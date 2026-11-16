'use strict';

// A transport owns settlement. Registering an action callback never itself
// implies that a response was sent, and every callback runs at most once.
function responseCompletion({ signal, onError = () => {}, timeoutMs = 10000 } = {}) {
    const callbacks = [];
    let settled = false, timer;
    const settle = async success => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
        await Promise.allSettled(callbacks.map(callback => Promise.resolve().then(() => callback(success === true)).catch(onError)));
    };
    const aborted = () => { void settle(false); };
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    return {
        afterResponse(callback) {
            if (settled || typeof callback !== 'function') throw Object.assign(new Error('Response completion is unavailable'), { code: 'EXPIRED' });
            if (callbacks.length >= 4) throw Object.assign(new Error('Too many response callbacks'), { code: 'BUSY' });
            callbacks.push(callback);
            if (!timer) { timer = setTimeout(aborted, timeoutMs); timer.unref?.(); }
        },
        settle
    };
}

module.exports = { responseCompletion };
