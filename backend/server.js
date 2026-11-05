const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();

// ---- Config (all optional, see README) ------------------------------------
const PORT = process.env.PORT || 5000;
const API_KEY = process.env.DISPATCH_API_KEY || '';           // if set, required on every /api call except /api/health
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';           // e.g. https://lockmess-frontend.vercel.app (comma-separated for several)
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

// WhatsApp Cloud API (Meta). Mock mode unless both TOKEN and PHONE_NUMBER_ID are set.
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';
// Template to send. 'hello_world' = Meta's built-in test template (no variables).
// Your own template should take 3 body variables: {{1}} job id, {{2}} address, {{3}} notes.
// Empty = send plain text (only delivered within 24h of the technician last messaging you).
const WHATSAPP_TEMPLATE = process.env.WHATSAPP_TEMPLATE ?? 'hello_world';
const WHATSAPP_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';
// While testing, send every WhatsApp alert to this number instead of the technician's.
const WHATSAPP_TEST_RECIPIENT = process.env.WHATSAPP_TEST_RECIPIENT || '';

app.use(cors({
    origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map(s => s.trim()),
    allowedHeaders: ['Content-Type', 'X-API-Key'],
    exposedHeaders: ['Content-Disposition'],
}));
app.use(express.json({ limit: '50kb' }));

// ---- Helpers ---------------------------------------------------------------
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Parses a money/percent value. Returns a finite number or null.
function toNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(n) ? n : null;
}

function computeSplit(gross, partCost, ratePct) {
    const net = Math.max(gross - partCost, 0);
    const companyShare = round2(net * (ratePct / 100));
    return {
        net: round2(net),
        companyRemittanceDue: companyShare,
        technicianPayout: round2(gross - companyShare), // tech keeps parts reimbursement + their share
    };
}

function requireKey(req, res, next) {
    if (!API_KEY || req.path === '/health') return next();
    if (req.get('X-API-Key') === API_KEY) return next();
    return res.status(401).json({ success: false, error: 'Missing or invalid API key' });
}
app.use('/api', requireKey);

function csvCell(value) {
    const s = value === null || value === undefined ? '' : String(value);
    // Quote when needed; neutralise spreadsheet formula injection (=, +, -, @ at start of text)
    const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// ---- In-memory database (resets on restart; swap for a real DB before production) ----
let ordersDb = [
    { id: '10943', address: 'Austin, TX (78701)', techName: 'Marcus K.', techPhone: '+1 555 0144', notes: 'Yale Assure keypad crazed by intense sun. Keypad swapping required.', dispatcherStatus: 'Review Pending', grossCollected: 350, partCost: 80, companyRate: 30, companyRemittanceDue: 81, technicianPayout: 269, location: { lat: 30.2672, lng: -97.7431 } },
    { id: '10944', address: 'Miami, FL (33101)', techName: 'Alex R.', techPhone: '+1 555 0199', notes: 'Emergency lock out. High security biometric reset.', dispatcherStatus: 'Dispatched', grossCollected: 180, partCost: 0, companyRate: 30, companyRemittanceDue: 54, technicianPayout: 126, location: { lat: 25.7617, lng: -80.1918 } },
    { id: '10945', address: 'Los Angeles, CA (90012)', techName: 'Dave J.', techPhone: '+1 555 0172', notes: 'Full residential lock core rebuilds.', dispatcherStatus: 'Review Pending', grossCollected: 420, partCost: 110, companyRate: 30, companyRemittanceDue: 93, technicianPayout: 327, location: { lat: 34.0522, lng: -118.2437 } },
];

const findOrder = id => ordersDb.find(o => o.id === String(id ?? '').trim());

// ---- Routes ----------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ success: true, authRequired: Boolean(API_KEY) }));

// 1. Get all jobs (dispatcher map & feed)
app.get('/api/orders', (req, res) => res.json({ success: true, ledger: ordersDb }));

// 2. Dispatch alert via Discord (real webhook when DISCORD_WEBHOOK_URL is set, otherwise mocked)
app.post('/api/dispatch/discord', async (req, res) => {
    const order = findOrder(req.body?.orderId);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.dispatcherStatus === 'Closed') {
        return res.status(409).json({ success: false, error: 'Order is already closed' });
    }

    const content = `🔐 **Dispatch #${order.id}** — ${order.address}\nTech: ${order.techName}\nNotes: ${order.notes}`;

    if (!DISCORD_WEBHOOK_URL) {
        console.log(`[DISCORD:mock] ${content.replace(/\n/g, ' | ')}`);
    } else {
        try {
            await axios.post(DISCORD_WEBHOOK_URL, { content, allowed_mentions: { parse: [] } }, { timeout: 8000 });
        } catch (err) {
            console.error('[DISCORD] webhook failed:', err.message);
            return res.status(502).json({ success: false, error: 'Discord webhook failed' });
        }
    }

    order.dispatcherStatus = 'Dispatched';
    res.json({ success: true, mocked: !DISCORD_WEBHOOK_URL, record: order });
});

// 2b. Dispatch alert via WhatsApp Cloud API (mocked until WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set)
function buildWhatsAppPayload(order, to) {
    if (!WHATSAPP_TEMPLATE) {
        return {
            messaging_product: 'whatsapp', to, type: 'text',
            text: { body: `🔐 Dispatch #${order.id} — ${order.address}\nTech: ${order.techName}\nNotes: ${order.notes}` },
        };
    }
    const template = { name: WHATSAPP_TEMPLATE, language: { code: WHATSAPP_TEMPLATE_LANG } };
    if (WHATSAPP_TEMPLATE !== 'hello_world') {
        template.components = [{
            type: 'body',
            parameters: [order.id, order.address, order.notes].map(text => ({ type: 'text', text: String(text) })),
        }];
    }
    return { messaging_product: 'whatsapp', to, type: 'template', template };
}

app.post('/api/dispatch/whatsapp', async (req, res) => {
    const order = findOrder(req.body?.orderId);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.dispatcherStatus === 'Closed') {
        return res.status(409).json({ success: false, error: 'Order is already closed' });
    }

    const to = String(WHATSAPP_TEST_RECIPIENT || order.techPhone || '').replace(/\D/g, '');
    if (to.length < 8) return res.status(400).json({ success: false, error: 'No valid WhatsApp number for this technician' });

    const payload = buildWhatsAppPayload(order, to);
    const mocked = !(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID);

    if (mocked) {
        console.log(`[WHATSAPP:mock] to +${to}: ${JSON.stringify(payload.template || payload.text)}`);
    } else {
        try {
            await axios.post(
                `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
                payload,
                { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, timeout: 10000 },
            );
        } catch (err) {
            const metaError = err.response?.data?.error;
            const detail = metaError ? `${metaError.message}${metaError.code ? ` (code ${metaError.code})` : ''}` : err.message;
            console.error('[WHATSAPP] send failed:', detail);
            return res.status(502).json({ success: false, error: `WhatsApp send failed: ${detail}` });
        }
    }

    order.dispatcherStatus = 'Dispatched';
    res.json({ success: true, mocked, sentTo: `+${to}`, mode: payload.type, record: order });
});

// 3. Finalize the financial split for a job
app.post('/api/dispatcher/finalize-split', (req, res) => {
    const { orderId, grossCollected, partCost, customCompanyRate } = req.body || {};
    const order = findOrder(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.dispatcherStatus === 'Closed') {
        return res.status(409).json({ success: false, error: 'Order is already closed' });
    }

    const gross = grossCollected === undefined ? order.grossCollected : toNumber(grossCollected);
    const parts = toNumber(partCost);
    const rate = toNumber(customCompanyRate);

    const errors = [];
    if (gross === null || gross < 0) errors.push('grossCollected must be a number ≥ 0');
    if (parts === null || parts < 0) errors.push('partCost must be a number ≥ 0');
    if (rate === null || rate < 0 || rate > 100) errors.push('customCompanyRate must be between 0 and 100');
    if (errors.length === 0 && parts > gross) errors.push('partCost cannot exceed grossCollected');
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('; ') });

    const split = computeSplit(gross, parts, rate);
    Object.assign(order, {
        grossCollected: round2(gross),
        partCost: round2(parts),
        companyRate: round2(rate),
        companyRemittanceDue: split.companyRemittanceDue,
        technicianPayout: split.technicianPayout,
        dispatcherStatus: 'Closed',
        closedAt: new Date().toISOString(),
    });

    res.json({ success: true, record: order });
});

// 4. Accounting ledger export (.csv)
app.get('/api/accounting/export-csv', (req, res) => {
    const fields = ['id', 'address', 'techName', 'dispatcherStatus', 'grossCollected', 'partCost', 'companyRate', 'companyRemittanceDue', 'technicianPayout', 'closedAt'];
    const rows = [fields.join(',')].concat(ordersDb.map(o => fields.map(f => csvCell(o[f])).join(',')));
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment('lock-ops-ledger.csv');
    res.send(rows.join('\r\n') + '\r\n');
});

app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Unknown endpoint' }));

if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Dispatch API active on port ${PORT}${API_KEY ? ' (API key required)' : ''}`));
}

module.exports = { app, computeSplit, toNumber, buildWhatsAppPayload };
