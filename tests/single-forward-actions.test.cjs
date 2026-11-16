'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { OneBotService } = require('../src/onebot/service.cjs');
const { runSingleForward } = require('../src/onebot/single-forward-actions.cjs');
function fixture() {
    const calls = [], state = { ready: true, epoch: 'e', self: { uin: '12345', uid: 'u_self' }, capabilities: { text: true, reply: true } };
    const service = new OneBotService({ store: {}, backend: { call: async method => { assert.equal(method, 'status'); return structuredClone(state); } } });
    service.record = async (_state, id, _peer, options) => { calls.push(['record', id, options]); return { chatType: 2, peerUid: '33333', msgId: '18446744073709551614', msgSeq: '77', msgTime: '1794810000', elements: [{ elementType: 1, textElement: { content: 'Source', atType: 0 } }] }; };
    service.convert = async () => ({ message: [{ type: 'text', data: { text: 'Source' } }] });
    service.send = async (_state, params, action) => { calls.push(['send', params, action]); return { message_id: 42 }; };
    return { service, state, calls };
}
test('both single forwards cross actual OneBot action dispatch, refresh source and return exact delivery ID', async () => {
    for (const [action, key, send] of [['forward_group_single_msg', 'group_id', 'send_group_msg'], ['forward_friend_single_msg', 'user_id', 'send_private_msg']]) {
        const f = fixture(), result = await f.service.action({ action, params: { message_id: -12, [key]: 54321 }, echo: 'same' });
        assert.equal(result.retcode, 0, JSON.stringify(result)); assert.deepEqual(result.data, { message_id: 42 }); assert.equal(result.echo, 'same');
        assert.deepEqual(f.calls, [['record', -12, { refresh: true }], ['send', { [key]: 54321, message: [{ type: 'text', data: { text: 'Source' } }] }, send]]);
    }
});
test('single forward rejects invalid IDs, wrong account, mixed unsupported content and changed sessions before delivery', async () => {
    const f = fixture();
    for (const params of [{ group_id: true, message_id: 1 }, { group_id: 54321, message_id: 0 }, { group_id: 54321, message_id: 1, user_id: 54321 }, { group_id: 54321, message_id: 1, self_id: 99999 }]) assert.notEqual((await f.service.action({ action: 'forward_group_single_msg', params })).retcode, 0);
    assert.equal(f.calls.length, 0);
    f.service.record = async () => ({ chatType: 2, peerUid: '33333', msgId: '99', elements: [{ elementType: 1 }, { elementType: 16 }] });
    await assert.rejects(runSingleForward(f.service, f.state, 'forward_group_single_msg', { group_id: 54321, message_id: 1 }), { code: 'UNSUPPORTED' });
    f.service.record = fixture().service.record;
    f.service.convert = async () => { f.state.epoch = 'changed'; return { message: [{ type: 'text', data: { text: 'Source' } }] }; };
    assert.notEqual((await f.service.action({ action: 'forward_group_single_msg', params: { group_id: 54321, message_id: 1 } }, { selfUin: '12345', epoch: 'e' })).retcode, 0);
    assert.equal(f.calls.filter(row => row[0] === 'send').length, 0);
});
