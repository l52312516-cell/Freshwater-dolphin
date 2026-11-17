'use strict';

// A catalogue is a compatibility inventory, not a claim that every entry works.
const { ACTION_REQUIREMENTS: GROUP_FILE_REQUIREMENTS } = require('./group-files.cjs');
const { STANDARD_REQUIREMENTS: EXTENDED_STANDARD, EXTENSION_REQUIREMENTS: EXTENDED_REQUIREMENTS } = require('./extended-actions.cjs');
const { REQUIREMENTS: GROUP_QUERY_REQUIREMENTS } = require('./group-queries.cjs');
const { ACTION_REQUIREMENTS: COLLECTION_REQUIREMENTS } = require('./collection-queries.cjs');
const { EXTENSION_REQUIREMENTS: ACCOUNT_QUERY_REQUIREMENTS } = require('./account-queries.cjs');
const { EXTENSION_REQUIREMENTS: COMPAT_REQUIREMENTS } = require('./compat-actions.cjs');
const { EXTENSION_REQUIREMENTS: QUERY2_REQUIREMENTS } = require('./extended-queries2.cjs');
const { EXTENSION_REQUIREMENTS: RKEY_REQUIREMENTS } = require('./rkey-actions.cjs');
const { EXTENSION_REQUIREMENTS: SHARE_REQUIREMENTS } = require('./share-actions.cjs');
const { EXTENSION_REQUIREMENTS: ADMIN_REQUIREMENTS } = require('./admin-actions.cjs');
const { EXTENSION_REQUIREMENTS: CUSTOM_FACE_REQUIREMENTS } = require('./custom-face-actions.cjs');
const { EXTENSION_REQUIREMENTS: EMOJI_PAGINATION_REQUIREMENTS } = require('./emoji-pagination-actions.cjs');
const { REQUIREMENTS: CONTACT_EXTRA_REQUIREMENTS } = require('./contact-extra-actions.cjs');
const { EXTENSION_REQUIREMENTS: SINGLE_FORWARD_REQUIREMENTS } = require('./single-forward-actions.cjs');
const { REQUIREMENTS: FLASH_REQUIREMENTS } = require('./flash-transfer-actions.cjs');
const { EXTENSION_REQUIREMENTS: QZONE_REQUIREMENTS } = require('./qzone-actions.cjs');
const { EXTENSION_REQUIREMENTS: GROUP_ALBUM_REQUIREMENTS } = require('./group-album-actions.cjs');
const { EXTENSION_REQUIREMENTS: MISC_EXTRA_REQUIREMENTS } = require('./misc-extra-actions.cjs');
const { REQUIREMENTS: STREAM_REQUIREMENTS } = require('./file-stream-actions.cjs');
const { EXTENSION_REQUIREMENTS: FRIEND_DRESS_REQUIREMENTS } = require('./friend-dress-actions.cjs');
const { REASONS: UNSUPPORTED_REASONS } = require('./unsupported-actions.cjs');
const { EXTENSION_REQUIREMENTS: FORWARD_EXTRA_REQUIREMENTS } = require('./forward-extra-actions.cjs');
const { EXTENSION_REQUIREMENTS: VOICE_EXTRA_REQUIREMENTS } = require('./voice-extra-actions.cjs');
const { EXTENSION_REQUIREMENTS: WORD_SLICE_REQUIREMENTS } = require('./word-slices-actions.cjs');
const { EXTENSION_REQUIREMENTS: RAW_PACKET_REQUIREMENTS } = require('./raw-packet-actions.cjs');
const { EXTENSION_REQUIREMENTS: AUTH_REQUIREMENTS } = require('./auth-extra-actions.cjs');
const { REQUIREMENTS: LIFECYCLE_REQUIREMENTS } = require('./lifecycle-actions.cjs');
const { EXTENSION_REQUIREMENTS: MODEL_SHOW_REQUIREMENTS } = require('./model-show-actions.cjs');
const { EXTENSION_REQUIREMENTS: URL_SAFETY_REQUIREMENTS } = require('./url-safety-actions.cjs');
const { EXTENSION_REQUIREMENTS: COLLECTION_CREATE_REQUIREMENTS } = require('./collection-create-actions.cjs');
const { EXTENSION_REQUIREMENTS: EMOJI_SUMMARY_REQUIREMENTS } = require('./emoji-summary-actions.cjs');
const { ACTION_REQUIREMENTS: ANONYMOUS_REQUIREMENTS } = require('./anonymous-actions.cjs');
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
    set_friend_add_request: 'friendRequests', set_group_add_request: 'groupRequests', send_like: 'profileLike',
    get_cookies: AUTH_REQUIREMENTS.get_cookies, get_csrf_token: AUTH_REQUIREMENTS.get_csrf_token,
    get_credentials: AUTH_REQUIREMENTS.get_credentials, set_restart: LIFECYCLE_REQUIREMENTS.set_restart, clean_cache: LIFECYCLE_REQUIREMENTS.clean_cache,
    ...ANONYMOUS_REQUIREMENTS
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
    send_private_forward_msg: 'mergeCustom', send_group_forward_msg: 'mergeCustom', ...GROUP_FILE_REQUIREMENTS, ...EXTENDED_REQUIREMENTS,
    ...GROUP_QUERY_REQUIREMENTS, ...COLLECTION_REQUIREMENTS, ...ACCOUNT_QUERY_REQUIREMENTS, ...COMPAT_REQUIREMENTS, ...QUERY2_REQUIREMENTS, ...RKEY_REQUIREMENTS, ...SHARE_REQUIREMENTS,
    ...ADMIN_REQUIREMENTS, ...CUSTOM_FACE_REQUIREMENTS, ...EMOJI_PAGINATION_REQUIREMENTS, ...CONTACT_EXTRA_REQUIREMENTS, ...SINGLE_FORWARD_REQUIREMENTS,
    ...FLASH_REQUIREMENTS, ...QZONE_REQUIREMENTS, ...GROUP_ALBUM_REQUIREMENTS, ...MISC_EXTRA_REQUIREMENTS, ...STREAM_REQUIREMENTS, ...FRIEND_DRESS_REQUIREMENTS, ...FORWARD_EXTRA_REQUIREMENTS, ...VOICE_EXTRA_REQUIREMENTS, ...WORD_SLICE_REQUIREMENTS, ...RAW_PACKET_REQUIREMENTS,
    get_clientkey: AUTH_REQUIREMENTS.get_clientkey, request_decrypt_key: AUTH_REQUIREMENTS.request_decrypt_key,
    bot_exit: LIFECYCLE_REQUIREMENTS.bot_exit, ...MODEL_SHOW_REQUIREMENTS, ...URL_SAFETY_REQUIREMENTS, ...COLLECTION_CREATE_REQUIREMENTS, ...EMOJI_SUMMARY_REQUIREMENTS });
const EXTENSION_ACTIONS = Object.freeze(Object.keys(EXTENSION_REQUIREMENTS));
const IMPLEMENTED_ACTIONS = new Set([...Object.keys(ACTION_REQUIREMENTS), ...EXTENSION_ACTIONS]);
// Diagnostics retain only fixed, recognized protocol names. Unknown strings
// can contain credentials and must never be copied into the operational log.
const KNOWN_ACTIONS = new Set([...STANDARD_ACTIONS, ...EXTENSION_ACTIONS,
    ...Object.keys(UNSUPPORTED_REASONS), 'send_group_forward_msg', 'send_private_forward_msg', 'send_forward_msg']);
const TARGET_VALIDATION = Object.freeze({
    get_private_file_url: ['received-private-file', 'original-uuid-and-checksum', '56041-byte-download'],
    qqapi_get_forward_messages: ['observed-group-forward', 'text-and-image', 'download-md5-checked']
});
const { evaluateRuntimeIdentity } = require('../qq/runtime-profile.cjs');

function capabilities(status = {}) {
    const flags = status.capabilities || {};
    const ready = Boolean(status.ready && status.self?.uin && status.self?.uid);
    const runtime = status.runtime_profile;
    const matched = runtime && evaluateRuntimeIdentity({ platform: runtime.platform, architecture: runtime.architecture,
        qqVersion: status.qqVersion, packageSha256: runtime.package_sha256, wrapperSha256: runtime.wrapper_sha256,
        profileId: runtime.profile_id, packageId: runtime.package_id, experimental: runtime.experimental });
    const exactEvidence = matched?.evidence === 'exact-build-history';
    const available = flag => Array.isArray(flag) ? flag.every(available) :
        flag === null || (flag === 'identity' ? ready : ready && flags[flag] === true);
    const entry = (name, implemented, flag, verified = false) => ({ name, implemented,
        available: implemented && (name === 'send_group_forward_msg' ? available(flag) || available('mergeExistingNative') :
            name === 'send_forward_msg' ? available(flag) || available('forwardUpload') : available(flag)),
        verification: verified ? 'verified' : implemented ? 'offline-tested' : 'unsupported',
        runtime_verification: exactEvidence && Object.hasOwn(TARGET_VALIDATION, name) ? 'historical-scope' : 'unverified',
        availability_basis: runtime?.admission === 'experimental-basic' ? 'experimental-methods' : 'session-methods',
        ...(implemented && runtime?.admission === 'denied' ? { reason: 'runtime_profile_denied' } : {}),
        ...(!implemented && UNSUPPORTED_REASONS[name] ? { reason: UNSUPPORTED_REASONS[name] } : {}),
        ...(name === 'send_group_forward_msg' ? { variants: { custom_text_image_nodes: available('mergeCustom'),
            existing_message_id_nodes: available('mergeExistingNative'), existing_scope: 'same-source-group-plain-text-1..20' } } : {}),
        ...(name === 'send_forward_msg' ? { variants: { targeted_text_image_nodes: available('mergeCustom'),
            upload_only_text_nodes: available('forwardUpload') } } : {}),
        ...(exactEvidence && Object.hasOwn(TARGET_VALIDATION, name) ? {
            target_validation: { qq_version: '3.2.35-54395', platform: 'linux-x64', date: '2026-11-16',
                scopes: [...TARGET_VALIDATION[name]], reference: 'docs/native-validation-20261116.md' }
        } : {}) });
    return {
        schema_version: 1, qq_version: status.qqVersion || null, ready,
        ...(runtime ? { runtime_profile: { ...runtime } } : {}),
        actions: STANDARD_ACTIONS.map(name => entry(name, Object.hasOwn(ACTION_REQUIREMENTS, name), ACTION_REQUIREMENTS[name])),
        extensions: [...EXTENSION_ACTIONS.map(name => entry(name, true, EXTENSION_REQUIREMENTS[name])),
            ...Object.keys(UNSUPPORTED_REASONS).filter(name => !STANDARD_ACTIONS.includes(name) && !IMPLEMENTED_ACTIONS.has(name)).map(name => entry(name, false, null))],
        segments: MESSAGE_SEGMENTS.map(name => ({ name,
            send: (runtime?.admission !== 'experimental-basic' || name === 'text') && ['text', 'at', 'reply', 'face', 'image', 'music', 'record', 'video'].includes(name) && available(name),
            receive: (['text', 'at', 'reply', 'face'].includes(name) && available(name)) || (['image', 'record', 'video', 'json'].includes(name) && available(name + 'Receive')) || (name === 'forward' && available('forwardRead')),
            implemented: ['text', 'at', 'reply', 'face', 'image', 'music', 'record', 'video', 'share', 'json', 'forward'].includes(name),
            ...(name === 'record' ? { receive_scope: !available('recordReceive') ? 'unavailable' :
                flags.recordReceiveDownload === true ? 'account-local-or-qq-downloader' : 'account-local-only' } : {}),
            runtime_verification: exactEvidence && ['text', 'at', 'reply'].includes(name) ? 'historical-scope' : 'unverified',
            verification: name === 'share' ? (exactEvidence ? 'target-rendering-failed' : 'unverified') : ['text', 'at', 'reply'].includes(name) ?
                (exactEvidence ? 'previous-target-validation' : 'unverified') : ['face', 'image', 'music', 'record', 'video', 'json', 'forward'].includes(name) ? 'offline-tested' : 'unsupported' })),
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
        notes: ['Availability checks the current session and method presence. Runtime business evidence is scoped to an exact guest OS, architecture, QQ build, package SHA256 and loaded wrapper SHA256; version numbers and a Windows host do not inherit Linux or other-build validation.',
            'Files and H.264 MP4 videos use single-segment sends. Canonical base64 voice/video/file inputs have a combined 10 MiB message limit, are validated and temporarily staged inside the account, then use the same native preparers. Share sending is disabled because target QQ clients could not render the fixed news template; its remaining generator is an offline experiment. Inbound Ark JSON retains validated data. Observed native merged forwards can be read; existing-message forwarding returns a kernel acknowledgment without a destination message ID. Custom merged sending accepts 1 to 100 text/base64-image nodes. Verified author identities and explicit uint32 second timestamps require mergeCustomMetadata; name/uin and nickname/user_id aliases are accepted, and time=0 uses the real QQ server time. Every successful send requires complete destination-resource readback. Image bodies are obtained through verified native self-chat staging. The native existing-ID merge variant is disabled on QQ 3.2.35-54395: real delivery was observed but callbacks omit a provable request-to-message correlation. Formal existing-ID requests fail before dispatch; custom text/image merging remains available. Voice export accepts account-observed resources; compressed formats require project FFmpeg. Generic JSON/XML sending and remote input URLs remain unavailable.',
            'Credential APIs return only current-account authenticated QQ tickets and fixed-domain cookies to authorized callers. Raw packets use the bounded correlated native queue. Packet statistics cover adapter-native SSO only. Reaction summaries use matching fresh message-record directories and complete user pages; unavailable last-reaction timestamps are null. Account exit/restart is asynchronously committed after the transport response; cache cleanup touches inactive registered stream files. Legacy model and anonymous protocols still require current QQ service validation.']
    };
}

module.exports = { STANDARD_ACTIONS, MESSAGE_SEGMENTS, EVENT_CATEGORIES, ACTION_REQUIREMENTS,
    EXTENSION_ACTIONS, IMPLEMENTED_ACTIONS, KNOWN_ACTIONS, capabilities };
