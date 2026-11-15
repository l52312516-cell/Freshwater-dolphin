'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = path.join(root, 'work/temp');
fs.mkdirSync(temp, { recursive: true });
const files = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.cjs'));
// Codec workers and filesystem/RPC integration tests are resource intensive.
// Bound file-level parallelism so a high core count cannot exhaust the runner.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...files.map(name => path.join(root, 'tests', name))], {
    cwd: root, stdio: 'inherit', env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp,
        npm_config_cache: path.join(root, 'work/cache/npm') }
});
process.exitCode = result.status === null ? 1 : result.status;
