'use strict';

// QQ Linux 3.2.35-54395 NodeIKernelFlashTransferService binding, statically
// verified from the installed wrapper.node request/response converters.
// This removes the current account's server history entry. It does not assert
// physical storage erasure or revoke all other users' copies/share access.
const fixed = require('./flash-transfer-protocol.cjs');
let sequence = 1;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function createFlashDelete(capture) {
    function service() {
        capture.ensureReady();
        const getter = capture.session?.getFlashTransferService;
        if (typeof getter !== 'function') fail('UNSUPPORTED', 'QQ lacks the fixed flash history service');
        const value = Reflect.apply(getter, capture.session, []);
        if (typeof value?.batchRemoveUserFileSetHistory !== 'function') fail('UNSUPPORTED', 'QQ lacks fixed flash history deletion');
        return value;
    }
    return {
        available() { try { service(); return true; } catch { return false; } },
        async remove(filesetId, active = () => capture.ensureReady()) {
            fixed.uuid(filesetId); active();
            const target = service(), seq = sequence; sequence = sequence === 0x7fffffff ? 1 : sequence + 1;
            const request = { seq, fileSetIdList: [filesetId], cancelOnDeleteUserRecords: false, cancelFileSetIdList: [] };
            // Exactly one fixed method, one explicit ID and no cancellation targets.
            const value = await Reflect.apply(target.batchRemoveUserFileSetHistory, target, [request]);
            active();
            const rsp = value?.rsp;
            if (!fixed.object(value) || Object.keys(value).some(key => key !== 'rsp') || !fixed.object(rsp) ||
                Object.keys(rsp).some(key => !['seq', 'result', 'errMs'].includes(key)) || rsp.seq !== seq ||
                !Number.isInteger(rsp.result) || rsp.result < -0x80000000 || rsp.result > 0x7fffffff ||
                typeof rsp.errMs !== 'string' || Buffer.byteLength(rsp.errMs) > 4096) fail('INVALID_RESPONSE', 'QQ did not correlate the fixed flash history deletion');
            if (rsp.result !== 0) fail('KERNEL_ERROR', 'QQ rejected flash history deletion; it was not retried');
            return { filesetId, confirmed: true, confirmation: 'native_history_ack' };
        }
    };
}
module.exports = { createFlashDelete };
