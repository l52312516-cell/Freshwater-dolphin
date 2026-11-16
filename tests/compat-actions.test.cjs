'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTIONS, EXTENSION_REQUIREMENTS, READ_ONLY_ACTIONS, runCompatActions, MAX_RESULT_BYTES } = require('../src/onebot/compat-actions.cjs');
const { createExtended } = require('../src/qq/extended.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');

const baseFace = overrides => ({ qSid: '14', qDes: 'Smile', emCode: '/smile', emojiNameAlias: ['微笑'], ...overrides });
const packs = () => [
    { source: 'common', packName: 'Classic', emojis: [baseFace(), baseFace({ qSid: '0', qDes: 'Zero', emojiNameAlias: [] })] },
    { source: 'special-big', packName: 'Animated', emojis: [baseFace({ qSid: '14', qDes: 'Overlapping', aniStickerType: 4, emojiNameAlias: ['duplicate-only'] }),
        baseFace({ qSid: '😀', qDes: 'Unicode', aniStickerType: 1, resourceUrl: { baseUrl: 'https://example.invalid/face', advUrl: 'https://example.invalid/adv' } })] },
    { source: 'magic', emojis: [] }
];
function fixture() {
    const state = { ready: true, epoch: 'compat-epoch', self: { uin: '11111', uid: 'u_self' },
        capabilities: Object.fromEntries(Object.values(EXTENSION_REQUIREMENTS).flat().map(flag => [flag, true])) };
    const calls = [], overrides = {}, records = new Map([[1, { locator: { peer: { chatType: 2, peerUid: '12345' } } }]]);
    const categories = [
        { categoryId: 0, categoryName: 'Default', categoryMbCount: 1, buddyList: [{ user_id: 22222, uid: 'u_friend' }] },
        { categoryId: 7, categoryName: 'Work', categoryMbCount: 0, buddyList: [] }
    ];
    let active = true;
    const service = {
        store: { get(account, id) { assert.equal(String(account), '11111'); return records.get(id); } },
        async assertSession(bound) { assert.equal(bound, state); if (!active) throw Object.assign(new Error('session changed'), { code: 'NOT_READY' }); },
        async sessionCall(bound, method, request) {
            await this.assertSession(bound); calls.push({ method, request });
            let result;
            if (overrides[method]) result = await overrides[method](request);
            else if (method === 'resolve') result = { uin: request.uin, uid: 'u_friend' };
            else if (method === 'socialQuery') result = categories;
            else if (method === 'groupFiles') result = { confirmed: true, groupId: request.groupId, folderId: request.folderId };
            else if (method === 'extendedAction') result = { ...request, confirmed: true };
            else if (method === 'extendedQuery') result = request.operation === 'face.list' ? { packs: packs() } : { faceId: request.faceId, face: null };
            else throw new Error('Unexpected method ' + method);
            await this.assertSession(bound); return result;
        },
        async record(bound, id, expected, options) {
            await this.assertSession(bound); assert.equal(records.has(id), true); assert.equal(expected, undefined); assert.deepEqual(options, { refresh: true });
            if (overrides.record) return overrides.record();
            return { chatType: 2, peerUid: '12345', msgId: '18446744073709551614', msgSeq: '100', clientSeq: '101', senderUin: '22222' };
        }
    };
    return { state, service, calls, overrides, records, categories, deactivate: () => { active = false; },
        invoke: (action, params = {}) => runCompatActions(service, state, action, params) };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('compatibility registry uses only the seven executable names and explicit multi-capability requirements', () => {
    assert.deepEqual([...ACTIONS], ['delete_group_file_folder', 'set_friends_category', 'set_group_reaction', 'fetch_sys_faces', 'fetch_face_entity', 'search_sys_faces', 'fetch_super_face_id']);
    assert.deepEqual([...READ_ONLY_ACTIONS], ['fetch_sys_faces', 'fetch_face_entity', 'search_sys_faces', 'fetch_super_face_id']);
    assert.deepEqual(EXTENSION_REQUIREMENTS.set_friends_category, ['friendCategorySet', 'friendCategories']);
    assert.equal(ACTIONS.has('get_qq_face_list'), false); assert.equal(ACTIONS.has('get_system_face_name'), false);
});

test('folder deletion alias reuses exact existing target validation and requires confirmation', async () => {
    const f = fixture();
    assert.equal(await f.invoke('delete_group_file_folder', { group_id: 12345, folder_id: '/opaque-folder' }), null);
    assert.deepEqual(f.calls, [{ method: 'groupFiles', request: { operation: 'group.folderDelete', groupId: '12345', folderId: '/opaque-folder' } }]);
    f.overrides.groupFiles = request => ({ confirmed: true, groupId: request.groupId, folderId: 'different' });
    await rejects(f.invoke('delete_group_file_folder', { group_id: 12345, folder_id: '/opaque-folder' }), 'INVALID_RESPONSE');
    assert.equal(f.calls.length, 2);
    for (const params of [{ group_id: 0, folder_id: 'folder' }, { group_id: 12345, folder_id: '' }, { group_id: 12345, folder_id: 'folder', extra: true }]) {
        await rejects(f.invoke('delete_group_file_folder', params), 'INVALID_PARAMS');
    }
    assert.equal(f.calls.length, 2);
});

test('category selectors verify live roster and exact existing ID or unique name before using the existing setter', async () => {
    for (const selector of [{ categoryId: 7 }, { categoryName: 'Work' }]) {
        const f = fixture();
        assert.equal(await f.invoke('set_friends_category', { uin: '22222', ...selector }), null);
        assert.deepEqual(f.calls, [
            { method: 'socialQuery', request: { operation: 'categories' } },
            { method: 'resolve', request: { uin: '22222' } },
            { method: 'extendedAction', request: { operation: 'friend.category', uid: 'u_friend', categoryId: 7 } }
        ]);
    }
    const f = fixture();
    assert.equal(await f.invoke('set_friends_category', { uin: 22222, categoryId: 0 }), null);
    assert.equal(f.calls.at(-1).request.categoryId, 0);
});

test('invalid or missing category selectors never query or mutate QQ', async () => {
    for (const params of [{ uin: 22222 }, { uin: 22222, categoryId: 0, categoryName: 'Default' }, { uin: 22222, categoryId: null },
        { uin: 22222, categoryName: '' }, { uin: 22222, categoryId: -1 }, { uin: 22222, categoryId: 4294967296 }, { uin: 0, categoryId: 7 }]) {
        const f = fixture(); await rejects(f.invoke('set_friends_category', params), 'INVALID_PARAMS'); assert.equal(f.calls.length, 0);
    }
});

test('category selection refuses missing, ambiguous, incomplete and conflicting live roster data without writes', async () => {
    const scenarios = [
        { params: { uin: 33333, categoryId: 7 }, code: 'NOT_FOUND' },
        { params: { uin: 22222, categoryId: 8 }, code: 'NOT_FOUND' },
        { params: { uin: 22222, categoryName: 'work' }, code: 'NOT_FOUND' },
        { change: f => f.categories.push({ categoryId: 8, categoryName: 'Work', categoryMbCount: 0, buddyList: [] }), code: 'INVALID_PARAMS' },
        { change: f => { f.categories[0].categoryMbCount = 2; }, code: 'INVALID_RESPONSE' },
        { change: f => { delete f.categories[0].buddyList[0].uid; }, code: 'INVALID_RESPONSE' },
        { change: f => { f.categories[1].categoryId = 0; }, code: 'INVALID_RESPONSE' },
        { change: f => { f.categories[1].categoryMbCount = 1; f.categories[1].buddyList = f.categories[0].buddyList; }, code: 'INVALID_RESPONSE' }
    ];
    for (const scenario of scenarios) {
        const f = fixture(); scenario.change?.(f);
        await rejects(f.invoke('set_friends_category', scenario.params || { uin: 22222, categoryName: 'Work' }), scenario.code);
        assert.deepEqual(f.calls.map(call => call.method), ['socialQuery']);
    }
});

test('category write requires resolver/roster agreement, same session and one exact confirmation', async () => {
    const f = fixture(); f.overrides.resolve = request => ({ uin: request.uin, uid: 'u_someone_else' });
    await rejects(f.invoke('set_friends_category', { uin: 22222, categoryId: 7 }), 'INVALID_RESPONSE');
    assert.equal(f.calls.some(call => call.method === 'extendedAction'), false);
    f.overrides.resolve = request => ({ uin: request.uin, uid: 'u_friend' });
    f.overrides.extendedAction = request => ({ ...request, categoryId: 8, confirmed: true });
    await rejects(f.invoke('set_friends_category', { uin: 22222, categoryId: 7 }), 'INVALID_RESPONSE');
    assert.equal(f.calls.filter(call => call.method === 'extendedAction').length, 1);
    const stale = fixture(); stale.overrides.socialQuery = () => { stale.deactivate(); return stale.categories; };
    await rejects(stale.invoke('set_friends_category', { uin: 22222, categoryName: 'Work' }), 'NOT_READY');
    assert.equal(stale.calls.some(call => call.method !== 'socialQuery'), false);
});

test('reaction alias preserves numeric code text and explicitly validates the stored group before refreshing', async () => {
    const f = fixture();
    assert.equal(await f.invoke('set_group_reaction', { message_id: 1, group_id: '12345', code: '128512', is_set: false }), null);
    assert.deepEqual(f.calls, [{ method: 'extendedAction', request: { operation: 'message.emoji', peer: { chatType: 2, peerUid: '12345' },
        groupId: '12345', nativeId: '18446744073709551614', sequence: '100', emojiId: '128512', set: false } }]);
    assert.equal(await f.invoke('set_group_reaction', { message_id: 1, code: '14' }), null);
    assert.equal(f.calls.at(-1).request.set, true);
    await rejects(f.invoke('set_group_reaction', { message_id: 1, group_id: 54321, code: '14' }), 'INVALID_PARAMS');
    assert.equal(f.calls.length, 2);
});

test('reaction alias rejects unknown/private messages, nonnumeric or oversized codes and invalid booleans before any native write', async () => {
    for (const params of [{ message_id: 2, code: '14' }, { message_id: 1, code: 14 }, { message_id: 1, code: '😀' }, { message_id: 1, code: '014' },
        { message_id: 1, code: '1114112' }, { message_id: 1, code: '14', is_set: null }, { message_id: '18446744073709551614', code: '14' }]) {
        const f = fixture(); await assert.rejects(f.invoke('set_group_reaction', params)); assert.equal(f.calls.length, 0);
    }
    const f = fixture(); f.records.get(1).locator.peer = { chatType: 1, peerUid: 'u_friend' };
    await rejects(f.invoke('set_group_reaction', { message_id: 1, code: '14' }), 'UNSUPPORTED'); assert.equal(f.calls.length, 0);
    const negative = fixture(); negative.records.set(-1, negative.records.get(1));
    assert.equal(await negative.invoke('set_group_reaction', { message_id: -1, code: '14' }), null);
    await rejects(negative.invoke('set_group_reaction', { message_id: -2, code: '14' }), 'NOT_FOUND');
});

test('face catalog preserves pack order, empty packs, Unicode IDs and real optional protobuf defaults', async () => {
    const f = fixture(), result = await f.invoke('fetch_sys_faces', { refresh: true });
    assert.deepEqual(result.packs.map(pack => pack.pack_name), ['Classic', 'Animated', 'MagicFace']);
    assert.deepEqual(result.packs[2].emojis, []);
    const first = result.packs[0].emojis[0];
    assert.deepEqual(first, { q_sid: '14', q_des: 'Smile', em_code: '/smile', q_cid: null, ani_sticker_type: null, ani_sticker_pack_id: null,
        ani_sticker_id: null, ani_sticker_width: null, ani_sticker_height: null, url: null, emoji_name_alias: ['微笑'], is_super: false });
    assert.equal(result.packs[1].emojis[1].q_sid, '😀'); assert.equal(result.packs[1].emojis[1].is_super, true);
    assert.equal(result.packs[1].emojis[1].url, 'https://example.invalid/face');
    assert.equal(JSON.stringify(result).includes('advUrl'), false);
    assert.deepEqual(f.calls, [{ method: 'extendedQuery', request: { operation: 'face.list' } }]);
});

test('face search matches names, IDs, code, aliases and groups case insensitively while preserving the first canonical entry', async () => {
    for (const query of ['14', ' SMILE ', '/SMILE', '微笑', 'classic', 'duplicate-only', 'ANIMATED']) {
        const f = fixture(), result = await f.invoke('search_sys_faces', { query });
        assert.ok(result.faces.some(face => face.q_sid === '14'), query);
        assert.equal(result.faces.find(face => face.q_sid === '14').q_des, 'Smile', query);
        assert.equal(new Set(result.faces.map(face => face.q_sid)).size, result.faces.length);
    }
    const f = fixture();
    assert.deepEqual(await f.invoke('search_sys_faces', { query: '   ' }), { faces: [] });
    assert.deepEqual(await f.invoke('search_sys_faces', { query: '\n\t' }), { faces: [] });
    assert.deepEqual(await f.invoke('search_sys_faces', { query: 'does-not-exist' }), { faces: [] });
    assert.equal((await f.invoke('search_sys_faces', { query: '😀' })).faces[0].q_sid, '😀');
});

test('face entity uses first catalog identity and refresh true performs a fresh catalog lookup without single fallback', async () => {
    const f = fixture();
    assert.equal((await f.invoke('fetch_face_entity', { face_id: 14 })).q_des, 'Smile');
    assert.equal((await f.invoke('fetch_face_entity', { face_id: 0, refresh: true })).q_sid, '0');
    assert.equal(await f.invoke('fetch_face_entity', { face_id: 999, refresh: true }), null);
    assert.deepEqual(await f.invoke('fetch_super_face_id', { face_id: 999, refresh: true }), { is_super: false });
    assert.equal(f.calls.every(call => call.request.operation === 'face.list'), true);
});

test('missing catalog faces use the exact single lookup and only explicit successful absence becomes null or false', async () => {
    const f = fixture();
    assert.equal(await f.invoke('fetch_face_entity', { face_id: '999' }), null);
    assert.deepEqual(f.calls.map(call => call.request), [{ operation: 'face.list' }, { operation: 'face.get', faceId: '999' }]);
    assert.deepEqual(await f.invoke('fetch_super_face_id', { face_id: 999 }), { is_super: false });
    f.overrides.extendedQuery = request => request.operation === 'face.list' ? { packs: packs() } : { faceId: request.faceId, face: baseFace({ qSid: request.faceId, aniStickerType: 2 }) };
    assert.equal((await f.invoke('fetch_face_entity', { face_id: 999 })).is_super, true);
    assert.deepEqual(await f.invoke('fetch_super_face_id', { face_id: 999 }), { is_super: true });
    for (const single of [{ faceId: '998', face: null }, { faceId: '999' }, { faceId: '999', face: baseFace({ qSid: '998' }) }]) {
        f.overrides.extendedQuery = request => request.operation === 'face.list' ? { packs: packs() } : single;
        await rejects(f.invoke('fetch_face_entity', { face_id: 999 }), 'INVALID_RESPONSE');
    }
    f.overrides.extendedQuery = request => { if (request.operation === 'face.list') return { packs: packs() }; throw Object.assign(new Error('QQ rejected'), { code: 'KERNEL_ERROR' }); };
    await rejects(f.invoke('fetch_super_face_id', { face_id: 999 }), 'KERNEL_ERROR');
});

test('super face classification follows positive aniStickerType instead of ID, pack or animation dimensions', async () => {
    const f = fixture();
    f.overrides.extendedQuery = () => ({ packs: [{ source: 'magic', emojis: [baseFace({ qSid: '999', aniStickerType: 0, aniStickerWidth: 100, aniStickerHeight: 100 })] }] });
    assert.deepEqual(await f.invoke('fetch_super_face_id', { face_id: 999 }), { is_super: false });
    f.overrides.extendedQuery = () => ({ packs: [{ source: 'common', emojis: [baseFace({ qSid: '1', aniStickerType: 1 })] }] });
    assert.deepEqual(await f.invoke('fetch_super_face_id', { face_id: 1 }), { is_super: true });
});

test('face responses reject incomplete panels and malformed known fields without reading arbitrary metadata', async () => {
    const bad = [{ faces: [] }, { packs: [{ source: 'unknown', emojis: [] }] }, { packs: [{ source: 'common' }] },
        { packs: [{ source: 'common', emojis: [{}] }] }, { packs: [{ source: 'common', emojis: [baseFace({ qSid: 14 })] }] },
        { packs: [{ source: 'common', emojis: [baseFace({ aniStickerType: '1' })] }] },
        { packs: [{ source: 'common', emojis: [baseFace({ emojiNameAlias: new Array(1) })] }] }];
    for (const response of bad) { const f = fixture(); f.overrides.extendedQuery = () => response; await rejects(f.invoke('fetch_sys_faces'), 'INVALID_RESPONSE'); }
    const f = fixture(), response = { packs: packs() };
    Object.defineProperty(response, 'unrelated', { get() { assert.fail('unknown response metadata must not be read'); } });
    Object.defineProperty(response.packs[0].emojis[0], 'unrelated', { get() { assert.fail('unknown face metadata must not be read'); } });
    f.overrides.extendedQuery = () => response;
    assert.equal((await f.invoke('fetch_sys_faces')).packs[0].emojis[0].q_sid, '14');
    Object.defineProperty(response.packs[0].emojis[0], 'qDes', { get() { assert.fail('known response accessor must not execute'); } });
    await rejects(f.invoke('fetch_sys_faces'), 'INVALID_RESPONSE');
});

test('catalog bounds account for escaped JSON bytes as well as entry and pack counts', async () => {
    const f = fixture(), huge = baseFace({ qDes: '\u0001'.repeat(4096), emCode: '\\'.repeat(4096), emojiNameAlias: Array(128).fill('a'.repeat(1024)) });
    f.overrides.extendedQuery = () => ({ packs: [{ source: 'common', emojis: Array(16).fill(huge) }] });
    await rejects(f.invoke('fetch_sys_faces'), 'INVALID_RESPONSE');
    assert.ok(MAX_RESULT_BYTES < 16 * Buffer.byteLength(JSON.stringify(huge)));
    f.overrides.extendedQuery = () => ({ packs: [{ source: 'common', emojis: Array(5001).fill(baseFace()) }] });
    await rejects(f.invoke('fetch_sys_faces'), 'INVALID_RESPONSE');
    f.overrides.extendedQuery = () => ({ packs: Array(1537).fill({ source: 'common', emojis: [] }) });
    await rejects(f.invoke('fetch_sys_faces'), 'INVALID_RESPONSE');
});

test('catalog output accepts exactly one MiB and rejects one more serialized byte', async () => {
    const f = fixture(), entry = baseFace({ qDes: 'x'.repeat(1000) });
    f.overrides.extendedQuery = () => ({ packs: [{ source: 'common', packName: '', emojis: [entry] }] });
    const projected = (await f.invoke('fetch_sys_faces')).packs[0].emojis[0], faceBytes = Buffer.byteLength(JSON.stringify(projected)),
        envelopeBytes = Buffer.byteLength(JSON.stringify({ packs: [{ pack_name: '', emojis: [] }] })),
        count = Math.floor((MAX_RESULT_BYTES - envelopeBytes + 1) / (faceBytes + 1)),
        padding = MAX_RESULT_BYTES - envelopeBytes - count * faceBytes - count + 1;
    assert.ok(count < 5000 && padding < 4096);
    const response = { packs: [{ source: 'common', packName: 'x'.repeat(padding), emojis: Array(count).fill(entry) }] };
    f.overrides.extendedQuery = () => response;
    assert.equal(Buffer.byteLength(JSON.stringify(await f.invoke('fetch_sys_faces'))), MAX_RESULT_BYTES);
    response.packs[0].packName += 'x';
    await rejects(f.invoke('fetch_sys_faces'), 'INVALID_RESPONSE');
});

test('compatibility actions enforce account identity, all capabilities, primitive types and safe parameter properties', async () => {
    for (const [action, params] of [['fetch_sys_faces', { refresh: null }], ['fetch_face_entity', { face_id: -1 }], ['fetch_face_entity', { face_id: 4294967296 }],
        ['search_sys_faces', { query: '' }], ['search_sys_faces', { query: 'x', refresh: false }], ['fetch_sys_faces', { self_id: 22222 }]]) {
        const f = fixture(); await rejects(f.invoke(action, params), 'INVALID_PARAMS'); assert.equal(f.calls.length, 0);
    }
    for (const flag of ['friendCategorySet', 'friendCategories']) {
        const f = fixture(); f.state.capabilities[flag] = false; await rejects(f.invoke('set_friends_category', { uin: 22222, categoryId: 7 }), 'UNSUPPORTED'); assert.equal(f.calls.length, 0);
    }
    for (const flag of ['systemFaceList', 'systemFaceGet']) {
        const f = fixture(); f.state.capabilities[flag] = false; await rejects(f.invoke('fetch_face_entity', { face_id: 14 }), 'UNSUPPORTED'); assert.equal(f.calls.length, 0);
    }
    const f = fixture(), params = {};
    Object.defineProperty(params, 'refresh', { get() { assert.fail('parameter getter must not execute'); }, enumerable: true });
    await rejects(f.invoke('fetch_sys_faces', params), 'INVALID_PARAMS');
    await rejects(f.invoke('fetch_sys_faces', Object.create({ refresh: true })), 'INVALID_PARAMS');
    await rejects(f.invoke('not_registered'), 'UNSUPPORTED'); assert.equal(f.calls.length, 0);
});

test('actual extended adapter retains raw packs and exact single identity through the compatibility projection', async () => {
    const wire = [], capture = { epoch: 'compat-real-adapter', self: { uin: '11111', uid: 'u_self' }, session: {}, ensureReady() {}, hasMethods: () => true,
        deadline: operation => operation(), resolve: async request => ({ uin: request.uin, uid: 'u_friend' }) };
    const extended = createExtended(capture, { native: { available: () => true, async run(_capture, request) {
        wire.push(request);
        if (request.operation === 'face.list') return { packs: packs() };
        if (request.operation === 'face.get') return { face: baseFace({ qSid: request.request.faceId, aniStickerType: 1 }) };
        assert.fail('No writes expected');
    } } });
    const state = { ready: true, epoch: capture.epoch, self: capture.self, capabilities: extended.capabilities() }, deadlines = [];
    const service = new OneBotService({ store: {}, backend: { async call(method, request, options) {
        if (method === 'status') return state;
        deadlines.push(Date.now() + options.timeoutMs);
        if (method === 'extendedQuery') return extended.query(request, { expiresAt: Date.now() + options.timeoutMs });
        assert.fail('Unexpected RPC ' + method);
    } } });
    const expiration = Date.now() + 15000;
    const invoke = (action, params) => service.deadlines.run(expiration, () => runCompatActions(service, state, action, params));
    const all = await invoke('fetch_sys_faces', {}); assert.equal(all.packs[2].pack_name, 'MagicFace');
    assert.equal((await invoke('fetch_face_entity', { face_id: 999 })).q_sid, '999');
    assert.equal(wire.at(-1).request.faceId, '999'); assert.equal(wire.at(-1).expectedUin, '11111'); assert.equal(wire.at(-1).expectedEpoch, capture.epoch);
    assert.ok(deadlines.every(deadline => Math.abs(deadline - expiration) < 20));
});
