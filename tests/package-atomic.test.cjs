'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pack } = require('../tools/package.cjs');
function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'package-atomic-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    fs.writeFileSync(path.join(root, 'README.md'), 'source\n');
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
const tar = bytes => (_name, args) => { fs.writeFileSync(args[1], bytes); return { status: 0 }; };
test('failed tar output cannot overwrite an existing source archive or its checksum', t => {
    const root = fixture(t), first = pack(root, { run: tar('complete-old') });
    const hash = fs.readFileSync(first.archive + '.sha256');
    assert.throws(() => pack(root, { run: (_name, args) => { fs.writeFileSync(args[1], 'partial'); return { status: 1, stderr: 'test interruption' }; } }), /Source archive failed/);
    assert.equal(fs.readFileSync(first.archive, 'utf8'), 'complete-old'); assert.deepEqual(fs.readFileSync(first.archive + '.sha256'), hash);
    assert.equal(fs.existsSync(first.archive + '.lock'), false);
    assert.deepEqual(fs.readdirSync(path.join(root, 'work/temp')), []);
});
test('a checksum publication failure rolls back the newly published archive', t => {
    const root = fixture(t), first = pack(root, { run: tar('old') }); let calls = 0;
    const previousHash = fs.readFileSync(first.archive + '.sha256', 'utf8');
    assert.throws(() => pack(root, { run: tar('new'), rename: (from, to) => {
        if (++calls === 2) throw Object.assign(new Error('test checksum rename failure'), { code: 'EIO' }); fs.renameSync(from, to);
    } }), { code: 'EIO' });
    assert.equal(fs.readFileSync(first.archive, 'utf8'), 'old'); assert.equal(fs.readFileSync(first.archive + '.sha256', 'utf8'), previousHash);
    const next = pack(root, { run: tar('new') });
    assert.equal(next.sha256, crypto.createHash('sha256').update('new').digest('hex'));
    assert.equal(fs.readFileSync(next.archive + '.sha256', 'utf8').startsWith(next.sha256 + '  '), true);
});
