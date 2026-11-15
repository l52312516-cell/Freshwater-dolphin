'use strict';

// Opt-in native MSF capture channel. Loads the capture-first detour addon
// (src/native/msf-capture.c) inside QQ's Electron main process and exposes a
// fixed set of observation sub-operations. It does NOT send packets and does
// NOT construct callbacks; install only observes QQ's natural SendMsfRequest
// calls and restores the original bytes on uninstall.
//
// The addon path is derived from the trusted launcher environment, never from
// request parameters. Session binding (expectedEpoch/expectedUin) is enforced
// by the capture handler before this module is reached.
//
// UNTESTED-LIVE: first run must be on a confirmed disposable instance.

const fs = require('node:fs');
const path = require('node:path');

const OPS = new Set(['probe', 'status', 'install', 'readCapture', 'uninstall', 'captureTarget', 'readTarget', 'restoreTarget', 'send', 'readResponse', 'readTemplate', 'fetchRkey', 'fetchGroupFileUrl', 'fetchGroupFileSpace']);
let addon = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function problem(code, message) { return Object.assign(new Error(message), { code }); }

function addonPath() {
    const accountRoot = process.env.FWD_ACCOUNT_ROOT;
    if (typeof accountRoot !== 'string' || !path.isAbsolute(accountRoot)) {
        throw problem('INVALID_CONFIG', 'Native MSF capture requires a managed account workspace');
    }
    const resolved = path.resolve(accountRoot, '..', '..', 'native-build', 'msf-capture.node');
    const expectedDir = path.resolve(accountRoot, '..', '..', 'native-build');
    if (path.dirname(resolved) !== expectedDir) {
        throw problem('INVALID_CONFIG', 'Native MSF capture addon path escapes the build directory');
    }
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw problem('INVALID_CONFIG', 'Native MSF capture addon must be an ordinary file');
    }
    return resolved;
}

function load() {
    if (addon) return addon;
    addon = require(addonPath());
    return addon;
}

// Capability probe: true when the native addon can be loaded in this process.
// Never throws; loading the addon has no hooking side effect (install is separate).
function available() {
    try { load(); return true; } catch { return false; }
}

function jsonSafe(value) {
    return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
}

// Acquire the live session-shell instance via the ssosend detour. If no template
// has been captured yet, prime it with one natural JS send (the hook captures the
// instance synchronously at send time, so poll briefly rather than awaiting the
// full priming response). Shared by every native fetch op.
async function ensureInstance(capture, native) {
    native.install('ssosend');
    let template = native.readTemplate();
    if (template.haveTemplate === 'true') return;
    const rkey = require('./rkey.cjs');
    const service = capture.service('msg');
    if (typeof service.sendSsoCmdReqByContend !== 'function') {
        throw problem('UNSUPPORTED', 'QQ lacks the SSO channel needed to prime the native instance');
    }
    Promise.resolve(service.sendSsoCmdReqByContend(rkey.CMD, rkey.latin1(rkey.encodeRequest()))).catch(() => {});
    const primeDeadline = Date.now() + 3000;
    while (Date.now() < primeDeadline) {
        await sleep(100);
        template = native.readTemplate();
        if (template.haveTemplate === 'true') return;
    }
    throw problem('NOT_READY', 'Native MSF instance was not captured; cannot send');
}

// Poll for a fresh response after send() (which resets the response counter).
async function awaitResponse(native, timeoutMs) {
    const deadline = Date.now() + (Number(timeoutMs) || 8000);
    while (Date.now() < deadline) {
        await sleep(150);
        const rsp = native.readResponse();
        if (rsp.count > 0 && rsp.bodyLen > 0) return Buffer.from(rsp.body);
    }
    return null;
}

// Fetch real download-rkey over the native MSF channel (bypasses the JS
// whitelist) using the verified real-device OidbBase envelope.
async function fetchRkeyNative(capture, params = {}) {
    const native = load();
    const rkey = require('./rkey.cjs');
    await ensureInstance(capture, native);
    const sent = native.send(rkey.NATIVE_CMD, rkey.encodeNativeRequest().toString('hex'));
    if (sent.ok !== 'true') throw problem('QUERY_FAILED', 'Native MSF rkey send failed: ' + (sent.error || ''));
    const body = await awaitResponse(native, params.timeoutMs);
    if (!body) throw problem('TIMEOUT', 'Native MSF rkey response timed out');
    return { rkeys: rkey.decodeResponse(body), via: 'native-msf' };
}

// Fetch a real group-file download URL over the native MSF channel
// (OidbSvcTrpcTcp.0x6d6_2). Proto verified against LLBot oidb.ts/group.ts.
async function fetchGroupFileUrlNative(capture, params = {}) {
    const native = load();
    const gfu = require('./group-file-url.cjs');
    await ensureInstance(capture, native);
    const body = gfu.encodeNativeRequest(params.groupId, params.fileId, params.busId);
    const sent = native.send(gfu.NATIVE_CMD, body.toString('hex'));
    if (sent.ok !== 'true') throw problem('QUERY_FAILED', 'Native MSF group-file send failed: ' + (sent.error || ''));
    const rsp = await awaitResponse(native, params.timeoutMs);
    if (!rsp) throw problem('TIMEOUT', 'Native MSF group-file response timed out');
    const result = gfu.decodeResponse(rsp);
    return { ...result, url: gfu.withFileName(result, params.fileName), via: 'native-msf' };
}

// Fetch real group-file space capacity over the native MSF channel
// (OidbSvcTrpcTcp.0x6d8_3). Proto verified against LLBot oidb.ts/group.ts.
async function fetchGroupFileSpaceNative(capture, params = {}) {
    const native = load();
    const gfs = require('./group-file-space.cjs');
    await ensureInstance(capture, native);
    const body = gfs.encodeNativeRequest(params.groupId);
    const sent = native.send(gfs.NATIVE_CMD, body.toString('hex'));
    if (sent.ok !== 'true') throw problem('QUERY_FAILED', 'Native MSF group-file space send failed: ' + (sent.error || ''));
    const rsp = await awaitResponse(native, params.timeoutMs);
    if (!rsp) throw problem('TIMEOUT', 'Native MSF group-file space response timed out');
    return { ...gfs.decodeResponse(rsp), via: 'native-msf' };
}

function run(capture, params) {
    const op = params && params.op;
    if (typeof op !== 'string' || !OPS.has(op)) {
        throw problem('INVALID_PARAMS', 'Native MSF capture op must be one of probe/status/install/readCapture/uninstall');
    }
    const native = load();
    if (op === 'fetchRkey') return fetchRkeyNative(capture, params);
    if (op === 'fetchGroupFileUrl') return fetchGroupFileUrlNative(capture, params);
    if (op === 'fetchGroupFileSpace') return fetchGroupFileSpaceNative(capture, params);
    switch (op) {
        case 'probe': return jsonSafe(native.probe());
        case 'status': return jsonSafe(native.status());
        case 'install': return jsonSafe(native.install(typeof params.target === 'string' ? params.target : 'sendpacket'));
        case 'readCapture': return jsonSafe(native.readCapture());
        case 'uninstall': return jsonSafe(native.uninstall());
        case 'captureTarget': return jsonSafe(native.captureTarget());
        case 'readTarget': return jsonSafe(native.readTarget());
        case 'restoreTarget': return jsonSafe(native.restoreTarget());
        case 'send': return jsonSafe(native.send(params.cmd, params.bodyHex));
        case 'readResponse': return jsonSafe(native.readResponse());
        case 'readTemplate': return jsonSafe(native.readTemplate());
    }
}

module.exports = { run, OPS, available };