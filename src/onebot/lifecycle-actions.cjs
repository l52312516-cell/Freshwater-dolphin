'use strict';

const { runStreamActions } = require('./file-stream-actions.cjs');
const ACTIONS = new Set(['bot_exit', 'set_restart', 'clean_cache']);
const REQUIREMENTS = Object.freeze({ bot_exit: 'managerLifecycle', set_restart: 'managerLifecycle', clean_cache: 'cleanCache' });
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
async function runLifecycleActions(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown lifecycle action');
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => key !== 'self_id')) fail('INVALID_PARAMS', 'Lifecycle actions accept no action-specific parameters');
    if (action === 'clean_cache') {
        if (!service.mediaDirectory) fail('UNSUPPORTED', 'Account-owned temporary cache is unavailable');
        await runStreamActions(service, { ...state, capabilities: { ...state.capabilities, streamFiles: true } }, 'clean_stream_temp_file', {});
        return null;
    }
    const options = service.streamOptions?.getStore?.();
    if (typeof options?.afterResponse !== 'function' || !service.lifecycleClient?.available()) fail('UNSUPPORTED', 'Managed account lifecycle requires a response completion transport');
    await service.assertSession(state);
    const receipt = await service.lifecycleClient.prepare(state, action === 'bot_exit' ? 'stop' : 'restart');
    try {
        await service.assertSession(state);
        if (options.signal?.aborted) fail('EXPIRED', 'Lifecycle response was cancelled');
        options.afterResponse(success => receipt.complete(success));
    } catch (error) { try { await receipt.complete(false); } catch { /* reservation expires if manager became unavailable */ } throw error; }
    return null;
}

module.exports = { ACTIONS, REQUIREMENTS, runLifecycleActions };
