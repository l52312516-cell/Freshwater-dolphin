'use strict';

const { randomBytes } = require('node:crypto');

function problem(code, message) { return Object.assign(new Error(message), { code }); }
function uid(value) {
    if (typeof value !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(value)) throw problem('INVALID_PARAMS', 'Expected a verified QQ UID');
    return value;
}
function decimal(value, name) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
        throw problem('INVALID_PARAMS', 'Invalid ' + name);
    }
    return String(value);
}
function opaqueDecimal(value) { return typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value); }
function text(value, name, maximum) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || value.includes('\0')) throw problem('INVALID_PARAMS', 'Invalid ' + name);
    return value;
}
function confirmed(value) {
    if (!value || value.result !== 0) throw problem('KERNEL_ERROR', 'QQ did not confirm the operation');
    return value;
}
function timestamp(value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,10}$/.test(String(value))) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number * 1000 <= Date.now() + 30000 ? number : null;
}

// Request flags are opaque capabilities for one native request in one QQ session.
// A void native return never proves that an approval or remark was applied.
function createSocial(capture, { requestTtlMs = 600000, maximumRequests = 1000 } = {}) {
    const handles = new Map();
    const keys = new Map();
    let currentEpoch = capture.epoch;
    function reset() { handles.clear(); keys.clear(); currentEpoch = capture.epoch; }
    function ready() {
        capture.ensureReady();
        if (currentEpoch !== capture.epoch) reset();
        return { epoch: capture.epoch, uin: capture.self?.uin, uid: capture.self?.uid };
    }
    function same(state) {
        capture.ensureReady();
        if (state.epoch !== capture.epoch || state.uin !== capture.self?.uin || state.uid !== capture.self?.uid) {
            throw problem('SESSION_CHANGED', 'QQ session changed during social operation');
        }
    }
    function active(state, context) {
        same(state);
        if (context.signal?.aborted || (context.expiresAt !== undefined && Date.now() >= context.expiresAt)) {
            throw problem('EXPIRED', 'Social operation expired; its result may be unknown');
        }
    }
    function sweep() {
        for (const [flag, item] of handles) if (item.expiresAt <= Date.now() && !item.inflight) {
            // Keep the native identity tombstone until the QQ session ends.
            // An expired callback must not mint a new flag and replay an event.
            handles.delete(flag);
        }
    }
    function remember(key, request) {
        sweep();
        const existing = handles.get(keys.get(key));
        if (existing) { existing.request = request; return existing; }
        if (keys.has(key)) return null;
        if (handles.size >= maximumRequests || keys.size >= 10000) throw problem('BUSY', 'Pending social request limit reached');
        const flag = 'fwd_req_' + randomBytes(24).toString('hex');
        const item = { flag, key, request, state: ready(), expiresAt: Date.now() + requestTtlMs, emitted: false, used: false, inflight: false };
        handles.set(flag, item); keys.set(key, flag);
        return item;
    }
    function fresh(time) {
        return time !== null && Number.isFinite(capture.readyAt) && time * 1000 + 1000 >= capture.readyAt;
    }
    function details(request) {
        const result = {}, record = request.record;
        const putText = (key, value) => {
            if (typeof value === 'string' && Buffer.byteLength(value) <= 16384 && !value.includes('\0')) result[key] = value;
        };
        if (request.type === 'friend') {
            putText('nickname', record.friendNick);
            for (const [from, to] of [['sourceId', 'source_id'], ['commFriendNum', 'common_friend_count']]) {
                if (Number.isSafeInteger(record[from]) && record[from] >= 0) result[to] = record[from];
            }
            if (/^[1-9]\d*$/.test(String(record.groupCode || '')) && Number.isSafeInteger(Number(record.groupCode))) {
                result.source_group_id = String(record.groupCode);
            }
        } else {
            putText('group_name', record.group?.groupName);
            const actor = request.nativeType === 7 ? record.user1 : record.user2;
            if (actor?.uid === request.uid) putText('nickname', actor.nickName);
            putText('warning_tips', record.warningTips);
            result.doubt = request.doubt;
        }
        return result;
    }
    function emit(item, time) {
        if (!item || item.emitted || item.used || !fresh(time)) return;
        same(item.state);
        item.emitted = true;
        const request = item.request;
        capture.publish({ kind: 'request', time, request: { type: request.type, flag: item.flag, uid: request.uid,
            comment: request.comment, ...details(request), ...(request.type === 'group' ? { subType: request.subType, groupId: request.groupId } : {}) } });
    }
    function observeFriend(notify) {
        try {
            ready();
            if (!Array.isArray(notify?.buddyReqs)) return;
            capture.bus.emit('social:friend', notify.buddyReqs);
            for (const record of notify.buddyReqs) {
                if (!record || !opaqueDecimal(record.reqTime) || !/^u_[A-Za-z0-9_-]+$/.test(record.friendUid || '')) continue;
                const key = JSON.stringify(['friend', record.friendUid, record.reqTime]);
                const existing = handles.get(keys.get(key));
                if (record.isDecide === true || record.reqType !== 1 || record.isInitiator === true || record.isDoubt === true) {
                    if (existing) existing.used = true;
                    continue;
                }
                if (record.isDecide !== false) continue;
                const item = remember(key, { type: 'friend', uid: record.friendUid, reqTime: record.reqTime,
                    comment: typeof record.extWords === 'string' ? record.extWords : '', record });
                if (record.isUnread === true) emit(item, timestamp(record.reqTime));
            }
        } catch (error) { capture.diagnostic(error); }
    }
    function observeGroup(doubt, records, publish = true) {
        try {
            ready();
            if (typeof doubt !== 'boolean' || !Array.isArray(records)) return;
            capture.bus.emit('social:group', doubt, records);
            if (!publish) capture.bus.emit('social:groupScreen', doubt, records);
            for (const record of records) {
                if (!record || ![1, 7].includes(record.type) || !opaqueDecimal(record.seq)) continue;
                let groupId;
                try { groupId = decimal(record.group?.groupCode, 'group number'); } catch { continue; }
                const sender = record.type === 7 ? record.user1?.uid : record.user2?.uid;
                if (!/^u_[A-Za-z0-9_-]+$/.test(sender || '')) continue;
                const key = JSON.stringify(['group', doubt, record.type, groupId, record.seq]);
                const existing = handles.get(keys.get(key));
                if (record.status !== 1) { if (existing) existing.used = true; continue; }
                const item = remember(key, { type: 'group', doubt, uid: sender, groupId, seq: record.seq,
                    nativeType: record.type, subType: record.type === 7 ? 'add' : 'invite',
                    comment: typeof record.postscript === 'string' ? record.postscript : '', record });
                if (publish) emit(item, timestamp(record.actionTime));
            }
        } catch (error) { capture.diagnostic(error); }
    }
    const listenerMethods = {
        buddy: { onBuddyReqChange: observeFriend },
        group: {
            onGroupNotifiesUpdated: (doubt, records) => observeGroup(doubt, records),
            onGroupSingleScreenNotifies: (doubt, _seq, records) => observeGroup(doubt, records, false)
        }
    };
    function hasListener(name) { return capture.registrations?.some(item => item.name === name) === true; }
    function capabilities() {
        return {
            friendRequests: hasListener('buddy') && capture.hasMethods('buddy', ['getBuddyReq', 'approvalFriendRequest']),
            groupRequests: hasListener('group') && capture.hasMethods('group', ['getSingleScreenNotifies', 'operateSysNotify']),
            friendRemark: capture.hasMethods('buddy', ['setBuddyRemark']) && capture.hasMethods('profile', ['getCoreAndBaseInfo']),
            friendCategories: capture.hasMethods('buddy', ['getBuddyListV2']) && capture.hasMethods('profile', ['getCoreAndBaseInfo']),
            recentContacts: capture.hasMethods('recent', ['getRecentContactListSnapShot']),
            markRead: capture.hasMethods('msg', ['setMsgRead'])
        };
    }
    async function categories(state) {
        const result = confirmed(await capture.invoke('buddy', 'getBuddyListV2', ['0', true, 0]));
        same(state);
        if (!Array.isArray(result.data) || result.data.length > 1000) throw problem('INVALID_RESPONSE', 'Invalid QQ friend categories');
        const all = new Set(), categoryIds = new Set();
        for (const category of result.data) {
            if (!Number.isInteger(category.categoryId) || category.categoryId < 0 || category.categoryId > 0xffffffff || typeof category.categroyName !== 'string' ||
                !Number.isInteger(category.categroyMbCount) || category.categroyMbCount < 0 || category.categroyMbCount > 0xffffffff || !Array.isArray(category.buddyUids) || category.buddyUids.length > 50000) {
                throw problem('INVALID_RESPONSE', 'Incomplete QQ friend category');
            }
            if (categoryIds.has(category.categoryId) || new Set(category.buddyUids).size !== category.buddyUids.length) {
                throw problem('INVALID_RESPONSE', 'QQ returned duplicate friend category identities');
            }
            categoryIds.add(category.categoryId);
            for (const value of category.buddyUids) all.add(uid(value));
        }
        const profiles = all.size ? await capture.invoke('profile', 'getCoreAndBaseInfo', ['nodeStore', [...all]]) : new Map();
        same(state);
        if (!(profiles instanceof Map) || [...all].some(value => !profiles.has(value))) throw problem('INVALID_RESPONSE', 'QQ category friend profiles are incomplete');
        return result.data.map(category => ({ categoryId: category.categoryId, categoryName: category.categroyName,
            categoryMbCount: category.categroyMbCount,
            buddyList: category.buddyUids.map(value => capture.simpleUser(profiles.get(value), { uid: value })) }));
    }
    async function recent(params, state) {
        const count = params.count ?? 10;
        if (!Number.isInteger(count) || count < 1 || count > 100) throw problem('INVALID_PARAMS', 'count must be 1..100');
        const result = confirmed(await capture.invoke('recent', 'getRecentContactListSnapShot', [count]));
        same(state);
        if (result.info?.errCode !== 0 || !Array.isArray(result.info.changedList) || result.info.changedList.length > 1000) {
            throw problem('INVALID_RESPONSE', 'Invalid QQ recent contacts snapshot');
        }
        const rows = [];
        for (const row of result.info.changedList) {
            if (![1, 2].includes(row?.chatType)) continue;
            const peerUin = decimal(row.peerUin, 'recent contact');
            if (!opaqueDecimal(row.msgId) || timestamp(row.msgTime) === null) throw problem('INVALID_RESPONSE', 'Recent contact has no reliable message locator');
            if (row.chatType === 1) {
                const resolved = await capture.resolve({ uid: uid(row.peerUid) });
                same(state);
                if (resolved.uin !== peerUin || resolved.uid !== row.peerUid) throw problem('INVALID_RESPONSE', 'Recent private contact identity is inconsistent');
            } else if (String(row.peerUid) !== peerUin) throw problem('INVALID_RESPONSE', 'Recent group contact identity is inconsistent');
            const output = { chatType: row.chatType, peerUin, peerUid: row.peerUid, msgTime: String(row.msgTime), nativeMsgId: row.msgId };
            for (const key of ['remark', 'peerName', 'sendNickName', 'sendMemberName']) if (typeof row[key] === 'string') output[key] = row[key];
            rows.push(output);
        }
        return rows.slice(0, count);
    }
    async function query(params = {}, context = {}) {
        const state = ready();
        if (params.operation === 'categories') return categories(state);
        if (params.operation === 'recent') return recent(params, state);
        if (params.operation === 'friendRequests') {
            if (!capabilities().friendRequests) throw problem('UNSUPPORTED', 'QQ friend request observation is unavailable');
            await capture.waiting('social:friend', rows => {
                if (!Array.isArray(rows) || rows.length > maximumRequests || rows.some(record => !record ||
                    !/^u_[A-Za-z0-9_-]+$/.test(record.friendUid || '') || !opaqueDecimal(record.reqTime) ||
                    !Number.isInteger(record.reqType) || record.reqType < 0 || record.reqType > 13 || typeof record.isDecide !== 'boolean')) {
                    throw problem('INVALID_RESPONSE', 'QQ returned an incomplete friend request list');
                }
                return rows;
            },
                () => capture.invoke('buddy', 'getBuddyReq', []), context);
        } else if (params.operation === 'groupRequests') {
            if (!capabilities().groupRequests) throw problem('UNSUPPORTED', 'QQ group request observation is unavailable');
            for (const doubt of [false, true]) await capture.waiting('social:groupScreen', (received, records) => {
                if (received !== doubt) return undefined;
                if (!Array.isArray(records) || records.length > 100 || records.some(record => !record || !opaqueDecimal(record.seq) ||
                    !Number.isInteger(record.type) || record.type < 0 || record.type > 17 || !Number.isInteger(record.status) ||
                    record.status < 0 || record.status > 4 || !/^[1-9]\d*$/.test(String(record.group?.groupCode ?? '')) ||
                    !Number.isSafeInteger(Number(record.group?.groupCode)))) {
                    throw problem('INVALID_RESPONSE', 'QQ returned an incomplete group request screen');
                }
                return records;
            },
                () => capture.invoke('group', 'getSingleScreenNotifies', [doubt, '0', 100]), context);
        } else throw problem('UNSUPPORTED', 'Unsupported social query');
        same(state); sweep();
        const type = params.operation === 'friendRequests' ? 'friend' : 'group';
        return [...handles.values()].filter(item => item.request.type === type && !item.used).map(item => ({
            flag: item.flag, uid: item.request.uid, comment: item.request.comment, ...details(item.request),
            ...(type === 'group' ? { groupId: item.request.groupId, subType: item.request.subType, seq: item.request.seq,
                time: timestamp(item.request.record.actionTime), doubt: item.request.doubt } : { time: timestamp(item.request.reqTime) })
        }));
    }
    async function remark(params, state, context) {
        active(state, context);
        const value = text(params.remark, 'remark', 1000);
        const who = await capture.resolve({ uin: decimal(params.uin, 'user_id') });
        active(state, context);
        if (!capture.hasMethods('buddy', ['setBuddyRemark']) || !capture.hasMethods('profile', ['getCoreAndBaseInfo'])) {
            throw problem('UNSUPPORTED', 'QQ friend remark confirmation is unavailable');
        }
        await capture.deadline(async () => {
            active(state, context);
            const result = await capture.invoke('buddy', 'setBuddyRemark', [{ uid: uid(who.uid), remark: value }]);
            if (result !== undefined) confirmed(result);
            active(state, context);
            // Query the real profile after the mutation. A missing or stale value
            // is a failure, even if the native setter returned without throwing.
            const profiles = await capture.invoke('profile', 'getCoreAndBaseInfo', ['nodeStore', [who.uid]]);
            same(state);
            if (!(profiles instanceof Map) || !profiles.has(who.uid)) throw problem('INVALID_RESPONSE', 'QQ did not return the modified friend profile');
            const profile = capture.simpleUser(profiles.get(who.uid), who);
            if (profile.remark !== value) throw problem('KERNEL_ERROR', 'QQ has not confirmed the requested friend remark');
        }, context);
        return { updated: true };
    }
    async function action(params = {}, context = {}) {
        const state = ready();
        active(state, context);
        if (params.operation === 'remark') return remark(params, state, context);
        if (params.operation === 'read') {
            if (!params.peer || ![1, 2].includes(params.peer.chatType)) throw problem('INVALID_PARAMS', 'Invalid read conversation');
            const peer = { chatType: params.peer.chatType, peerUid: params.peer.chatType === 1 ? uid(params.peer.peerUid) : decimal(params.peer.peerUid, 'group_id') };
            confirmed(await capture.invoke('msg', 'setMsgRead', [peer]));
            same(state); return { read: true };
        }
        if (!['friendRequest', 'groupRequest'].includes(params.operation)) throw problem('UNSUPPORTED', 'Unsupported social action');
        if (typeof params.approve !== 'boolean') throw problem('INVALID_PARAMS', 'approve must be boolean');
        if (params.operation === 'friendRequest' && params.remark !== undefined) text(params.remark, 'remark', 1000);
        if (params.operation === 'friendRequest' && params.approve && params.remark !== undefined && !capabilities().friendRemark) {
            throw problem('UNSUPPORTED', 'QQ friend remark confirmation is unavailable');
        }
        const reason = params.reason === undefined ? '' : text(params.reason, 'reason', 1000);
        if (typeof params.flag !== 'string') throw problem('INVALID_PARAMS', 'Expected an opaque request flag');
        const item = handles.get(params.flag);
        if (!item || item.expiresAt <= Date.now()) throw problem('NOT_FOUND', 'Unknown or expired request flag');
        same(item.state);
        const request = item.request;
        const expectedType = params.operation === 'friendRequest' ? 'friend' : 'group';
        if (request.type !== expectedType || (request.type === 'group' && params.subType !== request.subType)) throw problem('INVALID_PARAMS', 'Request type does not match flag');
        if (item.used || item.inflight) throw problem('BUSY', 'Request was already handled or its result is unknown');
        const service = request.type === 'friend' ? 'buddy' : 'group';
        const method = request.type === 'friend' ? 'approvalFriendRequest' : 'operateSysNotify';
        if (!capture.hasMethods(service, [method])) throw problem('UNSUPPORTED', 'QQ request handling is unavailable');
        item.inflight = true;
        try {
            if (request.type === 'friend') {
                await capture.waiting('social:friend', records => {
                    const results = records.filter(record => record?.friendUid === request.uid && record.reqTime === request.reqTime && record.isDecide === true);
                    if (!results.length) return undefined;
                    if (results.some(result => params.approve ? ![2, 3].includes(result.reqType) : result.reqType !== 7)) throw problem('KERNEL_ERROR', 'QQ confirmed a different or ambiguous friend request outcome');
                    return true;
                }, async () => {
                    active(state, context); item.used = true;
                    const result = await capture.invoke('buddy', 'approvalFriendRequest', [{ friendUid: request.uid, reqTime: request.reqTime, accept: params.approve }]);
                    if (result !== undefined) confirmed(result);
                    active(state, context);
                    if (capture.hasMethods('buddy', ['getBuddyReq'])) {
                        const refreshed = await capture.invoke('buddy', 'getBuddyReq', []);
                        if (refreshed !== undefined) confirmed(refreshed);
                        active(state, context);
                    }
                }, context, true);
                active(state, context);
                if (params.approve && params.remark !== undefined) {
                    const who = await capture.resolve({ uid: request.uid }); active(state, context);
                    await remark({ uin: who.uin, remark: params.remark }, state, context);
                }
            } else {
                await capture.waiting('social:group', (doubt, records) => {
                    if (doubt !== request.doubt) return undefined;
                    const results = records.filter(record => record?.seq === request.seq && record.type === request.nativeType && String(record.group?.groupCode) === request.groupId && record.status !== 1);
                    if (!results.length) return undefined;
                    if (results.some(result => result.status !== (params.approve ? 2 : 3))) throw problem('KERNEL_ERROR', 'QQ confirmed a different or ambiguous group request outcome');
                    return true;
                }, async () => {
                    active(state, context); item.used = true;
                    const result = await capture.invoke('group', 'operateSysNotify', [request.doubt, { operateType: params.approve ? 1 : 2,
                        targetMsg: { seq: request.seq, type: request.nativeType, groupCode: request.groupId, postscript: reason || ' ' } }]);
                    if (result !== undefined) confirmed(result);
                    active(state, context);
                    if (capture.hasMethods('group', ['getSingleScreenNotifies'])) {
                        const refreshed = await capture.invoke('group', 'getSingleScreenNotifies', [request.doubt, '', 100]);
                        if (refreshed !== undefined) confirmed(refreshed);
                        active(state, context);
                    }
                }, context, true);
            }
            active(state, context); return { handled: true };
        } finally { item.inflight = false; }
    }
    return { query, action, capabilities, listenerMethods, reset, close: reset };
}

module.exports = { createSocial };
