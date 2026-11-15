'use strict';

// Synthetic QQ provider for protocol interoperability tests. Never loads QQ.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { startServer } = require('../../src/ipc/server.cjs');
const { run } = require('../../src/runtime.cjs');

async function main() {
    const directory = path.resolve(process.argv[2]);
    const url = process.argv[3];
    const backend = new EventEmitter();
    const records = [];
    let nextId = 9000000000000000000n;
    const state = { epoch: 'synthetic-session', ready: true, readyAt: Date.now(), online: true,
        self: { uin: '12345', uid: 'u_self', nickname: 'Synthetic QQ' }, qqVersion: '3.2.35-54395', capabilities: { messages: true } };
    function record(peer, elements, sender = '22222') {
        return { chatType: peer.chatType, peerUid: peer.peerUid, peerUin: peer.chatType === 2 ? peer.peerUid : '22222',
            senderUin: sender, senderUid: sender === '12345' ? 'u_self' : 'u_sender', msgId: String(nextId++),
            msgSeq: String(nextId % 100000n), clientSeq: '100', msgTime: Math.floor(Date.now() / 1000),
            sendNickName: 'Synthetic sender', sendMemberName: 'Synthetic card', senderRole: 2, elements };
    }
    backend.call = async (method, params) => {
        if (method === 'status') return state;
        if (params.expectedEpoch && params.expectedEpoch !== state.epoch) throw Object.assign(new Error('old session'), { code: 'SESSION_CHANGED' });
        if (method === 'resolve') return { uin: params.uin || (params.uid === 'u_self' ? '12345' : '22222'),
            uid: params.uid || (params.uin === '12345' ? 'u_self' : 'u_sender') };
        if (method === 'user') return { user_id: Number(params.uin), nickname: 'Synthetic sender', sex: 'unknown' };
        if (method === 'friends') return [{ user_id: 22222, nickname: 'Synthetic sender', remark: '' }];
        if (method === 'groups') return [{ group_id: 33333, group_name: 'Synthetic group' }];
        if (method === 'groupInfo') return { group_id: Number(params.groupId), group_name: 'Synthetic group', member_count: 2, max_member_count: 200 };
        if (method === 'groupMember') return { group_id: Number(params.groupId), user_id: Number(params.uin), nickname: 'Synthetic sender', card: 'Synthetic card', role: 'member' };
        if (method === 'sendMessage') {
            const value = record(params.peer, params.elements, '12345');
            records.push(value);
            fs.writeFileSync(path.join(directory, 'sent.json'), JSON.stringify(records));
            return value;
        }
        if (method === 'getMessage') return records.find(item => item.msgId === params.nativeId);
        throw new Error('Unsupported synthetic operation');
    };
    const server = await startServer({ dir: path.join(directory, 'rpc'), backend });
    const application = await run({ root: directory, rpcDirectory: path.join(directory, 'rpc'), dataDirectory: path.join(directory, 'data'),
        healthFile: path.join(directory, 'health.json'), actionTimeoutMs: 2000, eventBufferSize: 1000, eventMaxAgeMs: 60000,
        reverseWs: { url, token: 'synthetic-token', heartbeatMs: 5000, pingTimeoutMs: 1000, reconnectMinMs: 20, reconnectMaxMs: 100 } }, () => {});
    const text = content => ({ elementType: 1, textElement: { content, atType: 0 } });
    setTimeout(() => {
        const privateMessage = record({ chatType: 1, peerUid: 'u_sender' }, [text('Synthetic 私聊\n')]);
        const groupMessage = record({ chatType: 2, peerUid: '33333' }, [text('Synthetic 群聊')]);
        const quoteMessage = record({ chatType: 2, peerUid: '33333' }, [
            { elementType: 7, replyElement: { replayMsgId: groupMessage.msgId, replayMsgSeq: groupMessage.msgSeq, senderUin: '22222', replyMsgClientSeq: groupMessage.clientSeq } },
            { elementType: 1, textElement: { content: '@Synthetic QQ', atType: 2, atUid: '12345', atNtUid: 'u_self' } }, text(' test')]);
        records.push(privateMessage, groupMessage, quoteMessage);
        for (const value of [privateMessage, groupMessage, quoteMessage]) backend.emit('event', { epoch: state.epoch, selfUin: state.self.uin, kind: 'message', record: value });
    }, 1000).unref();
    async function close() { await application.close(); await server.close(); }
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    process.stdin.resume();
    process.stdin.on('data', () => { void close().then(() => process.stdin.pause()); });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
