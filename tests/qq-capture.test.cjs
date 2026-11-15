'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const { METHODS: RPC_METHODS } = require('../src/ipc/common.cjs');

function fixture(options = {}) {
  const listeners = {};
  let completion, nextId = 0;
  const profile = {
    addKernelProfileListener(value) { listeners.profile = value; return 1; },
    removeKernelProfileListener() { listeners.profile = null; },
    getUidByUin(_source, values) { return new Map(values.map(uin => [uin, `u_${uin}`])); },
    getUinByUid(_source, values) { return new Map(values.map(uid => [uid, uid.slice(2)])); },
    async getCoreAndBaseInfo(_source, uids) { return new Map(uids.map(uid => [uid, {
      uid, uin: uid.slice(2), coreInfo: { nick: `User ${uid}`, remark: '' }, baseInfo: { age: 22, sex: 1 }
    }])); }
  };
  const msg = {
    addKernelMsgListener(value) { listeners.msg = value; return 2; },
    removeKernelMsgListener() { listeners.msg = null; },
    generateMsgUniqueId() { return String(++nextId); },
    async sendMsg(_zero, peer, elements) {
      const record = { ...peer, msgId: '999999999999999999', senderUin: '123', sendStatus: 2, elements };
      listeners.msg.onMsgInfoListUpdate([record]);
      return { result: 0 };
    },
    async getMsgsByMsgId(peer, ids) { return { result: 0, msgList: [{ ...peer, msgId: ids[0] }] }; }
  };
  const group = {
    addKernelGroupListener(value) { listeners.group = value; return 3; },
    removeKernelGroupListener() { listeners.group = null; },
    getGroupList() {
      listeners.group.onGroupListUpdate(0, [{ groupCode: '200', groupName: 'Test', memberNum: 3, maxMemberNum: 200 }]);
      return Promise.resolve({ result: 0 });
    },
    getGroupDetailInfo(code) {
      listeners.group.onGroupDetailInfoChange({ groupCode: code, groupName: 'Test', memberNum: 3 });
      return Promise.resolve({ result: 0 });
    },
    getMemberInfo(code, uids) {
      listeners.group.onMemberInfoChange(code, 0, new Map(uids.map(uid => [uid, {
        uid, uin: uid.slice(2), nick: 'Member', cardName: 'Card', role: 3
      }])));
      return Promise.resolve({ result: 0 });
    }
  };
  const session = {
    init(config, _depends, _dispatcher, handler) {
      assert.equal(this, session); completion = handler;
      if (options.initCallbackArgs) handler.onSessionInitComplete(...options.initCallbackArgs);
      if (options.initThrows) throw options.initThrows;
      return Object.hasOwn(options, 'initReturn') ? options.initReturn : 'original-init-result';
    },
    getMsgService() { return msg; }, getProfileService() { return profile; }, getGroupService() { return group; },
    getMSFService() { return { getServerTime: () => '1000' }; },
    getBuddyService() { return { getBuddyListV2: async () => ({ result: 0, data: [{ buddyUids: ['u_123'] }] }) }; }
  };
  const factory = { create() { assert.equal(this, factory); return session; } };
  if (options.frozenFactory) Object.freeze(factory);
  const processObject = { env: {}, dlopen(module) { module.exports = { NodeIQQNTWrapperSession: factory }; return 41; } };
  const capture = new Capture({ processObject, ...options });
  const nativeModule = {};
  assert.equal(processObject.dlopen(nativeModule, '/app/wrapper.node'), 41);
  assert.equal(nativeModule.exports.NodeIQQNTWrapperSession.create(), session);
  function init(version = TARGET_VERSION) {
    const config = { selfUin: '123', selfUid: 'u_123', clientVer: version, d2Key: 'must-not-be-retained' };
    const callback = { onSessionInitComplete() { assert.equal(this, callback); return 'original-callback-result'; } };
    if (options.frozenCompletion) Object.freeze(callback);
    assert.equal(session.init(config, {}, {}, callback), Object.hasOwn(options, 'initReturn') ? options.initReturn : 'original-init-result');
    return () => assert.equal(completion.onSessionInitComplete({ result: 0 }), 'original-callback-result');
  }
  return { capture, session, msg, profile, group, listeners, init, processObject, factory,
    complete: (...args) => completion.onSessionInitComplete(...args) };
}

test('send observation preserves early callback order without publishing a business message', () => {
  const f = fixture(), order = [], events = [];
  try {
    f.init()(); f.capture.publish = event => events.push(event);
    f.capture.bus.on('sendObservation', value => { order.push(value.callback); assert.equal(value.records[0].msgId, '123'); });
    f.capture.bus.on('sent', () => order.push('sent'));
    const record = { chatType: 2, peerUid: '200', msgId: '123', sendStatus: 3, elements: [] };
    f.listeners.msg.onAddSendMsg(record); f.listeners.msg.onMsgInfoListUpdate([record]);
    assert.deepEqual(order, ['onAddSendMsg', 'onMsgInfoListUpdate', 'sent']); assert.deepEqual(events, []);
  } finally { f.capture.close(); }
});

test('observes natural initialization without changing session identity or retaining tickets', async () => {
  const f = fixture();
  try {
    const complete = f.init();
    assert.equal((await f.capture.call('status')).ready, false);
    assert.equal(f.listeners.msg, undefined);
    complete();
    const status = await f.capture.call('status');
    assert.equal(status.ready, true);
    assert.equal(status.online, null);
    assert.equal(status.self.uin, '123');
    assert.equal(status.capabilities.messages, true);
    assert.ok(!JSON.stringify(status).includes('must-not-be-retained'));
    f.listeners.profile.onSelfStatusChanged({ uid: 'u_other', status: 10 });
    assert.equal((await f.capture.call('status')).online, null);
    f.listeners.profile.onSelfStatusChanged({ uid: 'u_123', status: 10 });
    assert.equal((await f.capture.call('status')).online, true);
    f.listeners.msg.onKickedOffLine({});
    assert.equal((await f.capture.call('status')).online, false);
  } finally { f.capture.close(); }
});

test('fixed methods reject unknown versions and arbitrary execution', async () => {
  const f = fixture();
  try {
    f.init('3.2.99-99999')();
    assert.equal((await f.capture.call('status')).capabilities.compatible, false);
    await assert.rejects(f.capture.call('friends'), { code: 'UNSUPPORTED' });
    await assert.rejects(f.capture.call('exec', { code: 'process.exit()' }), { code: 'UNSUPPORTED' });
  } finally { f.capture.close(); }
});

test('removed QR RPCs stay unavailable and capture does not access the official login service', async () => {
  let loginAccesses = 0;
  const capture = new Capture({ install: false });
  try {
    const exports = {};
    Object.defineProperty(exports, 'NodeIKernelLoginService', { get() { loginAccesses++; throw new Error('Login service must remain untouched'); } });
    assert.equal(capture.observeExports(exports), exports);
    assert.equal(capture.observeExports(exports), exports);
    assert.equal(loginAccesses, 0);
    for (const method of ['loginState', 'loginQr']) {
      assert.equal(RPC_METHODS.has(method), false);
      await assert.rejects(capture.call(method), { code: 'UNSUPPORTED' });
    }
    assert.equal((await capture.call('status')).ready, false);
    assert.equal(Object.hasOwn(capture, 'login'), false);
  } finally { capture.close(); }
});

test('queries install group waiters before synchronous kernel callbacks', async () => {
  const f = fixture();
  try {
    f.init()();
    assert.deepEqual(await f.capture.call('groups'), [{ group_id: 200, group_name: 'Test', member_count: 3, max_member_count: 200 }]);
    assert.equal((await f.capture.call('groupInfo', { groupId: '200' })).group_name, 'Test');
    const member = await f.capture.call('groupMember', { groupId: '200', uin: '456' });
    assert.equal(member.user_id, 456);
    assert.equal(member.card, 'Card');
    assert.equal(member.role, 'admin');
    assert.equal(f.capture.bus.listenerCount('groupMember'), 0);
  } finally { f.capture.close(); }
});

test('UIN mapping and real buddy details remain distinct from kernel UIDs', async () => {
  const f = fixture();
  try {
    f.init()();
    assert.deepEqual(await f.capture.call('resolve', { uin: '456' }), { uin: '456', uid: 'u_456' });
    assert.equal((await f.capture.call('user', { uid: 'u_456' })).user_id, 456);
    assert.deepEqual(await f.capture.call('friends'), [{ user_id: 123, uid: 'u_123', nickname: 'User u_123', remark: '', age: 22, sex: 'male' }]);
    await assert.rejects(f.capture.call('sendMessage', { expectedEpoch: f.capture.epoch, peer: { chatType: 1, peerUid: '456' }, elements: [{ elementType: 1 }] }), { code: 'INVALID_PARAMS' });
  } finally { f.capture.close(); }
});

test('receives only raw incoming events; send confirmations do not become received messages', async () => {
  const f = fixture();
  try {
    f.init()();
    const events = [];
    f.capture.on('event', event => { if (event.kind === 'message') events.push(event); });
    const record = { chatType: 1, peerUid: 'u_456', senderUid: 'u_456', senderUin: '456', msgId: '9007199254740993' };
    f.listeners.msg.onRecvMsg([record]);
    f.listeners.msg.onMsgInfoListUpdate([record]);
    assert.equal(events.length, 1);
    assert.equal(events[0].record, record);
  } finally { f.capture.close(); }
});

test('send succeeds only after status 2 from matching peer; status 3 is not delivery', async () => {
  const f = fixture();
  try {
    f.init()();
    let calls = 0;
    f.msg.sendMsg = async (_zero, peer) => {
      calls++;
      const record = { ...peer, msgId: '1234567890123456789', senderUin: '123', sendStatus: 3 };
      f.listeners.msg.onMsgInfoListUpdate([record, { ...record, sendStatus: 2, peerUid: 'u_wrong' }]);
      setTimeout(() => f.listeners.msg.onMsgInfoListUpdate([{ ...record, sendStatus: 2 }]), 10);
      return { result: 0 };
    };
    const request = { expectedEpoch: f.capture.epoch, peer: { chatType: 1, peerUid: 'u_456' }, elements: [{ elementType: 1, textElement: { content: 'same' } }] };
    assert.equal((await f.capture.call('sendMessage', request)).sendStatus, 2);
    assert.equal((await f.capture.call('sendMessage', request)).sendStatus, 2);
    assert.equal(calls, 2);
    assert.equal(f.capture.bus.listenerCount('sent'), 0);
  } finally { f.capture.close(); }
});

test('send timeout preserves unknown delivery, cleans listeners, and does not retry', async () => {
  const f = fixture();
  try {
    f.init()();
    let calls = 0;
    f.msg.sendMsg = async (_zero, peer) => {
      calls++; f.listeners.msg.onMsgInfoListUpdate([{ ...peer, msgId: '123', senderUin: '123', sendStatus: 3 }]);
      return { result: 0 };
    };
    await assert.rejects(f.capture.call('sendMessage', { expectedEpoch: f.capture.epoch, peer: { chatType: 2, peerUid: '200' }, elements: [{ elementType: 1 }], timeoutMs: 20 }), { code: 'TIMEOUT' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(f.capture.bus.listenerCount('sent'), 0);
  } finally { f.capture.close(); }
});

test('session switch rejects pending sends and makes previous callbacks passive', async () => {
  const f = fixture();
  try {
    f.init()();
    f.msg.sendMsg = async () => ({ result: 0 });
    const oldListener = f.listeners.msg;
    const previousEpoch = (await f.capture.call('status')).epoch;
    const pending = f.capture.call('sendMessage', { expectedEpoch: f.capture.epoch, peer: { chatType: 1, peerUid: 'u_456' }, elements: [{ elementType: 1 }] });
    await new Promise(resolve => setImmediate(resolve));
    f.init()();
    await assert.rejects(pending, { code: 'SESSION_CHANGED' });
    assert.notEqual((await f.capture.call('status')).epoch, previousEpoch);
    const events = [];
    f.capture.on('event', event => events.push(event));
    oldListener.onRecvMsg([{ chatType: 1, peerUid: 'u_456' }]);
    assert.deepEqual(events, []);
  } finally { f.capture.close(); }
});

test('message retrieval requires exact peer and native ID', async () => {
  const f = fixture();
  try {
    f.init()();
    const query = { peer: { chatType: 1, peerUid: 'u_456' }, nativeId: '90071992547409931234' };
    assert.equal((await f.capture.call('getMessage', query)).msgId, query.nativeId);
    f.msg.getMsgsByMsgId = async () => ({ result: 0, msgList: [{ chatType: 1, peerUid: 'u_other', msgId: query.nativeId }] });
    await assert.rejects(f.capture.call('getMessage', query), { code: 'NOT_FOUND' });
    f.msg.getMsgsByMsgId = async () => ({ result: 0, msgList: [
      { ...query.peer, msgId: query.nativeId, senderUin: '456' }, { ...query.peer, msgId: query.nativeId, senderUin: '789' }
    ] });
    await assert.rejects(f.capture.call('getMessage', query), { code: 'INVALID_RESPONSE' });
  } finally { f.capture.close(); }
});

test('closing capture restores owned loader and method hooks', () => {
  const f = fixture();
  const hooked = f.processObject.dlopen;
  f.init()();
  f.capture.close();
  assert.notEqual(f.processObject.dlopen, hooked);
  assert.equal(f.listeners.msg, null);
  assert.equal(f.factory.create(), f.session);
  f.capture.close();
});

test('frozen native factory and completion callback remain observable without changing session', async () => {
  const f = fixture({ frozenFactory: true, frozenCompletion: true });
  try {
    f.init()();
    assert.equal((await f.capture.call('status')).ready, true);
    assert.equal(f.capture.session, f.session);
  } finally { f.capture.close(); }
});

test('messages include authenticated account and epoch; invisible status remains online', async () => {
  const f = fixture();
  try {
    f.init()();
    const events = [];
    f.capture.on('event', event => events.push(event));
    f.listeners.msg.onRecvMsg([{ chatType: 2, peerUid: '200', msgId: '123' }]);
    assert.equal(events[0].epoch, f.capture.epoch);
    assert.equal(events[0].selfUin, '123');
    f.listeners.profile.onSelfStatusChanged({ uid: 'u_123', status: 11 });
    assert.equal((await f.capture.call('status')).online, true);
  } finally { f.capture.close(); }
});

test('missing or old expectedEpoch cannot send even when a new session is ready', async () => {
  const f = fixture();
  try {
    f.init()();
    let sends = 0;
    f.msg.sendMsg = async () => { sends++; return { result: 0 }; };
    const request = { peer: { chatType: 1, peerUid: 'u_456' }, elements: [{ elementType: 1 }] };
    await assert.rejects(f.capture.call('sendMessage', request), { code: 'SESSION_CHANGED' });
    const expectedEpoch = f.capture.epoch;
    f.init()();
    await assert.rejects(f.capture.call('sendMessage', { ...request, expectedEpoch }), { code: 'SESSION_CHANGED' });
    assert.equal(sends, 0);
  } finally { f.capture.close(); }
});

test('cancelled send does not reach QQ after an asynchronous pre-send lookup', async () => {
  const f = fixture();
  try {
    f.init()();
    const controller = new AbortController();
    let sends = 0;
    f.msg.generateMsgUniqueId = async () => { controller.abort(); return '123'; };
    f.msg.sendMsg = async () => { sends++; return { result: 0 }; };
    await assert.rejects(f.capture.call('sendMessage', { expectedEpoch: f.capture.epoch,
      peer: { chatType: 1, peerUid: 'u_456' }, elements: [{ elementType: 1 }] }, { signal: controller.signal }), { code: 'EXPIRED' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sends, 0);
  } finally { f.capture.close(); }
});

test('message listener registration retries after a late QQ service becomes available', async () => {
  const f = fixture();
  try {
    const original = f.session.getMsgService;
    f.session.getMsgService = () => null;
    f.init()();
    assert.equal((await f.capture.call('status')).capabilities.messages, false);
    f.session.getMsgService = original;
    await new Promise(resolve => setTimeout(resolve, 240));
    assert.equal((await f.capture.call('status')).capabilities.messages, true);
  } finally { f.capture.close(); }
});

test('all non-status methods reject a stale requested epoch before querying QQ', async () => {
  const f = fixture();
  try {
    f.init()();
    const expectedEpoch = f.capture.epoch;
    f.init()();
    const calls = [];
    const original = f.capture.invoke.bind(f.capture);
    f.capture.invoke = (...args) => { calls.push(args); return original(...args); };
    for (const method of ['resolve', 'user', 'friends', 'groups', 'groupInfo', 'groupMember', 'getMessage', 'sendMessage']) {
      await assert.rejects(f.capture.call(method, { expectedEpoch }), { code: 'SESSION_CHANGED' });
    }
    assert.deepEqual(calls, []);
    assert.equal((await f.capture.call('status', { expectedEpoch })).epoch, f.capture.epoch);
    assert.deepEqual(await f.capture.call('resolve', { expectedEpoch: f.capture.epoch, uin: '456' }), { uin: '456', uid: 'u_456' });
  } finally { f.capture.close(); }
});

test('completion rejects explicit failure forms without reporting a ready session', async () => {
  for (const value of [false, 1, -1, { result: 9 }, { errCode: 2 }, { errorCode: -5 }, { result: 0, errCode: 3 }]) {
    const f = fixture();
    try {
      f.init();
      assert.equal(f.complete(value), 'original-callback-result');
      const state = await f.capture.call('status');
      assert.equal(state.ready, false);
      assert.equal(state.capabilities.messages, false);
      assert.equal(f.listeners.msg, undefined);
    } finally { f.capture.close(); }
  }
});

test('completion recognizes explicit success while unknown objects expose only schema diagnostics', async () => {
  for (const args of [[], [undefined], [true], [0], [{ result: 0 }], [{ errCode: 0 }], [{ errorCode: 0 }]]) {
    const f = fixture();
    try { f.init(); f.complete(...args); assert.equal((await f.capture.call('status')).ready, true); }
    finally { f.capture.close(); }
  }
  const diagnostics = [];
  const f = fixture({ log: event => diagnostics.push(event) });
  try {
    f.init();
    f.complete({ accountToken: 'must-not-be-logged' });
    assert.equal((await f.capture.call('status')).ready, false);
    assert.equal(diagnostics[0].code, 'UNKNOWN_INIT_RESULT');
    assert.match(diagnostics[0].message, /type=object; keys=accountToken/);
    assert.ok(!JSON.stringify(diagnostics).includes('must-not-be-logged'));
  } finally { f.capture.close(); }
});

test('init return values preserve identity and never replace a completion signal', async () => {
  const pending = Promise.resolve('native-return');
  for (const initReturn of [false, true, undefined, pending]) {
    const f = fixture({ initReturn });
    try {
      f.init();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await f.capture.call('status')).ready, false);
      f.complete({ result: 0 });
      assert.equal((await f.capture.call('status')).ready, true);
    } finally { f.capture.close(); }
  }
});

test('init which throws after a synchronous completion retracts readiness and listeners', async () => {
  const failure = new Error('native init failure');
  const f = fixture({ initCallbackArgs: [{ result: 0 }], initThrows: failure });
  try {
    const states = [];
    f.capture.on('event', event => { if (event.kind === 'state') states.push(event.status); });
    assert.throws(() => f.init(), error => error === failure);
    const state = await f.capture.call('status');
    assert.equal(state.ready, false);
    assert.equal(state.online, null);
    assert.equal(state.capabilities.messages, false);
    assert.equal(f.listeners.msg, null);
    assert.equal(f.listeners.group, null);
    assert.equal(f.capture.observerTimer, null);
    assert.ok(states.some(value => value.ready));
    assert.equal(states.at(-1).ready, false);
  } finally { f.capture.close(); }
});

test('capabilities require actual QQ methods, not only registered listeners', async () => {
  const f = fixture();
  try {
    delete f.group.getGroupList;
    delete f.group.getMemberInfo;
    delete f.profile.getCoreAndBaseInfo;
    delete f.msg.getMsgsByMsgId;
    f.init()();
    let state = await f.capture.call('status');
    assert.equal(state.capabilities.messages, true);
    assert.equal(state.capabilities.text, true);
    assert.equal(state.capabilities.at, false);
    assert.equal(state.capabilities.reply, false);
    assert.equal(state.capabilities.groups, false);
    assert.equal(state.capabilities.groupMember, false);
    assert.equal(state.capabilities.user, false);
    assert.equal(state.capabilities.friends, false);
    delete f.msg.sendMsg;
    state = await f.capture.call('status');
    assert.equal(state.capabilities.text, false);
  } finally { f.capture.close(); }
});

test('UID conversion can use the group batch methods when profile conversion is absent', async () => {
  const f = fixture();
  try {
    delete f.profile.getUidByUin;
    delete f.profile.getUinByUid;
    f.group.getUidByUins = async uins => ({ uids: new Map(uins.map(uin => [uin, `u_${uin}`])) });
    f.group.getUinByUids = async uids => ({ uins: new Map(uids.map(uid => [uid, uid.slice(2)])) });
    f.init()();
    assert.equal((await f.capture.call('status')).capabilities.resolve, true);
    assert.deepEqual(await f.capture.call('resolve', { uin: '456' }), { uin: '456', uid: 'u_456' });
    assert.deepEqual(await f.capture.call('resolve', { uid: 'u_789' }), { uin: '789', uid: 'u_789' });
  } finally { f.capture.close(); }
});

test('group modification merges fields and removal preserves unrelated groups', async () => {
  const f = fixture();
  try {
    f.init()();
    f.listeners.group.onGroupListUpdate(1, [
      { groupCode: '200', groupName: 'First', memberNum: 2 },
      { groupCode: '300', groupName: 'Second', memberNum: 4 }
    ]);
    f.listeners.group.onGroupListUpdate(2, [{ groupCode: '200', groupName: 'Renamed' }]);
    let groups = await f.capture.call('groups');
    assert.deepEqual(groups, [
      { group_id: 200, group_name: 'Renamed', member_count: 2 },
      { group_id: 300, group_name: 'Second', member_count: 4 }
    ]);
    f.listeners.group.onGroupListUpdate(2, []);
    assert.deepEqual(await f.capture.call('groups'), groups);
    f.listeners.group.onGroupListUpdate(3, [{ groupCode: '200' }]);
    groups = await f.capture.call('groups');
    assert.deepEqual(groups, [{ group_id: 300, group_name: 'Second', member_count: 4 }]);
  } finally { f.capture.close(); }
});

test('initial empty deltas cannot become an empty success or satisfy a pending full query', async () => {
  const f = fixture();
  try {
    f.init()();
    f.listeners.group.onGroupListUpdate(2, []);
    f.listeners.group.onGroupListUpdate(3, []);
    f.listeners.group.onGroupListInited(true);
    assert.equal(f.capture.groupList, null);
    const forces = [];
    f.group.getGroupList = force => {
      forces.push(force);
      f.listeners.group.onGroupListUpdate(2, []);
      f.listeners.group.onGroupListUpdate(3, [{ groupCode: '200' }]);
      return Promise.resolve({ result: 0 });
    };
    let settled = false;
    const pending = f.capture.call('groups', { refresh: false }).then(value => { settled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.capture.groupList, null);
    assert.deepEqual(forces, [true]);
    f.listeners.group.onGroupListUpdate(1, [{ groupCode: '200', groupName: 'Real' }]);
    assert.deepEqual(await pending, [{ group_id: 200, group_name: 'Real' }]);
  } finally { f.capture.close(); }
});

test('refresh waits for a complete result despite intervening modify and remove callbacks', async () => {
  const f = fixture();
  try {
    f.init()();
    f.listeners.group.onGroupListUpdate(0, [{ groupCode: '200', groupName: 'Old' }]);
    let requests = 0;
    f.group.getGroupList = force => { requests++; assert.equal(force, true); return Promise.resolve({ result: 0 }); };
    let settled = false;
    const pending = f.capture.call('groups', { refresh: true }).then(value => { settled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    f.listeners.group.onGroupListUpdate(2, [{ groupCode: '300', groupName: 'Added' }]);
    f.listeners.group.onGroupListUpdate(3, [{ groupCode: '200' }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(await f.capture.call('groups'), [{ group_id: 300, group_name: 'Added' }]);
    f.listeners.group.onGroupListUpdate(0, [{ groupCode: '400', groupName: 'Complete' }]);
    assert.deepEqual(await pending, [{ group_id: 400, group_name: 'Complete' }]);
    assert.equal(requests, 1);
  } finally { f.capture.close(); }
});

test('confirmed complete empty lists are cached while unknown update types never replace them', async () => {
  const diagnostics = [];
  const f = fixture({ log: value => diagnostics.push(value) });
  try {
    f.init()();
    let requests = 0;
    f.group.getGroupList = force => {
      requests++; assert.equal(force, true);
      f.listeners.group.onGroupListUpdate(1, []);
      return Promise.resolve({ result: 0 });
    };
    assert.deepEqual(await f.capture.call('groups'), []);
    f.listeners.group.onGroupListUpdate(99, [{ groupCode: '200', groupName: 'Unknown' }]);
    assert.deepEqual(await f.capture.call('groups'), []);
    assert.equal(requests, 1);
    assert.equal(diagnostics.at(-1).code, 'UNKNOWN_GROUP_UPDATE');
  } finally { f.capture.close(); }
});

test('account change discards full membership cache and requests a fresh snapshot', async () => {
  const f = fixture();
  try {
    f.init()();
    f.listeners.group.onGroupListUpdate(1, [{ groupCode: '300', groupName: 'Old session group' }]);
    f.init()();
    assert.equal(f.capture.groupList, null);
    let force;
    f.group.getGroupList = value => {
      force = value;
      f.listeners.group.onGroupListUpdate(1, [{ groupCode: '200', groupName: 'New session group' }]);
      return Promise.resolve({ result: 0 });
    };
    assert.deepEqual(await f.capture.call('groups'), [{ group_id: 200, group_name: 'New session group' }]);
    assert.equal(force, true);
  } finally { f.capture.close(); }
});

test('readyAt records the first successful completion and remains stable for the epoch', async () => {
  const f = fixture();
  try {
    assert.equal((await f.capture.call('status')).readyAt, null);
    f.init();
    assert.equal((await f.capture.call('status')).readyAt, null);
    const before = Date.now();
    f.complete({ result: 0 });
    const initial = await f.capture.call('status');
    assert.ok(Number.isSafeInteger(initial.readyAt));
    assert.ok(initial.readyAt >= before && initial.readyAt <= Date.now());
    await new Promise(resolve => setTimeout(resolve, 5));
    f.complete({ result: 0 });
    assert.equal((await f.capture.call('status')).readyAt, initial.readyAt);
    f.init();
    const reset = await f.capture.call('status');
    assert.notEqual(reset.epoch, initial.epoch);
    assert.equal(reset.readyAt, null);
    f.complete({ result: 0 });
    assert.ok((await f.capture.call('status')).readyAt > initial.readyAt);
  } finally { f.capture.close(); }
});

test('failed completion retracts readyAt and closure does not leave a stale start time', async () => {
  const f = fixture();
  try {
    f.init()();
    assert.ok((await f.capture.call('status')).readyAt > 0);
    f.complete({ errCode: 1 });
    const failed = await f.capture.call('status');
    assert.equal(failed.ready, false);
    assert.equal(failed.readyAt, null);
    f.complete({ result: 0 });
    f.capture.close();
    assert.equal((await f.capture.call('status')).readyAt, null);
  } finally { f.capture.close(); }
});

test('group diagnostics contain only integer metadata and never list contents', async () => {
  const diagnostics = [];
  const f = fixture({ log: event => diagnostics.push(event) });
  try {
    f.init()();
    f.group.getGroupList = force => {
      assert.equal(force, true);
      f.listeners.group.onGroupListUpdate(1, [{ groupCode: '987654321', groupName: 'private-group-name' }]);
      return Promise.resolve({ result: 0 });
    };
    await f.capture.call('groups');
    const update = diagnostics.find(event => event.code === 'GROUP_LIST_UPDATE');
    const request = diagnostics.find(event => event.code === 'GROUP_LIST_REQUEST');
    assert.equal(update.message, 'type=1; count=1');
    assert.equal(request.message, 'force=1; result=0');
    const printed = JSON.stringify(diagnostics);
    assert.ok(!printed.includes('987654321'));
    assert.ok(!printed.includes('private-group-name'));
  } finally { f.capture.close(); }
});

test('member list requires a complete successful identity-consistent native result', async () => {
  const f = fixture();
  try {
    f.init()();
    let response = { errCode: 0, result: { finish: true, ids: [{ uid: 'u_456', index: 0 }],
      infos: new Map([['u_456', { uid: 'u_456', uin: '456', nick: 'Member', cardName: 'Card', role: 3 }]]) } };
    f.group.getAllMemberList = async (code, refresh) => { assert.equal(code, '200'); assert.equal(refresh, true); return response; };
    assert.equal((await f.capture.call('status')).capabilities.groupMembers, true);
    const members = await f.capture.call('groupMembers', { groupId: '200', refresh: true });
    assert.equal(members[0].user_id, 456);
    assert.equal(members[0].role, 'admin');
    response.result.finish = false;
    await assert.rejects(f.capture.call('groupMembers', { groupId: '200', refresh: true }), { code: 'INVALID_RESPONSE' });
    response.result.finish = true;
    response.result.ids.push({ uid: 'u_789' });
    assert.deepEqual((await f.capture.call('groupMembers', { groupId: '200', refresh: true })).map(member => member.user_id), [456, 789]);
    response = { errCode: 2, result: { finish: true, ids: [], infos: new Map() } };
    await assert.rejects(f.capture.call('groupMembers', { groupId: '200', refresh: true }), { code: 'KERNEL_ERROR' });
  } finally { f.capture.close(); }
});

test('profile extensions expose only real typed fields and validate birthday dates', async () => {
  const f = fixture();
  try {
    f.init()();
    f.profile.getCoreAndBaseInfo = async () => new Map([['u_456', { uid: 'u_456', uin: '456',
      coreInfo: { nick: 'Nickname', remark: 'Remark' }, baseInfo: { age: 25, sex: 2,
        birthday_year: 2000, birthday_month: 2, birthday_day: 29, longNick: 'first\nsecond', eMail: 'x@example.test', phoneNum: '', categoryId: 3 },
      qqLevel: { crownNum: 1, sunNum: 2, moonNum: 3, starNum: 1 },
      relationFlags: { isBlock: false, isMsgDisturb: true, isSpecialCareOpen: false } }]]);
    const value = await f.capture.call('user', { uin: '456' });
    assert.equal(value.signature, 'first\nsecond');
    assert.equal(value.birthday_day, 29);
    assert.equal(value.level, 109);
    assert.equal(value.phone, '');
    assert.equal(value.is_block, false);
    assert.equal(value.is_msg_disturb, true);
    assert.equal(Object.hasOwn(value, 'school'), false);
    const malformed = f.capture.simpleUser({ uin: '456', uid: 'u_456', baseInfo: {
      birthday_year: 2001, birthday_month: 2, birthday_day: 29, eMail: null, age: -1 } });
    assert.equal(Object.hasOwn(malformed, 'birthday_year'), false);
    assert.equal(Object.hasOwn(malformed, 'email'), false);
    assert.equal(Object.hasOwn(malformed, 'age'), false);
  } finally { f.capture.close(); }
});

test('detail profile validates the actual UIN and UID before exposing optional extended data', async () => {
  const f = fixture();
  try {
    f.init()();
    let detail = { uid: 'u_456', uin: '456', simpleInfo: { coreInfo: { nick: 'Name' }, baseInfo: { sex: 1 } },
      commonExt: { college: 'Example School', homeTown: 'Home', constellation: 5, labels: ['one', 'two'] } };
    f.profile.getUserDetailInfoByUin = async uin => { assert.equal(uin, '456'); return { result: 0, detail }; };
    const user = await f.capture.call('user', { uin: '456' });
    assert.equal(user.school, 'Example School');
    assert.deepEqual(user.labels, ['one', 'two']);
    assert.equal(user.constellation, 5);
    detail = { ...detail, uid: 'u_other' };
    await assert.rejects(f.capture.call('user', { uin: '456' }), { code: 'INVALID_RESPONSE' });
  } finally { f.capture.close(); }
});

test('late old-account member results cannot populate the new UID cache', async () => {
  const f = fixture();
  try {
    f.init()();
    let release;
    f.group.getAllMemberList = () => new Promise(resolve => { release = resolve; });
    const pending = f.capture.call('groupMembers', { groupId: '200' });
    const rejected = assert.rejects(pending, { code: 'SESSION_CHANGED' });
    await new Promise(resolve => setImmediate(resolve));
    f.init()();
    release({ errCode: 0, result: { finish: true, ids: [{ uid: 'u_789' }], infos: new Map([
      ['u_789', { uid: 'u_789', uin: '789', role: 2 }]]) } });
    await rejected;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.capture.forward.has('789'), false);
  } finally { f.capture.close(); }
});

test('history preserves long native message IDs and refuses cross-peer native pages', async () => {
  const f = fixture();
  try {
    f.init()();
    const peer = { chatType: 2, peerUid: '200' };
    let record = { ...peer, msgId: '18446744073709551614', msgSeq: '9007199254740993' };
    f.msg.getAioFirstViewLatestMsgs = async (actual, count) => {
      assert.deepEqual(actual, peer); assert.equal(count, 10);
      return { result: 0, msgList: [record] };
    };
    assert.equal((await f.capture.call('history', { peer, count: 10 })).records[0].msgId, record.msgId);
    record = { ...record, peerUid: '999' };
    await assert.rejects(f.capture.call('history', { peer, count: 10 }), { code: 'INVALID_RESPONSE' });
    await assert.rejects(f.capture.call('history', { peer, nativeId: 18446744073709551614 }), { code: 'INVALID_PARAMS' });
  } finally { f.capture.close(); }
});

test('recall waits before invoking QQ and requires its actual matching recall update', async () => {
  const f = fixture();
  try {
    f.init()();
    const peer = { chatType: 2, peerUid: '200' };
    let calls = 0;
    f.msg.recallMsg = async (actual, ids) => {
      calls++; assert.deepEqual(actual, peer); assert.deepEqual(ids, ['900']);
      f.listeners.msg.onMsgInfoListUpdate([{ ...peer, msgId: '900', recallTime: '0' }]);
      f.listeners.msg.onMsgInfoListUpdate([{ ...peer, msgId: '901', recallTime: '1800000000' }]);
      f.listeners.msg.onMsgInfoListUpdate([{ ...peer, msgId: '900', recallTime: '1800000000' }]);
      return { result: 0 };
    };
    assert.deepEqual(await f.capture.call('recall', { peer, nativeId: '900', expectedEpoch: f.capture.epoch }), { recalled: true });
    assert.equal(calls, 1);
    f.msg.recallMsg = async () => { calls++; return { result: 0 }; };
    await assert.rejects(f.capture.call('recall', { peer, nativeId: '900', expectedEpoch: f.capture.epoch },
      { expiresAt: Date.now() + 25 }), { code: 'TIMEOUT' });
    assert.equal(calls, 2);
    assert.equal(f.capture.bus.listenerCount('sent'), 0);
  } finally { f.capture.close(); }
});

test('gray tips leave capture as notices while ordinary messages retain their path', () => {
    const events = [], f = fixture({ onEvent: value => events.push(value) });
    try {
        f.init()();
        f.capture.on('event', value => events.push(value));
        const tip = { chatType: 2, peerUid: '200', msgId: '900', senderUin: '0', senderUid: '',
            elements: [{ elementType: 8, grayTipElement: { subElementType: 17 } }] };
        f.listeners.msg.onRecvMsg([tip, { chatType: 2, peerUid: '200', msgId: '901',
            elements: [{ elementType: 1, textElement: { content: 'ordinary' } }] }]);
        const business = events.filter(value => ['notice', 'message'].includes(value.kind));
        assert.equal(business[0].kind, 'notice');
        assert.equal(business[0].notice, 'gray_tip');
        assert.equal(business[0].record.msgId, '900');
        assert.equal(business[1].kind, 'message');
    } finally { f.capture.close(); }
});

test('only an authoritative recall record produces a raw recall notice', () => {
  const f = fixture();
  try {
    f.init()();
    const events = [];
    f.capture.on('event', value => events.push(value));
    const record = { chatType: 2, peerUid: '200', msgId: '900', recallTime: String(Math.floor(Date.now() / 1000)),
      elements: [{ elementType: 8, grayTipElement: { revokeElement: { operatorUid: 'u_123' } } }] };
    f.listeners.msg.onMsgInfoListUpdate([{ ...record, recallTime: '0' }]);
    f.listeners.msg.onMsgInfoListUpdate([record]);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'notice');
    assert.equal(events[0].notice, 'recall');
    assert.equal(events[0].epoch, f.capture.epoch);
  } finally { f.capture.close(); }
});

test('fixed group mutations validate typed parameters and require a successful QQ result', async () => {
  const f = fixture();
  try {
    f.init()();
    const received = [];
    f.group.modifyGroupName = async (...args) => { received.push(args); return { result: 0 }; };
    f.group.setGroupShutUp = async (...args) => { received.push(args); return { result: 0 }; };
    f.group.setMemberShutUp = async (...args) => { received.push(args); return { result: 0 }; };
    f.group.quitGroupV2 = async (...args) => { received.push(args); return { result: 120101005 }; };
    const base = { groupId: '200', expectedEpoch: f.capture.epoch };
    assert.deepEqual(await f.capture.call('groupAction', { ...base, operation: 'name', name: 'New Name' }), { confirmed: true });
    await f.capture.call('groupAction', { ...base, operation: 'wholeBan', enable: false });
    await f.capture.call('groupAction', { ...base, operation: 'memberBan', uin: '456', duration: 0 });
    assert.deepEqual(received, [['200', 'New Name', false], ['200', false], ['200', [{ uid: 'u_456', timeStamp: 0 }]]]);
    await assert.rejects(f.capture.call('groupAction', { ...base, operation: 'wholeBan', enable: 'false' }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.capture.call('groupAction', { ...base, operation: 'memberBan', uin: '456', duration: -1 }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.capture.call('groupAction', { ...base, operation: 'leave' }), { code: 'KERNEL_ERROR' });
    await assert.rejects(f.capture.call('groupAction', { ...base, operation: 'destroyGroup' }), { code: 'UNSUPPORTED' });
    assert.equal(received.length, 4);
  } finally { f.capture.close(); }
});

test('void and Promise<void> card and administrator mutations require a matching current member callback', async () => {
  const f = fixture();
  try {
    f.init()();
    let cardCalls = 0, roleCalls = 0, currentCard = 'Old', currentRole = 2;
    f.group.modifyMemberCardName = async (groupId, uid, card) => {
      cardCalls++; assert.equal(groupId, '200'); assert.equal(uid, 'u_456'); currentCard = card;
    };
    f.group.modifyMemberRole = async (groupId, uid, role) => {
      roleCalls++; assert.equal(groupId, '200'); assert.equal(uid, 'u_456'); currentRole = role;
    };
    f.group.getMemberInfo = (groupId, uids) => {
      f.listeners.group.onMemberInfoChange('999', 1, new Map([['u_456', { uid: 'u_456', uin: '456', cardName: currentCard, role: currentRole }]]));
      f.listeners.group.onMemberInfoChange(groupId, 1, new Map(uids.map(uid => [uid, { uid, uin: uid.slice(2), cardName: currentCard, role: currentRole }])));
      return Promise.resolve({ result: 0 });
    };
    const base = { groupId: '200', uin: '456', expectedEpoch: f.capture.epoch };
    assert.deepEqual(await f.capture.call('groupAction', { ...base, operation: 'card', card: 'New\nCard' }), { confirmed: true });
    assert.deepEqual(await f.capture.call('groupAction', { ...base, operation: 'admin', enable: true }), { confirmed: true });
    f.group.modifyMemberCardName = () => { cardCalls++; };
    await assert.rejects(f.capture.call('groupAction', { ...base, operation: 'card', card: 'Unconfirmed' },
      { expiresAt: Date.now() + 25 }), { code: 'TIMEOUT' });
    assert.equal(cardCalls, 2); assert.equal(roleCalls, 1);
    assert.equal(f.capture.bus.listenerCount('groupMember'), 0);
  } finally { f.capture.close(); }
});

test('an early timer rearms until the wall-clock deadline and does not reject a still-live native operation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1800000000000;
  t.mock.method(Date, 'now', () => clock);
  const f = fixture(); t.after(() => f.capture.close());
  f.init()();
  let release, began, outcome = 'pending', calls = 0;
  const started = new Promise(resolve => { began = resolve; });
  const task = f.capture.deadline(() => {
    calls++; began(); return new Promise(resolve => { release = resolve; });
  }, { expiresAt: clock + 20 });
  task.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
  const rejected = assert.rejects(task, { code: 'TIMEOUT' });
  await started;
  t.mock.timers.tick(20);
  await Promise.resolve();
  assert.equal(outcome, 'pending'); assert.equal(f.capture.pending.size, 1);
  clock += 19;
  t.mock.timers.tick(20);
  await Promise.resolve();
  assert.equal(outcome, 'pending');
  clock++;
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(outcome, 'rejected'); assert.equal(f.capture.pending.size, 0);
  release('late'); await Promise.resolve();
  assert.equal(calls, 1);
});

test('a synchronous native result after the wall-clock deadline cannot race its timer into success', async () => {
  const f = fixture();
  try {
    f.init()();
    let calls = 0;
    f.group.modifyGroupName = () => {
      calls++;
      const end = Date.now() + 30;
      while (Date.now() < end) { /* A synchronous native call blocks timer dispatch. */ }
      return { result: 0 };
    };
    await assert.rejects(f.capture.call('groupAction', { groupId: '200', operation: 'name', name: 'Test', expectedEpoch: f.capture.epoch },
      { expiresAt: Date.now() + 10 }), { code: 'TIMEOUT' });
    assert.equal(calls, 1);
  } finally { f.capture.close(); }
});
