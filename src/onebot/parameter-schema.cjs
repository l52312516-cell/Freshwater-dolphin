'use strict';

// HTTP has string values; JSON/WS already carry typed values. Keep one explicit
// schema so opaque flags, message text and 64-bit IDs never undergo inference.
const HTTP_PARAMETER_TYPES = Object.freeze(Object.fromEntries([
    ...['self_id', 'user_id', 'group_id', 'message_id', 'message_seq', 'duration', 'times', 'delay', 'count', 'font',
        'cache', 'proxy', 'timeout', 'file_size', 'busid', 'start_index', 'category_id', 'page', 'page_start', 'chat_type', 'face_id',
        'status', 'ext_status', 'battery_status', 'category', 'start', 'uin', 'categoryId', 'group_class', 'add_type',
        'no_finger_open', 'no_code_finger_open', 'robot_member_switch', 'robot_member_examine', 'src_id', 'reply_to', 'event_type', 'file_index',
        'face_type', 'bot_appid', 'msg_seq', 'target_uin', 'page_num', 'num', 'ugc_right', 'comment_uin', 'reply_uin',
        'chunk_index', 'total_chunks', 'file_retention', 'chunk_size'].map(key => [key, 'integer']),
    ...['auto_escape', 'no_cache', 'approve', 'enable', 'reject_add_request', 'is_dismiss', 'reverse_order',
        'reverseOrder', 'reverse', 'asface', 'isSet', 'is_set', 'set', 'block', 'both', 'refresh', 'visible', 'need_short_url',
        'allow_member_upload_album', 'allow_member_temporary_session', 'allow_member_create_group', 'is_complete', 'reset', 'verify_only', 'error', 'rsp'].map(key => [key, 'boolean']),
    ...['messages', 'message_ids', 'files', 'words', 'target_uins', 'images'].map(key => [key, 'array']),
    ...['context', 'operation', 'anonymous', 'params', 'headers'].map(key => [key, 'object']),
    ['message', 'message'], ['echo', 'json']
]));

function decodeHttpParameter(key, value, action) {
    const type = action === 'set_group_kick_members' && key === 'user_id' ? 'array' : HTTP_PARAMETER_TYPES[key];
    if (type === 'integer') return /^-?(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value;
    if (type === 'boolean') return value === 'true' ? true : value === 'false' ? false : value;
    if (!['array', 'object', 'message', 'json'].includes(type) || type === 'message' && !value.startsWith('[')) return value;
    try {
        const parsed = JSON.parse(value);
        if (type === 'array' && !Array.isArray(parsed) || type === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) return value;
        return parsed;
    } catch { return value; }
}

module.exports = { HTTP_PARAMETER_TYPES, decodeHttpParameter };
