'use strict';

// Detail requires acceptance and a matching callback; EF0 uses its keyed Map.
// Muted members come from a complete member snapshot with real mute timestamps.
const MAX_BYTES = 1024 * 1024;
const MAX_MEMBERS = 10000;
const MAX_QUERIES = 8;
const MAX_WAITERS = 16;
const MAX_RETIRED = 256;
const OPERATIONS = Object.freeze({
    'group.detail': ['groupDetail', 'getGroupDetailInfo'],
    'group.ext': ['groupInfoEx', 'getGroupExt0xEF0Info'],
    'group.shutList': ['groupShutList', 'getAllMemberList']
});
const EXT_FILTER = Object.freeze(Object.fromEntries([
    'bindGuildId', 'blacklistExpireTime', 'companyId', 'essentialMsgPrivilege', 'essentialMsgSwitch',
    'fullGroupExpansionSeq', 'fullGroupExpansionSwitch', 'gangUpId', 'groupAioBindGuildId',
    'groupBindGuildIds', 'groupBindGuildSwitch', 'groupExcludeGuildIds', 'groupExtFlameData',
    'groupFlagPro1', 'groupInfoExtSeq', 'groupOwnerId', 'groupSquareSwitch', 'hasGroupCustomPortrait',
    'inviteRobotMemberExamine', 'inviteRobotMemberSwitch', 'inviteRobotSwitch', 'isLimitGroupRtc',
    'lightCharNum', 'luckyWord', 'luckyWordId', 'msgEventSeq', 'qqMusicMedalSwitch', 'reserve',
    'showPlayTogetherSwitch', 'starId', 'todoSeq', 'viewedMsgDisappearTime'
].map(name => [name, 1])));
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function uint(value, positive = false) {
    return ['string', 'number'].includes(typeof value) && /^(0|[1-9]\d{0,9})$/.test(String(value)) &&
        Number.isSafeInteger(Number(value)) && Number(value) <= 0xffffffff && (!positive || Number(value) > 0);
}
function group(value, code = 'INVALID_PARAMS') {
    if (!uint(value, true)) throw problem(code, 'Expected an exact positive group identifier');
    return String(value);
}
function snapshot(value) {
    let nodes = 0, bytes = 0;
    const charge = amount => { bytes += amount; if (bytes > MAX_BYTES) throw new Error('Native response byte limit'); };
    const copy = (item, depth) => {
        if (++nodes > 100000 || depth > 16) throw new Error('Native data complexity limit');
        if (item === null || typeof item === 'boolean') { charge(item === null || item === true ? 4 : 5); return item; }
        if (typeof item === 'string') {
            if (Buffer.byteLength(item) > 65536 || item.includes('\0') || Buffer.from(item).toString('utf8') !== item) throw new Error('Native string limit');
            charge(Buffer.byteLength(JSON.stringify(item)));
            return item;
        }
        if (typeof item === 'number') {
            if (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item)) throw new Error('Inexact native number');
            charge(Buffer.byteLength(String(item)));
            return item;
        }
        if (typeof item === 'bigint') { const text = String(item); charge(Buffer.byteLength(text) + 2); return text; }
        if (Array.isArray(item)) {
            if (item.length > MAX_MEMBERS) throw new Error('Native array limit');
            charge(2 + Math.max(0, item.length - 1));
            const result = [];
            for (let index = 0; index < item.length; index++) {
                if (!Object.hasOwn(item, index)) throw new Error('Sparse native array');
                result.push(copy(item[index], depth + 1));
            }
            return result;
        }
        if (!object(item)) throw new Error('Unsupported native value');
        const result = Object.create(null);
        charge(2); let count = 0;
        for (const key in item) {
            if (!Object.hasOwn(item, key)) continue;
            if (key.length > 256) throw new Error('Native key limit');
            const keyBytes = Buffer.byteLength(JSON.stringify(key)) + 1 + (count ? 1 : 0);
            charge(keyBytes);
            const entry = item[key];
            if (entry !== undefined) {
                count++;
                result[key] = copy(entry, depth + 1);
            } else bytes -= keyBytes;
        }
        return result;
    };
    try {
        const result = copy(value, 0), encoded = JSON.stringify(result);
        if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('Native response byte limit');
        return JSON.parse(encoded);
    } catch { throw problem('INVALID_RESPONSE', 'QQ group query data is not a bounded exact JSON value'); }
}
function codes(value, required = false) {
    if (!object(value)) throw problem('INVALID_RESPONSE', 'QQ supplied no group query result');
    let found = false;
    for (const name of ['result', 'retCode', 'errCode', 'errorCode', 'retcode', 'errcode']) {
        if (!Object.hasOwn(value, name) || name === 'result' && object(value[name])) continue;
        found = true;
        const code = value[name];
        if (!['string', 'number'].includes(typeof code) || !/^-?(0|[1-9]\d*)$/.test(String(code)) || !Number.isSafeInteger(Number(code))) {
            throw problem('INVALID_RESPONSE', 'QQ supplied an invalid group query result code');
        }
        if (Number(code) !== 0) throw problem('KERNEL_ERROR', 'QQ rejected the group query');
    }
    if (required && !found) throw problem('INVALID_RESPONSE', 'QQ did not explicitly accept the group query');
}
function detail(value, groupId) {
    if (!object(value) || value.groupCode !== groupId || typeof value.groupName !== 'string' ||
        !uint(value.memberNum) || !uint(value.maxMemberNum, true) || Number(value.memberNum) > Number(value.maxMemberNum)) {
        throw problem('INVALID_RESPONSE', 'QQ returned incomplete or unrelated group detail');
    }
    codes(value);
    for (const name of ['shutUpAllTimestamp', 'shutUpMeTimestamp']) if (value[name] !== undefined && !uint(value[name])) {
        throw problem('INVALID_RESPONSE', 'QQ returned invalid group mute timestamps');
    }
    if (value.remarkName !== undefined && typeof value.remarkName !== 'string') throw problem('INVALID_RESPONSE', 'QQ returned an invalid group remark');
    return snapshot(value);
}
function members(value, groupId) {
    if (!Array.isArray(value) || value.length > MAX_MEMBERS) throw problem('INVALID_RESPONSE', 'QQ returned no complete bounded muted-member list');
    const uids = new Set(), uins = new Set(), projected = [];
    for (const member of value) {
        if (!object(member) || typeof member.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(member.uid) ||
            !uint(member.uin, true) || typeof member.nick !== 'string' || !uint(member.shutUpTime) ||
            member.groupCode !== undefined && member.groupCode !== groupId ||
            member.role !== undefined && ![2, 3, 4].includes(member.role) ||
            member.cardName !== undefined && typeof member.cardName !== 'string' || uids.has(member.uid) || uins.has(String(member.uin))) {
            throw problem('INVALID_RESPONSE', 'QQ returned an invalid or duplicate muted member');
        }
        uids.add(member.uid); uins.add(String(member.uin));
        const output = { uid: member.uid, uin: member.uin, nick: member.nick, shutUpTime: member.shutUpTime };
        if (member.role !== undefined) output.role = member.role;
        if (member.cardName !== undefined) output.cardName = member.cardName;
        projected.push(output);
    }
    return snapshot(projected);
}
function extended(response, groupId) {
    codes(response); codes(response.result);
    const values = response.result.groupExtInfos;
    if (!(values instanceof Map) || values.size > 32 || !values.has(groupId) ||
        [...values.keys()].some(key => typeof key !== 'string' || !uint(key, true))) {
        throw problem('INVALID_RESPONSE', 'QQ returned no exact group extension Map entry');
    }
    const value = values.get(groupId);
    if (!object(value) || !Object.keys(value).length) throw problem('INVALID_RESPONSE', 'QQ returned no group extension data');
    for (const name of ['groupCode', 'groupId', 'group_id']) if (value[name] !== undefined && String(value[name]) !== groupId) {
        throw problem('INVALID_RESPONSE', 'QQ group extension belongs to another group');
    }
    codes(value);
    return snapshot(value);
}

function createGroupQueries(capture, { queryTimeoutMs = 10000 } = {}) {
    if (!Number.isInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 10000) throw new TypeError('Invalid group query observation deadline');
    const queries = new Map(), nativePending = new Map(), retired = new Set();
    let generation = 0, currentSession = null;
    const listenerMethods = { group: {} };
    function capabilities() {
        const observed = capture.registrations?.some(entry => entry.name === 'group') === true;
        return Object.fromEntries(Object.entries(OPERATIONS).map(([operation, [flag, method]]) => [flag,
            capture.ready === true && capture.hasMethods('group', [method]) && (operation === 'group.ext' || observed)]));
    }
    function invoke(operation, groupId, args, query, method = OPERATIONS[operation][1]) {
        const key = query.key;
        if (nativePending.has(key)) throw problem('BUSY', 'A previous native group query remains unresolved for the current session');
        if (nativePending.size >= MAX_QUERIES) throw problem('BUSY', 'Too many unresolved native group queries');
        const token = {};
        nativePending.set(key, token);
        let task;
        try {
            query.dispatched = true;
            task = Promise.resolve(capture.invoke('group', method, args));
        } catch (error) {
            nativePending.delete(key); query.acceptance = 'rejected'; throw error;
        }
        const release = () => { if (nativePending.get(key) === token) nativePending.delete(key); };
        task.then(release, release);
        return task;
    }
    async function execute(operation, groupId, context, active, query) {
        const check = () => {
            active();
            if (context.signal?.aborted || Date.now() >= context.expiresAt) throw problem('EXPIRED', 'Group query expired or was cancelled');
        };
        check();
        if (operation === 'group.ext') {
            const response = await invoke(operation, groupId, [[groupId], [], { ...EXT_FILTER }, true], query);
            check(); return { groupId, info: extended(response, groupId) };
        }
        if (operation === 'group.shutList') {
            const records = await capture.groupMemberRecords({ groupId, refresh: false }, context, {
                requireMuteState: true, check,
                invoke(method, args) {
                    check();
                    query.callbackRequired = method === 'getMemberInfo';
                    query.callbackSeen = false; query.acceptance = 'pending';
                    return invoke(operation, groupId, args, query, method).then(value => {
                        try { codes(value, true); query.acceptance = 'accepted'; }
                        catch (error) { query.acceptance = error.code === 'KERNEL_ERROR' ? 'rejected' : 'unknown'; throw error; }
                        return value;
                    }, error => { query.acceptance = 'unknown'; throw error; });
                }
            }).catch(error => {
                if (error.code === 'INVALID_PARAMS') throw problem('INVALID_RESPONSE', 'QQ returned an invalid member identity');
                throw error;
            });
            check();
            // Validate every member before filtering. An absent mute timestamp
            // cannot prove that member is unmuted or authorize an empty result.
            const complete = members(records, groupId), now = Math.floor(Date.now() / 1000);
            query.callbackSeen = true;
            return { groupId, members: complete.filter(member => Number(member.shutUpTime) > now) };
        }
        const event = 'groupInfo';
        let handler, dispatched = false;
        const response = new Promise((resolve, reject) => {
            handler = (...args) => {
                if (!dispatched || args[0]?.groupCode !== groupId) return;
                try {
                    check();
                    const result = { groupId, detail: detail(args[0], groupId) };
                    query.callbackSeen = true;
                    resolve(result);
                } catch (error) { reject(error); }
            };
            capture.bus.on(event, handler);
        });
        response.catch(() => {});
        try {
            return await capture.deadline(async () => {
                check(); dispatched = true; query.callbackRequired = true;
                const accepted = invoke(operation, groupId, [groupId, 2], query)
                    .then(value => {
                        try { codes(value, true); query.acceptance = 'accepted'; }
                        catch (error) { query.acceptance = error.code === 'KERNEL_ERROR' ? 'rejected' : 'unknown'; throw error; }
                    }, error => { query.acceptance = 'unknown'; throw error; });
                const [, result] = await Promise.all([accepted, response]);
                check(); return result;
            }, context);
        } finally { dispatched = false; capture.bus.removeListener(event, handler); }
    }
    async function dispatch(operation, params = {}, context = {}) {
        if (!Object.hasOwn(OPERATIONS, operation)) throw problem('UNSUPPORTED', 'Unknown group query operation');
        if (!object(params) || Object.keys(params).some(key => !['operation', 'groupId', 'expectedEpoch'].includes(key)) ||
            params.operation !== undefined && params.operation !== operation) throw problem('INVALID_PARAMS', 'Unexpected group query parameters');
        const groupId = group(params.groupId);
        capture.ensureReady();
        if (typeof params.expectedEpoch !== 'string' || params.expectedEpoch !== capture.epoch) throw problem('SESSION_CHANGED', 'Group query must bind the current QQ session');
        const epoch = capture.epoch, session = capture.session, self = { ...capture.self };
        if (!uint(self.uin, true) || typeof self.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(self.uid)) throw problem('NOT_READY', 'Group query requires the real QQ identity');
        const sessionKey = JSON.stringify([epoch, self.uin, self.uid]);
        if (currentSession !== sessionKey) { clear(); currentSession = sessionKey; }
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== epoch || capture.session !== session || capture.self?.uin !== self.uin || capture.self?.uid !== self.uid) {
                throw problem('SESSION_CHANGED', 'QQ changed during the group query');
            }
        };
        if (!capabilities()[OPERATIONS[operation][0]]) throw problem('UNSUPPORTED', 'This QQ session lacks the group query contract');
        if (context.signal?.aborted || context.expiresAt !== undefined && (!Number.isFinite(context.expiresAt) || Date.now() >= context.expiresAt)) {
            throw problem('EXPIRED', 'Group query deadline expired or was cancelled');
        }
        const key = JSON.stringify([epoch, self.uin, self.uid, operation, groupId]);
        let query = queries.get(key);
        if (!query) {
            if (retired.has(key)) throw problem('BUSY', 'A previous group query remains unresolved for the current session');
            if (retired.size >= MAX_RETIRED) throw problem('BUSY', 'The current session reached its unresolved group query limit');
            if (queries.size >= MAX_QUERIES) throw problem('BUSY', 'Too many concurrent group queries');
            if (nativePending.has(key) || nativePending.size >= MAX_QUERIES) throw problem('BUSY', 'A previous native group query remains unresolved');
            const controller = new AbortController(), scope = { signal: controller.signal, expiresAt: Date.now() + queryTimeoutMs };
            query = { key, controller, waiters: 0, task: null, dispatched: false, callbackSeen: false, callbackRequired: false,
                acceptance: 'pending', generation };
            queries.set(key, query);
            const current = query;
            query.task = capture.deadline(() => execute(operation, groupId, scope, active, current), scope, queryTimeoutMs);
            const retire = error => {
                if (queries.get(key) === current) queries.delete(key);
                if (error && current.callbackRequired && current.generation === generation && current.dispatched &&
                    !current.callbackSeen && current.acceptance !== 'rejected' && retired.size < MAX_RETIRED) retired.add(key);
                controller.abort();
            };
            query.task.then(() => retire(), retire);
        }
        if (query.waiters >= MAX_WAITERS) throw problem('BUSY', 'Too many waiters for this group query');
        query.waiters++;
        try {
            return await capture.deadline(async () => { active(); const result = await query.task; active(); return snapshot(result); }, context);
        } finally {
            query.waiters--;
            // A caller's cancellation cannot prove the request stopped in QQ.
            // Keep one bounded shared observation until the native query ends.
        }
    }
    function clear() {
        generation++;
        for (const query of queries.values()) query.controller.abort();
        queries.clear(); retired.clear(); currentSession = null;
        // Native promises retain their separate budget until they really settle.
    }
    return { capabilities, dispatch, listenerMethods, clear };
}

module.exports = { createGroupQueries, OPERATIONS, EXT_FILTER, MAX_MEMBERS, MAX_BYTES, MAX_QUERIES, MAX_WAITERS, MAX_RETIRED };
