#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { privateDirectory, read, atomic } = require('./files.cjs');
const { fault } = require('../errors.cjs');
const temporary = privateDirectory(root, 'work/temp');
Object.assign(process.env, { TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    npm_config_cache: path.join(root, 'work/cache/npm'), XDG_CACHE_HOME: path.join(root, 'work/cache') });

async function main(args) {
    if (args.includes('--migrate-legacy')) return require('./migrate.cjs').migrate(root);
    if (args.includes('--health')) {
        const state = read(path.join(root, 'work/control/health.json'), {});
        if (!state.at || Date.now() - state.at > 15000 || !state.manager) throw new Error('Manager unavailable');
        return { manager: true };
    }
    const hasCert = Boolean(process.env.FWD_TLS_CERT), hasKey = Boolean(process.env.FWD_TLS_KEY);
    if (hasCert !== hasKey) throw fault('INVALID_CONFIG', 'FWD_TLS_CERT and FWD_TLS_KEY must be configured together');
    const tls = hasCert ? {
        cert: fs.readFileSync(require('../paths.cjs').workspacePath(root, process.env.FWD_TLS_CERT)),
        key: fs.readFileSync(require('../paths.cjs').workspacePath(root, process.env.FWD_TLS_KEY))
    } : undefined;
    const manager = await require('./server.cjs').createManager({ root, https: tls });
    const port = process.env.FWD_WEBUI_PORT ? Number(process.env.FWD_WEBUI_PORT) : manager.settings.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid management port');
    let location;
    try { location = await manager.app.listen({ host: manager.settings.host, port }); }
    catch (error) { await manager.close(); throw error; }
    const health = path.join(root, 'work/control/health.json');
    const update = () => atomic(health, { at: Date.now(), manager: true, accounts: manager.accounts.processes.size });
    update(); const timer = setInterval(update, 3000);
    process.stdout.write(JSON.stringify({ event: 'management_started', address: location, initialized: Boolean(manager.auth.record),
        ...(manager.auth.record ? {} : { setupCredentialFile: 'work/control/setup-token.txt' }) }) + '\n');
    if (!tls) process.stdout.write(JSON.stringify({ event: 'management_http', message: 'HTTP is unencrypted. Configure TLS or an HTTPS reverse proxy for public access.' }) + '\n');
    let closing = false;
    const close = async () => {
        if (closing) return; closing = true; clearInterval(timer);
        const timeout = setTimeout(() => process.exit(1), 95000); timeout.unref();
        try { await manager.close(); atomic(health, { at: Date.now(), manager: false }); } finally { clearTimeout(timeout); }
    };
    process.once('SIGTERM', close); process.once('SIGINT', close);
    return undefined;
}
if (require.main === module) main(process.argv.slice(2)).then(result => { if (result) console.log(JSON.stringify(result)); }).catch(error => {
    console.error(JSON.stringify({ event: 'management_failed', code: error.code || 'STARTUP_FAILED', message: error.code ? error.message : 'Manager startup failed' }));
    process.exitCode = 1;
});
module.exports = { main };
