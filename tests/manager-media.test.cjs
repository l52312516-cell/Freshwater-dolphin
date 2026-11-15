'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createManager } = require('../src/manager/server.cjs');
const media = require('../src/qq/media.cjs');

test('media URLs are time-limited, signed and bound to an account and opaque resource', async t => {
    const root = fs.mkdtempSync(path.resolve(__dirname, '../work/temp/media-manager-'));
    const manager = await createManager({ root, startAccounts: false });
    t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
    manager.accounts.create({ id: 'one' }); manager.accounts.create({ id: 'two' });
    manager.accounts.writeConfig('one'); manager.accounts.writeConfig('two');
    const opaque = 'fwd-image-' + 'a'.repeat(32), key = fs.readFileSync(path.join(root, 'work/accounts/one/state/media-key.txt'), 'utf8').trim();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5p8AAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(path.join(root, 'work/accounts/one/media', opaque), png);
    function signed(account, expires) {
        const signature = crypto.createHmac('sha256', Buffer.from(key, 'hex')).update('one\n' + opaque + '\n' + expires).digest('hex');
        return '/media/' + account + '/' + opaque + '?expires=' + expires + '&signature=' + signature;
    }
    const expires = Math.floor(Date.now() / 1000) + 300;
    const valid = await manager.app.inject(signed('one', expires)); assert.equal(valid.statusCode, 200); assert.equal(valid.headers['content-type'], 'image/png');
    const kernelUrl = require('../src/qq/media.cjs').signedImageUrl({ mediaBaseUrl: 'http://localhost/media/one',
        mediaSigningKeyFile: path.join(root, 'work/accounts/one/state/media-key.txt'), profileId: 'one' }, opaque);
    assert.equal((await manager.app.inject(new URL(kernelUrl).pathname + new URL(kernelUrl).search)).statusCode, 200);
    assert.equal((await manager.app.inject(signed('two', expires))).statusCode, 403);
    assert.equal((await manager.app.inject(signed('one', expires - 600))).statusCode, 403);
    assert.equal((await manager.app.inject(signed('one', expires + 60))).statusCode, 403);
    assert.equal((await manager.app.inject('/media/one/' + opaque)).statusCode, 403);
    assert.equal((await manager.app.inject('/media/one/not-a-resource?expires=' + expires)).statusCode, 404);
});

test('typed media HTTP returns exact video and voice bytes with type, length and isolated signatures', async t => {
    const root = fs.mkdtempSync(path.resolve(__dirname, '../work/temp/typed-media-manager-'));
    const manager = await createManager({ root, startAccounts: false });
    t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
    for (const id of ['one', 'two']) { manager.accounts.create({ id }); manager.accounts.writeConfig(id); }
    const directory = path.join(root, 'work/accounts/one/media'), keyFile = path.join(root, 'work/accounts/one/state/media-key.txt');
    const box = (kind, payload) => { const size = Buffer.alloc(4); size.writeUInt32BE(payload.length + 8); return Buffer.concat([size, Buffer.from(kind), payload]); };
    const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0mp42')), box('moov', Buffer.from([0])), box('mdat', Buffer.from([1, 2, 3]))]);
    const silk = Buffer.concat([Buffer.from('\x02#!SILK_V3'), Buffer.from([3, 0, 1, 2, 3])]);
    const signed = (file, profileId = 'one', expires = Math.floor(Date.now() / 1000) + 300) => {
        const secret = fs.readFileSync(keyFile, 'utf8').trim();
        const signature = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(profileId + '\n' + file + '\n' + expires).digest('hex');
        return '/media/' + profileId + '/' + file + '?expires=' + expires + '&signature=' + signature;
    };
    for (const [type, bytes, mime] of [['video', mp4, 'video/mp4'], ['record', silk, 'audio/silk']]) {
        const resource = media.exportMedia(directory, type, bytes);
        const response = await manager.app.inject(signed(resource.file));
        assert.equal(response.statusCode, 200); assert.equal(response.headers['content-type'], mime);
        assert.equal(Number(response.headers['content-length']), bytes.length); assert.deepEqual(response.rawPayload, bytes);
        const kernel = new URL(media.signedMediaUrl({ mediaBaseUrl: 'http://localhost/media/one', mediaSigningKeyFile: keyFile, profileId: 'one' }, resource.file));
        assert.equal((await manager.app.inject(kernel.pathname + kernel.search)).statusCode, 200);
        assert.equal((await manager.app.inject(signed(resource.file, 'two'))).statusCode, 403);
        assert.equal((await manager.app.inject(signed(resource.file, 'one', Math.floor(Date.now() / 1000) - 1))).statusCode, 403);
        assert.equal((await manager.app.inject(signed(resource.file, 'one', Math.floor(Date.now() / 1000) + 600))).statusCode, 403);
        assert.equal((await manager.app.inject(signed(resource.file).replace(/signature=./, 'signature=z'))).statusCode, 403);
        const spoofed = resource.file.replace(type, 'image'); fs.copyFileSync(resource.path, path.join(directory, spoofed));
        assert.equal((await manager.app.inject(signed(spoofed))).statusCode, 404);
    }
    assert.equal((await manager.app.inject(signed('fwd-video-' + 'f'.repeat(32)))).statusCode, 404);
});
