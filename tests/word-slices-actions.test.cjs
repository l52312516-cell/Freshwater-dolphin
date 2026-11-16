'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { runWordSlices, wordSlices, parameters, MAX_CONTENT_BYTES } = require('../src/onebot/word-slices-actions.cjs');
test('local word segmentation preserves Chinese, Latin, emoji, punctuation and whitespace without QQ traffic', async () => {
    const state = { self: { uin: '12345' }, capabilities: { wordSlices: true } }; let checked = 0;
    const service = { async assertSession(value) { assert.equal(value, state); checked++; }, sessionCall() { throw new Error('Local text must never be sent to QQ'); } };
    for (const content of ['你好，世界！ Freshwater dolphin 123 👨‍👩‍👧‍👦\n', '', ' a\tb\r\n', '中文分词测试']) {
        const result = await runWordSlices(service, state, '.get_word_slices', { content, self_id: 12345 });
        assert.equal(result.slices.join(''), content); assert.equal(result.slices.every(value => typeof value === 'string' && value.length > 0), true);
    }
    const english = wordSlices('Freshwater dolphin'); assert.deepEqual(english.slices, ['Freshwater', ' ', 'dolphin']);
    assert.equal(checked, 4);
});
test('local segmentation closes parameters and enforces UTF-8 and byte budgets before work', () => {
    const getter = Object.defineProperty({}, 'content', { enumerable: true, get() { throw new Error('Accessor executed'); } });
    for (const input of [null, [], { content: 1 }, { content: 'x', url: 'https://example.com' }, { content: 'x', self_id: 99999 },
        { content: '\ud800' }, { content: 'x'.repeat(MAX_CONTENT_BYTES + 1) }, getter]) assert.throws(() => parameters(input, '12345'), { code: 'INVALID_PARAMS' });
    assert.equal(parameters({ content: 'x'.repeat(MAX_CONTENT_BYTES) }, '12345').length, MAX_CONTENT_BYTES);
});
test('missing segmenter, lossy results and a changed account never return successful slices', async () => {
    assert.throws(() => wordSlices('x', null), { code: 'UNSUPPORTED' });
    class Broken { segment() { return [{ segment: 'other' }]; } }
    assert.throws(() => wordSlices('x', Broken), { code: 'INVALID_RESPONSE' });
    const state = { self: { uin: '12345' }, capabilities: { wordSlices: true } };
    await assert.rejects(runWordSlices({ async assertSession() { throw Object.assign(new Error('changed'), { code: 'SESSION_CHANGED' }); } }, state, '.get_word_slices', { content: 'text' }), { code: 'SESSION_CHANGED' });
    await assert.rejects(runWordSlices({}, { ...state, capabilities: {} }, '.get_word_slices', { content: 'text' }), { code: 'UNSUPPORTED' });
});
