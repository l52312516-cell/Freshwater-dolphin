'use strict';

const protocol = require('./admin-oidb.cjs');
const { setTimeout: pause } = require('node:timers/promises');
const MAX_PENDING = 8, MAX_MUTATIONS = 64;
const QUERY_REQUIREMENTS = Object.freeze({ 'group.settings': 'groupAdminSettings', 'group.tags': 'groupCategoryTags', 'group.shareLink': 'groupShareLink' });
const ACTION_REQUIREMENTS = Object.freeze({ 'group.addOption': 'groupAddOption', 'group.search': 'groupSearchOption', 'group.robotOption': 'groupRobotOption',
    'group.invitePolicy': 'groupInvitePolicy', 'group.historyVisibility': 'groupHistoryVisibility', 'group.permissions': 'groupMemberPermissions',
    'group.tagAdd': 'groupCategoryTagAdd', 'group.tagDelete': 'groupCategoryTagDelete',
    'todo.set': 'groupTodoSet', 'todo.complete': 'groupTodoComplete', 'todo.cancel': 'groupTodoCancel' });
const PARAMETERS = Object.freeze({ ...protocol.PARAMETERS, 'group.settings': ['groupId'],
    'group.invitePolicy': ['groupId', 'policy'],
    'group.permissions': ['groupId', 'allowMemberUploadAlbum', 'allowMemberTemporarySession', 'allowMemberCreateGroup'],
    'todo.set': ['groupId', 'nativeId', 'sequence', 'random'], 'todo.complete': ['groupId', 'nativeId', 'sequence', 'random'], 'todo.cancel': ['groupId', 'nativeId', 'sequence', 'random'] });
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function fields(value, operation) {
    if (!protocol.plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' ||
        !['operation', 'expectedEpoch', ...PARAMETERS[operation]].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw problem('INVALID_PARAMS', 'Unexpected group administration query fields');
}
function random(value, code = 'INVALID_PARAMS') {
    if (!['string', 'number'].includes(typeof value) || !/^-?(?:0|[1-9]\d{0,9})$/.test(String(value)) || String(value) === '-0' ||
        !Number.isSafeInteger(Number(value)) || Number(value) < -0x80000000 || Number(value) > 0xffffffff) throw problem(code, 'Invalid exact observed message random');
    return BigInt.asUintN(32, BigInt(value)).toString();
}
function uintResponse(value, name) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) throw problem('INVALID_RESPONSE', 'QQ omitted a real group administration ' + name);
    return value;
}
function detail(value) {
    if (!protocol.plain(value)) throw problem('INVALID_RESPONSE', 'QQ omitted group settings detail');
    const output = {};
    for (const name of ['addType', 'privilegeFlag', 'groupFlagExt4', 'noFingerOpen', 'noCodeFingerOpen']) output[name] = uintResponse(value[name], name);
    for (const name of ['question', 'answer', 'ownerUid']) {
        if (typeof value[name] !== 'string' || Buffer.byteLength(value[name]) > 4096 || value[name].includes('\0')) throw problem('INVALID_RESPONSE', 'QQ omitted group administration text');
        output[name] = value[name];
    }
    if (output.ownerUid && !/^u_[A-Za-z0-9_-]{1,126}$/.test(output.ownerUid)) throw problem('INVALID_RESPONSE', 'QQ returned an invalid group owner UID');
    return output;
}
function robot(value) {
    if (!protocol.plain(value)) throw problem('INVALID_RESPONSE', 'QQ omitted group robot options');
    return { robotMemberSwitch: uintResponse(value.robotMemberSwitch, 'robot switch'), robotMemberExamine: uintResponse(value.robotMemberExamine, 'robot examination') };
}
function tags(value) {
    if (!Array.isArray(value) || value.length > 1000) throw problem('INVALID_RESPONSE', 'QQ omitted bounded category tags');
    let bytes = 0; const seen = new Set();
    return value.map(tag => {
        if (!protocol.plain(tag) || typeof tag.name !== 'string' || !tag.name.length || Buffer.byteLength(tag.name) > 1024 || tag.name.includes('\0')) throw problem('INVALID_RESPONSE', 'QQ returned an invalid category tag');
        const entry = { id: uintResponse(tag.id, 'tag ID'), name: tag.name, type: uintResponse(tag.type, 'tag type') }, key = JSON.stringify(entry);
        if (seen.has(key) || (bytes += Buffer.byteLength(key)) > 1024 * 1024) throw problem('INVALID_RESPONSE', 'QQ returned duplicate or oversized category tags');
        seen.add(key); return entry;
    });
}
function settings(base, options) {
    const flag = BigInt(base.privilegeFlag);
    return { add_type: base.addType, group_question: base.question, group_answer: base.answer,
        robot_member_switch: options.robotMemberSwitch, robot_member_examine: options.robotMemberExamine,
        member_invite_policy: protocol.invitePolicy(base.privilegeFlag), allow_member_upload_album: (flag & 1n) === 0n,
        allow_member_temporary_session: (flag & 0x10000n) === 0n, allow_member_create_group: (flag & 0x8000n) === 0n,
        new_member_history_visible: protocol.historyVisible(base.groupFlagExt4), no_finger_open: base.noFingerOpen, no_code_finger_open: base.noCodeFingerOpen };
}
function createAdminQueries(capture, { native = require('./msf-native.cjs'), pollMs = 150 } = {}) {
    if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000) throw new TypeError('Invalid group administration confirmation interval');
    const pending = new Set(), mutations = new Map();
    function capabilities() {
        const available = native.available(), todo = available && capture.hasMethods('msg', ['getMsgsByMsgId']);
        return { ...Object.fromEntries([...Object.values(QUERY_REQUIREMENTS), ...Object.values(ACTION_REQUIREMENTS)].map(flag => [flag, available])),
            groupTodoSet: todo, groupTodoComplete: todo, groupTodoCancel: todo };
    }
    function scope(params, context) {
        capture.ensureReady();
        if (typeof params.expectedEpoch !== 'string' || params.expectedEpoch !== capture.epoch) throw problem('SESSION_CHANGED', 'Group administration must bind the current QQ session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid };
        protocol.uint(saved.uin, 'authenticated account', 0xffffffffn, 1n);
        if (typeof saved.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(saved.uid)) throw problem('NOT_READY', 'Group administration requires the real QQ identity');
        if (context.expiresAt !== undefined && !Number.isFinite(context.expiresAt)) throw problem('INVALID_PARAMS', 'Invalid group administration deadline');
        const expiresAt = Math.min(context.expiresAt ?? Infinity, Date.now() + 10000);
        const check = () => {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) throw problem('SESSION_CHANGED', 'QQ changed during group administration');
            if (context.signal?.aborted || Date.now() >= expiresAt) throw problem('EXPIRED', 'Group administration expired; mutation delivery may be unknown and must not be retried automatically');
        };
        check(); return { saved, check, context: { ...context, expiresAt } };
    }
    async function fixed(operation, input, bound) {
        bound.check(); const prepared = protocol.prepare(operation, input);
        if (pending.size >= MAX_PENDING) throw problem('BUSY', 'Too many group administration queries remain physically pending');
        const token = {}; pending.add(token);
        const task = Promise.resolve().then(() => {
            bound.check(); return native.run(capture, { op: 'fixedAdmin', operation, request: prepared.data,
                expectedEpoch: bound.saved.epoch, expectedUin: bound.saved.uin, signal: bound.context.signal,
                timeoutMs: Math.max(1, Math.min(10000, bound.context.expiresAt - Date.now())) });
        });
        task.finally(() => pending.delete(token)).catch(() => {});
        const value = await task; bound.check();
        if (!protocol.plain(value) || value.operation !== operation || Object.keys(prepared.data).some(key => value[key] !== prepared.data[key])) throw problem('INVALID_RESPONSE', 'QQ returned unrelated group administration data');
        return value;
    }
    const readDetail = async (groupId, bound) => detail((await fixed('group.settingsDetail', { groupId }, bound)).detail);
    const readRobot = async (groupId, bound) => robot((await fixed('group.robotDetail', { groupId }, bound)).robot);
    async function query(params, context = {}) {
        if (!protocol.plain(params) || !Object.hasOwn(QUERY_REQUIREMENTS, Object.getOwnPropertyDescriptor(params, 'operation')?.value)) throw problem('INVALID_PARAMS', 'Unknown group administration query');
        const operation = params.operation; fields(params, operation);
        const bound = scope(params, context);
        if (!capabilities()[QUERY_REQUIREMENTS[operation]]) throw problem('UNSUPPORTED', 'QQ cannot provide this group administration query');
        const task = Promise.resolve().then(async () => {
            if (operation === 'group.settings') {
                const groupId = protocol.uint(params.groupId, 'group ID', 0xffffffffn, 1n);
                const base = await readDetail(groupId, bound), options = await readRobot(groupId, bound);
                return { operation, groupId, settings: settings(base, options) };
            }
            const { expectedEpoch, operation: ignored, ...input } = params; void expectedEpoch; void ignored;
            const value = await fixed(operation, input, bound);
            return operation === 'group.tags' ? { operation, groupClass: value.groupClass, tags: tags(value.tags) } :
                { operation, groupId: value.groupId, needShortUrl: value.needShortUrl, srcId: value.srcId, additionalParam: value.additionalParam, url: protocol.validateUrl(value.url) };
        });
        const result = await capture.deadline(() => task, bound.context); bound.check(); return result;
    }
    async function locate(input, bound) {
        bound.check();
        const record = await capture.getMessage({ peer: { chatType: 2, peerUid: input.groupId }, nativeId: input.nativeId }); bound.check();
        const observed = [record?.msgRandom, record?.msg_random].filter(value => value !== undefined && value !== null);
        if (record?.chatType !== 2 || record.peerUid !== input.groupId || record.msgId !== input.nativeId || String(record.msgSeq) !== input.sequence ||
            typeof record.msgSeq === 'number' && !Number.isSafeInteger(record.msgSeq) ||
            !observed.length || observed.some(value => random(value, 'INVALID_RESPONSE') !== input.random)) throw problem('INVALID_RESPONSE', 'QQ todo message does not match its known group, sequence and random');
    }
    async function action(params, context = {}) {
        if (!protocol.plain(params) || !Object.hasOwn(ACTION_REQUIREMENTS, Object.getOwnPropertyDescriptor(params, 'operation')?.value)) throw problem('INVALID_PARAMS', 'Unknown group administration mutation');
        const operation = params.operation; fields(params, operation);
        const { expectedEpoch, operation: ignored, ...input } = params; void expectedEpoch; void ignored;
        if (operation === 'group.permissions') {
            input.groupId = protocol.uint(input.groupId, 'group ID', 0xffffffffn, 1n);
            for (const key of ['allowMemberUploadAlbum', 'allowMemberTemporarySession', 'allowMemberCreateGroup']) if (input[key] !== undefined) protocol.bool(input[key]);
            if (!['allowMemberUploadAlbum', 'allowMemberTemporarySession', 'allowMemberCreateGroup'].some(key => input[key] !== undefined)) throw problem('INVALID_PARAMS', 'At least one member permission is required');
        } else if (operation.startsWith('todo.')) {
            input.groupId = protocol.uint(input.groupId, 'group ID', 0xffffffffn, 1n); input.nativeId = protocol.uint(input.nativeId, 'native message ID', 0xffffffffffffffffn, 1n);
            input.sequence = protocol.uint(input.sequence, 'message sequence', 0xffffffffffffffffn, 1n); input.random = random(input.random);
        } else if (operation === 'group.invitePolicy') {
            input.groupId = protocol.uint(input.groupId, 'group ID', 0xffffffffn, 1n); protocol.mergeInvite(0, input.policy);
        } else Object.assign(input, protocol.prepare(operation, input).data);
        const bound = scope(params, context);
        if (!capabilities()[ACTION_REQUIREMENTS[operation]]) throw problem('UNSUPPORTED', 'QQ cannot provide this group administration mutation');
        const key = JSON.stringify([bound.saved.epoch, bound.saved.uin, bound.saved.uid, input.groupId ?? 'category:' + input.groupClass]);
        if (mutations.has(key)) throw problem('BUSY', 'A mutation for this group or category is awaiting confirmation');
        if (mutations.size >= MAX_MUTATIONS) throw problem('BUSY', 'Too many group administration mutations remain pending');
        const token = {}; mutations.set(key, token);
        const task = Promise.resolve().then(async () => {
            let last;
            const send = async (name, request) => {
                const value = await fixed(name, request, bound);
                if (value.confirmed !== true || value.confirmation !== 'server_ack') throw problem('INVALID_RESPONSE', 'QQ did not acknowledge the exact group administration mutation');
                last = value; return value;
            };
            const waitFor = async (read, matches) => {
                for (;;) {
                    const value = await read(); bound.check(); if (matches(value)) return value;
                    await pause(Math.max(1, Math.min(pollMs, bound.context.expiresAt - Date.now()))); bound.check();
                }
            };
            if (operation.startsWith('todo.')) {
                await locate(input, bound);
                await send(operation, { groupId: input.groupId, sequence: input.sequence });
                // 0xf90 is a scoped server acknowledgement. Completing a todo
                // can leave the group's shared banner present for other users.
                return { operation, ...input, confirmed: true, confirmation: 'server_ack' };
            }
            if (operation === 'group.tagAdd' || operation === 'group.tagDelete') {
                const current = tags((await fixed('group.tags', { groupClass: input.groupClass }, bound)).tags), exists = current.some(tag => tag.name === input.name);
                if (exists !== (operation === 'group.tagAdd')) {
                    await send(operation, input);
                    await waitFor(async () => tags((await fixed('group.tags', { groupClass: input.groupClass }, bound)).tags), values => values.some(tag => tag.name === input.name) === (operation === 'group.tagAdd'));
                }
                return { operation, groupClass: Number(input.groupClass), name: input.name, confirmed: true, confirmation: 'category_readback' };
            }
            if (operation === 'group.robotOption') {
                const before = await readRobot(input.groupId, bound); await send(operation, input);
                await waitFor(() => readRobot(input.groupId, bound), actual => ['robotMemberSwitch', 'robotMemberExamine'].every(key => actual[key] === (input[key] === undefined ? before[key] : Number(input[key]))));
            } else if (operation === 'group.permissions') {
                let current = await readDetail(input.groupId, bound);
                if (!current.ownerUid || current.ownerUid !== bound.saved.uid) throw problem('UNSUPPORTED', 'Only the verified group owner can change group member permissions');
                const updates = [['allowMemberUploadAlbum', 'upload_album'], ['allowMemberTemporarySession', 'temporary_session'], ['allowMemberCreateGroup', 'create_group']].filter(([key]) => input[key] !== undefined);
                let completed = 0;
                try {
                    for (const [key, permission] of updates) {
                        const expected = protocol.mergePermission(current.privilegeFlag, permission, input[key]), mask = BigInt(protocol.PERMISSION_MASKS[permission]);
                        await send('group.memberPermission', { groupId: input.groupId, currentPrivilegeFlag: current.privilegeFlag, permission, allow: input[key] });
                        current = await waitFor(() => readDetail(input.groupId, bound), actual => (BigInt(actual.privilegeFlag) & mask) === (BigInt(expected) & mask));
                        completed++;
                    }
                } catch (error) {
                    if (completed) throw problem('PARTIAL_RESULT', 'QQ confirmed ' + completed + ' of ' + updates.length + ' requested group permission changes; remaining changes were not retried');
                    throw error;
                }
            } else {
                const before = await readDetail(input.groupId, bound);
                if (operation === 'group.invitePolicy') {
                    const request = { groupId: input.groupId, policy: input.policy, currentPrivilegeFlag: before.privilegeFlag }, expected = protocol.mergeInvite(before.privilegeFlag, input.policy), mask = BigInt(protocol.INVITE_MASK);
                    await send(operation, request); await waitFor(() => readDetail(input.groupId, bound), actual => (BigInt(actual.privilegeFlag) & mask) === (BigInt(expected) & mask));
                } else if (operation === 'group.historyVisibility') {
                    await send(operation, input); await waitFor(() => readDetail(input.groupId, bound), actual => protocol.historyVisible(actual.groupFlagExt4) === input.visible);
                } else if (operation === 'group.search') {
                    await send(operation, input); await waitFor(() => readDetail(input.groupId, bound), actual => ['noFingerOpen', 'noCodeFingerOpen'].every(key => actual[key] === (input[key] === undefined ? before[key] : Number(input[key]))));
                } else {
                    const type = Number(input.addType) === 55 ? 5 : Number(input.addType);
                    await send(operation, input); await waitFor(() => readDetail(input.groupId, bound), actual => actual.addType === type &&
                        (![4, 5].includes(type) || actual.question === (input.groupQuestion ?? '') && actual.answer === (type === 4 ? input.groupAnswer ?? '' : '')));
                }
            }
            bound.check(); void last;
            return { operation, ...input, confirmed: true, confirmation: 'settings_readback' };
        });
        task.finally(() => { if (mutations.get(key) === token) mutations.delete(key); }).catch(() => {});
        const result = await capture.deadline(() => task, bound.context); bound.check(); return result;
    }
    return { capabilities, query, action };
}

module.exports = { createAdminQueries, QUERY_REQUIREMENTS, ACTION_REQUIREMENTS, PARAMETERS, random, settings, MAX_PENDING, MAX_MUTATIONS };
