'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const silk = require('silk-wasm');
const audio = require('../src/qq/audio.cjs');

function pcm(milliseconds = 200, amplitude = 8000) {
    const bytes = Buffer.alloc(milliseconds * 48);
    for (let index = 0; index < bytes.length / 2; index++) bytes.writeInt16LE(Math.round(Math.sin(index / 24000 * 440 * Math.PI * 2) * amplitude), index * 2);
    return bytes;
}
function fixture(t) {
    const temporary = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporary, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporary, 'audio-test-')), mediaDirectory = path.join(root, 'media');
    fs.mkdirSync(mediaDirectory, { mode: 0o700 });
    const ffmpegPath = path.join(root, 'ffmpeg'); fs.writeFileSync(ffmpegPath, 'workspace-only-test-tool');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, mediaDirectory, ffmpegPath, file(name, bytes) { const file = path.join(mediaDirectory, name); fs.writeFileSync(file, bytes, { mode: 0o600 }); return file; } };
}
function usingExec(t, implementation) {
    t.mock.method(childProcess, 'execFile', implementation);
    const file = require.resolve('../src/qq/audio.cjs'); delete require.cache[file];
    const result = require(file); delete require.cache[file];
    return result;
}

test('real PCM sample count and signal values determine duration and bounded waveform', () => {
    const quiet = audio.pcmInfo(pcm(500, 0)), loud = audio.pcmInfo(pcm(500, 16000));
    assert.equal(loud.durationMs, 500); assert.equal(loud.samples, 12000); assert.equal(loud.durationSeconds, 0.5);
    assert.equal(loud.waveAmplitudes.length, 32); assert.ok(loud.waveAmplitudes.every(value => value > 0 && value <= 100));
    assert.ok(quiet.waveAmplitudes.every(value => value === 0));
    assert.throws(() => audio.pcmInfo(Buffer.alloc(3)), { code: 'INVALID_RESPONSE' });
    assert.throws(() => audio.pcmInfo(pcm(200), 100), { code: 'UNSUPPORTED' });
});

test('real WASM encoded QQ SILK decodes with measured samples without ffmpeg or duration estimates', async t => {
    const f = fixture(t), source = pcm(500), encoded = Buffer.from((await silk.encode(source, 24000)).data);
    const processor = audio.createAudioProcessor(f);
    const result = await processor.prepare(f.file('voice.silk', encoded));
    assert.equal(result.durationMs, 500); assert.equal(result.sampleRate, 24000);
    assert.deepEqual(result.bytes, encoded); assert.equal(result.size, encoded.length);
    assert.equal(result.md5, crypto.createHash('md5').update(encoded).digest('hex'));
    assert.equal(result.waveAmplitudes.length, 32);
    assert.equal(fs.existsSync(path.join(f.root, 'work/temp')), false);
});

test('audio format and SILK framing reject arbitrary inputs, truncation and malformed frames', async t => {
    const f = fixture(t), processor = audio.createAudioProcessor(f);
    await assert.rejects(processor.prepare(f.file('playlist.mp3', Buffer.from('#EXTM3U\nfile:///etc/passwd'))), { code: 'UNSUPPORTED' });
    for (const bytes of [Buffer.from('\x02#!SILK_V3'), Buffer.from('\x02#!SILK_V3\xff\xffx'), Buffer.from('\x02#!SILK_V3\x04\x00ab')]) {
        assert.throws(() => audio.silkFraming(bytes), { code: 'INVALID_RESPONSE' });
    }
    const invalid = Buffer.concat([Buffer.from('\x02#!SILK_V3\x04\x00'), Buffer.from([0, 0, 0])]);
    await assert.rejects(processor.prepare(f.file('malformed.silk', invalid)), { code: 'INVALID_RESPONSE' });
});

test('full MP3 decode uses fixed input demuxer, no shell, bounded PCM and workspace staging', async t => {
    const f = fixture(t); let invocation;
    const module = usingExec(t, (file, args, options, complete) => {
        invocation = { file, args, options, staged: fs.readFileSync(args[args.indexOf('-i') + 1]) };
        setImmediate(() => complete(null, pcm(320), Buffer.alloc(0)));
        return { kill() { throw new Error('Successful decoder must not be killed'); } };
    });
    const source = Buffer.from('ID3test mp3 bytes');
    const result = await module.createAudioProcessor(f).prepare(f.file('song.mp3', source));
    assert.deepEqual(invocation.staged, source); assert.equal(result.durationMs, 320);
    assert.equal(invocation.options.shell, false); assert.equal(invocation.options.maxBuffer, 32 * 1024 * 1024);
    assert.equal(invocation.args[invocation.args.indexOf('-f') + 1], 'mp3');
    assert.deepEqual(invocation.args.slice(-2), ['s16le', 'pipe:1']);
    assert.equal(invocation.args.includes('-t'), false);
    assert.equal(invocation.options.env.TEMP, path.join(f.root, 'work/temp'));
    assert.equal(invocation.options.env.XDG_CACHE_HOME, path.join(f.root, 'work/cache/ffmpeg'));
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'work/temp')), []);
});

test('overlong and too large decoded audio rejects the whole source instead of silently truncating', async t => {
    const f = fixture(t);
    const module = usingExec(t, (_file, _args, _options, complete) => { setImmediate(() => complete(null, pcm(220))); return { kill() {} }; });
    const processor = module.createAudioProcessor({ ...f, maxDurationMs: 200 });
    await assert.rejects(processor.prepare(f.file('too-long.mp3', Buffer.from('ID3data'))), { code: 'UNSUPPORTED' });
    const bounded = module.createAudioProcessor({ ...f, maxPcmBytes: 100 });
    await assert.rejects(bounded.prepare(f.file('too-large.mp3', Buffer.from('ID3data'))), { code: 'INVALID_RESPONSE' });
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'work/temp')), []);
});

test('decoder cancellation kills the subprocess and removes staging only after completion', async t => {
    const f = fixture(t), controller = new AbortController(); let killed = 0, staged, closed;
    const module = usingExec(t, (_file, args, _options, complete) => {
        staged = args[args.indexOf('-i') + 1];
        closed = () => complete(Object.assign(new Error('terminated'), { code: 'KILLED' }), Buffer.alloc(0));
        return { kill(signal) { assert.equal(signal, 'SIGKILL'); killed++; assert.equal(fs.existsSync(staged), true); setImmediate(closed); } };
    });
    const pending = module.createAudioProcessor(f).prepare(f.file('cancel.mp3', Buffer.from('ID3data')), { signal: controller.signal });
    controller.abort(); await assert.rejects(pending, { code: 'EXPIRED' });
    assert.equal(killed, 1); assert.equal(fs.existsSync(staged), false);
});

test('FFmpeg paths, source paths and already expired work cannot escape their workspace', async t => {
    const f = fixture(t), input = f.file('source.mp3', Buffer.from('ID3data'));
    const outside = audio.createAudioProcessor({ ...f, ffmpegPath: process.execPath });
    assert.equal(outside.available(), false);
    await assert.rejects(outside.prepare(input), { code: 'INVALID_CONFIG' });
    const processor = audio.createAudioProcessor(f);
    await assert.rejects(processor.prepare(path.join(f.root, 'outside.mp3')), { code: 'INVALID_PARAMS' });
    await assert.rejects(processor.prepare(input, { expiresAt: Date.now() - 1 }), { code: 'EXPIRED' });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(processor.prepare(input, { signal: controller.signal }), { code: 'EXPIRED' });
});

test('SILK codec worker is cancelled independently of the main event loop', async t => {
    const f = fixture(t), encoded = Buffer.from((await silk.encode(pcm(500), 24000)).data);
    const processor = audio.createAudioProcessor(f), controller = new AbortController();
    const pending = processor.prepare(f.file('worker-cancel.silk', encoded), { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { code: 'EXPIRED' });
    const result = await processor.prepare(path.join(f.mediaDirectory, 'worker-cancel.silk'));
    assert.equal(result.durationMs, 500);
});

test('separate account processors retain independent private source boundaries', async t => {
    const first = fixture(t), second = fixture(t);
    const encoded = Buffer.from((await silk.encode(pcm(200), 24000)).data);
    const firstFile = first.file('first.silk', encoded), secondFile = second.file('second.silk', encoded);
    const one = audio.createAudioProcessor(first), two = audio.createAudioProcessor(second);
    await assert.rejects(one.prepare(secondFile), { code: 'INVALID_PARAMS' });
    await assert.rejects(two.prepare(firstFile), { code: 'INVALID_PARAMS' });
    const results = await Promise.all([one.prepare(firstFile), two.prepare(secondFile)]);
    assert.ok(results.every(value => value.durationMs === 200));
});
