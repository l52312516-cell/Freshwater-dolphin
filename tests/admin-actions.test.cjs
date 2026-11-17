'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/qq/proto.cjs');
const protocol = require('../src/qq/admin-oidb.cjs');
const { createAdminQueries, random, MAX_PENDING } = require('../src/qq/admin-queries.cjs');
const { Capture } = require('../src/qq/capture.cjs');
const { ACTIONS, EXTENSION_REQUIREMENTS, READ_ONLY_ACTIONS, runAdminActions, MAX_KICK_MEMBERS } = require('../src/onebot/admin-actions.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { createChannel } = require('../src/qq/msf-native.cjs');
const { TransportHub, parameters } = require('../src/onebot/transports.cjs');
const { nodeConfig } = require('../src/config.cjs');
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value)), join = (...parts) => Buffer.concat(parts);
const turn = () => new Promise(resolve => setImmediate(resolve));
const error = code => Object.assign(new Error(code), { code });
const rejects = (promise, code) => assert.rejects(promise, reason => reason.code === code);
function envelope(prepared, body = Buffer.alloc(0), changes = {}) {
    return join(n(1, changes.command ?? prepared.command), n(2, changes.sub ?? prepared.sub), n(3, changes.error ?? 0), b(4, body), n(12, changes.mode ?? prepared.mode));
}
function wireDetail(prepared, detail, groupId = prepared.data.groupId) {
    return envelope(prepared, b(1, join(n(1, groupId), b(3, join(s(1, detail.ownerUid), n(7, detail.addType), s(24, detail.question), s(25, detail.answer),
        n(21, groupId), n(56, detail.privilegeFlag), n(101, detail.groupFlagExt4), n(82, detail.noFingerOpen), n(83, detail.noCodeFingerOpen))))));
}
function fixture() {
    const detail = { ownerUid: 'u_self', addType: 2, question: 'Original question', answer: 'Original answer', privilegeFlag: 0x80000042,
        groupFlagExt4: 0, noFingerOpen: 0, noCodeFingerOpen: 1 }, robot = { robotMemberSwitch: 1, robotMemberExamine: 0 }, tags = [{ id: 1, name: '测试标签', type: 2 }];
    const calls = [], overrides = {};
    const capture = { epoch: 'admin-epoch', self: { uin: '11111', uid: 'u_self' }, session: {}, ensureReady() {}, hasMethods: () => true,
        deadline: operation => operation(), async getMessage(request) {
            calls.push({ message: request });
            return overrides.message ? overrides.message(request) : { chatType: 2, peerUid: '12345', msgId: '18446744073709551614', msgSeq: '100', msgRandom: '-1' };
        } };
    function perform(params) {
        const prepared = protocol.prepare(params.operation, params.request), data = prepared.data;
        let bytes;
        if (params.operation === 'group.settingsDetail') bytes = wireDetail(prepared, detail);
        else if (params.operation === 'group.robotDetail') bytes = envelope(prepared, b(1, join(n(1, data.groupId), n(2, 0), b(3, join(n(29, robot.robotMemberSwitch), n(30, robot.robotMemberExamine))))));
        else if (params.operation === 'group.tags') bytes = envelope(prepared, join(...tags.map(tag => b(1, join(n(1, tag.id), s(2, tag.name), n(3, tag.type))))));
        else if (params.operation === 'group.shareLink') bytes = envelope(prepared, b(12, s(1, 'https://qun.qq.com/real-share-link')));
        else {
            if (params.operation === 'group.addOption') {
                detail.addType = data.addType === 55 ? 5 : data.addType;
                if ([4, 5].includes(detail.addType)) { detail.question = data.groupQuestion ?? ''; detail.answer = detail.addType === 4 ? data.groupAnswer ?? '' : ''; }
            } else if (params.operation === 'group.search') {
                for (const key of ['noFingerOpen', 'noCodeFingerOpen']) if (data[key] !== undefined) detail[key] = data[key];
            } else if (params.operation === 'group.robotOption') {
                for (const key of ['robotMemberSwitch', 'robotMemberExamine']) if (data[key] !== undefined) robot[key] = data[key];
            } else if (params.operation === 'group.invitePolicy') detail.privilegeFlag = protocol.mergeInvite(data.currentPrivilegeFlag, data.policy);
            else if (params.operation === 'group.memberPermission') detail.privilegeFlag = protocol.mergePermission(data.currentPrivilegeFlag, data.permission, data.allow);
            else if (params.operation === 'group.historyVisibility') detail.groupFlagExt4 = data.visible ? 1 : 0;
            else if (params.operation === 'group.tagAdd') tags.push({ id: 2, name: data.name, type: 0 });
            else if (params.operation === 'group.tagDelete') tags.splice(tags.findIndex(tag => tag.name === data.name), 1);
            bytes = params.operation === 'group.robotOption' ? envelope(prepared, join(n(1, data.groupId), n(2, 0))) : envelope(prepared);
        }
        return protocol.decode(bytes, prepared);
    }
    const native = { available: () => true, async run(bound, params) {
        assert.equal(bound, capture); calls.push(params); return overrides.run ? overrides.run(params, () => perform(params)) : perform(params);
    } };
    const admin = createAdminQueries(capture, { native, pollMs: 2 });
    return { detail, robot, tags, calls, capture, native, overrides, admin, perform,
        query: (operation = 'group.settings', data = { groupId: '12345' }, context = {}) => admin.query({ operation, ...data, expectedEpoch: capture.epoch }, context),
        action: (operation, data = { groupId: '12345' }, context = {}) => admin.action({ operation, ...data, expectedEpoch: capture.epoch }, context) };
}
function onebotFixture() {
    const f = fixture(), state = { ready: true, epoch: f.capture.epoch, self: f.capture.self, capabilities: { ...f.admin.capabilities(), groupKick: true, groupMember: true } },
        rpc = [], mutations = [], overrides = {}, entries = new Map([[1, { locator: { peer: { chatType: 2, peerUid: '12345' } } }]]);
    const service = {
        store: { get(account, id) { assert.equal(String(account), '11111'); return entries.get(id); } },
        async assertSession(bound) { assert.equal(bound, state); if (overrides.stale) throw error('NOT_READY'); },
        async sessionCall(bound, method, request) {
            await this.assertSession(bound); rpc.push({ method, request });
            const context = { expiresAt: Date.now() + 500 };
            let result;
            if (overrides[method]) result = await overrides[method](request);
            else if (method === 'adminQuery') result = await f.admin.query({ ...request, expectedEpoch: state.epoch }, context);
            else if (method === 'adminAction') result = await f.admin.action({ ...request, expectedEpoch: state.epoch }, context);
            else if (method === 'groupMember') result = { group_id: Number(request.groupId), user_id: Number(request.uin), role: request.uin === '11111' ? 'owner' : 'member' };
            else assert.fail('Unexpected method ' + method);
            await this.assertSession(bound); return result;
        },
        async record(bound, id, peer, options) {
            await this.assertSession(bound); assert.equal(id, 1); assert.deepEqual(peer, { chatType: 2, peerUid: '12345' }); assert.deepEqual(options, { refresh: true });
            return overrides.record ? overrides.record() : { chatType: 2, peerUid: '12345', msgId: '18446744073709551614', msgSeq: '100', msgRandom: '-1' };
        },
        async groupAction(bound, params, action) {
            await this.assertSession(bound); assert.equal(action, 'set_group_kick'); mutations.push(params);
            if (overrides.kick) return overrides.kick(params); return null;
        }
    };
    return { ...f, state, service, rpc, mutations, overrides, entries, invoke: (action, params = {}) => runAdminActions(service, state, action, params) };
}

test('admin query wire uses exact GET masks and keeps GET and modification field numbers distinct', () => {
    const prepared = protocol.prepare('group.settingsDetail', { groupId: 12345 }), top = p.fields(prepared.body), body = p.fields(top.get(4)[0].value), config = p.fields(body.get(2)[0].value), flags = p.fields(config.get(2)[0].value);
    assert.equal(prepared.name, 'OidbSvcTrpcTcp.0x88d_0'); assert.equal(prepared.mode, 0); assert.equal(body.get(1)[0].value, 537099973n); assert.equal(config.get(1)[0].value, 12345n);
    for (const field of [1, 7, 21, 56, 101, 82, 83]) assert.equal(flags.get(field)[0].value, 1n);
    for (const field of [24, 25]) { assert.equal(flags.get(field)[0].wire, 2); assert.equal(flags.get(field)[0].value.length, 0); }
    const robot = protocol.prepare('group.robotDetail', { groupId: 12345 });
    assert.equal(robot.name, 'OidbSvcTrpcTcp.0xef0_1'); assert.equal(robot.mode, 1);
});

test('category zero is physically sent and uses the real category commands rather than a group ID', () => {
    for (const [operation, command] of [['group.tags', 0x967c], ['group.tagAdd', 0x967d], ['group.tagDelete', 0x967e]]) {
        const prepared = protocol.prepare(operation, { groupClass: 0, ...(operation === 'group.tags' ? {} : { name: '标签' }) }), body = p.fields(p.fields(prepared.body).get(4)[0].value);
        assert.equal(prepared.command, command); assert.equal(body.get(1)[0].value, 0n);
        if (operation !== 'group.tags') assert.equal(body.get(2)[0].value.toString(), '标签');
    }
});

test('share-link request fixes type=2 and preserves false/empty fields while srcId remains a validated compatibility parameter', () => {
    const first = protocol.prepare('group.shareLink', { groupId: 12345, needShortUrl: false, srcId: 73, additionalParam: '' }),
        second = protocol.prepare('group.shareLink', { groupId: 12345, needShortUrl: false, srcId: 1, additionalParam: '' }),
        body = p.fields(p.fields(first.body).get(4)[0].value), group = p.fields(body.get(12)[0].value);
    assert.equal(first.name, 'OidbSvcTrpcTcp.0x9060_3'); assert.equal(first.mode, 1); assert.equal(body.get(1)[0].value, 2n);
    assert.equal(group.get(1)[0].value, 12345n); assert.equal(group.get(3)[0].value.length, 0); assert.equal(group.get(4)[0].value, 0n);
    assert.deepEqual(first.body, second.body);
});

test('join option wire preserves exact 4/5/55 question-answer behavior including empty clearing', () => {
    for (const [addType, expectedType, answer] of [[4, 4, 'Answer'], [5, 5, ''], [55, 5, '']]) {
        const prepared = protocol.prepare('group.addOption', { groupId: 12345, addType, groupQuestion: 'Question', groupAnswer: 'Answer' }), body = p.fields(p.fields(prepared.body).get(4)[0].value), settings = p.fields(body.get(2)[0].value);
        assert.equal(prepared.command, 0x89a); assert.equal(settings.get(16)[0].value, BigInt(expectedType)); assert.equal(settings.get(30)[0].value.toString(), 'Question'); assert.equal(settings.get(31)[0].value.toString(), answer);
    }
    const prepared = protocol.prepare('group.addOption', { groupId: 12345, addType: 2, groupQuestion: 'Ignored', groupAnswer: 'Ignored' }), body = p.fields(p.fields(prepared.body).get(4)[0].value), settings = p.fields(body.get(2)[0].value);
    assert.deepEqual([...settings.keys()], [16]);
});

test('settings writes send zero values explicitly and omit only unrequested fields', () => {
    const search = protocol.prepare('group.search', { groupId: 12345, noFingerOpen: 0 }), body = p.fields(p.fields(search.body).get(4)[0].value), settings = p.fields(body.get(2)[0].value);
    assert.deepEqual([...settings.keys()], [35]); assert.equal(settings.get(35)[0].value, 0n);
    const robot = protocol.prepare('group.robotOption', { groupId: 12345, robotMemberExamine: 0 }), top = p.fields(p.fields(robot.body).get(4)[0].value), info = p.fields(top.get(2)[0].value), ext = p.fields(info.get(2)[0].value);
    assert.equal(robot.name, 'OidbSvcTrpcTcp.0xf00_3'); assert.equal(robot.mode, 1); assert.equal(info.get(1)[0].value, 12345n); assert.deepEqual([...ext.keys()], [30]); assert.equal(ext.get(30)[0].value, 0n);
});

test('permission and invite wire merge real uint32 high bits and use narrow masks, including history switch semantics', () => {
    const current = 0x8f01abcd;
    for (const policy of Object.keys(protocol.INVITE_BITS)) {
        const merged = protocol.mergeInvite(current, policy);
        assert.equal(BigInt(merged) & ~BigInt(protocol.INVITE_MASK), BigInt(current) & ~BigInt(protocol.INVITE_MASK)); assert.equal(protocol.invitePolicy(merged), policy);
        const prepared = protocol.prepare('group.invitePolicy', { groupId: 12345, currentPrivilegeFlag: current, policy }), body = p.fields(p.fields(prepared.body).get(4)[0].value), settings = p.fields(body.get(2)[0].value);
        assert.equal(settings.get(23)[0].value, BigInt(merged)); assert.equal(settings.get(24)[0].value, BigInt(protocol.INVITE_MASK)); assert.equal(settings.get(29)[0].value, policy === 'disabled' ? 0n : 1n);
    }
    for (const permission of Object.keys(protocol.PERMISSION_MASKS)) {
        const mask = BigInt(protocol.PERMISSION_MASKS[permission]), merged = protocol.mergePermission(current, permission, true);
        assert.equal(BigInt(merged) & mask, 0n); assert.equal(BigInt(merged) & ~mask, BigInt(current) & ~mask);
    }
    assert.equal(protocol.historyVisible(0), false); assert.equal(protocol.historyVisible(1), true); assert.equal(protocol.historyVisible(4), true);
    const prepared = protocol.prepare('group.historyVisibility', { groupId: 12345, visible: false }), body = p.fields(p.fields(prepared.body).get(4)[0].value), settings = p.fields(body.get(2)[0].value);
    assert.equal(settings.get(42)[0].value, 0n); assert.equal(settings.get(43)[0].value, 4n);
});

test('todo operations retain exact uint64 sequences and fixed subcommands without accepting raw packet controls', () => {
    for (const [operation, sub] of [['todo.set', 1], ['todo.complete', 2], ['todo.cancel', 3]]) {
        const prepared = protocol.prepare(operation, { groupId: 12345, sequence: '18446744073709551615' }), body = p.fields(p.fields(prepared.body).get(4)[0].value);
        assert.equal(prepared.command, 0xf90); assert.equal(prepared.sub, sub); assert.equal(body.get(2)[0].value, 0xffffffffffffffffn);
        assert.equal(protocol.decode(envelope(prepared), prepared).confirmed, true);
    }
    assert.throws(() => protocol.prepare('todo.set', { groupId: 12345, sequence: 1, command: 1 }), { code: 'INVALID_PARAMS' });
});

test('settings decoder checks group identities, errors, duplicate/wrong fields and real uint32 ranges', () => {
    const f = fixture(), prepared = protocol.prepare('group.settingsDetail', { groupId: 12345 });
    assert.deepEqual(protocol.decode(wireDetail(prepared, f.detail), prepared).detail, f.detail);
    assert.throws(() => protocol.decode(wireDetail(prepared, f.detail, '54321'), prepared), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(envelope(prepared), prepared), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(envelope(prepared, b(1, join(n(1, 12345), b(3, n(56, 0x100000000n))))), prepared), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(join(wireDetail(prepared, f.detail), n(3, 0)), prepared), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(envelope(prepared, Buffer.alloc(0), { error: 1 }), prepared), { code: 'KERNEL_ERROR' });
    assert.throws(() => protocol.decode(wireDetail(prepared, f.detail).subarray(0, 8), prepared), { code: 'INVALID_RESPONSE' });
});

test('robot decoder selects only the exact group and refuses duplicate target results or body-level failure', () => {
    const prepared = protocol.prepare('group.robotDetail', { groupId: 12345 }), item = (id, result = 0) => b(1, join(n(1, id), n(2, result), b(3, join(n(29, 1), n(30, 0)))));
    assert.deepEqual(protocol.decode(envelope(prepared, join(item(54321), item(12345))), prepared).robot, { robotMemberSwitch: 1, robotMemberExamine: 0 });
    assert.throws(() => protocol.decode(envelope(prepared, item(54321)), prepared), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(envelope(prepared, join(item(12345), item(12345))), prepared), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(envelope(prepared, item(12345, 7)), prepared), { code: 'KERNEL_ERROR' });
    const write = protocol.prepare('group.robotOption', { groupId: 12345, robotMemberSwitch: 0 });
    assert.throws(() => protocol.decode(envelope(write, join(n(1, 54321), n(2, 0))), write), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(envelope(write, join(n(1, 12345), n(2, 7))), write), { code: 'KERNEL_ERROR' });
});

test('tag and URL decoders bound content, preserve official zero IDs, and reject ambiguous or unsafe data', () => {
    const prepared = protocol.prepare('group.tags', { groupClass: 0 }), tag = b(1, join(n(1, 0), s(2, 'Tag'), n(3, 0)));
    assert.deepEqual(protocol.decode(envelope(prepared, tag), prepared).tags, [{ id: 0, name: 'Tag', type: 0 }]);
    assert.deepEqual(protocol.decode(envelope(prepared), prepared).tags, []);
    assert.throws(() => protocol.decode(envelope(prepared, join(tag, tag)), prepared), { code: 'INVALID_RESPONSE' });
    const share = protocol.prepare('group.shareLink', { groupId: 12345, srcId: 73, needShortUrl: true, additionalParam: '' });
    for (const url of ['', 'http://qun.qq.com/x', 'https://u:secret@qun.qq.com/x', 'https://qun.qq.com/has space']) assert.throws(() => protocol.decode(envelope(share, b(12, s(1, url))), share), { code: 'INVALID_RESPONSE' });
    assert.equal(protocol.decode(envelope(share, b(12, s(1, 'https://qm.qq.com/real'))), share).url, 'https://qm.qq.com/real');
});

test('fixed operations reject missing updates, nulls, unknown values and caller-controlled bitfields', () => {
    for (const [operation, input] of [['group.search', { groupId: 12345 }], ['group.robotOption', { groupId: 12345 }],
        ['group.historyVisibility', { groupId: 12345, visible: 0 }], ['group.invitePolicy', { groupId: 12345, currentPrivilegeFlag: 0, policy: 'unknown' }],
        ['group.memberPermission', { groupId: 12345, currentPrivilegeFlag: 0, permission: 'unknown', allow: true }], ['group.tagAdd', { groupClass: 0, name: '' }]]) {
        assert.throws(() => protocol.prepare(operation, input), { code: 'INVALID_PARAMS' });
    }
    const f = fixture(); return rejects(f.action('group.invitePolicy', { groupId: '12345', policy: 'disabled', currentPrivilegeFlag: 0 }), 'INVALID_PARAMS');
});

test('settings query combines real detail and robot replies into the complete requested public fields', async () => {
    const f = fixture(), result = await f.query();
    assert.deepEqual(f.calls.map(call => call.operation), ['group.settingsDetail', 'group.robotDetail']);
    assert.deepEqual(result, { operation: 'group.settings', groupId: '12345', settings: {
        add_type: 2, group_question: 'Original question', group_answer: 'Original answer', robot_member_switch: 1, robot_member_examine: 0,
        member_invite_policy: 'require_approval', allow_member_upload_album: true, allow_member_temporary_session: true,
        allow_member_create_group: true, new_member_history_visible: false, no_finger_open: 0, no_code_finger_open: 1 } });
    assert.equal(f.calls.every(call => call.op === 'fixedAdmin' && call.expectedUin === '11111' && call.expectedEpoch === f.capture.epoch), true);
});

test('tag and URL queries retain their respective category and request context', async () => {
    const f = fixture();
    assert.deepEqual(await f.query('group.tags', { groupClass: 0 }), { operation: 'group.tags', groupClass: 0, tags: [{ id: 1, name: '测试标签', type: 2 }] });
    const value = await f.query('group.shareLink', { groupId: '12345', needShortUrl: false, srcId: 0, additionalParam: 'a=1' });
    assert.equal(value.url, 'https://qun.qq.com/real-share-link'); assert.equal(value.needShortUrl, false); assert.equal(value.srcId, 0);
});

test('invitation mutation reads the actual flags before writing and preserves every unmodified high bit', async () => {
    const f = fixture(), before = f.detail.privilegeFlag;
    const result = await f.action('group.invitePolicy', { groupId: '12345', policy: 'no_approval' });
    assert.equal(result.confirmed, true); assert.equal(result.confirmation, 'settings_readback');
    const write = f.calls.find(call => call.operation === 'group.invitePolicy');
    assert.equal(write.request.currentPrivilegeFlag, before); assert.equal(protocol.invitePolicy(f.detail.privilegeFlag), 'no_approval');
    assert.equal(BigInt(f.detail.privilegeFlag) & ~BigInt(protocol.INVITE_MASK), BigInt(before) & ~BigInt(protocol.INVITE_MASK));
    assert.deepEqual(f.calls.map(call => call.operation), ['group.settingsDetail', 'group.invitePolicy', 'group.settingsDetail']);
});

test('compound member permissions require a verified owner and apply one bit per acknowledged readback', async () => {
    const f = fixture(), before = f.detail.privilegeFlag;
    const result = await f.action('group.permissions', { groupId: '12345', allowMemberUploadAlbum: false, allowMemberTemporarySession: false, allowMemberCreateGroup: true });
    assert.equal(result.confirmed, true);
    const writes = f.calls.filter(call => call.operation === 'group.memberPermission');
    assert.deepEqual(writes.map(call => call.request.permission), ['upload_album', 'temporary_session', 'create_group']);
    assert.equal(writes[0].request.currentPrivilegeFlag, before);
    assert.equal(writes[1].request.currentPrivilegeFlag, protocol.mergePermission(before, 'upload_album', false));
    const combined = 1n | 0x10000n | 0x8000n;
    assert.equal(BigInt(f.detail.privilegeFlag) & ~combined, BigInt(before) & ~combined);
    for (const ownerUid of ['', 'u_other']) {
        const no = fixture(); no.detail.ownerUid = ownerUid;
        await rejects(no.action('group.permissions', { groupId: '12345', allowMemberUploadAlbum: false }), 'UNSUPPORTED');
        assert.equal(no.calls.some(call => call.operation === 'group.memberPermission'), false);
    }
});

test('partial compound member permission failure reports the already confirmed count and never retries', async () => {
    const f = fixture();
    f.overrides.run = (params, perform) => { if (params.operation === 'group.memberPermission' && params.request.permission === 'temporary_session') throw error('KERNEL_ERROR'); return perform(); };
    await assert.rejects(f.action('group.permissions', { groupId: '12345', allowMemberUploadAlbum: false, allowMemberTemporarySession: false, allowMemberCreateGroup: false }), reason => reason.code === 'PARTIAL_RESULT' && reason.message.includes('1 of 3'));
    assert.deepEqual(f.calls.filter(call => call.operation === 'group.memberPermission').map(call => call.request.permission), ['upload_album', 'temporary_session']);
});

test('search and robot writes preserve unrequested fields while correctly applying explicit zero', async () => {
    const f = fixture();
    await f.action('group.search', { groupId: '12345', noFingerOpen: 1 }); assert.equal(f.detail.noFingerOpen, 1); assert.equal(f.detail.noCodeFingerOpen, 1);
    await f.action('group.search', { groupId: '12345', noFingerOpen: 0 }); assert.equal(f.detail.noFingerOpen, 0);
    await f.action('group.robotOption', { groupId: '12345', robotMemberExamine: 1 }); assert.deepEqual(f.robot, { robotMemberSwitch: 1, robotMemberExamine: 1 });
    await f.action('group.robotOption', { groupId: '12345', robotMemberSwitch: 0 }); assert.deepEqual(f.robot, { robotMemberSwitch: 0, robotMemberExamine: 1 });
    const writes = f.calls.filter(call => ['group.search', 'group.robotOption'].includes(call.operation));
    assert.deepEqual(writes[0].request, { groupId: '12345', noFingerOpen: 1 }); assert.deepEqual(writes[2].request, { groupId: '12345', robotMemberExamine: 1 });
});

test('join question clearing and history visibility require real settings readback after a single write', async () => {
    const f = fixture();
    await f.action('group.addOption', { groupId: '12345', addType: 55, groupQuestion: 'New question', groupAnswer: 'Must clear' });
    assert.equal(f.detail.addType, 5); assert.equal(f.detail.question, 'New question'); assert.equal(f.detail.answer, '');
    await f.action('group.historyVisibility', { groupId: '12345', visible: true }); assert.equal(f.detail.groupFlagExt4, 1);
    await f.action('group.historyVisibility', { groupId: '12345', visible: false }); assert.equal(f.detail.groupFlagExt4, 0);
    assert.equal(f.calls.filter(call => call.operation === 'group.addOption').length, 1);
});

test('tag mutation reads back exact name presence and absence without unnecessary replay for an already correct state', async () => {
    const f = fixture();
    await f.action('group.tagAdd', { groupClass: 0, name: 'New' }); assert.equal(f.tags.some(tag => tag.name === 'New'), true);
    await f.action('group.tagAdd', { groupClass: 0, name: 'New' }); assert.equal(f.calls.filter(call => call.operation === 'group.tagAdd').length, 1);
    await f.action('group.tagDelete', { groupClass: 0, name: 'New' }); assert.equal(f.tags.some(tag => tag.name === 'New'), false);
    await f.action('group.tagDelete', { groupClass: 0, name: 'Missing' }); assert.equal(f.calls.filter(call => call.operation === 'group.tagDelete').length, 1);
});

test('a settings read that consumes the deadline prevents the administration write', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
        const f = fixture();
        f.overrides.run = (params, perform) => {
            if (params.operation === 'group.settingsDetail') t.mock.timers.tick(26);
            return perform();
        };
        await rejects(f.action('group.search', { groupId: '12345', noFingerOpen: 1 }, { expiresAt: Date.now() + 25 }), 'EXPIRED');
        assert.deepEqual(f.calls.map(call => call.operation), ['group.settingsDetail']);
        assert.equal(f.detail.noFingerOpen, 0);
    } finally { t.mock.timers.reset(); }
});

test('missing readback expires without retry and holds the same group lock while a native confirmation remains pending', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    try {
        for (const phase of ['write', 'readback']) {
            const f = fixture(); let release, entered, reads = 0;
            f.capture.pending = new Set(); f.capture.deadline = Capture.prototype.deadline;
            const blocked = new Promise(resolve => { entered = resolve; });
            f.overrides.run = (params, perform) => {
                if (params.operation === 'group.settingsDetail') reads++;
                if (phase === 'write' && params.operation === 'group.search' ||
                    phase === 'readback' && params.operation === 'group.settingsDetail' && reads === 2) {
                    return new Promise(resolve => { release = () => resolve(perform()); entered(); });
                }
                // A server ACK without changed settings requires confirmation;
                // it cannot become success merely because the write settled.
                if (params.operation === 'group.search') return { operation: params.operation, ...params.request,
                    confirmed: true, confirmation: 'server_ack' };
                return perform();
            };
            const first = f.action('group.search', { groupId: '12345', noFingerOpen: 1 }, { expiresAt: Date.now() + 25 });
            const rejected = rejects(first, 'TIMEOUT');
            // Advance time only after the real mutation (and, in the second
            // case, its exact confirmation read) has physically been invoked.
            await blocked;
            const dispatched = ['group.settingsDetail', 'group.search', ...(phase === 'readback' ? ['group.settingsDetail'] : [])];
            assert.deepEqual(f.calls.map(call => call.operation), dispatched);
            assert.equal(f.calls.filter(call => call.operation === 'group.search').length, 1);
            t.mock.timers.tick(25); await rejected;
            assert.equal(f.capture.pending.size, 0);
            await rejects(f.action('group.historyVisibility', { groupId: '12345', visible: true }), 'BUSY');
            assert.deepEqual(f.calls.map(call => call.operation), dispatched);
            release(); await turn();
            // Late settlement must neither replay the mutation nor restart a
            // confirmation read after the original request has expired.
            assert.deepEqual(f.calls.map(call => call.operation), dispatched);
            f.overrides.run = undefined;
            assert.equal((await f.action('group.historyVisibility', { groupId: '12345', visible: true })).confirmed, true);
            assert.equal(f.calls.filter(call => call.operation === 'group.search').length, 1);
            assert.equal(f.calls.filter(call => call.operation === 'group.historyVisibility').length, 1);
            assert.equal(f.capture.pending.size, 0);
        }
    } finally { t.mock.timers.reset(); }
});

test('epoch or UID changes after native mutation suppress all late readback and successful completion', async () => {
    for (const change of [f => { f.capture.epoch = 'changed'; }, f => { f.capture.self.uid = 'u_other'; }, f => { f.capture.session = {}; }]) {
        const f = fixture(); f.overrides.run = (params, perform) => { const result = perform(); if (params.operation === 'group.search') change(f); return result; };
        await rejects(f.action('group.search', { groupId: '12345', noFingerOpen: 1 }), 'SESSION_CHANGED');
        assert.deepEqual(f.calls.map(call => call.operation), ['group.settingsDetail', 'group.search']);
    }
});

test('physical native query budget survives caller timeout and session replacement until actual promises settle', async () => {
    const f = fixture(), completions = [];
    f.capture.deadline = operation => { operation().catch(() => {}); return Promise.reject(error('TIMEOUT')); };
    f.overrides.run = (_params, perform) => new Promise(resolve => completions.push(() => resolve(perform())));
    for (let index = 0; index < MAX_PENDING; index++) await rejects(f.query('group.tags', { groupClass: index }), 'TIMEOUT');
    assert.equal(f.calls.length, MAX_PENDING); f.capture.epoch = 'new'; f.capture.session = {};
    f.capture.deadline = operation => operation(); await rejects(f.query('group.tags', { groupClass: 0 }), 'BUSY'); assert.equal(f.calls.length, MAX_PENDING);
    for (const complete of completions) complete(); await turn(); f.overrides.run = undefined;
    assert.equal((await f.query('group.tags', { groupClass: 0 })).tags.length, 1);
});

test('todo mutation verifies actual native ID, group, authoritative sequence and both signed/unsigned random before one server ACK', async () => {
    const f = fixture();
    const result = await f.action('todo.set', { groupId: '12345', nativeId: '18446744073709551614', sequence: '100', random: '4294967295' });
    assert.deepEqual(result, { operation: 'todo.set', groupId: '12345', nativeId: '18446744073709551614', sequence: '100', random: '4294967295', confirmed: true, confirmation: 'server_ack' });
    assert.deepEqual(f.calls.filter(call => call.operation).map(call => call.operation), ['todo.set']);
    for (const change of [record => { record.chatType = 1; }, record => { record.peerUid = '54321'; }, record => { record.msgId = '1'; }, record => { record.msgSeq = '101'; }, record => { record.msgRandom = 0; }, record => { delete record.msgRandom; }]) {
        const no = fixture(); no.overrides.message = () => { const record = { chatType: 2, peerUid: '12345', msgId: '18446744073709551614', msgSeq: '100', msgRandom: -1 }; change(record); return record; };
        await rejects(no.action('todo.set', { groupId: '12345', nativeId: '18446744073709551614', sequence: '100', random: '4294967295' }), 'INVALID_RESPONSE'); assert.equal(no.calls.some(call => call.operation), false);
    }
    assert.equal(random('-1'), '4294967295');
});

test('all QQ requests reject stale epochs, invalid fields, missing changes and wrong result targets before side effects', async () => {
    const f = fixture();
    await rejects(f.admin.query({ operation: 'group.tags', groupClass: 0, expectedEpoch: 'old' }), 'SESSION_CHANGED');
    for (const [operation, input] of [['group.search', { groupId: '12345' }], ['group.robotOption', { groupId: '12345' }],
        ['group.permissions', { groupId: '12345' }], ['group.permissions', { groupId: '12345', allowMemberUploadAlbum: null }],
        ['group.invitePolicy', { groupId: '12345', policy: 'invalid' }]]) await rejects(f.action(operation, input), 'INVALID_PARAMS');
    await rejects(f.query('group.settings', { groupId: 12345, arbitrary: true }), 'INVALID_PARAMS');
    assert.equal(f.calls.length, 0);
    f.overrides.run = () => ({ operation: 'group.tags', groupClass: 999, tags: [] });
    await rejects(f.query('group.tags', { groupClass: 0 }), 'INVALID_RESPONSE');
});

test('OneBot registry excludes anonymous success stubs and preserves the existing todo list owner', () => {
    assert.equal(ACTIONS.size, 15); assert.equal(ACTIONS.has('get_group_todo_list'), false); assert.equal(ACTIONS.has('set_group_anonymous'), false);
    assert.deepEqual([...READ_ONLY_ACTIONS], ['get_group_admin_settings', 'get_group_tags', 'get_group_share_link']);
    assert.deepEqual(EXTENSION_REQUIREMENTS.set_group_kick_members, ['groupKick', 'groupMember']); assert.equal(MAX_KICK_MEMBERS, 20);
});

test('public admin queries expose exact settings, category tags and URL response shapes', async () => {
    const f = onebotFixture();
    const current = await f.invoke('get_group_admin_settings', { group_id: 12345 }); assert.equal(current.add_type, 2); assert.equal(current.robot_member_switch, 1); assert.equal(Object.keys(current).length, 12);
    assert.deepEqual(await f.invoke('get_group_tags', { group_class: 0 }), { tags: [{ id: 1, name: '测试标签', type: 2 }] });
    assert.deepEqual(await f.invoke('get_group_share_link', { group_id: 12345 }), { url: 'https://qun.qq.com/real-share-link' });
    assert.deepEqual(f.rpc.at(-1).request, { operation: 'group.shareLink', groupId: '12345', needShortUrl: true, srcId: 73, additionalParam: '' });
});

test('public settings changes translate only supplied fields and require target/value readback confirmations', async () => {
    const cases = [
        ['set_group_add_option', { group_id: 12345, add_type: 4, group_question: 'Q', group_answer: 'A' }, 'group.addOption'],
        ['set_group_search', { group_id: 12345, no_finger_open: 0 }, 'group.search'],
        ['set_group_robot_add_option', { group_id: 12345, robot_member_examine: 0 }, 'group.robotOption'],
        ['set_group_member_invite_policy', { group_id: 12345, policy: 'disabled' }, 'group.invitePolicy'],
        ['set_group_new_member_history_visibility', { group_id: 12345, visible: true }, 'group.historyVisibility'],
        ['set_group_member_permissions', { group_id: 12345, allow_member_upload_album: false }, 'group.permissions'],
        ['add_group_tag', { group_class: 0, name: 'New tag' }, 'group.tagAdd'], ['delete_group_tag', { group_class: 0, name: '测试标签' }, 'group.tagDelete']
    ];
    for (const [action, params, operation] of cases) { const f = onebotFixture(); assert.equal(await f.invoke(action, params), null); assert.equal(f.rpc[0].method, 'adminAction'); assert.equal(f.rpc[0].request.operation, operation); }
    const f = onebotFixture(); f.overrides.adminAction = request => ({ ...request, groupId: '54321', confirmed: true, confirmation: 'settings_readback' });
    await rejects(f.invoke('set_group_search', { group_id: 12345, no_finger_open: 1 }), 'INVALID_RESPONSE'); assert.equal(f.rpc.length, 1);
});

test('public admin actions reject unknown/null fields, zero group IDs, no-op changes and other-account routing', async () => {
    const cases = [['set_group_search', { group_id: 12345 }], ['set_group_robot_add_option', { group_id: 12345 }], ['set_group_member_permissions', { group_id: 12345 }],
        ['set_group_search', { group_id: 12345, no_finger_open: null }], ['set_group_new_member_history_visibility', { group_id: 12345, visible: 1 }],
        ['get_group_admin_settings', { group_id: 0 }], ['get_group_admin_settings', { group_id: 12345, self_id: 33333 }], ['get_group_tags', { group_class: -1 }],
        ['add_group_tag', { group_class: 0, name: '' }], ['set_group_member_invite_policy', { group_id: 12345, policy: 'invalid' }],
        ['get_group_share_link', { group_id: 12345, need_short_url: null }], ['get_group_share_link', { group_id: 12345, src_id: 4294967296 }],
        ['get_group_admin_settings', { group_id: 12345, no_cache: true }]];
    for (const [action, params] of cases) { const f = onebotFixture(); await rejects(f.invoke(action, params), 'INVALID_PARAMS'); assert.equal(f.rpc.length, 0); }
    for (const action of ['set_group_anonymous', 'set_group_anonymous_ban']) { const f = onebotFixture(); await rejects(f.invoke(action, {}), 'UNSUPPORTED'); assert.equal(f.rpc.length, 0); }
});

test('public todo operations require real current-account message IDs and never derive IDs from the QQ sequence', async () => {
    for (const action of ['set_group_todo', 'complete_group_todo', 'cancel_group_todo']) {
        const f = onebotFixture(); assert.equal(await f.invoke(action, { group_id: 12345, message_id: 1 }), null);
        assert.equal(f.rpc[0].request.nativeId, '18446744073709551614'); assert.equal(f.rpc[0].request.sequence, '100'); assert.equal(f.rpc[0].request.random, '4294967295');
    }
    const f = onebotFixture();
    await rejects(f.invoke('set_group_todo', { group_id: 12345, message_id: 100 }), 'NOT_FOUND');
    await rejects(f.invoke('set_group_todo', { group_id: 54321, message_id: 1 }), 'INVALID_PARAMS'); assert.equal(f.rpc.length, 0);
    f.overrides.record = () => ({ chatType: 2, peerUid: '12345', msgId: '1', msgSeq: '100' });
    await rejects(f.invoke('set_group_todo', { group_id: 12345, message_id: 1 }), 'INVALID_RESPONSE'); assert.equal(f.rpc.length, 0);
});

test('batch kicks validate all targets first and then reuse only existing single-kick paths', async () => {
    const f = onebotFixture(); assert.equal(await f.invoke('set_group_kick_members', { group_id: 12345, user_id: [22222, '33333'], reject_add_request: true }), null);
    assert.deepEqual(f.rpc.map(call => call.request.uin), ['11111', '22222', '33333']);
    assert.deepEqual(f.mutations, [{ group_id: '12345', user_id: '22222', reject_add_request: true }, { group_id: '12345', user_id: '33333', reject_add_request: true }]);
    const blocked = onebotFixture(); blocked.overrides.groupMember = request => ({ group_id: 12345, user_id: Number(request.uin), role: request.uin === '11111' || request.uin === '33333' ? 'owner' : 'member' });
    await rejects(blocked.invoke('set_group_kick_members', { group_id: 12345, user_id: [22222, 33333] }), 'UNSUPPORTED'); assert.equal(blocked.mutations.length, 0);
});

test('batch kicks reject oversized, duplicated, sparse and self targets before reads, and stop on partial failure', async () => {
    for (const users of [[], [22222, 22222], [11111], new Array(1), Array.from({ length: 21 }, (_item, index) => index + 20000), '22222']) {
        const f = onebotFixture(); await rejects(f.invoke('set_group_kick_members', { group_id: 12345, user_id: users }), 'INVALID_PARAMS'); assert.equal(f.rpc.length, 0); assert.equal(f.mutations.length, 0);
    }
    const f = onebotFixture(); f.overrides.kick = params => { if (params.user_id === '33333') throw error('TIMEOUT'); };
    await assert.rejects(f.invoke('set_group_kick_members', { group_id: 12345, user_id: [22222, 33333, 44444] }), reason => reason.code === 'PARTIAL_RESULT' && reason.message.includes('1 of 3'));
    assert.equal(f.mutations.length, 2); assert.equal(f.mutations.some(params => params.user_id === '44444'), false);
});

test('each multi-capability requirement gates execution before reads or mutations', async () => {
    for (const [action, params] of [['set_group_member_permissions', { group_id: 12345, allow_member_create_group: false }], ['add_group_tag', { group_class: 0, name: 'Tag' }], ['set_group_kick_members', { group_id: 12345, user_id: [22222] }]]) {
        for (const flag of [].concat(EXTENSION_REQUIREMENTS[action])) { const f = onebotFixture(); f.state.capabilities[flag] = false; await rejects(f.invoke(action, params), 'UNSUPPORTED'); assert.equal(f.rpc.length, 0); }
    }
});

test('OneBot session calls and native settings adapter retain the outer total deadline', async () => {
    const f = fixture(), state = { ready: true, epoch: f.capture.epoch, self: f.capture.self, capabilities: f.admin.capabilities() }, expirations = [];
    const service = new OneBotService({ store: {}, backend: { async call(method, params, options) {
        if (method === 'status') return state;
        expirations.push(Date.now() + options.timeoutMs); const context = { expiresAt: Date.now() + options.timeoutMs };
        if (method === 'adminQuery') return f.admin.query(params, context); if (method === 'adminAction') return f.admin.action(params, context);
        assert.fail('Unexpected RPC ' + method);
    } } });
    const expiresAt = Date.now() + 15000;
    const result = await service.deadlines.run(expiresAt, () => runAdminActions(service, state, 'set_group_search', { group_id: 12345, no_finger_open: 1 }));
    assert.equal(result, null); assert.ok(expirations.every(value => Math.abs(value - expiresAt) < 20));
});

test('actual native channel serializes every fixed administration operation and releases correlated responses', async () => {
    const f = fixture(), sent = [], released = [], replies = new Map();
    let prepared;
    const native = {
        resetSession() {}, install: () => ({ ok: true }), readTemplate: () => ({ haveTemplate: true }),
        send(command, hex) {
            assert.equal(command, prepared.name); assert.equal(hex, prepared.body.toString('hex'));
            const requestId = String(sent.length + 1); let body = Buffer.alloc(0);
            if (prepared.operation === 'group.settingsDetail') {
                const response = wireDetail(prepared, f.detail); replies.set(requestId, response);
            } else {
                if (prepared.operation === 'group.robotDetail') body = b(1, join(n(1, prepared.data.groupId), n(2, 0), b(3, join(n(29, 1), n(30, 0)))));
                else if (prepared.operation === 'group.tags') body = b(1, join(n(1, 1), s(2, 'Real tag'), n(3, 0)));
                else if (prepared.operation === 'group.shareLink') body = b(12, s(1, 'https://qun.qq.com/native-channel'));
                else if (prepared.operation === 'group.robotOption') body = join(n(1, prepared.data.groupId), n(2, 0));
                replies.set(requestId, envelope(prepared, body));
            }
            sent.push(command); return { ok: true, requestId };
        },
        readResponse(requestId) { return { requestId, result: 0, count: 1, body: [...replies.get(requestId)] }; },
        release(requestId) { released.push(requestId); }
    };
    const channel = createChannel({ loadNative: () => native }), requests = {
        'group.settingsDetail': { groupId: 12345 }, 'group.robotDetail': { groupId: 12345 }, 'group.tags': { groupClass: 0 },
        'group.shareLink': { groupId: 12345, needShortUrl: false, srcId: 73, additionalParam: '' },
        'group.addOption': { groupId: 12345, addType: 2 }, 'group.search': { groupId: 12345, noFingerOpen: 0 },
        'group.robotOption': { groupId: 12345, robotMemberExamine: 0 },
        'group.invitePolicy': { groupId: 12345, currentPrivilegeFlag: 0x80000042, policy: 'disabled' },
        'group.historyVisibility': { groupId: 12345, visible: false },
        'group.memberPermission': { groupId: 12345, currentPrivilegeFlag: 0x80000042, permission: 'upload_album', allow: false },
        'group.tagAdd': { groupClass: 0, name: 'Real tag' }, 'group.tagDelete': { groupClass: 0, name: 'Real tag' },
        'todo.set': { groupId: 12345, sequence: '18446744073709551615' },
        'todo.complete': { groupId: 12345, sequence: '18446744073709551615' }, 'todo.cancel': { groupId: 12345, sequence: '18446744073709551615' }
    };
    assert.deepEqual(Object.keys(requests).sort(), [...protocol.OPERATIONS].sort());
    for (const [operation, request] of Object.entries(requests)) {
        prepared = protocol.prepare(operation, request);
        const result = await channel.run(f.capture, { op: 'fixedAdmin', operation, request, expectedEpoch: f.capture.epoch, expectedUin: f.capture.self.uin });
        assert.equal(result.operation, operation);
        for (const [key, value] of Object.entries(prepared.data)) assert.equal(result[key], value, operation + ':' + key);
    }
    assert.equal(sent.length, 15); assert.deepEqual(released, Array.from({ length: 15 }, (_, index) => String(index + 1)));
});

test('mutation acknowledgements reject unrelated commands, modes, duplicate fields and unknown bodies without leaking business text', () => {
    for (const operation of ['group.search', 'todo.complete']) {
        const request = operation === 'group.search' ? { groupId: 12345, noFingerOpen: 0 } : { groupId: 12345, sequence: 1 }, prepared = protocol.prepare(operation, request);
        for (const response of [envelope(prepared, Buffer.alloc(0), { command: prepared.command + 1 }),
            envelope(prepared, Buffer.alloc(0), { sub: prepared.sub + 1 }), envelope(prepared, Buffer.alloc(0), { mode: 1 }),
            envelope(prepared, n(99, 0)), join(envelope(prepared), n(1, prepared.command)), Buffer.alloc(1024 * 1024 + 1)]) {
            assert.throws(() => protocol.decode(response, prepared), { code: 'INVALID_RESPONSE' });
        }
        assert.throws(() => protocol.decode(join(envelope(prepared, Buffer.alloc(0), { error: 36 }), s(5, 'PRIVATE SERVER CONTENT')), prepared), reason => {
            assert.equal(reason.code, 'KERNEL_ERROR'); assert.equal(reason.message.includes('PRIVATE'), false); return true;
        });
    }
    const prepared = protocol.prepare('group.robotOption', { groupId: 12345, robotMemberSwitch: 1 });
    assert.throws(() => protocol.decode(envelope(prepared, join(n(1, 12345), n(2, 0xffffffffffffffdcn))), prepared), reason => reason.code === 'KERNEL_ERROR' && reason.message.includes('-36'));
    assert.throws(() => protocol.decode(envelope(prepared, join(n(1, 54321), n(2, 0))), prepared), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(envelope(prepared, join(n(1, 12345), n(2, 0), n(3, 0))), prepared), { code: 'INVALID_RESPONSE' });
});

test('deadline, cancellation and native failures stop administration without retries or invalidating live mutation locks', async () => {
    for (const context of [{ expiresAt: Date.now() - 1 }, { signal: AbortSignal.abort() }]) {
        const f = fixture(); await rejects(f.action('group.search', { groupId: 12345, noFingerOpen: 1 }, context), 'EXPIRED'); assert.equal(f.calls.length, 0);
    }
    const f = fixture(); await rejects(f.query('group.settings', { groupId: 12345 }, { expiresAt: NaN }), 'INVALID_PARAMS');
    f.overrides.run = params => { if (params.operation === 'group.search') throw error('KERNEL_ERROR'); return f.perform(params); };
    await rejects(f.action('group.search', { groupId: 12345, noFingerOpen: 1 }), 'KERNEL_ERROR');
    assert.equal(f.calls.filter(call => call.operation === 'group.search').length, 1);
    assert.equal(f.detail.noFingerOpen, 0);
    f.overrides.run = undefined; assert.equal((await f.action('group.search', { groupId: 12345, noFingerOpen: 1 })).confirmed, true);
});

test('registered OneBot dispatcher exposes all fifteen administration contracts and reports anonymous operations unsupported', async () => {
    const f = onebotFixture(), service = new OneBotService({ store: f.service.store, backend: { async call(method, request) {
        if (method === 'status') return f.state;
        const { expectedEpoch, ...params } = request; assert.equal(expectedEpoch, f.state.epoch);
        return f.service.sessionCall(f.state, method, params);
    } } });
    service.record = (...args) => f.service.record(...args); service.groupAction = (...args) => f.service.groupAction(...args);
    const cases = {
        get_group_admin_settings: { group_id: 12345 }, get_group_tags: { group_class: 0 }, get_group_share_link: { group_id: 12345 },
        add_group_tag: { group_class: 0, name: 'Public tag' }, delete_group_tag: { group_class: 0, name: 'Public tag' },
        set_group_add_option: { group_id: 12345, add_type: 4, group_question: 'Q', group_answer: 'A' },
        set_group_search: { group_id: 12345, no_finger_open: 0 }, set_group_robot_add_option: { group_id: 12345, robot_member_examine: 0 },
        set_group_member_invite_policy: { group_id: 12345, policy: 'no_approval' }, set_group_new_member_history_visibility: { group_id: 12345, visible: false },
        set_group_member_permissions: { group_id: 12345, allow_member_upload_album: false }, set_group_kick_members: { group_id: 12345, user_id: [22222] },
        set_group_todo: { group_id: 12345, message_id: 1 }, complete_group_todo: { group_id: 12345, message_id: 1 }, cancel_group_todo: { group_id: 12345, message_id: 1 }
    };
    assert.deepEqual(Object.keys(cases).sort(), [...ACTIONS].sort());
    for (const [action, params] of Object.entries(cases)) {
        const result = await service.action({ action, params, echo: false }); assert.equal(result.retcode, 0, action + ': ' + JSON.stringify(result)); assert.equal(result.echo, false);
        if (!READ_ONLY_ACTIONS.has(action)) assert.equal(result.data, null, action);
    }
    const status = await service.action({ action: 'get_capabilities' });
    for (const action of ACTIONS) assert.equal(status.data.extensions.find(item => item.name === action)?.available, true, action);
    for (const action of ['set_group_anonymous', 'set_group_anonymous_ban']) assert.equal((await service.action({ action, params: {} })).retcode, 1404);
    f.state.capabilities.groupTodoSet = false;
    assert.equal((await service.action({ action: 'set_group_todo', params: { group_id: 12345, message_id: 1 } })).retcode, 1404);
});

test('HTTP admin fields preserve explicit zero/false while batch user_id is action-specific and opaque text stays unchanged', async t => {
    const f = onebotFixture(), service = new OneBotService({ store: f.service.store, backend: { async call(method, request) {
        if (method === 'status') return f.state;
        const { expectedEpoch, ...params } = request; assert.equal(expectedEpoch, f.state.epoch);
        return f.service.sessionCall(f.state, method, params);
    } } });
    service.groupAction = (...args) => f.service.groupAction(...args);
    const hub = new TransportHub({ config: { profileId: 'admin', gatewayPort: 0, nodes: [nodeConfig({ id: 'api', type: 'httpApi' }, 0)] },
        action: (request, state) => service.action(request, state), status: async () => f.state });
    await hub.open(); hub.start(f.state.self.uin, f.state.epoch); t.after(() => hub.close());
    const base = 'http://127.0.0.1:' + hub.port + '/onebot/admin/api/';
    const kicked = await (await fetch(base + 'set_group_kick_members?' + new URLSearchParams({ group_id: '12345', user_id: '[22222,"33333"]', reject_add_request: 'false' }))).json();
    assert.equal(kicked.retcode, 0, JSON.stringify(kicked)); assert.equal(f.mutations.length, 2); assert.equal(f.mutations.every(params => params.reject_add_request === false), true);
    const changed = await (await fetch(base + 'set_group_member_permissions', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ group_id: '12345', allow_member_upload_album: 'false', allow_member_temporary_session: 'true', allow_member_create_group: 'false' }) })).json();
    assert.equal(changed.retcode, 0, JSON.stringify(changed));
    const link = await (await fetch(base + 'get_group_share_link?' + new URLSearchParams({ group_id: '12345', need_short_url: 'false', src_id: '0', additional_param: '00123' }))).json();
    assert.equal(link.retcode, 0, JSON.stringify(link));
    assert.deepEqual(f.rpc.at(-1).request, { operation: 'group.shareLink', groupId: '12345', needShortUrl: false, srcId: 0, additionalParam: '00123' });
    assert.equal(parameters(new URLSearchParams({ user_id: '22222' }), 'get_stranger_info').user_id, 22222);
    assert.equal(parameters(new URLSearchParams({ user_id: '[22222]' }), 'get_stranger_info').user_id, '[22222]');
    assert.deepEqual(parameters(new URLSearchParams({ action: 'set_group_kick_members', user_id: '[22222]' })).user_id, [22222]);
    const parsed = parameters(new URLSearchParams({ group_class: '0', add_type: '0', no_finger_open: '0', no_code_finger_open: '0',
        robot_member_switch: '0', robot_member_examine: '0', src_id: '0', visible: 'false', need_short_url: 'false', name: '00123', group_answer: '00123' }));
    for (const key of ['group_class', 'add_type', 'no_finger_open', 'no_code_finger_open', 'robot_member_switch', 'robot_member_examine', 'src_id']) assert.equal(parsed[key], 0);
    assert.equal(parsed.visible, false); assert.equal(parsed.need_short_url, false); assert.equal(parsed.name, '00123'); assert.equal(parsed.group_answer, '00123');
});
