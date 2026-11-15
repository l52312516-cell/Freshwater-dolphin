'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const { createLogger } = require('../src/log.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIUkAAAAASUVORK5CYII=', 'base64');
function fixture(t, account = '123', hook = async () => {}) {
    const parent = path.resolve(__dirname, '../work/temp');
    fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'inline-image-service-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const mediaDirectory = path.join(directory, 'media');
    fs.mkdirSync(mediaDirectory, { mode: 0o700 });
    const state = { ready: true, epoch: 'epoch-' + account, self: { uin: account, uid: 'u_' + account }, capabilities: { image: true } };
    const calls = [], logs = [];
    const backend = { async call(method, params) {
        if (method === 'status') return state;
        calls.push({ method, params });
        await hook(method, params);
        if (method === 'prepareMedia') {
            assert.equal(params.expectedEpoch, state.epoch);
            assert.equal(path.dirname(params.file), mediaDirectory);
            assert.deepEqual(fs.readFileSync(params.file), png);
            assert.equal(JSON.stringify(params).includes('base64://'), false);
            return { elementType: 2, picElement: { sourcePath: 'native-cache/' + account, md5HexStr: 'mock' } };
        }
        if (method === 'sendMessage') return { ...params.peer, msgId: '18446744073709551001', senderUin: account,
            elements: params.elements, msgSeq: '100', clientSeq: '200' };
        throw new Error('Unexpected method ' + method);
    } };
    const service = new OneBotService({ backend, mediaDirectory, store: new MessageStore({ directory: path.join(directory, 'store') }),
        logger: (event, data) => logs.push({ event, ...data }) });
    return { service, calls, logs, mediaDirectory, directory };
}
function request(echo = 'inline-test') {
    return { action: 'send_group_msg', echo, params: { group_id: 200, message: [
        { type: 'text', data: { text: '  图片\n' } }, { type: 'image', data: { file: 'base64://' + png.toString('base64') } }
    ] } };
}

test('inline images become private short RPC paths and are removed after confirmed send', async t => {
    const { service, calls, mediaDirectory } = fixture(t);
    const action = request({ seq: 18 }), original = JSON.stringify(action);
    const result = await service.action(action);
    assert.equal(result.retcode, 0);
    assert.deepEqual(result.echo, { seq: 18 });
    assert.deepEqual(calls.map(item => item.method), ['prepareMedia', 'sendMessage']);
    assert.deepEqual(calls[1].params.elements.map(item => item.elementType), [1, 2]);
    assert.equal(calls[1].params.elements[0].textElement.content, '  图片\n');
    assert.equal(JSON.stringify(action), original);
    assert.deepEqual(fs.readdirSync(mediaDirectory), []);
});

test('failed preparation and unknown send results clean only their own imports without retry', async t => {
    for (const failure of ['prepareMedia', 'sendMessage']) {
        const { service, calls, logs, mediaDirectory } = fixture(t, '123', async method => {
            if (method === failure) throw Object.assign(new Error('sensitive-body token=secret'), { code: 'TIMEOUT' });
        });
        const result = await service.action(request());
        assert.equal(result.retcode, 1504);
        assert.equal(calls.filter(item => item.method === failure).length, 1);
        assert.deepEqual(fs.readdirSync(mediaDirectory), []);
        assert.equal(logs[0].action, 'send_group_msg');
        assert.equal(logs[0].stage, failure);
        assert.equal(logs[0].code, 'TIMEOUT');
        assert.equal(JSON.stringify(logs).includes('secret'), false);
        assert.equal(JSON.stringify(logs).includes('base64://'), false);
    }
});

test('invalid mixed message creates no imports or native requests', async t => {
    const { service, calls, mediaDirectory } = fixture(t);
    const action = request();
    action.params.message.push({ type: 'video', data: { file: 'anything' } });
    assert.equal((await service.action(action)).retcode, 1404);
    assert.deepEqual(calls, []);
    assert.deepEqual(fs.readdirSync(mediaDirectory), []);
});

test('two accounts prepare concurrently and keep paths, confirmations and echo isolated', async t => {
    const preparing = [], release = {};
    const barrier = new Promise(resolve => { release.done = resolve; });
    const hook = async method => {
        if (method !== 'prepareMedia') return;
        preparing.push(true);
        if (preparing.length === 2) release.done();
        await barrier;
    };
    const alpha = fixture(t, '123', hook), beta = fixture(t, '456', hook);
    const [a, b] = await Promise.all([alpha.service.action(request('alpha')), beta.service.action(request('beta'))]);
    assert.equal(a.retcode, 0); assert.equal(b.retcode, 0);
    assert.equal(a.echo, 'alpha'); assert.equal(b.echo, 'beta');
    assert.notEqual(alpha.calls[0].params.file, beta.calls[0].params.file);
    assert.equal(alpha.calls[1].params.elements[1].picElement.sourcePath, 'native-cache/123');
    assert.equal(beta.calls[1].params.elements[1].picElement.sourcePath, 'native-cache/456');
    assert.deepEqual(fs.readdirSync(alpha.mediaDirectory), []);
    assert.deepEqual(fs.readdirSync(beta.mediaDirectory), []);
});

test('fixed action diagnostics retain stage without arbitrary bodies or error text', t => {
    const { directory } = fixture(t);
    const write = process.stdout.write;
    process.stdout.write = () => true;
    try {
        const logger = createLogger(path.join(directory, 'logs'));
        logger('action_failed', { action: 'send_group_msg', stage: 'prepareMedia', durationMs: 22,
            code: 'TIMEOUT', message: 'private chat', token: 'secret', reason: 'https://unsafe.test/?token=secret' });
    } finally { process.stdout.write = write; }
    const log = JSON.parse(fs.readFileSync(path.join(directory, 'logs/adapter.jsonl'), 'utf8'));
    assert.equal(log.action, 'send_group_msg'); assert.equal(log.stage, 'prepareMedia'); assert.equal(log.durationMs, 22);
    assert.equal(log.message, undefined); assert.equal(log.token, undefined); assert.equal(log.reason, undefined);
});
