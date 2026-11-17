'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMergedNodes, existingNodeIds, MAX_NODES, MAX_SEGMENTS, MAX_TEXT_BYTES, MAX_NAME_BYTES, MAX_IMAGE_BYTES } = require('../src/onebot/merged-nodes.cjs');

const SELF = '1000000001';
const PNG = 'base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const text = value => ({ type: 'text', data: { text: value } });
const image = (file = PNG) => ({ type: 'image', data: { file } });
const node = (content = [text('test')], data = {}) => ({ type: 'node', data: { user_id: SELF, nickname: '延迟检测机器人', content, ...data } });
const normalize = messages => normalizeMergedNodes(messages, { selfId: SELF });
const rejects = (input, code = 'INVALID_PARAMS') => assert.throws(() => normalize(input), error => { assert.equal(error.code, code, error.stack); return true; });

test('AstrBot default thirty mixed custom nodes preserve authors, display names, order and complete content', () => {
    const messages = [];
    for (let index = 1; index <= 15; index++) {
        messages.push(node([text('  📝 文本测试' + index + '\n ')]));
        messages.push(node([image(), text('🖼 图片测试' + index)]));
    }
    const output = normalize(messages);
    assert.equal(output.length, 30);
    for (let index = 0; index < output.length; index++) {
        assert.equal(output[index].user_id, SELF);
        assert.equal(output[index].nickname, messages[index].data.nickname);
        assert.deepEqual(output[index].content, messages[index].data.content);
    }
});

test('canonical and legacy aliases normalize without silently changing conflicting identities or names', () => {
    const legacy = { type: 'node', data: { uin: Number(SELF), name: '  📊 汇总  ', content: [text(' a\n\nb ')] } };
    assert.deepEqual(normalize([legacy]), [{ user_id: SELF, nickname: '  📊 汇总  ', content: [text(' a\n\nb ')] }]);
    assert.equal(normalize([node(undefined, { uin: Number(SELF), name: '延迟检测机器人' })])[0].user_id, SELF);
    rejects([node(undefined, { uin: '3000000002' })]);
    rejects([node(undefined, { name: 'different' })]);
    rejects([node(undefined, { nickname: ' name ', name: 'name' })]);
});

test('CQ strings use ordinary escaping while preserving raw text array contents', () => {
    const source = ' a&amp;b&#91;literal&#93;\n[CQ:image,file=' + PNG + ',summary=left&#44;right] tail ';
    assert.deepEqual(normalize([node(source)])[0].content, [text(' a&b[literal]\n'),
        { type: 'image', data: { file: PNG, summary: 'left,right' } }, text(' tail ')]);
    const literal = '  [CQ:at,qq=all] &amp; \n';
    assert.equal(normalize([node([text(literal)])])[0].content[0].data.text, literal);
    rejects([node('[CQ:image,file=' + PNG + ',cache=0]')], 'UNSUPPORTED');
    rejects([node('[CQ:image,file=' + PNG + ',file=' + PNG + ']')]);
    rejects([node('[CQ:at,qq=all]')], 'UNSUPPORTED');
});

test('a verified self account remains required while exact custom uint32 authors are preserved', () => {
    assert.throws(() => normalizeMergedNodes([node()]), { code: 'NOT_READY' });
    assert.throws(() => normalizeMergedNodes([node()], {}), { code: 'NOT_READY' });
    for (const user_id of [1, '3000000002', 4294967295, '4294967295']) {
        assert.equal(normalize([node(undefined, { user_id })])[0].user_id, String(user_id));
    }
    assert.equal(normalize([{ type: 'node', data: { uin: 3000000002, name: '原作者', content: [text('same')] } }])[0].user_id, '3000000002');
    for (const user_id of ['', 0, -1, 1.5, 4294967296, '4294967296', '01000000001', '+1000000001', '1000000001 ', '9e8', 9007199254740992, '9007199254740992', {}, null]) {
        rejects([node(undefined, { user_id })]);
    }
    for (const selfId of ['', 0, '4294967296', '01', {}, null]) {
        assert.throws(() => normalizeMergedNodes([node()], { selfId }), { code: 'INVALID_PARAMS' });
    }
    assert.equal(normalize([node(undefined, { user_id: '3000000002', uin: 3000000002 })])[0].user_id, '3000000002');
    const missing = node(); delete missing.data.user_id; rejects([missing]);
});

test('optional node times preserve zero and positive uint32 seconds as numbers without inventing missing times', () => {
    assert.equal(Object.hasOwn(normalize([node()])[0], 'time'), false);
    for (const time of [0, '0', 1, '1', 1794614400, '1794614400', 4294967295, '4294967295']) {
        const output = normalize([node(undefined, { user_id: '3000000002', time })])[0];
        assert.equal(output.time, Number(time));
        assert.equal(typeof output.time, 'number');
        assert.equal(output.user_id, '3000000002');
    }
    for (const time of [undefined, null, false, true, '', ' ', '01', '+1', '-0', '1 ', '1.0', '1e3', '0x10', -1, 1.5,
        NaN, Infinity, 4294967296, '4294967296', 9007199254740992, '9007199254740992', {}, []]) {
        rejects([node(undefined, { time })]);
    }
});

test('existing-node detection recognizes custom times but never accepts metadata on an ID node', () => {
    assert.equal(existingNodeIds([node(undefined, { user_id: '3000000002', time: '0' })]), null);
    assert.deepEqual(existingNodeIds([{ type: 'node', data: { id: -1 } }, { type: 'node', data: { id: '2' } }]), [-1, 2]);
    for (const [key, value] of Object.entries({ time: 0, user_id: SELF, uin: SELF, nickname: '原作者', name: '原作者', content: [text('same')] })) {
        assert.throws(() => existingNodeIds([{ type: 'node', data: { id: 1, [key]: value } }]), { code: 'INVALID_PARAMS' });
    }
    assert.throws(() => existingNodeIds([{ type: 'node', data: { id: 1 } }, node(undefined, { time: 0 })]), { code: 'UNSUPPORTED' });
});

test('count and aggregate segment bounds permit useful reports without splitting oversized requests', () => {
    assert.equal(normalize(Array.from({ length: MAX_NODES }, () => node())).length, MAX_NODES);
    rejects([]); rejects(Array.from({ length: MAX_NODES + 1 }, () => node()));
    const half = Array.from({ length: MAX_SEGMENTS / 2 }, () => text('x'));
    assert.equal(normalize([node(half), node(half)])[1].content.length, half.length);
    rejects([node(half), node([...half, text('x')])]);
    rejects([node([])]); rejects([node([text('')])]);
});

test('global text bytes include every node and respect UTF-8 rather than character count', () => {
    const half = 'x'.repeat(MAX_TEXT_BYTES / 2);
    assert.equal(normalize([node([text(half)]), node([text(half)])]).length, 2);
    rejects([node([text(half)]), node([text(half + 'x')])]);
    const wide = '海'.repeat(Math.floor(MAX_TEXT_BYTES / 3));
    assert.equal(normalize([node([text(wide)])])[0].content[0].data.text, wide);
    rejects([node([text(wide + '海')])]);
});

test('global decoded image bytes cannot reset at node boundaries or use encoding padding to bypass limits', () => {
    const half = Buffer.alloc(MAX_IMAGE_BYTES / 2);
    Buffer.from(PNG.slice(9), 'base64').copy(half);
    const source = 'base64://' + half.toString('base64');
    assert.equal(normalize([node([image(source)]), node([image(source)])]).length, 2);
    rejects([node([image(source)]), node([image(source), image()])]);
    rejects([node([image('base64://' + 'A'.repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3)))])]);
});

test('image validation reuses canonical actual-image checks without trusting a prefix or filename', () => {
    for (const file of ['base64://', 'base64://A', 'base64://AA=', 'base64://AA===', PNG + '\n',
        'base64://A A=', 'base64://AA-_', 'base64://Zh==', 'base64://Zm9=']) rejects([node([image(file)])]);
    rejects([node([image('base64://' + Buffer.from('not an image').toString('base64'))])], 'UNSUPPORTED');
    for (const file of ['pixel.png', '../pixel.png', 'E:\\private\\pixel.png', '/etc/passwd',
        'file:///private.png', 'https://example.test/image.png', 'http://127.0.0.1/private', 'data:image/png;base64,AAAA', 'BASE64://AAAA']) {
        rejects([node([image(file)])], 'UNSUPPORTED');
    }
});

test('PNG, JPEG and GIF validation follows the existing image contract and preserves explicit summaries', () => {
    const gif = 'base64://R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const jpeg = Buffer.from([255, 216, 255, 192, 0, 8, 8, 0, 1, 0, 1, 0, 255, 217]);
    const segments = [image(), image(gif), image('base64://' + jpeg.toString('base64'))];
    segments[0].data.type = 'image'; segments[0].data.summary = '  图片\n摘要  ';
    const output = normalize([node(segments)])[0].content;
    assert.equal(output[0].data.summary, '  图片\n摘要  ');
    assert.equal(output[0].data.type, undefined);
    assert.equal(output[1].data.file, gif);
    assert.equal(output[2].data.file, segments[2].data.file);
    rejects([node([{ type: 'image', data: { file: PNG, type: 'flash' } }])], 'UNSUPPORTED');
    rejects([node([{ type: 'image', data: { file: PNG, summary: 'x'.repeat(1025) } }])]);
});

test('node ID references, nested forwards and every unsupported message segment fail as a whole', () => {
    rejects([{ type: 'node', data: { id: 1 } }], 'UNSUPPORTED');
    rejects([node(undefined, { id: 1 })], 'UNSUPPORTED');
    for (const type of ['node', 'forward', 'at', 'reply', 'face', 'record', 'video', 'file', 'music', 'json', 'xml', 'unknown']) {
        rejects([node([text('valid first')]), node([{ type, data: {} }])], 'UNSUPPORTED');
    }
    rejects([{ type: 'forward', data: { id: 'fwd_handle' } }], 'UNSUPPORTED');
    rejects([node([{ type: 'image', data: { file: PNG, url: 'https://example.test/' } }])], 'UNSUPPORTED');
    rejects([node([{ type: 'text', data: { text: 'allowed', raw: 'ignored?' } }])], 'UNSUPPORTED');
});

test('display names are bounded but meaningful whitespace and Unicode are not rewritten', () => {
    assert.equal(normalize([node(undefined, { nickname: '  海豚 🐬  ' })])[0].nickname, '  海豚 🐬  ');
    assert.equal(normalize([node(undefined, { nickname: 'x'.repeat(MAX_NAME_BYTES) })])[0].nickname.length, MAX_NAME_BYTES);
    for (const nickname of ['', '  ', 'x'.repeat(MAX_NAME_BYTES + 1), 'bad\0name', 'bad\nname', 123, null]) rejects([node(undefined, { nickname })]);
});

test('normalization owns its results, leaves frozen inputs unchanged and preserves equal messages separately', () => {
    const source = node([text('same'), image()]);
    Object.freeze(source.data.content[0].data); Object.freeze(source.data.content[0]);
    Object.freeze(source.data.content[1].data); Object.freeze(source.data.content[1]);
    Object.freeze(source.data.content); Object.freeze(source.data); Object.freeze(source);
    const input = Object.freeze([source, source]);
    const result = normalize(input);
    assert.equal(result.length, 2);
    assert.notEqual(result[0], result[1]); assert.notEqual(result[0].content, result[1].content);
    result[0].content[0].data.text = 'changed';
    assert.equal(source.data.content[0].data.text, 'same');
    assert.equal(result[1].content[0].data.text, 'same');
});

test('non-JSON objects, symbols, accessors, proxies and sparse arrays are rejected without executing user code', () => {
    let executed = 0;
    const accessor = node(); Object.defineProperty(accessor.data, 'nickname', { enumerable: true, get() { executed++; return 'unsafe'; } });
    rejects([accessor]);
    const proxy = new Proxy(node(), { get() { executed++; throw new Error('must not execute'); }, ownKeys() { executed++; throw new Error('must not execute'); } });
    rejects([proxy]);
    const sparse = []; sparse.length = 1; rejects(sparse);
    const arrayAccessor = [node()]; Object.defineProperty(arrayAccessor, 0, { enumerable: true, get() { executed++; return node(); } }); rejects(arrayAccessor);
    const extra = [node()]; extra.execute = () => executed++; rejects(extra);
    const symbol = node(); symbol.data[Symbol('private')] = true; rejects([symbol]);
    const inherited = Object.create({ user_id: SELF }); inherited.nickname = 'unsafe'; inherited.content = [text('text')];
    rejects([{ type: 'node', data: inherited }]);
    for (const value of [null, {}, new Date(), Buffer.from('data'), () => executed++]) rejects(value);
    assert.equal(executed, 0);
    assert.equal(Object.prototype.polluted, undefined);
});

test('prototype-pollution keys and hidden execution hooks are never copied or called', () => {
    let executed = 0;
    for (const key of ['__proto__', 'constructor', 'prototype', 'toJSON', 'toString']) {
        const value = node();
        Object.defineProperty(value.data, key, { enumerable: true, value: key === 'toJSON' || key === 'toString' ? () => executed++ : { polluted: true } });
        rejects([value], 'UNSUPPORTED');
    }
    const options = {};
    Object.defineProperty(options, 'selfId', { enumerable: true, get() { executed++; return SELF; } });
    assert.throws(() => normalizeMergedNodes([node()], options), { code: 'INVALID_PARAMS' });
    const hidden = node(); Object.defineProperty(hidden.data, 'content', { enumerable: false, value: [text('hidden')] }); rejects([hidden]);
    const loop = node(); loop.data.content = [loop]; rejects([loop], 'UNSUPPORTED');
    assert.equal(executed, 0);
    assert.equal(Object.prototype.polluted, undefined);
});

test('plain JSON dictionaries with null prototypes are accepted without retaining their objects', () => {
    const data = Object.assign(Object.create(null), { user_id: SELF, nickname: '报告', content: [text('  中文\n ')] });
    const wrapper = Object.assign(Object.create(null), { type: 'node', data });
    assert.deepEqual(normalize([wrapper]), [{ user_id: SELF, nickname: '报告', content: [text('  中文\n ')] }]);
    assert.equal(Object.getPrototypeOf(data), null);
});

test('validation never invokes filesystem, network, process or native operations even when the last node fails', t => {
    let calls = 0;
    const forbidden = () => { calls++; throw new Error('preflight performed an external operation'); };
    const fs = require('node:fs'), child = require('node:child_process'), net = require('node:net');
    for (const name of ['readFileSync', 'writeFileSync', 'openSync', 'mkdirSync', 'unlinkSync', 'rmSync']) t.mock.method(fs, name, forbidden);
    for (const name of ['spawn', 'execFile', 'execSync']) t.mock.method(child, name, forbidden);
    t.mock.method(net, 'connect', forbidden); t.mock.method(globalThis, 'fetch', forbidden); t.mock.method(process, 'dlopen', forbidden);
    assert.equal(normalize([node([image(), text('valid')])]).length, 1);
    rejects([...Array.from({ length: 29 }, () => node([image(), text('valid')])), node([{ type: 'video', data: {} }])], 'UNSUPPORTED');
    rejects([node([image(PNG.slice(0, -4) + '%%%%')])]);
    assert.equal(calls, 0);
});
