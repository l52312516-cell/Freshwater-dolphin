'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = path.join(root, 'work/temp');
fs.mkdirSync(temp, { recursive: true });
const files = ['tests', 'deploy/tests'].flatMap(directory =>
    fs.readdirSync(path.join(root, directory)).filter(name => name.endsWith('.test.cjs')).sort()
        .map(name => path.join(root, directory, name)));
// Codec workers and filesystem/RPC integration tests are resource intensive.
// Bound file-level parallelism so a high core count cannot exhaust the runner.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...files], {
    cwd: root, stdio: 'inherit', env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp,
        npm_config_cache: path.join(root, 'work/cache/npm') }
});
process.exitCode = result.status === null ? 1 : result.status;
