'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const codec = require('../src/onebot/codec.cjs');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const { validateMusicCard } = require('../src/qq/music.cjs');
const { GlobalServices } = require('../src/global-services.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const { capabilities } = require('../src/onebot/capabilities.cjs');
const { atomic } = require('../src/manager/files.cjs');

const card = { app: 'com.tencent.structmsg', view: 'music', ver: '0.0.0.1', prompt: '[音乐]Test',
    meta: { music: { title: 'Test song', desc: 'Singer', musicUrl: 'https://audio.example/song.mp3',
        jumpUrl: 'https://song.example/123', preview: 'https://song.example/cover.jpg', appid: 100497308, token: 'provider-signature' } } };
const cardText = JSON.stringify(card);
const luaCard = { ...card, app: 'com.tencent.music.lua', config: { ctime: 1000000, forward: 1, token: 'provider-lua-signature', type: 'normal' }, extra: {},
    meta: { music: { ...card.meta.music, app_type: 1, appid: 100495085, ctime: 1000000, uin: 123, tag: '网易云音乐' } } };
function fixture(t, fetchImpl = async () => new Response(cardText)) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'music-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    atomic(path.join(root, 'work/control/settings.json'), { musicSignUrl: 'https://sign.example/card' });
    const native = []; let listener, confirmation = 2, id = 900;
    const msg = {
        addKernelMsgListener(value) { listener = value; return 1; }, removeKernelMsgListener() {},
        generateMsgUniqueId() { return String(++id); },
        async sendMsg(_id, peer, elements) {
            native.push({ peer, elements });
            if (confirmation !== null) listener.onMsgInfoListUpdate([{ ...peer, elements,
                msgId: String(id), msgTime: String(Math.floor(Date.now() / 1000)), senderUin: '123', senderUid: 'u_123', sendStatus: confirmation }]);
            return { result: 0 };
        }
    };
    const session = { getMsgService: () => msg, getMSFService: () => ({ getServerTime: () => '1000' }) };
    const capture = new Capture({ install: false, processObject: { env: {} } }); t.after(() => capture.close());
    capture.resetSession(session, { selfUin: '123', selfUid: 'u_123', clientVer: TARGET_VERSION });
    capture.ready = true; capture.attach();
    const globals = new GlobalServices({ root, fetchImpl });
    const service = new OneBotService({ backend: { call: (method, params, context) => method === 'resolve'
        ? Promise.resolve({ uin: params.uin, uid: 'u_' + params.uin }) : capture.call(method, params, context) },
        globalServices: globals, store: new MessageStore({ directory: path.join(root, 'store') }),
        mediaActionTimeoutMs: 2000, actionTimeoutMs: 1000 });
    return { root, service, globals, capture, native, session, confirm: value => { confirmation = value; } };
}

test('music input parsing validates every segment before signer, kernel preparation or sending', async t => {
    let signs = 0;
    const f = fixture(t, async () => { signs++; return new Response(cardText); });
    const invalid = [
        { type: 'qq' }, { type: '163', id: 'not-a-numeric-id' }, { type: 'custom', title: 'Song', url: 'https://song.example/' },
        { type: 'custom', title: 'Song', url: 'https://song.example/', audio: 'file:///secret' },
        { type: 'qq', id: 9007199254740992 }, { type: 'qq', id: '123', card: cardText },
        { type: 'qq', id: '123', title: 'Ambiguous' }, { type: 'arbitrary', id: '123' }
    ];
    for (const data of invalid) {
        const result = await f.service.action({ action: 'send_group_msg', params: { group_id: 200, message: [
            { type: 'music', data: { type: 'qq', id: '123' } }, { type: 'music', data }
        ] } });
        assert.equal(result.status, 'failed');
    }
    assert.equal(signs, 0); assert.equal(f.native.length, 0); assert.equal(f.capture.preparedMusic.size, 0);
    assert.throws(() => codec.parse([{ type: 'json', data: { data: cardText } }]), { code: 'UNSUPPORTED' });
    assert.deepEqual(codec.parse('[CQ:music,type=163,id=123]'), [{ type: 'music', data: { type: '163', id: '123' } }]);
});

test('OneBot music sends go from configured signer through account-bound native Ark preparation and confirmed send', async t => {
    const requests = [];
    const f = fixture(t, async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(cardText); });
    const group = await f.service.action({ action: 'send_group_msg', params: { group_id: 200, message: [
        { type: 'text', data: { text: 'before\n' } }, { type: 'music', data: { type: 'qq', id: '004-song' } }
    ] }, echo: { test: 'music' } });
    assert.equal(group.retcode, 0); assert.ok(group.data.message_id); assert.deepEqual(group.echo, { test: 'music' });
    assert.deepEqual(requests[0], { type: 'qq', id: '004-song' });
    assert.deepEqual(f.native[0].elements.map(element => element.elementType), [1, 10]);
    assert.equal(f.native[0].elements[0].textElement.content, 'before\n');
    assert.deepEqual(f.native[0].elements[1], { elementType: 10, elementId: '', arkElement: { bytesData: cardText, linkInfo: null, subElementType: null } });
    assert.equal(f.capture.preparedMusic.size, 0);
    const privateResult = await f.service.action({ action: 'send_private_msg', params: { user_id: 456, message: [
        { type: 'music', data: { type: 'custom', title: 'Song', content: 'Singer', url: 'https://song.example/info', audio: 'https://audio.example/track', image: 'https://song.example/cover' } }
    ] } });
    assert.equal(privateResult.retcode, 0); assert.equal(f.native[1].peer.peerUid, 'u_456');
    assert.deepEqual(requests[1], { type: 'custom', title: 'Song', singer: 'Singer', url: 'https://song.example/info', audio: 'https://audio.example/track', image: 'https://song.example/cover' });
});

test('provider signatures survive JSON string responses and invalid/error responses never become local cards', async t => {
    let signs = 0, response = JSON.stringify(cardText);
    const f = fixture(t, async () => { signs++; return new Response(response); });
    const signed = await f.globals.signMusic({ type: '163', id: '123' });
    assert.equal(JSON.parse(signed.text).meta.music.token, 'provider-signature');
    response = '{"status":"failed","data":null}';
    const failed = await f.service.action({ action: 'send_group_msg', params: { group_id: 200, message: [{ type: 'music', data: { type: '163', id: '123' } }] } });
    assert.equal(failed.status, 'failed'); assert.equal(signs, 2); assert.equal(f.native.length, 0);
    for (const value of [null, '{}', JSON.stringify({ ...card, app: 'com.tencent.other' }),
        JSON.stringify({ ...card, meta: { music: { ...card.meta.music, musicUrl: 'file:///secret' } } }),
        JSON.stringify({ ...card, meta: { ...card.meta, news: {} } })]) {
        assert.throws(() => validateMusicCard(value), { code: 'INVALID_PARAMS' });
    }
});

test('documented music Lua cards preserve their provider signature through the real Ark native path', async t => {
    const f = fixture(t, async () => new Response(JSON.stringify({ code: 200, msg: 'success', data: luaCard })));
    atomic(path.join(f.root, 'work/control/settings.json'), { musicSignUrl: 'https://apii.xianyuw.cn/api/v1/qq-musicark', musicSignKey: 'test-only-api-key' });
    const result = await f.service.action({ action: 'send_group_msg', params: { group_id: 200, message: [{ type: 'music', data: {
        type: 'custom', title: 'Song', content: 'Singer', url: 'https://music.163.com/#/song?id=123', audio: 'https://audio.example/song.mp3', image: 'https://song.example/cover'
    } }] } });
    assert.equal(result.retcode, 0);
    assert.deepEqual(JSON.parse(f.native[0].elements[0].arkElement.bytesData), luaCard);
    assert.equal(f.native[0].elements[0].musicToken, undefined);
    const unsigned = structuredClone(luaCard); delete unsigned.config.token;
    assert.throws(() => validateMusicCard(JSON.stringify(unsigned)), { code: 'INVALID_PARAMS' });
    const wrongApp = structuredClone(luaCard); wrongApp.app = 'com.tencent.arbitrary.lua';
    assert.throws(() => validateMusicCard(JSON.stringify(wrongApp)), { code: 'INVALID_PARAMS' });
});

test('failed keyed requests never disclose the API key or full signing URL in responses and action diagnostics', async t => {
    const f = fixture(t, async url => { throw new Error('network failed at ' + url); });
    const logs = []; f.service.logger = (event, data) => logs.push({ event, ...data });
    atomic(path.join(f.root, 'work/control/settings.json'), { musicSignUrl: 'https://selected.example/sign', musicSignKey: 'private-api-secret' });
    const response = await f.service.action({ action: 'send_group_msg', params: { group_id: 200, message: [{ type: 'music', data: {
        type: 'custom', title: 'Song', url: 'https://song.example/info', audio: 'https://audio.example/song.mp3'
    } }] } });
    assert.equal(response.status, 'failed'); assert.equal(f.native.length, 0);
    assert.equal(JSON.stringify({ response, logs }).includes('private-api-secret'), false);
    assert.equal(JSON.stringify({ response, logs }).includes('https://'), false);
});

test('native music send requires one-use credentials for the exact session, peer and full card bytes', async t => {
    const f = fixture(t), peer = { chatType: 2, peerUid: '200' };
    const prepare = () => f.capture.call('prepareMusic', { peer, card: cardText, expectedEpoch: f.capture.epoch });
    const send = (element, override = {}) => f.capture.call('sendMessage', { peer, expectedEpoch: f.capture.epoch, elements: [element], ...override });
    const prepared = await prepare();
    await assert.rejects(send({ ...prepared, musicToken: 'forged' }), { code: 'INVALID_PARAMS' });
    await assert.rejects(send(prepared, { peer: { chatType: 2, peerUid: '201' } }), { code: 'INVALID_PARAMS' });
    await assert.rejects(send({ ...prepared, arkElement: { ...prepared.arkElement, bytesData: cardText + ' ' } }), { code: 'INVALID_PARAMS' });
    await assert.rejects(send(prepared, { elements: [prepared, prepared] }), { code: 'INVALID_PARAMS' });
    assert.equal(f.native.length, 0);
    await send(prepared); assert.equal(f.native.length, 1);
    await assert.rejects(send(prepared), { code: 'INVALID_PARAMS' });
    const previous = await prepare();
    f.capture.resetSession(f.session, { selfUin: '123', selfUid: 'u_123', clientVer: TARGET_VERSION });
    f.capture.ready = true; f.capture.attach();
    await assert.rejects(send(previous), { code: 'INVALID_PARAMS' });
    assert.equal(f.native.length, 1);
});

test('native acceptance without a successful music delivery callback reports timeout without retry', async t => {
    let signs = 0;
    const f = fixture(t, async () => { signs++; return new Response(cardText); }); f.confirm(null); f.service.mediaActionTimeoutMs = 500;
    const result = await f.service.action({ action: 'send_group_msg', params: { group_id: 200, message: [{ type: 'music', data: { type: 'qq', id: '123' } }] } });
    assert.equal(result.retcode, 1504); assert.equal(f.native.length, 1); assert.equal(signs, 1);
    assert.equal(f.capture.bus.listenerCount('sent'), 0);
});

test('music capability describes implemented outbound support while receiving arbitrary cards remains unavailable', async t => {
    const f = fixture(t);
    const entry = capabilities(f.capture.state()).segments.find(item => item.name === 'music');
    assert.equal(entry.implemented, true); assert.equal(entry.send, true); assert.equal(entry.receive, false);
    assert.equal(entry.verification, 'offline-tested');
    atomic(path.join(f.root, 'work/control/settings.json'), { musicSignUrl: '' });
    const result = await f.service.capabilities();
    assert.equal(result.segments.find(item => item.name === 'music').send, false);
    assert.equal((await f.service.action({ action: 'send_group_msg', params: { group_id: 200, message: [{ type: 'music', data: { type: 'qq', id: '123' } }] } })).retcode, 1404);
    assert.equal(f.native.length, 0);
});
