'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { deflateSync } = require('node:zlib');
const video = require('../src/qq/video-send.cjs');

function box(type, bytes) {
    const header = Buffer.alloc(8); header.writeUInt32BE(bytes.length + 8); header.write(type, 4, 4, 'ascii');
    return Buffer.concat([header, bytes]);
}
function mp4({ width = 320, height = 180, movieScale = 1000, movieDuration = 2500, trackDuration = 2500,
    mediaScale = 24000, mediaDuration = 60000, version = 0, codec = 'avc1', tracks = 1, external = false } = {}) {
    const mvhd = Buffer.alloc(version ? 112 : 100); mvhd[0] = version;
    mvhd.writeUInt32BE(movieScale, version ? 20 : 12);
    if (version) mvhd.writeBigUInt64BE(BigInt(movieDuration), 24); else mvhd.writeUInt32BE(movieDuration, 16);
    const tkhd = Buffer.alloc(version ? 96 : 84); tkhd[0] = version;
    if (version) tkhd.writeBigUInt64BE(BigInt(trackDuration), 28); else tkhd.writeUInt32BE(trackDuration, 20);
    const mdhd = Buffer.alloc(version ? 36 : 24); mdhd[0] = version;
    mdhd.writeUInt32BE(mediaScale, version ? 20 : 12);
    if (version) mdhd.writeBigUInt64BE(BigInt(mediaDuration), 24); else mdhd.writeUInt32BE(mediaDuration, 16);
    const hdlr = Buffer.alloc(24); hdlr.write('vide', 8, 4, 'ascii');
    const entry = Buffer.alloc(78); entry.writeUInt16BE(1, 6); entry.writeUInt16BE(width, 24); entry.writeUInt16BE(height, 26);
    const avcc = box('avcC', Buffer.from([1, 66, 0, 30, 255, 225, 0]));
    const sample = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), box(codec, Buffer.concat([entry, avcc]))]);
    const reference = external ? Buffer.concat([Buffer.alloc(4), Buffer.from('file:///unavailable\0')]) : Buffer.from([0, 0, 0, 1]);
    const dref = box('dref', Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), box('url ', reference)]));
    const minf = box('minf', Buffer.concat([box('dinf', dref), box('stbl', box('stsd', sample))]));
    const track = box('trak', Buffer.concat([box('tkhd', tkhd), box('mdia', Buffer.concat([box('mdhd', mdhd), box('hdlr', hdlr), minf]))]));
    return Buffer.concat([box('ftyp', Buffer.from('isom\x00\x00\x00\x01isomavc1', 'binary')),
        box('moov', Buffer.concat([box('mvhd', mvhd), ...Array.from({ length: tracks }, () => track)])), box('mdat', Buffer.from('frame data'))]);
}
function png(width = 320, height = 180, changes = {}) {
    function chunk(type, data) {
        const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
        let crc = 0xffffffff;
        for (const byte of bytes.subarray(4, -4)) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
        bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = changes.color ?? 2;
    const pixels = Buffer.alloc((width * 3 + 1) * height);
    if (changes.filter !== undefined) pixels[0] = changes.filter;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
        chunk('IDAT', changes.compressed ?? deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function fixture(t) {
    const temporary = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporary, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporary, 'video-test-')), mediaDirectory = path.join(root, 'media');
    fs.mkdirSync(mediaDirectory, { mode: 0o700 });
    const ffmpegPath = path.join(root, 'ffmpeg'); fs.writeFileSync(ffmpegPath, 'workspace-test-tool', { mode: 0o700 });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, mediaDirectory, ffmpegPath,
        file(name, bytes = mp4()) { const file = path.join(mediaDirectory, name); fs.writeFileSync(file, bytes, { mode: 0o600 }); return file; } };
}
function usingExec(t, implementation) {
    t.mock.method(childProcess, 'execFile', implementation);
    const file = require.resolve('../src/qq/video-send.cjs'); delete require.cache[file];
    const result = require(file); delete require.cache[file]; return result;
}
test('MP4 track metadata preserves real encoded dimensions and noninteger duration', () => {
    const info = video.mp4Metadata(mp4());
    assert.deepEqual(info, { width: 320, height: 180, durationSeconds: 2.5, durationMs: 2500, fileFormat: 2, extension: 'mp4' });
    assert.equal(video.mp4Metadata(mp4({ version: 1, codec: 'avc3' })).durationSeconds, 2.5);
});
test('metadata rejects unsupported codecs, dimensions, missing duration, extra tracks and external references', () => {
    for (const options of [{ codec: 'hvc1' }, { codec: 'encv' }, { width: 0 }, { width: 4097 }, { height: 4097 },
        { movieScale: 0 }, { trackDuration: 0 }, { trackDuration: 600001 }, { mediaScale: 0 }, { mediaDuration: 0 },
        { mediaDuration: 1 }, { tracks: 2 }, { external: true }]) {
        assert.throws(() => video.mp4Metadata(mp4(options)), { code: 'UNSUPPORTED' });
    }
});
test('truncated, overflowing and fragmented boxes cannot provide invented metadata', () => {
    const bytes = mp4();
    for (const value of [bytes.subarray(0, bytes.length - 1), Buffer.from('not a video'),
        Buffer.concat([bytes, box('moof', Buffer.alloc(8))]), Buffer.concat([bytes, Buffer.alloc(7)])]) {
        assert.throws(() => video.mp4Metadata(value), { code: 'UNSUPPORTED' });
    }
    const overflow = Buffer.from(bytes); overflow.writeUInt32BE(0xffffffff, 0);
    assert.throws(() => video.mp4Metadata(overflow), { code: 'UNSUPPORTED' });
    const duplicate = Buffer.from(bytes); duplicate.writeUInt32BE(2, duplicate.indexOf(Buffer.from('stsd')) + 8);
    assert.throws(() => video.mp4Metadata(duplicate), { code: 'UNSUPPORTED' });
});
test('preparation stages exact source bytes, decodes a bounded real thumbnail, and preserves hashes', async t => {
    const f = fixture(t), source = mp4(), thumb = png(640, 360); let invocation;
    const module = usingExec(t, (executable, args, options, done) => {
        invocation = { executable, args, options, source: fs.readFileSync(args[args.indexOf('-i') + 1]) };
        setImmediate(() => done(null, thumb, Buffer.alloc(0))); return { kill() { throw new Error('No cancellation expected'); } };
    });
    const processor = module.createVideoProcessor(f), filename = f.file('test.mp4', source);
    assert.equal(processor.available(), true);
    const result = await processor.prepare(filename);
    assert.deepEqual(result.bytes, source); assert.deepEqual(result.thumbnail.bytes, thumb);
    assert.deepEqual(fs.readFileSync(filename), source);
    assert.equal(result.md5, crypto.createHash('md5').update(source).digest('hex'));
    assert.equal(result.thumbnail.md5, crypto.createHash('md5').update(thumb).digest('hex'));
    assert.equal(result.thumbnail.width, 640); assert.equal(result.thumbnail.height, 360);
    assert.equal(result.thumbnail.extension, 'png');
    assert.equal(result.durationSeconds, 2.5); assert.equal(result.width, 320); assert.equal(result.height, 180);
    assert.equal(invocation.options.shell, false); assert.equal(invocation.options.maxBuffer, 2 * 1024 * 1024);
    assert.equal(invocation.args[invocation.args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    assert.equal(invocation.args[invocation.args.indexOf('-enable_drefs') + 1], '0');
    assert.equal(invocation.args[invocation.args.indexOf('-f') + 1], 'mov');
    assert.equal(invocation.args[invocation.args.indexOf('-c:v') + 1], 'png');
    assert.equal(invocation.args[invocation.args.indexOf('-pix_fmt') + 1], 'rgb24');
    assert.deepEqual(invocation.args.slice(-2), ['image2pipe', 'pipe:1']);
    assert.deepEqual(invocation.source, source);
    for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(invocation.options.env[key], path.join(f.root, 'work/temp'));
    assert.equal(invocation.options.env.XDG_CACHE_HOME, path.join(f.root, 'work/cache/ffmpeg'));
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'work/temp')), []);
});
test('non-PNG, truncated, corrupt, invalid pixels, unbounded and failed decoder output never fabricate a cover', async t => {
    const f = fixture(t); let outcome = { bytes: Buffer.from('invalid') };
    const module = usingExec(t, (_tool, _args, _options, done) => {
        setImmediate(() => done(outcome.error || null, outcome.bytes)); return { kill() {} };
    });
    const processor = module.createVideoProcessor(f), file = f.file('test.mp4');
    const corrupt = png(); corrupt[29] ^= 1;
    for (const bytes of [Buffer.from('invalid'), Buffer.from([255, 216, 255, 217]), png().subarray(0, 30),
        png().subarray(0, -1), corrupt, png(641, 360), png(320, 180, { color: 6 }), png(320, 180, { filter: 5 }),
        png(320, 180, { compressed: deflateSync(Buffer.alloc(4)) }),
        png(320, 180, { compressed: Buffer.concat([deflateSync(Buffer.alloc((320 * 3 + 1) * 180)), Buffer.from([0])]) }),
        Buffer.alloc(2 * 1024 * 1024 + 1)]) {
        outcome = { bytes }; await assert.rejects(processor.prepare(file), { code: 'INVALID_RESPONSE' });
    }
    outcome = { error: Object.assign(new Error('hidden decoder output'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) };
    await assert.rejects(processor.prepare(file), { code: 'UNSUPPORTED' });
    outcome = { error: new Error('private input text') };
    await assert.rejects(processor.prepare(file), error => error.code === 'INVALID_RESPONSE' && !error.message.includes('private'));
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'work/temp')), []);
});
test('cancellation kills FFmpeg once and clears private staging after the process completes', async t => {
    const f = fixture(t), controller = new AbortController(); let killed = 0, staged;
    const module = usingExec(t, (_tool, args, _options, done) => {
        staged = args[args.indexOf('-i') + 1];
        return { kill(signal) { killed++; assert.equal(signal, 'SIGKILL'); assert.equal(fs.existsSync(staged), true);
            setImmediate(() => done(new Error('killed'))); } };
    });
    const pending = module.createVideoProcessor(f).prepare(f.file('cancel.mp4'), { signal: controller.signal });
    controller.abort(); await assert.rejects(pending, { code: 'EXPIRED' });
    assert.equal(killed, 1); assert.equal(fs.existsSync(staged), false);
});
test('deadline kills a stalled decoder and late output never becomes a result', async t => {
    const f = fixture(t); let killed = 0, started = false;
    const module = usingExec(t, (_tool, _args, _options, done) => {
        started = true;
        return { kill() { killed++; setImmediate(() => done(null, png())); } };
    });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    try {
        const pending = module.createVideoProcessor(f).prepare(f.file('deadline.mp4'), { expiresAt: Date.now() + 50 });
        assert.equal(started, true, 'the decoder must start before its deadline is advanced');
        const rejected = assert.rejects(pending, { code: 'EXPIRED' });
        t.mock.timers.tick(50);
        await rejected;
        assert.equal(killed, 1); assert.deepEqual(fs.readdirSync(path.join(f.root, 'work/temp')), []);
    } finally { t.mock.timers.reset(); }
});
test('workspace tool, private source boundaries, input size and expired requests are enforced', async t => {
    const f = fixture(t), input = f.file('test.mp4');
    const outside = video.createVideoProcessor({ ...f, ffmpegPath: process.execPath });
    assert.equal(outside.available(), false); await assert.rejects(outside.prepare(input), { code: 'INVALID_CONFIG' });
    const missing = video.createVideoProcessor({ ...f, ffmpegPath: path.join(f.root, 'missing') });
    assert.equal(missing.available(), false); await assert.rejects(missing.prepare(input), { code: 'UNSUPPORTED' });
    const processor = video.createVideoProcessor(f);
    for (const source of [path.join(f.root, 'other.mp4'), 'https://example.invalid/movie.mp4', 'base64://AAAA']) {
        await assert.rejects(processor.prepare(source), error => ['INVALID_PARAMS', 'UNSUPPORTED'].includes(error.code));
    }
    await assert.rejects(processor.prepare(input, { expiresAt: Date.now() - 1 }), { code: 'EXPIRED' });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(processor.prepare(input, { signal: controller.signal }), { code: 'EXPIRED' });
    await assert.rejects(processor.prepare(input, { expiresAt: Infinity }), { code: 'INVALID_PARAMS' });
    const large = f.file('large.mp4', Buffer.from([0])); fs.truncateSync(large, 50 * 1024 * 1024 + 1);
    await assert.rejects(processor.prepare(large), { code: 'INVALID_PARAMS' });
});
test('account-isolated processors reject sources owned by the other profile', async t => {
    const first = fixture(t), second = fixture(t);
    const one = video.createVideoProcessor(first), two = video.createVideoProcessor(second);
    await assert.rejects(one.prepare(second.file('other.mp4')), { code: 'INVALID_PARAMS' });
    await assert.rejects(two.prepare(first.file('other.mp4')), { code: 'INVALID_PARAMS' });
});
test('one account cannot allocate several large video snapshots concurrently and releases its slot', async t => {
    const f = fixture(t); let complete;
    const module = usingExec(t, (_tool, _args, _options, done) => { complete = done; return { kill() {} }; });
    const processor = module.createVideoProcessor(f), file = f.file('test.mp4');
    const first = processor.prepare(file);
    await assert.rejects(processor.prepare(file), { code: 'BUSY' });
    complete(null, png()); await first;
    const next = processor.prepare(file); complete(null, png());
    assert.equal((await next).size, fs.statSync(file).size);
});
