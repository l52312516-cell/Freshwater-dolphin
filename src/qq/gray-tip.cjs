'use strict';

const MAX_JSON_BYTES = 64 * 1024;
const MAX_ITEMS = 64;
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function plain(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function elementsOf(record) {
    if (!plain(record)) return null;
    return Array.isArray(record.elements) ? record.elements : null;
}
function isGrayTip(record) {
    return elementsOf(record)?.some(element => plain(element) &&
        (element.elementType === 8 || element.grayTipElement != null)) === true;
}
function hasOtherPayload(value, allowed) {
    return Object.entries(value).some(([key, data]) => key.endsWith('Element') &&
        key !== allowed && data !== null && data !== undefined);
}

// QQ 3.2.35 exposes a poke as a JSON gray tip (business 1061), rather than
// as a user-authored chat message. Only the two structured QQ references
// establish its participants; wording, nicknames and template text do not.
function parseGrayTip(record) {
    const elements = elementsOf(record);
    if (!isGrayTip(record)) return null;
    const candidates = elements.filter(element => plain(element?.grayTipElement?.jsonGrayTipElement) &&
        [1061, '1061'].includes(element.grayTipElement.jsonGrayTipElement.busiId));
    if (!candidates.length) return { kind: 'system', reason: 'unsupported_gray_tip' };
    const malformed = () => problem('INVALID_RESPONSE', 'QQ poke has an invalid structured gray-tip payload');
    if (![1, 2].includes(record.chatType) || record.msgType !== 5 || record.subMsgType !== 12 ||
        elements.length !== 1 || candidates.length !== 1) throw malformed();
    const element = candidates[0], gray = element.grayTipElement;
    if (element.elementType !== 8 || !plain(gray) || gray.subElementType !== 17 ||
        hasOtherPayload(element, 'grayTipElement') || hasOtherPayload(gray, 'jsonGrayTipElement')) throw malformed();
    const source = gray.jsonGrayTipElement.jsonStr;
    if (typeof source !== 'string' || !source || Buffer.byteLength(source, 'utf8') > MAX_JSON_BYTES) throw malformed();
    let body;
    try { body = JSON.parse(source); } catch { throw malformed(); }
    if (!plain(body) || !Array.isArray(body.items) || body.items.length < 2 || body.items.length > MAX_ITEMS ||
        body.items.some(item => !plain(item))) throw malformed();
    if (body.items.some(item => !['qq', 'nor', 'img'].includes(item.type))) {
        throw problem('UNSUPPORTED', 'QQ poke contains an unverified gray-tip item type');
    }
    const people = body.items.filter(item => item.type === 'qq');
    if (people.length !== 2 || people.some(item => typeof item.uid !== 'string' || item.uid.length > 128 ||
        !/^u_[A-Za-z0-9_-]+$/.test(item.uid)) ||
        body.items.some(item => item.type !== 'qq' && Object.hasOwn(item, 'uid'))) throw malformed();
    return { kind: 'poke', actorUid: people[0].uid, targetUid: people[1].uid };
}

module.exports = { isGrayTip, parseGrayTip };
