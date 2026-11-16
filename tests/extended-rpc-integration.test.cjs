'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const { createExtended } = require('../src/qq/extended.cjs');
const fixed = require('../src/qq/fixed-oidb.cjs');
const p = require('../src/qq/proto.cjs');
const media = require('../src/qq/media.cjs');
const { startServer } = require('../src/ipc/server.cjs');
const { RpcClient } = require('../src/ipc/client.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'extended-rpc-'));
    const directory = path.join(root, 'media'); fs.mkdirSync(directory, { mode: 0o700 });
    const calls = [], source = { chatType: 2, peerUid: '2000000001', msgId: '18446744073709551000', msgSeq: '77', msgRandom: '0', emojiLikesList: [],
        senderUin: '54321', senderUid: 'u_54321', msgTime: '1794790000', elements: [{ elementType: 1, textElement: { content: 'test', atType: 0 } }] };
    let friend = true, categoryId = 0;
    const profile = {
        getUidByUin(_from, values) { return new Map(values.map(value => [value, 'u_' + value])); },
        getUinByUid(_from, values) { return new Map(values.map(value => [value, value.slice(2)])); },
        getCoreAndBaseInfo(_from, values) { return new Map(values.map(uid => [uid, { uid, uin: uid.slice(2), coreInfo: { uid, nick: 'Friend' }, baseInfo: { categoryId } }])); },
        async setHeader(file) { calls.push({ method: 'self.avatar', file }); return { result: 0 }; }
    };
    const capture = new Capture({ install: false, mediaDirectory: directory });
    capture.session = { getProfileService: () => profile, getMsgService: () => ({
        async getMsgsByMsgId() { return { result: 0, msgList: [{ ...source }] }; },
        async setStatus(data) { calls.push({ method: 'self.status', data }); return { result: 0 }; }
    }), getBuddyService: () => ({ isBuddy() { return friend; }, async delBuddy(data) { calls.push({ method: 'friend.delete', data }); friend = false; } }),
    getGroupService: () => ({ async setHeader(groupId, file) { calls.push({ method: 'group.avatar', groupId, file }); return { result: 0 }; } }),
    getTicketService: () => ({ async forceFetchClientKey() { return { result: 0, clientKey: 'PRIVATE', keyIndex: '1' }; } }) };
    capture.epoch = 'e1'; capture.qqVersion = TARGET_VERSION; capture.ready = true; capture.online = true;
    capture.self = { uin: '12345', uid: 'u_12345', nickname: 'Self' }; capture.remember('12345', 'u_12345');
    const native = { available: () => true, async run(_capture, params) {
        calls.push({ method: params.operation, data: params.request });
        const spec = fixed.prepare(params.operation, params.request);
        if (params.operation === 'friend.category') categoryId = params.request.categoryId;
        if (params.operation === 'message.emoji') source.emojiLikesList = params.request.set ? [{ emojiId: params.request.emojiId,
            emojiType: params.request.emojiId.length > 3 ? '2' : '1', likesCnt: '1', isClicked: true }] : [];
        let result = Buffer.alloc(0);
        if (params.operation === 'image.ocr') result = p.messageField(10, [p.messageField(1, [p.bytesField(1, Buffer.from('OCR文字')), p.varintField(2, 99)])]);
        if (params.operation === 'voice.characters') result = p.messageField(1, [p.bytesField(1, Buffer.from('声音')), p.messageField(2, [
            p.bytesField(1, Buffer.from('voice-1')), p.bytesField(2, Buffer.from('实际角色')), p.bytesField(3, Buffer.from('https://qq.example/actual-preview'))])]);
        const face = p.bytesField(1, Buffer.from('66'));
        if (params.operation === 'face.get') result = p.bytesField(1, face);
        if (params.operation === 'face.list') result = p.messageField(2, [p.messageField(1, [p.bytesField(2, face)])]);
        return fixed.decode(Buffer.concat([p.varintField(1, spec.command), p.varintField(2, spec.sub), p.varintField(3, 0), p.bytesField(4, result)]), spec);
    } };
    capture.extendedApi = createExtended(capture, { native, fetchImpl: async (input, options) => {
        const url = new URL(input);
        if (url.hostname === 'ssl.ptlogin2.qq.com') return new Response('', { status: 302, headers: [['location', 'https://qun.qq.com/'], ['set-cookie', 'uin=o12345; Domain=qq.com; Path=/'], ['set-cookie', 'skey=SECRET; Domain=qq.com; Path=/']] });
        if (url.pathname === '/') return new Response('landing');
        calls.push({ method: 'web', path: url.pathname, body: options.body });
        if (url.pathname.includes('digest_list')) return Response.json({ retcode: 0, data: { is_end: true, msg_list: [] } });
        if (url.pathname.includes('/qunapp/')) return Response.json({ retcode: 0, data: { talkative_list: [] } });
        if (url.pathname.includes('list_announce')) return Response.json({ ec: 0, feeds: [{ fid: 'notice-1', msg: { text: '公告' } }] });
        return Response.json({ ec: 0 });
    } });
    const server = await startServer({ dir: path.join(root, 'rpc'), backend: capture, pollMs: 1 });
    const backend = new RpcClient({ directory: path.join(root, 'rpc'), timeoutMs: 3000 });
    const store = new MessageStore({ directory: path.join(root, 'store') });
    const service = new OneBotService({ backend, store, mediaDirectory: directory });
    const messageId = store.remember('12345', source).id;
    const image = media.exportImage(directory, { bytes: png, ...media.imageInfo(png) });
    t.after(async () => { backend.close(); await server.close(); capture.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { service, calls, messageId, image };
}

test('new OneBot actions cross real file RPC and Capture with consistent request/result contracts', async t => {
    const f = await fixture(t);
    const requests = [
        ['group_poke', { group_id: 2000000001, user_id: 54321 }],
        ['set_msg_emoji_like', { message_id: f.messageId, emoji_id: 66, set: true }],
        ['set_essence_msg', { message_id: f.messageId }], ['delete_essence_msg', { message_id: f.messageId }],
        ['set_friend_category', { user_id: 54321, category_id: 3 }],
        ['set_group_special_title', { group_id: 2000000001, user_id: 54321, special_title: '永久测试', duration: -1 }],
        ['_get_group_notice', { group_id: 2000000001 }], ['_send_group_notice', { group_id: 2000000001, content: '测试' }],
        ['_del_group_notice', { group_id: 2000000001, notice_id: 'notice-1' }],
        ['get_essence_msg_list', { group_id: 2000000001 }], ['get_group_honor_info', { group_id: 2000000001, type: 'talkative' }],
        ['set_online_status', { status: 10 }], ['set_qq_avatar', { file: f.image.file }],
        ['set_group_portrait', { group_id: 2000000001, file: f.image.file }],
        ['ocr_image', { image: 'https://example.org/image.png' }], ['get_ai_characters', { group_id: 2000000001 }],
        ['get_system_face_list', {}], ['get_system_face', { face_id: 66 }], ['delete_friend', { user_id: 54321 }]
    ];
    for (const [action, params] of requests) {
        const result = await f.service.action({ action, params, echo: { action } });
        assert.equal(result.retcode, 0, action + ': ' + JSON.stringify(result));
        assert.deepEqual(result.echo, { action });
    }
    assert.equal(f.calls.filter(call => call.method === 'friend.delete').length, 1);
    assert.equal(f.calls.find(call => call.method === 'group.essence').data.random, '0');
});
