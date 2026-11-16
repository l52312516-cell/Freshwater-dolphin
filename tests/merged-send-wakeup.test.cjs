'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createMergedSend } = require('../src/qq/merged-send.cjs');

// The root callback may already be queued when the candidate wait is about to
// start. Capture.deadline defers its operation to a microtask, so this exercises
// the real boundary between observing a root and installing a wake callback.
test('a merged root queued before the candidate waiter starts is consumed without a second update', async t => {
    const self = { uid: 'u_wakeup_self', uin: '1000000001' };
    const destination = { chatType: 2, peerUid: '2000000001' };
    const epoch = 'merged-wakeup-session';
    const sourceId = '18446744073709551001';
    const rootId = '18446744073709551500';
    const childId = '18446744073709551200';
    const content = ' before\n after ';
    const records = new Map();
    const calls = [];
    let mergeArgs, rootEmitted = false, deadlinesAfterMerge = 0;
    const capture = new Capture({ install: false, qqVersion: '3.2.35-54395', audioProcessor: {}, videoProcessor: {} });
    capture.ready = true;
    capture.epoch = epoch;
    capture.self = { ...self };
    t.after(() => capture.close());

    const native = {
        generateMsgUniqueId() { return '80001'; },
        sendMsg(_zero, target, elements) {
            calls.push('stage');
            const record = {
                chatType: target.chatType, peerUid: target.peerUid, guildId: target.guildId,
                msgId: sourceId, msgSeq: '9007199254740994', msgRandom: '300001', msgTime: '1794636400',
                senderUid: self.uid, senderUin: self.uin, sendStatus: 2, sendNickName: 'Actual QQ name',
                elements: structuredClone(elements)
            };
            records.set(sourceId, record);
            capture.bus.emit('sent', [record]);
            return { result: 0 };
        },
        getMsgsByMsgId(_target, ids) {
            calls.push(ids[0] === rootId ? 'read-root' : 'read-source');
            return { result: 0, msgList: ids.map(id => structuredClone(records.get(id))) };
        },
        multiForwardMsgWithComment(...args) {
            calls.push('merge');
            mergeArgs = args;
            return { result: 0 };
        },
        getMultiMsg(_target, id, parent) {
            calls.push('read-resource');
            assert.equal(id, rootId);
            assert.equal(parent, rootId);
            return { result: 0, msgList: [{ ...structuredClone(records.get(sourceId)), msgId: childId }] };
        }
    };
    capture.session = {
        getMsgService: () => native,
        getMSFService: () => ({ getServerTime: () => '1794636400' })
    };

    const originalDeadline = capture.deadline.bind(capture);
    capture.deadline = (operation, ...args) => {
        // After native submission the first deadline awaits its acceptance;
        // the next starts the no-candidate wait. Queue the sole root before
        // that real deadline schedules its operation. Do not emit another
        // update to accidentally wake an already-lost notification.
        if (mergeArgs && ++deadlinesAfterMerge === 2) {
            queueMicrotask(() => {
                assert.equal(rootEmitted, false);
                rootEmitted = true;
                const root = {
                    ...mergeArgs[2], msgId: rootId, senderUid: self.uid, senderUin: self.uin, sendStatus: 2,
                    elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'wakeup-resource' } }]
                };
                records.set(rootId, root);
                capture.bus.emit('sent', [root]);
            });
        }
        return originalDeadline(operation, ...args);
    };

    const result = await createMergedSend(capture).run({
        expectedEpoch: epoch, destination, timeoutMs: 2000,
        nodes: [{ nickname: 'Display hint', elements: [{ elementType: 1, textElement: { content, atType: 0 } }] }]
    });
    assert.equal(rootEmitted, true);
    assert.equal(result.confirmed, true);
    assert.equal(result.messageId, rootId);
    assert.equal(result.records[0].msgId, childId);
    assert.equal(result.records[0].elements[0].textElement.content, content);
    assert.equal(calls.filter(method => method === 'stage').length, 1);
    assert.equal(calls.filter(method => method === 'merge').length, 1);
    assert.equal(calls.filter(method => method === 'read-root').length, 1);
    assert.equal(calls.filter(method => method === 'read-resource').length, 1);
    assert.equal(capture.bus.listenerCount('sent'), 0);
});
