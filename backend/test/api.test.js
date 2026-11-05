const test = require('node:test');
const assert = require('node:assert');
const { app, computeSplit } = require('../server');

let server, base;
test.before(() => new Promise(resolve => {
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api`; resolve(); });
}));
test.after(() => server.close());

const post = (path, body) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('computeSplit rounds to cents and never goes negative', () => {
    assert.deepStrictEqual(computeSplit(350, 80, 30), { net: 270, companyRemittanceDue: 81, technicianPayout: 269 });
    assert.deepStrictEqual(computeSplit(350, 80.33, 30), { net: 269.67, companyRemittanceDue: 80.9, technicianPayout: 269.1 });
    assert.strictEqual(computeSplit(50, 80, 30).companyRemittanceDue, 0);
});

test('GET /orders returns the three seeded jobs', async () => {
    const data = await (await fetch(base + '/orders')).json();
    assert.deepStrictEqual(data.ledger.map(o => o.id), ['10943', '10944', '10945']);
});

test('finalize-split rejects bad input', async () => {
    assert.strictEqual((await post('/dispatcher/finalize-split', { orderId: '10943', partCost: 'abc', customCompanyRate: 30 })).status, 400);
    assert.strictEqual((await post('/dispatcher/finalize-split', { orderId: '10943', partCost: 10, customCompanyRate: 150 })).status, 400);
    assert.strictEqual((await post('/dispatcher/finalize-split', { orderId: '10943', partCost: 999, customCompanyRate: 30 })).status, 400);
    assert.strictEqual((await post('/dispatcher/finalize-split', { orderId: '99999', partCost: 0, customCompanyRate: 30 })).status, 404);
});

test('finalize-split accepts numeric ids, closes once, then 409s', async () => {
    const res = await post('/dispatcher/finalize-split', { orderId: 10945, grossCollected: '420', partCost: '110.5', customCompanyRate: 25 });
    assert.strictEqual(res.status, 200);
    const { record } = await res.json();
    assert.strictEqual(record.dispatcherStatus, 'Closed');
    assert.strictEqual(record.companyRemittanceDue, 77.38);
    assert.strictEqual(record.technicianPayout, 342.62);
    assert.strictEqual((await post('/dispatcher/finalize-split', { orderId: '10945', partCost: 0, customCompanyRate: 30 })).status, 409);
});

test('discord dispatch is mocked without a webhook and refuses closed jobs', async () => {
    const ok = await (await post('/dispatch/discord', { orderId: '10943' })).json();
    assert.strictEqual(ok.mocked, true);
    assert.strictEqual(ok.record.dispatcherStatus, 'Dispatched');
    assert.strictEqual((await post('/dispatch/discord', { orderId: '10945' })).status, 409);
});

test('whatsapp dispatch is mocked without credentials, uses hello_world by default', async () => {
    const res = await post('/dispatch/whatsapp', { orderId: '10944' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.mocked, true);
    assert.strictEqual(data.mode, 'template');
    assert.strictEqual(data.sentTo, '+15550199');
    assert.strictEqual((await post('/dispatch/whatsapp', { orderId: '10945' })).status, 409);
    assert.strictEqual((await post('/dispatch/whatsapp', { orderId: 'nope' })).status, 404);
});

test('CSV export has a header and one row per order', async () => {
    const res = await fetch(base + '/accounting/export-csv');
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const lines = (await res.text()).trim().split('\r\n');
    assert.strictEqual(lines.length, 4);
    assert.ok(lines[0].startsWith('id,address,techName'));
    assert.ok(lines[1].includes('"Austin, TX (78701)"'));
});
