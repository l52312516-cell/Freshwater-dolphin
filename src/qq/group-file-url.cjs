'use strict';

// Native QQ group-file download URL over the kernel's own MSF channel.
//
// Command OidbSvcTrpcTcp.0x6d6_2 (LLBot GetFileUrl). Proto verified against
// LLBot src/ntqqapi/proto/oidb.ts (GetGroupFileReq/GetGroupFileResp) and the
// encoder in src/main/qqProtocol/mixins/group.ts getGroupFileUrl():
//   request  inner = {3:download{1:groupCode(uint32), 2:appId=7, 3:busId=102, 4:fileId(string)}}
//   response inner = {3:download{1:retCode(int64), 3:clientWording, 5:downloadDns, 6:downloadUrl(bytes)}}
// wrapped in the OidbBase envelope {1:command, 2:subCommand, 3:errorCode, 4:body, 12:isReserved}.
// The download URL is https://<downloadDns>/ftn_handler/<downloadUrl hex>/?fname=<encoded name>.
//
// UNTESTED-LIVE until confirmed on a disposable instance; the host allowlist for
// the actual download is enforced by the consumer from observed real responses.

const { problem, varintField, bytesField, messageField, fields, one, unsigned, text } = require('./proto.cjs');

const COMMAND = 0x6d6;
const SUBCOMMAND = 2;
const CMD = `OidbSvc.0x${COMMAND.toString(16)}_${SUBCOMMAND}`;
const NATIVE_CMD = `OidbSvcTrpcTcp.0x${COMMAND.toString(16)}_${SUBCOMMAND}`;
// Constants carried verbatim from the LLBot group-file encoder.
const APP_ID = 7;
const DEFAULT_BUS_ID = 102;
const MAX_FILE_ID_BYTES = 512;
const MAX_DOWNLOAD_URL_BYTES = 4096;
const MAX_DNS_BYTES = 253;

function groupCode(value) {
    const text = String(value ?? '');
    if (!/^[1-9]\d{0,9}$/.test(text)) throw problem('INVALID_PARAMS', 'Group file URL requires a numeric group ID');
    const num = Number(text);
    if (!Number.isSafeInteger(num) || num > 0xffffffff) throw problem('INVALID_PARAMS', 'Group ID is out of range');
    return num;
}
function fileId(value) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_FILE_ID_BYTES || /[\x00-\x1f\x7f]/.test(value)) {
        throw problem('INVALID_PARAMS', 'Group file URL requires a bounded file ID');
    }
    return value;
}
function busId(value) {
    if (value === undefined || value === null) return DEFAULT_BUS_ID;
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw problem('INVALID_PARAMS', 'Invalid group file bus ID');
    return value;
}

// Full OidbBase envelope for the native MSF channel (TrpcTcp).
function encodeNativeRequest(group, file, bus) {
    const download = messageField(3, [
        varintField(1, groupCode(group)),
        varintField(2, APP_ID),
        varintField(3, busId(bus)),
        bytesField(4, Buffer.from(fileId(file), 'utf8'))
    ]);
    return Buffer.concat([
        varintField(1, COMMAND), varintField(2, SUBCOMMAND),
        bytesField(4, download), varintField(12, 1)
    ]);
}

function hostname(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_DNS_BYTES ||
        !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(value) || value.includes('..') ||
        !/\.qq\.com$/i.test(value)) return null;
    return value;
}

// OidbBase{1:command,2:subCommand,3:errorCode,4:body};
// body = GetGroupFileResp{3:download{1:retCode,3:clientWording,5:downloadDns,6:downloadUrl}}.
function decodeResponse(buffer) {
    const envelope = fields(buffer);
    const command = unsigned(one(envelope, 1), 0xffffffffn);
    const subCommand = unsigned(one(envelope, 2), 0xffffffffn);
    if (command !== BigInt(COMMAND) || subCommand !== BigInt(SUBCOMMAND)) {
        throw problem('QUERY_FAILED', 'QQ group-file command mismatch (kernel returned a stub)');
    }
    const errorCode = unsigned(one(envelope, 3), 0xffffffffn) ?? 0n;
    if (errorCode !== 0n) throw problem('QUERY_FAILED', 'QQ rejected the group-file URL query (errorCode ' + errorCode + ')');
    const body = one(envelope, 4);
    if (!body || body.wire !== 2 || body.value.length === 0) throw problem('QUERY_FAILED', 'QQ returned no group-file body');
    const download = one(fields(body.value), 3);
    if (!download || download.wire !== 2) throw problem('QUERY_FAILED', 'QQ returned no group-file download payload');
    const info = fields(download.value);
    const retCode = unsigned(one(info, 1), 0x7fffffffffffffffn) ?? 0n;
    const wording = text(one(info, 3), 1024) || '';
    if (retCode !== 0n) throw problem('QUERY_FAILED', 'QQ group-file download rejected (retCode ' + retCode + (wording ? ': ' + wording : '') + ')');
    const dns = hostname(text(one(info, 5), MAX_DNS_BYTES));
    if (!dns) throw problem('INVALID_RESPONSE', 'QQ returned an invalid group-file download host');
    const urlBytes = one(info, 6);
    if (!urlBytes || urlBytes.wire !== 2 || urlBytes.value.length === 0 || urlBytes.value.length > MAX_DOWNLOAD_URL_BYTES) {
        throw problem('INVALID_RESPONSE', 'QQ returned an invalid group-file download token');
    }
    const tokenHex = urlBytes.value.toString('hex');
    const url = `https://${dns}/ftn_handler/${tokenHex}/?fname=`;
    let parsed;
    try { parsed = new URL(url); } catch { throw problem('INVALID_RESPONSE', 'QQ group-file download URL is malformed'); }
    if (parsed.protocol !== 'https:' || parsed.hostname !== dns || !parsed.pathname.startsWith('/ftn_handler/')) {
        throw problem('INVALID_RESPONSE', 'QQ group-file download URL identity is inconsistent');
    }
    return { url, downloadDns: dns, downloadUrlHex: tokenHex, retCode: Number(retCode), clientWording: wording };
}

// Append the real file name to the base URL (LLBot appends encodeURIComponent(fileName)).
function withFileName(result, fileName) {
    if (typeof fileName !== 'string' || !fileName) return result.url;
    return result.url + encodeURIComponent(fileName);
}

module.exports = { COMMAND, SUBCOMMAND, CMD, NATIVE_CMD, APP_ID, DEFAULT_BUS_ID, encodeNativeRequest, decodeResponse, withFileName };
