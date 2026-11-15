'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
function record(overrides = {}) {
    return { chatType: 2, peerUid: '33333', peerUin: '33333', msgId: '18446744073709551612',
        msgSeq: '0', senderUid: '', senderUin: '0', msgType: 5, subMsgType: 12,
        msgTime: String(Math.floor(Date.now() / 1000)), elements: [{ elementType: 8, grayTipElement: {
            subElementType: 17, jsonGrayTipElement: { busiId: '1061', jsonStr: JSON.stringify({ items: [
                { type: 'qq', uid: 'u_actor' }, { type: 'img', src: 'not-used' }, { type: 'nor', txt: 'not-used' },
                { type: 'qq', uid: 'u_self', tp: '0' }, { type: 'nor', txt: '' }] }) } } }], ...overrides };
}
function fixture(t) {
    const directory = fs.mkdtempSync(path.resolve(__dirname, '../work/temp/poke-notice-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = new MessageStore({ directory }), logs = [], calls = [];
    const state = { epoch: 'session-1', ready: true, readyAt: Date.now() - 5000,
        self: { uin: '11111', uid: 'u_self' } };
    const ids = { u_actor: '22222', u_self: '11111', u_other: '44444' };
    const backend = { async call(method, params) {
        calls.push({ method, params });
        if (method === 'status') return structuredClone(state);
        assert.equal(method, 'resolve');
        assert.equal(params.expectedEpoch, state.epoch);
        return { uid: params.uid, uin: ids[params.uid] };
    } };
    const service = new OneBotService({ backend, store, logger: (event, details) => logs.push({ event, ...details }) });
    const event = value => ({ kind: 'notice', notice: 'gray_tip', epoch: state.epoch, selfUin: state.self.uin, record: value || record() });
    return { service, store, state, backend, calls, ids, logs, event };
}
test('native authorless group poke becomes a notice without allocating a message ID', async t => {
    const f = fixture(t), input = f.event();
    assert.deepEqual(await f.service.event(input), { time: Number(input.record.msgTime), self_id: 11111,
        post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 22222, target_id: 11111, group_id: 33333 });
    assert.equal(f.store.state('11111').nextId, 1);
    assert.equal(f.store.state('11111').byId.size, 0);
    assert.equal(f.logs[0].event, 'notice_received');
    assert.equal(JSON.stringify(f.logs).includes('not-used'), false);
});
test('old message envelopes route poke before ordinary sender and echo validation', async t => {
    const f = fixture(t);
    const result = await f.service.event({ ...f.event(), kind: 'message' });
    assert.equal(result.sub_type, 'poke');
    assert.equal(f.logs.some(log => log.event === 'message_skipped'), false);
});
test('poke deduplication handles parallel callbacks while retaining distinct zero-sequence events', async t => {
    const f = fixture(t), input = f.event();
    const results = await Promise.all([f.service.event(input), f.service.event(input)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await f.service.event(input), null);
    assert.equal((await f.service.event(f.event(record({ msgId: '18446744073709551613' })))).sub_type, 'poke');
    assert.equal(f.calls.filter(call => call.method === 'resolve').length, 4);
});
test('poke identity and deduplication stay isolated by account and epoch', async t => {
    const f = fixture(t), input = f.event();
    assert.ok(await f.service.event(input));
    assert.equal(await f.service.event({ ...input, epoch: 'another' }), null);
    assert.equal(await f.service.event({ ...input, selfUin: '99999' }), null);
    f.state.epoch = 'session-2';
    assert.ok(await f.service.event(f.event()));
    f.state.self = { uin: '44444', uid: 'u_other' };
    assert.equal((await f.service.event(f.event())).self_id, 44444);
    assert.equal(f.service.noticeSeen.size, 1);
});
test('incoming and outgoing private pokes preserve actual actor and target without group IDs', async t => {
    const f = fixture(t);
    const incoming = record({ chatType: 1, peerUid: 'u_actor', peerUin: '22222' });
    const result = await f.service.event(f.event(incoming));
    assert.equal(result.user_id, 22222); assert.equal(result.target_id, 11111);
    assert.equal(Object.hasOwn(result, 'group_id'), false);
    const outgoing = structuredClone(incoming);
    outgoing.msgId = '900';
    outgoing.elements[0].grayTipElement.jsonGrayTipElement.jsonStr = JSON.stringify({ items: [
        { type: 'qq', uid: 'u_self' }, { type: 'qq', uid: 'u_actor' }] });
    const sent = await f.service.event(f.event(outgoing));
    assert.equal(sent.user_id, 11111); assert.equal(sent.target_id, 22222);
});
test('private poke rejects unrelated conversations and inconsistent peer UINs', async t => {
    const f = fixture(t);
    for (const data of [{ peerUid: 'u_other', peerUin: '44444' }, { peerUid: 'u_actor', peerUin: '99999' },
        { peerUid: 'u_self', peerUin: '11111' }]) {
        assert.equal(await f.service.event(f.event(record({ chatType: 1, ...data }))), null);
    }
    assert.equal(f.store.state('11111').nextId, 1);
});
test('poke rejects stale, historical, future and inexact native identities', async t => {
    const f = fixture(t), now = Math.floor(Date.now() / 1000);
    for (const data of [{ msgTime: String(now - 120) }, { msgTime: String(now + 40) }, { sourceType: 3 },
        { msgTime: 'invalid' }, { msgId: 9007199254740992 }, { msgId: '0' }, { msgId: '18446744073709551616' },
        { peerUin: '99999' }]) assert.equal(await f.service.event(f.event(record(data))), null);
    f.state.readyAt = Date.now() + 1000;
    assert.equal(await f.service.event(f.event()), null);
    assert.equal(f.calls.some(call => call.method === 'resolve'), false);
});
test('failed or conflicting participant resolution emits no notice and does not poison retry deduplication', async t => {
    const f = fixture(t), original = f.backend.call;
    for (const bad of [{ uid: 'u_wrong', uin: '22222' }, { uid: 'u_actor', uin: '0' }, { uid: 'u_actor', uin: '11111' }]) {
        f.backend.call = async (method, params) => method === 'resolve' ? bad : original(method, params);
        assert.equal(await f.service.event(f.event()), null);
    }
    f.backend.call = async (method, params) => {
        if (method === 'resolve') throw Object.assign(new Error('private diagnostic'), { code: 'TIMEOUT' });
        return original(method, params);
    };
    assert.equal(await f.service.event(f.event()), null);
    assert.equal(f.service.noticeSeen.size, 0);
    f.backend.call = original;
    assert.ok(await f.service.event(f.event()));
    assert.equal(JSON.stringify(f.logs).includes('private diagnostic'), false);
});
test('session withdrawal during UID resolution prevents poke reporting', async t => {
    const f = fixture(t), original = f.backend.call;
    f.backend.call = async (method, params) => {
        const result = await original(method, params);
        if (method === 'resolve') f.state.ready = false;
        return result;
    };
    assert.equal(await f.service.event(f.event()), null);
    assert.equal(f.service.noticeSeen.size, 0);
});
test('notice deduplication is bounded and expires old entries', async t => {
    const f = fixture(t);
    await f.service.event(f.event());
    for (let index = 0; index < 1024; index++) f.service.noticeSeen.set('older-' + index, Date.now());
    assert.ok(await f.service.event(f.event(record({ msgId: '900' }))));
    assert.equal(f.service.noticeSeen.size, 1024);
    assert.equal(f.service.noticeSeen.has('older-0'), false);
    f.service.noticeSeen.set('expired', Date.now() - 61000);
    assert.ok(await f.service.event(f.event(record({ msgId: '901' }))));
    assert.equal(f.service.noticeSeen.has('expired'), false);
    assert.equal(f.service.noticeSeen.size, 1024);
});
test('unknown system tips and malformed poke JSON never become user messages or IDs', async t => {
    const f = fixture(t), unknown = record();
    unknown.elements[0].grayTipElement.jsonGrayTipElement.busiId = '9999';
    assert.equal(await f.service.event({ ...f.event(unknown), kind: 'message' }), null);
    const invalid = record(); invalid.elements[0].grayTipElement.jsonGrayTipElement.jsonStr = '{';
    assert.equal(await f.service.event(f.event(invalid)), null);
    assert.equal(f.store.state('11111').nextId, 1);
    assert.equal(f.logs[0].reason, 'unsupported_gray_tip');
    assert.equal(f.logs[1].reason, 'invalid_poke');
});
