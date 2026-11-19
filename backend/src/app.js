const express = require('express');
const cors = require('cors');
const { hashPassword, verifyPassword } = require('./security');
const { parseLatLng, isLatLng } = require('./geo');
const { normalizePhone } = require('./channels');
const { OPEN_STATUSES, TICKET_STATUSES, TECH_STATUSES, TECH_CHANNELS } = require('./dispatch');

const ROLES = ['admin', 'dispatcher', 'technician'];
const SESSION_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Simple fixed-window rate limiter (per process).
function rateLimiter(limit, windowMs) {
    const hits = new Map();
    return key => {
        const now = Date.now();
        const h = hits.get(key);
        if (!h || now - h.start > windowMs) { hits.set(key, { start: now, count: 1 }); return true; }
        h.count += 1;
        return h.count <= limit;
    };
}

function createApp(ctx) {
    const { store, settings, keys, dispatch, geocode, config } = ctx;
    const app = express();
    app.set('trust proxy', 1);

    app.use(cors({
        origin: config.corsOrigin === '*' ? '*' : config.corsOrigin.split(',').map(s => s.trim()),
        allowedHeaders: ['Content-Type', 'Authorization'],
        exposedHeaders: ['Content-Disposition'],
    }));
    // Keep the raw body: WhatsApp webhooks are verified against it.
    app.use(express.json({ limit: '200kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

    const ok = (res, body = {}) => res.json({ success: true, ...body });
    const fail = (res, code, error) => res.status(code).json({ success: false, error });
    const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

    // ---------------- auth helpers ----------------
    const userView = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, technicianId: u.technicianId || null, disabled: Boolean(u.disabled), createdAt: u.createdAt });
    const issueToken = u => keys.signToken({ uid: u.id, tv: u.tokenVersion || 0, exp: Date.now() + SESSION_DAYS * 86400000 });

    function authenticate(req, res, next) {
        const h = req.get('Authorization') || '';
        const payload = h.startsWith('Bearer ') ? keys.verifyToken(h.slice(7)) : null;
        const user = payload && store.get('users', payload.uid);
        if (!user || user.disabled || (user.tokenVersion || 0) !== payload.tv) return fail(res, 401, 'Please log in again');
        req.user = user;
        next();
    }
    const allow = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : fail(res, 403, 'Not allowed for your role'));
    const staff = [authenticate, allow('admin', 'dispatcher')];
    const adminOnly = [authenticate, allow('admin')];

    const loginLimiter = rateLimiter(10, 15 * 60 * 1000);
    const requestLimiter = rateLimiter(5, 60 * 60 * 1000);
    const setupAllowed = () => store.list('users').length === 0 && (!config.production || Boolean(config.setupCode));

    // ---------------- health & auth ----------------
    app.get('/api/health', (req, res) => ok(res, {
        storage: store.driver.kind, persistent: config.dataPersistent !== false && store.driver.persistent, saveError: store.lastSaveError ? true : undefined,
    }));

    app.get('/api/auth/status', (req, res) => ok(res, {
        needsSetup: store.list('users').length === 0,
        setupAllowed: setupAllowed(),
        setupNeedsCode: Boolean(config.production && config.setupCode),
        companyName: settings.effective().company.name,
    }));

    app.post('/api/auth/setup', (req, res) => {
        if (!setupAllowed()) return fail(res, 403, 'Setup is not available. On the server, set ADMIN_EMAIL and ADMIN_PASSWORD to create the first admin.');
        if (config.production && req.body?.setupCode !== config.setupCode) return fail(res, 403, 'Wrong setup code');
        const err = validateUserInput(req.body, { requirePassword: true });
        if (err) return fail(res, 400, err);
        const user = store.insert('users', { name: str(req.body.name, 80), email: str(req.body.email, 120).toLowerCase(), role: 'admin', passwordHash: hashPassword(req.body.password), tokenVersion: 0 });
        ok(res, { token: issueToken(user), user: userView(user) });
    });

    app.post('/api/auth/login', (req, res) => {
        const email = str(req.body?.email, 120).toLowerCase();
        if (!loginLimiter(`${req.ip}|${email}`)) return fail(res, 429, 'Too many attempts. Try again in 15 minutes.');
        const user = store.find('users', u => u.email === email);
        if (!user || user.disabled || !verifyPassword(req.body?.password || '', user.passwordHash)) return fail(res, 401, 'Wrong email or password');
        ok(res, { token: issueToken(user), user: userView(user) });
    });

    app.get('/api/auth/me', authenticate, (req, res) => ok(res, { user: userView(req.user), companyName: settings.effective().company.name }));

    app.post('/api/auth/password', authenticate, (req, res) => {
        if (!verifyPassword(req.body?.currentPassword || '', req.user.passwordHash)) return fail(res, 400, 'Current password is wrong');
        if (String(req.body?.newPassword || '').length < 8) return fail(res, 400, 'New password must be at least 8 characters');
        const user = store.update('users', req.user.id, { passwordHash: hashPassword(req.body.newPassword), tokenVersion: (req.user.tokenVersion || 0) + 1 });
        ok(res, { token: issueToken(user) });
    });

    // ---------------- users (admin) ----------------
    function validateUserInput(body, { requirePassword, id } = {}) {
        if (!str(body?.name)) return 'Name is required';
        const email = str(body?.email, 120).toLowerCase();
        if (!EMAIL_RE.test(email)) return 'A valid email is required';
        if (store.find('users', u => u.email === email && u.id !== id)) return 'That email is already used by another login';
        if ((requirePassword || body?.password) && String(body?.password || '').length < 8) return 'Password must be at least 8 characters';
        return null;
    }
    const adminCount = () => store.filter('users', u => u.role === 'admin' && !u.disabled).length;

    app.get('/api/users', adminOnly, (req, res) => ok(res, { users: store.filter('users', u => u.role !== 'technician').map(userView) }));

    app.post('/api/users', adminOnly, (req, res) => {
        const role = req.body?.role;
        if (!['admin', 'dispatcher'].includes(role)) return fail(res, 400, 'Role must be admin or dispatcher');
        const err = validateUserInput(req.body, { requirePassword: true });
        if (err) return fail(res, 400, err);
        const user = store.insert('users', { name: str(req.body.name, 80), email: str(req.body.email, 120).toLowerCase(), role, passwordHash: hashPassword(req.body.password), tokenVersion: 0 });
        ok(res, { user: userView(user) });
    });

    app.put('/api/users/:id', adminOnly, (req, res) => {
        const user = store.get('users', req.params.id);
        if (!user || user.role === 'technician') return fail(res, 404, 'User not found');
        const err = validateUserInput({ name: req.body?.name ?? user.name, email: req.body?.email ?? user.email, password: req.body?.password }, { id: user.id });
        if (err) return fail(res, 400, err);
        const role = req.body?.role ?? user.role;
        if (!['admin', 'dispatcher'].includes(role)) return fail(res, 400, 'Role must be admin or dispatcher');
        const disabled = req.body?.disabled ?? Boolean(user.disabled);
        if (user.role === 'admin' && (role !== 'admin' || disabled) && adminCount() <= 1) return fail(res, 409, 'There must be at least one active admin');
        const patch = { name: str(req.body?.name ?? user.name, 80), email: str(req.body?.email ?? user.email, 120).toLowerCase(), role, disabled: Boolean(disabled) };
        if (req.body?.password) Object.assign(patch, { passwordHash: hashPassword(req.body.password), tokenVersion: (user.tokenVersion || 0) + 1 });
        if (disabled && !user.disabled) patch.tokenVersion = (user.tokenVersion || 0) + 1;
        ok(res, { user: userView(store.update('users', user.id, patch)) });
    });

    app.delete('/api/users/:id', adminOnly, (req, res) => {
        const user = store.get('users', req.params.id);
        if (!user || user.role === 'technician') return fail(res, 404, 'User not found');
        if (user.id === req.user.id) return fail(res, 409, "You can't delete your own login");
        if (user.role === 'admin' && adminCount() <= 1) return fail(res, 409, 'There must be at least one active admin');
        store.remove('users', user.id);
        ok(res);
    });

    // ---------------- settings (admin) ----------------
    app.get('/api/settings', adminOnly, (req, res) => ok(res, { settings: settings.publicView(), webhooks: ctx.webhookUrls ? ctx.webhookUrls(req) : {} }));
    app.put('/api/settings', adminOnly, (req, res) => {
        const { errors } = settings.update(req.body?.settings);
        if (errors.length) return fail(res, 400, errors.join('; '));
        ok(res, { settings: settings.publicView() });
    });

    // ---------------- technicians ----------------
    async function technicianInput(body, existing) {
        const name = str(body.name ?? existing?.name, 80);
        if (!name) return { error: 'Name is required' };
        const channel = body.channel ?? existing?.channel ?? 'imessage';
        if (!TECH_CHANNELS.includes(channel)) return { error: `Channel must be one of ${TECH_CHANNELS.join(', ')}` };
        const phoneRaw = body.phone ?? existing?.phone ?? '';
        const phone = normalizePhone(phoneRaw, settings.effective().company.defaultCountryCode);
        if (channel !== 'discord' && !phone) return { error: 'A valid phone number is required (international format, e.g. +1 555 123 4567)' };
        if (phoneRaw && !phone) return { error: 'Phone number is not valid' };
        const discordUserId = str(body.discordUserId ?? existing?.discordUserId, 30);
        if (discordUserId && !/^\d{15,22}$/.test(discordUserId)) return { error: 'Discord user ID must be the long number from Discord (Copy User ID)' };
        const status = body.status ?? existing?.status ?? 'available';
        if (!TECH_STATUSES.includes(status)) return { error: 'Invalid status' };
        const doc = {
            name, phone, channel, discordUserId, status,
            email: str(body.email ?? existing?.email, 120).toLowerCase(),
            skills: (Array.isArray(body.skills) ? body.skills : String(body.skills ?? (existing?.skills || []).join(',')).split(','))
                .map(s => str(s, 40)).filter(Boolean).slice(0, 20),
            notes: str(body.notes ?? existing?.notes, 1000),
            active: body.active === undefined ? existing?.active !== false : Boolean(body.active),
            baseAddress: str(body.baseAddress ?? existing?.baseAddress, 300),
        };
        const manual = parseLatLng(body.baseLocation);
        if (manual) doc.baseLocation = manual;
        else if (doc.baseAddress && doc.baseAddress !== existing?.baseAddress) doc.baseLocation = await geocode(doc.baseAddress);
        else if (!doc.baseAddress) doc.baseLocation = null;
        return { doc };
    }

    // Optional login for the technician GPS page.
    function upsertTechLogin(tech, body) {
        const existing = store.find('users', u => u.technicianId === tech.id);
        const email = str(body.loginEmail ?? existing?.email ?? tech.email, 120).toLowerCase();
        if (body.removeLogin) { if (existing) store.remove('users', existing.id); return null; }
        if (!body.password && !existing) return null;
        const err = validateUserInput({ name: tech.name, email, password: body.password }, { id: existing?.id, requirePassword: !existing });
        if (err) return err;
        const patch = { name: tech.name, email, role: 'technician', technicianId: tech.id };
        if (body.password) Object.assign(patch, { passwordHash: hashPassword(body.password), tokenVersion: (existing?.tokenVersion || 0) + 1 });
        if (existing) store.update('users', existing.id, patch); else store.insert('users', { ...patch, tokenVersion: 0 });
        return null;
    }

    app.get('/api/technicians', staff, (req, res) => ok(res, {
        technicians: store.list('technicians').map(t => dispatch.technicianView(t, { includeLogin: req.user.role === 'admin' })),
    }));

    app.post('/api/technicians', adminOnly, wrap(async (req, res) => {
        const { doc, error } = await technicianInput(req.body || {});
        if (error) return fail(res, 400, error);
        const loginErr = req.body?.password ? validateUserInput({ name: doc.name, email: str(req.body.loginEmail || doc.email, 120), password: req.body.password }, { requirePassword: true }) : null;
        if (loginErr) return fail(res, 400, `Login: ${loginErr}`);
        const tech = store.insert('technicians', doc);
        upsertTechLogin(tech, req.body);
        ok(res, { technician: dispatch.technicianView(tech, { includeLogin: true }) });
    }));

    app.put('/api/technicians/:id', adminOnly, wrap(async (req, res) => {
        const tech = store.get('technicians', req.params.id);
        if (!tech) return fail(res, 404, 'Technician not found');
        const { doc, error } = await technicianInput(req.body || {}, tech);
        if (error) return fail(res, 400, error);
        const updated = store.update('technicians', tech.id, doc);
        const loginErr = upsertTechLogin(updated, req.body || {});
        if (loginErr) return fail(res, 400, `Saved, but the login was not: ${loginErr}`);
        ok(res, { technician: dispatch.technicianView(updated, { includeLogin: true }) });
    }));

    app.delete('/api/technicians/:id', adminOnly, (req, res) => {
        const tech = store.get('technicians', req.params.id);
        if (!tech) return fail(res, 404, 'Technician not found');
        if (store.find('tickets', k => k.technicianId === tech.id && OPEN_STATUSES.includes(k.status))) {
            return fail(res, 409, 'This technician has open jobs. Reassign them first, or mark the technician inactive.');
        }
        const login = store.find('users', u => u.technicianId === tech.id);
        if (login) store.remove('users', login.id);
        store.remove('technicians', tech.id);
        ok(res);
    });

    // ---------------- tickets ----------------
    const getTicket = (req, res) => {
        const t = store.get('tickets', String(req.params.id).trim());
        if (!t) { fail(res, 404, 'Ticket not found'); return null; }
        return t;
    };

    app.get('/api/tickets', staff, (req, res) => {
        const scope = req.query.scope === 'all' ? 'all' : 'open';
        const list = store.filter('tickets', k => scope === 'all' || OPEN_STATUSES.includes(k.status))
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        ok(res, { tickets: list.map(dispatch.ticketView) });
    });

    app.get('/api/tickets/:id', staff, (req, res) => {
        const t = getTicket(req, res); if (!t) return;
        ok(res, { ticket: dispatch.ticketView(t) });
    });

    async function ticketLocation(body, existing) {
        const manual = parseLatLng(body.location);
        if (manual) return { location: manual, locationSource: body.locationSource === 'gps' ? 'gps' : 'manual' };
        const address = body.address ?? existing?.address;
        if (address && (!existing || address !== existing.address || !existing.location)) {
            const hit = await geocode(address);
            if (hit) return { location: hit, locationSource: 'geocoded' };
            return existing && address !== existing.address ? { location: null, locationSource: null } : {};
        }
        return {};
    }

    app.post('/api/tickets', staff, wrap(async (req, res) => {
        const b = req.body || {};
        if (!str(b.address) && !parseLatLng(b.location)) return fail(res, 400, 'Address or location is required');
        if (!str(b.client?.name) && !str(b.client?.phone)) return fail(res, 400, 'Client name or phone is required');
        const loc = await ticketLocation(b);
        const ticket = dispatch.createTicket({ client: b.client, address: b.address, issue: b.issue, location: loc.location, locationSource: loc.locationSource, source: 'phone' });
        ok(res, { ticket: dispatch.ticketView(ticket) });
    }));

    app.put('/api/tickets/:id', staff, wrap(async (req, res) => {
        const t = getTicket(req, res); if (!t) return;
        const b = req.body || {};
        const patch = {};
        if (b.client) patch.client = { ...t.client, name: str(b.client.name ?? t.client?.name, 120), phone: normalizePhone(b.client.phone ?? t.client?.phone, settings.effective().company.defaultCountryCode) || str(b.client.phone ?? t.client?.phone, 40) };
        if (b.address !== undefined) patch.address = str(b.address, 300);
        if (b.issue !== undefined) patch.issue = str(b.issue, 2000);
        if (b.status !== undefined) {
            if (!TICKET_STATUSES.includes(b.status) || b.status === 'Closed') return fail(res, 400, 'Invalid status (use Finalize to close a ticket)');
            patch.status = b.status;
        }
        Object.assign(patch, await ticketLocation({ ...b, address: patch.address ?? t.address }, t));
        const updated = store.update('tickets', t.id, patch);
        if (patch.status === 'Cancelled' && t.technicianId) dispatch.releaseIfIdle(t.technicianId);
        ok(res, { ticket: dispatch.ticketView(updated) });
    }));

    app.delete('/api/tickets/:id', adminOnly, (req, res) => {
        const t = getTicket(req, res); if (!t) return;
        store.remove('tickets', t.id);
        for (const m of store.filter('messages', m => m.ticketId === t.id)) store.remove('messages', m.id);
        if (t.technicianId) dispatch.releaseIfIdle(t.technicianId);
        ok(res);
    });

    app.get('/api/tickets/:id/candidates', staff, (req, res) => {
        const t = getTicket(req, res); if (!t) return;
        ok(res, { candidates: dispatch.candidates(t), ticketLocation: t.location });
    });

    app.post('/api/tickets/:id/assign', staff, wrap(async (req, res) => {
        const t = getTicket(req, res); if (!t) return;
        const tech = store.get('technicians', req.body?.technicianId);
        if (!tech) return fail(res, 404, 'Technician not found');
        const out = await dispatch.assign(t, tech, { notify: req.body?.notify !== false, author: req.user.name });
        if (out.error) return fail(res, out.code, out.error);
        ok(res, { ticket: dispatch.ticketView(out.ticket), notification: out.notification });
    }));

    app.post('/api/tickets/:id/unassign', staff, (req, res) => {
        const t = getTicket(req, res); if (!t) return;
        if (!OPEN_STATUSES.includes(t.status)) return fail(res, 409, 'Ticket is not open');
        const prev = t.technicianId;
        const updated = store.update('tickets', t.id, { technicianId: null, assignedAt: null, status: 'New' });
        if (prev) dispatch.releaseIfIdle(prev);
        ok(res, { ticket: dispatch.ticketView(updated) });
    });

    app.post('/api/tickets/:id/finalize', staff, (req, res) => {
        const t = getTicket(req, res); if (!t) return;
        const out = dispatch.finalize(t, req.body || {});
        if (out.error) return fail(res, out.code, out.error);
        ok(res, { ticket: dispatch.ticketView(out.ticket) });
    });

    app.get('/api/accounting/export-csv', staff, (req, res) => {
        const cell = value => {
            const s = value === null || value === undefined ? '' : String(value);
            const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
            return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
        };
        const cols = [
            ['id', k => k.id], ['createdAt', k => k.createdAt], ['status', k => k.status], ['source', k => k.source],
            ['clientName', k => k.client?.name], ['clientPhone', k => k.client?.phone], ['address', k => k.address],
            ['technician', k => store.get('technicians', k.technicianId)?.name], ['grossCollected', k => k.grossCollected],
            ['partCost', k => k.partCost], ['companyRate', k => k.companyRate], ['companyRemittanceDue', k => k.companyRemittanceDue],
            ['technicianPayout', k => k.technicianPayout], ['closedAt', k => k.closedAt],
        ];
        const rows = [cols.map(c => c[0]).join(',')].concat(store.list('tickets').map(k => cols.map(c => cell(c[1](k))).join(',')));
        res.header('Content-Type', 'text/csv; charset=utf-8');
        res.attachment('lock-ops-ledger.csv');
        res.send(rows.join('\r\n') + '\r\n');
    });

    // ---------------- technician's own page ----------------
    const techOnly = [authenticate, allow('technician')];
    const myTech = (req, res) => {
        const t = req.user.technicianId && store.get('technicians', req.user.technicianId);
        if (!t) { fail(res, 404, 'Your login is not linked to a technician profile'); return null; }
        return t;
    };

    app.get('/api/me/jobs', techOnly, (req, res) => {
        const tech = myTech(req, res); if (!tech) return;
        const jobs = store.filter('tickets', k => k.technicianId === tech.id && OPEN_STATUSES.includes(k.status))
            .sort((a, b) => Date.parse(a.assignedAt || a.createdAt) - Date.parse(b.assignedAt || b.createdAt))
            .map(k => {
                const v = dispatch.ticketView(k);
                return { id: v.id, status: v.status, client: v.client, address: v.address, location: v.location, issue: v.issue, directionsUrl: v.directionsUrl, assignedAt: v.assignedAt };
            });
        ok(res, { technician: dispatch.technicianView(tech), jobs });
    });

    app.post('/api/me/location', techOnly, (req, res) => {
        const tech = myTech(req, res); if (!tech) return;
        const loc = parseLatLng(req.body);
        if (!loc) return fail(res, 400, 'lat and lng are required');
        const accuracy = Number(req.body.accuracy);
        store.update('technicians', tech.id, { location: { ...loc, accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : null, at: new Date().toISOString() } });
        ok(res);
    });

    app.put('/api/me/status', techOnly, (req, res) => {
        const tech = myTech(req, res); if (!tech) return;
        if (!TECH_STATUSES.includes(req.body?.status)) return fail(res, 400, 'Status must be available, busy or off');
        ok(res, { technician: dispatch.technicianView(store.update('technicians', tech.id, { status: req.body.status })) });
    });

    app.post('/api/me/jobs/:id/status', techOnly, (req, res) => {
        const tech = myTech(req, res); if (!tech) return;
        const t = store.get('tickets', req.params.id);
        if (!t || t.technicianId !== tech.id || !OPEN_STATUSES.includes(t.status)) return fail(res, 404, 'Job not found');
        if (!['En route', 'Completed'].includes(req.body?.status)) return fail(res, 400, 'Status must be "En route" or "Completed"');
        store.update('tickets', t.id, { status: req.body.status });
        dispatch.recordMessage({ ticketId: t.id, party: 'system', direction: 'in', channel: 'app', text: `${tech.name} marked the job "${req.body.status}"`, ok: true });
        ok(res);
    });

    // ---------------- public request form ----------------
    app.get('/api/public/info', (req, res) => ok(res, { companyName: settings.effective().company.name }));

    app.post('/api/public/requests', wrap(async (req, res) => {
        const b = req.body || {};
        if (b.website) return ok(res, { ticketId: null }); // honeypot: bots fill hidden fields
        if (!requestLimiter(req.ip)) return fail(res, 429, 'Too many requests from this device. Please call us instead.');
        const name = str(b.name, 120);
        const phone = normalizePhone(b.phone, settings.effective().company.defaultCountryCode);
        if (!name) return fail(res, 400, 'Please enter your name');
        if (!phone) return fail(res, 400, 'Please enter a valid phone number');
        if (!str(b.address) && !parseLatLng(b.location)) return fail(res, 400, 'Please enter your address or share your location');
        const loc = await ticketLocation({ address: b.address, location: b.location, locationSource: parseLatLng(b.location) ? 'gps' : undefined });
        const ticket = dispatch.createTicket({
            client: { name, phone, channel: b.contactBy === 'whatsapp' ? 'whatsapp' : 'imessage' },
            address: b.address, issue: b.issue, location: loc.location, locationSource: loc.locationSource, source: 'form',
        });
        ok(res, { ticketId: ticket.id });
    }));

    // Extra routes (messaging/webhooks) are mounted by the caller.
    if (ctx.mount) ctx.mount(app, { authenticate, allow, staff, adminOnly, ok, fail, wrap, getTicket });

    app.use('/api', (req, res) => fail(res, 404, 'Unknown endpoint'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err.type === 'entity.parse.failed') return fail(res, 400, 'Invalid JSON');
        console.error('[error]', err);
        fail(res, 500, 'Server error');
    });
    return app;
}

module.exports = { createApp, ROLES, isLatLng };
