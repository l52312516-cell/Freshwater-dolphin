'use strict';

// Native QQ video download URL over the kernel's own MSF channel.
//
// NTV2RichMedia download commands (same family as the verified rkey query):
//   group   OidbSvcTrpcTcp.0x11ea_200
//   private OidbSvcTrpcTcp.0x11e9_200
// Proto verified against LLBot src/ntqqapi/proto/media.ts (NTV2RichMediaReq/Resp)
// and the encoders in src/main/qqProtocol/mixins/media.ts getGroupVideoUrl /
// getPrivateVideoUrl. The JS getVideoPlayUrlV2 path fails on this build
// (result=170013002); the native channel returns a working official URL.
//   request  reqHead{1:common{1:1,2:200}, 2:scene{101:2,102:2,103:0,200:sceneType,
//            201:c2c{1:2,2:targetUid} | 202:group{1:0}}, 3:client{1:2}}
//            download{3:{1:node{2:fileUuid,3:1,4:0,5:0,6:0}}}
//   response download{3:{1:rKeyParam, 3:info{1:domain,2:urlPath}}}
// URL = https://<domain><urlPath><rKeyParam>.
//
// Live-verified on a disposable instance (HTTP 200, exact size + MD5).

const { problem, varintField, bytesField, messageField, fields, one, unsigned, text } = require('./proto.cjs');

const GROUP_COMMAND = 0x11ea;
const PRIVATE_COMMAND = 0x11e9;
const SUBCOMMAND = 200;
const groupCmd = isGroup => `OidbSvcTrpcTcp.0x${(isGroup ? GROUP_COMMAND : PRIVATE_COMMAND).toString(16)}_${SUBCOMMAND}`;
const MAX_UUID_BYTES = 512;
const MAX_URL_BYTES = 8192;

function fileUuid(value) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_UUID_BYTES || /[\x00-\x1f\x7f]/.test(value)) {
        throw problem('INVALID_PARAMS', 'Video URL requires a bounded file UUID');
    }
    return value;
}

function encodeNativeRequest(uuid, isGroup, targetUid) {
    const command = isGroup ? GROUP_COMMAND : PRIVATE_COMMAND;
    const sceneParts = [varintField(101, 2), varintField(102, 2), varintField(103, 0)];
    if (isGroup) {
        sceneParts.push(varintField(200, 2), messageField(202, [varintField(1, 0)]));
    } else {
        if (typeof targetUid !== 'string' || !targetUid) throw problem('INVALID_PARAMS', 'Private video URL requires the self UID');
        sceneParts.push(varintField(200, 1), messageField(201, [varintField(1, 2), bytesField(2, Buffer.from(targetUid, 'utf8'))]));
    }
    const head = messageField(1, [
        messageField(1, [varintField(1, 1), varintField(2, SUBCOMMAND)]),
        messageField(2, sceneParts),
        messageField(3, [varintField(1, 2)])
    ]);
    const node = messageField(1, [
        bytesField(2, Buffer.from(fileUuid(uuid), 'utf8')),
        varintField(3, 1), varintField(4, 0), varintField(5, 0), varintField(6, 0)
    ]);
    const req = Buffer.concat([head, messageField(3, [node])]);
    return Buffer.concat([
        varintField(1, command), varintField(2, SUBCOMMAND),
        bytesField(4, req), varintField(12, 1)
    ]);
}

// OidbBase{1:command,2:subCommand,3:errorCode,4:body}; body = NTV2RichMediaResp.
function decodeResponse(buffer, isGroup) {
    const envelope = fields(buffer);
    const command = unsigned(one(envelope, 1), 0xffffffffn);
    const subCommand = unsigned(one(envelope, 2), 0xffffffffn);
    const expected = isGroup ? GROUP_COMMAND : PRIVATE_COMMAND;
    if (command !== BigInt(expected) || subCommand !== BigInt(SUBCOMMAND)) {
        throw problem('QUERY_FAILED', 'QQ video command mismatch (kernel returned a stub)');
    }
    const errorCode = unsigned(one(envelope, 3), 0xffffffffn) ?? 0n;
    if (errorCode !== 0n) throw problem('QUERY_FAILED', 'QQ rejected the video URL query (errorCode ' + errorCode + ')');
    const body = one(envelope, 4);
    if (!body || body.wire !== 2 || body.value.length === 0) throw problem('QUERY_FAILED', 'QQ returned no video body');
    const download = one(fields(body.value), 3);
    if (!download || download.wire !== 2) throw problem('QUERY_FAILED', 'QQ returned no video download payload');
    const info = fields(download.value);
    const rKeyParam = text(one(info, 1), MAX_URL_BYTES) || '';
    const infoEntry = one(info, 3);
    if (!infoEntry || infoEntry.wire !== 2) throw problem('INVALID_RESPONSE', 'QQ returned no video download source');
    const source = fields(infoEntry.value);
    const domain = text(one(source, 1), 253);
    const urlPath = text(one(source, 2), MAX_URL_BYTES);
    if (!domain || !/^[a-z0-9.-]+\.qq\.com(\.cn)?$/i.test(domain) || !urlPath || !urlPath.startsWith('/')) {
        throw problem('INVALID_RESPONSE', 'QQ returned an invalid video download source');
    }
    const url = `https://${domain}${urlPath}${rKeyParam}`;
    let parsed;
    try { parsed = new URL(url); } catch { throw problem('INVALID_RESPONSE', 'QQ video download URL is malformed'); }
    if (parsed.protocol !== 'https:' || parsed.hostname !== domain) {
        throw problem('INVALID_RESPONSE', 'QQ video download URL identity is inconsistent');
    }
    return { url, domain, rKeyTtlSecond: Number(unsigned(one(info, 2), 0xffffffffn) ?? 0n) };
}

module.exports = { GROUP_COMMAND, PRIVATE_COMMAND, SUBCOMMAND, groupCmd, encodeNativeRequest, decodeResponse };
