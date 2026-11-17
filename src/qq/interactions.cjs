'use strict';

const MAX_COUNTER = 0xffffffff;
const MAX_LIKE_TARGETS = 256;
const MAX_MUTATION_TARGETS = 256;
const PROFILE_CONFIRMATION_POLL_MS = 250;
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function fields(value, allowed) {
    if (!record(value) || Object.keys(value).some(key => key !== 'expectedEpoch' && !allowed.includes(key))) {
        throw problem('INVALID_PARAMS', 'Invalid interaction parameters');
    }
}
function uid(value) {
    if (typeof value !== 'string' || value.length > 128 || !/^u_[A-Za-z0-9_-]+$/.test(value)) {
        throw problem('INVALID_PARAMS', 'Profile likes require a resolved QQ UID');
    }
    return value;
}
function groupId(value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value)) || Number(value) > MAX_COUNTER) {
        throw problem('INVALID_PARAMS', 'Invalid group number');
    }
    return String(value);
}
function result(value, key) {
    if (!record(value) || !Object.hasOwn(value, key)) throw problem('INVALID_RESPONSE', 'QQ supplied no explicit interaction result');
    if (value[key] !== 0 && value[key] !== '0') {
        const code = value[key];
        if (!((typeof code === 'number' && Number.isSafeInteger(code)) ||
            (typeof code === 'string' && /^-?[1-9]\d{0,9}$/.test(code)))) {
            throw problem('INVALID_RESPONSE', 'QQ supplied an invalid interaction result');
        }
        throw problem('KERNEL_ERROR', 'QQ rejected the interaction; it was not retried');
    }
    return value;
}
function counter(value) { return Number.isInteger(value) && value >= 0 && value <= MAX_COUNTER; }
function text(value, maximum, empty, label) {
    if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0') || Buffer.byteLength(value) > maximum) {
        throw problem('INVALID_PARAMS', 'Invalid ' + label);
    }
    return value;
}
function optionalAcknowledgement(value) {
    // These profile setters can complete with void. Only a subsequent exact
    // account readback can turn that completion into a confirmed modification.
    if (value === undefined) return;
    if (!record(value)) throw problem('INVALID_RESPONSE', 'QQ supplied an unknown profile completion');
    const keys = ['result', 'errCode', 'errorCode'].filter(key => Object.hasOwn(value, key));
    if (!keys.length) throw problem('INVALID_RESPONSE', 'QQ supplied no recognizable profile result');
    for (const key of keys) result(value, key);
}

// Fixed operations share the capture's real session and deadlines.
// A like request is dispatched once; even a timeout cannot release its target
// lock while the native promise is still pending in the same QQ session.
function createInteractions(capture, { native = require('./msf-native.cjs') } = {}) {
    let epoch, session, selfUin, selfUid;
    const pendingLikes = new Map();
    const pendingMutations = new Map();
    function synchronize() {
        if (epoch !== capture.epoch || session !== capture.session || selfUin !== capture.self?.uin || selfUid !== capture.self?.uid) {
            pendingLikes.clear();
            pendingMutations.clear();
            epoch = capture.epoch; session = capture.session;
            selfUin = capture.self?.uin; selfUid = capture.self?.uid;
        }
    }
    function capabilities() {
        synchronize();
        const selfNickname = capture.hasMethods('profile', ['getCoreAndBaseInfo', 'setNickName']);
        const selfSignature = capture.hasMethods('profile', ['getCoreAndBaseInfo', 'setLongNick']);
        const selfSex = capture.hasMethods('profile', ['getCoreAndBaseInfo']) && native.available();
        const groupRemark = capture.hasMethods('group', ['modifyGroupRemark', 'getGroupList']);
        return { profileLike: capture.hasMethods('profileLike', ['setBuddyProfileLike']),
            groupAtAllRemain: capture.hasMethods('group', ['getGroupRemainAtTimes']),
            ...(selfNickname || selfSignature || selfSex ? { selfProfile: true, selfNickname, selfSignature, selfSex } : {}),
            ...(groupRemark ? { groupRemark: true } : {}) };
    }
    function active(state, context) {
        capture.ensureReady();
        if (state.epoch !== capture.epoch || state.session !== capture.session ||
            state.uin !== capture.self?.uin || state.uid !== capture.self?.uid) {
            throw problem('SESSION_CHANGED', 'QQ session changed during interaction');
        }
        if (context.signal?.aborted || (context.expiresAt !== undefined && Date.now() >= context.expiresAt)) {
            throw problem('EXPIRED', 'Interaction expired; its result may be unknown');
        }
    }
    function like(target, count, state, context) {
        if (pendingLikes.has(target)) throw problem('BUSY', 'A profile like for this target is still pending');
        if (pendingLikes.size >= MAX_LIKE_TARGETS) throw problem('BUSY', 'Too many pending profile like requests');
        const token = {};
        pendingLikes.set(target, token);
        const native = Promise.resolve().then(() => {
            active(state, context);
            return capture.invoke('profileLike', 'setBuddyProfileLike', [{ friendUid: target,
                sourceId: 71, doLikeCount: count, doLikeTollCount: 0 }]);
        });
        const operation = native.then(value => {
            active(state, context);
            const outcome = result(value, 'result');
            if (!Number.isInteger(outcome.succCounts) || outcome.succCounts < 0 || outcome.succCounts > count) {
                throw problem('INVALID_RESPONSE', 'QQ supplied no reliable successful like count; it was not retried');
            }
            if (outcome.succCounts !== count) throw problem('PARTIAL_RESULT', 'QQ confirmed only part of the requested likes; remaining likes were not retried');
            return { uid: target, count, confirmed: true };
        });
        operation.finally(() => {
            if (pendingLikes.get(target) === token) pendingLikes.delete(target);
        }).catch(() => {});
        return operation;
    }
    async function remaining(target, state, context) {
        active(state, context);
        const outcome = await capture.invoke('group', 'getGroupRemainAtTimes', [target]);
        active(state, context);
        const info = result(outcome, 'errCode').atInfo;
        if (!record(info) || typeof info.canAtAll !== 'boolean' ||
            !counter(info.RemainAtAllCountForUin) || !counter(info.RemainAtAllCountForGroup) ||
            typeof info.atTimesMsg !== 'string' || typeof info.canNotAtAllMsg !== 'string' ||
            Buffer.byteLength(info.atTimesMsg) > 16384 || Buffer.byteLength(info.canNotAtAllMsg) > 16384) {
            throw problem('INVALID_RESPONSE', 'QQ supplied an incomplete at-all allowance');
        }
        return { group_id: Number(target), can_at_all: info.canAtAll,
            remain_at_all_count_for_uin: info.RemainAtAllCountForUin,
            remain_at_all_count_for_group: info.RemainAtAllCountForGroup,
            at_times_msg: info.atTimesMsg, can_not_at_all_msg: info.canNotAtAllMsg };
    }
    async function selfProfile(state, context, requested) {
        active(state, context);
        const values = await capture.invoke('profile', 'getCoreAndBaseInfo', ['nodeStore', [state.uid]]);
        active(state, context);
        const value = values instanceof Map ? values.get(state.uid) : undefined;
        if (!record(value) || !record(value.coreInfo)) throw problem('INVALID_RESPONSE', 'QQ supplied no self profile snapshot');
        const identifiers = [value.uid, value.coreInfo.uid].filter(item => item !== undefined);
        if (!identifiers.length || identifiers.some(item => item !== state.uid) ||
            [value.uin, value.coreInfo.uin].some(item => item !== undefined && String(item) !== state.uin)) {
            throw problem('INVALID_RESPONSE', 'QQ self profile belongs to another account');
        }
        const snapshot = {};
        if (Object.hasOwn(requested, 'nickname')) {
            if (typeof value.coreInfo.nick !== 'string' || value.coreInfo.nick.includes('\0') || Buffer.byteLength(value.coreInfo.nick) > 256) {
                throw problem('INVALID_RESPONSE', 'QQ omitted a bounded real self nickname');
            }
            snapshot.nickname = value.coreInfo.nick;
        }
        if (Object.hasOwn(requested, 'personalNote')) {
            if (!record(value.baseInfo) || typeof value.baseInfo.longNick !== 'string' || value.baseInfo.longNick.includes('\0') ||
                Buffer.byteLength(value.baseInfo.longNick) > 4096 ||
                value.baseInfo.uid !== undefined && value.baseInfo.uid !== state.uid ||
                value.baseInfo.uin !== undefined && String(value.baseInfo.uin) !== state.uin) {
                throw problem('INVALID_RESPONSE', 'QQ omitted a matching self signature');
            }
            snapshot.personalNote = value.baseInfo.longNick;
        }
        if (Object.hasOwn(requested, 'sex')) {
            if (!record(value.baseInfo) || !Number.isInteger(value.baseInfo.sex) || value.baseInfo.sex < 0 || value.baseInfo.sex > 2 ||
                value.baseInfo.uid !== undefined && value.baseInfo.uid !== state.uid ||
                value.baseInfo.uin !== undefined && String(value.baseInfo.uin) !== state.uin) {
                throw problem('INVALID_RESPONSE', 'QQ omitted a matching real self sex value');
            }
            snapshot.sex = value.baseInfo.sex;
        }
        return snapshot;
    }
    function confirmationDelay(state, context) {
        active(state, context);
        return new Promise((resolve, reject) => {
            let timer, done = false;
            const finish = error => {
                if (done) return;
                done = true; clearTimeout(timer);
                context.signal?.removeEventListener('abort', cancelled);
                if (error) reject(error); else resolve();
            };
            const cancelled = () => finish(problem('EXPIRED', 'Interaction confirmation was cancelled; its result may be unknown'));
            timer = setTimeout(() => {
                try { active(state, context); finish(); } catch (error) { finish(error); }
            }, PROFILE_CONFIRMATION_POLL_MS);
            context.signal?.addEventListener('abort', cancelled, { once: true });
            if (context.signal?.aborted) cancelled();
        });
    }
    async function confirmProfileField(state, context, requested, key) {
        // Setter completion and the cached profile snapshot can arrive in
        // either order. Poll only this verified read API under the original
        // mutation deadline; never dispatch the setter a second time.
        for (;;) {
            const observed = await selfProfile(state, context, requested);
            if (observed[key] === requested[key]) return observed;
            await confirmationDelay(state, context);
        }
    }
    async function updateProfile(requested, state, context) {
        const previous = await selfProfile(state, context, requested);
        let observed = previous, applied = 0;
        try {
            for (const [key, method] of [['nickname', 'setNickName'], ['personalNote', 'setLongNick'], ['sex', null]]) {
                if (!Object.hasOwn(requested, key) || requested[key] === observed[key]) continue;
                active(state, context);
                if (key === 'sex') {
                    const request = { uin: state.uin, sex: requested.sex };
                    require('./profile-update-protocol.cjs').prepare('profile.sex', request);
                    const ack = await native.run(capture, { op: 'fixedProfile', operation: 'profile.sex', request,
                        expectedEpoch: state.epoch, expectedUin: state.uin, signal: context.signal,
                        timeoutMs: Math.max(1, Math.min(10000, (context.expiresAt ?? Date.now() + 10000) - Date.now())) });
                    active(state, context);
                    if (!record(ack) || ack.operation !== 'profile.sex' || ack.uin !== state.uin || ack.sex !== requested.sex ||
                        ack.confirmed !== false || ack.confirmation !== 'requires_profile_readback') {
                        throw problem('INVALID_RESPONSE', 'QQ supplied no matching profile acknowledgement');
                    }
                } else optionalAcknowledgement(await capture.invoke('profile', method, [requested[key]]));
                active(state, context);
                observed = await confirmProfileField(state, context, requested, key);
                applied++;
            }
            if (Object.keys(requested).some(key => requested[key] !== observed[key])) {
                throw problem('UNCONFIRMED', 'QQ self profile fields changed during confirmation; no retry was attempted');
            }
        } catch (error) {
            if (applied && !['SESSION_CHANGED', 'EXPIRED', 'TIMEOUT', 'NOT_READY'].includes(error.code)) {
                throw problem('PARTIAL_RESULT', 'QQ confirmed only part of the profile update; no rollback or retry was attempted');
            }
            throw error;
        }
        return { confirmed: true, uin: state.uin, uid: state.uid, ...observed, previous,
            changed: Object.keys(requested).some(key => previous[key] !== requested[key]) };
    }
    async function groupRemarkValue(target, state, context) {
        active(state, context);
        const list = await capture.groups({ refresh: true }, context);
        active(state, context);
        if (!Array.isArray(list)) throw problem('INVALID_RESPONSE', 'QQ supplied no group list for remark confirmation');
        const matches = list.filter(item => record(item) && String(item.group_id) === target);
        if (!matches.length) throw problem('NOT_FOUND', 'QQ group is absent from the current account list');
        if (matches.length !== 1 || typeof matches[0].group_remark !== 'string' || matches[0].group_remark.includes('\0') ||
            Buffer.byteLength(matches[0].group_remark) > 1024) {
            throw problem('INVALID_RESPONSE', 'QQ supplied no unique real group remark');
        }
        return matches[0].group_remark;
    }
    async function updateGroupRemark(target, remark, state, context) {
        const previous = await groupRemarkValue(target, state, context);
        if (previous !== remark) {
            active(state, context);
            result(await capture.invoke('group', 'modifyGroupRemark', [target, remark]), 'result');
            active(state, context);
            // A successful native acknowledgement may precede the forced
            // group-list snapshot. Confirm by reads under the same deadline;
            // stale data never causes the setter to be sent a second time.
            while (await groupRemarkValue(target, state, context) !== remark) await confirmationDelay(state, context);
        }
        return { confirmed: true, groupId: target, remark, previous, changed: previous !== remark };
    }
    function mutate(key, operation) {
        if (pendingMutations.has(key)) throw problem('BUSY', 'A modification for this target still awaits confirmation');
        if (pendingMutations.size >= MAX_MUTATION_TARGETS) throw problem('BUSY', 'Too many pending profile modifications');
        const token = {};
        pendingMutations.set(key, token);
        const pending = Promise.resolve().then(operation);
        pending.finally(() => {
            if (pendingMutations.get(key) === token) pendingMutations.delete(key);
        }).catch(() => {});
        return pending;
    }
    async function modification(method, params, state, context) {
        const enabled = capabilities();
        let operation, key;
        if (method === 'profile.update') {
            const requested = {};
            if (Object.hasOwn(params, 'nickname')) requested.nickname = text(params.nickname, 256, true, 'nickname');
            if (Object.hasOwn(params, 'personalNote')) requested.personalNote = text(params.personalNote, 4096, true, 'personal note');
            if (Object.hasOwn(params, 'sex')) requested.sex = require('./profile-update-protocol.cjs').sex(params.sex);
            if (!Object.keys(requested).length) {
                active(state, context);
                return { confirmed: true, changed: false, uin: state.uin, uid: state.uid, previous: {} };
            }
            if (Object.hasOwn(requested, 'nickname') && enabled.selfNickname !== true ||
                Object.hasOwn(requested, 'personalNote') && enabled.selfSignature !== true ||
                Object.hasOwn(requested, 'sex') && enabled.selfSex !== true) {
                throw problem('UNSUPPORTED', 'QQ cannot update and verify every requested profile field');
            }
            key = 'self:profile'; operation = scoped => updateProfile(requested, state, scoped);
        } else {
            const target = groupId(params.groupId), remark = text(params.remark, 1024, true, 'group remark');
            if (enabled.groupRemark !== true) throw problem('UNSUPPORTED', 'QQ cannot update and verify group remarks');
            key = 'group:' + target; operation = scoped => updateGroupRemark(target, remark, state, scoped);
        }
        const controller = new AbortController();
        const scoped = { ...context, expiresAt: Math.min(Date.now() + 10000, context.expiresAt ?? Infinity),
            signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal };
        active(state, scoped);
        try { return await capture.deadline(() => mutate(key, () => operation(scoped)), scoped); }
        finally { controller.abort(); }
    }
    async function dispatch(method, params = {}, context = {}) {
        if (!['profile.like', 'group.atAllRemain', 'profile.update', 'group.remark'].includes(method)) throw problem('UNSUPPORTED', 'Unknown interaction method');
        fields(params, method === 'profile.like' ? ['uid', 'count'] : method === 'profile.update' ? ['nickname', 'personalNote', 'sex'] :
            method === 'group.remark' ? ['groupId', 'remark'] : ['groupId']);
        capture.ensureReady(); synchronize();
        if (params.expectedEpoch !== undefined && params.expectedEpoch !== capture.epoch) {
            throw problem('SESSION_CHANGED', 'Interaction belongs to another QQ session');
        }
        const state = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid };
        if (['profile.update', 'group.remark'].includes(method)) {
            if (typeof state.uin !== 'string' || !/^[1-9]\d{0,9}$/.test(state.uin) || Number(state.uin) > MAX_COUNTER) {
                throw problem('NOT_READY', 'QQ self identity is not a verified account');
            }
            uid(state.uid);
            return modification(method, params, state, context);
        }
        let target, count;
        if (method === 'profile.like') {
            target = uid(params.uid); count = params.count === undefined ? 1 : params.count;
            if (!Number.isInteger(count) || count < 0 || count > 10) throw problem('INVALID_PARAMS', 'Like count must be an integer from 0 to 10');
        } else target = groupId(params.groupId);
        const flag = method === 'profile.like' ? 'profileLike' : 'groupAtAllRemain';
        if (!capabilities()[flag]) throw problem('UNSUPPORTED', 'QQ interaction method is unavailable');
        active(state, context);
        return capture.deadline(() => method === 'profile.like' ? like(target, count, state, context) : remaining(target, state, context), context);
    }
    return { capabilities, dispatch };
}

module.exports = { createInteractions };
