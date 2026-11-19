// Company settings + integration keys. Secrets are encrypted at rest and never sent back in full.
// Lookup order for every field: value saved on the Settings page → environment variable → default.
const { randomToken } = require('./security');

const SCHEMA = {
    company: {
        name: { default: 'Lock-Ops' },
        distanceUnit: { default: 'mi', options: ['mi', 'km'] },
        defaultCompanyRate: { default: '30' },
        defaultCountryCode: { default: '1' }, // used when a phone number is typed without +country code
        frontendUrl: { env: 'FRONTEND_URL', default: '' },
        autoReply: { default: 'on', options: ['on', 'off'] }, // confirm new requests that arrive by message
    },
    whatsapp: {
        token: { secret: true, env: 'WHATSAPP_TOKEN' },
        phoneNumberId: { env: 'WHATSAPP_PHONE_NUMBER_ID' },
        appSecret: { secret: true, env: 'WHATSAPP_APP_SECRET' },
        verifyToken: { secret: true, env: 'WHATSAPP_VERIFY_TOKEN', generate: true },
        messageMode: { default: 'template', options: ['template', 'text'] },
        template: { env: 'WHATSAPP_TEMPLATE', default: 'hello_world' },
        templateLang: { env: 'WHATSAPP_TEMPLATE_LANG', default: 'en_US' },
        apiVersion: { env: 'WHATSAPP_API_VERSION', default: 'v23.0' },
        testRecipient: { env: 'WHATSAPP_TEST_RECIPIENT' },
    },
    discord: {
        webhookUrl: { secret: true, env: 'DISCORD_WEBHOOK_URL' },
        botToken: { secret: true, env: 'DISCORD_BOT_TOKEN' },
        channelId: { env: 'DISCORD_CHANNEL_ID' },
    },
    imessage: {
        apiKeyId: { env: 'SENDBLUE_API_KEY_ID' },
        apiSecret: { secret: true, env: 'SENDBLUE_API_SECRET' },
        fromNumber: { env: 'SENDBLUE_FROM_NUMBER' },
        webhookSecret: { secret: true, env: 'SENDBLUE_WEBHOOK_SECRET', generate: true },
    },
};

function createSettings(store, keys, env = process.env) {
    const raw = () => store.settings || {};

    function stored(section, field) {
        const v = raw()[section]?.[field];
        if (v === undefined || v === null) return undefined;
        if (SCHEMA[section][field].secret) return keys.decrypt(v) ?? undefined;
        return v;
    }

    function resolve(section, field) {
        const def = SCHEMA[section][field];
        const s = stored(section, field);
        if (s !== undefined && s !== '') return { value: s, source: 'settings' };
        // Legacy: WHATSAPP_TEMPLATE set to an empty string meant "send plain text".
        if (section === 'whatsapp' && field === 'messageMode' && env.WHATSAPP_TEMPLATE === '') return { value: 'text', source: 'env' };
        if (def.env && env[def.env]) return { value: env[def.env], source: 'env' };
        return { value: def.default ?? '', source: def.default ? 'default' : 'none' };
    }

    // Plain object with every effective value, for the server's own use.
    function effective() {
        const out = {};
        for (const [section, fields] of Object.entries(SCHEMA)) {
            out[section] = {};
            for (const field of Object.keys(fields)) out[section][field] = resolve(section, field).value;
        }
        return out;
    }

    // What the Settings page sees: secrets are masked.
    function publicView() {
        const out = {};
        for (const [section, fields] of Object.entries(SCHEMA)) {
            out[section] = {};
            for (const [field, def] of Object.entries(fields)) {
                const { value, source } = resolve(section, field);
                out[section][field] = def.secret
                    ? { secret: true, set: Boolean(value), hint: value ? `••••${String(value).slice(-4)}` : '', source }
                    : { value, source, ...(def.options ? { options: def.options } : {}) };
            }
        }
        return out;
    }

    // patch = { section: { field: value } }. Secrets: '' or undefined keeps, null clears.
    // Other fields: '' or null clears (falls back to env/default).
    function update(patch) {
        const next = JSON.parse(JSON.stringify(raw()));
        const errors = [];
        for (const [section, fields] of Object.entries(patch || {})) {
            if (!SCHEMA[section] || typeof fields !== 'object' || !fields) { errors.push(`Unknown section: ${section}`); continue; }
            next[section] = next[section] || {};
            for (const [field, value] of Object.entries(fields)) {
                const def = SCHEMA[section][field];
                if (!def) { errors.push(`Unknown field: ${section}.${field}`); continue; }
                if (def.secret) {
                    if (value === null) delete next[section][field];
                    else if (typeof value === 'string' && value.trim()) next[section][field] = keys.encrypt(value.trim());
                    continue;
                }
                if (value === null || value === '') { delete next[section][field]; continue; }
                const v = String(value).trim().slice(0, 500);
                if (def.options && !def.options.includes(v)) { errors.push(`${section}.${field} must be one of ${def.options.join(', ')}`); continue; }
                next[section][field] = v;
            }
        }
        if (errors.length) return { errors };
        store.setSettings(next);
        return { errors: [] };
    }

    // Create random verify/webhook secrets once, so webhook URLs work without manual setup.
    function ensureGenerated() {
        const next = JSON.parse(JSON.stringify(raw()));
        let changed = false;
        for (const [section, fields] of Object.entries(SCHEMA)) {
            for (const [field, def] of Object.entries(fields)) {
                if (!def.generate || resolve(section, field).value) continue;
                next[section] = next[section] || {};
                next[section][field] = keys.encrypt(randomToken(18));
                changed = true;
            }
        }
        if (changed) store.setSettings(next);
    }

    return { effective, publicView, update, ensureGenerated, SCHEMA };
}

module.exports = { createSettings, SCHEMA };
