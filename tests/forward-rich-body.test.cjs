'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../src/qq/proto.cjs');
const rich = require('../src/qq/forward-rich-body.cjs');
const { elementsSignature } = require('../src/qq/merged-send.cjs');
const codec = require('../src/onebot/codec.cjs');
const n = p.varintField, b = p.bytesField, s = (field, text) => b(field, Buffer.from(text, 'utf8'));
const join = (...parts) => Buffer.concat(parts);
const body = (...elements) => b(1, join(...elements.map(element => b(2, element))));
const text = content => b(1, s(1, content));
const MD5 = 'abcdef1234567890abcdef1234567890';
const URL_PATH = '/download?appid=1407&fileid=synthetic-image-resource';
const URL_PARAM = '&spec=0';
const FLAGS = b(37, b(19, join(n(85, 1), b(109, join(n(1, 1), b(4, Buffer.alloc(8, 1)))))));
function image(options = {}) {
    const reserve = join(n(1, 0), n(3, 0), n(4, 0), s(8, ''), n(10, 0), s(12, ''), s(18, ''), s(19, ''),
        b(20, join(n(1, 0), s(2, ''), n(3, 0), n(4, 0), n(5, 0), s(7, ''))),
        s(30, '/synthetic-compatibility-locator'), s(31, ''), n(34, 0));
    const fileType = join(n(1, 1), n(2, options.format ?? 1001), n(3, 0), n(4, 0));
    const file = join(n(1, options.size ?? 70), s(2, options.md5 ?? MD5.toUpperCase()), s(3, 'b'.repeat(40)),
        s(4, 'actual-file.png'), b(5, fileType), n(6, options.width ?? 1), n(7, options.height ?? 1), n(8, 0), n(9, 1));
    const index = join(b(1, file), s(2, 'actual-wire-file-uuid'), n(3, 1), n(4, 1700000001), n(5, 1800000001), n(6, 0));
    const pic = join(s(1, options.path ?? URL_PATH), b(2, join(s(1, options.param ?? URL_PARAM), s(2, '&spec=720'), s(3, '&spec=198'))),
        s(3, options.domain ?? 'multimedia.nt.qq.com.cn'));
    const mediaBody = join(b(1, index), b(2, pic), n(5, 1), b(6, b(2, Buffer.alloc(20, 2))));
    const extPic = join(n(1, 0), s(2, options.summary ?? ''), b(11, reserve), n(1001, 1), n(1002, 2), n(1003, 1234567890));
    const ext = join(b(1, extPic), b(2, b(3, Buffer.alloc(0))), b(3, join(b(11, Buffer.alloc(0)), b(12, Buffer.alloc(0)))),
        b(4, b(1, Buffer.alloc(0))), n(10, 0));
    return b(53, join(n(1, 48), b(2, join(b(1, mediaBody), b(2, ext))), n(3, options.business ?? 20)));
}
function encode(map) {
    return join(...[...map].flatMap(([field, values]) => values.map(entry => entry.wire === 0 ? n(field, entry.value) :
        entry.wire === 2 ? b(field, entry.value) : join(p.varint(BigInt(field * 8 + entry.wire)), entry.value))));
}
function edit(raw, at, callback) {
    const map = p.fields(raw);
    if (!at.length) return callback(map) ?? encode(map);
    const entry = map.get(at[0])[0];
    entry.value = edit(entry.value, at.slice(1), callback);
    return encode(map);
}
function replace(raw, at, field, bytes) {
    return edit(raw, at, map => { map.delete(field); return join(encode(map), bytes); });
}
const COMMON = [53], INFO = [...COMMON, 2], MEDIA = [...INFO, 1], INDEX = [...MEDIA, 1];
const FILE = [...INDEX, 1], TYPE = [...FILE, 5], PIC = [...MEDIA, 2], PARAMS = [...PIC, 2];
const EXT = [...INFO, 2], EXTPIC = [...EXT, 1], RESERVE = [...EXTPIC, 11], RESERVE20 = [...RESERVE, 20];
const rejected = (raw, code = 'UNSUPPORTED') => assert.throws(() => rich.decodeRichBody(raw), { code });

test('ordinary text preserves exact Unicode, BOM, whitespace and segment order', () => {
    const values = ['\uFEFF  原文😀\n\n', '\tsecond\r\n', '中文'];
    assert.deepEqual(rich.decodeRichBody(body(...values.map(text))), values.map(content =>
        ({ elementType: 1, textElement: { content, atType: 0 } })));
});

test('the observed NT48/20 picture and GeneralFlags produce actual native image metadata', () => {
    const elements = rich.decodeRichBody(body(image(), text('caption'), FLAGS));
    assert.deepEqual(elements, [{ elementType: 2, picElement: { md5HexStr: MD5, fileSize: '70', picWidth: 1,
        picHeight: 1, originImageUrl: URL_PATH + URL_PARAM, fileName: 'actual-file.png', fileUuid: 'actual-wire-file-uuid',
        picType: 1001, picSubType: 0, summary: '' } }, { elementType: 1, textElement: { content: 'caption', atType: 0 } }]);
    assert.equal(elementsSignature(elements), JSON.stringify([[2, MD5, '70', '1', '1'], [1, 'caption']]));
    for (const element of elements) for (const fabricated of ['elementId', 'msgId', 'sourcePath']) {
        assert.equal(Object.hasOwn(element, fabricated), false);
        assert.equal(Object.hasOwn(element.picElement ?? {}, fabricated), false);
    }
});

test('NT48/10 private image uses its actual image appid and resource path', () => {
    const path = '/download?appid=1406&fileid=private-resource';
    const result = rich.decodeRichBody(body(image({ business: 10, path, summary: '原始图片说明' })))[0].picElement;
    assert.equal(result.originImageUrl, path + URL_PARAM);
    assert.equal(result.summary, '原始图片说明');
});

test('repeated ordinary pictures remain repeated, including adjacent copies with the same digest', () => {
    const result = rich.decodeRichBody(body(image(), image(), text('between'), image(), FLAGS));
    assert.deepEqual(result.map(item => item.elementType), [2, 2, 1, 2]);
    assert.equal(result.filter(item => item.picElement?.md5HexStr === MD5).length, 3);
    result[0].picElement.fileName = 'changed';
    assert.equal(result[1].picElement.fileName, 'actual-file.png');
});

test('optional metadata is omitted when absent instead of using placeholder native values', () => {
    let source = image();
    for (const [at, fields] of [[FILE, [3, 4, 8, 9]], [INDEX, [2, 3, 4, 5, 6]], [TYPE, [2, 3, 4]],
        [EXTPIC, [1, 2, 11, 1001, 1002, 1003]], [EXT, [2, 3, 4, 10]], [MEDIA, [5, 6]]]) {
        source = edit(source, at, map => { for (const field of fields) map.delete(field); });
    }
    assert.deepEqual(rich.decodeRichBody(body(source))[0].picElement, { md5HexStr: MD5, fileSize: '70',
        picWidth: 1, picHeight: 1, originImageUrl: URL_PATH + URL_PARAM });
});

test('field order changes preserve interpreted image data', () => {
    const source = image(), expected = rich.decodeRichBody(body(source));
    for (const at of [[], COMMON, INFO, MEDIA, INDEX, FILE, TYPE, PIC, PARAMS, EXT, EXTPIC, RESERVE, RESERVE20]) {
        assert.deepEqual(rich.decodeRichBody(body(edit(source, at, map => encode(new Map([...map].reverse()))))), expected);
    }
});

test('every unknown content element rejects the whole body, even after valid text or pictures', () => {
    for (const field of [2, 4, 8, 9, 16, 19, 45, 51, 99]) {
        rejected(body(text('must not return a partial body'), image(), b(field, Buffer.alloc(0))));
    }
    for (const legacy of [4, 8]) {
        rejected(body(b(legacy, s(1, 'legacy')), image()));
        rejected(body(image(), b(legacy, s(1, 'legacy'))));
        rejected(body(join(image(), b(legacy, s(1, 'legacy')))), 'INVALID_RESPONSE');
    }
});

test('missing or conflicting element payloads and repeated flags are rejected', () => {
    for (const elem of [Buffer.alloc(0), join(text('a'), image()), join(text('a'), FLAGS), join(image(), FLAGS)]) rejected(body(elem), 'INVALID_RESPONSE');
    rejected(body(text('a'), FLAGS, FLAGS), 'INVALID_RESPONSE');
    rejected(body(FLAGS));
});

test('unknown nested media fields are rejected rather than dropping unrecognized semantics', () => {
    for (const at of [COMMON, INFO, MEDIA, INDEX, FILE, TYPE, PIC, PARAMS, EXT, EXTPIC, RESERVE, RESERVE20]) {
        rejected(body(edit(image(), at, map => join(encode(map), n(99, 1)))));
    }
    rejected(edit(body(text('a')), [], map => join(encode(map), n(2, 1))));
    rejected(edit(body(text('a')), [1], map => join(encode(map), n(1, 1))));
});

test('duplicate fields and incorrect wire types are invalid protocol responses', () => {
    for (const [at, field] of [[COMMON, 1], [COMMON, 2], [COMMON, 3], [INFO, 2], [FILE, 1], [TYPE, 1], [EXTPIC, 1]]) {
        rejected(body(edit(image(), at, map => { const entry = map.get(field)[0];
            return join(encode(map), entry.wire === 0 ? n(field, entry.value) : b(field, entry.value)); })), 'INVALID_RESPONSE');
        rejected(body(replace(image(), at, field, p.fields(at.reduce((raw, index) => p.fields(raw).get(index)[0].value, image())).get(field)[0].wire === 0 ?
            b(field, Buffer.alloc(0)) : n(field, 0))), 'INVALID_RESPONSE');
    }
    rejected(body(join(text('a'), text('b'))), 'INVALID_RESPONSE');
});

test('required image identity and dimensional metadata cannot be synthesized', () => {
    for (const [at, field] of [[COMMON, 1], [COMMON, 2], [COMMON, 3], [INFO, 1], [INFO, 2], [MEDIA, 1], [MEDIA, 2],
        [INDEX, 1], [FILE, 1], [FILE, 2], [FILE, 5], [FILE, 6], [FILE, 7], [TYPE, 1], [PIC, 1], [EXT, 1]]) {
        rejected(body(edit(image(), at, map => { map.delete(field); })), 'INVALID_RESPONSE');
    }
});

test('mentions, links and text reserves are not flattened into ordinary text', () => {
    for (const field of [2, 3, 4, 11, 12]) rejected(body(b(1, join(s(1, '@somebody'), b(field, Buffer.from([1]))))));
    const explicitDefaults = b(1, join(s(1, 'a'), ...[2, 3, 4, 11, 12].map(field => b(field, Buffer.alloc(0)))));
    assert.deepEqual(rich.decodeRichBody(body(explicitDefaults)), rich.decodeRichBody(body(text('a'))));
});

test('special picture, voice and video discriminators are rejected', () => {
    for (const business of [0, 11, 12, 21, 22, 48]) rejected(body(image({ business })));
    for (const [at, field, number] of [[COMMON, 1, 3], [TYPE, 1, 2], [TYPE, 3, 1], [TYPE, 4, 1],
        [EXTPIC, 1, 1], [RESERVE, 1, 1], [RESERVE, 3, 1], [RESERVE, 4, 1], [RESERVE, 10, 1],
        [RESERVE, 34, 1], [RESERVE20, 1, 1], [INDEX, 6, 1], [FILE, 8, 1], [MEDIA, 5, 0], [EXT, 10, 1]]) {
        rejected(body(replace(image(), at, field, n(field, number))));
    }
    for (const field of [3, 4]) rejected(body(edit(image(), MEDIA, map => join(encode(map), b(field, Buffer.alloc(0))))));
    for (const field of [2, 3, 4]) rejected(body(edit(image(), [...EXT, field], map => {
        const key = map.keys().next().value; return replace(encode(map), [], key, s(key, 'nonempty-media-data'));
    })));
    rejected(body(edit(image(), RESERVE20, map => join(encode(map), n(8, 0)))));
    rejected(body(replace(image(), EXTPIC, 12, b(12, n(1, 1)))));
});

test('multiple MsgInfo bodies cannot silently lose secondary media content', () => {
    rejected(body(edit(image(), INFO, map => join(encode(map), b(1, map.get(1)[0].value)))));
});

test('GeneralFlags accepts only the specifically observed non-content envelope', () => {
    for (const [at, field, replacement] of [[[37], 6, n(6, 1)], [[37, 19], 85, n(85, 0)],
        [[37, 19], 109, b(109, join(n(1, 1), b(4, Buffer.alloc(9))))], [[37, 19, 109], 1, n(1, 2)]]) {
        rejected(body(text('a'), replace(FLAGS, at, field, replacement)));
    }
    rejected(body(text('a'), edit(FLAGS, [37, 19], map => join(encode(map), n(100, 1)))));
});

test('the observed text-only GeneralFlags omits field 85 while retaining the same required 109 envelope', () => {
    const textFlags = edit(FLAGS, [37, 19], map => { map.delete(85); });
    const content = '  实际纯文本节点\n\n';
    assert.deepEqual(rich.decodeRichBody(body(text(content), textFlags)), rich.decodeRichBody(body(text(content))));
    rejected(body(text(content), edit(textFlags, [37, 19], map => { map.delete(109); })), 'INVALID_RESPONSE');
    rejected(body(text(content), replace(textFlags, [37, 19], 85, n(85, 0))));
});

test('the proved private-image reserve8 summary replica preserves exact text and leaves flash metadata absent', () => {
    const summary = '\uFEFF  实际摘要😀\n\n';
    const source = replace(image({ business: 10, summary }), RESERVE, 8, s(8, summary));
    const decoded = rich.decodeRichBody(body(source))[0];
    assert.equal(decoded.picElement.summary, summary);
    assert.equal(Object.hasOwn(decoded.picElement, 'isFlashPic'), false);
    assert.equal(decoded.picElement.picSubType, 0);
    assert.equal(elementsSignature([decoded]), JSON.stringify([[2, MD5, '70', '1', '1']]));
});

test('nonempty reserve8 cannot replace a missing, empty or conflicting main picture summary', () => {
    const summary = 'observed compatibility summary';
    const pair = replace(image({ summary }), RESERVE, 8, s(8, summary));
    rejected(body(edit(pair, EXTPIC, map => { map.delete(2); })));
    rejected(body(replace(pair, EXTPIC, 2, s(2, ''))));
    rejected(body(replace(pair, EXTPIC, 2, s(2, summary + ' '))));
    const noSummary = edit(image(), EXTPIC, map => { map.delete(2); });
    assert.equal(Object.hasOwn(rich.decodeRichBody(body(noSummary))[0].picElement, 'summary'), false);
});

test('reserve8 keeps UTF-8 and byte limits while every other unsupported auxiliary field remains rejected', () => {
    const summary = '😀'.repeat(256);
    const source = replace(image({ summary }), RESERVE, 8, s(8, summary));
    assert.equal(rich.decodeRichBody(body(source))[0].picElement.summary, summary);
    rejected(body(replace(image({ summary: 'valid' }), RESERVE, 8, b(8, Buffer.from([0xff])))), 'INVALID_RESPONSE');
    rejected(body(replace(image({ summary: 'valid' }), RESERVE, 8, s(8, summary + 'a'))), 'INVALID_RESPONSE');
    for (const field of [12, 18, 19, 31]) rejected(body(replace(source, RESERVE, field, s(field, summary))));
    rejected(body(replace(source, RESERVE, 1, n(1, 1))));
    rejected(body(edit(source, RESERVE, map => join(encode(map), s(8, summary)))), 'INVALID_RESPONSE');
});

test('MD5, SHA-1 and protocol strings require valid exact UTF-8 and formats', () => {
    for (const md5 of ['', 'a'.repeat(31), 'g'.repeat(32), 'a'.repeat(33)]) rejected(body(image({ md5 })), 'INVALID_RESPONSE');
    for (const [at, field, bytes] of [[FILE, 2, Buffer.from([0xff])], [FILE, 3, Buffer.from('bad-sha1')],
        [FILE, 4, Buffer.from('../bad.png')], [INDEX, 2, Buffer.from([0xc0, 0x80])], [EXTPIC, 2, Buffer.from([0xff])]]) {
        rejected(body(replace(image(), at, field, b(field, bytes))), 'INVALID_RESPONSE');
    }
    rejected(body(b(1, b(1, Buffer.from([0xff])))), 'INVALID_RESPONSE');
    rejected(body(text('')), 'INVALID_RESPONSE');
});

test('image locators preserve the exact original parameters and reject ambiguous or unsafe URLs', () => {
    const absolute = 'https://multimedia.nt.qq.com.cn' + URL_PATH;
    assert.equal(rich.decodeRichBody(body(image({ path: absolute })))[0].picElement.originImageUrl, absolute + URL_PARAM);
    assert.equal(rich.decodeRichBody(body(image({ domain: 'multimedia.nt.qq.com' })))[0].picElement.originImageUrl,
        'https://multimedia.nt.qq.com' + URL_PATH + URL_PARAM);
    for (const options of [{ path: '/not-download?appid=1407&fileid=a' }, { domain: 'attacker.example' },
        { path: 'http://multimedia.nt.qq.com.cn/download?appid=1407&fileid=a' },
        { path: 'https://multimedia.nt.qq.com.cn:444/download?appid=1407&fileid=a' },
        { path: 'https://user@multimedia.nt.qq.com.cn/download?appid=1407&fileid=a' },
        { path: 'https://attacker.example/download?appid=1407&fileid=a' }, { path: URL_PATH + '&appid=1406' },
        { path: URL_PATH + '&extra=1' }, { path: '/download?appid=1407' }, { path: '/download?appid=1&fileid=a' },
        { path: '/download?appid=1407&fileid=a%20b' }, { path: URL_PATH + '#fragment' }, { param: '?spec=0' },
        { param: '&spec=0&spec=1' }]) {
        assert.throws(() => rich.decodeRichBody(body(image(options))), error => ['UNSUPPORTED', 'INVALID_RESPONSE'].includes(error.code));
    }
});

test('single and aggregate image size, dimensions and pixels have bounded exact values', () => {
    for (const options of [{ size: 0 }, { size: rich.MAX_IMAGE_BYTES + 1 }, { width: 0 }, { height: 0 },
        { width: 65536 }, { height: 65536 }, { width: 10001, height: 10000 }]) rejected(body(image(options)), 'INVALID_RESPONSE');
    const exact = rich.decodeRichBody(body(image({ size: rich.MAX_IMAGE_BYTES, width: 10000, height: 10000 })))[0].picElement;
    assert.equal(exact.fileSize, String(rich.MAX_IMAGE_BYTES));
    rejected(body(image({ size: 6 * 1024 * 1024 }), image({ size: 5 * 1024 * 1024 })), 'INVALID_RESPONSE');
});

test('body, element and aggregate text budgets are enforced at their boundaries', () => {
    assert.equal(rich.decodeRichBody(body(text('a'.repeat(rich.MAX_TEXT_BYTES))))[0].textElement.content.length, rich.MAX_TEXT_BYTES);
    rejected(body(text('a'.repeat(rich.MAX_TEXT_BYTES + 1))), 'INVALID_RESPONSE');
    rejected(body(text('a'.repeat(32768)), text('b'.repeat(32769))), 'INVALID_RESPONSE');
    assert.equal(rich.decodeRichBody(body(...Array.from({ length: rich.MAX_ELEMENTS }, () => text('a')))).length, rich.MAX_ELEMENTS);
    rejected(body(...Array.from({ length: rich.MAX_ELEMENTS + 1 }, () => text('a'))), 'INVALID_RESPONSE');
    for (const raw of [undefined, new Uint8Array([1]), Buffer.alloc(0), Buffer.alloc(rich.MAX_BYTES + 1)]) rejected(raw, 'INVALID_RESPONSE');
});

test('malformed protobuf, truncated fields and oversized varints never return partial content', () => {
    for (const raw of [Buffer.from([0]), Buffer.from([0x0a, 5, 1]), Buffer.from([0x0a, 0x80]),
        Buffer.from([0x0a, ...Array(11).fill(0xff)]), body(text('a'), Buffer.from([0x0b]))]) rejected(raw, 'INVALID_RESPONSE');
});

test('decoded output has no aliases into the source buffer and does not mutate the input', () => {
    const input = body(image(), text('caption'), FLAGS), copy = Buffer.from(input), result = rich.decodeRichBody(input);
    assert(input.equals(copy));
    input.fill(0);
    assert.equal(result[0].picElement.originImageUrl, URL_PATH + URL_PARAM);
    assert.equal(result[1].textElement.content, 'caption');
});

test('native-like decoded elements convert through the existing public codec without child message IDs', async () => {
    const elements = rich.decodeRichBody(body(text('  caption\n'), image(), FLAGS));
    let conversions = 0;
    const result = await codec.fromKernel({ elements }, { image: async element => {
        conversions++;
        assert.equal(element.msgId, undefined);
        assert.equal(element.picElement.originImageUrl, URL_PATH + URL_PARAM);
        return { file: element.picElement.md5HexStr, url: 'https://multimedia.nt.qq.com.cn' + URL_PATH + URL_PARAM };
    } });
    assert.equal(conversions, 1);
    assert.deepEqual(result, [{ type: 'text', data: { text: '  caption\n' } }, { type: 'image', data: { file: MD5,
        url: 'https://multimedia.nt.qq.com.cn' + URL_PATH + URL_PARAM, file_size: '70', file_name: 'actual-file.png',
        width: 1, height: 1, sub_type: 0, summary: '' } }]);
});
