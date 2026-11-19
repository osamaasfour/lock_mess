require('dotenv').config();
const { createContext } = require('./src/context');
const { createApp } = require('./src/app');

async function main() {
    const ctx = await createContext();
    const app = createApp(ctx);
    const port = process.env.PORT || 5000;
    const server = app.listen(port, () => {
        console.log(`🚀 Lock-Ops API on port ${port} (storage: ${ctx.store.driver.kind}${ctx.store.driver.persistent ? '' : ', NOT persistent'})`);
        if (ctx.store.list('users').length === 0) {
            console.log('   No logins yet: open the dashboard to create the first admin, or set ADMIN_EMAIL and ADMIN_PASSWORD.');
        }
    });

    // Write pending changes before the platform stops us (Render sends SIGTERM on redeploy).
    const shutdown = async () => {
        server.close();
        try { await ctx.store.flush(); } catch {}
        if (ctx.stop) ctx.stop();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return ctx;
}

main().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});
