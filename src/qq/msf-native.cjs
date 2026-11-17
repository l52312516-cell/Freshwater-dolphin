'use strict';

// Fixed operations over QQ 3.2.35-54395 x64. One queue belongs to one
// QQ process; immutable native callback IDs isolate timed-out and late responses.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');
const runtimeProfile = require('./runtime-profile.cjs');
const { annotate } = require('../diagnostics.cjs');
const FIXED_PROTOCOLS = Object.freeze({ fixedExtended: './fixed-oidb.cjs', fixedQuery2: './query2-oidb.cjs',
    fixedShare: './share-oidb.cjs', fixedAdmin: './admin-oidb.cjs', fixedCustomFace: './custom-face-protocol.cjs',
    fixedContactExtra: './contact-extra-protocol.cjs', fixedGroupAlbum: './group-album-protocol.cjs', fixedMiscExtra: './misc-extra-protocol.cjs',
    fixedFlashTransfer: './flash-transfer-protocol.cjs', fixedForwardUpload: './forward-upload-protocol.cjs', fixedVoiceExtra: './voice-extra-protocol.cjs',
    fixedDbKey: './db-key-protocol.cjs', fixedUrlSafety: './url-safety-protocol.cjs', fixedAnonymous: './anonymous-protocol.cjs',
    fixedProfile: './profile-update-protocol.cjs' });
const OPS = new Set(['rawPacket', 'fetchRkey', 'fetchGroupFileUrl', 'fetchGroupFileSpace', 'fetchVideoUrl', 'fetchPrivateFileUrl', ...Object.keys(FIXED_PROTOCOLS)]);
const MAX_QUEUED = 32;
let addon = null;
let profileProvider = null;
function bindProfile(provider) { profileProvider = provider; }
function currentProfile(capture) {
    return typeof capture?.runtimeProfile === 'function' ? capture.runtimeProfile() :
        profileProvider ? profileProvider() : runtimeProfile.fromEnvironment();
}
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function addonPath() {
    const configured = process.env.FWD_MSF_ADDON_PATH, accountRoot = process.env.FWD_ACCOUNT_ROOT;
    if (!configured && (typeof accountRoot !== 'string' || !path.isAbsolute(accountRoot))) throw problem('INVALID_CONFIG', 'Native MSF requires a managed account workspace');
    const resolved = configured || path.resolve(accountRoot, '..', '..', 'native-build', 'msf-capture.node');
    if (!path.isAbsolute(resolved)) throw problem('INVALID_CONFIG', 'Native MSF addon path must be absolute');
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) throw problem('INVALID_CONFIG', 'Native MSF addon must be an ordinary file');
    return resolved;
}
function load() {
    if (!addon) {
        const loaded = require(addonPath());
        if (loaded.protocolVersion !== 2 || typeof loaded.release !== 'function') throw problem('UNSUPPORTED', 'Rebuild native MSF for request correlation protocol 2');
        addon = loaded;
    }
    return addon;
}
function available(capture) { try {
    if (currentProfile(capture).native_eligible !== true) return false;
    const native = load(); return typeof native.verifyTarget === 'function' && success(native.verifyTarget().ok);
} catch { return false; } }
function success(value) { return value === true || value === 'true'; }

// Test dependencies cannot be selected through RPC parameters.
function createChannel({ loadNative = load, now = () => performance.now(), sleep = ms => pause(ms), pollMs = 30 } = {}) {
    const waiting = [];
    const statistics = require('./packet-statistics.cjs').createPacketStatistics();
    let current = null, lastSession = null;
    function pump() {
        if (current || !waiting.length) return;
        const entry = waiting.shift();
        current = entry; entry.started = true;
        Promise.resolve().then(entry.execute).then(entry.resolve, entry.reject).finally(() => {
            current = null; pump();
        }).catch(() => {});
    }
    function run(capture, params = {}) {
        if (!OPS.has(params.op)) return Promise.reject(problem('INVALID_PARAMS', 'Unsupported fixed native operation'));
        if (params.diagnostic !== undefined && (params.op !== 'fetchPrivateFileUrl' || params.diagnostic !== 'resource-metadata' ||
            params.transport !== undefined && params.transport !== 'oidb')) {
            return Promise.reject(problem('INVALID_PARAMS', 'Private file diagnostics require the fixed OIDB query'));
        }
        let raw;
        if (params.op === 'rawPacket') {
            try { raw = require('./raw-packet.cjs').prepare(params); }
            catch (error) { return Promise.reject(error); }
        }
        const timeoutMs = params.timeoutMs ?? 10000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) return Promise.reject(problem('INVALID_PARAMS', 'Invalid native deadline'));
        if (waiting.length + (current ? 1 : 0) >= MAX_QUEUED) return Promise.reject(problem('BUSY', 'Native operation queue is full'));
        const deadline = now() + timeoutMs, epoch = params.expectedEpoch ?? capture.epoch;
        const uin = String(params.expectedUin ?? capture.self?.uin ?? '');
        if (params.op === 'fixedProfile') {
            try {
                const prepared = require('./profile-update-protocol.cjs').prepare(params.operation, params.request);
                if (prepared.data.uin !== uin || uin !== String(capture.self?.uin ?? '')) {
                    throw problem('SESSION_CHANGED', 'Profile update must target the authenticated account');
                }
            } catch (error) { return Promise.reject(error); }
        }
        const controller = new AbortController();
        const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal;
        function check() {
            if (signal.aborted) throw typeof signal.reason?.code === 'string' ? signal.reason : problem('TIMEOUT', 'Native operation cancelled');
            if (capture.closed || capture.epoch !== epoch || String(capture.self?.uin ?? '') !== uin) throw problem('SESSION_CHANGED', 'QQ session changed during native operation');
            if (now() >= deadline) throw problem('TIMEOUT', 'Native operation exceeded its total deadline');
        }
        async function wait() { check(); await sleep(Math.max(1, Math.min(pollMs, deadline - now()))); check(); }
        const execute = async () => {
            check();
            // Injected test channels exercise the transport without loading
            // QQ. Production always checks exact identity before installation.
            if (loadNative === load && currentProfile(capture).native_eligible !== true) throw annotate(
                problem('UNSUPPORTED', 'Native MSF requires the exact verified QQ runtime profile'),
                { reason: 'native_profile_mismatch', phase: 'session' });
            const native = loadNative(), session = JSON.stringify([epoch, uin]);
            if (lastSession !== session) { native.resetSession(); lastSession = session; }
            const installed = native.install('ssosend');
            if (!success(installed.ok)) throw problem('UNSUPPORTED', 'Native MSF target does not match the supported QQ build');
            if (!success(native.readTemplate().haveTemplate)) {
                const rkey = require('./rkey.cjs'), service = capture.service('msg');
                if (typeof service.sendSsoCmdReqByContend !== 'function') throw problem('UNSUPPORTED', 'QQ lacks the native session priming channel');
                Promise.resolve(service.sendSsoCmdReqByContend(rkey.CMD, rkey.latin1(rkey.encodeRequest()))).catch(() => {});
                while (!success(native.readTemplate().haveTemplate)) await wait();
            }
            check();
            let command, request, decode, allowEmptyResponse = false;
            if (raw) {
                command = raw.command; request = raw.body;
                decode = body => ({ responseHex: body.toString('hex') });
                allowEmptyResponse = true;
            } else if (Object.hasOwn(FIXED_PROTOCOLS, params.op)) {
                const proto = require(FIXED_PROTOCOLS[params.op]);
                const prepared = proto.prepare(params.operation, params.request);
                command = prepared.name; request = prepared.body; decode = body => proto.decode(body, prepared);
                allowEmptyResponse = prepared.allowEmptyResponse === true;
            } else if (params.op === 'fetchRkey') {
                const proto = require('./rkey.cjs');
                command = proto.NATIVE_CMD; request = proto.encodeNativeRequest(); decode = body => ({ rkeys: proto.decodeResponse(body) });
            } else if (params.op === 'fetchGroupFileUrl') {
                const proto = require('./group-file-url.cjs');
                command = proto.NATIVE_CMD; request = proto.encodeNativeRequest(params.groupId, params.fileId, params.busId);
                decode = body => { const result = proto.decodeResponse(body); return { ...result, url: proto.withFileName(result, params.fileName) }; };
            } else if (params.op === 'fetchGroupFileSpace') {
                const proto = require('./group-file-space.cjs');
                command = proto.NATIVE_CMD; request = proto.encodeNativeRequest(params.groupId); decode = proto.decodeResponse;
            } else if (params.op === 'fetchPrivateFileUrl') {
                const proto = require('./private-file-url.cjs');
                if (params.transport !== undefined && !['oidb', 'offline'].includes(params.transport)) throw problem('INVALID_PARAMS', 'Invalid fixed private file transport');
                if (params.transport === 'offline') {
                    command = proto.OFFLINE_CMD; request = proto.encodeOfflineRequest(uin, params.fileId);
                    decode = body => proto.decodeOfflineResponse(body, { fileId: params.fileId });
                } else {
                    command = proto.NATIVE_CMD; request = proto.encodeNativeRequest(capture.self?.uid, params.fileId, params.fileHash);
                    decode = body => proto.decodeResponse(body, { fileId: params.fileId, fileHash: params.fileHash }, params.diagnostic);
                }
            } else {
                const proto = require('./video-url.cjs'), group = params.isGroup !== false;
                command = proto.groupCmd(group); request = proto.encodeNativeRequest(params.fileUuid, group, params.targetUid);
                decode = body => proto.decodeResponse(body, group);
            }
            check();
            const sent = native.send(command, request.toString('hex'));
            if (!success(sent.ok) || !/^[1-9]\d*$/.test(String(sent.requestId))) throw problem('QUERY_FAILED', 'Native MSF query could not be submitted');
            statistics.record('submitted', request.length);
            const id = String(sent.requestId);
            try {
                // Submission is the complete contract for rsp=false. It says
                // nothing about the server accepting the requested business action.
                if (raw?.rsp === false) { check(); return { submitted: true, via: 'native-msf' }; }
                while (true) {
                    check();
                    const response = native.readResponse(id);
                    if (String(response.requestId) !== id) throw problem('INVALID_RESPONSE', 'Native response request ID mismatch');
                    if (response.count > 0) {
                        statistics.record('response', response.body?.length || 0);
                        if (BigInt(response.result) !== 0n) throw problem('QUERY_FAILED', 'QQ native query returned a transport error');
                        if (!response.body?.length) {
                            const size = /^(0|[1-9]\d{0,19})$/.test(String(response.responseBytes)) ? String(response.responseBytes) : 'unknown';
                            const status = ['empty', 'too_large', 'invalid', 'allocation_failed'].includes(response.bodyStatus) ? response.bodyStatus : 'unknown';
                            if (!allowEmptyResponse || status !== 'empty' || size !== '0') throw problem('QUERY_FAILED', 'QQ native query returned no response body [status=' + status + ',bytes=' + size + ']');
                        }
                        const result = decode(Buffer.from(response.body || []));
                        check(); return { ...result, via: 'native-msf' };
                    }
                    await wait();
                }
            } finally { native.release(id); }
        };
        return new Promise((resolve, reject) => {
            let settled = false, timer;
            const settle = (error, value) => {
                if (settled) return;
                settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
                statistics.record(!error ? 'succeeded' : params.signal?.aborted ? 'cancelled' : ['TIMEOUT', 'EXPIRED'].includes(error.code) ? 'timed_out' : 'failed');
                if (error) reject(error); else resolve(value);
            };
            const entry = { execute, started: false, resolve: value => settle(null, value), reject: error => settle(error) };
            const abort = () => {
                settle(typeof signal.reason?.code === 'string' ? signal.reason : problem('TIMEOUT', 'Native operation cancelled'));
                if (!entry.started) {
                    const index = waiting.indexOf(entry);
                    if (index !== -1) waiting.splice(index, 1);
                    pump();
                }
            };
            signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => controller.abort(problem('TIMEOUT', 'Native operation exceeded its total deadline')), timeoutMs);
            waiting.push(entry);
            statistics.record('queued');
            if (signal.aborted) abort(); else pump();
        });
    }
    return { run, statistics: () => ({ ...statistics.snapshot(), queued: waiting.length, active: current !== null }) };
}
const channel = createChannel();
function status() {
    const value = load().status();
    return { protocolVersion: 2, installed: Boolean(value.installed), targetVerified: available(), liveRequests: Number(value.liveRequests) };
}
function packetStatus() {
    let native = { installed: false, targetVerified: false, liveRequests: 0 };
    try { native = status(); } catch {}
    return { ...channel.statistics(), native };
}
module.exports = { run: channel.run, OPS, available, createChannel, status, packetStatus, bindProfile };
