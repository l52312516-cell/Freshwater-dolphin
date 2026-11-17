'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { prepareConfig, applyConfig } = require('../tools/windows/config.cjs');
const { WindowsRuntime } = require('../tools/windows/runtime.cjs');
const temporary = path.resolve(__dirname, '../work/temp');
function fixture(t) {
    fs.mkdirSync(temporary, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporary, 'windows-hardening-'));
    t.after(() => { assert.ok(root.startsWith(temporary + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
    const file = path.join(root, '.wslconfig'), victim = path.join(root, 'unapproved-config');
    const original = Buffer.from('[wsl2]\nlocalhostForwarding=true\n');
    fs.writeFileSync(file, original); fs.writeFileSync(victim, original);
    const plan = prepareConfig(file, { swapFile: 'E:\\Freshwater\\work\\windows\\swap.vhdx', memoryMiB: 6144, processors: 4, swapMiB: 2048 });
    return { root, file, victim, original, plan, backups: path.join(root, 'work/backups') };
}
test('configuration preview cannot authorize a later symbolic link to another file with identical content', t => {
    const f = fixture(t); fs.unlinkSync(f.file);
    try { fs.symlinkSync(f.victim, f.file, 'file'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('File symbolic links unavailable'); return; } throw error; }
    assert.throws(() => applyConfig(f.plan, f.backups), /link|ordinary|changed|identity/i);
    assert.deepEqual(fs.readFileSync(f.victim), f.original);
});
test('configuration preview cannot authorize a later hard link to another file with identical content', t => {
    const f = fixture(t); fs.unlinkSync(f.file); fs.linkSync(f.victim, f.file);
    assert.throws(() => applyConfig(f.plan, f.backups), /link|ordinary|changed|identity/i);
    assert.deepEqual(fs.readFileSync(f.victim), f.original);
});
test('the release root itself cannot redirect runtime data through a junction or symbolic directory', t => {
    const f = fixture(t), actual = path.join(f.root, 'actual-release'), alias = path.join(f.root, 'aliased-release');
    fs.mkdirSync(actual);
    try { fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Directory links unavailable'); return; } throw error; }
    assert.throws(() => new WindowsRuntime(alias, { manifest: { runtime: {} }, configFile: path.join(f.root, '.wslconfig') }), /link|junction|canonical|reparse/i);
});
