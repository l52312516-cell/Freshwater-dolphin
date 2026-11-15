'use strict';

const path = require('node:path');
const BOOTSTRAP = Symbol.for('freshwater.entry');

function bootstrap(originalMain, options = {}) {
  if (typeof originalMain !== 'string' || !path.isAbsolute(originalMain)) throw new TypeError('Original QQ entry must be absolute');
  const globalObject = options.globalObject || globalThis;
  const processObject = options.processObject || process;
  const existing = globalObject[BOOTSTRAP];
  if (existing) {
    if (existing.originalMain !== originalMain) throw new Error('Freshwater already observes a different application');
    if (existing.error) throw existing.error;
    return existing.value;
  }
  const log = options.log || (error => console.error('[freshwater]', error.code || 'STARTUP_ERROR', error.message));
  const state = { originalMain, value: {}, error: null, capture: null, server: null, desktop: null, closed: false };
  Object.defineProperty(globalObject, BOOTSTRAP, { value: state, configurable: true });
  const diagnostic = error => { try { log(error); } catch {} };
  const close = () => {
    if (state.closed) return;
    state.closed = true;
    try { state.desktop?.close(); } catch (error) { diagnostic(error); }
    try { Promise.resolve(state.server?.close()).catch(diagnostic); } catch (error) { diagnostic(error); }
    try { state.capture?.close(); } catch (error) { diagnostic(error); }
  };
  state.close = close;
  try {
    const createCapture = options.createCapture || require('./capture.cjs').createCapture;
    state.capture = createCapture({ processObject, log: diagnostic, ...options.captureOptions });
    const env = options.env || processObject.env || {};
    if (env.FWD_ACCOUNT_ROOT && env.FWD_QQ_BACKGROUND_MODE !== 'off') {
      try {
        const electron = options.electron || require('electron');
        state.desktop = require('./desktop.cjs').manageDesktop({ capture: state.capture, electron,
          expectedUin: env.FWD_EXPECTED_UIN || '', log: diagnostic });
      } catch (error) { diagnostic(error); }
    }
    const dir = options.dir || env.FWD_RPC_DIR;
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('FWD_RPC_DIR must be an absolute private workspace directory');
    const startServer = options.startServer || require('../ipc/server.cjs').startServer;
    state.serverReady = Promise.resolve().then(() => startServer({ dir, backend: state.capture })).then(server => {
      if (state.closed) return Promise.resolve(server.close()).then(() => null);
      state.server = server;
      return server;
    }).catch(error => {
      diagnostic(error);
      state.capture?.close();
      return null;
    });
    if (typeof processObject.once === 'function') processObject.once('exit', close);
  } catch (error) { diagnostic(error); close(); }
  const requireMain = options.requireMain || require;
  try { state.value = requireMain(originalMain); return state.value; }
  catch (error) { state.error = error; close(); throw error; }
}

module.exports = { bootstrap };
