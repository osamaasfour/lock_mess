// Two-way conversations: route incoming messages to the right ticket, send replies,
// receive webhooks (WhatsApp, Sendblue) and poll Discord job threads.
const crypto = require('crypto');
const { digits, samePhone, normalizePhone } = require('./channels');
const { parseLatLng, directionsLink } = require('./geo');
const { OPEN_STATUSES } = require('./dispatch');
const { safeEqual } = require('./security');

const CONTEXT_TTL_MS = 3 * 24 * 60 * 60 * 1000; // a reply within 3 days follows the last outbound conversation
const WA_WINDOW_MS = 24 * 60 * 60 * 1000;

// Pull coordinates out of a shared map link (Apple Maps, Google Maps) in message text.
function parseLocationFromText(text) {
    const s = String(text || '');
    const patterns = [
        /maps\.apple\.com\/[^\s]*[?&](?:ll|q|sll|coordinate)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/i,
        /google\.[a-z.]+\/maps[^\s]*[@?&=/](-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/i,
        /maps\.google\.[a-z.]+\/[^\s]*[?&]q=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/i,
        /goo\.gl\/maps[^\s]*?(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/i,
    ];
    for (const re of patterns) {
        const m = s.match(re);
        if (m) return parseLatLng({ lat: m[1], lng: m[2] });
    }
    return null;
}

function createMessaging(ctx) {
    const { store, settings, channels, dispatch, http, log } = ctx;
    const cfg = () => settings.effective();
    const meta = () => store.meta;

    // ---------- conversation context ----------
    const ctxKey = (channel, address) => `${channel}:${String(address).includes('@') ? String(address).toLowerCase() : digits(address)}`;

    function rememberOutbound(channel, to, info) {
        if (!to) return;
        const map = { ...(meta().lastOutbound || {}) };
        map[ctxKey(channel, to)] = { ...info, at: new Date().toISOString() };
        // keep the map small
        const entries = Object.entries(map).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, 500);
        store.setMeta({ lastOutbound: Object.fromEntries(entries) });
    }
    function lastOutbound(channel, from) {
        const hit = (meta().lastOutbound || {})[ctxKey(channel, from)];
        return hit && Date.now() - Date.parse(hit.at) < CONTEXT_TTL_MS ? hit : null;
    }
    function rememberInbound(channel, from) {
        store.setMeta({ lastInbound: { ...(meta().lastInbound || {}), [ctxKey(channel, from)]: new Date().toISOString() } });
    }
    function whatsappWindowOpen(phone) {
        const c = cfg().whatsapp;
        const at = (meta().lastInbound || {})[ctxKey('whatsapp', c.testRecipient || phone)];
        return Boolean(at && Date.now() - Date.parse(at) < WA_WINDOW_MS);
    }

    dispatch.hooks.onRecord = m => {
        if (m.direction === 'out' && m.ok && m.to && m.ticketId && ['whatsapp', 'imessage'].includes(m.channel)) {
            rememberOutbound(m.channel, m.to, { ticketId: m.ticketId, party: m.party, technicianId: m.technicianId || null });
        }
    };
    const record = m => dispatch.recordMessage(m);

    function bumpUnread(ticketId, party) {
        const t = store.get('tickets', ticketId);
        if (!t) return;
        const unread = { client: 0, technician: 0, ...(t.unread || {}) };
        unread[party] = (unread[party] || 0) + 1;
        store.update('tickets', ticketId, { unread, lastMessageAt: new Date().toISOString() });
    }

    // ---------- inbound ----------
    // channel: 'whatsapp' | 'imessage'; from: phone/Apple ID; returns the stored message.
    async function routeInbound({ channel, from, text = '', location = null, mediaUrl = null, externalId = null, profileName = '' }) {
        if (externalId && store.find('messages', m => m.externalId === externalId && m.direction === 'in')) return null; // duplicate webhook
        rememberInbound(channel, from);
        const techByPhone = store.find('technicians', t => samePhone(t.phone, from));
        const remembered = lastOutbound(channel, from);

        let party, technicianId = null, ticket = null;
        if (remembered && store.get('tickets', remembered.ticketId)) {
            party = remembered.party; technicianId = remembered.technicianId;
            ticket = store.get('tickets', remembered.ticketId);
        } else if (techByPhone) {
            party = 'technician'; technicianId = techByPhone.id;
            ticket = store.filter('tickets', k => k.technicianId === techByPhone.id && OPEN_STATUSES.includes(k.status))
                .sort((a, b) => Date.parse(b.assignedAt || 0) - Date.parse(a.assignedAt || 0))[0] || null;
        } else {
            party = 'client';
            ticket = dispatch.findOpenTicketForClient(from);
        }

        // A technician sharing a location updates their live position.
        if (location && party === 'technician' && technicianId) {
            store.update('technicians', technicianId, { location: { ...location, accuracy: null, at: new Date().toISOString(), via: channel } });
        }

        let created = false;
        if (party === 'client' && !ticket) {
            ticket = dispatch.createTicket({
                client: { name: profileName, phone: normalizePhone(from, cfg().company.defaultCountryCode) || from, channel },
                issue: text, location, locationSource: location ? channel : null, source: channel,
            });
            created = true;
        } else if (party === 'client' && location && ticket) {
            store.update('tickets', ticket.id, { location, locationSource: channel });
        }
        if (party === 'client' && ticket && profileName && !ticket.client?.name) {
            store.update('tickets', ticket.id, { client: { ...ticket.client, name: profileName } });
        }

        const msg = record({
            ticketId: ticket?.id || null, party, technicianId, direction: 'in', channel, from,
            text: text || (location ? '📍 Shared a location' : mediaUrl ? '📎 Sent an attachment' : ''),
            location, mediaUrl, externalId, ok: true, read: false,
        });
        if (ticket) bumpUnread(ticket.id, party);

        if (created && cfg().company.autoReply !== 'off') {
            const reply = `Thanks${profileName ? `, ${profileName.split(' ')[0]}` : ''}! We received your request (#${ticket.id}). A dispatcher will reply shortly.${location ? '' : ' Please send your address or share your location.'}`;
            await sendToParty(store.get('tickets', ticket.id), 'client', reply, { author: 'Auto-reply' });
        }
        return msg;
    }

    // ---------- outbound ----------
    async function sendToParty(ticket, party, text, { author = 'Dispatcher' } = {}) {
        text = String(text || '').trim();
        if (!text) return { ok: false, error: 'Message is empty' };
        let res;
        let technicianId = null;
        if (party === 'client') {
            const phone = ticket.client?.phone;
            if (!phone) return { ok: false, error: 'This ticket has no client phone number' };
            if (ticket.client?.channel === 'whatsapp') {
                res = await channels.whatsapp.sendText(phone, text);
                if (!res.ok && !whatsappWindowOpen(phone)) res.error = `${res.error}. WhatsApp only allows free text within 24 h of the client's last message.`;
            } else {
                res = await channels.imessage.sendText(phone, text);
            }
        } else if (party === 'technician') {
            const tech = ticket.technicianId && store.get('technicians', ticket.technicianId);
            if (!tech) return { ok: false, error: 'No technician is assigned to this ticket' };
            technicianId = tech.id;
            if (tech.channel === 'whatsapp') {
                res = await channels.whatsapp.sendText(tech.phone, text);
                if (!res.ok && !whatsappWindowOpen(tech.phone)) res.error = `${res.error}. WhatsApp only allows free text within 24 h of the technician's last message — ask them to reply to the job alert first.`;
            } else if (tech.channel === 'discord') {
                const t = store.get('tickets', ticket.id);
                if (t.discordThreadId && channels.discord.botConfigured()) res = await channels.discord.sendToThread(t.discordThreadId, `**Dispatch:** ${text}`);
                else res = await channels.discord.sendDispatch({ content: `${tech.discordUserId ? `<@${tech.discordUserId}> ` : ''}**Job #${t.id}:** ${text}`, threadName: `Job #${t.id} — ${tech.name}` });
            } else {
                res = await channels.imessage.sendText(tech.phone, text);
            }
        } else {
            return { ok: false, error: 'party must be client or technician' };
        }
        const msg = record({
            ticketId: ticket.id, party, technicianId, direction: 'out', channel: res.channel, text, author,
            ok: res.ok, mocked: res.mocked, error: res.error || null, externalId: res.externalId || null, to: res.to, status: res.ok ? 'sent' : 'failed',
        });
        return { ...res, message: msg };
    }

    // Send the client's location to the assigned technician (native pin on WhatsApp when allowed).
    async function sendLocationToTechnician(ticket, { author } = {}) {
        const tech = ticket.technicianId && store.get('technicians', ticket.technicianId);
        if (!tech) return { ok: false, error: 'No technician is assigned to this ticket' };
        const link = directionsLink(ticket.location, ticket.address);
        if (!link) return { ok: false, error: 'This ticket has no address or map location' };
        const text = `📍 Client location for job #${ticket.id}${ticket.address ? `: ${ticket.address}` : ''}\n${link}`;
        if (tech.channel === 'whatsapp' && ticket.location && whatsappWindowOpen(tech.phone)) {
            const res = await channels.whatsapp.sendLocation(tech.phone, ticket.location, ticket.client?.name || `Job #${ticket.id}`, ticket.address);
            record({ ticketId: ticket.id, party: 'technician', technicianId: tech.id, direction: 'out', channel: 'whatsapp', text: `📍 Location pin: ${ticket.address || link}`, location: ticket.location, author, ok: res.ok, mocked: res.mocked, error: res.error || null, externalId: res.externalId || null, to: res.to });
            if (res.ok) return res;
        }
        return sendToParty(ticket, 'technician', text, { author });
    }

    // ---------- WhatsApp webhook ----------
    function verifyWhatsAppSignature(req) {
        const secret = cfg().whatsapp.appSecret;
        if (!secret) return { ok: false, reason: 'App secret is not set in Settings → WhatsApp' };
        const sig = req.get('X-Hub-Signature-256') || '';
        const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
        return safeEqual(sig, expected) ? { ok: true } : { ok: false, reason: 'Bad signature' };
    }

    async function handleWhatsApp(body) {
        for (const entry of body?.entry || []) {
            for (const change of entry.changes || []) {
                const v = change.value || {};
                const names = Object.fromEntries((v.contacts || []).map(c => [digits(c.wa_id), c.profile?.name || '']));
                for (const m of v.messages || []) {
                    let text = '';
                    let location = null;
                    if (m.type === 'text') text = m.text?.body || '';
                    else if (m.type === 'location') {
                        location = parseLatLng({ lat: m.location?.latitude, lng: m.location?.longitude });
                        text = ['📍 Shared a location', m.location?.name, m.location?.address].filter(Boolean).join(' · ');
                    } else if (m.type === 'button') text = m.button?.text || '';
                    else if (m.type === 'interactive') text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
                    else if (['image', 'video', 'document', 'audio', 'sticker'].includes(m.type)) text = `📎 Sent ${m.type === 'image' ? 'a photo' : `a ${m.type}`}${m[m.type]?.caption ? `: ${m[m.type].caption}` : ''} (open WhatsApp to view)`;
                    else text = `(${m.type} message)`;
                    if (!location) location = parseLocationFromText(text);
                    await routeInbound({ channel: 'whatsapp', from: `+${digits(m.from)}`, text, location, externalId: m.id, profileName: names[digits(m.from)] || '' });
                }
                // Delivery receipts: mark sent messages delivered / read / failed.
                for (const s of v.statuses || []) {
                    const msg = store.find('messages', x => x.externalId === s.id);
                    if (!msg) continue;
                    const patch = { status: s.status };
                    if (s.status === 'failed') Object.assign(patch, { ok: false, error: s.errors?.[0]?.title || s.errors?.[0]?.message || 'Delivery failed' });
                    store.update('messages', msg.id, patch);
                }
            }
        }
    }

    // ---------- Sendblue (iMessage) webhook ----------
    async function handleSendblue(body) {
        if (!body || body.is_outbound === true || body.is_outbound === 'true') return null;
        const from = body.number || body.from_number;
        if (!from) return null;
        const text = String(body.content || '');
        let location = parseLocationFromText(text);
        // "Send My Current Location" in iMessage arrives as a .vcf card that contains a maps.apple.com link.
        if (!location && body.media_url && /\.vcf(\?|$)/i.test(body.media_url)) {
            try {
                const { data } = await http.get(body.media_url, { timeout: 8000, responseType: 'text' });
                location = parseLocationFromText(String(data));
            } catch (err) { log.error('[IMESSAGE] could not read shared location card:', err.message); }
        }
        return routeInbound({
            channel: 'imessage', from, text: text || (location ? '📍 Shared a location' : body.media_url ? '📎 Sent an attachment' : ''),
            location, mediaUrl: location ? null : (body.media_url || null), externalId: body.message_handle || null,
        });
    }

    // ---------- Discord thread polling ----------
    let pollTimer = null;
    let polling = false;
    async function pollDiscord() {
        if (polling || !channels.discord.botConfigured()) return;
        polling = true;
        try {
            const threads = store.filter('tickets', k => k.discordThreadId && (OPEN_STATUSES.includes(k.status) || Date.now() - Date.parse(k.updatedAt) < WA_WINDOW_MS));
            for (const t of threads) {
                const cursors = meta().discordCursor || {};
                let msgs;
                try { msgs = await channels.discord.fetchThreadMessages(t.discordThreadId, cursors[t.discordThreadId] || t.discordThreadId); }
                catch (err) { log.error(`[DISCORD] poll ${t.discordThreadId} failed:`, err.response?.status || err.message); continue; }
                msgs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
                for (const m of msgs) {
                    if (!m.author?.bot && (m.content || m.attachments?.length)) {
                        if (!store.find('messages', x => x.externalId === m.id)) {
                            const tech = store.find('technicians', x => x.discordUserId && x.discordUserId === m.author?.id) || (t.technicianId && store.get('technicians', t.technicianId));
                            const text = m.content || `📎 ${m.attachments.map(a => a.filename).join(', ')}`;
                            const location = parseLocationFromText(text);
                            if (location && tech) store.update('technicians', tech.id, { location: { ...location, accuracy: null, at: new Date().toISOString(), via: 'discord' } });
                            record({ ticketId: t.id, party: 'technician', technicianId: tech?.id || null, direction: 'in', channel: 'discord', from: m.author?.username || 'discord', text, location, externalId: m.id, ok: true });
                            bumpUnread(t.id, 'technician');
                        }
                    }
                }
                if (msgs.length) store.setMeta({ discordCursor: { ...(meta().discordCursor || {}), [t.discordThreadId]: msgs[msgs.length - 1].id } });
            }
        } finally { polling = false; }
    }
    function startPolling(intervalMs = 8000) {
        stopPolling();
        pollTimer = setInterval(() => { pollDiscord().catch(err => log.error('[DISCORD] poll error:', err.message)); }, intervalMs);
        if (pollTimer.unref) pollTimer.unref();
    }
    function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

    return {
        routeInbound, sendToParty, sendLocationToTechnician, handleWhatsApp, handleSendblue, verifyWhatsAppSignature,
        pollDiscord, startPolling, stopPolling, whatsappWindowOpen, rememberOutbound,
    };
}

module.exports = { createMessaging, parseLocationFromText };
