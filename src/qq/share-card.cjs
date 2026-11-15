'use strict';

const { randomUUID } = require('node:crypto');
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function text(value, label, maximum, optional = false) {
    if (optional && value === undefined) return '';
    if (typeof value !== 'string' || Buffer.byteLength(value) > maximum ||
        (label === 'title' ? /[\x00-\x1f\x7f]/ : /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/).test(value) || !optional && !value.trim()) {
        throw problem('INVALID_PARAMS', 'Invalid share ' + label);
    }
    return value;
}
function link(value, label, optional = false) {
    const input = text(value, label, 2048, optional);
    if (!input && optional) return '';
    let url;
    try { url = new URL(input); } catch { throw problem('INVALID_PARAMS', 'Invalid share ' + label); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\x00-\x20\x7f]/.test(input)) {
        throw problem('INVALID_PARAMS', 'Invalid share ' + label);
    }
    return input;
}
function normalizeShareData(data) {
    if (!plain(data) || Object.keys(data).some(key => !['url', 'title', 'content', 'image'].includes(key))) {
        throw problem('INVALID_PARAMS', 'Invalid share segment fields');
    }
    return { url: link(data.url, 'url'), title: text(data.title, 'title', 1024),
        content: text(data.content, 'content', 4096, true), image: link(data.image, 'image', true) };
}
function buildShareCard(data) {
    const item = normalizeShareData(data);
    // The news template uses its public content fields only. A fabricated Ark
    // package version or configuration does not establish client compatibility.
    return JSON.stringify({ app: 'com.tencent.structmsg', view: 'news', prompt: item.title,
        meta: { news: { title: item.title, desc: item.content, jumpUrl: item.url, preview: item.image } } });
}
// This prepares only the fixed news template. It never accepts arbitrary Ark
// bytes, music metadata, native elements or commands from a protocol caller.
function createShareCards(capture) {
    const prepared = new Map(); let session;
    function current() {
        const value = JSON.stringify([capture.epoch, capture.self?.uin, capture.self?.uid]);
        if (value !== session) { prepared.clear(); session = value; }
        const now = Date.now();
        for (const [key, item] of prepared) if (now - item.at > 60000) prepared.delete(key);
        return now;
    }
    function prepare(params) {
        capture.ensureReady();
        const at = current();
        if (!plain(params) || Object.keys(params).some(key => !['expectedEpoch', 'peer', 'data'].includes(key)) || params.expectedEpoch !== capture.epoch) {
            throw problem('SESSION_CHANGED', 'Share preparation is not bound to this account session');
        }
        const peer = params.peer;
        if (!plain(peer) || typeof peer.peerUid !== 'string' || Object.keys(peer).some(key => !['chatType', 'peerUid'].includes(key)) || ![1, 2].includes(peer.chatType) ||
            (peer.chatType === 1 ? !/^u_[A-Za-z0-9_-]{1,126}$/.test(peer.peerUid || '') : !/^[1-9]\d{0,15}$/.test(peer.peerUid || '') || !Number.isSafeInteger(Number(peer.peerUid)))) {
            throw problem('INVALID_PARAMS', 'Invalid share conversation');
        }
        const card = buildShareCard(params.data);
        if (prepared.size >= 100) throw problem('BUSY', 'Too many prepared share cards');
        const shareToken = randomUUID();
        prepared.set(shareToken, { peer: { ...peer }, at, card, epoch: capture.epoch });
        return { elementType: 10, elementId: '', arkElement: { bytesData: card, linkInfo: null, subElementType: null }, shareToken };
    }
    function verify(element, peer) {
        capture.ensureReady(); current();
        const item = prepared.get(element?.shareToken), ark = element?.arkElement;
        if (!item || item.epoch !== capture.epoch || element.musicToken !== undefined ||
            item.peer.chatType !== peer.chatType || item.peer.peerUid !== peer.peerUid || element.elementType !== 10 ||
            !plain(ark) || Object.keys(ark).some(key => !['bytesData', 'linkInfo', 'subElementType'].includes(key)) ||
            ark.linkInfo !== null || ark.subElementType !== null || ark.bytesData !== item.card) {
            throw problem('INVALID_PARAMS', 'Share was not prepared for this account and conversation');
        }
        return element.shareToken;
    }
    return { prepare, verify, consume: token => prepared.delete(token), clear: () => prepared.clear() };
}

module.exports = { normalizeShareData, buildShareCard, createShareCards };
