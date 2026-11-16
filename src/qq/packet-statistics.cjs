'use strict';

const EVENTS = new Set(['queued', 'submitted', 'response', 'succeeded', 'failed', 'cancelled', 'timed_out']);
function createPacketStatistics() {
    const counters = Object.fromEntries([...EVENTS].map(name => [name, 0n])); let requestBytes = 0n, responseBytes = 0n;
    const exact = value => value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
    function record(event, bytes = 0) {
        if (!EVENTS.has(event) || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 16 * 1024 * 1024 || !['submitted', 'response'].includes(event) && bytes !== 0) throw Object.assign(new Error('Invalid aggregate packet statistics event'), { code: 'INVALID_PARAMS' });
        counters[event]++;
        if (event === 'submitted') requestBytes += BigInt(bytes);
        if (event === 'response') responseBytes += BigInt(bytes);
    }
    function snapshot() {
        return { scope: 'adapter-native-sso', resetScope: 'worker-process', includesAllQQTraffic: false, includesUnawaitedResponses: false,
            counters: Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, exact(value)])), requestBytes: exact(requestBytes), responseBytes: exact(responseBytes) };
    }
    return { record, snapshot };
}
module.exports = { createPacketStatistics, EVENTS };
