'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GlobalServices } = require('../src/global-services.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const media = require('../src/qq/media.cjs');
const { atomic } = require('../src/manager/files.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function fixture(t, options = {}) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'global-services-integration-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const mediaDirectory = path.join(root, 'media'); fs.mkdirSync(mediaDirectory, { mode: 0o700 });
    const key = path.join(root, 'media-key'); fs.writeFileSync(key, '07'.repeat(32), { mode: 0o600 });
    atomic(path.join(root, 'work/control/settings.json'), { rkey: { fallbackServers: ['https://rkey.example/api?token=endpoint-secret'] } });
    let state = { ready: true, epoch: 'first', self: { uin: '123', uid: 'u_123' }, capabilities: { imageReceive: true } };
    const calls = [], logs = [];
    const logger = (event, data) => logs.push({ event, ...data }); logger.message = details => logs.push(details);
    const client = new GlobalServices({ root, fetchImpl: async (url, init) => {
        calls.push('fallback');
        if (options.fetch) return options.fetch(url, init);
        return new Response(JSON.stringify({ group_rkey: 'group-rkey-secret', private_rkey: 'private-rkey-secret' }));
    } });
    client.resetSession(state.epoch, state.self.uin);
    const backend = { async call(method, params) {
        if (method === 'status') return state;
        if (method === 'receiveMedia') {
            calls.push('native');
            if (options.native) return options.native(params);
            throw Object.assign(new Error('No downloaded cache'), { code: 'NOT_FOUND' });
        }
        throw new Error('Unexpected method ' + method);
    } };
    const store = new MessageStore({ directory: path.join(root, 'store') });
    const service = new OneBotService({ backend, store, logger, mediaDirectory, mediaBaseUrl: 'https://panel.example/media/account',
        mediaSigningKeyFile: key, profileId: 'account', globalServices: client });
    return { root, mediaDirectory, service, store, calls, logs, client, switchSession() {
        state = { ...state, epoch: 'second' }; client.resetSession(state.epoch, state.self.uin);
    } };
}
function record(chatType = 2, msgId = '900', host = 'multimedia.nt.qq.com.cn') {
    return { chatType, peerUid: chatType === 2 ? '200' : 'u_456', senderUid: 'u_456', senderUin: '456', msgId,
        msgTime: String(Math.floor(Date.now() / 1000)), elements: [
            { elementType: 1, textElement: { content: 'before\n', atType: 0 } },
            { elementType: 2, elementId: 'image-element', picElement: { originImageUrl: 'https://' + host + '/download?fileid=original-file', fileName: 'photo.jpg' } },
            { elementType: 1, textElement: { content: ' after', atType: 0 } }
        ] };
}
function event(value) { return { kind: 'message', epoch: 'first', selfUin: '123', record: value }; }

test('image conversion prefers a confirmed native local resource before any configured rkey service', async t => {
    let resource;
    const f = fixture(t, { native: async () => resource });
    resource = media.exportImage(f.mediaDirectory, { bytes: png, ...media.imageInfo(png) });
    const output = await f.service.event(event(record()));
    assert.deepEqual(f.calls, ['native']);
    assert.match(output.message[1].data.url, /^https:\/\/panel\.example\/media\/account\/fwd-image-/);
    assert.equal(output.message[1].data.file, resource.file);
});

test('get_msg and message events share fallback conversion with correct group/private rkeys and segment order', async t => {
    for (const chatType of [1, 2]) {
        const f = fixture(t), value = record(chatType);
        const entry = f.store.remember('123', value);
        const response = await f.service.action({ action: 'get_msg', params: { message_id: entry.id }, echo: 'query' });
        assert.equal(response.retcode, 0); assert.equal(response.echo, 'query');
        assert.deepEqual(response.data.message.map(segment => segment.type), ['text', 'image', 'text']);
        assert.equal(response.data.message[0].data.text, 'before\n'); assert.equal(response.data.message[2].data.text, ' after');
        assert.equal(new URL(response.data.message[1].data.url).searchParams.get('rkey'), chatType === 2 ? 'group-rkey-secret' : 'private-rkey-secret');
        assert.deepEqual(f.calls, ['native', 'fallback']);
        const output = await f.service.event(event(record(chatType, '901')));
        assert.equal(new URL(output.message[1].data.url).searchParams.get('rkey'), chatType === 2 ? 'group-rkey-secret' : 'private-rkey-secret');
        assert.deepEqual(f.calls, ['native', 'fallback', 'native']);
        assert.equal(JSON.stringify(f.logs).includes('rkey-secret'), false);
        assert.equal(JSON.stringify(f.logs).includes('https://'), false);
    }
});

test('only recoverable native image errors use fallback and official multimedia hostnames match exactly', async t => {
    for (const code of ['NOT_FOUND', 'UNSUPPORTED']) {
        const f = fixture(t, { native: async () => { throw Object.assign(new Error('No native resource'), { code }); } });
        const output = await f.service.event(event(record(2, '900', 'multimedia.qfile.qq.com')));
        assert.ok(output); assert.deepEqual(f.calls, ['native', 'fallback']);
    }
    const failed = fixture(t, { native: async () => { throw Object.assign(new Error('native diagnostic with secret URL'), { code: 'KERNEL_ERROR' }); } });
    assert.equal(await failed.service.event(event(record())), null); assert.deepEqual(failed.calls, ['native']);
    assert.equal(failed.logs.length, 1);
    const { traceId, ...diagnostic } = failed.logs[0];
    assert.match(traceId, /^[a-f0-9]{32}$/);
    assert.deepEqual(diagnostic, { event: 'message_skipped', code: 'KERNEL_ERROR', reason: 'business_rejected',
        phase: 'element_convert', mediaType: 'image', elementType: 2, elementIndex: 1 });
    const wrongHost = fixture(t);
    const unavailable = await wrongHost.service.event(event(record(2, '901', 'multimedia.nt.qq.com.cn.evil.example')));
    assert.equal(unavailable._freshwater.content_status, 'partial');
    assert.equal(unavailable._freshwater.issues[0].reason, 'media_unavailable');
    assert.equal(JSON.stringify(unavailable).includes('evil.example'), false);
    assert.deepEqual(wrongHost.calls, ['native']);
});

test('session changes while fetching rkey discard results, reject get_msg and emit no event or sensitive diagnostics', async t => {
    for (const useAction of [true, false]) {
        let f;
        f = fixture(t, { fetch: async () => {
            f.switchSession();
            return new Response(JSON.stringify({ group_rkey: 'late-group-rkey-secret' }));
        } });
        const value = record();
        if (useAction) {
            const entry = f.store.remember('123', value);
            assert.equal((await f.service.action({ action: 'get_msg', params: { message_id: entry.id } })).retcode, 1503);
        } else assert.equal(await f.service.event(event(value)), null);
        assert.equal(f.client.keys.size, 0);
        const diagnostics = JSON.stringify(f.logs);
        assert.equal(diagnostics.includes('rkey-secret'), false); assert.equal(diagnostics.includes('https://'), false);
        assert.equal(f.logs.some(log => log.kind === 'message'), false);
    }
});
