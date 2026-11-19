const axios = require('axios');
const { Store, createDriver } = require('./store');
const { createKeys, hashPassword, randomToken } = require('./security');
const { createSettings } = require('./settings');
const { createChannels } = require('./channels');
const { createDispatch } = require('./dispatch');
const { createGeocoder } = require('./geo');
const { seedDemo } = require('./seed');

// Builds everything the app needs. Tests pass their own env, http stub, geocoder and store.
async function createContext({ env = process.env, http = axios, store, geocode, log = console } = {}) {
    store = store || await new Store(createDriver(env)).load();

    const production = env.NODE_ENV === 'production' || Boolean(env.RENDER);
    let appSecret = env.APP_SECRET;
    if (!appSecret) {
        // Fallback so the app still runs; keeping the secret next to the data is weaker, so warn.
        if (!store.meta.generatedAppSecret) store.setMeta({ generatedAppSecret: randomToken(32) });
        appSecret = store.meta.generatedAppSecret;
        if (env.NODE_ENV !== 'test') log.warn('[config] APP_SECRET is not set: using a generated one stored with the data. Set APP_SECRET on the server.');
    }

    const keys = createKeys(appSecret);
    const settings = createSettings(store, keys, env);
    settings.ensureGenerated();
    const channels = createChannels({ http, getConfig: settings.effective, log });
    const dispatch = createDispatch({ store, settings, channels });

    // First admin from environment variables (the safe way to bootstrap a public server).
    if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD && !store.find('users', u => u.role === 'admin')) {
        store.insert('users', { name: env.ADMIN_NAME || 'Admin', email: env.ADMIN_EMAIL.trim().toLowerCase(), role: 'admin', passwordHash: hashPassword(env.ADMIN_PASSWORD), tokenVersion: 0 });
        log.log(`[config] created admin login ${env.ADMIN_EMAIL}`);
    }

    if (env.SEED_DEMO !== 'false' && store.list('tickets').length === 0 && store.list('technicians').length === 0) {
        seedDemo(store, dispatch);
    }

    const config = {
        production,
        corsOrigin: env.CORS_ORIGIN || '*',
        setupCode: env.SETUP_CODE || '',
        publicBaseUrl: env.PUBLIC_BASE_URL || (env.RENDER_EXTERNAL_URL || ''),
        // A local file on a cloud host (e.g. Render) is wiped on every redeploy.
        dataPersistent: store.driver.persistent && !(production && store.driver.kind === 'file'),
    };
    if (!config.dataPersistent && env.NODE_ENV !== 'test') {
        log.warn('[config] Data is NOT persistent on this server. Set DATABASE_URL to a Postgres database.');
    }

    return { store, keys, settings, channels, dispatch, config, http, log, geocode: geocode || createGeocoder(http) };
}

module.exports = { createContext };
