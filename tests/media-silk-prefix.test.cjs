'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const media = require('../src/qq/media.cjs');

const header = Buffer.from('#!SILK_V3');
const frames = Buffer.from([3, 0, 1, 2, 3, 2, 0, 4, 5]);
const info = { extension: 'silk', mime: 'audio/silk' };
const container = (prefix, payload = frames, newline = false) => Buffer.concat([
    prefix === undefined ? Buffer.alloc(0) : Buffer.from([prefix]), header,
    newline ? Buffer.from([10]) : Buffer.alloc(0), payload
]);

test('received SILK accepts exact 02 and 03 prefixes with the same complete packet rules', () => {
    for (const prefix of [undefined, 2, 3]) {
        for (const newline of [false, true]) {
            for (const terminal of [false, true]) {
                const payload = terminal ? Buffer.concat([frames, Buffer.from([255, 255])]) : frames;
                const bytes = container(prefix, payload, newline), before = Buffer.from(bytes);
                assert.deepEqual(media.recordInfo(bytes), info);
                assert.deepEqual(media.mediaInfo('record', bytes), info);
                assert.deepEqual(bytes, before);
            }
        }
    }
    // A first length byte of 0x0a remains a packet size, not a forced newline.
    assert.deepEqual(media.recordInfo(container(3, Buffer.concat([Buffer.from([10, 0]), Buffer.alloc(10, 7)]))), info);
});

test('SILK 03 prefix still rejects every incomplete or invalid packet stream', () => {
    for (const payload of [Buffer.alloc(0), Buffer.from([255, 255]), Buffer.from([3]),
        Buffer.from([0, 0]), Buffer.from([254, 255]), Buffer.from([3, 0, 1, 2]),
        Buffer.concat([frames, Buffer.from([0])]), Buffer.concat([frames, Buffer.from([0, 0])]),
        Buffer.concat([frames, Buffer.from([255, 255, 1])])]) {
        for (const newline of [false, true]) assert.throws(() => media.recordInfo(container(3, payload, newline)), { code: 'UNSUPPORTED' });
    }
    const wrongHeader = container(3); wrongHeader[9] = '2'.charCodeAt(0);
    assert.throws(() => media.recordInfo(wrongHeader), { code: 'UNSUPPORTED' });
    assert.throws(() => media.recordInfo(container(3).subarray(0, 9)), { code: 'UNSUPPORTED' });
});

test('SILK never skips an unrecognized or repeated prefix byte', () => {
    for (let prefix = 0; prefix <= 255; prefix++) {
        if (prefix === 2 || prefix === 3) continue;
        assert.throws(() => media.recordInfo(container(prefix)), { code: 'UNSUPPORTED' });
    }
    for (const prefix of [[2, 3], [3, 2], [3, 3]]) {
        assert.throws(() => media.recordInfo(Buffer.concat([Buffer.from(prefix), header, frames])), { code: 'UNSUPPORTED' });
    }
});

test('received 03 SILK resources retain their original bytes and digest', t => {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'silk-prefix-'));
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bytes = container(3), digest = crypto.createHash('md5').update(bytes).digest('hex');
    const exported = media.exportMedia(directory, 'record', bytes);
    assert.equal(exported.md5, digest); assert.equal(exported.size, bytes.length);
    assert.deepEqual(fs.readFileSync(path.join(directory, exported.file)), bytes);
    assert.deepEqual(media.resourceInfo(directory, exported.file), exported);
});
