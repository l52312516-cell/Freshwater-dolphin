'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let failed = false;
function walk(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['.git', 'work', 'outputs', 'node_modules', 'dist', '__pycache__'].includes(item.name)) continue;
        const file = path.join(directory, item.name);
        if (item.isDirectory()) { walk(file); continue; }
        if (item.name.endsWith('.cjs')) {
            const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
            if (result.status !== 0) failed = true;
        }
        if (file.startsWith(path.join(root, 'webui', 'src', 'assets') + path.sep) && /\.(png|jpe?g|ico)$/i.test(file)) continue;
        const bytes = fs.readFileSync(file);
        if (bytes.includes(13) || bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) {
            console.error('Expected LF and UTF-8 without BOM:', path.relative(root, file));
            failed = true;
        }
    }
}
walk(root);
process.exitCode = failed ? 1 : 0;
