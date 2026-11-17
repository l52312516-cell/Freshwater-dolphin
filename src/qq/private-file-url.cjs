'use strict';

// Fixed private-file URL query. Wire fields have been checked against the
// current QQApi schema and the published 0xe37_1200 definition. This module is
// independently implemented; it does not expose arbitrary SSO commands.
// UID mode is field12=0. Preserve the message's actual file10MMd5 input:
// this build may supply a 32-hex checksum while 140/145 carry opaque addons.
// Metadata aliases are checked below; actual downloads are verified separately.
const net = require('node:net');
const { problem, varintField, bytesField, messageField, fields } = require('./proto.cjs');

const COMMAND = 0xe37;
const SUBCOMMAND = 1200;
const CMD = `OidbSvc.0x${COMMAND.toString(16)}_${SUBCOMMAND}`;
const NATIVE_CMD = `OidbSvcTrpcTcp.0x${COMMAND.toString(16)}_${SUBCOMMAND}`;
const OFFLINE_CMD = 'OfflineFilleHandleSvr.pb_ftn_CMD_REQ_APPLY_DOWNLOAD-1200';
const U32 = 0xffffffffn;

function opaque(value, label, limit) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > limit ||
        /[\x00-\x1f\x7f]/.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) {
        throw problem('INVALID_PARAMS', 'Private file URL requires a valid ' + label);
    }
    return value;
}
function resource(fileId, fileHash) {
    return { fileId: opaque(fileId, 'file UUID', 1024), fileHash: opaque(fileHash, 'opaque file hash', 4096) };
}
function encodeNativeRequest(selfUid, fileId, fileHash) {
    if (typeof selfUid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(selfUid)) {
        throw problem('INVALID_PARAMS', 'Private file URL requires the observed account UID');
    }
    const item = resource(fileId, fileHash);
    const inner = Buffer.concat([
        varintField(1, SUBCOMMAND), varintField(2, 1),
        messageField(14, [bytesField(10, Buffer.from(selfUid)), bytesField(20, Buffer.from(item.fileId)),
            varintField(30, 2), bytesField(60, Buffer.from(item.fileHash)), varintField(601, 0)]),
        varintField(101, 3), varintField(102, 103), varintField(200, 1),
        bytesField(99999, Buffer.from([0xc0, 0x85, 0x2c, 0x01]))
    ]);
    return Buffer.concat([varintField(1, COMMAND), varintField(2, SUBCOMMAND), varintField(3, 0),
        bytesField(4, inner), varintField(12, 0)]);
}

function field(map, tag, wire, required = false) {
    const values = map.get(tag) || [];
    if (values.length > 1 || values.length === 1 && values[0].wire !== wire || required && !values.length) {
        throw problem('INVALID_RESPONSE', 'Private file response has an invalid field');
    }
    return values[0]?.value;
}
function integer(map, tag, required = false) {
    const value = field(map, tag, 0, required);
    if (value !== undefined && value > U32) throw problem('INVALID_RESPONSE', 'Private file response integer is out of range');
    return value;
}
function string(map, tag, limit, required = false) {
    const bytes = field(map, tag, 2, required);
    if (bytes === undefined) return undefined;
    if (bytes.length > limit) throw problem('INVALID_RESPONSE', 'Private file response text is too large');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw problem('INVALID_RESPONSE', 'Private file response contains invalid UTF-8'); }
}
function nested(map, tag) { return fields(field(map, tag, 2, true)); }

function downloadUrl(host, port, target, thumbnail = true, scheme = 'http:') {
    if (!host || host.length > 253 || /[\s/@?#\\%\x00-\x1f\x7f]/.test(host)) {
        throw problem('INVALID_RESPONSE', 'Invalid private file download authority');
    }
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    const ip = net.isIP(bare);
    if (!ip && (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
        !/(?:^|\.)qq\.com(?:\.cn)?$/i.test(host))) {
        throw problem('INVALID_RESPONSE', 'Invalid private file download host');
    }
    if (!['http:', 'https:'].includes(scheme) || typeof port !== 'bigint' || port < 1n || port > 65535n || typeof target !== 'string' || !target.startsWith('/') ||
        target.startsWith('//') || /[\s#\\\x00-\x1f\x7f]/.test(target) || /%(?![a-f0-9]{2})/i.test(target)) {
        throw problem('INVALID_RESPONSE', 'Invalid private file download target');
    }
    const authority = ip === 6 ? '[' + bare + ']' : host;
    const value = `${scheme}//${authority}:${port}${target}`;
    let parsed;
    try { parsed = new URL(value); }
    catch { throw problem('INVALID_RESPONSE', 'Invalid private file download URL'); }
    const expectedHost = ip === 6 ? '[' + bare.toLowerCase() + ']' : host.toLowerCase();
    const targetAfterParsing = parsed.pathname + parsed.search;
    if (parsed.hostname.toLowerCase() !== expectedHost || (parsed.port || (scheme === 'https:' ? '443' : '80')) !== String(port) ||
        parsed.username || parsed.password || parsed.hash ||
        targetAfterParsing !== target && !(target.endsWith('?') && targetAfterParsing === target.slice(0, -1))) {
        throw problem('INVALID_RESPONSE', 'Private file download URL changed during validation');
    }
    // Do not normalize or reserialize a server-issued signed path/query.
    return thumbnail ? value + (target.includes('?') ? '&' : '?') + 'isthumb=0' : value;
}

function metadataDiagnostic(item) {
    return { diagnosticOnly: true, diagnostic: 'resource-metadata', version: 2, businessSuccess: false,
        decoderAccepted: false, phase: 'envelope', errorCode: null, metadataPresent: false, metadataParsed: false,
        failedChecks: [], checks: {
            id6Present: false, id144Present: false, hash140Present: false, hash145Present: false, checksum100Present: false,
            id6EqualsInput: false, id144EqualsInput: false, hash140EqualsInput: false, hash145EqualsInput: false,
            checksum100LengthIs16: false, inputHashIs32Hex: /^[a-fA-F0-9]{32}$/.test(item.fileHash),
            checksumComparisonApplicable: false, checksum100EqualsInput: false, originalChecksumMatches: false, directChecksumMatches: false,
            idCheckRequired: false, hashCheckRequired: false, idMatches: false, hashMatches: false, aliasChecksumRequired: false
        } };
}

function decodeResponse(buffer, expected, diagnostic) {
    if (diagnostic !== undefined && diagnostic !== 'resource-metadata') {
        throw problem('INVALID_PARAMS', 'Invalid private file diagnostic mode');
    }
    const item = resource(expected?.fileId, expected?.fileHash);
    const observation = diagnostic === 'resource-metadata' ? metadataDiagnostic(item) : null;
    let phase = 'envelope';
    try {
    const top = fields(buffer);
    if (integer(top, 1, true) !== BigInt(COMMAND) || integer(top, 2, true) !== BigInt(SUBCOMMAND) ||
        (integer(top, 12) ?? 0n) !== 0n) throw problem('INVALID_RESPONSE', 'Private file response identity mismatch');
    phase = 'envelope-status';
    if ((integer(top, 3) ?? 0n) !== 0n) throw problem('QUERY_FAILED', 'QQ rejected the private file URL query');
    phase = 'payload';
    const payload = nested(nested(top, 4), 14);
    // The meaning of nonzero field10 is not established by the schema.
    if ((integer(payload, 10) ?? 0n) !== 0n) throw problem('UNSUPPORTED', 'Private file response contains an unverified status');
    phase = 'routing-fields';
    const result = nested(payload, 30);
    const host = string(result, 20, 253, true), port = integer(result, 40, true), target = string(result, 50, 8192, true);
    phase = 'resource-metadata';
    if (observation) observation.metadataPresent = payload.has(40);
    const metadata = field(payload, 40, 2);
    let fileName;
    if (metadata !== undefined) {
        const info = fields(metadata), returnedId = string(info, 6, 1024), returnedHash = string(info, 140, 4096);
        // This QQ build can return a canonical file in 6/140 while retaining
        // the requested UUID/addon in 144/145. Its 32-hex file10MMd5 is also
        // returned as 16 bytes in field100; it is not the 87-byte addon string.
        // Accept that observed variant only with the exact original UUID AND
        // its checksum, never by filename, case folding or a missing identity.
        const originalId = string(info, 144, 1024), originalHash = string(info, 145, 4096);
        const checksum = field(info, 100, 2);
        const originalChecksumMatches = originalId === item.fileId && /^[a-fA-F0-9]{32}$/.test(item.fileHash) &&
            checksum?.length === 16 && checksum.equals(Buffer.from(item.fileHash, 'hex'));
        // The directly returned UUID can identify the same original file while
        // field140 carries an opaque addon. Trust its checksum only together
        // with that exact UUID; checksum alone never identifies a resource.
        const directChecksumMatches = returnedId === item.fileId && /^[a-fA-F0-9]{32}$/.test(item.fileHash) &&
            checksum?.length === 16 && checksum.equals(Buffer.from(item.fileHash, 'hex'));
        const idMatches = returnedId === item.fileId || originalId === item.fileId;
        const hashMatches = returnedHash === item.fileHash || originalHash === item.fileHash || originalChecksumMatches || directChecksumMatches;
        const idCheckRequired = returnedId !== undefined || originalId !== undefined;
        const hashCheckRequired = returnedHash !== undefined || originalHash !== undefined;
        const aliasChecksumRequired = originalId === item.fileId && returnedId !== item.fileId && originalHash !== item.fileHash;
        if (observation) {
            const applicable = observation.checks.inputHashIs32Hex && checksum?.length === 16;
            observation.metadataParsed = true;
            observation.checks = { ...observation.checks,
                id6Present: returnedId !== undefined, id144Present: originalId !== undefined,
                hash140Present: returnedHash !== undefined, hash145Present: originalHash !== undefined, checksum100Present: checksum !== undefined,
                id6EqualsInput: returnedId === item.fileId, id144EqualsInput: originalId === item.fileId,
                hash140EqualsInput: returnedHash === item.fileHash, hash145EqualsInput: originalHash === item.fileHash,
                checksum100LengthIs16: checksum?.length === 16, checksumComparisonApplicable: applicable === true,
                checksum100EqualsInput: applicable === true && checksum.equals(Buffer.from(item.fileHash, 'hex')),
                originalChecksumMatches: originalChecksumMatches === true, directChecksumMatches: directChecksumMatches === true,
                idCheckRequired, hashCheckRequired, idMatches, hashMatches, aliasChecksumRequired };
            if (idCheckRequired && !idMatches) observation.failedChecks.push('ID_ALIAS_NOT_MATCHED');
            if (hashCheckRequired && !hashMatches) observation.failedChecks.push('HASH_ALIAS_NOT_MATCHED');
            if (aliasChecksumRequired && !originalChecksumMatches) observation.failedChecks.push('ORIGINAL_ALIAS_CHECKSUM_REQUIRED');
        }
        if (idCheckRequired && !idMatches || hashCheckRequired && !hashMatches || aliasChecksumRequired && !originalChecksumMatches) {
            throw problem('INVALID_RESPONSE', 'Private file response belongs to another resource');
        }
        phase = 'resource-name';
        fileName = string(info, 7, 1024);
    }
    phase = 'url-validation';
    const url = downloadUrl(host, port, target);
    if (observation) return { ...observation, decoderAccepted: true, phase: 'complete' };
    return { fileId: item.fileId, url, ...(fileName ? { fileName } : {}) };
    } catch (error) {
        if (!observation) throw error;
        // Never return the error text, raw fields, URL, resource identifiers or
        // checksums. Diagnostic mode is a closed observation, never a URL result.
        return { ...observation, phase, errorCode: ['INVALID_RESPONSE', 'QUERY_FAILED', 'UNSUPPORTED'].includes(error?.code)
            ? error.code : 'INTERNAL_ERROR' };
    }
}

function fromFileElement(element) {
    if (!element || typeof element !== 'object') throw problem('INVALID_PARAMS', 'Private file element is required');
    // Keep the real message field: 32-hex values are checked against the native
    // response checksum; do not guess a replacement from fileMd5 or fileSubId.
    return resource(element.fileUuid, element.file10MMd5);
}

// Classic offline-file service uses numeric UIN and a bare service protobuf,
// not the UID-mode OIDB envelope above. Public clients agree on these fields;
// support by this QQ build must still be established by a real native query.
function encodeOfflineRequest(selfUin, fileId) {
    if (!['string', 'number', 'bigint'].includes(typeof selfUin) || typeof selfUin === 'number' && !Number.isSafeInteger(selfUin)) {
        throw problem('INVALID_PARAMS', 'Offline file URL requires an exact numeric account UIN');
    }
    const uin = String(selfUin ?? '');
    if (!/^[1-9]\d{0,9}$/.test(uin) || BigInt(uin) > U32) {
        throw problem('INVALID_PARAMS', 'Offline file URL requires the observed numeric account UIN');
    }
    return Buffer.concat([varintField(1, SUBCOMMAND),
        messageField(14, [varintField(10, BigInt(uin)), bytesField(20, Buffer.from(opaque(fileId, 'file UUID', 1024))), varintField(30, 2)]),
        varintField(101, 3), varintField(102, 104), messageField(99999, [varintField(1, 90200)])]);
}

function absoluteDownloadUrl(value, declaredHost, declaredPort) {
    const matched = /^(https?):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::([0-9]+))?(\/[^]*)$/i.exec(value);
    if (!matched) throw problem('INVALID_RESPONSE', 'Invalid absolute offline file URL');
    const scheme = matched[1].toLowerCase() + ':';
    const port = BigInt(matched[3] || (scheme === 'https:' ? '443' : '80'));
    downloadUrl(matched[2], port, matched[4], false, scheme);
    // Some responses include both an absolute URL and the separate routing
    // fields. Do not let the URL silently override a different destination.
    if (declaredPort !== undefined && declaredPort !== port) throw problem('INVALID_RESPONSE', 'Offline file download port identity mismatch');
    if (declaredHost !== undefined) {
        const routed = new URL(downloadUrl(declaredHost, port, matched[4], false, scheme));
        if (routed.hostname !== new URL(value).hostname) throw problem('INVALID_RESPONSE', 'Offline file download host identity mismatch');
    }
    return value;
}

function decodeOfflineResponse(buffer, expected) {
    const fileId = opaque(expected?.fileId, 'file UUID', 1024), top = fields(buffer);
    const command = integer(top, 1);
    if (command !== undefined && command !== BigInt(SUBCOMMAND)) throw problem('INVALID_RESPONSE', 'Offline file response command mismatch');
    const payload = nested(top, 14);
    if ((integer(payload, 10) ?? 0n) !== 0n) throw problem('QUERY_FAILED', 'QQ rejected the offline file URL query');
    const result = nested(payload, 30), target = string(result, 50, 8192, true);
    const absolute = /^https?:\/\//i.test(target);
    const host = string(result, 30, 253, !absolute), port = integer(result, 40, !absolute);
    const url = absolute ? absoluteDownloadUrl(target, host, port) : downloadUrl(host, port, target, false);
    const metadata = field(payload, 40, 2);
    let fileName;
    if (metadata !== undefined) {
        const info = fields(metadata), returnedId = string(info, 6, 1024);
        if (returnedId !== undefined && returnedId !== fileId) throw problem('INVALID_RESPONSE', 'Offline file response belongs to another resource');
        fileName = string(info, 7, 1024);
    }
    return { fileId, url, ...(fileName ? { fileName } : {}) };
}

module.exports = { COMMAND, SUBCOMMAND, CMD, NATIVE_CMD, OFFLINE_CMD,
    encodeNativeRequest, decodeResponse, fromFileElement, encodeOfflineRequest, decodeOfflineResponse,
    validateDownloadUrl: absoluteDownloadUrl };
