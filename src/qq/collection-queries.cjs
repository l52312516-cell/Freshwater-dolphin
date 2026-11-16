'use strict';

// Budget the complete native page result below the 2 MiB file-RPC envelope.
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_PENDING = 4;
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function unsigned(value, label, maximum = 0xffffffffn, minimum = 0n) {
    if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) ||
        !/^(0|[1-9]\d{0,19})$/.test(String(value)) || BigInt(value) < minimum || BigInt(value) > maximum) {
        throw problem('INVALID_PARAMS', 'Invalid collection ' + label);
    }
    return String(value);
}
function request(value) {
    if (!object(value) || Object.keys(value).some(key => !['expectedEpoch', 'category', 'count', 'timeStamp'].includes(key))) {
        throw problem('INVALID_PARAMS', 'Unexpected collection query parameters');
    }
    return { category: Number(unsigned(value.category === undefined ? 0 : value.category, 'category')),
        count: Number(unsigned(value.count === undefined ? 50 : value.count, 'page size', 100n, 1n)),
        timeStamp: unsigned(value.timeStamp === undefined ? '0' : value.timeStamp, 'page timestamp', 0xffffffffffffffffn) };
}
function snapshot(value) {
    let nodes = 0, bytes = 0;
    function budget(amount) {
        bytes += amount;
        if (bytes > MAX_PAGE_BYTES) throw problem('INVALID_RESPONSE', 'QQ collection page exceeds 1 MiB');
    }
    function visit(item, depth) {
        if (++nodes > 50000 || depth > 20) throw problem('INVALID_RESPONSE', 'QQ collection response is too complex');
        if (item === null || typeof item === 'boolean') { budget(item === null || item === true ? 4 : 5); return item; }
        if (typeof item === 'string') {
            if (Buffer.byteLength(item) > MAX_PAGE_BYTES || item.includes('\0') || Buffer.from(item).toString('utf8') !== item) {
                throw problem('INVALID_RESPONSE', 'QQ collection response contains invalid text');
            }
            budget(Buffer.byteLength(JSON.stringify(item)));
            return item;
        }
        if (typeof item === 'number' && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) {
            budget(Buffer.byteLength(JSON.stringify(item))); return item;
        }
        if (Array.isArray(item)) {
            if (item.length > 10000) throw problem('INVALID_RESPONSE', 'QQ collection response contains an oversized array');
            budget(2 + Math.max(0, item.length - 1));
            const result = [];
            for (let index = 0; index < item.length; index++) result.push(visit(item[index], depth + 1));
            return result;
        }
        if (!object(item)) throw problem('INVALID_RESPONSE', 'QQ collection response is not ordinary JSON data');
        budget(2);
        let entries = 0;
        const result = Object.create(null);
        for (const key in item) {
            if (!Object.hasOwn(item, key)) continue;
            if (++nodes > 50000 || Buffer.byteLength(key) > 256 || Buffer.from(key).toString('utf8') !== key ||
                ['__proto__', 'constructor', 'prototype'].includes(key)) {
                throw problem('INVALID_RESPONSE', 'QQ collection response contains an invalid field');
            }
            const child = item[key];
            // Native optional properties may be undefined; JSON omits them.
            if (child !== undefined) {
                budget(Buffer.byteLength(JSON.stringify(key)) + 1 + Number(entries++ > 0));
                result[key] = visit(child, depth + 1);
            }
        }
        return result;
    }
    const detached = visit(value, 0);
    let json;
    try { json = JSON.stringify(detached); } catch { throw problem('INVALID_RESPONSE', 'QQ collection response cannot be serialized'); }
    if (Buffer.byteLength(json) > MAX_PAGE_BYTES) throw problem('INVALID_RESPONSE', 'QQ collection page exceeds 1 MiB');
    return JSON.parse(json);
}
function validateCollectionPage(value, expected) {
    if (!object(value)) throw problem('INVALID_RESPONSE', 'QQ omitted the collection result');
    const codes = ['result', 'errCode', 'errorCode'].filter(key => Object.hasOwn(value, key));
    if (!codes.length) throw problem('INVALID_RESPONSE', 'QQ collection result has no explicit business status');
    const statuses = codes.map(key => {
        const code = value[key];
        if (!(typeof code === 'number' && Number.isSafeInteger(code) && !Object.is(code, -0) ||
            typeof code === 'string' && /^(0|-?[1-9]\d{0,15})$/.test(code) && Number.isSafeInteger(Number(code)))) {
            throw problem('INVALID_RESPONSE', 'QQ collection result has a malformed ' + key + ' business status');
        }
        return [key, Number(code)];
    });
    if (statuses.some(([, code]) => code !== 0)) {
        // Only fixed field names and exact numeric codes enter public errors.
        // Native errMsg can contain private account or collection details.
        throw problem('KERNEL_ERROR', 'QQ rejected the collection query (' +
            statuses.map(([key, code]) => key + '=' + code).join(', ') + '); it was not retried');
    }
    const page = snapshot(value.collectionSearchList);
    if (!object(page) || !Array.isArray(page.collectionItemList) || page.collectionItemList.length > expected.count ||
        typeof page.hasMore !== 'boolean' || typeof page.bottomTimeStamp !== 'string' ||
        !/^(0|[1-9]\d{0,19})$/.test(page.bottomTimeStamp) || BigInt(page.bottomTimeStamp) > 0xffffffffffffffffn ||
        page.hasMore && (!page.collectionItemList.length || page.bottomTimeStamp === '0' || page.bottomTimeStamp === expected.timeStamp)) {
        throw problem('INVALID_RESPONSE', 'QQ returned an incomplete or non-progressing collection page');
    }
    const identities = new Set();
    for (const item of page.collectionItemList) {
        if (!object(item) || typeof item.cid !== 'string' || !item.cid || Buffer.byteLength(item.cid) > 256 ||
            !['type', 'status', 'category'].every(key => Number.isInteger(item[key]) && item[key] >= 0 && item[key] <= 0xffffffff) ||
            expected.category !== 0 && item.category !== expected.category || !object(item.author) || !object(item.summary) ||
            !['createTime', 'collectTime', 'modifyTime', 'sequence'].every(key => typeof item[key] === 'string' &&
                /^(0|[1-9]\d{0,19})$/.test(item[key]) && BigInt(item[key]) <= 0xffffffffffffffffn)) {
            throw problem('INVALID_RESPONSE', 'QQ returned incomplete or unrelated collection metadata');
        }
        if (identities.has(item.cid)) throw problem('INVALID_RESPONSE', 'QQ returned duplicate collection identities');
        identities.add(item.cid);
    }
    const result = Object.fromEntries(codes.map(key => [key, value[key]]));
    if (Object.hasOwn(value, 'errMsg')) {
        if (typeof value.errMsg !== 'string' || Buffer.byteLength(value.errMsg) > 16384) throw problem('INVALID_RESPONSE', 'QQ returned an invalid collection status message');
        result.errMsg = value.errMsg;
    }
    const complete = { ...result, collectionSearchList: page };
    if (Buffer.byteLength(JSON.stringify(complete)) > MAX_PAGE_BYTES) {
        throw problem('INVALID_RESPONSE', 'QQ collection page result exceeds 1 MiB');
    }
    return complete;
}
function createCollectionQueries(capture) {
    let epoch, session, uin, uid;
    const pending = new Set();
    function synchronize() {
        if (epoch !== capture.epoch || session !== capture.session || uin !== capture.self?.uin || uid !== capture.self?.uid) {
            epoch = capture.epoch; session = capture.session; uin = capture.self?.uin; uid = capture.self?.uid;
            // Changing session invalidates results, not unresolved native work.
            // Its physical slot is released only when the original task settles.
        }
    }
    function capabilities() { synchronize(); return { collectionList: capture.hasMethods('collection', ['getCollectionItemList']) }; }
    async function query(params, context = {}) {
        const input = request(params);
        capture.ensureReady(); synchronize();
        if (!capture.self || params.expectedEpoch !== capture.epoch) throw problem('SESSION_CHANGED', 'Collection query must bind the current QQ session');
        const saved = { epoch, session, uin, uid };
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) {
                throw problem('SESSION_CHANGED', 'QQ changed during the collection query');
            }
            if (context.signal?.aborted || Date.now() >= (context.expiresAt ?? Infinity)) throw problem('EXPIRED', 'Collection query expired');
        };
        active();
        if (!capabilities().collectionList) throw problem('UNSUPPORTED', 'This QQ session has no collection-list query');
        if (pending.size >= MAX_PENDING) throw problem('BUSY', 'Too many collection queries are still pending');
        const token = {}; pending.add(token);
        const operation = Promise.resolve().then(() => {
            active();
            return capture.invoke('collection', 'getCollectionItemList', [{ category: input.category, groupId: -1,
                forceSync: true, forceFromDb: false, timeStamp: input.timeStamp, count: input.count, searchDown: true }]);
        }).then(value => {
            active(); return { ...input, page: validateCollectionPage(value, input) };
        });
        // A caller timing out does not release a still-running native request.
        operation.finally(() => pending.delete(token)).catch(() => {});
        const result = await capture.deadline(() => operation, context);
        active(); return result;
    }
    return { capabilities, query };
}
module.exports = { createCollectionQueries, validateCollectionPage, request };
