#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { WindowsRuntime, assertWorkPath } = require('./runtime.cjs');
const { assertReleaseRoot } = require('./manifest.cjs');
async function confirm(prompt) {
    if (!process.stdin.isTTY) throw new Error('Interactive installation preview is required; run Freshwater in a terminal');
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return (await input.question(prompt)).trim() === 'INSTALL'; } finally { input.close(); }
}
async function main(args = process.argv.slice(2)) {
    const root = path.resolve(__dirname, '../..');
    assertReleaseRoot(root);
    const temp = path.join(root, 'work/temp'); assertWorkPath(root, temp); fs.mkdirSync(temp, { recursive: true });
    Object.assign(process.env, { TEMP: temp, TMP: temp, TMPDIR: temp, npm_config_cache: path.join(root, 'work/cache/npm'), XDG_CACHE_HOME: path.join(root, 'work/cache') });
    const flags = args.filter(arg => arg.startsWith('--'));
    if (flags.some(flag => !['--no-open', '--no-browser', '--previous', '--help'].includes(flag))) throw new Error('Unknown option');
    const names = args.filter(arg => !arg.startsWith('--')); const command = names[0] || 'start';
    if (names.length > 1) throw new Error('Only one command is supported');
    if (flags.includes('--help') || command === 'help') {
        console.log('Freshwater [start|status|open|stop|install|doctor] [--no-open]\n默认前台启动；安装先展示配置和空间预检，输入 INSTALL 后执行。'); return;
    }
    if (!['start', 'status', 'open', 'stop', 'install', 'doctor'].includes(command)) throw new Error('Unknown command: ' + command);
    const runtime = new WindowsRuntime(root);
    const result = command === 'start' ? await runtime.start({ confirm, previous: flags.includes('--previous'), noOpen: flags.includes('--no-open') || flags.includes('--no-browser') }) :
        command === 'install' ? await runtime.install(confirm) : await runtime[command]();
    if (result) console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(error => { console.error('Freshwater：' + error.message); process.exitCode = 1; });
module.exports = { main, confirm };
