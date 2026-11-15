'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const codec = require('../src/onebot/codec.cjs');

const text = value => ({ elementType: 1, textElement: { content: value, atType: 0 } });
const ark = data => ({ elementType: 10, arkElement: { bytesData: data, linkInfo: null, subElementType: null } });
const image = data => ({ elementType: 2, picElement: data });
const resource = { file: 'image-resource', url: 'https://example.invalid/resource', file_size: '25' };
const receive = elements => ({ elements });
function shareElement(data, overrides = {}) {
    return { elementType: 10, shareToken: 'account-peer-token', arkElement: {
        bytesData: JSON.stringify({ app: 'com.tencent.structmsg', view: 'news', meta: { news: {
            title: data.title, jumpUrl: data.url, desc: data.content || '', preview: data.image || '' } } }), ...overrides } };
}

test('receive-only JSON preserves signed card bytes and mixed segment order without executing content', async () => {
    const json = ' {\n "app": "com.tencent.music.lua", "meta": {"music":{"title":"甲,乙 [CQ:at,qq=1]", "token":"unchanged"}} } ';
    const converted = await codec.fromKernel(receive([text('  A\n'), ark(json), text('\nB  ')]));
    assert.deepEqual(converted, [{ type: 'text', data: { text: '  A\n' } }, { type: 'json', data: { data: json } },
        { type: 'text', data: { text: '\nB  ' } }]);
    assert.ok(codec.stringify(converted).includes('[CQ:json,data='));
    assert.throws(() => codec.parse([{ type: 'json', data: { data: json } }]), { code: 'UNSUPPORTED' });
});

test('invalid, scalar, array and excessive JSON cards reject the entire native chain', async () => {
    for (const json of ['', '{', 'null', 'true', '7', '"scalar"', '[]', '{}'.repeat(70000)]) {
        let downloads = 0;
        await assert.rejects(codec.fromKernel(receive([image({}), ark(json)]), {
            image: async () => { downloads++; return resource; }
        }), { code: 'INVALID_RESPONSE' });
        assert.equal(downloads, 0);
    }
});

test('native envelopes with conflicting non-null payloads never become truncated text or media', async () => {
    for (const element of [{ ...text('misleading'), arkElement: { bytesData: '{}' } },
        { ...image({}), fileElement: {} }, { ...ark('{}'), grayTipElement: {} }]) {
        await assert.rejects(codec.fromKernel(receive([element]), { image: async () => resource }), { code: 'UNSUPPORTED' });
    }
    assert.deepEqual(await codec.fromKernel(receive([{ ...text('safe'), arkElement: null, fileElement: null }])),
        [{ type: 'text', data: { text: 'safe' } }]);
});

test('every static element is checked before resource downloads or identity lookups', async () => {
    for (const invalid of [{ elementType: 1, textElement: { content: 9 } },
        { elementType: 6, faceElement: { faceType: 3, faceIndex: 10 } },
        { elementType: 1, textElement: { content: '@role', atType: 8 } },
        { elementType: 4, pttElement: null }, { elementType: 3, fileElement: {} }]) {
        let calls = 0;
        await assert.rejects(codec.fromKernel(receive([image({}), invalid]), {
            image: async () => { calls++; return resource; }, record: async () => { calls++; return resource; }
        }));
        assert.equal(calls, 0);
    }
});

test('image receive retains actual filename, dimensions, summary and exact size', async () => {
    const result = await codec.fromKernel(receive([image({ fileName: '原图.png', picWidth: 1920, picHeight: 1080,
        fileSize: '18446744073709551615', picSubType: 1, summary: '图片摘要' })]), { image: async () => resource });
    assert.deepEqual(result, [{ type: 'image', data: { ...resource, file_name: '原图.png', width: 1920, height: 1080, sub_type: 1, summary: '图片摘要' } }]);
    const exact = await codec.fromKernel(receive([image({ fileSize: '18446744073709551615' })]), {
        image: async () => ({ file: 'id', url: 'https://example.invalid/image' }) });
    assert.equal(exact[0].data.file_size, '18446744073709551615');
});

test('voice and video receive expose real duration and dimensions while preserving signed resource URLs', async () => {
    const url = 'https://example.invalid/resource?signature=a%2Fb&expires=1';
    const results = await codec.fromKernel(receive([
        { elementType: 4, pttElement: { fileName: '录音.silk', fileSize: 80, duration: 1.5 } },
        { elementType: 5, videoElement: { fileName: '短视频.mp4', fileTime: 10, fileWidth: 640, fileHeight: 480 } }
    ]), { record: async () => ({ file: 'record-id', url }), video: async () => ({ file: 'video-id', url }) });
    assert.deepEqual(results, [
        { type: 'record', data: { file: 'record-id', url, file_size: '80', file_name: '录音.silk', duration: 1.5 } },
        { type: 'video', data: { file: 'video-id', url, file_name: '短视频.mp4', duration: 10, width: 640, height: 480 } }
    ]);
});

test('optional media metadata never invents absent or malformed values or exposes cache paths', async () => {
    const invalid = [undefined, 'bad', -1, NaN, Infinity, 9007199254740992];
    for (const value of invalid) {
        const result = await codec.fromKernel(receive([image({ fileName: '/private/QQ/cache.png', filePath: '/private/QQ/cache.png',
            fileSize: value, picWidth: value, picHeight: value })]), { image: async () => ({ file: 'id', url: 'https://example.invalid/image' }) });
        assert.deepEqual(result[0].data, { file: 'id', url: 'https://example.invalid/image' });
    }
});

test('explicit file queries preserve opaque IDs and exact uint64 metadata without exposing cache paths or guessing URLs', async () => {
    const file = { elementType: 3, fileElement: { fileUuid: 'opaque:/file?id=甲', fileName: '资料.txt',
        fileSize: '18446744073709551615', filePath: '/private/QQ/cache.txt', url: 'https://unverified.invalid/file' } };
    assert.deepEqual(await codec.fromKernel(receive([text('before\n'), file, text(' after')]), { queryFiles: true }), [
        { type: 'text', data: { text: 'before\n' } },
        { type: 'file', data: { file: 'opaque:/file?id=甲', file_id: 'opaque:/file?id=甲', name: '资料.txt', file_size: '18446744073709551615' } },
        { type: 'text', data: { text: ' after' } }
    ]);
    for (const fileSize of [0, '0', Number.MAX_SAFE_INTEGER, '9007199254740992']) {
        const result = await codec.fromKernel(receive([{ ...file, fileElement: { ...file.fileElement, fileSize } }]), { queryFiles: true });
        assert.equal(result[0].data.file_size, String(fileSize));
    }
});

test('file metadata query support never enables ordinary file event conversion through a truthy option or converter', async () => {
    const file = { elementType: 3, fileElement: { fileUuid: 'id', fileName: 'file.txt', fileSize: '10' } };
    for (const context of [{}, { queryFiles: false }, { queryFiles: 'true' }, { queryFiles: 1 }, { file: async () => ({ file: 'id' }) }]) {
        await assert.rejects(codec.fromKernel(receive([text('must not truncate'), file]), context), { code: 'UNSUPPORTED' });
    }
});

test('all query file fields are validated before resource downloads or identity lookups', async () => {
    const valid = { fileUuid: 'opaque', fileName: 'file.txt', fileSize: '10' };
    const changes = [
        ...[undefined, null, '', 7, 'x'.repeat(1025), 'x\n', 'x\u007f', 'x\u0085'].map(fileUuid => ({ fileUuid })),
        ...[undefined, null, '', ' ', '.', '..', '../file', 'x\\file', '/file', 'x\n', 'x\u007f', '文'.repeat(86)].map(fileName => ({ fileName })),
        ...[undefined, null, '', -1, '-1', '01', '1.5', '18446744073709551616', 9007199254740992, Infinity, NaN].map(fileSize => ({ fileSize }))
    ];
    for (const change of changes) {
        let calls = 0;
        await assert.rejects(codec.fromKernel(receive([image({}), { elementType: 3, fileElement: { ...valid, ...change } }]), {
            queryFiles: true, image: async () => { calls++; return resource; }
        }), { code: 'INVALID_RESPONSE' });
        assert.equal(calls, 0);
    }
    let calls = 0;
    await assert.rejects(codec.fromKernel(receive([image({}), { elementType: 3, fileElement: valid }, { elementType: 99 }]), {
        queryFiles: true, image: async () => { calls++; return resource; }
    }), { code: 'UNSUPPORTED' });
    assert.equal(calls, 0);
});

test('mention UID conversion requires the exact returned identity and a syntactically valid UID', async () => {
    const record = receive([{ elementType: 1, textElement: { content: '@成员', atType: 2, atUid: '', atNtUid: 'u_target' } }]);
    for (const result of [{ uin: '12345' }, { uid: 'u_other', uin: '12345' }, { uid: 'u_target', uin: '0' }]) {
        await assert.rejects(codec.fromKernel(record, { resolveUid: async () => result }), { code: 'INVALID_RESPONSE' });
    }
    for (const atNtUid of ['u_', 'u_space value', 'u_target\n']) {
        let calls = 0;
        await assert.rejects(codec.fromKernel(receive([{ elementType: 1, textElement: { content: '@x', atType: 2, atNtUid } }]), {
            resolveUid: async () => { calls++; return { uid: atNtUid, uin: '12345' }; }
        }), { code: 'INVALID_RESPONSE' });
        assert.equal(calls, 0);
    }
});

test('incoming reply locators must return nonzero 32-bit OneBot IDs', async () => {
    const record = receive([{ elementType: 7, replyElement: {} }]);
    for (const id of [0, 1.5, '1', 2147483648, -2147483649]) {
        await assert.rejects(codec.fromKernel(record, { reply: async () => id }), { code: 'NOT_FOUND' });
    }
    for (const id of [-2147483648, 2147483647]) {
        assert.deepEqual(await codec.fromKernel(record, { reply: async () => id }), [{ type: 'reply', data: { id: String(id) } }]);
    }
});

test('unknown outgoing segments cannot silently disappear from direct kernel conversion', async () => {
    await assert.rejects(codec.toKernel([{ type: 'unknown', data: {} }], {}), { code: 'UNSUPPORTED' });
});

test('file and video accept only explicit local files and standalone message chains', () => {
    for (const segment of [{ type: 'file', data: { file: '报告.txt', name: '分享报告.txt' } },
        { type: 'video', data: { file: 'file:///data/video.mp4' } }]) {
        assert.deepEqual(codec.parse([segment]), [segment]);
        assert.deepEqual(codec.parse(codec.stringify([segment])), [segment]);
        assert.throws(() => codec.parse([{ type: 'text', data: { text: 'partial' } }, segment]), { code: 'UNSUPPORTED' });
        assert.throws(() => codec.parse([segment, segment]), { code: 'UNSUPPORTED' });
    }
    for (const file of ['', 7, 'https://example.invalid/video.mp4', 'base64://AAAA', 'ftp://example.invalid/file', 'bad\n']) {
        for (const type of ['file', 'video']) assert.throws(() => codec.parse([{ type, data: { file } }]));
    }
    for (const data of [{ file: 'x', name: '../unsafe' }, { file: 'x', name: '' }, { file: 'x', magic: true }]) {
        assert.throws(() => codec.parse([{ type: 'file', data }]));
    }
    for (const name of ['.', '..', 'bad\n.txt', 'bad\x7f.txt', 'bad\x85.txt', 'bad\x9f.txt']) {
        assert.throws(() => codec.parse([{ type: 'file', data: { file: 'x', name } }]), { code: 'INVALID_REQUEST' });
    }
    for (const data of [{ file: 'x', name: 'video' }, { file: 'x', cover: 'x.png' }, { file: 'x', url: 'https://example.invalid' }]) {
        assert.throws(() => codec.parse([{ type: 'video', data }]), { code: 'UNSUPPORTED' });
    }
});

test('file and video conversion call only fixed preparers and validate returned native types', async () => {
    for (const [type, elementType, payload] of [['file', 3, 'fileElement'], ['video', 5, 'videoElement']]) {
        const segment = { type, data: { file: 'local' } }, element = { elementType, [payload]: { filePath: 'prepared' } };
        const context = { [type === 'file' ? 'prepareFile' : 'prepareVideo']: async data => {
            assert.deepEqual(data, segment.data); return element;
        } };
        assert.deepEqual(await codec.toKernel([segment], context), [element]);
        await assert.rejects(codec.toKernel([segment], {}), { code: 'UNSUPPORTED' });
        context[type === 'file' ? 'prepareFile' : 'prepareVideo'] = async () => ({ elementType: 2, picElement: {} });
        await assert.rejects(codec.toKernel([segment], context), { code: 'INVALID_RESPONSE' });
    }
});

test('fixed share segments preserve Chinese text and CQ escaping while validating all URL fields', () => {
    const segment = { type: 'share', data: { url: 'https://example.invalid/a?x=1,2#位置', title: '标题 [甲]&乙',
        content: '简介\n 第二行', image: 'https://example.invalid/preview.png' } };
    assert.deepEqual(codec.parse([segment]), [segment]);
    assert.deepEqual(codec.parse(codec.stringify([segment])), [segment]);
    assert.deepEqual(codec.parse([{ type: 'share', data: { url: 'http://example.invalid/', title: '标题' } }])[0].data,
        { url: 'http://example.invalid/', title: '标题' });
    for (const url of ['javascript:alert(1)', 'file:///data/x', 'https://name:password@example.invalid/', '\nhttps://example.invalid/', 'bad']) {
        assert.throws(() => codec.parse([{ type: 'share', data: { url, title: 'x' } }]), { code: 'INVALID_REQUEST' });
        assert.throws(() => codec.parse([{ type: 'share', data: { url: 'https://example.invalid', title: 'x', image: url } }]), { code: 'INVALID_REQUEST' });
    }
    for (const data of [{ url: 'https://example.invalid', title: '' }, { url: 'https://example.invalid', title: 'x', arkElement: {} },
        { url: 'https://example.invalid', title: 'x', content: 7 }]) assert.throws(() => codec.parse([{ type: 'share', data }]), { code: 'INVALID_REQUEST' });
});

test('share conversion requires its separate preparation credential and exact fixed content', async () => {
    const segment = { type: 'share', data: { url: 'https://example.invalid/story', title: '标题', content: '正文', image: '' } };
    const element = shareElement(segment.data);
    assert.deepEqual(await codec.toKernel([segment], { prepareShare: async () => element }), [element]);
    await assert.rejects(codec.toKernel([segment], {}), { code: 'UNSUPPORTED' });
    for (const invalid of [{ ...element, shareToken: undefined }, { ...element, shareToken: undefined, musicToken: 'music-token' },
        shareElement({ ...segment.data, title: 'another' }), shareElement(segment.data, { bytesData: '[]' })]) {
        await assert.rejects(codec.toKernel([segment], { prepareShare: async () => invalid }), { code: 'INVALID_RESPONSE' });
    }
});
