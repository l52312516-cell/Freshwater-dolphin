'use strict';

// Local ICU word boundaries provide this text utility without sending the
// caller's text to QQ or inventing a server-side segmentation acknowledgement.
const ACTIONS = new Set(['.get_word_slices']);
const EXTENSION_REQUIREMENTS = Object.freeze({ '.get_word_slices': 'wordSlices' });
const MAX_CONTENT_BYTES = 65536, MAX_SLICES = 65536;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function parameters(value, self) {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
        Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['content', 'self_id'].includes(key) ||
            !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('INVALID_PARAMS', 'Unexpected word segmentation parameters');
    if (value.self_id !== undefined && (!/^[1-9]\d{0,9}$/.test(String(value.self_id)) || String(value.self_id) !== String(self))) fail('INVALID_PARAMS', 'Word segmentation self_id belongs to another account');
    if (typeof value.content !== 'string' || Buffer.byteLength(value.content) > MAX_CONTENT_BYTES ||
        Buffer.from(value.content).toString('utf8') !== value.content) fail('INVALID_PARAMS', 'Word segmentation requires bounded valid UTF-8 content');
    return value.content;
}
function wordSlices(content, Segmenter = globalThis.Intl?.Segmenter) {
    if (typeof Segmenter !== 'function') fail('UNSUPPORTED', 'The local ICU word segmenter is unavailable');
    const slices = [];
    for (const part of new Segmenter('zh-CN', { granularity: 'word' }).segment(content)) {
        if (!part || typeof part.segment !== 'string' || !part.segment || slices.length >= MAX_SLICES) fail('INVALID_RESPONSE', 'The local word segmenter returned an invalid bounded result');
        // Retain punctuation and whitespace so text is never silently dropped.
        slices.push(part.segment);
    }
    if (slices.join('') !== content) fail('INVALID_RESPONSE', 'Local word segmentation did not preserve the complete input');
    return { slices };
}
async function runWordSlices(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown word segmentation action');
    const content = parameters(params, state.self?.uin);
    if (state.capabilities?.wordSlices !== true) fail('UNSUPPORTED', 'The current runtime lacks local word segmentation');
    const result = wordSlices(content);
    await service.assertSession(state);
    return result;
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, runWordSlices, wordSlices, parameters, MAX_CONTENT_BYTES, MAX_SLICES };
