'use strict';

const { createHash } = require('node:crypto');
const MAX_RAW_BYTES = 262144, MAX_BRIEF_BYTES = 4096;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function fields(value, allowed, code = 'INVALID_PARAMS') {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
        Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) ||
            !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail(code, 'Unexpected collection creation fields');
}
function text(value, maximum, empty = true, code = 'INVALID_PARAMS') {
    if (typeof value !== 'string' || !empty && !value.length || Buffer.byteLength(value) > maximum || value.includes('\0') ||
        Buffer.from(value).toString('utf8') !== value) fail(code, 'Invalid bounded collection text');
    return value;
}
function input(value, internal = false) {
    fields(value, ['rawData', 'brief', internal ? 'expectedEpoch' : 'self_id']);
    return { rawData: text(value.rawData, MAX_RAW_BYTES, false), brief: text(value.brief, MAX_BRIEF_BYTES) };
}
function digest(value) { return createHash('sha256').update(JSON.stringify([value.rawData, value.brief])).digest('hex'); }
function acknowledgement(value) {
    fields(value, ['result', 'errMsg'], 'INVALID_RESPONSE');
    if (typeof value.result !== 'number' || !Number.isInteger(value.result) || Object.is(value.result, -0) ||
        value.result < -0x80000000 || value.result > 0x7fffffff) fail('INVALID_RESPONSE', 'QQ supplied no explicit collection creation business status');
    text(value.errMsg, 16384, true, 'INVALID_RESPONSE');
    if (value.result !== 0) fail('KERNEL_ERROR', 'QQ rejected collection creation (result=' + value.result + '); it was not retried');
    return { result: value.result, errMsg: value.errMsg };
}
function nativeRequest(value, self, stamp) {
    if (typeof self?.uin !== 'string' || !/^[1-9]\d{0,9}$/.test(self.uin) || BigInt(self.uin) > 0xffffffffn ||
        typeof self?.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(self.uid)) fail('SESSION_CHANGED', 'Collection creation requires the exact current QQ author');
    const name = text(self.nickname ?? '', 4096, true, 'INVALID_RESPONSE');
    if (!Number.isSafeInteger(stamp) || stamp <= 0) fail('INVALID_RESPONSE', 'Collection creation has no valid local sequence');
    return {
        commInfo: { bid: 1, category: 2, author: { type: 1, numId: self.uin, strId: name, groupId: '0', groupName: '', uid: self.uid },
            createTime: String(stamp), sequence: String(stamp), bizkey: '', bizDataList: [], shareUrl: '', appId: 0, customGroupId: 0,
            modifyTime: '0', qzoneUgcKey: '' },
        richMediaSummary: { originalUri: '', publisher: '', richMediaVersion: 0, subTitle: '', title: '', brief: value.brief,
            picList: [], contentType: 1 },
        richMediaContent: { rawData: value.rawData, bizDataList: [], picList: [], fileList: [] }, need_share_url: false
    };
}
function createCollectionCreate(capture) {
    let writing = false, generation = 0, lastStamp = 0;
    const capabilities = () => ({ collectionCreate: capture.hasMethods('collection', ['createNewCollectionItem']) });
    async function action(data, context = {}) {
        const value = input(data, true); capture.ensureReady();
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid, generation };
        if (data.expectedEpoch !== saved.epoch) fail('SESSION_CHANGED', 'Collection creation must bind the current QQ session');
        if (!capabilities().collectionCreate) fail('UNSUPPORTED', 'This QQ session has no native collection creation method');
        if (writing) fail('BUSY', 'A collection creation still awaits its physical completion');
        const bounded = { ...context, expiresAt: Math.min(Date.now() + 15000, context.expiresAt ?? Infinity) };
        const active = () => { capture.ensureReady();
            if (generation !== saved.generation || capture.epoch !== saved.epoch || capture.session !== saved.session ||
                capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) fail('SESSION_CHANGED', 'QQ changed during collection creation; it was not retried');
            if (bounded.signal?.aborted || Date.now() >= bounded.expiresAt) fail('EXPIRED', 'Collection creation expired; its outcome may be unknown and it was not retried'); };
        active();
        const stamp = Math.max(Date.now(), lastStamp + 1), request = nativeRequest(value, capture.self, stamp); lastStamp = stamp;
        writing = true;
        const task = Promise.resolve().then(async () => {
            active(); let result;
            try { result = await capture.invoke('collection', 'createNewCollectionItem', [request]); }
            catch { active(); fail('QUERY_FAILED', 'Native collection creation failed; its outcome may be unknown and it was not retried'); }
            active();
            return { uin: saved.uin, digest: digest(value), confirmation: 'native_business_ack', ...acknowledgement(result) };
        });
        task.then(() => { writing = false; }, () => { writing = false; });
        const result = await capture.deadline(() => task, bounded, 15000); active(); return result;
    }
    return { capabilities, action, clear() { generation++; } };
}
module.exports = { createCollectionCreate, input, digest, acknowledgement, nativeRequest, MAX_RAW_BYTES, MAX_BRIEF_BYTES };
