// Conversation panel on the dispatch board: one thread with the client, one with the technician.
(function () {
    const { api, toast, esc, time } = LockOps;
    const chLabel = { imessage: 'iMessage', whatsapp: 'WhatsApp', discord: 'Discord', app: 'Technician page' };
    const drafts = {};          // `${ticketId}:${party}` → unsent text
    let state = null;           // { el, ticket, party, data, timer, onChange }

    function style() {
        if (document.getElementById('conv-style')) return;
        const s = document.createElement('style');
        s.id = 'conv-style';
        s.textContent = `
            .conv-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
            .conv-tabs button { padding: 8px; border-radius: 7px; border: 1px solid var(--line-2); background: transparent; color: var(--soft); font: inherit; font-weight: 700; cursor: pointer; }
            .conv-tabs button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
            .conv-tabs .n { background: #e11d48; color: #fff; border-radius: 999px; padding: 0 6px; font-size: 11px; margin-left: 4px; }
            .conv-to { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
            .conv-list { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 4px 2px; }
            .msg { max-width: 85%; padding: 8px 11px; border-radius: 12px; overflow-wrap: anywhere; font-size: 13.5px; }
            .msg .body { white-space: pre-wrap; }
            .msg > a.small { display: inline-block; margin-top: 4px; margin-right: 8px; }
            .msg.in { align-self: flex-start; background: #334155; border-bottom-left-radius: 4px; }
            .msg.out { align-self: flex-end; background: #3730a3; border-bottom-right-radius: 4px; }
            .msg.sys { align-self: center; background: transparent; color: var(--muted); font-size: 12px; padding: 2px; }
            .msg.failed { background: #450a0a; border: 1px solid #991b1b; }
            .msg .meta { display: block; font-size: 11px; color: #cbd5e1; opacity: .75; margin-top: 4px; }
            .msg .err { display: block; font-size: 12px; color: #fecaca; margin-top: 4px; }
            .conv-compose { display: flex; gap: 8px; margin-top: 10px; align-items: flex-end; }
            .conv-compose textarea { min-height: 42px; height: 42px; max-height: 140px; }
            .conv-empty { color: var(--muted); font-size: 13px; padding: 10px 0; text-align: center; }`;
        document.head.appendChild(s);
    }

    function linkify(text) {
        return esc(text).replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u.length > 60 ? u.slice(0, 57) + '…' : u}</a>`);
    }

    function bubble(m) {
        if (m.party === 'system') return `<div class="msg sys">${esc(m.text)} · ${time(m.at)}</div>`;
        const failed = m.direction === 'out' && !m.ok;
        const who = m.direction === 'out' ? (m.author || 'Dispatch') : (m.party === 'client' ? 'Client' : 'Technician');
        const status = m.direction !== 'out' ? '' : failed ? ' · ❌ not delivered' : m.mocked ? ' · logged only (channel not set up)' : m.status && m.status !== 'sent' ? ` · ${esc(m.status)}` : ' · sent';
        return [
            `<div class="msg ${m.direction} ${failed ? 'failed' : ''}"><div class="body">${linkify(m.text)}</div>`,
            m.location ? `<a class="small" href="https://www.google.com/maps?q=${m.location.lat},${m.location.lng}" target="_blank" rel="noopener">Open location ↗</a>` : '',
            /^https?:\/\//i.test(m.mediaUrl || "") ? `<a class="small" href="${esc(m.mediaUrl)}" target="_blank" rel="noopener">Open attachment ↗</a>` : '',
            `<span class="meta">${esc(who)} · ${chLabel[m.channel] || esc(m.channel)} · ${time(m.at)}${status}</span>`,
            failed && m.error ? `<span class="err">${esc(m.error)}</span>` : '',
            '</div>',
        ].join('');
    }

    function render() {
        if (!state) return;
        const { el, ticket, party, data } = state;
        const msgs = (data?.messages || []).filter(m => m.party === party || (party === 'technician' && m.party === 'system'));
        const ch = data?.channels?.[party];
        const unread = data?.unread || ticket.unread || {};
        const key = `${ticket.id}:${party}`;
        const list = el.querySelector('.conv-list');
        const atBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        const focused = document.activeElement?.id === 'conv-text';

        let hint = '';
        if (!ch) hint = party === 'client' ? 'This ticket has no client phone number.' : 'Assign a technician to message them.';
        else if (ch.windowOpen === false) hint = `⚠️ WhatsApp delivers free text only within 24 h of their last message. ${party === 'technician' ? 'Job alerts use your template; ask them to reply to it first.' : 'Ask them to message you first.'}`;
        else if (ch.channel === 'discord' && !ch.discordReplies) hint = 'Discord replies need the bot token and channel ID in Settings.';

        el.innerHTML = `
            <div class="row" style="margin-bottom:8px"><h3>Messages</h3></div>
            <div class="conv-tabs">
                <button type="button" data-party="client" class="${party === 'client' ? 'on' : ''}">Client${unread.client ? `<span class="n">${unread.client}</span>` : ''}</button>
                <button type="button" data-party="technician" class="${party === 'technician' ? 'on' : ''}">Technician${unread.technician ? `<span class="n">${unread.technician}</span>` : ''}</button>
            </div>
            ${ch ? `<div class="conv-to">To ${esc(ch.name || ticket.client?.name || '')} via <b>${chLabel[ch.channel]}</b> ${ch.to ? `· ${esc(ch.to)}` : ''}</div>` : ''}
            <div class="conv-list">${msgs.length ? msgs.map(bubble).join('') : `<div class="conv-empty">${data ? 'No messages yet.' : 'Loading…'}</div>`}</div>
            ${hint ? `<div class="small" style="color:#fcd34d;margin-top:8px">${esc(hint)}</div>` : ''}
            ${ch ? `<div class="conv-compose">
                <textarea id="conv-text" placeholder="Message the ${party}… (Ctrl+Enter to send)" maxlength="4000">${esc(drafts[key] || '')}</textarea>
                <button type="button" class="btn btn-primary" id="conv-send">Send</button></div>
                ${party === 'technician' && ['Assigned', 'En route', 'New', 'Completed'].includes(ticket.status) ? '<button type="button" class="btn btn-sm" id="conv-loc" style="margin-top:8px">📍 Send client location to technician</button>' : ''}` : ''}`;

        const newList = el.querySelector('.conv-list');
        if (atBottom) newList.scrollTop = newList.scrollHeight;
        if (focused) { const ta = el.querySelector('#conv-text'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
    }

    async function load() {
        if (!state) return;
        const { ticket } = state;
        try {
            const data = await api(`/api/tickets/${ticket.id}/messages`);
            if (state?.ticket.id !== ticket.id) return;
            const sig = JSON.stringify(data);
            state.data = data;
            if (sig !== state.sig) { state.sig = sig; render(); }
            markRead();
        } catch (e) { if (e.status !== 401) console.warn(e.message); }
    }

    async function markRead() {
        const { ticket, party, data } = state;
        if (!document.hidden && data?.unread?.[party]) {
            data.unread[party] = 0;
            try { await api(`/api/tickets/${ticket.id}/read`, { method: 'POST', body: { party } }); } catch {}
            render();
            state.onChange && state.onChange({ quiet: true });
        }
    }

    async function send() {
        const ta = state.el.querySelector('#conv-text');
        const text = ta.value.trim();
        if (!text) return;
        const btn = state.el.querySelector('#conv-send');
        btn.disabled = true;
        try {
            const r = await api(`/api/tickets/${state.ticket.id}/messages`, { method: 'POST', body: { party: state.party, text } });
            drafts[`${state.ticket.id}:${state.party}`] = '';
            ta.value = '';
            if (!r.sent) toast(`Not delivered: ${r.error}`, 'error');
            else if (r.mocked) toast('Logged only — this channel isn’t set up in Settings yet.');
            await load();
        } catch (e) { toast(e.message, 'error'); }
        finally { const b = state?.el.querySelector('#conv-send'); if (b) b.disabled = false; }
    }

    function bind(el) {
        el.addEventListener('click', async e => {
            const p = e.target.closest('[data-party]')?.dataset.party;
            if (p && p !== state.party) { state.party = p; render(); markRead(); return; }
            if (e.target.id === 'conv-send') return send();
            if (e.target.id === 'conv-loc') {
                e.target.disabled = true;
                try {
                    const r = await api(`/api/tickets/${state.ticket.id}/send-location`, { method: 'POST' });
                    toast(r.sent ? (r.mocked ? 'Location logged (channel not set up).' : 'Client location sent to the technician.') : `Not delivered: ${r.error}`, r.sent ? 'ok' : 'error');
                    await load();
                } catch (err) { toast(err.message, 'error'); }
                finally { e.target.disabled = false; }
            }
        });
        el.addEventListener('input', e => { if (e.target.id === 'conv-text') drafts[`${state.ticket.id}:${state.party}`] = e.target.value; });
        el.addEventListener('keydown', e => { if (e.target.id === 'conv-text' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    }

    window.Conversation = {
        mount(el, ticket, { onChange } = {}) {
            style();
            if (state?.timer) clearInterval(state.timer);
            const unread = ticket.unread || {};
            const party = unread.technician && !unread.client ? 'technician' : 'client';
            state = { el, ticket, party, data: null, onChange, timer: setInterval(() => { if (!document.hidden) load(); }, 5000) };
            bind(el);
            render();
            load();
        },
        // Ticket list refreshed: keep the same panel, pick up status/assignment changes.
        update(ticket) {
            if (!state || state.ticket.id !== ticket.id) return;
            const changed = state.ticket.technicianId !== ticket.technicianId || state.ticket.status !== ticket.status;
            state.ticket = ticket;
            if (changed) load();
        },
    };
})();
