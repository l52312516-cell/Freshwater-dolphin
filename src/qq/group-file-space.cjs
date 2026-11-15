'use strict';

// Native QQ group-file space capacity over the kernel's own MSF channel.
//
// Command OidbSvcTrpcTcp.0x6d8_3 (LLBot GetFileSpace). Proto verified against
// LLBot src/ntqqapi/proto/oidb.ts (GetGroupFileSpaceReq/Resp) and the encoder in
// src/main/qqProtocol/mixins/group.ts getGroupFileSpace():
//   request  inner = {4:spaceReq{1:groupCode(uint32), 2:appId=7}}
//   response inner = {4:spaceResp{4:totalSpace(uint64), 5:usedSpace(uint64)}}
// wrapped in the OidbBase envelope {1:command, 2:subCommand, 3:errorCode, 4:body, 12:isReserved}.
//
// UNTESTED-LIVE until confirmed on a disposable instance.

const { problem, varintField, bytesField, messageField, fields, one, unsigned } = require('./proto.cjs');

const COMMAND = 0x6d8;
const SUBCOMMAND = 3;
const CMD = `OidbSvc.0x${COMMAND.toString(16)}_${SUBCOMMAND}`;
const NATIVE_CMD = `OidbSvcTrpcTcp.0x${COMMAND.toString(16)}_${SUBCOMMAND}`;
const APP_ID = 7;
const U64_MAX = 0xffffffffffffffffn;

function groupCode(value) {
    const text = String(value ?? '');
    if (!/^[1-9]\d{0,9}$/.test(text)) throw problem('INVALID_PARAMS', 'Group file space requires a numeric group ID');
    const num = Number(text);
    if (!Number.isSafeInteger(num) || num > 0xffffffff) throw problem('INVALID_PARAMS', 'Group ID is out of range');
    return num;
}
function u64(value) {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function encodeNativeRequest(group) {
    const spaceReq = messageField(4, [varintField(1, groupCode(group)), varintField(2, APP_ID)]);
    return Buffer.concat([
        varintField(1, COMMAND), varintField(2, SUBCOMMAND),
        bytesField(4, spaceReq), varintField(12, 1)
    ]);
}

// OidbBase{1:command,2:subCommand,3:errorCode,4:body};
// body = GetGroupFileSpaceResp{4:spaceResp{4:totalSpace,5:usedSpace}}.
function decodeResponse(buffer) {
    const envelope = fields(buffer);
    const command = unsigned(one(envelope, 1), 0xffffffffn);
    const subCommand = unsigned(one(envelope, 2), 0xffffffffn);
    if (command !== BigInt(COMMAND) || subCommand !== BigInt(SUBCOMMAND)) {
        throw problem('QUERY_FAILED', 'QQ group-file space command mismatch (kernel returned a stub)');
    }
    const errorCode = unsigned(one(envelope, 3), 0xffffffffn) ?? 0n;
    if (errorCode !== 0n) throw problem('QUERY_FAILED', 'QQ rejected the group-file space query (errorCode ' + errorCode + ')');
    const body = one(envelope, 4);
    if (!body || body.wire !== 2 || body.value.length === 0) throw problem('QUERY_FAILED', 'QQ returned no group-file space body');
    const spaceResp = one(fields(body.value), 4);
    if (!spaceResp || spaceResp.wire !== 2) throw problem('QUERY_FAILED', 'QQ returned no group-file space payload');
    const info = fields(spaceResp.value);
    const totalSpace = unsigned(one(info, 4), U64_MAX);
    const usedSpace = unsigned(one(info, 5), U64_MAX);
    if (totalSpace === null || usedSpace === null) throw problem('INVALID_RESPONSE', 'QQ returned invalid group-file space values');
    if (usedSpace > totalSpace) throw problem('INVALID_RESPONSE', 'QQ group-file used space exceeds total space');
    return { totalSpace: u64(totalSpace), usedSpace: u64(usedSpace) };
}

module.exports = { COMMAND, SUBCOMMAND, CMD, NATIVE_CMD, APP_ID, encodeNativeRequest, decodeResponse };
