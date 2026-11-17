'use strict';

// This is an operational vocabulary, never a transport for native error text.
const REASONS = Object.freeze({
    action_unsupported: '接口尚未实现', version_unverified: '当前 QQ 版本尚未验证',
    runtime_profile_denied: '当前 QQ 版本未获准使用此运行配置', experimental_operation_disabled: '实验配置未开放此操作',
    native_profile_mismatch: '本机模块与当前 QQ 版本不匹配',
    capability_missing: '当前会话缺少所需能力', unsupported_element: '消息片段类型尚未支持',
    unsupported_mention: '提及类型尚未支持', unsupported_face: '特殊表情尚未支持',
    media_unavailable: '媒体资源暂不可读取', media_format_invalid: '媒体格式尚未支持',
    quote_unavailable: '原引用消息暂不可定位', invalid_structure: '消息结构未通过校验',
    invalid_identity: '消息身份未通过校验', event_session: '消息所属会话已经变化',
    protocol_response_invalid: 'QQ 返回结果未通过校验', business_rejected: 'QQ 拒绝本次请求',
    outcome_unknown: '操作结果尚未确认，请勿自动重试', partial_source_not_sendable: '不能将部分内容当作完整原文转发',
    partial_quick_operation: '部分消息不允许执行撤回或成员管理快捷操作'
});
const PHASES = new Set(['validate', 'convert', 'element_validate', 'element_convert', 'identity', 'session',
    'media_receive', 'media_parse', 'media_download', 'image_resolve', 'quote_lookup', 'forward_read',
    'forward_decode', 'synthesize', 'receipt', 'download', 'prepare', 'dispatch', 'quick_operation']);
const TYPES = new Set(['image', 'record', 'video', 'file']);
function safeDiagnostic(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    if (typeof value.reason === 'string' && Object.hasOwn(REASONS, value.reason)) result.reason = value.reason;
    if (PHASES.has(value.phase)) result.phase = value.phase;
    if (TYPES.has(value.mediaType)) result.mediaType = value.mediaType;
    for (const key of ['elementType', 'atType', 'faceType', 'wireType']) {
        if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 0x1fffffff) result[key] = value[key];
    }
    for (const key of ['elementIndex', 'nodeIndex']) {
        if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] < 1000) result[key] = value[key];
    }
    if (Number.isSafeInteger(value.businessCode) && value.businessCode >= -0x80000000 && value.businessCode <= 0xffffffff) result.businessCode = value.businessCode;
    if (typeof value.traceId === 'string' && /^[a-f0-9]{32}$/.test(value.traceId)) result.traceId = value.traceId;
    return result;
}
function defaultReason(code) {
    if (['NOT_READY', 'SESSION_CHANGED', 'ABORTED'].includes(code)) return 'event_session';
    if (['TIMEOUT', 'EXPIRED', 'PARTIAL_RESULT'].includes(code)) return 'outcome_unknown';
    if (['INVALID_RESPONSE', 'INVALID_EVENT'].includes(code)) return 'protocol_response_invalid';
    if (code === 'KERNEL_ERROR') return 'business_rejected';
    if (code === 'UNSUPPORTED') return 'capability_missing';
    return undefined;
}
function errorDiagnostics(error, defaults = {}) {
    return safeDiagnostic({ reason: defaultReason(error?.code), ...safeDiagnostic(defaults), ...safeDiagnostic(error?.diagnostic) });
}
function annotate(error, details) {
    if (!error || typeof error !== 'object') return error;
    error.diagnostic = errorDiagnostics(error, details);
    return error;
}
module.exports = { REASONS, safeDiagnostic, errorDiagnostics, annotate };
