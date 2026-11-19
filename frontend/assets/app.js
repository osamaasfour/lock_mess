// Shared helpers for every Lock-Ops page: backend URL, login session, API calls, nav, formatting.
(function () {
    const PRODUCTION_API = 'https://lock-ops-backend.onrender.com';
    const IS_LOCAL = location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
    const DEFAULT_API = IS_LOCAL ? 'http://localhost:5000' : PRODUCTION_API;

    const store = {
        get(k) { try { return localStorage.getItem(k); } catch { return null; } },
        set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
    };
    const params = new URLSearchParams(location.search);
    if (params.get('api')) store.set('lockops.api', params.get('api'));
    let apiBase = (store.get('lockops.api') || DEFAULT_API).replace(/\/+$/, '');

    let token = store.get('lockops.token');
    let currentUser = null;

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const money = n => '$' + (Number(n) || 0).toFixed(2);
    const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

    function ago(iso) {
        if (!iso) return 'never';
        const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
        if (s < 45) return 'just now';
        if (s < 3600) return `${Math.round(s / 60)} min ago`;
        if (s < 86400) return `${Math.round(s / 3600)} h ago`;
        return new Date(iso).toLocaleDateString();
    }
    const time = iso => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

    class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

    async function api(path, { method = 'GET', body, raw = false, noRedirect = false } = {}) {
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (token) headers.Authorization = `Bearer ${token}`;
        let res;
        try {
            res = await fetch(apiBase + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        } catch (e) {
            throw new ApiError(`Can't reach the server at ${apiBase}. It may be waking up — try again in a minute.`, 0);
        }
        if (res.status === 401 && !noRedirect) { logout(true); throw new ApiError('Please log in again', 401); }
        if (raw) { if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status); return res; }
        let data = null;
        try { data = await res.json(); } catch {}
        if (!res.ok || (data && data.success === false)) throw new ApiError(data?.error || `${res.status} ${res.statusText}`, res.status);
        return data;
    }

    function setSession(newToken, user) {
        token = newToken; store.set('lockops.token', newToken);
        if (user) currentUser = user;
    }

    function logout(expired) {
        token = null; currentUser = null; store.set('lockops.token', null);
        const next = encodeURIComponent(location.pathname.split('/').pop() + location.search);
        location.href = `login.html${expired ? `?next=${next}` : ''}`;
    }

    function homeFor(user) { return user.role === 'technician' ? 'tech.html' : 'index.html'; }

    // Ensures a logged-in user with one of `roles`; redirects otherwise. Returns the user.
    async function requireAuth(roles) {
        if (!token) { logout(true); return new Promise(() => {}); }
        const { user, companyName } = await api('/api/auth/me');
        currentUser = user;
        if (roles && !roles.includes(user.role)) { location.href = homeFor(user); return new Promise(() => {}); }
        if (companyName) document.title = document.title.replace('Lock-Ops', companyName);
        return user;
    }

    function renderNav(active) {
        const u = currentUser;
        const bar = document.createElement('header');
        bar.className = 'topbar';
        const links = [
            ['dispatch', 'index.html', 'Dispatch', ['admin', 'dispatcher']],
            ['technicians', 'technicians.html', 'Technicians', ['admin', 'dispatcher']],
            ['settings', 'settings.html', 'Settings', ['admin']],
        ].filter(l => l[3].includes(u.role));
        bar.innerHTML = `
            <a class="brand" href="${homeFor(u)}">🔐 LOCK-OPS</a>
            <nav class="nav">${links.map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'active' : ''}">${label}</a>`).join('')}</nav>
            <div class="userbox">
                <span class="small">${esc(u.name)} · ${esc(u.role)}</span>
                <button type="button" class="btn btn-sm" data-act="password">Password</button>
                <button type="button" class="btn btn-sm" data-act="logout">Log out</button>
            </div>`;
        bar.querySelector('[data-act=logout]').onclick = () => logout(false);
        bar.querySelector('[data-act=password]').onclick = openPasswordDialog;
        document.body.prepend(bar);
    }

    function openPasswordDialog() {
        const d = document.createElement('dialog');
        d.innerHTML = `<form method="dialog">
            <div class="dialog-head"><h2>Change password</h2></div>
            <div class="field"><label class="label">Current password</label><input type="password" name="cur" required autocomplete="current-password"></div>
            <div class="field"><label class="label">New password (8+ characters)</label><input type="password" name="next" required minlength="8" autocomplete="new-password"></div>
            <div class="dialog-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn btn-primary" value="ok">Save</button></div>
        </form>`;
        document.body.appendChild(d);
        d.querySelector('form').addEventListener('submit', async e => {
            if (e.submitter?.value !== 'ok') return;
            e.preventDefault();
            try {
                const r = await api('/api/auth/password', { method: 'POST', body: { currentPassword: d.querySelector('[name=cur]').value, newPassword: d.querySelector('[name=next]').value } });
                setSession(r.token);
                d.close(); toast('Password changed. Other devices are logged out.');
            } catch (err) { toast(err.message, 'error'); }
        });
        d.addEventListener('close', () => d.remove());
        d.showModal();
    }

    function toast(msg, type = 'ok', ms = 5000) {
        let box = document.getElementById('toasts');
        if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
        const t = document.createElement('div');
        t.className = `toast ${type === 'error' ? 'error' : ''}`;
        t.setAttribute('role', 'status');
        t.textContent = msg;
        box.appendChild(t);
        setTimeout(() => t.remove(), type === 'error' ? Math.max(ms, 8000) : ms);
    }

    function banner(el, html, type = 'error') {
        if (!el) return;
        if (!html) { el.className = 'hidden'; el.innerHTML = ''; return; }
        el.className = `banner ${type}`;
        el.innerHTML = html;
    }

    // Warn staff when the server is running without a database.
    async function checkStorage(el) {
        try {
            const h = await api('/api/health', { noRedirect: true });
            if (h.persistent === false) banner(el, '⚠️ The server has no database connected, so tickets, technicians and settings are lost whenever it restarts. Ask the admin to set <code>DATABASE_URL</code> on the server.', 'warn');
        } catch {}
    }

    function setApiBase() {
        const url = prompt('Backend URL (e.g. https://your-app.onrender.com):', apiBase);
        if (url === null) return;
        apiBase = (url.trim() || DEFAULT_API).replace(/\/+$/, '');
        store.set('lockops.api', apiBase);
        location.reload();
    }

    window.LockOps = {
        api, ApiError, setSession, logout, requireAuth, renderNav, toast, banner, checkStorage, setApiBase, homeFor,
        $, $$, esc, money, round2, ago, time, store,
        get apiBase() { return apiBase; }, get user() { return currentUser; }, get token() { return token; },
    };
})();
