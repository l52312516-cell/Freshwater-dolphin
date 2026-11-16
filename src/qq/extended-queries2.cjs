'use strict';

const fixed = require('./query2-oidb.cjs');
const { createGroupWeb } = require('./group-web.cjs');
const QUERIES = Object.freeze({ 'user.status': ['uin'], 'group.todos': ['groupId'], 'group.signedList': ['groupId'], 'account.onlineClients': ['noCache'] });
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function identifier(value) {
    if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) ||
        !/^[1-9]\d{0,9}$/.test(String(value)) || BigInt(value) > 0xffffffffn) fail('INVALID_PARAMS', 'Expected an exact positive QQ identifier');
    return String(value);
}
function deviceKind(clientType) {
    const value = clientType & 0xff;
    return [1, 5, 15].includes(value) ? '电脑' : [2, 3, 4, 6, 7, 12].includes(value) ? '手机' : [8, 9, 10, 11, 13].includes(value) ? 'Pad' : '未知设备';
}
function onlineClients(value) {
    if (!Array.isArray(value) || value.length > 32) fail('INVALID_RESPONSE', 'QQ omitted a bounded online-device snapshot');
    const clients = [], seen = new Set();
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        const row = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
        if (!row || typeof row !== 'object' || Array.isArray(row) || ![Object.prototype, null].includes(Object.getPrototypeOf(row))) fail('INVALID_RESPONSE', 'QQ returned an invalid online-device entry');
        const selected = {};
        for (const key of ['instanceId', 'clientType', 'devUid']) {
            const property = Object.getOwnPropertyDescriptor(row, key);
            if (!property || !Object.hasOwn(property, 'value')) fail('INVALID_RESPONSE', 'QQ online device omitted a native identity field');
            selected[key] = property.value;
        }
        if (!Number.isInteger(selected.instanceId) || selected.instanceId < 0 || selected.instanceId > 0xffffffff ||
            !Number.isInteger(selected.clientType) || selected.clientType < 1 || selected.clientType > 0xffffffff ||
            typeof selected.devUid !== 'string' || !selected.devUid.length || Buffer.byteLength(selected.devUid) > 128 ||
            /[\u0000-\u001f\u007f]/u.test(selected.devUid) || Buffer.from(selected.devUid).toString('utf8') !== selected.devUid || seen.has(selected.devUid)) fail('INVALID_RESPONSE', 'QQ online device has an invalid or duplicate native identity');
        seen.add(selected.devUid);
        clients.push({ ...selected, deviceKind: deviceKind(selected.clientType) });
    }
    return clients;
}
function createExtendedQueries2(capture, options = {}) {
    const native = options.native || require('./msf-native.cjs'), web = createGroupWeb(capture, options);
    // A caller deadline cannot free a native ticket or HTTP operation which is
    // still unresolved. Retain physical slots across account/epoch changes.
    const pending = new Set(); let onlinePending;
    const listenerMethods = { msg: { onLineDev(value) {
        const current = onlinePending;
        if (!current?.dispatched) return;
        try { current.active(); current.resolve(onlineClients(value)); } catch (error) { current.reject(error); }
    } } };
    function clear() {
        if (onlinePending) onlinePending.reject(Object.assign(new Error('QQ session changed during the online-device query'), { code: 'SESSION_CHANGED' }));
        onlinePending = undefined;
    }
    function capabilities() { return { userStatus: native.available(), groupTodoList: native.available(), groupSignedList: web.supported(),
        onlineClients: capture.hasMethods('msg', ['getOnLineDev']) && capture.registrations?.some(entry => entry.name === 'msg') === true }; }
    async function query(data, callerContext = {}) {
        const allowed = QUERIES[data?.operation];
        if (!allowed) fail('UNSUPPORTED', 'Unknown fixed extended query');
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['operation', 'expectedEpoch', ...allowed].includes(key))) fail('INVALID_PARAMS', 'Unexpected fixed extended query fields');
        const isOnline = data.operation === 'account.onlineClients';
        if (isOnline && data.noCache !== undefined && typeof data.noCache !== 'boolean') fail('INVALID_PARAMS', 'noCache must be boolean');
        if (isOnline && data.noCache === true) fail('UNSUPPORTED', 'QQ getOnLineDev replays its kernel cache and cannot force a network refresh');
        const request = isOnline ? { noCache: false } : Object.fromEntries(allowed.map(key => [key, identifier(data[key])]));
        if (fixed.OPERATIONS.has(data.operation)) fixed.prepare(data.operation, request);
        capture.ensureReady();
        if (data.expectedEpoch !== capture.epoch) fail('SESSION_CHANGED', 'Fixed queries must bind the current QQ session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid };
        const context = { ...callerContext, expiresAt: Math.min(Date.now() + 10000, callerContext.expiresAt ?? Infinity) };
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) fail('SESSION_CHANGED', 'QQ changed during the fixed query');
            if (context.signal?.aborted || Date.now() >= context.expiresAt) fail('EXPIRED', 'Fixed query expired or was cancelled');
        };
        active();
        if (!(isOnline ? capabilities().onlineClients : data.operation === 'group.signedList' ? web.supported() : native.available())) fail('UNSUPPORTED', 'The current QQ session lacks this fixed query capability');
        if (isOnline && onlinePending) fail('BUSY', 'A native online-device snapshot is still unresolved');
        if (pending.size >= 8) fail('BUSY', 'Too many fixed queries still await their actual completion');
        const token = {}; pending.add(token);
        const task = Promise.resolve().then(async () => {
            active();
            if (isOnline) {
                if (onlinePending) fail('BUSY', 'A native online-device snapshot is still unresolved');
                let resolve, reject;
                const snapshot = new Promise((accept, decline) => { resolve = accept; reject = decline; });
                snapshot.catch(() => {});
                const current = { active, resolve, reject, dispatched: false }; onlinePending = current;
                try {
                    current.dispatched = true;
                    const accepted = await capture.invoke('msg', 'getOnLineDev', []);
                    active();
                    if (!accepted || typeof accepted !== 'object' || accepted.result !== 0 ||
                        ['errCode', 'errorCode'].some(key => accepted[key] !== undefined && accepted[key] !== 0)) fail('KERNEL_ERROR', 'QQ did not accept the online-device snapshot query');
                    const clients = await snapshot; active();
                    return { selfUin: saved.uin, clients, source: 'kernel_snapshot' };
                } finally { if (onlinePending === current) onlinePending = undefined; }
            }
            const result = data.operation === 'group.signedList' ? await web.execute(data.operation, request, context, saved) :
                await native.run(capture, { op: 'fixedQuery2', operation: data.operation, request,
                    expectedEpoch: saved.epoch, expectedUin: saved.uin, signal: context.signal,
                    timeoutMs: Math.max(1, context.expiresAt - Date.now()) });
            active(); return result;
        });
        const release = () => pending.delete(token);
        task.then(release, release);
        const result = await capture.deadline(() => task, context);
        active(); return result;
    }
    return { capabilities, query, listenerMethods, clear };
}
module.exports = { createExtendedQueries2, QUERIES, onlineClients, deviceKind };
