'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createFlashRecovery, MAX_RECORDS, MAX_BYTES } = require('../src/qq/flash-recovery.cjs');
const ID = '11111111-2222-3333-4444-555555555555';
const temp = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temp, { recursive: true });
function fixture(t) {
    const root = fs.mkdtempSync(path.join(temp, 'flash-recovery-test-'));
    if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filename = path.join(root, 'fwd-flash-recovery.json');
    const journal = () => createFlashRecovery(root, '12345', 'u_self');
    const document = rows => ({ version: 1, selfUin: '12345', selfUid: 'u_self', filesets: rows });
    const row = (filesetId = ID) => ({ filesetId, stage: 'allocated', createdAt: 1, updatedAt: 1 });
    return { root, filename, journal, document, row,
        write(value) { fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 }); } };
}

test('recovery persists only allocated identities and fixed stages across independent instances', t => {
    const f = fixture(t), journal = f.journal();
    const release = journal.prepare();
    assert.equal(fs.statSync(f.filename).nlink, 1);
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.filename).mode & 0o777, 0o600);
    assert.deepEqual(journal.list(), []); assert.equal(journal.has(ID), false);
    assert.throws(() => journal.stage(ID, 'confirmed'), { code: 'INVALID_CONFIG' });
    journal.allocated(ID); journal.stage(ID, 'committed'); journal.stage(ID, 'cleanup_pending'); release(); release();
    const observed = f.journal().list(); assert.equal(observed.length, 1);
    assert.equal(observed[0].stage, 'cleanup_pending'); assert.equal(observed[0].lastStage, 'committed');
    assert.throws(() => journal.allocated(ID), { code: 'INVALID_CONFIG' });
    assert.throws(() => journal.stage(ID, 'unknown'), { code: 'INVALID_CONFIG' });
    f.journal().deleted(ID); assert.deepEqual(journal.list(), []);
    assert.deepEqual(fs.readdirSync(f.root), ['fwd-flash-recovery.json']);
});

test('recovery refuses another account, invalid schemas, duplicate IDs and excessive storage', t => {
    const f = fixture(t); f.write(f.document([f.row()]));
    assert.throws(() => createFlashRecovery(f.root, '54321', 'u_self').has(ID), { code: 'INVALID_CONFIG' });
    assert.throws(() => createFlashRecovery(f.root, '12345', 'u_other').has(ID), { code: 'INVALID_CONFIG' });
    const invalid = [f.document([f.row(), f.row()]), f.document([{ ...f.row(), stage: 'unknown' }]),
        f.document([{ ...f.row(), stage: 'cleanup_pending' }]), f.document([{ ...f.row(), lastStage: 'allocated' }]),
        f.document([{ ...f.row(), filesetId: '../other' }]), f.document([{ ...f.row(), updatedAt: 0 }]),
        { ...f.document([]), secret: true }, f.document([{ ...f.row(), unexpected: true }]), f.document(Array(MAX_RECORDS + 1).fill(f.row()))];
    for (const value of invalid) { f.write(value); assert.throws(() => f.journal().list(), { code: 'INVALID_CONFIG' }); }
    fs.writeFileSync(f.filename, Buffer.alloc(MAX_BYTES + 1)); assert.throws(() => f.journal().list(), { code: 'INVALID_CONFIG' });
    fs.writeFileSync(f.filename, '{invalid'); assert.throws(() => f.journal().list(), { code: 'INVALID_CONFIG' });
});

test('recovery capacity reservations prevent concurrent create preflights from overbooking', t => {
    const f = fixture(t);
    const rows = Array.from({ length: MAX_RECORDS - 1 }, (_, index) => f.row('aaaaaaaa-bbbb-cccc-dddd-' + index.toString(16).padStart(12, '0')));
    f.write(f.document(rows));
    const first = f.journal().prepare();
    assert.throws(() => f.journal().prepare(), { code: 'BUSY' });
    first(); const second = f.journal().prepare(); f.journal().allocated(ID); second();
    assert.equal(f.journal().list().length, MAX_RECORDS);
    assert.throws(() => f.journal().prepare(), { code: 'BUSY' });
});

test('recovery refuses symbolic links and hard links without modifying their targets', t => {
    const f = fixture(t), target = path.join(f.root, 'owned-target.json');
    const bytes = JSON.stringify(f.document([f.row()])); fs.writeFileSync(target, bytes, { mode: 0o600 });
    fs.linkSync(target, f.filename);
    assert.throws(() => f.journal().has(ID), { code: 'INVALID_CONFIG' });
    assert.throws(() => f.journal().prepare(), { code: 'INVALID_CONFIG' });
    assert.equal(fs.readFileSync(target, 'utf8'), bytes); fs.unlinkSync(f.filename);
    try { fs.symlinkSync(target, f.filename); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Windows account cannot create symlinks; hard-link rejection verified'); return; } throw error; }
    assert.throws(() => f.journal().has(ID), { code: 'INVALID_CONFIG' });
    assert.throws(() => f.journal().prepare(), { code: 'INVALID_CONFIG' });
    assert.equal(fs.readFileSync(target, 'utf8'), bytes);
});

test('recovery refuses public POSIX journals and account directories', { skip: process.platform === 'win32' }, t => {
    const f = fixture(t); f.write(f.document([f.row()])); fs.chmodSync(f.filename, 0o644);
    assert.throws(() => f.journal().list(), { code: 'INVALID_CONFIG' });
    fs.chmodSync(f.filename, 0o600); fs.chmodSync(f.root, 0o755);
    assert.throws(() => f.journal().list(), { code: 'INVALID_CONFIG' }); fs.chmodSync(f.root, 0o700);
});
