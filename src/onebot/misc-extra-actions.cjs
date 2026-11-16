'use strict';
const protocol = require('../qq/misc-extra-protocol.cjs');
const EXTENSION_REQUIREMENTS = Object.freeze({ get_mini_app_ark: 'miniappArk', send_tuwen_ark: 'tuwenArk', set_group_sign: 'groupSign',
    set_diy_online_status: 'selfDiyStatus', click_inline_keyboard_button: Object.freeze(['inlineButton', 'reply']) });
const ACTIONS = new Set(Object.keys(EXTENSION_REQUIREMENTS));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
async function runMiscExtra(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown misc extension action');
    const allowed = { get_mini_app_ark: ['type', 'title', 'desc', 'picUrl', 'pic_url', 'jumpUrl', 'jump_url'],
        send_tuwen_ark: ['group_id', 'user_id', 'title', 'desc', 'summary', 'preview_url', 'jump_url'], set_group_sign: ['group_id'],
        set_diy_online_status: ['face_id', 'face_type', 'wording'], click_inline_keyboard_button: ['group_id', 'bot_appid', 'msg_seq', 'button_id', 'callback_data'] }[action];
    if (!protocol.object(params) || Object.keys(params).some(key => !['self_id', ...allowed].includes(key))) fail('INVALID_PARAMS', 'Unexpected misc action parameters');
    if ([].concat(EXTENSION_REQUIREMENTS[action]).some(flag => state.capabilities?.[flag] !== true)) fail('UNSUPPORTED', 'This QQ session lacks the misc capability');
    const fallback = (value, defaultValue) => value === undefined ? defaultValue : value;
    let request;
    if (action === 'get_mini_app_ark') {
        if (params.picUrl !== undefined && params.pic_url !== undefined && params.picUrl !== params.pic_url || params.jumpUrl !== undefined && params.jump_url !== undefined && params.jumpUrl !== params.jump_url) fail('INVALID_PARAMS', 'Conflicting miniapp URL aliases');
        request = { operation: 'miniapp.ark', type: fallback(params.type, 'bili'), title: fallback(params.title, ''), desc: fallback(params.desc, ''),
            picUrl: fallback(params.picUrl === undefined ? params.pic_url : params.picUrl, ''), jumpUrl: fallback(params.jumpUrl === undefined ? params.jump_url : params.jumpUrl, '') };
    } else if (action === 'send_tuwen_ark') {
        const groupId = params.group_id === undefined ? undefined : protocol.integer(params.group_id, true), userId = params.user_id === undefined ? undefined : protocol.integer(params.user_id, true);
        if (groupId === undefined && userId === undefined) fail('INVALID_PARAMS', 'A card destination is required');
        request = { operation: 'card.send', targetId: groupId ?? userId, peerType: groupId === undefined ? 0 : 1, title: params.title, desc: params.desc,
            summary: fallback(params.summary, '[分享]'), previewUrl: fallback(params.preview_url, 'https://tangram-1251316161.file.myqcloud.com/files/20210721/e50a8e37e08f29bf1ffc7466e1950690.png'), jumpUrl: params.jump_url };
    } else if (action === 'set_group_sign') request = { operation: 'group.sign', groupId: protocol.integer(params.group_id, true), selfUin: String(state.self.uin) };
    else if (action === 'set_diy_online_status') request = { operation: 'self.diy', faceId: protocol.integer(params.face_id), faceType: protocol.integer(fallback(params.face_type, 1)), wording: fallback(params.wording, '') };
    else {
        request = { operation: 'button.click', groupId: protocol.integer(params.group_id, true), botAppid: protocol.integer(params.bot_appid, true), msgSeq: protocol.integer(params.msg_seq, true, 0xffffffffffffffffn),
            buttonId: params.button_id, callbackData: fallback(params.callback_data, '') };
        protocol.text(request.buttonId, 1024, false); protocol.text(request.callbackData);
        const entries = [...service.store.state(state.self.uin).byId.values()].filter(entry => entry.locator?.peer.chatType === 2 && entry.locator.peer.peerUid === request.groupId && entry.locator.seq === request.msgSeq);
        if (entries.length !== 1) fail('NOT_FOUND', 'The inline button must belong to one observed message in this account and group');
        const record = await service.record(state, entries[0].id, { chatType: 2, peerUid: request.groupId }, { refresh: true });
        const buttons = (record.elements || []).flatMap(element => {
            const keyboard = element?.inlineKeyboardElement;
            return keyboard?.botAppid === request.botAppid && Array.isArray(keyboard.rows) && keyboard.rows.length <= 100 ? keyboard.rows.flatMap(row => Array.isArray(row.buttons) && row.buttons.length <= 100 ? row.buttons : []) : [];
        }).filter(button => button?.id === request.buttonId && button.data === request.callbackData && button.type === 2);
        if (String(record.msgSeq) !== request.msgSeq || buttons.length !== 1) fail('INVALID_PARAMS', 'The button identity or callback does not match the refreshed group message');
    }
    const { operation, ...input } = request, prepared = protocol.prepare(operation, input);
    const result = await service.sessionCall(state, 'miscExtra', { operation, ...prepared.data });
    if (!protocol.object(result) || result.operation !== operation || Object.keys(prepared.data).some(key => result[key] !== prepared.data[key])) fail('INVALID_RESPONSE', 'QQ returned another misc target or value');
    if (operation === 'miniapp.ark') {
        const ark = result.result?.data;
        require('../qq/share-oidb.cjs').validateArk(JSON.stringify(ark));
        if (ark.miniappShareOrigin !== 3 || ark.miniappOpenRefer !== '10002') fail('INVALID_RESPONSE', 'QQ miniapp share metadata is incomplete');
        return { data: ark };
    }
    if (operation === 'button.click') {
        const value = result.result;
        if (!protocol.object(value) || value.result !== 0 || value.status !== 0 || value.promptType !== 0 || value.promptIcon !== 0) fail('INVALID_RESPONSE', 'QQ did not confirm the inline button result');
        protocol.text(value.errMsg, 4096, true, 'INVALID_RESPONSE'); protocol.text(value.promptText, 4096, true, 'INVALID_RESPONSE'); return value;
    }
    if (result.confirmed !== true || result.confirmation !== 'server_ack') fail('INVALID_RESPONSE', 'QQ supplied no misc operation acknowledgement');
    return operation === 'group.sign' ? {} : null;
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, runMiscExtra };
