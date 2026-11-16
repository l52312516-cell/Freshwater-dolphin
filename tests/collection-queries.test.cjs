'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createCollectionQueries } = require('../src/qq/collection-queries.cjs');
const { runCollectionQueries } = require('../src/onebot/collection-queries.cjs');

function item(cid = 'first') {
    return { cid, type: 8, status: 1, category: 2, author: { type: 1, numId: '11111', strId: '本人', uid: 'u_self' },
        createTime: '1800000000000', collectTime: '1800000000000', modifyTime: '1800000000000', sequence: '18446744073709551614',
        summary: { richMediaSummary: { brief: 'A \n原文', picList: [] }, textSummary: null }, securityBeat: false };
}
function page(items = [item()], extra = {}) {
    return { errCode: 0, errMsg: '', collectionSearchList: { collectionItemList: items, hasMore: false,
        bottomTimeStamp: '1800000000000', ...extra } };
}
function fixture() {
    const calls = [], capture = { epoch: 'collections-e1', session: {}, self: { uin: '11111', uid: 'u_self' }, pending: new Set(),
        ensureReady() {}, hasMethods: () => true, deadline: Capture.prototype.deadline };
    let response = () => page();
    const api = createCollectionQueries(capture);
    capture.invoke = async (service, method, args) => { calls.push({ service, method, args }); return response(); };
    const state = { epoch: capture.epoch, self: { ...capture.self }, capabilities: { collectionList: true } };
    const service = { sessionCall: (_state, method, params) => {
        assert.equal(method, 'collectionQuery'); return api.query({ ...params, expectedEpoch: state.epoch });
    } };
    return { api, capture, calls, state, service, response(value) { response = value; },
        query: (params = {}, context = {}) => api.query({ ...params, expectedEpoch: capture.epoch }, context),
        action: (params = {}) => runCollectionQueries(service, state, 'get_collection_list', params) };
}

test('collection action executes a real fixed kernel page and preserves exact contents and pagination', async () => {
    const f = fixture(), original = page([item()], { hasMore: true });
    f.response(() => original);
    const result = await f.action({ category: '2', count: '1' });
    assert.deepEqual(result, original);
    assert.deepEqual(f.calls, [{ service: 'collection', method: 'getCollectionItemList', args: [{ category: 2, groupId: -1,
        forceSync: true, forceFromDb: false, timeStamp: '0', count: 1, searchDown: true }] }]);
    original.collectionSearchList.collectionItemList[0].summary.richMediaSummary.brief = 'changed later';
    assert.equal(result.collectionSearchList.collectionItemList[0].summary.richMediaSummary.brief, 'A \n原文');
    assert.equal(result.collectionSearchList.collectionItemList[0].sequence, '18446744073709551614');
    assert.equal(result.collectionSearchList.hasMore, true, 'one fetched page never becomes a complete account inventory');
    assert.equal(f.calls.length, 1, 'a partial page does not trigger an unbounded follow-up fetch');
});

test('collection pagination accepts canonical timestamps and keeps confirmed empty pages distinct from missing results', async () => {
    const f = fixture(); f.response(() => page([], { bottomTimeStamp: '0' }));
    const result = await f.action({ time_stamp: '1800000000000', count: 5 });
    assert.deepEqual(result.collectionSearchList.collectionItemList, []);
    assert.equal(result.collectionSearchList.hasMore, false);
    assert.equal(f.calls[0].args[0].timeStamp, '1800000000000');
    f.response(() => ({ result: '0', collectionSearchList: page().collectionSearchList }));
    assert.equal((await f.action()).result, '0');
});

test('malformed collection parameters are rejected before native dispatch', async () => {
    const f = fixture();
    for (const category of [null, true, -1, '01', ' 2 ', '2.0', 4294967296, {}, []]) {
        await assert.rejects(f.action({ category }), { code: 'INVALID_PARAMS' });
    }
    for (const count of [null, true, 0, 101, 1.5, '01', '1e2', {}, []]) {
        await assert.rejects(f.action({ count }), { code: 'INVALID_PARAMS' });
    }
    for (const time_stamp of [null, true, -1, '01', '18446744073709551616', 9007199254740992]) {
        await assert.rejects(f.action({ time_stamp }), { code: 'INVALID_PARAMS' });
    }
    await assert.rejects(f.action({ arbitrary_method: 'getCollectionUserInfo' }), { code: 'INVALID_PARAMS' });
    assert.equal(f.calls.length, 0);
});

test('collection queries require explicit successful business status and never retry failures', async () => {
    const f = fixture();
    for (const outcome of [undefined, {}, { collectionSearchList: page().collectionSearchList }]) {
        f.response(() => outcome);
        await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' });
    }
    for (const [field, code] of [['errCode', 5], ['result', -1], ['errorCode', '7']]) {
        f.response(() => ({ ...page([], { bottomTimeStamp: '0' }), [field]: code, errMsg: 'private native diagnostic' }));
        await assert.rejects(f.action(), error => error.code === 'KERNEL_ERROR' &&
            error.message.includes(field + '=' + Number(code)) && !error.message.includes('private native diagnostic'));
    }
    assert.equal(f.calls.length, 6, 'every failure makes exactly one native request');
    f.response(() => page([], { bottomTimeStamp: '0' }));
    assert.deepEqual((await f.action()).collectionSearchList.collectionItemList, [], 'only a successful native empty page is empty success');
});

test('malformed or noncanonical collection status codes are invalid responses rather than business failures', async () => {
    const f = fixture();
    const invalid = [undefined, null, true, {}, [], NaN, Infinity, 1.5, -0, Number.MAX_SAFE_INTEGER + 1,
        '', '00', '-0', '+0', '0.0', '1e0', ' 0', '0 ', '-01', '5x', '9007199254740992'];
    for (const field of ['result', 'errCode', 'errorCode']) for (const code of invalid) {
        f.response(() => ({ ...page(), [field]: code }));
        await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' });
    }
    f.response(() => ({ ...page(), errCode: 5, result: 'invalid' }));
    await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' }, 'an explicit failure cannot conceal a malformed additional status');
    assert.equal(f.calls.length, invalid.length * 3 + 1, 'invalid statuses are never retried');
});

test('collection pages reject duplicate identities, unrelated categories, inaccurate numbers and stalled cursors', async () => {
    const f = fixture();
    const invalid = [page([item(), item()]), page([item()], { hasMore: true, bottomTimeStamp: '0' }),
        page([], { hasMore: true }), page([item()], { hasMore: 'false' }),
        page([{ ...item(), sequence: 9007199254740992 }]), page([{ ...item(), author: null }]),
        page([{ ...item(), summary: { count: Number.MAX_SAFE_INTEGER + 1 } }]),
        page([item()], { bottomTimeStamp: '18446744073709551616' })];
    for (const outcome of invalid) {
        f.response(() => outcome); await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' });
    }
    f.response(() => page());
    await assert.rejects(f.action({ category: 1 }), { code: 'INVALID_RESPONSE' });
    f.response(() => page([item()], { hasMore: true }));
    await assert.rejects(f.action({ time_stamp: '1800000000000' }), { code: 'INVALID_RESPONSE' });
    f.response(() => page([item('a'), item('b')]));
    await assert.rejects(f.action({ count: 1 }), { code: 'INVALID_RESPONSE' });
});

test('collection response bytes and recursive content are bounded before publication', async () => {
    const f = fixture();
    f.response(() => page([{ ...item(), summary: { text: 'x'.repeat(2 * 1024 * 1024) } }]));
    await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' });
    const cyclic = {}; cyclic.self = cyclic;
    f.response(() => page([{ ...item(), summary: cyclic }]));
    await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' });
    f.response(() => page([{ ...item(), summary: { broken: '\ud800' } }]));
    await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' });
});

test('the collection byte budget includes business status and leaves room for the real RPC envelope', async () => {
    const f = fixture(), limit = 1024 * 1024;
    const outcome = page([{ ...item(), summary: { text: '' } }]);
    const padding = limit - Buffer.byteLength(JSON.stringify(outcome.collectionSearchList)) - 8;
    outcome.collectionSearchList.collectionItemList[0].summary.text = 'x'.repeat(padding);
    assert.ok(Buffer.byteLength(JSON.stringify(outcome.collectionSearchList)) < limit);
    assert.ok(Buffer.byteLength(JSON.stringify(outcome)) > limit);
    f.response(() => outcome);
    await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' });
    outcome.collectionSearchList.collectionItemList[0].summary.text = 'x'.repeat(padding - 1024);
    const result = await f.action();
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < limit);
    const envelope = { version: 1, instance: 'test-instance', requestId: 'test-request', ok: true,
        result: { category: 0, count: 50, timeStamp: '0', page: result } };
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < require('../src/ipc/common.cjs').LIMIT);
});

test('collection snapshot stops on accumulated encoded bytes before visiting or serializing an oversized result', async () => {
    const f = fixture(), repeated = 'x'.repeat(600000);
    let tailReads = 0;
    const repeatedValues = [repeated, repeated];
    Object.defineProperty(repeatedValues, 2, { enumerable: true, get() { tailReads++; throw new Error('oversized tail must remain unread'); } });
    f.response(() => page([{ ...item(), summary: { repeatedValues } }]));
    await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' });
    assert.equal(tailReads, 0, 'the second reused string crosses the budget before walking the tail');
    const escaped = '\\'.repeat(300000), escapedValues = [escaped, escaped];
    f.response(() => page([{ ...item(), summary: { escapedValues } }]));
    await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' });
    const many = Object.fromEntries(Array.from({ length: 26000 }, (_, index) => ['field' + index, 0]));
    f.response(() => page([{ ...item(), summary: many }]));
    await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' });
});

test('expired, cancelled and replaced collection sessions cannot dispatch or publish an old result', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await assert.rejects(f.query({}, { signal: controller.signal }), { code: 'EXPIRED' });
    await assert.rejects(f.query({}, { expiresAt: Date.now() - 1 }), { code: 'EXPIRED' });
    await assert.rejects(f.api.query({ expectedEpoch: 'other-account' }), { code: 'SESSION_CHANGED' });
    assert.equal(f.calls.length, 0);
    let finish; f.response(() => new Promise(resolve => { finish = resolve; }));
    const old = f.query(); await new Promise(resolve => setImmediate(resolve));
    f.capture.self = { uin: '22222', uid: 'u_other' }; finish(page());
    await assert.rejects(old, { code: 'SESSION_CHANGED' });
    assert.equal(f.calls.length, 1);
});

test('timed-out native collection requests retain their bounded slots until native completion', async () => {
    const f = fixture(), finish = [];
    f.response(() => new Promise(resolve => finish.push(resolve)));
    const pending = Array.from({ length: 4 }, () => f.query({}, { expiresAt: Date.now() + 30 }));
    const outcomes = await Promise.allSettled(pending);
    assert.ok(outcomes.every(value => value.status === 'rejected' && ['TIMEOUT', 'EXPIRED'].includes(value.reason.code)));
    await assert.rejects(f.query(), { code: 'BUSY' });
    assert.equal(f.calls.length, 4);
    finish[0](page()); await new Promise(resolve => setImmediate(resolve));
    f.response(() => page());
    assert.equal((await f.query()).page.errCode, 0);
    f.capture.epoch = 'collections-e2'; f.capture.session = {};
    assert.equal((await f.query()).page.errCode, 0);
    finish.slice(1).forEach(resolve => resolve(page()));
    await new Promise(resolve => setImmediate(resolve));
});

test('repeated session changes cannot bypass the four physical collection request slots', async () => {
    const f = fixture(), finish = [];
    f.response(() => new Promise(resolve => finish.push(resolve)));
    for (let index = 0; index < 4; index++) {
        f.capture.epoch = 'pending-collection-' + index;
        f.capture.session = {};
        f.capture.self = { uin: String(11111 + index), uid: 'u_account_' + index };
        const controller = new AbortController(), pending = f.query({}, { signal: controller.signal });
        const rejected = assert.rejects(pending, { code: 'EXPIRED' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(finish.length, index + 1, 'the native request has really started before cancelling its caller');
        controller.abort(); await rejected;
    }
    for (let index = 0; index < 8; index++) {
        f.capture.epoch = 'replacement-collection-' + index;
        f.capture.session = {};
        f.capture.self = { uin: String(22222 + index), uid: 'u_replacement_' + index };
        await assert.rejects(f.query(), { code: 'BUSY' });
    }
    assert.equal(f.calls.length, 4, 'session changes do not dispatch extra unresolved native queries');
    finish[0](page()); await new Promise(resolve => setImmediate(resolve));
    f.response(() => page());
    assert.equal((await f.query()).page.errCode, 0, 'settlement of an old-session request releases exactly one slot');
    assert.equal(f.calls.length, 5);
    finish.slice(1).forEach(resolve => resolve(page()));
    await new Promise(resolve => setImmediate(resolve));
});

test('OneBot collection boundary checks capability, request identity and returned page instead of trusting RPC envelopes', async () => {
    const f = fixture();
    f.state.capabilities.collectionList = false;
    await assert.rejects(f.action(), { code: 'UNSUPPORTED' });
    f.state.capabilities.collectionList = true;
    f.capture.hasMethods = () => false;
    await assert.rejects(f.action(), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
    f.service.sessionCall = async () => ({ category: 1, count: 50, timeStamp: '0', page: page() });
    await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' });
    f.service.sessionCall = async () => ({ category: 0, count: 50, timeStamp: '0', page: { collectionSearchList: page().collectionSearchList } });
    await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' });
    await assert.rejects(runCollectionQueries(f.service, f.state, 'create_collection', {}), { code: 'UNSUPPORTED' });
});
