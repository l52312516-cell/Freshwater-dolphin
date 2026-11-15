'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
function setup(t) {
    let records = [], calls = 0;
    const msg = { getMsgByClientSeqAndTime(peer, seq, time) {
        calls++; assert.deepEqual(peer, { chatType: 1, peerUid: 'u_peer' }); assert.equal(seq, '428'); assert.equal(time, '1794621690');
        return { result: 0, msgList: records };
    } };
    const capture = new Capture({ install: false, processObject: { env: {} } });
    capture.resetSession({ getMsgService: () => msg }, { selfUin: '123', selfUid: 'u_self', clientVer: TARGET_VERSION }); capture.ready = true;
    t.after(() => capture.close());
    const params = { peer: { chatType: 1, peerUid: 'u_peer' }, clientSeq: '428', time: '1794621690', senderUid: 'u_author' };
    const record = { chatType: 1, peerUid: 'u_peer', msgId: '7707841464180459071', clientSeq: '428', msgTime: '1794621690', senderUid: 'u_author' };
    return { capture, params, record, set: value => { records = value; }, calls: () => calls };
}
test('private sequence queries require matching author, time and conversation', async t => {
    const f = setup(t);
    f.set([{ ...f.record, senderUid: 'u_other' }, { ...f.record, msgTime: '1794621689' }, { ...f.record, peerUid: 'u_other' }, f.record]);
    assert.deepEqual(await f.capture.call('getMessage', f.params), f.record); assert.equal(f.calls(), 1);
    f.set([{ ...f.record, senderUid: 'u_other' }]); await assert.rejects(f.capture.call('getMessage', f.params), { code: 'NOT_FOUND' });
    f.set([f.record, { ...f.record, msgId: '7707841464180459072' }]); await assert.rejects(f.capture.call('getMessage', f.params), { code: 'INVALID_RESPONSE' });
});
test('private local sequences never fall back to a global sequence or omit required identity fields', async t => {
    const f = setup(t);
    for (const override of [{ senderUid: '0' }, { senderUid: undefined }, { time: undefined }, { time: 1794621690 }, { clientSeq: 428 }, { peer: { chatType: 2, peerUid: '200' } }]) {
        await assert.rejects(f.capture.call('getMessage', { ...f.params, ...override }), { code: 'INVALID_PARAMS' });
    }
    assert.equal(f.calls(), 0);
});
