// Outbound messaging: WhatsApp Cloud API, Sendblue (iMessage/SMS), Discord (webhook or bot).
// Every sender returns { ok, mocked, channel, to, externalId?, error? } and never throws.
// When a channel has no credentials it runs in mock mode: the message is logged, not sent.

const digits = v => String(v ?? '').replace(/\D/g, '');

// Best-effort E.164: '+20 122…' → '+20122…'; '00 20 …' → '+20…'; 10 bare digits → default country code.
function normalizePhone(value, defaultCountryCode = '1') {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    if (raw.includes('@')) return raw.toLowerCase(); // Apple ID e-mail (iMessage)
    let d = digits(raw);
    if (!d) return '';
    if (!raw.startsWith('+') && d.startsWith('00')) d = d.slice(2);
    else if (!raw.startsWith('+') && d.length === 10 && defaultCountryCode) d = digits(defaultCountryCode) + d;
    return d.length >= 8 && d.length <= 15 ? `+${d}` : '';
}

function samePhone(a, b) {
    if (!a || !b) return false;
    if (String(a).includes('@') || String(b).includes('@')) return String(a).toLowerCase() === String(b).toLowerCase();
    const x = digits(a); const y = digits(b);
    if (!x || !y) return false;
    if (x === y) return true;
    return x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10);
}

function errorDetail(err) {
    const d = err.response?.data;
    const meta = d?.error;
    if (meta?.message) return `${meta.message}${meta.code ? ` (code ${meta.code})` : ''}`;
    if (d?.message) return String(d.message);
    if (d?.error_message) return String(d.error_message);
    return err.message;
}

function createChannels({ http, getConfig, log = console }) {
    const result = (channel, to, extra) => ({ channel, to, ok: true, mocked: false, ...extra });
    const fail = (channel, to, err) => ({ channel, to, ok: false, mocked: false, error: errorDetail(err) });

    // ---------------- WhatsApp ----------------
    function waConfig() {
        const c = getConfig().whatsapp;
        return { ...c, configured: Boolean(c.token && c.phoneNumberId) };
    }
    function waRecipient(to) {
        const c = getConfig().whatsapp;
        return digits(c.testRecipient || to);
    }
    async function waPost(to, payload) {
        const c = waConfig();
        const recipient = waRecipient(to);
        if (recipient.length < 8) return { channel: 'whatsapp', to: recipient, ok: false, mocked: false, error: 'No valid WhatsApp number' };
        const body = { messaging_product: 'whatsapp', to: recipient, ...payload };
        if (!c.configured) {
            log.log(`[WHATSAPP:mock] to +${recipient}: ${JSON.stringify(payload)}`);
            return { channel: 'whatsapp', to: `+${recipient}`, ok: true, mocked: true };
        }
        try {
            const { data } = await http.post(
                `https://graph.facebook.com/${c.apiVersion}/${c.phoneNumberId}/messages`, body,
                { headers: { Authorization: `Bearer ${c.token}` }, timeout: 10000 },
            );
            return result('whatsapp', `+${recipient}`, { externalId: data?.messages?.[0]?.id });
        } catch (err) {
            log.error('[WHATSAPP] send failed:', errorDetail(err));
            return fail('whatsapp', `+${recipient}`, err);
        }
    }
    const whatsapp = {
        sendText: (to, text) => waPost(to, { type: 'text', text: { body: String(text).slice(0, 4096), preview_url: true } }),
        sendLocation: (to, loc, name, address) => waPost(to, {
            type: 'location', location: { latitude: loc.lat, longitude: loc.lng, name: name || undefined, address: address || undefined },
        }),
        // Job alert. Uses the approved template (business-initiated) unless messageMode is 'text'.
        // Custom templates receive 3 body variables: {{1}} job id, {{2}} address + map link, {{3}} details.
        sendDispatch(to, { id, addressLine, details, fallbackText }) {
            const c = waConfig();
            if (c.messageMode === 'text') return whatsapp.sendText(to, fallbackText);
            const template = { name: c.template || 'hello_world', language: { code: c.templateLang || 'en_US' } };
            if (template.name !== 'hello_world') {
                const clean = s => String(s ?? '').replace(/\s*\n+\s*/g, ' · ').replace(/\s{4,}/g, ' ').slice(0, 900) || '-';
                template.components = [{ type: 'body', parameters: [id, addressLine, details].map(t => ({ type: 'text', text: clean(t) })) }];
            }
            return waPost(to, { type: 'template', template });
        },
    };

    // ---------------- iMessage (Sendblue) ----------------
    const imessage = {
        async sendText(to, text) {
            const c = getConfig().imessage;
            const number = String(to || '').includes('@') ? String(to).trim() : normalizePhone(to, getConfig().company.defaultCountryCode);
            if (!number) return { channel: 'imessage', to, ok: false, mocked: false, error: 'No valid phone number' };
            if (!(c.apiKeyId && c.apiSecret)) {
                log.log(`[IMESSAGE:mock] to ${number}: ${String(text).replace(/\n/g, ' | ')}`);
                return { channel: 'imessage', to: number, ok: true, mocked: true };
            }
            try {
                const body = { number, content: String(text).slice(0, 10000) };
                if (c.fromNumber) body.from_number = normalizePhone(c.fromNumber, '1');
                const { data } = await http.post('https://api.sendblue.com/api/send-message', body, {
                    headers: { 'sb-api-key-id': c.apiKeyId, 'sb-api-secret-key': c.apiSecret }, timeout: 15000,
                });
                if (data && (data.status === 'ERROR' || data.error_message)) {
                    return { channel: 'imessage', to: number, ok: false, mocked: false, error: data.error_message || 'Sendblue error' };
                }
                return result('imessage', number, { externalId: data?.message_handle });
            } catch (err) {
                log.error('[IMESSAGE] send failed:', errorDetail(err));
                return fail('imessage', number, err);
            }
        },
    };

    // ---------------- Discord ----------------
    const DISCORD_API = 'https://discord.com/api/v10';
    const botHeaders = () => ({ Authorization: `Bot ${getConfig().discord.botToken}` });
    const discord = {
        botConfigured: () => Boolean(getConfig().discord.botToken && getConfig().discord.channelId),
        configured: () => discord.botConfigured() || Boolean(getConfig().discord.webhookUrl),
        // Bot mode: post in the dispatch channel and open a thread for the ticket. Webhook mode: just post.
        async sendDispatch({ content, threadName }) {
            const c = getConfig().discord;
            const allowed = { parse: ['users'] };
            if (discord.botConfigured()) {
                try {
                    const { data: msg } = await http.post(`${DISCORD_API}/channels/${c.channelId}/messages`,
                        { content: content.slice(0, 2000), allowed_mentions: allowed }, { headers: botHeaders(), timeout: 10000 });
                    let threadId = null;
                    try {
                        const { data: thread } = await http.post(`${DISCORD_API}/channels/${c.channelId}/messages/${msg.id}/threads`,
                            { name: threadName.slice(0, 100), auto_archive_duration: 10080 }, { headers: botHeaders(), timeout: 10000 });
                        threadId = thread.id;
                    } catch (err) { log.error('[DISCORD] thread create failed:', errorDetail(err)); }
                    return result('discord', `#${c.channelId}`, { externalId: msg.id, threadId });
                } catch (err) {
                    log.error('[DISCORD] bot send failed:', errorDetail(err));
                    return fail('discord', `#${c.channelId}`, err);
                }
            }
            if (c.webhookUrl) {
                try {
                    await http.post(c.webhookUrl, { content: content.slice(0, 2000), allowed_mentions: allowed }, { timeout: 8000 });
                    return result('discord', 'webhook');
                } catch (err) {
                    log.error('[DISCORD] webhook failed:', errorDetail(err));
                    return fail('discord', 'webhook', err);
                }
            }
            log.log(`[DISCORD:mock] ${content.replace(/\n/g, ' | ')}`);
            return { channel: 'discord', to: 'mock', ok: true, mocked: true };
        },
        // Reply inside a ticket's thread (bot mode only).
        async sendToThread(threadId, content) {
            if (!discord.botConfigured()) return { channel: 'discord', to: threadId, ok: false, mocked: false, error: 'Discord replies need the bot token and channel ID in Settings' };
            try {
                const { data } = await http.post(`${DISCORD_API}/channels/${threadId}/messages`,
                    { content: String(content).slice(0, 2000), allowed_mentions: { parse: [] } }, { headers: botHeaders(), timeout: 10000 });
                return result('discord', threadId, { externalId: data.id });
            } catch (err) { return fail('discord', threadId, err); }
        },
        async fetchThreadMessages(threadId, afterId) {
            const { data } = await http.get(`${DISCORD_API}/channels/${threadId}/messages`, {
                params: { limit: 50, ...(afterId ? { after: afterId } : {}) }, headers: botHeaders(), timeout: 10000,
            });
            return Array.isArray(data) ? data : [];
        },
    };

    return { whatsapp, imessage, discord };
}

module.exports = { createChannels, normalizePhone, samePhone, digits, errorDetail };
