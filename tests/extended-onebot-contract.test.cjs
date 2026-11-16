'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtended } = require('../src/qq/extended.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');

test('OneBot routes through the actual QQ extended adapter without face/catalog identity type drift', async () => {
    const wire = [], capture = { epoch: 'contract-epoch', self: { uin: '11111', uid: 'u_self' }, session: {},
        ensureReady() {}, hasMethods: () => true, deadline: operation => operation(),
        resolve: async params => ({ uid: params.uid || 'u_' + params.uin, uin: params.uin || params.uid.slice(2) }) };
    const extended = createExtended(capture, { fetchImpl: async () => { assert.fail('catalogs and poke do not need HTTP'); },
        native: { available: () => true, async run(_capture, request) {
            wire.push(request);
            if (request.operation === 'face.get') return { face: { qSid: String(request.request.faceId), qDes: 'fixture-face' } };
            if (request.operation === 'face.list') return { packs: [{ source: 'common', packName: 'default', emojis: [{ qSid: '1' }] }] };
            if (request.operation === 'voice.characters') return { categories: [{ category: '普通', voices: [{ voiceId: 'voice-1', voiceDisplayName: '角色', voiceExampleUrl: 'https://example.invalid/preview' }] }] };
            if (request.operation === 'image.ocr') return { texts: [{ text: '第一行\n第二行', confidence: 100 }], language: 'zh' };
            return { ...request.request, confirmed: true, confirmation: 'server_ack' };
        } } });
    const service = new OneBotService({ store: {}, backend: { async call(method, params, options) {
        if (method === 'status') return { ready: true, epoch: capture.epoch, self: capture.self, capabilities: extended.capabilities() };
        if (method === 'resolve') return capture.resolve(params);
        const context = { expiresAt: Date.now() + options.timeoutMs };
        if (method === 'extendedQuery') return extended.query(params, context);
        if (method === 'extendedAction') return extended.action(params, context);
        throw new Error('Unexpected method ' + method);
    } } });
    const invoke = (action, params) => service.action({ action, params });
    const face = await invoke('get_system_face', { face_id: 1 }); assert.equal(face.retcode, 0, JSON.stringify(face)); assert.equal(face.data.qSid, '1');
    assert.equal(wire[0].request.faceId, '1'); assert.equal(wire[0].expectedUin, '11111');
    assert.deepEqual((await invoke('get_system_face_list', {})).data, [{ qSid: '1', source: 'common', packName: 'default' }]);
    assert.deepEqual((await invoke('get_ai_characters', { group_id: 12345 })).data, [{ category: '普通', type: '普通',
        voices: [{ voiceId: 'voice-1', voiceDisplayName: '角色', voiceExampleUrl: 'https://example.invalid/preview' }],
        characters: [{ voiceId: 'voice-1', voiceDisplayName: '角色', voiceExampleUrl: 'https://example.invalid/preview',
            character_id: 'voice-1', character_name: '角色', preview_url: 'https://example.invalid/preview' }] }]);
    assert.equal((await invoke('ocr_image', { image: 'https://gchat.qpic.cn/actual/0' })).data.texts[0].text, '第一行\n第二行');
    const poke = await invoke('send_poke', { group_id: 12345, user_id: 22222 }); assert.equal(poke.retcode, 0, JSON.stringify(poke));
    assert.deepEqual(wire.at(-1).request, { chatType: 2, peerUin: '12345', targetUin: '22222' });
});
