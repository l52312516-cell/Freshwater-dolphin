'use strict';

// A catalogue is a compatibility inventory, not a claim that every entry works.
const { ACTION_REQUIREMENTS: GROUP_FILE_REQUIREMENTS } = require('./group-files.cjs');
const { STANDARD_REQUIREMENTS: EXTENDED_STANDARD, EXTENSION_REQUIREMENTS: EXTENDED_REQUIREMENTS } = require('./extended-actions.cjs');
const STANDARD_ACTIONS = Object.freeze([
    'send_private_msg', 'send_group_msg', 'send_msg', 'delete_msg', 'get_msg', 'get_forward_msg',
    'send_like', 'set_group_kick', 'set_group_ban', 'set_group_anonymous_ban', 'set_group_whole_ban',
    'set_group_admin', 'set_group_anonymous', 'set_group_card', 'set_group_name', 'set_group_leave',
    'set_group_special_title', 'set_friend_add_request', 'set_group_add_request', 'get_login_info',
    'get_stranger_info', 'get_friend_list', 'get_group_info', 'get_group_list', 'get_group_member_info',
    'get_group_member_list', 'get_group_honor_info', 'get_cookies', 'get_csrf_token', 'get_credentials',
    'get_record', 'get_image', 'can_send_image', 'can_send_record', 'get_status', 'get_version_info',
    'set_restart', 'clean_cache'
]);
const MESSAGE_SEGMENTS = Object.freeze(['text', 'face', 'image', 'record', 'video', 'at', 'rps',
    'dice', 'shake', 'poke', 'anonymous', 'share', 'contact', 'location', 'music', 'reply', 'forward',
    'node', 'xml', 'json']);
const EVENT_CATEGORIES = Object.freeze(['message', 'notice', 'request', 'meta_event']);
const ACTION_REQUIREMENTS = Object.freeze({
    send_private_msg: 'text', send_group_msg: 'text', send_msg: 'text', delete_msg: 'recall',
    get_msg: 'reply', get_forward_msg: 'forwardRead', get_login_info: 'identity', get_stranger_info: 'user', get_friend_list: 'friends',
    get_group_info: 'groupInfo', get_group_list: 'groups', get_group_member_info: 'groupMember',
    get_group_member_list: 'groupMembers', get_status: null, get_version_info: null,
    can_send_image: null, can_send_record: null, get_image: 'imageReceive', get_record: 'recordExport', ...EXTENDED_STANDARD, set_group_name: 'groupName', set_group_ban: 'groupMemberBan',
    set_group_whole_ban: 'groupWholeBan', set_group_leave: 'groupLeave', set_group_card: 'groupCard', set_group_admin: 'groupAdmin', set_group_kick: 'groupKick',
    set_friend_add_request: 'friendRequests', set_group_add_request: 'groupRequests', send_like: 'profileLike'
});
const EXTENSION_REQUIREMENTS = Object.freeze({ get_capabilities: null, get_group_msg_history: 'history', get_friend_msg_history: 'history',
    upload_group_file: 'file', upload_private_file: 'file', set_friend_remark: 'friendRemark', get_friends_with_category: 'friendCategories',
    get_recent_contact: 'recentContacts', get_friend_requests: 'friendRequests', get_group_system_msg: 'groupRequests',
    mark_private_msg_as_read: 'markRead', mark_group_msg_as_read: 'markRead', mark_msg_as_read: 'markRead',
    get_group_at_all_remain: 'groupAtAllRemain', get_group_root_files: 'groupFiles',
    get_group_files_by_folder: 'groupFiles', get_group_file_info: 'groupFileInfo', get_group_file_url: 'groupFileUrl',
    get_group_file_system_info: 'groupFileSpace',
    get_private_file_url: 'privateFileUrl',
    set_qq_profile: 'selfProfile', set_group_remark: 'groupRemark',
    qqapi_get_forward_messages: 'forwardRead', qqapi_message_forward: 'forwardExisting',
    send_private_forward_msg: 'mergeCustom', send_group_forward_msg: 'mergeCustom', ...GROUP_FILE_REQUIREMENTS, ...EXTENDED_REQUIREMENTS });
const EXTENSION_ACTIONS = Object.freeze(Object.keys(EXTENSION_REQUIREMENTS));
const IMPLEMENTED_ACTIONS = new Set([...Object.keys(ACTION_REQUIREMENTS), ...EXTENSION_ACTIONS]);
// Diagnostics retain only fixed, recognized protocol names. Unknown strings
// can contain credentials and must never be copied into the operational log.
const KNOWN_ACTIONS = new Set([...STANDARD_ACTIONS, ...EXTENSION_ACTIONS,
    'send_group_forward_msg', 'send_private_forward_msg', 'send_forward_msg']);
const TARGET_VALIDATION = Object.freeze({
    get_private_file_url: ['received-private-file', 'original-uuid-and-checksum', '56041-byte-download'],
    qqapi_get_forward_messages: ['observed-group-forward', 'text-and-image', 'download-md5-checked']
});

function capabilities(status = {}) {
    const flags = status.capabilities || {};
    const ready = Boolean(status.ready && status.self?.uin && status.self?.uid);
    const available = flag => flag === null || (flag === 'identity' ? ready : ready && flags[flag] === true);
    const entry = (name, implemented, flag, verified = false) => ({ name, implemented,
        available: implemented && (name === 'send_group_forward_msg' ? available(flag) || available('mergeExistingNative') : available(flag)),
        verification: verified ? 'verified' : implemented ? 'offline-tested' : 'unsupported',
        ...(name === 'send_group_forward_msg' ? { variants: { custom_text_image_nodes: available('mergeCustom'),
            existing_message_id_nodes: available('mergeExistingNative'), existing_scope: 'same-source-group-plain-text-1..20' } } : {}),
        ...(status.qqVersion === '3.2.35-54395' && Object.hasOwn(TARGET_VALIDATION, name) ? {
            target_validation: { qq_version: '3.2.35-54395', platform: 'linux-x64', date: '2026-11-16',
                scopes: [...TARGET_VALIDATION[name]], reference: 'docs/native-validation-20261116.md' }
        } : {}) });
    return {
        schema_version: 1, qq_version: status.qqVersion || null, ready,
        actions: STANDARD_ACTIONS.map(name => entry(name, Object.hasOwn(ACTION_REQUIREMENTS, name), ACTION_REQUIREMENTS[name])),
        extensions: EXTENSION_ACTIONS.map(name => entry(name, true, EXTENSION_REQUIREMENTS[name])),
        segments: MESSAGE_SEGMENTS.map(name => ({ name,
            send: ['text', 'at', 'reply', 'face', 'image', 'music', 'record', 'video'].includes(name) && available(name),
            receive: (['text', 'at', 'reply', 'face'].includes(name) && available(name)) || (['image', 'record', 'video', 'json'].includes(name) && available(name + 'Receive')) || (name === 'forward' && available('forwardRead')),
            implemented: ['text', 'at', 'reply', 'face', 'image', 'music', 'record', 'video', 'share', 'json', 'forward'].includes(name),
            ...(name === 'record' ? { receive_scope: !available('recordReceive') ? 'unavailable' :
                flags.recordReceiveDownload === true ? 'account-local-or-qq-downloader' : 'account-local-only' } : {}),
            verification: name === 'share' ? 'target-rendering-failed' : ['text', 'at', 'reply'].includes(name) ? 'previous-target-validation' : ['face', 'image', 'music', 'record', 'video', 'json', 'forward'].includes(name) ? 'offline-tested' : 'unsupported' })),
        segment_extensions: [{ name: 'file', send: available('file'), receive: available('groupFileUrl') || available('privateFileUrl'),
            send_contexts: ['private', 'group'], receive_contexts: [
                ...(available('privateFileUrl') ? ['private'] : []), ...(available('groupFileUrl') ? ['group'] : [])],
            implemented: true, verification: 'offline-tested' }],
        events: EVENT_CATEGORIES.map(name => ({ name,
            implemented: true, available: name === 'meta_event' ||
                (name === 'message' && ready && flags.messages === true) || (name === 'notice' && ready && (flags.recallNotice === true || flags.pokeNotice === true)) ||
                (name === 'request' && ready && (flags.friendRequests === true || flags.groupRequests === true)),
            subtypes: name === 'message' ? ['private', 'group'] : name === 'notice' ? ['friend_recall', 'group_recall', 'notify.poke'] :
                name === 'meta_event' ? ['lifecycle', 'heartbeat'] : ['friend', 'group'] })),
        notes: ['Availability checks the current session and method presence; new kernel operations still require target QQ validation.',
            'Files and H.264 MP4 videos use single-segment sends. Canonical base64 voice/video/file inputs have a combined 10 MiB message limit, are validated and temporarily staged inside the account, then use the same native preparers. Share sending is disabled because target QQ clients could not render the fixed news template; its remaining generator is an offline experiment. Inbound Ark JSON retains validated data. Observed native merged forwards can be read; existing-message forwarding returns a kernel acknowledgment without a destination message ID. Custom merged sending accepts 1 to 100 self-authored text/base64-image nodes, stages fresh self-chat messages and requires complete destination-resource readback. The native existing-ID merge variant is disabled on QQ 3.2.35-54395: real delivery was observed but callbacks omit a provable request-to-message correlation. Formal existing-ID requests fail before dispatch; custom text/image merging remains available. Voice export accepts account-observed resources; compressed formats require project FFmpeg. Generic JSON/XML sending and remote input URLs remain unavailable.',
            'Group names, cards, administrator roles, member bans, whole-group bans, confirmed member removal and leaving are implemented; social requests use expiring account-session flags. Fixed poke/reaction/essence/category/notice/honor/title actions require their own current-session capabilities and verified acknowledgments; unavailable native contracts stay disabled. Credential APIs remain unavailable.']
    };
}

module.exports = { STANDARD_ACTIONS, MESSAGE_SEGMENTS, EVENT_CATEGORIES, ACTION_REQUIREMENTS,
    EXTENSION_ACTIONS, IMPLEMENTED_ACTIONS, KNOWN_ACTIONS, capabilities };
