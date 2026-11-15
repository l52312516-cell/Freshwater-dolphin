'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const hosts = new Set(['qqdl.gtimg.cn', 'dldir1.qq.com']);
function official(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password) {
    throw new Error('QQ URL must use HTTPS on qqdl.gtimg.cn or dldir1.qq.com');
  }
  return url;
}

async function download({ url, sha256, root = path.resolve(__dirname, '..') }) {
  if (!/^[a-fA-F0-9]{64}$/.test(sha256 || '')) throw new Error('An expected SHA256 is required');
  let source = official(url);
  const directory = path.join(root, 'work', 'cache', 'downloads');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, 'QQ.deb');
  const temporary = path.join(directory, 'QQ.' + crypto.randomBytes(8).toString('hex') + '.part');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  let response;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetch(source, { redirect: 'manual', signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 5) throw new Error('QQ download redirect limit reached');
        source = official(new URL(location, source));
      } else break;
    }
    if (!response.ok || !response.body) throw new Error('QQ download failed: HTTP ' + response.status);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const inspect = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024 * 1024) return callback(new Error('QQ package exceeds size limit'));
      hash.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), inspect, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (!size || hash.digest('hex') !== sha256.toLowerCase()) throw new Error('QQ SHA256 mismatch; file was not installed');
    const descriptor = fs.openSync(temporary, 'r');
    try {
      const magic = Buffer.alloc(8);
      fs.readSync(descriptor, magic, 0, 8, 0);
      if (magic.toString() !== '!<arch>\n') throw new Error('QQ package is not a Debian archive');
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, target);
    fs.writeFileSync(path.join(directory, 'QQ.sha256'), sha256.toLowerCase() + '  QQ.deb\n', { mode: 0o600 });
    return { file: target, sha256: sha256.toLowerCase(), bytes: size };
  } finally {
    clearTimeout(timer);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

if (require.main === module) {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--url' && args[index + 1]) options.url = args[++index];
    else if (args[index] === '--sha256' && args[index + 1]) options.sha256 = args[++index];
    else { console.error('Usage: node tools/download-qq.cjs --url OFFICIAL_HTTPS_URL --sha256 EXPECTED_SHA256'); process.exit(1); }
  }
  download(options).then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { official, download };
