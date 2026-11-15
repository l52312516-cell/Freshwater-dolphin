#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { workspacePath } = require('./paths.cjs');
const temporary = workspacePath(root, 'work/temp');
fs.mkdirSync(temporary, { recursive: true });
Object.assign(process.env, { TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    npm_config_cache: path.join(root, 'work/cache/npm') });
const { loadConfig } = require('./config.cjs');
const { createLogger } = require('./log.cjs');

async function main(args) {
    const position = args.indexOf('--config');
    if (position >= 0 && !args[position + 1]) throw new Error('--config requires a filename');
    if (args.includes('--help')) {
        console.log('node src/cli.cjs [--config config.json] [--health]'); return;
    }
    const config = loadConfig({ root, file: position < 0 ? undefined : args[position + 1] });
    if (args.includes('--health')) {
        try {
            const status = JSON.parse(fs.readFileSync(config.healthFile, 'utf8'));
            console.log(JSON.stringify(status));
            process.exitCode = Date.now() - status.at < 15000 && status.bridge && status.ready && status.connected ? 0 : 1;
        } catch (_) { console.log(JSON.stringify({ bridge: false, ready: false, connected: false, online: null })); process.exitCode = 1; }
        return;
    }
    const log = createLogger(config.logDirectory);
    const application = await require('./runtime.cjs').run(config, log);
    let closing = false;
    async function close() {
        if (closing) return;
        closing = true;
        const timeout = setTimeout(() => process.exit(1), Math.max(config.actionTimeoutMs, config.mediaActionTimeoutMs) + 2000);
        timeout.unref();
        try { await application.close(); log('adapter_stopped'); }
        finally { clearTimeout(timeout); }
    }
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
    const detail = ['INVALID_CONFIG', 'BUSY'].includes(error.code) ? ': ' + error.message : '';
    process.stderr.write('Freshwater-dolphin: ' + (error.code || 'STARTUP_FAILED') + detail + '\n');
    process.exitCode = 1;
});
module.exports = { main };
