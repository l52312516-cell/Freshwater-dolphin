'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createCollectionQueries, validateCollectionPage } = require('../src/qq/collection-queries.cjs');
const { runCollectionQueries } = require('../src/onebot/collection-queries.cjs');
const protocol = require('../src/qq/collection-protocol.cjs'), wire = require('./helpers/collection-wire.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    const tickets = [], requests = [], capture = { epoch: 'e1', session: {}, self: { uin: '11111', uid: 'u_self' }, pending: new Set(),
        ensureReady() {}, hasMethods: (service, methods) => service === 'tipOff' && methods[0] === 'getPskey', deadline: Capture.prototype.deadline };
    let reply = () => wire.page(), ticket = () => ({ result: 0, domainPskeyMap: new Map([['weiyun.com', 'synthetic-ticket']]) });
    capture.invoke = async (service, method, args) => { tickets.push({ service, method, args }); return ticket(); };
    const api = createCollectionQueries(capture, { fetchImpl: async (url, options) => {
        const request = wire.request(options.body); requests.push({ url, options, request });
        const result = await reply(request, options); return result instanceof Response ? result : new Response(result);
    } });
    const state = { epoch: capture.epoch, capabilities: { collectionList: true } };
    const service = { sessionCall: (_state, method, params) => { assert.equal(method, 'collectionQuery'); return api.query({ ...params, expectedEpoch: state.epoch }); } };
    return { capture, api, state, service, tickets, requests, response(value) { reply = value; }, ticket(value) { ticket = value; },
        query: (params = {}, context = {}) => api.query({ ...params, expectedEpoch: capture.epoch }, context),
        action: (params = {}) => runCollectionQueries(service, state, 'get_collection_list', params) };
}
const empty = () => ({ errCode: 0, errMsg: '', collectionSearchList: { collectionItemList: [], hasMore: false, bottomTimeStamp: '0' } });

test('collection reads retain tickets in the worker and call only the fixed authenticated HTTPS operation', async () => {
    const f = fixture(), result = await f.action({ count: 1 });
    assert.deepEqual(f.tickets, [{ service: 'tipOff', method: 'getPskey', args: [['weiyun.com'], true] }]);
    const { url, options, request } = f.requests[0];
    assert.equal(url, protocol.ENDPOINT); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/octet-stream', Host: 'collector.weiyun.com', Cookie: 'uin=11111;vt=27;vi=synthetic-ticket;appid=5004', Range: 'bytes=0-' });
    assert.equal(request.timestamp, '18446744073709551615'); assert.equal(request.count, 1); assert.equal(f.requests.length, 1);
    assert.equal(result.collectionSearchList.collectionItemList[0].sequence, '18446744073709551614');
    assert.equal(result.collectionSearchList.collectionItemList[0].summary.textSummary.text, 'Real\ntext');
    assert.equal(JSON.stringify(result).includes('synthetic-ticket'), false);
});
test('category filtering advances the exact scan cursor without truncating a wire page', async () => {
    const f = fixture(); f.response(request => request.sequence === 1 ? wire.page([{ cid: 'other', category: 1, modifyTime: '900' }], { reachedBottom: 0 }) : wire.page([{ cid: 'wanted', category: 2, modifyTime: '800' }], { reachedBottom: 0, sequence: 2 }));
    const result = await f.action({ category: 2, count: 1, time_stamp: '1000' });
    assert.deepEqual(f.requests.map(entry => [entry.request.timestamp, entry.request.count]), [['1000', 1], ['900', 1]]);
    assert.equal(result.collectionSearchList.collectionItemList[0].cid, 'wanted'); assert.equal(result.collectionSearchList.bottomTimeStamp, '800'); assert.equal(result.collectionSearchList.hasMore, true);
    const g = fixture(); g.response(() => wire.page([])); assert.deepEqual((await g.action()).collectionSearchList, empty().collectionSearchList);
});

test('the observed uint32 terminal marker is a confirmed empty page while missing and zero markers fail', async () => {
    const f = fixture(); f.response(() => wire.page([], { reachedBottom: 215000, listExtra: [wire.n(2, 0)] }));
    assert.deepEqual(await f.action(), empty()); assert.equal(f.requests.length, 1);
    const g = fixture(); g.response(() => wire.page([], { reachedBottom: 0 }));
    await assert.rejects(g.action(), { code: 'INVALID_RESPONSE' }); assert.equal(g.requests.length, 1);
    const h = fixture(); h.response(() => wire.envelope(Buffer.concat([wire.n(1, 11111), wire.n(2, 1), wire.n(3, 2), wire.n(4, 20000), wire.n(101, 0)]), wire.b(2, wire.b(20000, wire.n(2, 0)))));
    await assert.rejects(h.action(), { code: 'INVALID_RESPONSE' }); assert.equal(h.requests.length, 1);
});
test('count100 uses two bounded pages and preserves all requested results', async () => {
    const f = fixture(); f.response(request => wire.page(Array.from({ length: 50 }, (_, i) => ({ cid: request.sequence + '-' + i, modifyTime: String(10000 - request.sequence * 100 - i) })), { reachedBottom: request.sequence === 1 ? 0 : 1, sequence: request.sequence }));
    assert.equal((await f.action({ count: 100 })).collectionSearchList.collectionItemList.length, 100); assert.deepEqual(f.requests.map(value => value.request.count), [50, 50]);
});
test('inputs and capability are checked before tickets or network requests', async () => {
    const f = fixture(); for (const params of [{ category: null }, { category: true }, { category: '01' }, { category: 4294967296 }, { count: 0 }, { count: 101 }, { count: 1.5 }, { time_stamp: '01' }, { time_stamp: '18446744073709551616' }, { time_stamp: 9007199254740992 }, { endpoint: 'other' }]) await assert.rejects(f.action(params), { code: 'INVALID_PARAMS' });
    f.capture.hasMethods = () => false; await assert.rejects(f.action(), { code: 'UNSUPPORTED' }); assert.equal(f.tickets.length, 0); assert.equal(f.requests.length, 0);
});
test('ticket and business failures remain explicit failures without retries or private diagnostics', async () => {
    const f = fixture(); for (const value of [undefined, { result: 5 }, { result: 0, domainPskeyMap: {} }, { result: 0, domainPskeyMap: new Map([['weiyun.com', 'invalid;ticket']]) }]) { f.ticket(() => value); await assert.rejects(f.action(), { code: 'AUTH_FAILED' }); }
    assert.equal(f.requests.length, 0); const g = fixture(); g.response(() => wire.page([], { retCode: -17 }));
    await assert.rejects(g.action(), error => error.code === 'KERNEL_ERROR' && error.message.includes('retCode=-17') && !error.message.includes('ticket')); assert.equal(g.requests.length, 1);
});
test('HTTP errors, redirects and oversized stream bodies fail without another destination or retry', async () => {
    for (const response of [new Response('', { status: 302, headers: { Location: 'https://example.invalid/' } }), new Response('', { status: 500 }), new Response('', { headers: { 'content-length': '999999999' } }), new Response('', { headers: { 'content-length': 'invalid' } }), new Response(Buffer.alloc(protocol.MAX_RESPONSE_BYTES + 1)), new Response('')]) {
        const f = fixture(); f.response(() => response); await assert.rejects(f.action(), error => ['QUERY_FAILED', 'INVALID_RESPONSE'].includes(error.code)); assert.equal(f.requests.length, 1);
    }
    const f = fixture(); f.response(() => { throw new Error('private synthetic-ticket'); }); await assert.rejects(f.action(), error => error.code === 'QUERY_FAILED' && !error.message.includes('synthetic-ticket'));
});
test('expired, cancelled or replaced sessions cannot dispatch or publish an old ticket result', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort(); await assert.rejects(f.query({}, { signal: controller.signal }), { code: 'EXPIRED' }); await assert.rejects(f.query({}, { expiresAt: Date.now() - 1 }), { code: 'EXPIRED' }); await assert.rejects(f.api.query({ expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' }); assert.equal(f.tickets.length, 0);
    let finish; f.ticket(() => new Promise(resolve => { finish = resolve; })); const pending = f.query(), rejected = assert.rejects(pending, { code: 'SESSION_CHANGED' }); await tick(); f.capture.epoch = 'e2'; finish({ result: 0, domainPskeyMap: new Map([['weiyun.com', 'synthetic-ticket']]) }); await rejected; assert.equal(f.requests.length, 0);
});

test('a completed HTTPS request cannot publish into a replacement identity or request sequence', async () => {
    const f = fixture(); let finish;
    f.response(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.query(), rejected = assert.rejects(pending, { code: 'SESSION_CHANGED' });
    await tick(); assert.equal(f.requests.length, 1);
    f.capture.self = { uin: '22222', uid: 'u_other' }; finish(wire.page()); await rejected;
    for (const expected of [{ uin: '22222' }, { sequence: 2 }]) {
        const g = fixture(); g.response(() => wire.page([], expected));
        await assert.rejects(g.action(), { code: 'INVALID_RESPONSE' }); assert.equal(g.requests.length, 1);
    }
});
test('unresolved ticket promises keep all four physical slots across cancellation and repeated session changes', async () => {
    const f = fixture(), finish = []; f.ticket(() => new Promise(resolve => finish.push(resolve)));
    for (let i = 0; i < 4; i++) { const controller = new AbortController(), pending = f.query({}, { signal: controller.signal }), rejected = assert.rejects(pending, { code: 'EXPIRED' }); await tick(); controller.abort(); await rejected; }
    for (let i = 0; i < 8; i++) { f.capture.epoch = 'replacement-' + i; f.capture.session = {}; await assert.rejects(f.query(), { code: 'BUSY' }); }
    assert.equal(f.tickets.length, 4); finish[0]({ result: 0, domainPskeyMap: new Map([['weiyun.com', 'synthetic-ticket']]) }); await tick(); f.ticket(() => ({ result: 0, domainPskeyMap: new Map([['weiyun.com', 'synthetic-ticket']]) })); assert.equal((await f.query()).page.errCode, 0); for (const resolve of finish.slice(1)) resolve({ result: 0, domainPskeyMap: new Map() }); await tick();
});
test('filtered scans stop after ten pages without reporting unproven empty success', async () => {
    const f = fixture(); f.response(request => wire.page([{ cid: String(request.sequence), category: 1, modifyTime: String(1000 - request.sequence) }], { reachedBottom: 0, sequence: request.sequence })); await assert.rejects(f.action({ category: 2, count: 1 }), { code: 'INVALID_RESPONSE' }); assert.equal(f.requests.length, 10);
});
test('OneBot validates business statuses and echoed RPC scope independently', async () => {
    for (const value of [undefined, null, true, NaN, -0, '00', '-0', '5x']) assert.throws(() => validateCollectionPage({ ...empty(), errCode: value }, { count: 50, category: 0, timeStamp: '0' }), { code: 'INVALID_RESPONSE' });
    assert.throws(() => validateCollectionPage({ ...empty(), errCode: 5, errMsg: 'private' }, { count: 50, category: 0, timeStamp: '0' }), error => error.code === 'KERNEL_ERROR' && !error.message.includes('private'));
    const f = fixture(); f.state.capabilities.collectionList = false; await assert.rejects(f.action(), { code: 'UNSUPPORTED' }); f.state.capabilities.collectionList = true; f.service.sessionCall = async () => ({ category: 1, count: 50, timeStamp: '0', page: empty() }); await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' }); await assert.rejects(runCollectionQueries(f.service, f.state, 'create_collection', {}), { code: 'UNSUPPORTED' });
});

test('the independent OneBot boundary bounds recursive and encoded JSON responses including status bytes', () => {
    const expected = { count: 50, category: 0, timeStamp: '0' };
    const valid = protocol.decodeResponse(wire.page()).items[0];
    const page = summary => ({ ...empty(), collectionSearchList: { collectionItemList: [{ ...valid, summary }], hasMore: false, bottomTimeStamp: valid.modifyTime } });
    const cyclic = {}; cyclic.self = cyclic;
    for (const summary of [cyclic, { value: '\ud800' }, { value: Number.MAX_SAFE_INTEGER + 1 }, { value: 'x'.repeat(2 * 1024 * 1024) }]) {
        assert.throws(() => validateCollectionPage(page(summary), expected), { code: 'INVALID_RESPONSE' });
    }
    let tailReads = 0;
    const values = ['x'.repeat(600000), 'x'.repeat(600000)];
    Object.defineProperty(values, 2, { enumerable: true, get() { tailReads++; throw new Error('Oversized tail must not be visited'); } });
    assert.throws(() => validateCollectionPage(page({ values }), expected), { code: 'INVALID_RESPONSE' }); assert.equal(tailReads, 0);
    const outcome = page({ text: '' }), limit = 1024 * 1024;
    const padding = limit - Buffer.byteLength(JSON.stringify(outcome.collectionSearchList)) - 8;
    outcome.collectionSearchList.collectionItemList[0].summary.text = 'x'.repeat(padding);
    assert.ok(Buffer.byteLength(JSON.stringify(outcome.collectionSearchList)) < limit);
    assert.ok(Buffer.byteLength(JSON.stringify(outcome)) > limit);
    assert.throws(() => validateCollectionPage(outcome, expected), { code: 'INVALID_RESPONSE' });
});
