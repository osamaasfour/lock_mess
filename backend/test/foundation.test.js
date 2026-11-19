const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('./helpers');
const { computeSplit } = require('../src/dispatch');
const { normalizePhone, samePhone } = require('../src/channels');
const { distanceKm } = require('../src/geo');
const { Store, PostgresDriver } = require('../src/store');

test('pure helpers', () => {
    assert.deepStrictEqual(computeSplit(350, 80.33, 30), { net: 269.67, companyRemittanceDue: 80.9, technicianPayout: 269.1 });
    assert.strictEqual(normalizePhone('(512) 555-0100'), '+15125550100');
    assert.strictEqual(normalizePhone('+20 122 511 3392'), '+201225113392');
    assert.strictEqual(normalizePhone('0020 122 511 3392'), '+201225113392');
    assert.strictEqual(normalizePhone('123'), '');
    assert.ok(samePhone('+1 (512) 555-0100', '5125550100'));
    assert.ok(!samePhone('+15125550100', '+15125550101'));
    assert.ok(Math.abs(distanceKm({ lat: 30.2672, lng: -97.7431 }, { lat: 29.7604, lng: -95.3698 }) - 235) < 5); // Austin → Houston
});

test('postgres driver round-trips state (pg-mem)', async () => {
    const { newDb } = require('pg-mem');
    const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg();
    const driver = new PostgresDriver('postgres://x/y?sslmode=disable', Pool);
    const s1 = await new Store(driver).load();
    s1.insert('technicians', { name: 'A' });
    await s1.flush();
    const s2 = await new Store(new PostgresDriver('postgres://x/y?sslmode=disable', Pool)).load();
    assert.strictEqual(s2.list('technicians')[0].name, 'A');
});

test('logins, roles and setup', async t => {
    const s = await startServer();
    t.after(() => s.close());

    let r = await s.call('GET', '/auth/status');
    assert.strictEqual(r.body.needsSetup, true);
    assert.strictEqual((await s.call('GET', '/tickets')).status, 401);

    r = await s.call('POST', '/auth/setup', { name: 'Osama', email: 'Admin@Example.com', password: 'longpassword' });
    assert.strictEqual(r.status, 200);
    s.setToken(r.body.token);
    assert.strictEqual((await s.call('POST', '/auth/setup', { name: 'X', email: 'x@y.z', password: 'longpassword' })).status, 403, 'setup only once');

    r = await s.call('POST', '/users', { name: 'Dee', email: 'dee@example.com', password: 'short', role: 'dispatcher' });
    assert.strictEqual(r.status, 400);
    r = await s.call('POST', '/users', { name: 'Dee', email: 'dee@example.com', password: 'dispatcher1', role: 'dispatcher' });
    assert.strictEqual(r.status, 200);

    const dee = await s.loginAs('dee@example.com', 'dispatcher1');
    assert.strictEqual((await s.call('GET', '/tickets', undefined, { token: dee })).status, 200);
    assert.strictEqual((await s.call('GET', '/settings', undefined, { token: dee })).status, 403, 'dispatchers cannot see settings');
    assert.strictEqual((await s.call('POST', '/technicians', { name: 'T' }, { token: dee })).status, 403);
    assert.strictEqual((await s.call('POST', '/auth/login', { email: 'dee@example.com', password: 'wrong' }, { token: null })).status, 401);

    // last admin cannot be removed
    const me = (await s.call('GET', '/auth/me')).body.user;
    assert.strictEqual((await s.call('PUT', `/users/${me.id}`, { role: 'dispatcher' })).status, 409);

    // password change invalidates old tokens
    const old = (await s.call('POST', '/auth/login', { email: 'dee@example.com', password: 'dispatcher1' }, { token: null })).body.token;
    const changed = await s.call('POST', '/auth/password', { currentPassword: 'dispatcher1', newPassword: 'dispatcher2' }, { token: old });
    assert.strictEqual(changed.status, 200);
    assert.strictEqual((await s.call('GET', '/auth/me', undefined, { token: old })).status, 401);
    assert.strictEqual((await s.call('GET', '/auth/me', undefined, { token: changed.body.token })).status, 200);
});

test('production: public setup blocked, admin from env', async t => {
    const s = await startServer({ env: { RENDER: 'true', ADMIN_EMAIL: 'boss@co.com', ADMIN_PASSWORD: 'supersecret1' } });
    t.after(() => s.close());
    const blocked = await startServer({ env: { RENDER: 'true' } });
    t.after(() => blocked.close());
    assert.strictEqual((await blocked.call('POST', '/auth/setup', { name: 'Evil', email: 'e@e.com', password: 'longpassword' })).status, 403);
    assert.ok(await s.loginAs('boss@co.com', 'supersecret1'));
});

test('settings: secrets encrypted, masked, env fallback', async t => {
    const s = await startServer({ env: { WHATSAPP_PHONE_NUMBER_ID: '999', ADMIN_EMAIL: 'a@a.com', ADMIN_PASSWORD: 'password123' } });
    t.after(() => s.close());
    s.setToken(await s.loginAs('a@a.com', 'password123'));
    let r = await s.call('GET', '/settings');
    assert.strictEqual(r.body.settings.whatsapp.phoneNumberId.value, '999');
    assert.strictEqual(r.body.settings.whatsapp.phoneNumberId.source, 'env');
    assert.strictEqual(r.body.settings.whatsapp.verifyToken.set, true, 'verify token auto-generated');

    r = await s.call('PUT', '/settings', { settings: { whatsapp: { token: 'EAAsecretTOKEN1234', phoneNumberId: '111' }, imessage: { apiKeyId: 'kid', apiSecret: 'sbsecret' } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.settings.whatsapp.token.hint, '••••1234');
    assert.ok(!JSON.stringify(r.body).includes('EAAsecretTOKEN1234'), 'secret never echoed');
    assert.ok(!JSON.stringify(s.ctx.store.state.settings).includes('EAAsecretTOKEN1234'), 'secret encrypted at rest');
    assert.strictEqual(s.ctx.settings.effective().whatsapp.token, 'EAAsecretTOKEN1234');
    assert.strictEqual(s.ctx.settings.effective().whatsapp.phoneNumberId, '111');

    // blank secret keeps; null clears; blank normal field falls back to env
    await s.call('PUT', '/settings', { settings: { whatsapp: { token: '', phoneNumberId: '' } } });
    assert.strictEqual(s.ctx.settings.effective().whatsapp.token, 'EAAsecretTOKEN1234');
    assert.strictEqual(s.ctx.settings.effective().whatsapp.phoneNumberId, '999');
    await s.call('PUT', '/settings', { settings: { whatsapp: { token: null } } });
    assert.strictEqual(s.ctx.settings.effective().whatsapp.token, '');
    assert.strictEqual((await s.call('PUT', '/settings', { settings: { company: { distanceUnit: 'parsecs' } } })).status, 400);
});

async function adminServer(opts = {}) {
    const s = await startServer({ ...opts, env: { ADMIN_EMAIL: 'a@a.com', ADMIN_PASSWORD: 'password123', ...(opts.env || {}) } });
    s.setToken(await s.loginAs('a@a.com', 'password123'));
    return s;
}

test('technicians CRUD with geocoded base and login', async t => {
    const s = await adminServer();
    t.after(() => s.close());
    s.geocodes.set('austin, tx', { lat: 30.2672, lng: -97.7431 });
    let r = await s.call('POST', '/technicians', { name: 'Marcus', phone: '512 555 0100', channel: 'imessage', baseAddress: 'Austin, TX', skills: 'Smart locks, Auto', loginEmail: 'marcus@co.com', password: 'techpass123' });
    assert.strictEqual(r.status, 200, r.text);
    const tech = r.body.technician;
    assert.strictEqual(tech.phone, '+15125550100');
    assert.deepStrictEqual(tech.skills, ['Smart locks', 'Auto']);
    assert.deepStrictEqual(tech.baseLocation, { lat: 30.2672, lng: -97.7431 });
    assert.strictEqual(tech.positionSource, 'base');
    assert.strictEqual(tech.hasLogin, true);

    assert.strictEqual((await s.call('POST', '/technicians', { name: 'NoPhone', channel: 'whatsapp' })).status, 400);
    assert.strictEqual((await s.call('POST', '/technicians', { name: 'D', channel: 'discord', discordUserId: 'abc' })).status, 400);
    assert.strictEqual((await s.call('POST', '/technicians', { name: 'D', channel: 'discord', discordUserId: '123456789012345678' })).status, 200);

    r = await s.call('PUT', `/technicians/${tech.id}`, { status: 'off', notes: 'Night shift' });
    assert.strictEqual(r.body.technician.status, 'off');
    assert.strictEqual(r.body.technician.phone, '+15125550100');

    // technician login can use the GPS endpoints but not dispatcher ones
    const techToken = await s.loginAs('marcus@co.com', 'techpass123');
    assert.strictEqual((await s.call('GET', '/tickets', undefined, { token: techToken })).status, 403);
    assert.strictEqual((await s.call('POST', '/me/location', { lat: 30.3, lng: -97.7, accuracy: 12.4 }, { token: techToken })).status, 200);
    assert.strictEqual((await s.call('POST', '/me/location', { lat: 300, lng: 0 }, { token: techToken })).status, 400);
    r = await s.call('GET', '/me/jobs', undefined, { token: techToken });
    assert.strictEqual(r.body.technician.positionSource, 'live');

    assert.strictEqual((await s.call('DELETE', `/technicians/${tech.id}`)).status, 200);
    assert.strictEqual((await s.call('POST', '/auth/login', { email: 'marcus@co.com', password: 'techpass123' }, { token: null })).status, 401, 'login removed with technician');
});

test('tickets: create, nearest technicians, assign + notify, technician flow, finalize', async t => {
    const s = await adminServer();
    t.after(() => s.close());
    s.geocodes.set('1100 congress ave, austin, tx', { lat: 30.2747, lng: -97.7404 });
    const mk = body => s.call('POST', '/technicians', body).then(r => r.body.technician);
    const near = await mk({ name: 'Near', phone: '+15125550101', channel: 'imessage', baseLocation: { lat: 30.28, lng: -97.74 }, loginEmail: 'near@co.com', password: 'techpass123' });
    const far = await mk({ name: 'Far', phone: '+15125550102', channel: 'whatsapp', baseLocation: { lat: 29.76, lng: -95.37 } });
    const off = await mk({ name: 'Off', phone: '+15125550103', channel: 'imessage', baseLocation: { lat: 30.2748, lng: -97.7405 }, status: 'off' });

    assert.strictEqual((await s.call('POST', '/tickets', { client: { name: 'Jo' } })).status, 400);
    let r = await s.call('POST', '/tickets', { client: { name: 'Jo', phone: '5125559999' }, address: '1100 Congress Ave, Austin, TX', issue: 'Locked out' });
    assert.strictEqual(r.status, 200, r.text);
    const ticket = r.body.ticket;
    assert.strictEqual(ticket.locationSource, 'geocoded');
    assert.strictEqual(ticket.client.phone, '+15125559999');
    assert.match(ticket.directionsUrl, /destination=30\.274700,-97\.740400/);

    r = await s.call('GET', `/tickets/${ticket.id}/candidates`);
    assert.deepStrictEqual(r.body.candidates.map(c => c.name), ['Near', 'Far', 'Off'], 'available first, nearest first, off last');
    assert.strictEqual(r.body.candidates[0].distanceUnit, 'mi');
    assert.ok(r.body.candidates[0].distance < 1);
    assert.ok(r.body.candidates[1].distance > 100);

    r = await s.call('POST', `/tickets/${ticket.id}/assign`, { technicianId: near.id });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.ticket.status, 'Assigned');
    assert.strictEqual(r.body.notification.channel, 'imessage');
    assert.strictEqual(r.body.notification.mocked, true);
    assert.strictEqual((await s.call('GET', '/technicians')).body.technicians.find(x => x.id === near.id).status, 'busy');
    const msg = s.ctx.store.list('messages').find(m => m.ticketId === ticket.id);
    assert.match(msg.text, /New job #\d+/);
    assert.match(msg.text, /Directions: https:\/\/www\.google\.com\/maps\/dir/);

    // real Sendblue call once configured
    await s.call('PUT', '/settings', { settings: { imessage: { apiKeyId: 'kid', apiSecret: 'ksecret', fromNumber: '+15125550000' } } });
    s.http.reply('sendblue.com', { status: 'QUEUED', message_handle: 'H1' });
    r = await s.call('POST', `/tickets/${ticket.id}/assign`, { technicianId: near.id });
    const sb = s.http.calls.find(c => c.url.includes('sendblue.com'));
    assert.strictEqual(sb.body.number, '+15125550101');
    assert.strictEqual(sb.body.from_number, '+15125550000');
    assert.strictEqual(sb.opts.headers['sb-api-key-id'], 'kid');
    assert.strictEqual(r.body.notification.mocked, false);
    assert.strictEqual(r.body.notification.externalId, 'H1');

    // WhatsApp technician with a custom template gets 3 parameters incl. map link
    await s.call('PUT', '/settings', { settings: { whatsapp: { token: 'tok', phoneNumberId: '42', template: 'job_dispatch' } } });
    s.http.reply('graph.facebook.com', { messages: [{ id: 'wamid.1' }] });
    r = await s.call('POST', `/tickets/${ticket.id}/assign`, { technicianId: far.id });
    const wa = s.http.calls.find(c => c.url.includes('graph.facebook.com/v23.0/42/messages'));
    assert.strictEqual(wa.body.to, '15125550102');
    assert.strictEqual(wa.body.template.name, 'job_dispatch');
    const params = wa.body.template.components[0].parameters.map(p => p.text);
    assert.strictEqual(params[0], ticket.id);
    assert.match(params[1], /1100 Congress Ave.*google\.com\/maps/);
    assert.match(params[2], /Locked out.*Client: Jo/);
    assert.ok(!params.some(p => p.includes('\n')), 'no newlines in template params');
    assert.strictEqual((await s.call('GET', '/technicians')).body.technicians.find(x => x.id === near.id).status, 'available', 'previous tech released');

    // back to Near; the technician marks progress from their page
    await s.call('POST', `/tickets/${ticket.id}/assign`, { technicianId: near.id, notify: false });
    const techToken = await s.loginAs('near@co.com', 'techpass123');
    r = await s.call('GET', '/me/jobs', undefined, { token: techToken });
    assert.strictEqual(r.body.jobs.length, 1);
    assert.strictEqual(r.body.jobs[0].client.phone, '+15125559999');
    assert.strictEqual((await s.call('POST', `/me/jobs/${ticket.id}/status`, { status: 'Completed' }, { token: techToken })).status, 200);

    // finalize closes, frees the technician, rejects a second close
    assert.strictEqual((await s.call('POST', `/tickets/${ticket.id}/finalize`, { grossCollected: 350, partCost: 'abc', customCompanyRate: 30 })).status, 400);
    r = await s.call('POST', `/tickets/${ticket.id}/finalize`, { grossCollected: 350, partCost: 80, customCompanyRate: 30 });
    assert.strictEqual(r.body.ticket.status, 'Closed');
    assert.strictEqual(r.body.ticket.companyRemittanceDue, 81);
    assert.strictEqual((await s.call('POST', `/tickets/${ticket.id}/finalize`, { grossCollected: 1, partCost: 0, customCompanyRate: 30 })).status, 409);
    assert.strictEqual((await s.call('GET', '/technicians')).body.technicians.find(x => x.id === near.id).status, 'available');
    assert.strictEqual((await s.call('GET', '/tickets')).body.tickets.length, 0, 'closed tickets hidden from open list');
    assert.strictEqual((await s.call('GET', '/tickets?scope=all')).body.tickets.length, 1);
    assert.strictEqual((await s.call('DELETE', `/technicians/${off.id}`)).status, 200);

    const csv = await s.call('GET', '/accounting/export-csv');
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.text, /Closed/);
});

test('public request form creates a ticket; honeypot and rate limit', async t => {
    const s = await adminServer();
    t.after(() => s.close());
    let r = await s.call('POST', '/public/requests', { name: 'Kim', phone: '512 555 0177', issue: 'Car lockout', location: { lat: 30.26, lng: -97.75 } }, { token: null });
    assert.strictEqual(r.status, 200, r.text);
    const ticket = s.ctx.store.get('tickets', r.body.ticketId);
    assert.strictEqual(ticket.source, 'form');
    assert.strictEqual(ticket.locationSource, 'gps');
    assert.strictEqual(ticket.client.phone, '+15125550177');
    assert.strictEqual((await s.call('POST', '/public/requests', { name: 'Kim', phone: 'x', address: 'a' }, { token: null })).status, 400);
    r = await s.call('POST', '/public/requests', { name: 'Bot', phone: '5125550100', address: 'x', website: 'spam.com' }, { token: null });
    assert.strictEqual(r.body.ticketId, null);
    let last;
    for (let i = 0; i < 6; i++) last = await s.call('POST', '/public/requests', { name: 'K', phone: '5125550100', address: 'Austin TX' }, { token: null });
    assert.strictEqual(last.status, 429);
});

test('demo seed', async t => {
    const s = await adminServer({ seed: true });
    t.after(() => s.close());
    const tickets = (await s.call('GET', '/tickets')).body.tickets;
    assert.strictEqual(tickets.length, 3);
    const c = (await s.call('GET', `/tickets/${tickets.find(k => k.address.includes('Congress')).id}/candidates`)).body.candidates;
    assert.match(c[0].name, /Marcus/, 'nearest available Austin tech first');
    assert.strictEqual(c[0].positionSource, 'live');
});
