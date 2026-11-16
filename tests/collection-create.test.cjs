'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createCollectionCreate, acknowledgement, MAX_RAW_BYTES } = require('../src/qq/collection-create.cjs');
const { runCollectionCreate } = require('../src/onebot/collection-create-actions.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    const calls = [], capture = { epoch: 'e1', session: {}, self: { uin: '11111', uid: 'u_self', nickname: 'Author' },
        pending: new Set(), ensureReady() {}, hasMethods: () => true, deadline: Capture.prototype.deadline };
    let reply = () => ({ result: 0, errMsg: '' });
    capture.invoke = async (...args) => { calls.push(args); return reply(); };
    const api = createCollectionCreate(capture), state = { self: { ...capture.self }, epoch: capture.epoch, capabilities: { collectionCreate: true } };
    const service = { sessionCall: (_state, method, value) => { assert.equal(method, 'collectionCreate'); return api.action({ ...value, expectedEpoch: state.epoch }); }, assertSession: async () => {} };
    return { api, capture, state, service, calls, reply(value) { reply = value; },
        create: (value = { rawData: '<note>example</note>', brief: 'Example' }, context = {}) => api.action({ ...value, expectedEpoch: capture.epoch }, context),
        action: (value = { rawData: '<note>example</note>', brief: 'Example' }) => runCollectionCreate(service, state, 'create_collection', value) };
}
test('collection creation sends an exact self-authored native request and returns only its business acknowledgement', async () => {
    const f = fixture(); assert.deepEqual(await f.action(), { result: 0, errMsg: '' });
    assert.equal(f.calls.length, 1); const [service, method, args] = f.calls[0];
    assert.equal(service, 'collection'); assert.equal(method, 'createNewCollectionItem'); assert.equal(args.length, 1);
    const request = args[0]; assert.deepEqual(request.commInfo.author, { type: 1, numId: '11111', strId: 'Author', groupId: '0', groupName: '', uid: 'u_self' });
    assert.equal(request.commInfo.category, 2); assert.equal(request.commInfo.appId, 0); assert.equal(request.commInfo.customGroupId, 0);
    assert.equal(request.richMediaContent.rawData, '<note>example</note>'); assert.equal(request.richMediaSummary.brief, 'Example');
    assert.deepEqual(request.richMediaContent.fileList, []); assert.equal(request.need_share_url, false);
    assert.ok(Number(request.commInfo.sequence) >= Date.now() - 1000);
    await f.action(); assert.ok(BigInt(f.calls[1][2][0].commInfo.sequence) > BigInt(request.commInfo.sequence));
});
test('collection parameters, author scope and capability are checked before any native mutation', async () => {
    const f = fixture();
    for (const value of [null, [], { rawData: '', brief: '' }, { rawData: '\ud800', brief: '' }, { rawData: 'x'.repeat(MAX_RAW_BYTES + 1), brief: '' },
        { rawData: 'x', brief: '' , author: 'other' }, { rawData: 'x', brief: '', self_id: '22222' }, { rawData: 'x', brief: false }]) await assert.rejects(f.action(value), { code: 'INVALID_PARAMS' });
    const evil = { rawData: 'x' }; Object.defineProperty(evil, 'brief', { get() { throw new Error('Must not run accessor'); } });
    await assert.rejects(f.action(evil), { code: 'INVALID_PARAMS' });
    f.state.capabilities.collectionCreate = false; await assert.rejects(f.action(), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});
test('collection success requires the exact explicit int32 business status and bounded text', async () => {
    for (const value of [undefined, {}, { result: '0', errMsg: '' }, { result: false, errMsg: '' }, { result: -0, errMsg: '' }, { result: 0 },
        { result: 0, errMsg: '\ud800' }, { result: 0, errMsg: '', cid: 'invented' }]) assert.throws(() => acknowledgement(value), { code: 'INVALID_RESPONSE' });
    const f = fixture(); f.reply(() => ({ result: 5, errMsg: 'private server diagnostic' }));
    await assert.rejects(f.action(), error => error.code === 'KERNEL_ERROR' && error.message.includes('result=5') && !error.message.includes('private'));
    assert.equal(f.calls.length, 1);
    f.reply(() => { throw new Error('private native failure'); });
    await assert.rejects(f.action(), error => error.code === 'QUERY_FAILED' && !error.message.includes('private')); assert.equal(f.calls.length, 2);
});
test('collection cancellation retains the write lock until native settlement, even after clear or identity changes', async () => {
    const f = fixture(), controller = new AbortController(); let finish;
    f.reply(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.create(undefined, { signal: controller.signal }), rejected = assert.rejects(pending, { code: 'EXPIRED' });
    await tick(); controller.abort(); await rejected;
    f.api.clear(); f.capture.epoch = 'e2'; f.capture.session = {};
    await assert.rejects(f.create(), { code: 'BUSY' }); assert.equal(f.calls.length, 1);
    finish({ result: 0, errMsg: '' }); await tick();
    f.reply(() => ({ result: 0, errMsg: '' })); assert.equal((await f.create()).confirmation, 'native_business_ack');
});
test('collection session replacement and forged bridge confirmations cannot publish success', async () => {
    const f = fixture(); let finish; f.reply(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.create(), rejected = assert.rejects(pending, { code: 'SESSION_CHANGED' }); await tick();
    f.capture.self = { uin: '22222', uid: 'u_other' }; finish({ result: 0, errMsg: '' }); await rejected;
    const g = fixture(); g.service.sessionCall = async () => ({ uin: '11111', result: 0, errMsg: '', confirmation: 'native_business_ack', digest: 'forged' });
    await assert.rejects(g.action(), { code: 'INVALID_RESPONSE' });
    const h = fixture(), expired = new AbortController(); expired.abort(); await assert.rejects(h.create(undefined, { signal: expired.signal }), { code: 'EXPIRED' }); assert.equal(h.calls.length, 0);
});
