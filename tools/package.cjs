'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function sourceFiles(root) {
  const files = [];
  const allowedRoots = ['src', 'tests', 'tools', 'deploy', 'docs', 'webui'];
  function visit(relative) {
    const filename = path.join(root, relative);
    const info = fs.lstatSync(filename);
    if (info.isSymbolicLink()) throw new Error('Source package rejects symbolic links: ' + relative);
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) {
        if (['node_modules', 'dist', 'work', 'outputs', '.cache', '__pycache__'].includes(name)) continue;
        visit(path.posix.join(relative, name));
      }
    } else if (info.isFile()) {
      if (/[\r\n]/.test(relative) || /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|deb|so|dll|zip|tar|gz)|credentials[^/]*)$/i.test(relative)) {
        throw new Error('Unexpected private or binary material in source tree: ' + relative);
      }
      files.push(relative);
    }
  }
  for (const name of allowedRoots) if (fs.existsSync(path.join(root, name))) visit(name);
  for (const name of ['package.json', 'package-lock.json', 'requirements-test.txt', 'config.example.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitattributes', '.dockerignore']) {
    if (fs.existsSync(path.join(root, name))) visit(name);
  }
  return files.sort();
}

function pack(root = path.resolve(__dirname, '..')) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!/^[0-9A-Za-z.+-]+$/.test(version || '')) throw new Error('Package version is invalid');
  const output = path.join(root, 'outputs');
  const temp = path.join(root, 'work', 'temp');
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const archive = path.join(output, 'freshwater-dolphin-' + version + '-source.tar.gz');
  const manifest = path.join(temp, 'package-' + crypto.randomBytes(8).toString('hex') + '.txt');
  const files = sourceFiles(root);
  fs.writeFileSync(manifest, files.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  try {
    const result = spawnSync('tar', ['-czf', archive, '-T', manifest], {
      cwd: root, encoding: 'utf8', env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Source archive failed: ' + result.stderr.trim());
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(archive + '.sha256', sha256 + '  ' + path.basename(archive) + '\n');
    return { archive, sha256, files: files.length };
  } finally { fs.unlinkSync(manifest); }
}

if (require.main === module) {
  try { console.log(JSON.stringify(pack())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { pack, sourceFiles };
