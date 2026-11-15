'use strict';

// A stdin sink for the third-party QQ process; keep raw diagnostic files bounded.
const fs = require('node:fs');
const path = require('node:path');
const file = process.argv[2];
if (!file || !path.isAbsolute(file)) throw new Error('An absolute log path is required');
const limit = 10 * 1024 * 1024;
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
function rotate() {
  for (let index = 2; index >= 0; index--) {
    const from = file + (index ? '.' + index : '');
    const to = file + '.' + (index + 1);
    try { fs.renameSync(from, to); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  size = 0;
}
process.stdin.on('data', chunk => {
  if (size + chunk.length > limit) rotate();
  fs.appendFileSync(file, chunk, { mode: 0o600 });
  size += chunk.length;
});
process.stdin.on('error', error => { console.error('QQ log stream failed: ' + error.code); process.exitCode = 1; });
