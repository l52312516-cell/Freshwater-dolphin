'use strict';

const protocol = require('../qq/admin-oidb.cjs');
const { random } = require('../qq/admin-queries.cjs');
const { locator } = require('./store.cjs');
const EXTENSION_REQUIREMENTS = Object.freeze({
    get_group_admin_settings: 'groupAdminSettings', get_group_tags: 'groupCategoryTags', get_group_share_link: 'groupShareLink',
    add_group_tag: Object.freeze(['groupCategoryTags', 'groupCategoryTagAdd']), delete_group_tag: Object.freeze(['groupCategoryTags', 'groupCategoryTagDelete']),
    set_group_add_option: Object.freeze(['groupAdminSettings', 'groupAddOption']), set_group_search: Object.freeze(['groupAdminSettings', 'groupSearchOption']),
    set_group_robot_add_option: Object.freeze(['groupAdminSettings', 'groupRobotOption']), set_group_member_invite_policy: Object.freeze(['groupAdminSettings', 'groupInvitePolicy']),
    set_group_new_member_history_visibility: Object.freeze(['groupAdminSettings', 'groupHistoryVisibility']), set_group_member_permissions: Object.freeze(['groupAdminSettings', 'groupMemberPermissions']),
    set_group_kick_members: Object.freeze(['groupKick', 'groupMember']),
    set_group_todo: 'groupTodoSet', complete_group_todo: 'groupTodoComplete', cancel_group_todo: 'groupTodoCancel'
});
const ACTIONS = new Set(Object.keys(EXTENSION_REQUIREMENTS));
const READ_ONLY_ACTIONS = new Set(['get_group_admin_settings', 'get_group_tags', 'get_group_share_link']);
const UNSUPPORTED_ACTIONS = Object.freeze(['set_group_anonymous', 'set_group_anonymous_ban']);
const MAX_KICK_MEMBERS = 20;
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function fields(value, allowed) {
    if (!protocol.plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['self_id', ...allowed].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw problem('INVALID_PARAMS', 'Unexpected group administration action parameters');
}
const group = value => protocol.uint(value, 'group_id', 0xffffffffn, 1n);
const integer = (value, name) => Number(protocol.uint(value, name));
function short(value) {
    if (!['string', 'number'].includes(typeof value) || !/^-?[1-9]\d{0,9}$/.test(String(value)) ||
        !Number.isInteger(Number(value)) || Number(value) < -0x80000000 || Number(value) > 0x7fffffff) throw problem('INVALID_PARAMS', 'Use a current-account short message_id');
    return Number(value);
}
const OPTIONALS = Object.freeze({
    set_group_add_option: [['group_question', 'groupQuestion', 'string'], ['group_answer', 'groupAnswer', 'string']],
    set_group_search: [['no_finger_open', 'noFingerOpen', 'integer'], ['no_code_finger_open', 'noCodeFingerOpen', 'integer']],
    set_group_robot_add_option: [['robot_member_switch', 'robotMemberSwitch', 'integer'], ['robot_member_examine', 'robotMemberExamine', 'integer']],
    set_group_member_permissions: [['allow_member_upload_album', 'allowMemberUploadAlbum', 'boolean'], ['allow_member_temporary_session', 'allowMemberTemporarySession', 'boolean'], ['allow_member_create_group', 'allowMemberCreateGroup', 'boolean']]
});
function confirmation(value, request) {
    if (!protocol.plain(value) || value.confirmed !== true || typeof value.confirmation !== 'string' ||
        Object.keys(request).some(key => value[key] !== request[key])) throw problem('INVALID_RESPONSE', 'QQ did not confirm the exact group administration target or requested value');
}
function settings(value) {
    if (!protocol.plain(value)) throw problem('INVALID_RESPONSE', 'QQ omitted group administration settings');
    const output = {};
    for (const name of ['add_type', 'robot_member_switch', 'robot_member_examine', 'no_finger_open', 'no_code_finger_open']) {
        if (typeof value[name] !== 'number' || !Number.isInteger(value[name]) || value[name] < 0 || value[name] > 0xffffffff) throw problem('INVALID_RESPONSE', 'QQ omitted an actual group setting integer');
        output[name] = value[name];
    }
    for (const name of ['group_question', 'group_answer']) {
        if (typeof value[name] !== 'string' || Buffer.byteLength(value[name]) > 4096 || value[name].includes('\0')) throw problem('INVALID_RESPONSE', 'QQ omitted a real group join question or answer');
        output[name] = value[name];
    }
    for (const name of ['allow_member_upload_album', 'allow_member_temporary_session', 'allow_member_create_group', 'new_member_history_visible']) {
        if (typeof value[name] !== 'boolean') throw problem('INVALID_RESPONSE', 'QQ omitted an actual group setting boolean'); output[name] = value[name];
    }
    if (!Object.hasOwn(protocol.INVITE_BITS, value.member_invite_policy)) throw problem('INVALID_RESPONSE', 'QQ returned an unknown group invitation policy');
    output.member_invite_policy = value.member_invite_policy; return output;
}
async function runAdminActions(service, state, action, params) {
    if (UNSUPPORTED_ACTIONS.includes(action)) throw problem('UNSUPPORTED', 'No real target-verified anonymous group operation is available');
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unknown group administration action');
    const isTag = ['get_group_tags', 'add_group_tag', 'delete_group_tag'].includes(action), isTodo = ['set_group_todo', 'complete_group_todo', 'cancel_group_todo'].includes(action),
        allowed = isTag ? ['group_class', ...(action === 'get_group_tags' ? [] : ['name'])] : isTodo ? ['group_id', 'message_id'] :
            action === 'get_group_share_link' ? ['group_id', 'need_short_url', 'src_id', 'additional_param'] : action === 'set_group_kick_members' ? ['group_id', 'user_id', 'reject_add_request'] :
                ['group_id', ...(OPTIONALS[action] || []).map(([name]) => name), ...(action === 'set_group_add_option' ? ['add_type'] : action === 'set_group_member_invite_policy' ? ['policy'] : action === 'set_group_new_member_history_visibility' ? ['visible'] : [])];
    fields(params, allowed);
    if (params.self_id !== undefined && group(params.self_id) !== String(state.self.uin)) throw problem('INVALID_PARAMS', 'self_id belongs to another account');
    if ([].concat(EXTENSION_REQUIREMENTS[action]).some(flag => state.capabilities?.[flag] !== true)) throw problem('UNSUPPORTED', 'This QQ session lacks the required group administration capability');
    const groupId = isTag ? null : group(params.group_id);
    if (action === 'get_group_admin_settings') {
        const response = await service.sessionCall(state, 'adminQuery', { operation: 'group.settings', groupId });
        if (response?.operation !== 'group.settings' || response.groupId !== groupId) throw problem('INVALID_RESPONSE', 'QQ returned settings for another group');
        const result = settings(response.settings); await service.assertSession(state); return result;
    }
    if (action === 'get_group_share_link') {
        const request = { operation: 'group.shareLink', groupId, needShortUrl: params.need_short_url === undefined ? true : protocol.bool(params.need_short_url),
            srcId: params.src_id === undefined ? 73 : integer(params.src_id, 'src_id'), additionalParam: protocol.text(params.additional_param === undefined ? '' : params.additional_param, 'additional_param') };
        const response = await service.sessionCall(state, 'adminQuery', request);
        if (!protocol.plain(response) || Object.keys(request).some(key => request[key] !== response[key])) throw problem('INVALID_RESPONSE', 'QQ returned a group share link for another request');
        const url = protocol.validateUrl(response.url); await service.assertSession(state); return { url };
    }
    if (isTag) {
        const groupClass = integer(params.group_class, 'group_class'), request = { operation: action === 'get_group_tags' ? 'group.tags' : action === 'add_group_tag' ? 'group.tagAdd' : 'group.tagDelete', groupClass };
        if (action !== 'get_group_tags') request.name = protocol.text(params.name, 'tag name', 1024, false);
        const response = await service.sessionCall(state, action === 'get_group_tags' ? 'adminQuery' : 'adminAction', request);
        if (action !== 'get_group_tags') { confirmation(response, request); return null; }
        if (!protocol.plain(response) || response.operation !== request.operation || response.groupClass !== groupClass || !Array.isArray(response.tags) || response.tags.length > 1000) throw problem('INVALID_RESPONSE', 'QQ returned tags for another group category');
        const seen = new Set(), tags = response.tags.map(tag => {
            if (!protocol.plain(tag) || typeof tag.id !== 'number' || typeof tag.type !== 'number' || typeof tag.name !== 'string' || !tag.name.length || Buffer.byteLength(tag.name) > 1024 || tag.name.includes('\0') ||
                ![tag.id, tag.type].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)) throw problem('INVALID_RESPONSE', 'QQ returned an invalid group category tag');
            const row = { id: tag.id, name: tag.name, type: tag.type }, identity = JSON.stringify(row);
            if (seen.has(identity)) throw problem('INVALID_RESPONSE', 'QQ repeated a category tag'); seen.add(identity); return row;
        });
        await service.assertSession(state); return { tags };
    }
    if (action === 'set_group_kick_members') {
        if (!Array.isArray(params.user_id) || !params.user_id.length || params.user_id.length > MAX_KICK_MEMBERS) throw problem('INVALID_PARAMS', 'Expected 1 to ' + MAX_KICK_MEMBERS + ' member accounts');
        for (let index = 0; index < params.user_id.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(params.user_id, String(index));
            if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw problem('INVALID_PARAMS', 'Batch member accounts must be ordinary dense data');
        }
        const users = params.user_id.map(group), reject = params.reject_add_request === undefined ? false : protocol.bool(params.reject_add_request);
        if (new Set(users).size !== users.length || users.includes(String(state.self.uin))) throw problem('INVALID_PARAMS', 'Batch member accounts must be unique and cannot include the authenticated account');
        const self = await service.sessionCall(state, 'groupMember', { groupId, uin: String(state.self.uin), refresh: true });
        if (self?.group_id !== Number(groupId) || self.user_id !== Number(state.self.uin) || !['admin', 'owner'].includes(self.role)) throw problem('UNSUPPORTED', 'The authenticated account cannot remove members from this group');
        // Validate the complete batch before its first mutation. Each mutation
        // still uses the existing single-member forced snapshot and readback.
        for (const uin of users) {
            const member = await service.sessionCall(state, 'groupMember', { groupId, uin, refresh: true });
            if (member?.group_id !== Number(groupId) || member.user_id !== Number(uin) || !['member', 'admin', 'owner'].includes(member.role)) throw problem('INVALID_RESPONSE', 'QQ returned another batch member identity');
            if (member.role === 'owner' || member.role === 'admin' && self.role !== 'owner') throw problem('UNSUPPORTED', 'This batch includes a member the authenticated account cannot remove');
        }
        let completed = 0;
        try {
            for (const uin of users) {
                await service.groupAction(state, { group_id: groupId, user_id: uin, reject_add_request: reject }, 'set_group_kick'); completed++;
            }
        } catch (error) {
            if (completed) throw problem('PARTIAL_RESULT', 'QQ confirmed ' + completed + ' of ' + users.length + ' requested member removals; the batch stopped and remaining targets were not attempted');
            throw error;
        }
        return null;
    }
    if (isTodo) {
        const id = short(params.message_id), entry = service.store.get(state.self.uin, id);
        if (!entry) throw problem('NOT_FOUND', 'Todo message_id is unknown to this account');
        if (entry.locator?.peer?.chatType !== 2 || entry.locator.peer.peerUid !== groupId) throw problem('INVALID_PARAMS', 'Todo message belongs to another conversation');
        const record = await service.record(state, id, { chatType: 2, peerUid: groupId }, { refresh: true }), where = locator(record), observed = [record.msgRandom, record.msg_random].filter(value => value !== undefined && value !== null);
        if (where.peer.chatType !== 2 || where.peer.peerUid !== groupId || !observed.length) throw problem('INVALID_RESPONSE', 'Todo message has no verified group sequence/random identity');
        const value = random(observed[0], 'INVALID_RESPONSE');
        if (observed.some(item => random(item, 'INVALID_RESPONSE') !== value)) throw problem('INVALID_RESPONSE', 'Todo message has conflicting random metadata');
        const request = { operation: action === 'set_group_todo' ? 'todo.set' : action === 'complete_group_todo' ? 'todo.complete' : 'todo.cancel', groupId,
            nativeId: protocol.uint(where.nativeId, 'native message identity', 0xffffffffffffffffn, 1n), sequence: protocol.uint(where.seq, 'message sequence', 0xffffffffffffffffn, 1n), random: value };
        confirmation(await service.sessionCall(state, 'adminAction', request), request); return null;
    }
    const operation = { set_group_add_option: 'group.addOption', set_group_search: 'group.search', set_group_robot_add_option: 'group.robotOption',
        set_group_member_invite_policy: 'group.invitePolicy', set_group_new_member_history_visibility: 'group.historyVisibility', set_group_member_permissions: 'group.permissions' }[action], request = { operation, groupId };
    for (const [from, to, kind] of OPTIONALS[action] || []) if (params[from] !== undefined) request[to] = kind === 'string' ? protocol.text(params[from], from) : kind === 'integer' ? integer(params[from], from) : protocol.bool(params[from]);
    if (action === 'set_group_add_option') request.addType = params.add_type === undefined ? 0 : integer(params.add_type, 'add_type');
    else if (action === 'set_group_member_invite_policy') { protocol.mergeInvite(0, params.policy); request.policy = params.policy; }
    else if (action === 'set_group_new_member_history_visibility') request.visible = protocol.bool(params.visible);
    else if (Object.keys(request).length === 2) throw problem('INVALID_PARAMS', 'At least one group setting must be specified');
    confirmation(await service.sessionCall(state, 'adminAction', request), request); return null;
}

module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, READ_ONLY_ACTIONS, UNSUPPORTED_ACTIONS, MAX_KICK_MEMBERS, runAdminActions };
