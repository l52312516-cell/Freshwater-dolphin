'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function sourceFiles(root) {
  const files = [];
  const allowedRoots = ['src', 'tests', 'tools', 'deploy', 'docs', 'webui', '.github'];
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
  for (const name of ['package.json', 'package-lock.json', 'requirements-test.txt', 'config.example.json', 'Freshwater.cmd', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitattributes', '.dockerignore']) {
    if (fs.existsSync(path.join(root, name))) visit(name);
  }
  return files.sort();
}

function pack(root = path.resolve(__dirname, '..'), { run = spawnSync, rename = fs.renameSync } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!/^[0-9A-Za-z.+-]+$/.test(version || '')) throw new Error('Package version is invalid');
  const output = path.join(root, 'outputs');
  const temp = path.join(root, 'work', 'temp');
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const archive = path.join(output, 'freshwater-dolphin-' + version + '-source.tar.gz');
  for (const directory of [output, temp]) if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Package directories cannot be symbolic links');
  const files = sourceFiles(root);
  const lock = archive + '.lock';
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  let stage;
  let preserveStage = false;
  try {
    stage = fs.mkdtempSync(path.join(temp, 'package-'));
    const manifest = path.join(stage, 'files.txt');
    const stagedArchive = path.join(stage, 'source.tar.gz');
    fs.writeFileSync(manifest, files.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    const result = run('tar', ['-czf', stagedArchive, '-T', manifest], {
      cwd: root, encoding: 'utf8', env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Source archive failed: ' + result.stderr.trim());
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(stagedArchive)).digest('hex');
    const stagedHash = stagedArchive + '.sha256';
    fs.writeFileSync(stagedHash, sha256 + '  ' + path.basename(archive) + '\n', { flag: 'wx', mode: 0o600 });
    const targets = [archive, archive + '.sha256'];
    const staged = [stagedArchive, stagedHash];
    const previous = targets.map((target, index) => {
      if (!fs.existsSync(target)) return null;
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Existing package must be an ordinary private file');
      const saved = path.join(stage, 'previous-' + index); fs.copyFileSync(target, saved, fs.constants.COPYFILE_EXCL); return saved;
    });
    for (const file of staged) { const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    let published = 0;
    try {
      for (; published < targets.length; published++) rename(staged[published], targets[published]);
    } catch (error) {
      try {
        for (let index = 0; index < published; index++) {
          if (previous[index]) fs.renameSync(previous[index], targets[index]);
          else fs.unlinkSync(targets[index]);
        }
      } catch { preserveStage = true; throw new Error('Package publication rollback requires repair; previous files retained at ' + stage, { cause: error }); }
      throw error;
    }
    return { archive, sha256, files: files.length };
  } finally {
    fs.closeSync(lockFd); fs.unlinkSync(lock);
    if (stage && !preserveStage) fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { console.log(JSON.stringify(pack())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { pack, sourceFiles };
