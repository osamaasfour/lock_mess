const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startServer } = require('./helpers');
const { parseLocationFromText } = require('../src/messaging');

async function setup() {
    const s = await startServer({ env: { ADMIN_EMAIL: 'a@a.com', ADMIN_PASSWORD: 'password123' } });
    s.setToken(await s.loginAs('a@a.com', 'password123'));
    await s.call('PUT', '/settings', { settings: {
        whatsapp: { token: 'tok', phoneNumberId: '42', appSecret: 'appsecret', messageMode: 'template', template: 'hello_world' },
        imessage: { apiKeyId: 'kid', apiSecret: 'ksecret' },
    } });
    s.http.reply('sendblue.com', { status: 'QUEUED', message_handle: 'H' });
    s.http.reply('graph.facebook.com', { messages: [{ id: 'wamid.out' }] });
    const hooks = (await s.call('GET', '/settings')).body.webhooks;
    return { s, hooks };
}
const waSend = (s, body) => {
    const raw = JSON.stringify(body);
    const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(raw).digest('hex');
    return s.call('POST', '/webhooks/whatsapp', raw, { token: null, headers: { 'X-Hub-Signature-256': sig } });
};
const waText = (from, text, id, name = '') => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id, type: 'text', text: { body: text } }] } }] }] });
const settle = () => new Promise(r => setTimeout(r, 60)); // webhooks are processed after the 200

test('location links are parsed', () => {
    assert.deepStrictEqual(parseLocationFromText('here http://maps.apple.com/?ll=30.2672,-97.7431&q=Pin'), { lat: 30.2672, lng: -97.7431 });
    assert.deepStrictEqual(parseLocationFromText('https://www.google.com/maps/@30.25,-97.75,15z'), { lat: 30.25, lng: -97.75 });
    assert.deepStrictEqual(parseLocationFromText('https://maps.google.com/?q=25.77,-80.19'), { lat: 25.77, lng: -80.19 });
    assert.strictEqual(parseLocationFromText('no link here 30.1, -97.1'), null);
});

test('webhook URLs, WhatsApp verification handshake and signature check', async t => {
    const { s, hooks } = await setup();
    t.after(() => s.close());
    assert.match(hooks.whatsapp.url, /\/api\/webhooks\/whatsapp$/);
    assert.ok(hooks.whatsapp.verifyToken.length > 10);
    assert.match(hooks.imessage.url, /\/api\/webhooks\/sendblue\/.+/);

    let r = await fetch(`${s.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(hooks.whatsapp.verifyToken)}&hub.challenge=12345`);
    assert.strictEqual(await r.text(), '12345');
    r = await fetch(`${s.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
    assert.strictEqual(r.status, 403);

    const forged = await s.call('POST', '/webhooks/whatsapp', waText('15125550000', 'hi', 'x'), { token: null, headers: { 'X-Hub-Signature-256': 'sha256=bad' } });
    assert.strictEqual(forged.status, 401);
    assert.strictEqual(s.ctx.store.list('tickets').length, 0, 'forged message ignored');

    assert.strictEqual((await s.call('POST', '/webhooks/sendblue/wrong', { content: 'x', number: '+15125550000' }, { token: null })).status, 404);
});

test('new client on WhatsApp creates a ticket, gets an auto-reply; replies thread into it', async t => {
    const { s } = await setup();
    t.after(() => s.close());
    assert.strictEqual((await waSend(s, waText('15125550111', 'Locked out of my car at HEB', 'wamid.1', 'Rita Gomez'))).status, 200);
    await settle();
    let tickets = (await s.call('GET', '/tickets')).body.tickets;
    assert.strictEqual(tickets.length, 1);
    const tk = tickets[0];
    assert.strictEqual(tk.source, 'whatsapp');
    assert.strictEqual(tk.client.name, 'Rita Gomez');
    assert.strictEqual(tk.client.channel, 'whatsapp');
    assert.strictEqual(tk.issue, 'Locked out of my car at HEB');
    assert.strictEqual(tk.unread.client, 1);
    const autoReply = s.http.calls.find(c => c.url.includes('graph.facebook.com') && c.body.type === 'text');
    assert.match(autoReply.body.text.body, new RegExp(`#${tk.id}`));

    // duplicate delivery of the same webhook is ignored
    await waSend(s, waText('15125550111', 'Locked out of my car at HEB', 'wamid.1', 'Rita Gomez')); await settle();
    // shared location goes to the same ticket and puts it on the map
    await waSend(s, { entry: [{ changes: [{ value: { messages: [{ from: '15125550111', id: 'wamid.2', type: 'location', location: { latitude: 30.31, longitude: -97.72, name: 'HEB' } }] } }] }] });
    await settle();
    tickets = (await s.call('GET', '/tickets')).body.tickets;
    assert.strictEqual(tickets.length, 1);
    assert.deepStrictEqual(tickets[0].location, { lat: 30.31, lng: -97.72 });
    assert.strictEqual(tickets[0].locationSource, 'whatsapp');

    const msgs = (await s.call('GET', `/tickets/${tk.id}/messages`)).body;
    assert.deepStrictEqual(msgs.messages.map(m => `${m.direction}:${m.party}`), ['in:client', 'out:client', 'in:client']);
    assert.strictEqual(msgs.channels.client.windowOpen, true);
    assert.strictEqual(msgs.unread.client, 2);
    await s.call('POST', `/tickets/${tk.id}/read`, { party: 'client' });
    assert.strictEqual((await s.call('GET', `/tickets/${tk.id}/messages`)).body.unread.client, 0);

    // dispatcher replies as free text inside the 24 h window
    s.http.calls.length = 0;
    const r = await s.call('POST', `/tickets/${tk.id}/messages`, { party: 'client', text: 'A technician is on the way!' });
    assert.strictEqual(r.body.sent, true);
    assert.strictEqual(s.http.calls[0].body.text.body, 'A technician is on the way!');
    assert.strictEqual(r.body.message.author, 'Admin');

    // delivery receipt marks the message failed with Meta's reason
    await waSend(s, { entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.out', status: 'failed', errors: [{ title: 'Re-engagement message' }] }] } }] }] });
    await settle();
    const failed = (await s.call('GET', `/tickets/${tk.id}/messages`)).body.messages.filter(m => m.error === 'Re-engagement message');
    assert.ok(failed.length >= 1);
});

test('iMessage: technician gets job, replies route to ticket, shared location updates GPS; client conversation', async t => {
    const { s, hooks } = await setup();
    t.after(() => s.close());
    const sbPath = new URL(hooks.imessage.url).pathname.replace('/api', '');
    const tech = (await s.call('POST', '/technicians', { name: 'Omar', phone: '+15125550188', channel: 'imessage', baseLocation: { lat: 30.2, lng: -97.7 } })).body.technician;
    const tk = (await s.call('POST', '/tickets', { client: { name: 'Lee', phone: '+15125550142' }, address: 'x', location: { lat: 30.26, lng: -97.74 }, issue: 'Rekey' })).body.ticket;
    await s.call('POST', `/tickets/${tk.id}/assign`, { technicianId: tech.id });

    await s.call('POST', sbPath, { is_outbound: false, number: '+15125550188', content: 'On it, 15 min', message_handle: 'm1', service: 'iMessage' }, { token: null });
    await s.call('POST', sbPath, { is_outbound: false, number: '+15125550188', content: 'I am here http://maps.apple.com/?ll=30.2601,-97.7402', message_handle: 'm2' }, { token: null });
    await s.call('POST', sbPath, { is_outbound: true, number: '+15125550188', content: 'echo of our own message' }, { token: null });
    await settle();
    const conv = (await s.call('GET', `/tickets/${tk.id}/messages`)).body;
    const techMsgs = conv.messages.filter(m => m.party === 'technician');
    assert.deepStrictEqual(techMsgs.map(m => m.direction), ['out', 'in', 'in']);
    assert.strictEqual(conv.unread.technician, 2);
    const techNow = (await s.call('GET', '/technicians')).body.technicians[0];
    assert.strictEqual(techNow.positionSource, 'live');
    assert.deepStrictEqual(techNow.position, { lat: 30.2601, lng: -97.7402 });

    // send client location to technician → iMessage text with directions link
    s.http.calls.length = 0;
    assert.strictEqual((await s.call('POST', `/tickets/${tk.id}/send-location`)).body.sent, true);
    assert.match(s.http.calls[0].body.content, /maps\/dir\/\?api=1&destination=30\.260000,-97\.740000/);

    // client conversation over iMessage
    s.http.calls.length = 0;
    await s.call('POST', `/tickets/${tk.id}/messages`, { party: 'client', text: 'Omar is 15 minutes away' });
    assert.strictEqual(s.http.calls[0].body.number, '+15125550142');
    await s.call('POST', sbPath, { is_outbound: false, number: '+15125550142', content: 'Thanks!', message_handle: 'c1' }, { token: null });
    await settle();
    assert.strictEqual((await s.call('GET', `/tickets/${tk.id}/messages`)).body.messages.at(-1).party, 'client');

    // unknown iMessage sender = new client request
    await s.call('POST', sbPath, { is_outbound: false, number: '+13105550000', content: 'Need a locksmith at 5th & Main' }, { token: null });
    await settle();
    const fresh = (await s.call('GET', '/tickets')).body.tickets.find(k => k.client.phone === '+13105550000');
    assert.strictEqual(fresh.source, 'imessage');
    assert.ok(s.http.calls.some(c => c.body?.number === '+13105550000' && /We received your request/.test(c.body.content)), 'auto-reply sent');
});

test('WhatsApp test-recipient mode: replies follow the last conversation', async t => {
    const { s } = await setup();
    t.after(() => s.close());
    await s.call('PUT', '/settings', { settings: { whatsapp: { testRecipient: '+201225113392' } } });
    const tech = (await s.call('POST', '/technicians', { name: 'Sara', phone: '+15125550155', channel: 'whatsapp' })).body.technician;
    const tk = (await s.call('POST', '/tickets', { client: { name: 'Jo', phone: '+15125550999' }, address: 'x', location: { lat: 30, lng: -97 } })).body.ticket;
    await s.call('POST', `/tickets/${tk.id}/assign`, { technicianId: tech.id });
    assert.strictEqual(s.http.calls.find(c => c.url.includes('graph')).body.to, '201225113392');
    await waSend(s, waText('201225113392', 'Got it, heading there', 'w9', 'Osama')); await settle();
    const conv = (await s.call('GET', `/tickets/${tk.id}/messages`)).body;
    assert.strictEqual(conv.messages.at(-1).party, 'technician');
    assert.strictEqual((await s.call('GET', '/tickets')).body.tickets.length, 1, 'no stray ticket created');
    // now the 24 h window is open → location goes as a native pin
    s.http.calls.length = 0;
    await s.call('POST', `/tickets/${tk.id}/send-location`);
    assert.strictEqual(s.http.calls[0].body.type, 'location');
    assert.strictEqual(s.http.calls[0].body.location.latitude, 30);
});

test('Discord bot: thread per job, replies polled into the ticket, dispatcher answers in thread', async t => {
    const { s } = await setup();
    t.after(() => s.close());
    await s.call('PUT', '/settings', { settings: { discord: { botToken: 'bot-token', channelId: '111' } } });
    s.http.reply('/channels/111/messages/900/threads', { id: '900' }, 'post');
    s.http.reply('/channels/111/messages', { id: '900' }, 'post');
    const tech = (await s.call('POST', '/technicians', { name: 'Dave', channel: 'discord', discordUserId: '123456789012345678' })).body.technician;
    const tk = (await s.call('POST', '/tickets', { client: { name: 'Al' }, address: 'x', location: { lat: 34, lng: -118 } })).body.ticket;
    const r = await s.call('POST', `/tickets/${tk.id}/assign`, { technicianId: tech.id });
    assert.strictEqual(r.body.notification.threadId, '900');
    const post = s.http.calls.find(c => c.url.endsWith('/channels/111/messages'));
    assert.match(post.body.content, /^<@123456789012345678> 🔐 New job/);
    assert.strictEqual(post.opts.headers.Authorization, 'Bot bot-token');

    s.http.reply('/channels/900/messages', [
        { id: '902', author: { id: '123456789012345678', username: 'dave' }, content: 'Omw' },
        { id: '901', author: { id: '1', bot: true }, content: 'bot echo' },
    ], 'get');
    await s.ctx.messaging.pollDiscord();
    await s.ctx.messaging.pollDiscord(); // second poll: cursor moved, same messages not duplicated
    const conv = (await s.call('GET', `/tickets/${tk.id}/messages`)).body;
    assert.deepStrictEqual(conv.messages.filter(m => m.direction === 'in').map(m => m.text), ['Omw']);
    assert.strictEqual(s.http.calls.filter(c => c.method === 'get').at(-1).opts.params.after, '902');

    s.http.reply('/channels/900/messages', { id: '903' }, 'post');
    const sent = await s.call('POST', `/tickets/${tk.id}/messages`, { party: 'technician', text: 'Client is at the back door' });
    assert.strictEqual(sent.body.sent, true);
    assert.ok(s.http.calls.some(c => c.method === 'post' && c.url.endsWith('/channels/900/messages') && c.body.content.includes('back door')));
});

test('technician message with no open job lands in the unlinked inbox', async t => {
    const { s, hooks } = await setup();
    t.after(() => s.close());
    await s.call('POST', '/technicians', { name: 'Omar', phone: '+15125550188', channel: 'imessage' });
    await s.call('POST', new URL(hooks.imessage.url).pathname.replace('/api', ''), { is_outbound: false, number: '+15125550188', content: 'Free for a job?' }, { token: null });
    await settle();
    const inbox = (await s.call('GET', '/messages/unlinked')).body.messages;
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].technician, 'Omar');
    assert.strictEqual((await s.call('GET', '/tickets')).body.tickets.length, 0, 'technicians never create client tickets');
    await s.call('POST', `/messages/${inbox[0].id}/dismiss`);
    assert.strictEqual((await s.call('GET', '/messages/unlinked')).body.messages.length, 0);
});
