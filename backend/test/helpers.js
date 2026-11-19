const { Store, MemoryDriver } = require('../src/store');
const { createContext } = require('../src/context');
const { createApp } = require('../src/app');

// Records every outbound HTTP call; responses can be scripted per URL substring.
function stubHttp() {
    const calls = [];
    const routes = [];
    const handle = method => async (url, body, opts) => {
        calls.push({ method, url, body, opts });
        const r = routes.find(x => url.includes(x.match) && (!x.method || x.method === method));
        if (r?.error) { const e = new Error(r.error.message || 'fail'); e.response = r.error.response; throw e; }
        return { data: typeof r?.data === 'function' ? r.data(url, body, opts) : (r?.data ?? {}) };
    };
    return {
        calls, routes,
        post: handle('post'),
        get: (url, opts) => handle('get')(url, undefined, opts),
        reply(match, data, method) { routes.unshift({ match, data, method }); },
        failOn(match, error) { routes.unshift({ match, error }); },
        reset() { calls.length = 0; routes.length = 0; },
    };
}

const silent = { log() {}, warn() {}, error() {} };

async function startServer({ env = {}, seed = false, store } = {}) {
    const http = stubHttp();
    const geocodes = new Map();
    const ctx = await createContext({
        env: { NODE_ENV: 'test', APP_SECRET: 'test-secret', SEED_DEMO: seed ? 'true' : 'false', ...env },
        http,
        store: store || new Store(new MemoryDriver()),
        geocode: async address => geocodes.get(String(address).toLowerCase()) ?? null,
        log: silent,
    });
    const app = createApp(ctx);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;

    let token = null;
    async function call(method, path, body, opts = {}) {
        const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
        const t = opts.token === undefined ? token : opts.token;
        if (t) headers.Authorization = `Bearer ${t}`;
        const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch {}
        return { status: res.status, body: json, text, headers: res.headers };
    }

    return {
        ctx, http, geocodes, base, call,
        setToken(t) { token = t; },
        async loginAs(email, password) {
            const r = await call('POST', '/auth/login', { email, password }, { token: null });
            if (r.status !== 200) throw new Error(`login failed: ${r.text}`);
            return r.body.token;
        },
        close: () => new Promise(r => server.close(r)),
    };
}

module.exports = { startServer, stubHttp, silent };
