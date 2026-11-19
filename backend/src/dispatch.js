// Tickets, technicians, nearest-technician ranking, assignment and payout splits.
const { distanceKm, directionsLink, isLatLng } = require('./geo');
const { normalizePhone, samePhone } = require('./channels');

const OPEN_STATUSES = ['New', 'Assigned', 'En route', 'Completed'];
const TICKET_STATUSES = [...OPEN_STATUSES, 'Closed', 'Cancelled'];
const TECH_STATUSES = ['available', 'busy', 'off'];
const TECH_CHANNELS = ['imessage', 'whatsapp', 'discord'];
const LIVE_LOCATION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // live GPS older than 2 h falls back to the base address

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const KM_PER_MI = 1.609344;

function toNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(n) ? n : null;
}

function computeSplit(gross, partCost, ratePct) {
    const net = Math.max(gross - partCost, 0);
    const companyShare = round2(net * (ratePct / 100));
    return { net: round2(net), companyRemittanceDue: companyShare, technicianPayout: round2(gross - companyShare) };
}

function createDispatch({ store, settings, channels }) {
    const cfg = () => settings.effective();
    const countryCode = () => cfg().company.defaultCountryCode;

    // ---------- technicians ----------
    function techPosition(t) {
        const live = t.location && isLatLng(t.location) && Date.now() - Date.parse(t.location.at || 0) < LIVE_LOCATION_MAX_AGE_MS;
        if (live) return { position: { lat: t.location.lat, lng: t.location.lng }, positionSource: 'live', positionAt: t.location.at };
        if (isLatLng(t.baseLocation)) return { position: t.baseLocation, positionSource: 'base', positionAt: null };
        return { position: null, positionSource: 'none', positionAt: t.location?.at || null };
    }

    function openJobsFor(techId) {
        return store.filter('tickets', k => k.technicianId === techId && OPEN_STATUSES.includes(k.status)).length;
    }

    function technicianView(t, { includeLogin = false } = {}) {
        const login = store.find('users', u => u.technicianId === t.id);
        return {
            id: t.id, name: t.name, phone: t.phone, email: t.email || '', channel: t.channel, discordUserId: t.discordUserId || '',
            skills: t.skills || [], notes: t.notes || '', active: t.active !== false, status: t.status || 'off',
            baseAddress: t.baseAddress || '', baseLocation: t.baseLocation || null,
            ...techPosition(t), openJobs: openJobsFor(t.id), lastSeenAt: t.location?.at || null,
            ...(includeLogin ? { hasLogin: Boolean(login), loginEmail: login?.email || '' } : {}),
            createdAt: t.createdAt, updatedAt: t.updatedAt,
        };
    }

    // ---------- tickets ----------
    function ticketView(k) {
        const tech = k.technicianId ? store.get('technicians', k.technicianId) : null;
        return {
            ...k,
            technician: tech ? { id: tech.id, name: tech.name, channel: tech.channel, phone: tech.phone } : null,
            directionsUrl: directionsLink(k.location, k.address),
        };
    }

    function findOpenTicketForClient(phone) {
        const open = store.filter('tickets', k => OPEN_STATUSES.includes(k.status) && samePhone(k.client?.phone, phone));
        return open.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null;
    }

    function createTicket({ client = {}, address = '', issue = '', location = null, source = 'phone', locationSource = null }) {
        return store.insert('tickets', {
            id: store.nextTicketId(),
            status: 'New',
            source,
            client: {
                name: String(client.name || '').trim().slice(0, 120),
                phone: normalizePhone(client.phone, countryCode()) || String(client.phone || '').trim().slice(0, 40),
                channel: client.channel || null, // channel the client reached us on (imessage / whatsapp)
            },
            address: String(address || '').trim().slice(0, 300),
            location: isLatLng(location) ? location : null,
            locationSource: isLatLng(location) ? (locationSource || 'manual') : null,
            issue: String(issue || '').trim().slice(0, 2000),
            technicianId: null,
            assignedAt: null,
            grossCollected: 0, partCost: 0,
            companyRate: toNumber(cfg().company.defaultCompanyRate) ?? 30,
            companyRemittanceDue: 0, technicianPayout: 0,
            unread: { client: 0, technician: 0 },
        });
    }

    // Technicians ranked for a ticket: available first, then by distance.
    function candidates(ticket) {
        const unit = cfg().company.distanceUnit === 'km' ? 'km' : 'mi';
        return store.filter('technicians', t => t.active !== false)
            .map(t => {
                const view = technicianView(t);
                const km = ticket.location ? distanceKm(ticket.location, view.position) : null;
                return { ...view, distance: km === null ? null : round2(unit === 'km' ? km : km / KM_PER_MI), distanceUnit: unit };
            })
            .sort((a, b) => {
                const rank = s => ({ available: 0, busy: 1, off: 2 }[s] ?? 3);
                if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
                if (a.distance === null) return b.distance === null ? a.name.localeCompare(b.name) : 1;
                if (b.distance === null) return -1;
                return a.distance - b.distance;
            });
    }

    function dispatchText(ticket, tech, frontendUrl) {
        const lines = [
            `🔐 New job #${ticket.id}`,
            ticket.client?.name || ticket.client?.phone ? `Client: ${[ticket.client.name, ticket.client.phone].filter(Boolean).join(' · ')}` : null,
            ticket.address ? `Address: ${ticket.address}` : null,
            ticket.issue ? `Issue: ${ticket.issue}` : null,
            directionsLink(ticket.location, ticket.address) ? `Directions: ${directionsLink(ticket.location, ticket.address)}` : null,
            frontendUrl ? `Your jobs: ${frontendUrl.replace(/\/+$/, '')}/tech.html` : null,
            tech?.channel === 'discord' ? 'Reply in this thread to talk to dispatch.' : 'Reply to this message to talk to dispatch.',
        ];
        return lines.filter(Boolean).join('\n');
    }

    // Send the job to the technician on their preferred channel and log it in the conversation.
    async function notifyTechnician(ticket, tech, { author = 'system' } = {}) {
        const c = cfg();
        const text = dispatchText(ticket, tech, c.company.frontendUrl);
        let res;
        if (tech.channel === 'whatsapp') {
            const link = directionsLink(ticket.location, ticket.address);
            res = await channels.whatsapp.sendDispatch(tech.phone, {
                id: ticket.id,
                addressLine: [ticket.address || 'See map', link].filter(Boolean).join(' — '),
                details: [ticket.issue, ticket.client?.name || ticket.client?.phone ? `Client: ${[ticket.client.name, ticket.client.phone].filter(Boolean).join(' ')}` : ''].filter(Boolean).join(' — '),
                fallbackText: text,
            });
        } else if (tech.channel === 'discord') {
            const mention = tech.discordUserId ? `<@${tech.discordUserId}> ` : '';
            res = await channels.discord.sendDispatch({ content: `${mention}${text}`, threadName: `Job #${ticket.id} — ${tech.name}` });
            if (res.ok && res.threadId) store.update('tickets', ticket.id, { discordThreadId: res.threadId });
        } else {
            res = await channels.imessage.sendText(tech.phone, text);
        }
        recordMessage({
            ticketId: ticket.id, party: 'technician', technicianId: tech.id, direction: 'out', channel: res.channel,
            text, author, ok: res.ok, mocked: res.mocked, error: res.error || null, externalId: res.externalId || null, to: res.to,
        });
        return res;
    }

    function recordMessage(m) {
        return store.insert('messages', { at: new Date().toISOString(), ...m });
    }

    async function assign(ticket, tech, { notify = true, author } = {}) {
        if (!OPEN_STATUSES.includes(ticket.status)) return { error: 'Ticket is not open', code: 409 };
        if (tech.active === false) return { error: 'Technician is inactive', code: 409 };
        const previous = ticket.technicianId;
        store.update('tickets', ticket.id, { technicianId: tech.id, assignedAt: new Date().toISOString(), status: 'Assigned' });
        if (tech.status === 'available') store.update('technicians', tech.id, { status: 'busy' });
        if (previous && previous !== tech.id) releaseIfIdle(previous);
        const notification = notify ? await notifyTechnician(store.get('tickets', ticket.id), tech, { author }) : null;
        return { ticket: store.get('tickets', ticket.id), notification };
    }

    // A busy technician with no open jobs left becomes available again.
    function releaseIfIdle(techId) {
        const t = store.get('technicians', techId);
        if (t && t.status === 'busy' && openJobsFor(techId) === 0) store.update('technicians', techId, { status: 'available' });
    }

    function finalize(ticket, { grossCollected, partCost, customCompanyRate }) {
        if (ticket.status === 'Closed' || ticket.status === 'Cancelled') return { error: 'Ticket is already closed', code: 409 };
        const gross = grossCollected === undefined ? ticket.grossCollected : toNumber(grossCollected);
        const parts = toNumber(partCost);
        const rate = toNumber(customCompanyRate);
        const errors = [];
        if (gross === null || gross < 0) errors.push('grossCollected must be a number ≥ 0');
        if (parts === null || parts < 0) errors.push('partCost must be a number ≥ 0');
        if (rate === null || rate < 0 || rate > 100) errors.push('customCompanyRate must be between 0 and 100');
        if (!errors.length && parts > gross) errors.push('partCost cannot exceed grossCollected');
        if (errors.length) return { error: errors.join('; '), code: 400 };
        const split = computeSplit(gross, parts, rate);
        const updated = store.update('tickets', ticket.id, {
            grossCollected: round2(gross), partCost: round2(parts), companyRate: round2(rate),
            companyRemittanceDue: split.companyRemittanceDue, technicianPayout: split.technicianPayout,
            status: 'Closed', closedAt: new Date().toISOString(),
        });
        if (ticket.technicianId) releaseIfIdle(ticket.technicianId);
        return { ticket: updated };
    }

    return {
        technicianView, ticketView, candidates, createTicket, assign, notifyTechnician, recordMessage,
        finalize, releaseIfIdle, findOpenTicketForClient, dispatchText, techPosition,
    };
}

module.exports = { createDispatch, computeSplit, toNumber, round2, OPEN_STATUSES, TICKET_STATUSES, TECH_STATUSES, TECH_CHANNELS };
