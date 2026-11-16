'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const silk = require('silk-wasm');
const media = require('../src/qq/media.cjs');
const { createRecordExporter } = require('../src/qq/record-export.cjs');
const childProcess = require('node:child_process');

function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'record-export-')), mediaDirectory = path.join(root, 'media');
    fs.mkdirSync(mediaDirectory, { mode: 0o700 }); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // Isolate the missing-tool fixture from the real image's FWD_FFMPEG_PATH.
    return { root, mediaDirectory, exporter: createRecordExporter({ root, mediaDirectory, ffmpegPath: path.join(root, 'missing-ffmpeg') }) };
}
async function source(f) {
    const pcm = Buffer.alloc(24000 * 2 / 5);
    for (let index = 0; index < pcm.length / 2; index++) pcm.writeInt16LE(Math.round(Math.sin(index / 24000 * 440 * 2 * Math.PI) * 8000), index * 2);
    const encoded = Buffer.from((await silk.encode(pcm, 24000)).data), item = media.exportMedia(f.mediaDirectory, 'record', encoded);
    return { encoded, item };
}
function usingExec(t, implementation) {
    t.mock.method(childProcess, 'execFile', implementation);
    const name = require.resolve('../src/qq/record-export.cjs'); delete require.cache[name];
    const result = require(name); delete require.cache[name]; return result;
}

test('real SILK resources export full decoded WAV samples and cache by content without FFmpeg', async t => {
    const f = fixture(t), s = await source(f), expected = Buffer.from((await silk.decode(s.encoded, 24000)).data);
    assert.equal(f.exporter.available(), true); assert.deepEqual(f.exporter.formats(), ['silk', 'wav']);
    const result = await f.exporter.export({ file: s.item.file, outFormat: 'wav' });
    const bytes = fs.readFileSync(result.path); assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    assert.equal(bytes.readUInt32LE(24), 24000); assert.equal(bytes.readUInt32LE(40), expected.length);
    assert.deepEqual(bytes.subarray(44), expected); assert.equal(result.size, expected.length + 44); assert.equal(result.format, 'wav');
    assert.ok(result.path.startsWith(path.join(f.mediaDirectory, 'voice-exports') + path.sep));
    assert.deepEqual(await f.exporter.export({ file: s.item.file, outFormat: 'wav' }), result);
    assert.equal(fs.readdirSync(path.dirname(result.path)).length, 1);
    const original = await f.exporter.export({ file: s.item.file, outFormat: 'silk' });
    assert.deepEqual(fs.readFileSync(original.path), s.encoded);
});

test('voice export rejects cross-account handles, paths, unsupported formats and expired calls', async t => {
    const f = fixture(t), other = fixture(t), s = await source(f);
    await assert.rejects(other.exporter.export({ file: s.item.file, outFormat: 'wav' }));
    for (const params of [{ file: s.item.path, outFormat: 'wav' }, { file: s.item.file, outFormat: 'amr' },
        { file: s.item.file, outFormat: 'wav', arbitrary: true }]) await assert.rejects(f.exporter.export(params), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.exporter.export({ file: s.item.file, outFormat: 'mp3' }), { code: 'UNSUPPORTED' });
    await assert.rejects(f.exporter.export({ file: s.item.file, outFormat: 'wav' }, { expiresAt: Date.now() - 1 }), { code: 'EXPIRED' });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.exporter.export({ file: s.item.file, outFormat: 'wav' }, { signal: controller.signal }), { code: 'EXPIRED' });
    assert.equal(fs.existsSync(path.join(f.mediaDirectory, 'voice-exports')), false);
});

test('corrupt or linked cached exports cannot return an apparently successful voice resource', async t => {
    const f = fixture(t), s = await source(f), result = await f.exporter.export({ file: s.item.file, outFormat: 'silk' });
    fs.writeFileSync(result.path, 'corrupt');
    await assert.rejects(f.exporter.export({ file: s.item.file, outFormat: 'silk' }), { code: 'INVALID_RESPONSE' });
    assert.equal(fs.readdirSync(path.dirname(result.path)).filter(name => name.startsWith('.pending-')).length, 0);
});

test('compressed exports use fixed FFmpeg codecs and account staging without shell or network input', async t => {
    const f = fixture(t), s = await source(f), ffmpegPath = path.join(f.root, 'ffmpeg'); fs.writeFileSync(ffmpegPath, 'fixture-tool');
    const invocations = [];
    const module = usingExec(t, (file, args, options, complete) => {
        invocations.push({ file, args, options, pcm: fs.readFileSync(args[args.indexOf('-i') + 1]) });
        const format = args[args.lastIndexOf('-f') + 1];
        const bytes = Buffer.from((format === 'mp3' ? 'ID3' : format === 'ogg' ? 'OggS' : 'fLaC') + 'synthetic-compressed-output');
        setImmediate(() => complete(null, bytes)); return { kill() { assert.fail('successful conversion cannot be killed'); } };
    });
    const exporter = module.createRecordExporter({ ...f, ffmpegPath });
    assert.deepEqual(exporter.formats(), ['silk', 'wav', 'mp3', 'flac', 'ogg']);
    const pcm = Buffer.from((await silk.decode(s.encoded, 24000)).data);
    for (const format of ['mp3', 'flac', 'ogg']) {
        const result = await exporter.export({ file: s.item.file, outFormat: format }); assert.equal(result.format, format);
        const call = invocations.at(-1); assert.equal(call.file, ffmpegPath); assert.equal(call.options.shell, false);
        assert.equal(call.options.maxBuffer, 32 * 1024 * 1024); assert.equal(call.args.includes('-t'), false);
        assert.equal(call.args[call.args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
        assert.deepEqual(call.pcm, pcm); assert.ok(call.options.env.TEMP.startsWith(path.join(f.mediaDirectory, 'voice-exports', '.pending-')));
        assert.equal(fs.existsSync(call.options.env.TEMP), false);
    }
});

test('cancelling compressed export kills only its child and waits for completion before removing staging', async t => {
    const f = fixture(t), s = await source(f), ffmpegPath = path.join(f.root, 'ffmpeg'); fs.writeFileSync(ffmpegPath, 'fixture-tool');
    const controller = new AbortController(); let started, killed = 0;
    const dispatched = new Promise(resolve => { started = resolve; });
    const module = usingExec(t, (_file, args, _options, complete) => {
        const input = args[args.indexOf('-i') + 1]; started();
        return { kill(signal) { assert.equal(signal, 'SIGKILL'); killed++; assert.equal(fs.existsSync(input), true);
            setImmediate(() => complete(Object.assign(new Error('stopped'), { code: 'KILLED' }), Buffer.alloc(0))); } };
    });
    const exporter = module.createRecordExporter({ ...f, ffmpegPath });
    const pending = exporter.export({ file: s.item.file, outFormat: 'mp3' }, { signal: controller.signal });
    await dispatched; controller.abort(); await assert.rejects(pending, { code: 'EXPIRED' });
    assert.equal(killed, 1); assert.deepEqual(fs.readdirSync(path.join(f.mediaDirectory, 'voice-exports')), []);
});
