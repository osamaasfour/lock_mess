// Tiny document store: everything lives in memory and is persisted as one JSON document.
// Drivers: memory (tests), file (local dev), postgres (production, via DATABASE_URL).
// Designed for a single backend instance and a small company's volume of data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COLLECTIONS = ['users', 'technicians', 'tickets', 'messages'];

function emptyState() {
    return { version: 1, users: [], technicians: [], tickets: [], messages: [], settings: {}, meta: { nextTicketNumber: 10943 } };
}

class MemoryDriver {
    constructor() { this.kind = 'memory'; this.persistent = false; }
    async load() { return null; }
    async save() {}
}

class FileDriver {
    constructor(file) { this.kind = 'file'; this.persistent = true; this.file = file; }
    async load() {
        try { return JSON.parse(await fs.promises.readFile(this.file, 'utf8')); }
        catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    }
    async save(state) {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(state));
        await fs.promises.rename(tmp, this.file);
    }
}

class PostgresDriver {
    // `Pool` can be injected for tests (pg-mem); production uses the `pg` package.
    constructor(connectionString, Pool) {
        this.kind = 'postgres';
        this.persistent = true;
        const PgPool = Pool || require('pg').Pool;
        const needsSsl = connectionString && !/localhost|127\.0\.0\.1|sslmode=disable/.test(connectionString);
        this.pool = new PgPool({ connectionString, ssl: needsSsl ? { rejectUnauthorized: false } : undefined, max: 3 });
    }
    async load() {
        await this.pool.query('CREATE TABLE IF NOT EXISTS lockops_state (id INTEGER PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
        const { rows } = await this.pool.query('SELECT data FROM lockops_state WHERE id = 1');
        if (!rows.length) return null;
        return typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    }
    async save(state) {
        await this.pool.query(
            'INSERT INTO lockops_state (id, data, updated_at) VALUES (1, $1, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()',
            [JSON.stringify(state)],
        );
    }
    async close() { await this.pool.end(); }
}

class Store {
    constructor(driver = new MemoryDriver()) {
        this.driver = driver;
        this.state = emptyState();
        this._timer = null;
        this._saving = Promise.resolve();
        this.lastSaveError = null;
    }

    async load() {
        const loaded = await this.driver.load();
        if (loaded) {
            const base = emptyState();
            this.state = { ...base, ...loaded, meta: { ...base.meta, ...(loaded.meta || {}) } };
            for (const c of COLLECTIONS) if (!Array.isArray(this.state[c])) this.state[c] = [];
        }
        return this;
    }

    isEmpty() { return COLLECTIONS.every(c => this.state[c].length === 0); }

    // ---- persistence: debounce writes, never lose the last one ----
    touch() {
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this.flush(), 300);
        if (this._timer.unref) this._timer.unref();
    }
    flush() {
        clearTimeout(this._timer);
        const snapshot = JSON.parse(JSON.stringify(this.state));
        this._saving = this._saving.then(() => this.driver.save(snapshot)).then(
            () => { this.lastSaveError = null; },
            err => { this.lastSaveError = err.message; console.error('[store] save failed:', err.message); },
        );
        return this._saving;
    }

    // ---- collections ----
    list(col) { return this.state[col]; }
    get(col, id) { return this.state[col].find(x => x.id === String(id)); }
    find(col, pred) { return this.state[col].find(pred); }
    filter(col, pred) { return this.state[col].filter(pred); }
    insert(col, doc) {
        const now = new Date().toISOString();
        const row = { id: doc.id || crypto.randomUUID(), createdAt: now, updatedAt: now, ...doc };
        this.state[col].push(row);
        this.touch();
        return row;
    }
    update(col, id, patch) {
        const row = this.get(col, id);
        if (!row) return null;
        Object.assign(row, patch, { updatedAt: new Date().toISOString() });
        this.touch();
        return row;
    }
    remove(col, id) {
        const i = this.state[col].findIndex(x => x.id === String(id));
        if (i === -1) return false;
        this.state[col].splice(i, 1);
        this.touch();
        return true;
    }
    nextTicketId() {
        const n = this.state.meta.nextTicketNumber++;
        this.touch();
        return String(n);
    }

    // ---- singletons ----
    get settings() { return this.state.settings; }
    setSettings(next) { this.state.settings = next; this.touch(); }
    get meta() { return this.state.meta; }
    setMeta(patch) { Object.assign(this.state.meta, patch); this.touch(); }
}

function createDriver(env) {
    if (env.DATABASE_URL) return new PostgresDriver(env.DATABASE_URL);
    if (env.NODE_ENV === 'test') return new MemoryDriver();
    return new FileDriver(env.DATA_FILE || path.join(__dirname, '..', 'data', 'lockops.json'));
}

module.exports = { Store, MemoryDriver, FileDriver, PostgresDriver, createDriver };
