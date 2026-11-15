'use strict';

// Native QQ private (c2c) file download URL over the kernel's own MSF channel.
//
// Command OidbSvcTrpcTcp.0xe37_1200 (LLBot GetPrivateFileUrl). Proto verified
// against LLBot src/ntqqapi/proto/oidb.ts (GetPrivateFileReq/Resp) and the
// encoder in src/main/qqProtocol/mixins/friend.ts getPrivateFileUrl():
//   request inner = {1:1200, 2:1, 14:{10:receiverUid, 20:fileUuid, 30:2, 60:'', 601:0},
//                    101:3, 102:1, 200:1, 99999:bytes(c0852c01)}
//   response inner = {14:{10:retCode, 20:state, 30:{120:{102:{8:downloadUrl(bytes), 11:downloadDns}}},
//                     40:{7:fileName}}}
// receiverUid is the query initiator's OWN uid. URL is the same official
// ftn_handler form as group files: https://<dns>/ftn_handler/<tokenHex>/?fname=<name>.
//
// UNTESTED-LIVE until confirmed on a disposable instance with a real private file.

const { problem, varintField, bytesField, messageField, fields, one, unsigned, text } = require('./proto.cjs');

const COMMAND = 0xe37;
const SUBCOMMAND = 1200;
const CMD = `OidbSvc.0x${COMMAND.toString(16)}_${SUBCOMMAND}`;
const NATIVE_CMD = `OidbSvcTrpcTcp.0x${COMMAND.toString(16)}_${SUBCOMMAND}`;
const FIELD_99999 = Buffer.from([0xc0, 0x85, 0x2c, 0x01]);
const MAX_UID_BYTES = 128;
const MAX_FILE_UUID_BYTES = 512;
const MAX_DOWNLOAD_URL_BYTES = 4096;
const MAX_DNS_BYTES = 253;

function uid(value, label) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_UID_BYTES || /[\x00-\x1f\x7f]/.test(value)) {
        throw problem('INVALID_PARAMS', 'Private file URL requires a bounded ' + label);
    }
    return value;
}

function encodeNativeRequest(receiverUid, fileUuid) {
    const body = messageField(14, [
        bytesField(10, Buffer.from(uid(receiverUid, 'receiver UID'), 'utf8')),
        bytesField(20, Buffer.from(uid(fileUuid, 'file UUID'), 'utf8')),
        varintField(30, 2),
        bytesField(60, Buffer.alloc(0)),
        varintField(601, 0)
    ]);
    const inner = Buffer.concat([
        varintField(1, SUBCOMMAND), varintField(2, 1), body,
        varintField(101, 3), varintField(102, 1), varintField(200, 1),
        bytesField(99999, FIELD_99999)
    ]);
    return Buffer.concat([
        varintField(1, COMMAND), varintField(2, SUBCOMMAND),
        bytesField(4, inner), varintField(12, 1)
    ]);
}

function hostname(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_DNS_BYTES ||
        !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(value) || value.includes('..') ||
        !/\.qq\.com$/i.test(value)) return null;
    return value;
}
function message(entry) {
    if (!entry || entry.wire !== 2) return null;
    return fields(entry.value);
}

// OidbBase{1:command,2:subCommand,3:errorCode,4:body}; body = GetPrivateFileResp.
function decodeResponse(buffer) {
    const envelope = fields(buffer);
    const command = unsigned(one(envelope, 1), 0xffffffffn);
    const subCommand = unsigned(one(envelope, 2), 0xffffffffn);
    if (command !== BigInt(COMMAND) || subCommand !== BigInt(SUBCOMMAND)) {
        throw problem('QUERY_FAILED', 'QQ private-file command mismatch (kernel returned a stub)');
    }
    const errorCode = unsigned(one(envelope, 3), 0xffffffffn) ?? 0n;
    if (errorCode !== 0n) throw problem('QUERY_FAILED', 'QQ rejected the private-file URL query (errorCode ' + errorCode + ')');
    const resp = message(one(envelope, 4));
    if (!resp) throw problem('QUERY_FAILED', 'QQ returned no private-file body');
    const inner = message(one(resp, 14));
    if (!inner) throw problem('QUERY_FAILED', 'QQ returned no private-file payload');
    const retCode = unsigned(one(inner, 10), 0x7fffffffffffffffn) ?? 0n;
    const state = text(one(inner, 20), 1024) || '';
    if (retCode !== 0n) throw problem('QUERY_FAILED', 'QQ private-file download rejected (retCode ' + retCode + (state ? ': ' + state : '') + ')');
    const result = message(one(inner, 30));
    const extra = result && message(one(result, 120));
    const download = extra && message(one(extra, 102));
    if (!download) throw problem('INVALID_RESPONSE', 'QQ returned no private-file download payload');
    const dns = hostname(text(one(download, 11), MAX_DNS_BYTES));
    if (!dns) throw problem('INVALID_RESPONSE', 'QQ returned an invalid private-file download host');
    const urlBytes = one(download, 8);
    if (!urlBytes || urlBytes.wire !== 2 || urlBytes.value.length === 0 || urlBytes.value.length > MAX_DOWNLOAD_URL_BYTES) {
        throw problem('INVALID_RESPONSE', 'QQ returned an invalid private-file download token');
    }
    const tokenHex = urlBytes.value.toString('hex');
    const metadata = message(one(inner, 40));
    const fileName = metadata ? text(one(metadata, 7), 1024) : null;
    const url = `https://${dns}/ftn_handler/${tokenHex}/?fname=`;
    let parsed;
    try { parsed = new URL(url); } catch { throw problem('INVALID_RESPONSE', 'QQ private-file download URL is malformed'); }
    if (parsed.protocol !== 'https:' || parsed.hostname !== dns || !parsed.pathname.startsWith('/ftn_handler/')) {
        throw problem('INVALID_RESPONSE', 'QQ private-file download URL identity is inconsistent');
    }
    return { url, downloadDns: dns, downloadUrlHex: tokenHex, retCode: Number(retCode), state, fileName: fileName || undefined };
}

function withFileName(result, fileName) {
    const name = typeof fileName === 'string' && fileName ? fileName : result.fileName;
    if (typeof name !== 'string' || !name) return result.url;
    return result.url + encodeURIComponent(name);
}

module.exports = { COMMAND, SUBCOMMAND, CMD, NATIVE_CMD, encodeNativeRequest, decodeResponse, withFileName };
