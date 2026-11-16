'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { createFlashDelete } = require('../src/qq/flash-delete.cjs');
const ID = '11111111-2222-3333-4444-555555555555';
function fixture() {
    const calls = []; let reply = request => ({ rsp: { seq: request.seq, result: 0, errMs: '' } });
    const service = { batchRemoveUserFileSetHistory: async request => { calls.push(request); return reply(request); } };
    const capture = { ensureReady() {}, session: { getFlashTransferService: () => service } };
    return { calls, capture, api: createFlashDelete(capture), reply(fn) { reply = fn; } };
}

test('native history deletion calls one fixed method with one ID and no cancellation targets', async () => {
    const f = fixture(); assert.equal(f.api.available(), true);
    assert.deepEqual(await f.api.remove(ID), { filesetId: ID, confirmed: true, confirmation: 'native_history_ack' });
    assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].fileSetIdList, [ID]);
    assert.deepEqual(f.calls[0].cancelFileSetIdList, []); assert.equal(f.calls[0].cancelOnDeleteUserRecords, false);
    assert.ok(Number.isInteger(f.calls[0].seq) && f.calls[0].seq > 0 && f.calls[0].seq <= 0x7fffffff);
    const previous = f.calls[0].seq; await f.api.remove(ID); assert.notEqual(f.calls[1].seq, previous);
    await assert.rejects(f.api.remove('../other'), { code: 'INVALID_PARAMS' }); assert.equal(f.calls.length, 2);
});

test('native history deletion requires exact response sequence, typed status and errMs schema', async () => {
    const cases = [request => ({ rsp: { seq: request.seq + 1, result: 0, errMs: '' } }),
        request => ({ rsp: { seq: request.seq, result: '0', errMs: '' } }),
        request => ({ rsp: { seq: request.seq, result: 0, errMsg: '' } }),
        request => ({ rsp: { seq: request.seq, result: 0, errMs: 'x'.repeat(4097) } }),
        request => ({ rsp: { seq: request.seq, result: 0, errMs: '', extra: true } }),
        request => ({ seq: request.seq, result: 0, errMs: '' })];
    for (const reply of cases) {
        const f = fixture(); f.reply(reply); await assert.rejects(f.api.remove(ID), { code: 'INVALID_RESPONSE' }); assert.equal(f.calls.length, 1);
    }
    const rejected = fixture(); rejected.reply(request => ({ rsp: { seq: request.seq, result: 25, errMs: 'private-server-message' } }));
    await assert.rejects(rejected.api.remove(ID), error => error.code === 'KERNEL_ERROR' && !error.message.includes('private-server-message'));
});

test('native history deletion fails closed without its service or after account invalidation', async () => {
    const f = fixture(); f.capture.session = {}; assert.equal(f.api.available(), false);
    await assert.rejects(f.api.remove(ID), { code: 'UNSUPPORTED' }); assert.equal(f.calls.length, 0);
    const g = fixture(); let checks = 0;
    await assert.rejects(g.api.remove(ID, () => { if (++checks > 1) throw Object.assign(new Error('changed'), { code: 'SESSION_CHANGED' }); }), { code: 'SESSION_CHANGED' });
    assert.equal(g.calls.length, 1);
});
