'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { groupFields, memberFields, userFields } = require('../src/qq/profile-fields.cjs');
function capture(t) {
  const value = new Capture({ install: false, processObject: { env: {} } });
  t.after(() => value.close());
  return value;
}

test('group list and detail snapshots preserve their actual counts and timestamps', t => {
  const f = capture(t);
  assert.deepEqual(f.normalizeGroup({ groupCode: '12345', groupName: 'Group', memberCount: 0, maxMember: 200,
    createTime: '1700000000', groupShutupExpireTime: '0', personShutupExpireTime: '1800000000',
    groupOwnerId: { memberUin: '22222', memberUid: 'u_owner' }, isTop: false }), {
    group_id: 12345, group_name: 'Group', member_count: 0, max_member_count: 200,
    group_create_time: 1700000000, shut_up_all_timestamp: 0, shut_up_me_timestamp: 1800000000,
    owner_id: 22222, owner_uid: 'u_owner', is_top: false
  });
  assert.deepEqual(f.normalizeGroup({ groupCode: '12345', groupName: '', memberNum: 3, maxMemberNum: 500,
    groupCreateTime: 1700000000, ownerUin: '22222', ownerUid: 'u_owner', groupUin: '77777',
    groupMemo: 'memo\nline', fingerMemo: 'finger', groupQuestion: 'question', remarkName: 'remark',
    activeMemberNum: 0, groupAdminMaxNum: 10, groupGrade: 5 }), {
    group_id: 12345, group_name: '', member_count: 3, max_member_count: 500, group_create_time: 1700000000,
    owner_id: 22222, owner_uid: 'u_owner', group_uin: 77777, group_remark: 'remark', group_memo: 'memo\nline',
    group_finger_memo: 'finger', group_question: 'question', group_grade: 5, active_member_count: 0, group_admin_max_count: 10
  });
});

test('conflicting aliases or missing group identity never become a fabricated empty group', t => {
  const f = capture(t);
  for (const fields of [{ memberNum: 2, memberCount: 3 }, { maxMemberNum: 200, maxMember: 500 },
    { ownerUin: '22222', groupOwnerId: { memberUin: '33333' } }, { ownerUid: 'u_one', groupOwnerId: { memberUid: 'u_two' } }]) {
    assert.throws(() => f.normalizeGroup({ groupCode: '12345', groupName: 'Group', ...fields }), { code: 'INVALID_RESPONSE' });
  }
  assert.throws(() => f.normalizeGroup({ groupCode: '12345' }), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(groupFields({ memberNum: -1, maxMemberNum: Number.MAX_SAFE_INTEGER + 1, isTop: 'true', groupCreateTime: '1.2' }), {});
});

test('group member responses preserve actual mute, title expiry, identity and robot flags', t => {
  const f = capture(t);
  const result = f.normalizeMember('12345', { uin: '22222', uid: 'u_member', role: 3, nick: 'Nick', cardName: 'Card',
    sex: 2, age: 22, qid: 'qid', remark: '', joinTime: '1700000000', lastSpeakTime: '1800000000',
    memberRealLevel: 5, shutUpTime: 1800000060, specialTitleExpireTime: '-1', memberSpecialTitle: 'Title',
    isRobot: false, isSpecialConcerned: true, isSpecialShield: false, isSpecialShielded: true });
  assert.equal(result.uid, 'u_member'); assert.equal(result.qid, 'qid'); assert.equal(result.remark, '');
  assert.equal(result.join_time, 1700000000); assert.equal(result.last_sent_time, 1800000000);
  assert.equal(result.title_expire_time, -1); assert.equal(result.shut_up_timestamp, 1800000060);
  assert.equal(result.is_robot, false); assert.equal(result.is_special_care, true);
  assert.equal(result.is_special_shield, false); assert.equal(result.is_special_shielded, true);
  assert.equal(result.role, 'admin'); assert.equal(result.level, '5');
  assert.equal(Object.hasOwn(result, 'card_changeable'), false); assert.equal(Object.hasOwn(result, 'unfriendly'), false);
  assert.deepEqual(memberFields({ specialTitleExpireTime: '1800000010', shutUpTime: '0', isRobot: true }),
    { title_expire_time: 1800000010, shut_up_timestamp: 0, is_robot: true });
});

test('invalid or missing optional member metadata is not promoted into typed values', t => {
  const f = capture(t);
  const result = f.normalizeMember('12345', { uin: '22222', uid: 'u_member', role: 2, age: -1,
    joinTime: -1, lastSpeakTime: 'Infinity', isRobot: 1, specialTitleExpireTime: '-2' });
  assert.equal(Object.hasOwn(result, 'age'), false); assert.equal(Object.hasOwn(result, 'is_robot'), false);
  assert.equal(result.join_time, 0); assert.equal(result.last_sent_time, 0);
  assert.deepEqual(memberFields({ shutUpTime: -1, qid: null, specialTitleExpireTime: '9007199254740992' }), {});
});

test('user profiles retain real UIDs and distinguish blocking directions and big-club membership', t => {
  const f = capture(t);
  const result = f.simpleUser({ uid: 'u_user', uin: '22222', coreInfo: { uid: 'u_user', uin: '22222', nick: 'Name' },
    relationFlags: { isBlock: false, isBlocked: true }, vasInfo: { bigClub: false, bigClubLevel: 0 } });
  assert.equal(result.uid, 'u_user'); assert.equal(result.is_block, false); assert.equal(result.is_blocked, true);
  assert.equal(result.is_big_club, false); assert.equal(result.big_club_level, 0);
  assert.deepEqual(userFields({ relationFlags: { isBlocked: 'false' }, vasInfo: { bigClub: 1, bigClubLevel: -1 } }), {});
});

test('nested conflicting user identities are rejected before UID caches change', t => {
  const f = capture(t);
  for (const nested of [{ uin: '33333' }, { uid: 'u_other' }]) {
    assert.throws(() => f.simpleUser({ uid: 'u_user', uin: '22222', coreInfo: { nick: 'Name', ...nested } },
      { uin: '22222', uid: 'u_user' }), { code: 'INVALID_RESPONSE' });
  }
  assert.equal(f.forward.has('22222'), false);
  assert.equal(f.simpleUser({ uin: '22222', uid: 'u_user', coreInfo: { uid: 'u_***_22222', uin: '22222' } },
    { uin: '22222', uid: 'u_user' }).uid, 'u_user');
});

test('friend list identity validation and epoch withdrawal prevent a profile query in the next session', async t => {
  const f = capture(t), calls = [];
  f.invoke = async (service, method) => {
    calls.push({ service, method });
    f.epoch = 'changed';
    return { result: 0, data: [{ buddyUids: ['u_friend'] }] };
  };
  await assert.rejects(f.friends(), { code: 'SESSION_CHANGED' });
  assert.equal(calls.length, 1);
  f.invoke = async () => ({ result: 0, data: [{ buddyUids: ['not-a-uid'] }] });
  await assert.rejects(f.friends(), { code: 'INVALID_RESPONSE' });
});

test('friend category aliases preserve a real category name and complete profile fields', async t => {
  const f = capture(t);
  f.invoke = async service => service === 'buddy'
    ? { result: 0, data: [{ categoryId: 7, categoryName: 'Friends', buddyUids: ['u_friend'] }] }
    : new Map([['u_friend', { uid: 'u_friend', uin: '22222', coreInfo: { nick: 'Name' }, baseInfo: { categoryId: 7 } }]]);
  const result = await f.friends();
  assert.deepEqual(result[0].categories, [{ id: 7, name: 'Friends' }]);
  assert.equal(result[0].category_name, 'Friends'); assert.equal(result[0].uid, 'u_friend');
});
