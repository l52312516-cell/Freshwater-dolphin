'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createContactExtra } = require('../src/qq/contact-extra.cjs');
const { runContactExtraActions, ACTIONS, WRITE_ACTIONS } = require('../src/onebot/contact-extra-actions.cjs');
const fixed = require('../src/qq/contact-extra-protocol.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const doubt = () => ({ uid: 'u_person', uin: '54321', reqTime: '1794810000', nick: 'Person', msg: 'Hi' });
const group = (sequence = '18446744073709551614', eventType = 1) => ({ sequence, eventType, state: 1, groupId: '33333', groupName: 'Group', comment: 'Hi', target: { uin: '54321', name: 'Target' } });
function fixture() {
    const calls = [], reads = [];
    const capture = { epoch: 'e1', session: {}, self: { uin: '11111', uid: 'u_self' }, pending: new Set(),
        ensureReady() {}, deadline: Capture.prototype.deadline, hasMethods: () => true,
        resolve: async who => who.uid ? { ...who, uin: who.uid === 'u_person' ? '54321' : '65432' } : { ...who, uid: who.uin === '54321' ? 'u_person' : 'u_other' },
        invoke: async (service, method, args) => { reads.push({ service, method, args }); return { result: 0 }; } };
    let reply = async params => {
        if (params.operation === 'translate') return { words: params.request.words.map(word => '中' + word), sourceWords: [...params.request.words] };
        if (params.operation === 'unidirectional') return { items: [{ uin: '54321', uid: 'u_person', nick_name: 'Person' }], limit: 99, complete: false };
        if (params.operation === 'doubt.list') return { items: [doubt()], limit: params.request.count };
        if (params.operation === 'group.filtered') return { items: [group(), group('18446744073709551613', 2)], cursor: '0', filtered: true };
        return { confirmed: true, confirmation: 'server_ack', ...params.request };
    };
    const native = { available: () => true, run: async (_capture, params) => {
        assert.equal(params.op, 'fixedContactExtra'); assert.equal(params.expectedEpoch, capture.epoch); assert.equal(params.expectedUin, capture.self.uin);
        fixed.prepare(params.operation, params.request); calls.push(params); return reply(params);
    } };
    const api = createContactExtra(capture, { native });
    const state = { self: capture.self, capabilities: api.capabilities() };
    const service = { sessionCall: async (_state, method, params) => { assert.equal(method, 'contactExtra'); return api.execute({ ...params, expectedEpoch: capture.epoch }); } };
    return { capture, api, state, service, native, calls, reads,
        reply(value) { reply = value; }, execute: (params, context = {}) => api.execute({ ...params, expectedEpoch: capture.epoch }, context),
        action: (action, params = {}) => runContactExtraActions(service, state, action, params) };
}

test('all eight actions dispatch real fixed operations and mark-read uses its native method', async () => {
    const f = fixture(); assert.equal(ACTIONS.size, 8); assert.equal(WRITE_ACTIONS.size, 3);
    assert.deepEqual(await f.action('translate_en2zh', { words: ['hello', 'A\nB'] }), { words: ['中hello', '中A\nB'] });
    assert.deepEqual(await f.action('get_unidirectional_friend_list'), [{ uin: 54321, uid: 'u_person', nick_name: 'Person' }]);
    assert.deepEqual(await f.action('set_input_status', { user_id: 54321, event_type: 0 }), {});
    assert.equal(await f.action('_mark_all_as_read'), null);
    assert.deepEqual(f.reads, [{ service: 'msg', method: 'setAllC2CAndGroupMsgRead', args: [] }]);
    const ignored = await f.action('get_group_ignored_notifies'), adds = await f.action('get_group_ignore_add_request');
    assert.equal(ignored.length, 2); assert.equal(adds.length, 1);
    assert.equal(adds[0].request_id, '18446744073709551614'); assert.equal(adds[0].requester_uin, 54321);
    assert.equal(Object.hasOwn(adds[0], 'actor'), false, 'no operator account is fabricated');
    const requests = await f.action('get_doubt_friends_add_request');
    assert.match(requests[0].flag, /^fwd_doubt_[a-f0-9]{48}$/); assert.equal(requests[0].uid, 'u_person');
    assert.equal(await f.action('set_doubt_friends_add_request', { flag: requests[0].flag, approve: true }), null);
    assert.deepEqual(f.calls.at(-1).request, { targetUid: 'u_person', selfUid: 'u_self' });
    assert.equal(f.calls.filter(call => call.operation === 'doubt.list').length, 2, 'approval refreshes the separate filtered inbox first');
    await assert.rejects(f.action('set_doubt_friends_add_request', { flag: requests[0].flag }), { code: 'BUSY' });
});

test('all public and worker parameters are validated before any native dispatch', async () => {
    const f = fixture();
    for (const [action, params] of [['translate_en2zh', { words: [] }], ['translate_en2zh', { words: ['x'], endpoint: 'arbitrary' }],
        ['set_input_status', { user_id: true }], ['set_input_status', { user_id: 54321, event_type: -1 }], ['set_input_status', { user_id: 54321, event_type: null }],
        ['get_doubt_friends_add_request', { count: 0 }], ['get_doubt_friends_add_request', { count: 101 }], ['get_doubt_friends_add_request', { count: null }],
        ['set_doubt_friends_add_request', { flag: 'u_person' }], ['get_group_ignored_notifies', { filtered: false }], ['_mark_all_as_read', { peer: 'any' }]]) await assert.rejects(f.action(action, params), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.execute({ operation: 'group.filtered', command: 'raw' }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.api.execute({ operation: 'unidirectional', expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' });
    f.state.capabilities.translateEn2zh = false; await assert.rejects(f.action('translate_en2zh', { words: ['x'] }), { code: 'UNSUPPORTED' });
    f.native.available = () => false; await assert.rejects(f.execute({ operation: 'unidirectional' }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length + f.reads.length, 0);
});

test('rejection is its own fixed operation and failed acknowledgements never auto-retry', async () => {
    const f = fixture(), flag = (await f.action('get_doubt_friends_add_request'))[0].flag;
    assert.equal(await f.action('set_doubt_friends_add_request', { flag, approve: false }), null);
    assert.equal(f.calls.at(-1).operation, 'doubt.reject'); assert.deepEqual(f.calls.at(-1).request, { targetUid: 'u_person' });
    const g = fixture(), other = (await g.action('get_doubt_friends_add_request'))[0].flag;
    g.reply(async params => { if (params.operation === 'doubt.list') return { items: [doubt()] }; throw Object.assign(new Error('Fixed rejection'), { code: 'KERNEL_ERROR' }); });
    await assert.rejects(g.action('set_doubt_friends_add_request', { flag: other, approve: false }), { code: 'KERNEL_ERROR' });
    await assert.rejects(g.action('set_doubt_friends_add_request', { flag: other, approve: false }), { code: 'BUSY' });
    assert.equal(g.calls.filter(call => call.operation === 'doubt.reject').length, 1);
    g.capture.invoke = async () => undefined; await assert.rejects(g.action('_mark_all_as_read'), { code: 'KERNEL_ERROR' });
});

test('request flags require the same observed applicant, timestamp, account and session', async () => {
    const f = fixture(), flag = (await f.action('get_doubt_friends_add_request'))[0].flag;
    f.reply(async () => ({ items: [{ ...doubt(), reqTime: '1794810001' }] }));
    await assert.rejects(f.action('set_doubt_friends_add_request', { flag }), { code: 'NOT_FOUND' });
    assert.equal(f.calls.some(call => call.operation === 'doubt.approve'), false);
    f.capture.epoch = 'e2'; f.capture.session = {};
    await assert.rejects(f.action('set_doubt_friends_add_request', { flag }), { code: 'NOT_FOUND' });
    const g = fixture(); await assert.rejects(g.action('set_doubt_friends_add_request', { flag }), { code: 'NOT_FOUND' });
});

test('concurrent approvals dispatch one mutation and undated requests never mint actionable flags', async () => {
    const f = fixture(), flag = (await f.action('get_doubt_friends_add_request'))[0].flag;
    const results = await Promise.allSettled([f.action('set_doubt_friends_add_request', { flag }), f.action('set_doubt_friends_add_request', { flag })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(f.calls.filter(call => call.operation === 'doubt.approve').length, 1);
    const g = fixture(); g.reply(async () => ({ items: [{ ...doubt(), reqTime: '0' }] }));
    assert.equal((await g.action('get_doubt_friends_add_request'))[0].flag, null);
});

test('numeric applicants are resolved with the account field and never with request time', async () => {
    const f = fixture(), resolutions = [];
    f.capture.resolve = async value => { resolutions.push(value); return { uin: '54321', uid: 'u_person' }; };
    f.reply(async () => ({ items: [{ uin: '54321', reqTime: '1794810000' }] }));
    const result = await f.action('get_doubt_friends_add_request');
    assert.deepEqual(resolutions, [{ uin: '54321' }]); assert.equal(result[0].user_id, 54321); assert.ok(result[0].flag);
});

test('filtered group pagination is complete, bounded and never substitutes the main inbox', async () => {
    const f = fixture(); f.reply(async params => ({ items: [group(params.request.cursor === '0' ? '999' : '998')], cursor: params.request.cursor === '0' ? '100' : '0', filtered: true }));
    assert.equal((await f.action('get_group_ignore_add_request')).length, 2);
    assert.deepEqual(f.calls.map(call => [call.operation, call.request]), [['group.filtered', { count: 100, cursor: '0' }], ['group.filtered', { count: 100, cursor: '100' }]]);
    const g = fixture(); let sequence = 1000;
    g.reply(async () => ({ items: [group(String(sequence--))], cursor: String(sequence), filtered: true }));
    await assert.rejects(g.action('get_group_ignored_notifies'), { code: 'QUERY_FAILED' }); assert.equal(g.calls.length, 10);
    const h = fixture(); h.reply(async () => ({ items: [group()], cursor: '1', filtered: true }));
    await assert.rejects(h.action('get_group_ignored_notifies'), { code: 'INVALID_RESPONSE' });
});

test('late native results are isolated and physical slots survive caller aborts and session changes', async () => {
    const f = fixture(), finish = [];
    f.reply(() => new Promise(resolve => finish.push(resolve)));
    for (let index = 0; index < 8; index++) {
        const controller = new AbortController(), pending = f.execute({ operation: 'unidirectional' }, { signal: controller.signal });
        const rejected = assert.rejects(pending, { code: 'EXPIRED' }); await tick(); controller.abort(); await rejected;
    }
    for (let index = 0; index < 3; index++) { f.capture.epoch = 'new-' + index; f.capture.session = {}; await assert.rejects(f.execute({ operation: 'unidirectional' }), { code: 'BUSY' }); }
    assert.equal(f.calls.length, 8);
    finish[0]({ items: [], limit: 99, complete: false }); await tick();
    f.reply(async () => ({ items: [], limit: 99, complete: false }));
    assert.deepEqual((await f.execute({ operation: 'unidirectional' })).result.items, []);
    for (const resolve of finish.slice(1)) resolve({ items: [], limit: 99, complete: false }); await tick();
    const g = fixture(); let done; g.reply(() => new Promise(resolve => { done = resolve; }));
    const pending = g.execute({ operation: 'unidirectional' }), rejected = assert.rejects(pending, { code: 'SESSION_CHANGED' });
    await tick(); g.capture.self = { uin: '22222', uid: 'u_other' }; done({ items: [], limit: 99, complete: false }); await rejected;
});

test('OneBot independently checks identity, scope, word pairing, list types and ACK echoes', async () => {
    const f = fixture();
    f.service.sessionCall = async () => ({ operation: 'unidirectional', selfUin: '22222', result: { items: [], limit: 99, complete: false } });
    await assert.rejects(f.action('get_unidirectional_friend_list'), { code: 'INVALID_RESPONSE' });
    f.service.sessionCall = async () => ({ operation: 'translate', selfUin: '11111', result: { words: ['中'], sourceWords: ['wrong'] } });
    await assert.rejects(f.action('translate_en2zh', { words: ['hello'] }), { code: 'INVALID_RESPONSE' });
    f.service.sessionCall = async () => ({ operation: 'group.filtered', selfUin: '11111', result: { items: [], complete: true, filtered: false } });
    await assert.rejects(f.action('get_group_ignored_notifies'), { code: 'INVALID_RESPONSE' });
    f.service.sessionCall = async () => ({ operation: 'input.status', selfUin: '11111', result: { confirmed: true, confirmation: 'server_ack', uin: '65432', targetUid: 'u_other', eventType: 0 } });
    await assert.rejects(f.action('set_input_status', { user_id: '54321' }), { code: 'INVALID_RESPONSE' });
});
