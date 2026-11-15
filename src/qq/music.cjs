'use strict';

const MAX_CARD_BYTES = 128 * 1024;
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function text(value, label, maximum, optional = false) {
    if (value === undefined && optional) return '';
    if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f\x7f]/.test(value) || !optional && !value.trim()) {
        throw problem('INVALID_PARAMS', 'Invalid music ' + label);
    }
    return value;
}
function musicUrl(value, label, optional = false, allowFragment = false) {
    const input = text(value, label, 2048, optional);
    if (!input && optional) return '';
    let url;
    try { url = new URL(input); } catch { throw problem('INVALID_PARAMS', 'Invalid music ' + label); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || !allowFragment && input.includes('#')) {
        throw problem('INVALID_PARAMS', 'Invalid music ' + label);
    }
    return url.href;
}
function normalizeMusicData(data) {
    if (!record(data) || Object.keys(data).some(key => !['type', 'id', 'url', 'audio', 'title', 'image', 'content'].includes(key))) {
        throw problem('INVALID_PARAMS', 'Invalid music segment fields');
    }
    if (!['qq', '163', 'custom'].includes(data.type)) throw problem('UNSUPPORTED', 'Supported music platforms are qq, 163 and custom');
    if (data.type !== 'custom') {
        const id = typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id > 0 ? String(data.id) : data.id;
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || data.type === '163' && !/^[1-9]\d*$/.test(id)) {
            throw problem('INVALID_PARAMS', 'Music platform cards require a valid song ID');
        }
        if (['url', 'audio', 'title', 'image', 'content'].some(key => Object.hasOwn(data, key))) throw problem('INVALID_PARAMS', 'Platform song IDs cannot be mixed with custom music fields');
        return { type: data.type, id };
    }
    if (data.id !== undefined) throw problem('INVALID_PARAMS', 'Custom music does not accept a platform song ID');
    return { type: 'custom', url: musicUrl(data.url, 'url', false, true), audio: musicUrl(data.audio, 'audio'),
        title: text(data.title, 'title', 1024), content: text(data.content, 'content', 2048, true), image: musicUrl(data.image, 'image', true) };
}
function validateMusicCard(input) {
    if (typeof input !== 'string' || !input || Buffer.byteLength(input) > MAX_CARD_BYTES) throw problem('INVALID_PARAMS', 'Music card is absent or exceeds 128 KiB');
    let card;
    try { card = JSON.parse(input); } catch { throw problem('INVALID_PARAMS', 'Music card is not JSON'); }
    if (!record(card) || !['com.tencent.structmsg', 'com.tencent.music.lua'].includes(card.app) || card.view !== 'music' || !record(card.meta) ||
        Object.keys(card.meta).some(key => key !== 'music') || !record(card.meta.music)) {
        throw problem('INVALID_PARAMS', 'Only music share cards are accepted');
    }
    const music = card.meta.music;
    text(music.title, 'card title', 1024);
    // These public card fields distinguish a music share from an arbitrary Ark
    // payload. Extra provider signature fields are retained byte for byte.
    musicUrl(music.musicUrl, 'card audio');
    musicUrl(music.jumpUrl, 'card link', false, true);
    if (music.preview !== undefined && music.preview !== '') musicUrl(music.preview, 'card image');
    if (card.app === 'com.tencent.music.lua') {
        if (!record(card.config) || !record(card.extra) || !Number.isSafeInteger(music.app_type) || music.app_type < 1 ||
            !Number.isSafeInteger(music.appid) || music.appid < 1 || !Number.isSafeInteger(music.ctime) || music.ctime < 1 ||
            !Number.isSafeInteger(music.uin) || music.uin < 0 || !Number.isSafeInteger(card.config.ctime) || card.config.ctime < 1) {
            throw problem('INVALID_PARAMS', 'Music Lua card is missing required signed metadata');
        }
        text(card.config.token, 'card signature', 4096); text(card.config.type, 'card type', 64);
    }
    if (Object.keys(card).some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw problem('INVALID_PARAMS', 'Invalid music card fields');
    return input;
}
module.exports = { normalizeMusicData, validateMusicCard, MAX_CARD_BYTES };
