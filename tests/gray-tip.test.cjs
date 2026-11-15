'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isGrayTip, parseGrayTip } = require('../src/qq/gray-tip.cjs');

function poke(extra = {}) {
    return { chatType: 2, msgType: 5, subMsgType: 12, peerUid: '12345', senderUin: '0', senderUid: '',
        msgId: '18446744073709551610', msgSeq: '0', msgTime: '1800000000',
        elements: [{ elementType: 8, textElement: null, picElement: null, grayTipElement: {
            subElementType: 17, revokeElement: null, xmlElement: null,
            jsonGrayTipElement: { busiId: '1061', jsonStr: JSON.stringify({ align: 'center', items: [
                { type: 'qq', uid: 'u_actor', nm: 'Synthetic sender', col: '3' },
                { type: 'img', src: 'https://example.invalid/decoration.png', jp: '0' },
                { type: 'nor', txt: '戳了戳' },
                { type: 'qq', uid: 'u_target', nm: 'Synthetic target', tp: '0', col: '3' },
                { type: 'nor', txt: '合成后缀' }
            ] }), isServer: true, recentAbstract: 'Synthetic poke',
            xmlToJsonParam: { templId: '1132', seqId: '123456789', members: {}, templParam: {} } }
        } }], ...extra };
}
function items(record, change) {
    const data = record.elements[0].grayTipElement.jsonGrayTipElement;
    const body = JSON.parse(data.jsonStr);
    change(body.items, body);
    data.jsonStr = JSON.stringify(body);
    return record;
}

test('group poke uses ordered structured UID references without storing decoration or allocating a chat ID', () => {
    const record = poke(), before = JSON.stringify(record);
    assert.equal(isGrayTip(record), true);
    assert.deepEqual(parseGrayTip(record), { kind: 'poke', actorUid: 'u_actor', targetUid: 'u_target' });
    assert.equal(JSON.stringify(record), before);
});

test('private and self poke preserve the exact participants for later account checks', () => {
    assert.deepEqual(parseGrayTip(poke({ chatType: 1, peerUid: 'u_target' })),
        { kind: 'poke', actorUid: 'u_actor', targetUid: 'u_target' });
    const self = items(poke(), values => { values[3].uid = 'u_actor'; });
    assert.deepEqual(parseGrayTip(self), { kind: 'poke', actorUid: 'u_actor', targetUid: 'u_actor' });
});

test('wording, display names, QQ-looking text and template parameters cannot replace participant UIDs', () => {
    const record = items(poke(), values => {
        values[0].nm = '77777'; values[2].txt = '11111 拍了拍 22222'; values[3].nm = '88888';
    });
    record.elements[0].grayTipElement.jsonGrayTipElement.xmlToJsonParam.templParam = {
        uin_str1: '99999', uin_str2: '66666'
    };
    assert.deepEqual(parseGrayTip(record), { kind: 'poke', actorUid: 'u_actor', targetUid: 'u_target' });
    assert.throws(() => parseGrayTip(items(record, values => { delete values[0].uid; })), { code: 'INVALID_RESPONSE' });
});

test('ordinary text and null native payload fields do not become system notifications', () => {
    for (const record of [undefined, null, {}, { elements: [] }, { elements: [{ elementType: 1,
        grayTipElement: null, textElement: { content: '戳了戳' } }] }]) {
        assert.equal(isGrayTip(record), false);
        assert.equal(parseGrayTip(record), null);
    }
});

test('unknown, revoke and other system gray tips remain system records without guessing a poke', () => {
    const other = poke(); other.elements[0].grayTipElement.jsonGrayTipElement.busiId = '19324';
    const revoke = poke(); revoke.elements[0].grayTipElement = {
        subElementType: 1, revokeElement: { operatorUid: 'u_operator' }
    };
    for (const record of [other, revoke, { elements: [{ elementType: 8, grayTipElement: {} }] }]) {
        assert.equal(isGrayTip(record), true);
        assert.deepEqual(parseGrayTip(record), { kind: 'system', reason: 'unsupported_gray_tip' });
    }
});

test('poke rejects missing, malformed or ambiguous identities', () => {
    const changes = [
        values => { values.splice(3, 1); },
        values => { values.push({ type: 'qq', uid: 'u_third' }); },
        values => { values[0].uid = ''; },
        values => { values[0].uid = '12345'; },
        values => { values[0].uid = 12345; },
        values => { values[0].uid = 'u_bad uid'; },
        values => { values[0].uid = 'u_' + 'a'.repeat(129); },
        values => { values[2].uid = 'u_hidden'; },
        values => { values[3].uid = null; },
        values => { values[0] = null; }
    ];
    for (const change of changes) assert.throws(() => parseGrayTip(items(poke(), change)), { code: 'INVALID_RESPONSE' });
});

test('known poke payloads cannot disguise mixed messages or conflicting native elements', () => {
    const changes = [
        record => { record.chatType = 3; },
        record => { record.msgType = 2; },
        record => { record.subMsgType = 8; },
        record => { record.elements[0].elementType = 1; },
        record => { record.elements[0].textElement = { content: 'keep the complete message' }; },
        record => { record.elements[0].grayTipElement.revokeElement = {}; },
        record => { record.elements[0].grayTipElement.subElementType = '17'; },
        record => { record.elements.push({ elementType: 1, textElement: { content: 'not a poke' } }); },
        record => { record.elements.push(structuredClone(record.elements[0])); }
    ];
    for (const change of changes) { const record = poke(); change(record);
        assert.throws(() => parseGrayTip(record), { code: 'INVALID_RESPONSE' }); }
});

test('malformed or excessive JSON is rejected with fixed diagnostics that do not include message content', () => {
    for (const source of ['', null, '{"items":', 'null', '[]', '{}', '{"items":{}}',
        JSON.stringify({ items: [] }), JSON.stringify({ items: Array(65).fill({ type: 'nor', txt: 'x' }) }),
        JSON.stringify({ items: [{ type: 'qq', uid: 'u_actor' }, { type: 'qq', uid: 'u_target' }], extra: '私'.repeat(24000) })]) {
        const record = poke(); record.elements[0].grayTipElement.jsonGrayTipElement.jsonStr = source;
        assert.throws(() => parseGrayTip(record), error => error.code === 'INVALID_RESPONSE' &&
            !error.message.includes('私') && !error.message.includes('items'));
    }
});

test('unknown item types are explicit unsupported events rather than partial participant conversions', () => {
    assert.throws(() => parseGrayTip(items(poke(), values => { values[2].type = 'unverified'; })), { code: 'UNSUPPORTED' });
});

test('numeric and string native business IDs produce identical structured results', () => {
    const record = poke(); record.elements[0].grayTipElement.jsonGrayTipElement.busiId = 1061;
    assert.deepEqual(parseGrayTip(record), { kind: 'poke', actorUid: 'u_actor', targetUid: 'u_target' });
});
