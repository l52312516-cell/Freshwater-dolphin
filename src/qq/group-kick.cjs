'use strict';

function problem(code, message) { return Object.assign(new Error(message), { code }); }
function account(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || BigInt(value) > 0xffffffffn) {
        throw problem('INVALID_RESPONSE', 'QQ returned an invalid member account');
    }
    return value;
}
function uid(value) { return typeof value === 'string' && /^u_[A-Za-z0-9_-]+$/.test(value); }

// A void kick completion proves dispatch only. A complete forced-refresh
// snapshot must show that the exact previously present member has gone.
async function kickMember(capture, params, context = {}) {
    const epoch = capture.epoch, self = { ...capture.self };
    const expiresAt = Math.min(context.expiresAt ?? Infinity, Date.now() + 10000);
    const active = () => {
        capture.ensureReady();
        if (capture.epoch !== epoch || capture.self?.uid !== self.uid || capture.self?.uin !== self.uin) {
            throw problem('SESSION_CHANGED', 'QQ changed during member removal');
        }
        if (context.signal?.aborted || Date.now() >= expiresAt) {
            throw problem('EXPIRED', 'Member removal expired; its result may be unknown; do not retry automatically');
        }
    };
    active();
    if (params.expectedEpoch !== epoch) throw problem('SESSION_CHANGED', 'Member removal belongs to another QQ session');
    if (typeof params.groupId !== 'string' || !/^[1-9]\d{0,9}$/.test(params.groupId) || BigInt(params.groupId) > 0xffffffffn ||
        typeof params.uin !== 'string' || !/^[1-9]\d{0,9}$/.test(params.uin) || BigInt(params.uin) > 0xffffffffn ||
        typeof params.rejectAddRequest !== 'boolean' || typeof params.reason !== 'string' ||
        Buffer.byteLength(params.reason) > 1024 || params.reason.includes('\0')) {
        throw problem('INVALID_PARAMS', 'Invalid member removal parameters');
    }
    if (!capture.hasMethods('group', ['kickMember', 'getAllMemberList'])) {
        throw problem('UNSUPPORTED', 'QQ cannot confirm member removal');
    }
    const target = await capture.resolve({ uin: params.uin });
    active();
    if (target.uin !== params.uin || !uid(target.uid)) throw problem('INVALID_RESPONSE', 'Member removal identity is inconsistent');
    if (target.uid === self.uid || target.uin === self.uin) throw problem('UNSUPPORTED', 'Use the explicit leave action to leave a group');
    const key = JSON.stringify([epoch, params.groupId, target.uid]);
    if (capture.memberMutations.has(key)) throw problem('BUSY', 'A mutation for this group member is awaiting confirmation');
    capture.memberMutations.add(key);
    const snapshot = async () => {
        active();
        const response = await capture.invoke('group', 'getAllMemberList', [params.groupId, true]);
        active();
        if (!response || response.errCode !== 0) throw problem('KERNEL_ERROR', 'QQ rejected the member removal confirmation query');
        const result = response.result;
        if (!result || result.finish !== true || !Array.isArray(result.ids) || result.ids.length > 10000 ||
            !(result.infos instanceof Map) || result.infos.size !== result.ids.length) {
            throw problem('INVALID_RESPONSE', 'QQ returned an incomplete member removal snapshot');
        }
        const seen = new Set(), accounts = new Set();
        for (const item of result.ids) {
            if (!item || typeof item !== 'object' || Array.isArray(item) || !uid(item.uid) || seen.has(item.uid)) {
                throw problem('INVALID_RESPONSE', 'QQ returned inconsistent member identities');
            }
            seen.add(item.uid);
            const record = result.infos.get(item.uid);
            if (!record || record.uid !== item.uid || record.isDelete === true || ![2, 3, 4].includes(record.role)) {
                throw problem('INVALID_RESPONSE', 'QQ returned inconsistent member records');
            }
            const uin = account(record.uin);
            if (accounts.has(uin)) throw problem('INVALID_RESPONSE', 'QQ returned duplicate member accounts');
            accounts.add(uin);
        }
        if ([...result.infos.keys()].some(value => !seen.has(value))) throw problem('INVALID_RESPONSE', 'QQ returned unrelated member records');
        const currentSelf = result.infos.get(self.uid);
        if (!currentSelf || currentSelf.uin !== self.uin) throw problem('INVALID_RESPONSE', 'The acting account is missing from this group snapshot');
        const currentTarget = result.infos.get(target.uid);
        if (currentTarget && currentTarget.uin !== target.uin || !currentTarget && accounts.has(target.uin)) {
            throw problem('INVALID_RESPONSE', 'QQ changed the target member identity');
        }
        return { currentSelf, currentTarget };
    };
    try {
        const before = await snapshot();
        if (!before.currentTarget) throw problem('NOT_FOUND', 'The target is already absent; no member removal was sent');
        if (![3, 4].includes(before.currentSelf.role) || before.currentTarget.role === 4 ||
            before.currentTarget.role === 3 && before.currentSelf.role !== 4) {
            throw problem('UNSUPPORTED', 'This account cannot remove that group member');
        }
        active();
        const accepted = await capture.invoke('group', 'kickMember', [params.groupId, [target.uid], params.rejectAddRequest, params.reason]);
        // QQ versions may resolve a void, request number or opaque completion.
        // None proves success. Only an explicit named failure can stop the
        // confirmation query; the complete before/after snapshots decide it.
        if (accepted instanceof Error) throw problem('KERNEL_ERROR', 'QQ failed member removal');
        if (accepted && typeof accepted === 'object' && !Array.isArray(accepted)) {
            for (const name of ['result', 'errCode', 'retCode']) {
                if (!Object.hasOwn(accepted, name)) continue;
                const code = accepted[name];
                if (['number', 'string'].includes(typeof code) && code !== 0 && code !== '0') {
                    throw problem('KERNEL_ERROR', 'QQ explicitly rejected member removal');
                }
            }
        }
        active();
        for (;;) {
            const after = await snapshot();
            if (!after.currentTarget) return { confirmed: true };
            active();
            await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(1, expiresAt - Date.now()))));
        }
    } finally { capture.memberMutations.delete(key); }
}

module.exports = { kickMember };
