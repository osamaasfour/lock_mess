// HTTP routes for conversations and incoming-message webhooks.
const { safeEqual } = require('./security');

function baseUrl(req, config) {
    if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, '');
    return `${req.protocol}://${req.get('host')}`;
}

function webhookUrls(ctx) {
    return req => {
        const c = ctx.settings.effective();
        const base = baseUrl(req, ctx.config);
        return {
            whatsapp: { url: `${base}/api/webhooks/whatsapp`, verifyToken: c.whatsapp.verifyToken },
            imessage: { url: `${base}/api/webhooks/sendblue/${encodeURIComponent(c.imessage.webhookSecret)}` },
            discord: { botActive: ctx.channels.discord.botConfigured() },
        };
    };
}

function mountMessaging(app, h, ctx) {
    const { store, messaging, settings, log } = ctx;
    const { staff, ok, fail, wrap, getTicket } = h;

    const messageView = m => ({
        id: m.id, at: m.at, party: m.party, direction: m.direction, channel: m.channel, text: m.text, author: m.author || null,
        ok: m.ok !== false, mocked: Boolean(m.mocked), error: m.error || null, status: m.status || null, to: m.to || null, from: m.from || null,
        location: m.location || null, mediaUrl: m.mediaUrl || null,
    });

    app.get('/api/tickets/:id/messages', staff, (req, res) => {
        const t = getTicket(req, res); if (!t) return;
        const messages = store.filter('messages', m => m.ticketId === t.id).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        const tech = t.technicianId && store.get('technicians', t.technicianId);
        ok(res, {
            messages: messages.map(messageView),
            unread: t.unread || { client: 0, technician: 0 },
            channels: {
                client: t.client?.phone ? { channel: t.client.channel === 'whatsapp' ? 'whatsapp' : 'imessage', to: t.client.phone, windowOpen: t.client.channel === 'whatsapp' ? messaging.whatsappWindowOpen(t.client.phone) : null } : null,
                technician: tech ? { channel: tech.channel, to: tech.channel === 'discord' ? (t.discordThreadId ? 'job thread' : 'channel') : tech.phone, name: tech.name, windowOpen: tech.channel === 'whatsapp' ? messaging.whatsappWindowOpen(tech.phone) : null, discordReplies: tech.channel === 'discord' ? ctx.channels.discord.botConfigured() : null } : null,
            },
        });
    });

    app.post('/api/tickets/:id/messages', staff, wrap(async (req, res) => {
        const t = getTicket(req, res); if (!t) return;
        const party = req.body?.party;
        if (!['client', 'technician'].includes(party)) return fail(res, 400, 'party must be "client" or "technician"');
        const text = String(req.body?.text || '').trim().slice(0, 4000);
        if (!text) return fail(res, 400, 'Message is empty');
        const out = await messaging.sendToParty(t, party, text, { author: req.user.name });
        if (!out.message) return fail(res, 400, out.error);
        ok(res, { message: messageView(out.message), sent: out.ok, mocked: Boolean(out.mocked), error: out.error || null });
    }));

    app.post('/api/tickets/:id/send-location', staff, wrap(async (req, res) => {
        const t = getTicket(req, res); if (!t) return;
        const out = await messaging.sendLocationToTechnician(t, { author: req.user.name });
        if (!out.ok && !out.message && !out.mocked) return fail(res, 400, out.error);
        ok(res, { sent: out.ok, mocked: Boolean(out.mocked), error: out.error || null });
    }));

    app.post('/api/tickets/:id/read', staff, (req, res) => {
        const t = getTicket(req, res); if (!t) return;
        const party = req.body?.party;
        if (!['client', 'technician'].includes(party)) return fail(res, 400, 'party must be "client" or "technician"');
        if ((t.unread?.[party] || 0) > 0) store.update('tickets', t.id, { unread: { client: 0, technician: 0, ...t.unread, [party]: 0 } });
        ok(res);
    });

    // Messages that couldn't be tied to a ticket (e.g. a technician writing with no open job).
    app.get('/api/messages/unlinked', staff, (req, res) => {
        const list = store.filter('messages', m => !m.ticketId && m.direction === 'in' && !m.dismissed)
            .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 50)
            .map(m => ({ ...messageView(m), technician: m.technicianId ? store.get('technicians', m.technicianId)?.name || null : null }));
        ok(res, { messages: list });
    });
    app.post('/api/messages/:id/dismiss', staff, (req, res) => {
        const m = store.get('messages', req.params.id);
        if (!m) return fail(res, 404, 'Message not found');
        store.update('messages', m.id, { dismissed: true });
        ok(res);
    });

    // ---------- webhooks ----------
    // Meta calls GET once to verify the URL, then POSTs every message and delivery receipt.
    app.get('/api/webhooks/whatsapp', (req, res) => {
        const token = settings.effective().whatsapp.verifyToken;
        if (req.query['hub.mode'] === 'subscribe' && token && safeEqual(req.query['hub.verify_token'], token)) {
            return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
        }
        res.sendStatus(403);
    });

    app.post('/api/webhooks/whatsapp', (req, res) => {
        const check = messaging.verifyWhatsAppSignature(req);
        if (!check.ok) { log.warn(`[WHATSAPP] webhook rejected: ${check.reason}`); return res.sendStatus(check.reason.startsWith('App secret') ? 503 : 401); }
        res.sendStatus(200); // answer fast; Meta retries slow webhooks
        messaging.handleWhatsApp(req.body).catch(err => log.error('[WHATSAPP] webhook handling failed:', err));
    });

    app.post('/api/webhooks/sendblue/:secret', (req, res) => {
        const secret = settings.effective().imessage.webhookSecret;
        if (!secret || !safeEqual(req.params.secret, secret)) return res.sendStatus(404);
        res.status(200).json({ received: true });
        messaging.handleSendblue(req.body).catch(err => log.error('[IMESSAGE] webhook handling failed:', err));
    });
}

module.exports = { mountMessaging, webhookUrls };
