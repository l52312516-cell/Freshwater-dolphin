'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepare } = require('../tools/prepare-qq.cjs');
const { official, download } = require('../tools/download-qq.cjs');
const { sourceFiles } = require('../tools/package.cjs');

const workspace = path.resolve(__dirname, '..');
const temporary = path.join(workspace, 'work', 'temp');
fs.mkdirSync(temporary, { recursive: true });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(temporary, 'deploy-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(temporary + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const app = path.join(root, 'work', 'qq-root', 'opt', 'QQ', 'resources', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'qq'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'qq', 'entry.cjs'), 'exports.bootstrap = value => value;\n');
  fs.writeFileSync(path.join(app, 'main.cjs'), 'module.exports = {};\n');
  const original = Buffer.from('{\r\n  "name": "QQ 测试",\r\n  "main": "main.cjs"\r\n}\r\n');
  fs.writeFileSync(path.join(app, 'package.json'), original);
  return { root, app, original };
}

test('QQ entry preparation is idempotent and restore preserves exact original bytes', t => {
  const { root, app, original } = fixture(t);
  const first = prepare({ root, appDir: app });
  assert.equal(first.changed, true);
  const prepared = fs.readFileSync(path.join(app, 'package.json'));
  assert.equal(JSON.parse(prepared).main, 'freshwater-entry.cjs');
  assert.equal(prepare({ root, appDir: app }).changed, false);
  assert.deepEqual(fs.readFileSync(path.join(app, 'package.json')), prepared);
  assert.equal(prepare({ root, appDir: app, restore: true }).changed, true);
  assert.deepEqual(fs.readFileSync(path.join(app, 'package.json')), original);
  assert.equal(fs.existsSync(path.join(app, 'freshwater-entry.cjs')), false);
  assert.equal(prepare({ root, appDir: app, restore: true }).changed, false);
});

test('QQ entry refuses restoring files changed by another owner', t => {
  const { root, app } = fixture(t);
  prepare({ root, appDir: app });
  const proxy = path.join(app, 'freshwater-entry.cjs');
  fs.appendFileSync(proxy, '// user modification\n');
  assert.throws(() => prepare({ root, appDir: app, restore: true }), /ownership check failed/);
  assert.match(fs.readFileSync(proxy, 'utf8'), /user modification/);
  assert.ok(fs.existsSync(path.join(app, '.freshwater-package.original')));
});

test('QQ ASAR virtual entry is preserved for Electron and restores exact package bytes', t => {
  const { root, app } = fixture(t);
  fs.writeFileSync(path.join(app, 'application.asar'), 'opaque archive fixture; Node must not expand it');
  const original = Buffer.from('{\r\n"main":"application.asar/app_launcher/index.js"\r\n}\r\n');
  fs.writeFileSync(path.join(app, 'package.json'), original);
  assert.equal(prepare({ root, appDir: app }).changed, true);
  const expected = path.join(app, 'application.asar', 'app_launcher', 'index.js');
  assert.ok(fs.readFileSync(path.join(app, 'freshwater-entry.cjs'), 'utf8').includes(JSON.stringify(expected)));
  assert.equal(fs.statSync(path.join(app, 'application.asar')).isFile(), true);
  assert.equal(prepare({ root, appDir: app }).changed, false);
  prepare({ root, appDir: app, restore: true });
  assert.deepEqual(fs.readFileSync(path.join(app, 'package.json')), original);
  assert.equal(fs.readFileSync(path.join(app, 'application.asar'), 'utf8'), 'opaque archive fixture; Node must not expand it');
});

test('QQ entry rejects a nonexistent ordinary main and missing ASAR archive', t => {
  const { root, app } = fixture(t);
  for (const main of ['missing/main.js', 'missing.asar/app_launcher/index.js', 'main.cjs/not-a-directory.js']) {
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ main }));
    assert.throws(() => prepare({ root, appDir: app }), /does not exist as a file or within an ordinary ASAR/);
    assert.equal(fs.existsSync(path.join(app, '.freshwater-package.original')), false);
  }
});

test('QQ ASAR lexical escape is rejected before modifying package metadata', t => {
  const { root, app } = fixture(t);
  fs.writeFileSync(path.join(root, 'work', 'outside.asar'), 'not app-owned');
  const main = path.relative(app, path.join(root, 'work', 'outside.asar', 'main.js'));
  const original = Buffer.from(JSON.stringify({ main }));
  fs.writeFileSync(path.join(app, 'package.json'), original);
  assert.throws(() => prepare({ root, appDir: app }), /escapes the application directory/);
  assert.deepEqual(fs.readFileSync(path.join(app, 'package.json')), original);
});

test('QQ ASAR archive through a directory junction cannot escape the app', t => {
  const { root, app } = fixture(t);
  const outside = path.join(root, 'work', 'archives');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'application.asar'), 'external archive');
  try { fs.symlinkSync(outside, path.join(app, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Directory links unavailable'); return; } throw error; }
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ main: 'linked/application.asar/main.js' }));
  assert.throws(() => prepare({ root, appDir: app }), /ASAR archive escapes the application directory/);
  assert.equal(fs.existsSync(path.join(app, '.freshwater-package.original')), false);
});

test('QQ ASAR file symlink is rejected even if its target is inside the app', t => {
  const { root, app } = fixture(t);
  const target = path.join(app, 'actual.asar');
  fs.writeFileSync(target, 'real archive');
  try { fs.symlinkSync(target, path.join(app, 'linked.asar'), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('File links unavailable'); return; } throw error; }
  for (const main of ['linked.asar/main.js', 'linked.asar']) {
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ main }));
    assert.throws(() => prepare({ root, appDir: app }), /must not be a symbolic link/);
    assert.equal(fs.existsSync(path.join(app, '.freshwater-package.original')), false);
  }
});

test('QQ entry never overwrites a pre-existing unowned proxy', t => {
  const { root, app, original } = fixture(t);
  const proxy = path.join(app, 'freshwater-entry.cjs');
  fs.writeFileSync(proxy, 'owned by another tool');
  assert.throws(() => prepare({ root, appDir: app }), /without an ownership manifest/);
  assert.equal(fs.readFileSync(proxy, 'utf8'), 'owned by another tool');
  assert.deepEqual(fs.readFileSync(path.join(app, 'package.json')), original);
});

test('QQ main outside its app directory is rejected before writing', t => {
  const { root, app } = fixture(t);
  const external = path.join(root, 'work', 'main.cjs');
  fs.writeFileSync(external, '// unrelated\n');
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ main: path.relative(app, external) }));
  assert.throws(() => prepare({ root, appDir: app }), /escapes the application directory/);
  assert.equal(fs.existsSync(path.join(app, '.freshwater-package.original')), false);
});

test('QQ directory junction cannot escape the workspace', t => {
  const parent = fs.mkdtempSync(path.join(temporary, 'junction-'));
  t.after(() => {
    assert.ok(path.resolve(parent).startsWith(temporary + path.sep));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const root = path.join(parent, 'project');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, path.join(root, 'work', 'qq-root'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Directory links unavailable'); return; } throw error; }
  assert.throws(() => prepare({ root, appDir: outside }), /must not resolve outside this project/);
});

test('QQ download rejects unofficial URLs and missing expected digests before network', async () => {
  for (const value of ['http://qqdl.gtimg.cn/test.deb', 'https://example.com/test.deb', 'https://qqdl.gtimg.cn.evil.test/test.deb', 'https://user:pass@qqdl.gtimg.cn/test.deb']) {
    assert.throws(() => official(value), /must use HTTPS/);
  }
  assert.equal(official('https://dldir1.qq.com/qq/test.deb').hostname, 'dldir1.qq.com');
  await assert.rejects(download({ url: 'https://dldir1.qq.com/test.deb' }), /expected SHA256 is required/);
});

test('source packaging selects source trees but excludes runtime config and account data', t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'work', 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'private-dependency'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work', 'data', 'session.json'), 'private');
  fs.writeFileSync(path.join(root, 'config.json'), 'secret token');
  fs.writeFileSync(path.join(root, 'config.example.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'private-dependency', 'index.js'), '// dependency');
  const files = sourceFiles(root);
  assert.ok(files.includes('src/qq/entry.cjs'));
  assert.ok(files.includes('config.example.json'));
  assert.equal(files.some(name => name.startsWith('work/') || name.startsWith('node_modules/')), false);
  assert.equal(files.includes('config.json'), false);
});

test('source packaging rejects credential-like files inside otherwise allowed source trees', t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'server.key'), 'private');
  assert.throws(() => sourceFiles(root), /private or binary material/);
});
