'use strict';

const { safeDiagnostic } = require('../diagnostics.cjs');
const MAX_ISSUES = 32;
const CONTENT_REASONS = new Set(['unsupported_element', 'unsupported_mention', 'unsupported_face',
    'media_unavailable', 'media_format_invalid', 'quote_unavailable']);
function issue(details) {
    const safe = safeDiagnostic(details);
    if (!CONTENT_REASONS.has(safe.reason) || safe.elementIndex === undefined || safe.elementType === undefined) return null;
    return { element_index: safe.elementIndex, element_type: safe.elementType, reason: safe.reason,
        ...(safe.mediaType ? { media_type: safe.mediaType } : {}),
        ...(safe.atType !== undefined ? { at_type: safe.atType } : {}),
        ...(safe.faceType !== undefined ? { face_type: safe.faceType } : {}),
        ...(safe.wireType !== undefined ? { wire_type: safe.wireType } : {}),
        ...(safe.nodeIndex !== undefined ? { node_index: safe.nodeIndex } : {}) };
}
function metadata(issues) {
    const safe = Array.isArray(issues) ? issues.filter(Boolean) : [];
    if (!safe.length) return undefined;
    // Revalidate at every output boundary; no arbitrary native fields survive.
    const validated = safe.map(item => issue({ reason: item.reason, elementIndex: item.element_index,
        elementType: item.element_type, mediaType: item.media_type, atType: item.at_type, faceType: item.face_type,
        wireType: item.wire_type, nodeIndex: item.node_index })).filter(Boolean);
    if (!validated.length) return undefined;
    return { schema: 1, content_status: 'partial', issue_count: validated.length, issues: validated.slice(0, MAX_ISSUES) };
}
function isPartial(value) { return value?._freshwater?.content_status === 'partial'; }
function placeholder(details) {
    const labels = { unsupported_mention: '暂不支持的QQ提及', unsupported_face: '暂不支持的QQ表情',
        media_unavailable: 'QQ媒体暂不可读取', media_format_invalid: '暂不支持的QQ媒体格式', quote_unavailable: 'QQ引用消息暂不可定位' };
    const kind = details.wireType !== undefined ? '协议字段' + details.wireType : '类型' + details.elementType;
    return { type: 'text', data: { text: '[' + (labels[details.reason] || '暂不支持的QQ消息片段') + '：' + kind + ']' } };
}
module.exports = { MAX_ISSUES, CONTENT_REASONS, issue, metadata, isPartial, placeholder };
