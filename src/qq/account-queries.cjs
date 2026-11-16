'use strict';

function problem(code, message) { return Object.assign(new Error(message), { code }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) {
    if (!object(value) || Object.keys(value).some(key => !['operation', 'expectedEpoch', ...allowed].includes(key))) throw problem('INVALID_PARAMS', 'Unexpected account query parameters');
}
function integer(value, name, maximum = 0xffffffffffffffffn, minimum = 0n) {
    if (!['number', 'string'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) ||
        !/^(0|[1-9]\d{0,19})$/.test(String(value)) || BigInt(value) < minimum || BigInt(value) > maximum) throw problem('INVALID_PARAMS', 'Invalid exact ' + name);
    return String(value);
}
function text(value, maximum, empty = false, code = 'INVALID_PARAMS') {
    if (typeof value !== 'string' || !empty && !value.length || Buffer.byteLength(value) > maximum ||
        /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value).toString('utf8') !== value) throw problem(code, 'Invalid bounded account query text');
    return value;
}
function uid(value) { if (typeof value !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(value)) throw problem('INVALID_PARAMS', 'Expected a verified QQ UID'); return value; }
function peer(value) {
    if (!object(value) || Object.keys(value).some(key => !['chatType', 'peerUid'].includes(key)) || ![1, 2].includes(value.chatType)) throw problem('INVALID_PARAMS', 'Invalid account query peer');
    return { chatType: value.chatType, peerUid: value.chatType === 1 ? uid(value.peerUid) : integer(value.peerUid, 'group UIN', 0xffffffffn, 1n) };
}
function result(value) {
    if (!object(value) || !Object.hasOwn(value, 'result') || !(value.result === 0 || value.result === '0')) {
        throw problem(object(value) && Object.hasOwn(value, 'result') && (Number.isSafeInteger(value.result) || typeof value.result === 'string' && /^-?[1-9]\d{0,9}$/.test(value.result)) ? 'KERNEL_ERROR' : 'INVALID_RESPONSE', 'QQ supplied no successful account query completion');
    }
    for (const key of ['errCode', 'errorCode']) if (Object.hasOwn(value, key) && value[key] !== 0 && value[key] !== '0') throw problem('KERNEL_ERROR', 'QQ returned conflicting account query completion codes');
    return value;
}
function boundedSnapshot(value) {
    let bytes = 0, nodes = 0;
    const active = new Set();
    function spend(count) { bytes += count; if (bytes > 1024 * 1024) throw problem('INVALID_RESPONSE', 'QQ profile-like response exceeds its 1 MiB JSON budget'); }
    function string(value) {
        if (value.length > 1024 * 1024 - bytes) throw problem('INVALID_RESPONSE', 'QQ profile-like string exceeds the remaining JSON budget');
        spend(2);
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i);
            if (code === 34 || code === 92) spend(2);
            else if ([8, 9, 10, 12, 13].includes(code)) spend(2);
            else if (code < 32) spend(6);
            else if (code < 128) spend(1);
            else if (code < 2048) spend(2);
            else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { spend(4); i++; }
            else spend(code >= 0xd800 && code <= 0xdfff ? 6 : 3);
        }
        return value;
    }
    function visit(item, depth = 0) {
        if (++nodes > 50000 || depth > 32) throw problem('INVALID_RESPONSE', 'QQ profile-like response exceeds its node or depth budget');
        if (typeof item === 'string') return string(item);
        if (item === null || typeof item === 'boolean') { spend(item === null ? 4 : item ? 4 : 5); return item; }
        if (typeof item === 'number' && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) { spend(String(item).length); return item; }
        if (!object(item) && !Array.isArray(item) || active.has(item)) throw problem('INVALID_RESPONSE', 'QQ profile-like response contains an unsupported or cyclic JSON value');
        active.add(item); spend(2);
        let copy;
        if (Array.isArray(item)) {
            if (item.length > 50000 - nodes) throw problem('INVALID_RESPONSE', 'QQ profile-like array exceeds its node budget');
            copy = [];
            for (let index = 0; index < item.length; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
                if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw problem('INVALID_RESPONSE', 'QQ profile-like response contains a sparse or accessor array');
                if (index) spend(1); copy.push(visit(descriptor.value, depth + 1));
            }
        } else {
            const prototype = Object.getPrototypeOf(item);
            if (prototype !== Object.prototype && prototype !== null) throw problem('INVALID_RESPONSE', 'QQ profile-like response contains a nonplain JSON object');
            const names = Object.keys(item);
            if (names.length > 50000 - nodes) throw problem('INVALID_RESPONSE', 'QQ profile-like object exceeds its node budget');
            copy = Object.create(null);
            names.forEach((name, index) => {
                const descriptor = Object.getOwnPropertyDescriptor(item, name);
                if (!Object.hasOwn(descriptor, 'value')) throw problem('INVALID_RESPONSE', 'QQ profile-like response contains a JSON accessor');
                if (index) spend(1); string(name); spend(1); copy[name] = visit(descriptor.value, depth + 1);
            });
        }
        active.delete(item); return copy;
    }
    return JSON.parse(JSON.stringify(visit(value)));
}
function validateProfileInfo(value, expectedUid) {
    if (!object(value) || value.uid !== expectedUid) throw problem('INVALID_RESPONSE', 'QQ profile-like uid is missing or differs from the requested UID');
    const time = value.time;
    // The target Linux kernel returns a number; published typings also allow
    // decimal strings. Preserve either exact representation without coercion.
    if (!(typeof time === 'number' && Number.isSafeInteger(time) && time >= 0 ||
        typeof time === 'string' && /^(0|[1-9]\d{0,19})$/.test(time) && BigInt(time) <= 0xffffffffffffffffn)) {
        throw problem('INVALID_RESPONSE', 'QQ profile-like time must be an exact nonnegative integer or decimal string');
    }
    for (const [key, counters] of [['favoriteInfo', ['total_count', 'last_time', 'today_count']], ['voteInfo', ['total_count', 'new_count', 'new_nearby_count', 'last_visit_time']]]) {
        const info = value[key];
        if (!object(info)) throw problem('INVALID_RESPONSE', 'QQ profile-like ' + key + ' must be an object');
        for (const name of counters) if (!Number.isSafeInteger(info[name]) || info[name] < 0) throw problem('INVALID_RESPONSE', 'QQ profile-like ' + key + '.' + name + ' must be an exact nonnegative integer');
        if (!Array.isArray(info.userInfos) || info.userInfos.length > 1000 || info.userInfos.some(row => !object(row))) throw problem('INVALID_RESPONSE', 'QQ profile-like ' + key + '.userInfos must be a bounded object array');
    }
    return boundedSnapshot(value);
}
function validateEmojiUsers(value) {
    if (!Array.isArray(value) || value.length > 15) throw problem('INVALID_RESPONSE', 'QQ supplied an unbounded reaction page');
    const seen = new Set();
    const users = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw problem('INVALID_RESPONSE', 'QQ supplied a sparse or accessor reaction-user array');
        const row = descriptor.value;
        if (!object(row)) throw problem('INVALID_RESPONSE', 'QQ supplied an invalid reaction user');
        const tinyId = text(row.tinyId, 128, false, 'INVALID_RESPONSE');
        if (seen.has(tinyId)) throw problem('INVALID_RESPONSE', 'QQ repeated a reaction user in one page');
        seen.add(tinyId);
        users.push({ tinyId, nickName: text(row.nickName, 1024, true, 'INVALID_RESPONSE'), headUrl: text(row.headUrl, 4096, true, 'INVALID_RESPONSE') });
    }
    return users;
}

function createAccountQueries(capture) {
    // Session changes invalidate results through active(), but cannot prove
    // that older native work stopped. Keep its physical slot until settlement.
    const pending = new Set();
    function capabilities() {
        return { profileLikeRead: capture.hasMethods('profileLike', ['getBuddyProfileLike']),
            messageEmojiLikes: capture.hasMethods('msg', ['getMsgsByMsgId', 'getMsgEmojiLikesList']) };
    }
    async function query(data, context = {}) {
        let request;
        if (data?.operation === 'profile.likes') {
            fields(data, ['uid', 'start', 'count']);
            request = { uid: uid(data.uid), start: Number(integer(data.start === undefined ? 0 : data.start, 'profile offset', 0x7fffffffn)), count: Number(integer(data.count === undefined ? 10 : data.count, 'profile count', 100n, 1n)) };
        } else if (['message.emojiLikes', 'message.locate'].includes(data?.operation)) {
            fields(data, data.operation === 'message.locate' ? ['peer', 'nativeId', 'sequence'] : ['peer', 'nativeId', 'sequence', 'emojiId', 'emojiType', 'cookie']);
            request = { peer: peer(data.peer), nativeId: integer(data.nativeId, 'native message ID', 0xffffffffffffffffn, 1n),
                sequence: integer(data.sequence, 'message sequence', 0xffffffffffffffffn, 1n) };
            if (data.operation === 'message.emojiLikes') {
                Object.assign(request, { emojiId: integer(data.emojiId, 'emoji ID'), emojiType: data.emojiType, cookie: text(data.cookie === undefined ? '' : data.cookie, 4096, true) });
                if (!['1', '2'].includes(request.emojiType)) throw problem('INVALID_PARAMS', 'Explicit emoji type 1 or 2 is required');
            }
        } else throw problem('UNSUPPORTED', 'Unknown account query');
        capture.ensureReady();
        if (data.expectedEpoch !== capture.epoch) throw problem('SESSION_CHANGED', 'Account queries must bind the current QQ session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid };
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) throw problem('SESSION_CHANGED', 'QQ changed during the account query');
            if (context.signal?.aborted || Date.now() >= (context.expiresAt ?? Infinity)) throw problem('EXPIRED', 'Account query expired');
        };
        active();
        const flags = capabilities();
        if (!(data.operation === 'profile.likes' ? flags.profileLikeRead : flags.messageEmojiLikes)) throw problem('UNSUPPORTED', 'This QQ session does not expose the account query method');
        if (pending.size >= 4) throw problem('BUSY', 'Too many account queries still await their native completion');
        const token = {};
        pending.add(token);
        const native = Promise.resolve().then(async () => {
            active();
            if (data.operation === 'profile.likes') {
                const response = await capture.invoke('profileLike', 'getBuddyProfileLike', [{ friendUids: [request.uid], basic: 1, vote: 1,
                    favorite: 0, userProfile: 1, type: request.uid === saved.uid ? 2 : 1, start: request.start, limit: request.count }]);
                active();
                const infos = result(response).info?.userLikeInfos;
                if (!Array.isArray(infos) || infos.length > 256) throw problem('INVALID_RESPONSE', 'QQ supplied no bounded profile-like collection');
                const matches = infos.filter(row => object(row) && row.uid === request.uid);
                if (matches.length !== 1) throw problem('INVALID_RESPONSE', 'QQ did not uniquely identify the requested profile');
                return { operation: data.operation, ...request, profile: validateProfileInfo(matches[0], request.uid) };
            }
            const record = await capture.getMessage({ peer: request.peer, nativeId: request.nativeId });
            active();
            let observed;
            try { observed = integer(record?.msgSeq, 'observed message sequence', 0xffffffffffffffffn, 1n); } catch { throw problem('INVALID_RESPONSE', 'QQ omitted an exact reaction message sequence'); }
            if (!object(record) || record.chatType !== request.peer.chatType || record.peerUid !== request.peer.peerUid || record.msgId !== request.nativeId ||
                observed !== request.sequence) throw problem('INVALID_RESPONSE', 'QQ refreshed a different reaction message locator');
            if (data.operation === 'message.locate') return { operation: data.operation, ...request };
            const response = await capture.invoke('msg', 'getMsgEmojiLikesList', [{ ...request.peer, guildId: '' }, request.sequence,
                request.emojiId, request.emojiType, request.cookie, false, 15]);
            active(); result(response);
            const users = validateEmojiUsers(response.emojiLikesList), cookie = text(response.cookie, 4096, true, 'INVALID_RESPONSE');
            if (typeof response.isLastPage !== 'boolean' || typeof response.isFirstPage !== 'boolean' || response.isFirstPage !== (request.cookie === '') ||
                !response.isLastPage && (!cookie || cookie === request.cookie)) throw problem('INVALID_RESPONSE', 'QQ supplied no reliable progressing reaction pagination state');
            return { operation: data.operation, peer: request.peer, nativeId: request.nativeId, sequence: request.sequence,
                emojiId: request.emojiId, emojiType: request.emojiType, users, cookie, isLastPage: response.isLastPage, isFirstPage: response.isFirstPage };
        });
        native.finally(() => pending.delete(token)).catch(() => {});
        return capture.deadline(() => native, context);
    }
    return { capabilities, query };
}

module.exports = { createAccountQueries, validateProfileInfo, validateEmojiUsers };
