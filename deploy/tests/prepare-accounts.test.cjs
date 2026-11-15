'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepare } = require('../../tools/prepare-qq.cjs');
const temporary = path.resolve(__dirname, '../../work/temp');

function fixture(t) {
  fs.mkdirSync(temporary, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporary, 'account-entry-'));
  t.after(() => { assert.ok(root.startsWith(temporary + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'src/qq'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/qq/entry.cjs'), 'exports.bootstrap = value => value;\n');
  const make = id => {
    const accountRoot = path.join(root, 'work/accounts', id);
    const appDir = path.join(accountRoot, 'qq-root/opt/QQ/resources/app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'main.cjs'), 'exports.owner = ' + JSON.stringify(id) + ';\n');
    const original = Buffer.from('{\r\n "main":"main.cjs","name":' + JSON.stringify(id) + '\r\n}\r\n');
    fs.writeFileSync(path.join(appDir, 'package.json'), original);
    return { accountRoot, appDir, original };
  };
  return { root, make };
}

test('independent QQ copies prepare and restore without changing the other account', t => {
  const { root, make } = fixture(t), a = make('a'), b = make('b');
  assert.equal(prepare({ root, ...a }).changed, true);
  assert.equal(prepare({ root, ...b }).changed, true);
  const bPrepared = fs.readFileSync(path.join(b.appDir, 'package.json'));
  assert.equal(prepare({ root, ...a }).changed, false);
  assert.equal(prepare({ root, ...a, restore: true }).changed, true);
  assert.deepEqual(fs.readFileSync(path.join(a.appDir, 'package.json')), a.original);
  assert.deepEqual(fs.readFileSync(path.join(b.appDir, 'package.json')), bPrepared);
  assert.equal(prepare({ root, ...b }).changed, false);
});

test('one account cannot prepare another account copy or a nested instance path', t => {
  const { root, make } = fixture(t), a = make('a'), b = make('b');
  assert.throws(() => prepare({ root, accountRoot: a.accountRoot, appDir: b.appDir }), /inside this workspace QQ directory/);
  assert.throws(() => prepare({ root, accountRoot: path.join(a.accountRoot, 'nested'), appDir: a.appDir }), /direct workspace/);
  assert.deepEqual(fs.readFileSync(path.join(b.appDir, 'package.json')), b.original);
});

test('an account junction to another account is rejected before preparing the QQ copy', t => {
  const { root, make } = fixture(t), a = make('actual');
  const link = path.join(root, 'work/accounts/linked');
  try { fs.symlinkSync(a.accountRoot, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Directory links unavailable'); return; } throw error; }
  assert.throws(() => prepare({ root, accountRoot: link, appDir: path.join(link, 'qq-root/opt/QQ/resources/app') }), /symbolic links/);
  assert.deepEqual(fs.readFileSync(path.join(a.appDir, 'package.json')), a.original);
});
