'use strict';

const REQUIREMENTS = Object.freeze({ get_group_detail_info: 'groupDetail', get_group_info_ex: 'groupInfoEx', get_group_shut_list: 'groupShutList' });
const ACTIONS = new Set(Object.keys(REQUIREMENTS));
const OPERATIONS = { get_group_detail_info: 'group.detail', get_group_info_ex: 'group.ext', get_group_shut_list: 'group.shutList' };
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function uint(value, positive = false) { return ['string', 'number'].includes(typeof value) && /^(0|[1-9]\d{0,9})$/.test(String(value)) &&
    Number.isSafeInteger(Number(value)) && Number(value) <= 0xffffffff && (!positive || Number(value) > 0); }

async function runGroupQueries(service, state, action, params) {
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unknown group query extension');
    if (!object(params) || Object.keys(params).some(key => !['group_id', 'self_id'].includes(key)) || !uint(params.group_id, true)) {
        throw problem('INVALID_PARAMS', 'Expected only an exact group_id for this group query');
    }
    if (state.capabilities?.[REQUIREMENTS[action]] !== true) throw problem('UNSUPPORTED', 'The current QQ session lacks this group query capability');
    const groupId = String(params.group_id);
    const result = await service.sessionCall(state, 'groupQuery', { operation: OPERATIONS[action], groupId });
    if (!object(result) || result.groupId !== groupId) throw problem('INVALID_RESPONSE', 'QQ returned a different group query');
    if (action === 'get_group_detail_info') {
        const value = result.detail;
        if (!object(value) || value.groupCode !== groupId || typeof value.groupName !== 'string' ||
            !uint(value.memberNum) || !uint(value.maxMemberNum, true) || Number(value.memberNum) > Number(value.maxMemberNum) ||
            value.shutUpAllTimestamp !== undefined && !uint(value.shutUpAllTimestamp) ||
            value.remarkName !== undefined && typeof value.remarkName !== 'string') {
            throw problem('INVALID_RESPONSE', 'QQ returned invalid native group detail');
        }
        const output = { ...value, group_id: Number(groupId), group_name: value.groupName,
            member_count: Number(value.memberNum), max_member_count: Number(value.maxMemberNum) };
        // These aliases have defined native sources. Unrecognized fields in a
        // raw record cannot substitute for evidence of a remark or mute state.
        delete output.group_all_shut; delete output.group_remark;
        if (value.shutUpAllTimestamp !== undefined) output.group_all_shut = Number(value.shutUpAllTimestamp) > Math.floor(Date.now() / 1000) ? -1 : 0;
        if (value.remarkName !== undefined) output.group_remark = value.remarkName;
        return output;
    }
    if (action === 'get_group_info_ex') {
        if (!object(result.info) || !Object.keys(result.info).length) throw problem('INVALID_RESPONSE', 'QQ returned no native group extension');
        for (const name of ['groupCode', 'groupId', 'group_id']) if (result.info[name] !== undefined && String(result.info[name]) !== groupId) {
            throw problem('INVALID_RESPONSE', 'QQ extension belongs to another group');
        }
        return result.info;
    }
    if (!Array.isArray(result.members) || result.members.length > 10000) throw problem('INVALID_RESPONSE', 'QQ returned no bounded muted-member list');
    const seenUids = new Set(), seenUins = new Set();
    for (const value of result.members) {
        if (!object(value) || typeof value.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(value.uid) ||
            !uint(value.uin, true) || typeof value.nick !== 'string' || !uint(value.shutUpTime) ||
            seenUids.has(value.uid) || seenUins.has(String(value.uin))) throw problem('INVALID_RESPONSE', 'QQ returned invalid or duplicate muted members');
        seenUids.add(value.uid); seenUins.add(String(value.uin));
    }
    return result.members;
}

module.exports = { ACTIONS, REQUIREMENTS, ACTION_REQUIREMENTS: REQUIREMENTS, runGroupQueries };
