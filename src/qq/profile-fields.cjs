'use strict';

function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID_RESPONSE' }); }
function integer(value, minimum = 0) {
  if (!['string', 'number'].includes(typeof value) || !/^-?(?:0|[1-9]\d*)$/.test(String(value))) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : undefined;
}
function consistent(values, label) {
  const real = values.filter(value => value !== undefined);
  if (real.some(value => value !== real[0])) throw invalid('QQ supplied conflicting ' + label);
  return real[0];
}
function strings(output, source, fields) {
  for (const [from, to] of Object.entries(fields)) if (typeof source?.[from] === 'string') output[to] = source[from];
}
function numbers(output, source, fields) {
  for (const [from, to] of Object.entries(fields)) {
    const value = integer(source?.[from]);
    if (value !== undefined) output[to] = value;
  }
}
function booleans(output, source, fields) {
  for (const [from, to] of Object.entries(fields)) if (typeof source?.[from] === 'boolean') output[to] = source[from];
}

// The QQ list and detail services expose different names for the same counts
// and timestamps. Preserve real zeros and reject contradictory snapshots.
function groupFields(record) {
  const output = {};
  for (const [sources, target] of [
    [['memberNum', 'memberCount'], 'member_count'], [['maxMemberNum', 'maxMember'], 'max_member_count'],
    [['groupCreateTime', 'createTime'], 'group_create_time'],
    [['shutUpAllTimestamp', 'groupShutupExpireTime'], 'shut_up_all_timestamp'],
    [['shutUpMeTimestamp', 'personShutupExpireTime'], 'shut_up_me_timestamp']
  ]) {
    const value = consistent(sources.map(key => integer(record[key])), target);
    if (value !== undefined) output[target] = value;
  }
  const ownerId = consistent([integer(record.ownerUin, 1), integer(record.groupOwnerId?.memberUin, 1)], 'owner account');
  if (ownerId !== undefined) output.owner_id = ownerId;
  const uid = value => typeof value === 'string' && /^u_[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
  const ownerUid = consistent([uid(record.ownerUid), uid(record.groupOwnerId?.memberUid)], 'owner UID');
  if (ownerUid !== undefined) output.owner_uid = ownerUid;
  const groupUin = integer(record.groupUin, 1);
  if (groupUin !== undefined) output.group_uin = groupUin;
  strings(output, record, { remarkName: 'group_remark', groupMemo: 'group_memo', fingerMemo: 'group_finger_memo',
    groupQuestion: 'group_question', groupClassText: 'group_class' });
  numbers(output, record, { groupGrade: 'group_grade', activeMemberNum: 'active_member_count', groupAdminMaxNum: 'group_admin_max_count' });
  booleans(output, record, { isTop: 'is_top' });
  return output;
}
function memberFields(record) {
  const output = {};
  strings(output, record, { qid: 'qid', remark: 'remark' });
  numbers(output, record, { shutUpTime: 'shut_up_timestamp', memberLevel: 'member_level',
    globalGroupLevel: 'global_group_level', globalGroupPoint: 'global_group_point', memberTitleId: 'title_id' });
  booleans(output, record, { isRobot: 'is_robot', isSpecialConcerned: 'is_special_care', isSpecialShield: 'is_special_shield',
    isSpecialShielded: 'is_special_shielded' });
  const titleExpiry = integer(record.specialTitleExpireTime, -1);
  if (titleExpiry !== undefined) output.title_expire_time = titleExpiry;
  return output;
}
function userFields(record) {
  const output = {};
  booleans(output, record.relationFlags, { isBlocked: 'is_blocked' });
  booleans(output, record.vasInfo, { bigClub: 'is_big_club' });
  numbers(output, record.vasInfo, { bigClubLevel: 'big_club_level' });
  return output;
}

module.exports = { integer, groupFields, memberFields, userFields };
