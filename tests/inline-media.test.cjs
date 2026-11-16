'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const codec = require('../src/onebot/codec.cjs');
const { decodeInlineMedia, stageInlineMedia, MAX_INLINE_BYTES } = require('../src/onebot/media-input.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const encode = bytes => 'base64://' + bytes.toString('base64');

function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'inline-media-')), mediaDirectory = path.join(root, 'media'); fs.mkdirSync(mediaDirectory, { mode: 0o700 });
    const store = new MessageStore({ directory: path.join(root, 'store') });
    const state = { ready: true, epoch: 'inline-epoch', self: { uin: '11111', uid: 'u_self' }, capabilities: { record: true, video: true, file: true } };
    const calls = [], staged = [], overrides = {};
    const backend = { async call(method, params) {
        if (method === 'status') return state; calls.push({ method, params });
        if (method === 'prepareMedia') {
            assert.ok(params.file.startsWith(mediaDirectory + path.sep)); assert.equal(params.file.startsWith('base64://'), false);
            staged.push({ path: params.file, bytes: fs.readFileSync(params.file) });
            if (overrides.prepare) return overrides.prepare(params);
            const payload = { type: params.type, filePath: params.file };
            return params.type === 'record' ? { elementType: 4, pttElement: payload } : { elementType: 3, fileElement: payload };
        }
        if (method === 'sendMessage') return { ...params.peer, msgId: '18446744073709551001', msgSeq: '1', clientSeq: '2', msgTime: '1800000000',
            senderUid: 'u_self', senderUin: '11111', sendStatus: 2, elements: params.elements };
        throw new Error('Unexpected call ' + method);
    } };
    const service = new OneBotService({ backend, store, mediaDirectory });
    t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, mediaDirectory, service, calls, staged, overrides };
}

test('inline record/file parsing validates canonical bytes and retains the original complete message', () => {
    const voice = encode(Buffer.from('ID3synthetic-mp3-input')), file = encode(Buffer.from('ordinary file bytes'));
    assert.deepEqual(codec.parse([{ type: 'record', data: { file: voice } }]), [{ type: 'record', data: { file: voice } }]);
    assert.deepEqual(codec.parse([{ type: 'file', data: { file, name: '资料.txt' } }]), [{ type: 'file', data: { file, name: '资料.txt' } }]);
    for (const value of ['base64://', 'base64://***', 'base64://QQ=', 'base64://QR==', encode(Buffer.from('not audio'))]) {
        assert.throws(() => codec.parse([{ type: 'record', data: { file: value } }]));
    }
    assert.throws(() => codec.parse([{ type: 'video', data: { file: encode(Buffer.from('not MP4')) } }]));
    assert.throws(() => decodeInlineMedia('base64://' + 'A'.repeat(4 * Math.ceil(MAX_INLINE_BYTES / 3) + 4), 'file'), { code: 'INVALID_REQUEST' });
});

test('inline voice/file formal sends stage account-local bytes once and remove every temporary file', async t => {
    for (const type of ['record', 'file']) {
        const f = fixture(t), bytes = Buffer.from(type === 'record' ? 'ID3synthetic-mp3-input' : 'file contents\n第二行');
        const input = { action: 'send_group_msg', params: { group_id: 12345, message: [{ type, data: { file: encode(bytes), ...(type === 'file' ? { name: '资料.txt' } : {}) } }] } };
        const before = JSON.stringify(input), result = await f.service.action(input);
        assert.equal(result.retcode, 0, JSON.stringify(result)); assert.equal(JSON.stringify(input), before);
        assert.deepEqual(f.staged[0].bytes, bytes); assert.equal(f.staged.length, 1); assert.equal(fs.existsSync(f.staged[0].path), false);
        assert.deepEqual(f.calls.map(call => call.method), ['prepareMedia', 'sendMessage']); assert.deepEqual(fs.readdirSync(f.mediaDirectory), []);
    }
});

test('invalid trailing media prevents staging and native calls, and failed preparation cleans imports', async t => {
    const f = fixture(t), voice = encode(Buffer.from('ID3synthetic-mp3-input'));
    const result = await f.service.action({ action: 'send_group_msg', params: { group_id: 12345,
        message: [{ type: 'record', data: { file: voice } }, { type: 'unknown', data: {} }] } });
    assert.equal(result.retcode, 1404); assert.equal(f.calls.length, 0); assert.deepEqual(fs.readdirSync(f.mediaDirectory), []);
    f.overrides.prepare = () => { throw Object.assign(new Error('fixture failure'), { code: 'TIMEOUT' }); };
    const failed = await f.service.action({ action: 'send_group_msg', params: { group_id: 12345, message: [{ type: 'record', data: { file: voice } }] } });
    assert.equal(failed.retcode, 1504); assert.equal(f.calls.some(call => call.method === 'sendMessage'), false);
    assert.equal(fs.existsSync(f.staged[0].path), false); assert.deepEqual(fs.readdirSync(f.mediaDirectory), []);
});

test('inline account staging enforces its transient file bound and rejects unrelated schemes', t => {
    const f = fixture(t), input = encode(Buffer.from('file'));
    for (let index = 0; index < 32; index++) stageInlineMedia(f.mediaDirectory, 'file', input);
    assert.throws(() => stageInlineMedia(f.mediaDirectory, 'file', input), { code: 'BUSY' });
    assert.throws(() => decodeInlineMedia('https://example.invalid/file', 'file'), { code: 'INVALID_REQUEST' });
});
