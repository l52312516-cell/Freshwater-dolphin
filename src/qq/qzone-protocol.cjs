'use strict';

// Closed Qzone web contracts. This module parses data, never JavaScript code.
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function integer(value, maximum = Number.MAX_SAFE_INTEGER, minimum = 0, code = 'INVALID_PARAMS') {
    if (!['number', 'string'].includes(typeof value) || !/^(0|[1-9]\d{0,15})$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) fail(code, 'Qzone requires an exact bounded integer');
    return Number(value);
}
function string(value, maximum = 32768, empty = true, code = 'INVALID_PARAMS') {
    if (typeof value !== 'string' || !empty && !value.trim() || Buffer.byteLength(value) > maximum || value.includes('\0') || Buffer.from(value).toString('utf8') !== value) fail(code, 'Qzone requires bounded valid text');
    return value;
}
function identifier(value, code = 'INVALID_PARAMS') {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(code, 'Invalid Qzone post or comment identifier');
    return value;
}
function uin(value, code = 'INVALID_PARAMS') { return String(integer(value, 0xffffffff, 1, code)); }
function ack(value) {
    if (!object(value) || !['code', 'subcode'].some(key => Object.hasOwn(value, key))) fail('INVALID_RESPONSE', 'Qzone omitted an explicit business acknowledgement; check delivery before retrying');
    for (const key of ['code', 'subcode']) if (Object.hasOwn(value, key)) {
        if (!Number.isSafeInteger(value[key])) fail('INVALID_RESPONSE', 'Qzone supplied an invalid business status');
        if (value[key] !== 0) fail('KERNEL_ERROR', 'Qzone rejected the operation (' + key + '=' + value[key] + ')');
    }
    return value;
}
const QUERIES = Object.freeze({ 'qzone.list': ['targetUin', 'pos', 'num'], 'qzone.detail': ['targetUin', 'tid', 'pos', 'num'], 'qzone.feeds': ['pageNum', 'count', 'cursor'] });
const ACTIONS = Object.freeze({ 'qzone.publish': ['content', 'images', 'ugcRight', 'targetUins'], 'qzone.delete': ['tid'], 'qzone.right': ['tid', 'ugcRight', 'targetUins'],
    'qzone.like': ['tid', 'targetUin', 'abstime'], 'qzone.unlike': ['tid', 'targetUin', 'abstime'], 'qzone.comment': ['tid', 'targetUin', 'content', 'images', 'commentId', 'commentUin', 'replyUin', 'replyName'], 'qzone.ban': ['userId', 'enable'] });
function validate(data, mutation) {
    const allowed = (mutation ? ACTIONS : QUERIES)[data?.operation];
    if (!allowed) fail('UNSUPPORTED', 'Unknown fixed Qzone operation');
    if (!object(data) || Object.keys(data).some(key => !['operation', 'expectedEpoch', ...allowed].includes(key))) fail('INVALID_PARAMS', 'Unexpected Qzone operation parameters');
    const output = { ...data };
    for (const key of ['targetUin', 'commentUin', 'replyUin', 'userId']) if (data[key] !== undefined) output[key] = uin(data[key]);
    if (data.operation === 'qzone.ban') { output.userId = uin(data.userId); output.enable = data.enable ?? true; if (typeof output.enable !== 'boolean') fail('INVALID_PARAMS', 'Qzone ban enable must be boolean'); }
    if (allowed.includes('tid')) output.tid = identifier(data.tid);
    if (allowed.includes('pos')) { output.pos = integer(data.pos ?? 0, 100000); output.num = integer(data.num ?? 20, 100, 1); }
    if (allowed.includes('content')) output.content = string(data.content, 32768, false);
    if (allowed.includes('abstime')) output.abstime = integer(data.abstime ?? 0, 0xffffffff);
    if (data.operation === 'qzone.feeds') {
        output.pageNum = integer(data.pageNum ?? 1, 100000, 1); output.count = integer(data.count ?? 10, 50, 1);
        if (data.cursor !== undefined) string(data.cursor, 65536, false);
        if (data.cursor === undefined && output.pageNum > 20) fail('INVALID_PARAMS', 'Deep Qzone feed pages require a continuation cursor');
    }
    if (allowed.includes('ugcRight')) {
        output.ugcRight = integer(data.ugcRight ?? (data.operation === 'qzone.publish' ? 1 : undefined), 128, 1);
        if (![1, 4, 16, 64, 128].includes(output.ugcRight)) fail('INVALID_PARAMS', 'Unsupported Qzone visibility');
        if (data.targetUins !== undefined && (!Array.isArray(data.targetUins) || data.targetUins.length > 100)) fail('INVALID_PARAMS', 'Qzone visibility targets exceed their bound');
        output.targetUins = (data.targetUins || []).map(value => uin(value));
        if (new Set(output.targetUins).size !== output.targetUins.length || ([16, 128].includes(output.ugcRight) ? !output.targetUins.length : output.targetUins.length)) fail('INVALID_PARAMS', 'Qzone visibility needs a unique matching target list');
    }
    if (allowed.includes('images')) {
        if (data.images !== undefined && (!Array.isArray(data.images) || data.images.length > 9 || data.images.some(value => typeof value !== 'string' || !/^fwd-image-[a-f0-9]{32}$/.test(value)))) fail('INVALID_PARAMS', 'Qzone images require at most nine account image handles');
        output.images = data.images || [];
    }
    if (data.operation === 'qzone.comment') {
        if ((data.commentId === undefined) !== (data.commentUin === undefined) || (data.replyUin === undefined) !== (data.replyName === undefined) || data.replyUin !== undefined && data.commentId === undefined) fail('INVALID_PARAMS', 'Qzone comment reply requires paired parent and addressed-user fields');
        if (data.commentId !== undefined) { output.commentId = identifier(data.commentId); if (output.images.length) fail('INVALID_PARAMS', 'Qzone inline replies support text only'); }
        if (data.replyName !== undefined) output.replyName = string(data.replyName, 1024, false);
    }
    return output;
}

// Bounded recursive literal parser. Only known wrappers and literal tokens are
// accepted; calls, expressions, getters, templates and prototype keys fail.
function parse(text) {
    string(text, 2 * 1024 * 1024, false, 'INVALID_RESPONSE');
    let source = text.trim(), wrapper = false;
    if (source.startsWith('<script>') && source.endsWith('</script>')) source = source.slice(8, -9).trim();
    const prefix = /^(?:_preloadCallback|_Callback|callback|frameElement\.callback)\s*\(/.exec(source);
    if (prefix) { wrapper = true; source = source.slice(prefix[0].length); }
    let offset = 0, nodes = 0;
    const invalid = () => fail('INVALID_RESPONSE', 'Qzone returned no bounded literal data response');
    const whitespace = () => { while (/\s/.test(source[offset] || '') && offset < source.length) offset++; };
    function quoted() {
        const quote = source[offset++]; let value = '', closed = false;
        while (offset < source.length) {
            const char = source[offset++];
            if (char === quote) { closed = true; break; }
            if (char.charCodeAt(0) < 32) invalid();
            if (char !== '\\') { value += char; continue; }
            const escape = source[offset++], escapes = { '"': '"', "'": "'", '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
            if (Object.hasOwn(escapes, escape)) value += escapes[escape];
            else if (escape === 'x' || escape === 'u') {
                const length = escape === 'x' ? 2 : 4, hex = source.slice(offset, offset + length);
                if (hex.length !== length || !/^[0-9a-f]+$/i.test(hex)) invalid();
                offset += length; value += String.fromCharCode(parseInt(hex, 16));
            } else invalid();
        }
        if (!closed || Buffer.from(value).toString('utf8') !== value) invalid();
        return value;
    }
    function value(depth) {
        if (++nodes > 30000 || depth > 32) invalid(); whitespace();
        const char = source[offset];
        if (char === '"' || char === "'") return quoted();
        if (char === '{') {
            offset++; const output = {}; whitespace();
            if (source[offset] === '}') { offset++; return output; }
            for (;;) {
                whitespace(); let key;
                if (source[offset] === '"' || source[offset] === "'") key = quoted();
                else { const found = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(offset)); if (!found) invalid(); key = found[0]; offset += key.length; }
                if (['__proto__', 'prototype', 'constructor'].includes(key) || Object.hasOwn(output, key)) invalid();
                whitespace(); if (source[offset++] !== ':') invalid(); output[key] = value(depth + 1); whitespace();
                const next = source[offset++]; if (next === '}') return output; if (next !== ',') invalid();
                whitespace(); if (source[offset] === '}') { offset++; return output; }
            }
        }
        if (char === '[') {
            offset++; const output = []; whitespace();
            if (source[offset] === ']') { offset++; return output; }
            for (;;) {
                whitespace();
                if (source[offset] === ',') { if (++nodes > 30000) invalid(); output.push(null); offset++; continue; }
                if (source[offset] === ']') { offset++; return output; }
                output.push(value(depth + 1)); if (output.length > 10000) invalid(); whitespace();
                const next = source[offset++]; if (next === ']') return output; if (next !== ',') invalid();
            }
        }
        for (const [token, decoded] of [['true', true], ['false', false], ['null', null], ['undefined', null]]) if (source.startsWith(token, offset)) { offset += token.length; return decoded; }
        const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(offset));
        if (!number) invalid(); offset += number[0].length;
        const decoded = Number(number[0]); if (!Number.isFinite(decoded) || Number.isInteger(decoded) && !Number.isSafeInteger(decoded)) invalid(); return decoded;
    }
    const output = value(0); whitespace();
    if (wrapper) { if (source[offset++] !== ')') invalid(); whitespace(); }
    if (source[offset] === ';') { offset++; whitespace(); }
    if (offset !== source.length || !object(output)) invalid();
    return output;
}
function imageUrl(value, code = 'INVALID_RESPONSE') {
    string(value, 8192, false, code); let url;
    try { url = new URL(value.startsWith('//') ? 'https:' + value : value); } catch { fail(code, 'Invalid Qzone image URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(code, 'Invalid Qzone image URL');
    return url.href;
}
function list(value, request) {
    ack(value);
    if (!Array.isArray(value.msglist) || value.msglist.length > request.num) fail('INVALID_RESPONSE', 'Qzone omitted a bounded post collection');
    const total = integer(value.total, 10000000, 0, 'INVALID_RESPONSE'), seen = new Set();
    if (value.msglist.length && total < request.pos + value.msglist.length) fail('INVALID_RESPONSE', 'Qzone post page conflicts with its real total');
    return { total, msglist: value.msglist.map(item => {
        if (!object(item)) fail('INVALID_RESPONSE', 'Invalid Qzone post');
        const tid = identifier(item.tid, 'INVALID_RESPONSE'); if (seen.has(tid)) fail('INVALID_RESPONSE', 'Repeated Qzone post'); seen.add(tid);
        const images = item.pic === undefined || item.pic === null ? [] : item.pic;
        if (!Array.isArray(images) || images.length > 100) fail('INVALID_RESPONSE', 'Invalid Qzone post images');
        return { tid, content: string(item.content, 131072, true, 'INVALID_RESPONSE'), time: integer(item.created_time, 0xffffffff, 0, 'INVALID_RESPONSE'),
            comment_num: integer(item.cmtnum, 10000000, 0, 'INVALID_RESPONSE'), is_private: integer(item.secret, 255, 0, 'INVALID_RESPONSE') !== 0,
            images: images.map(pic => { if (!object(pic)) fail('INVALID_RESPONSE', 'Invalid Qzone picture'); return imageUrl(pic.url3 || pic.url2 || pic.url1 || pic.smallurl); }) };
    }) };
}
function detail(value, request) {
    ack(value);
    if (identifier(value.tid, 'INVALID_RESPONSE') !== request.tid || value.uin !== undefined && uin(value.uin, 'INVALID_RESPONSE') !== request.targetUin) fail('INVALID_RESPONSE', 'Qzone detail belongs to another post or account');
    const total = integer(value.cmtnum, 10000000, 0, 'INVALID_RESPONSE');
    const comments = value.commentlist == null && (total === 0 || request.pos >= total) ? [] : value.commentlist;
    if (!Array.isArray(comments) || comments.length > request.num || comments.length > total) fail('INVALID_RESPONSE', 'Qzone omitted a real comment page');
    const map = item => {
        if (!object(item)) fail('INVALID_RESPONSE', 'Invalid Qzone comment');
        const id = typeof item.tid === 'number' ? String(integer(item.tid, Number.MAX_SAFE_INTEGER, 0, 'INVALID_RESPONSE')) : identifier(item.tid, 'INVALID_RESPONSE');
        return { comment_id: id, uin: Number(uin(item.uin, 'INVALID_RESPONSE')), name: string(item.name, 4096, true, 'INVALID_RESPONSE'),
            time: integer(item.create_time, 0xffffffff, 0, 'INVALID_RESPONSE'), content: string(item.content, 131072, true, 'INVALID_RESPONSE') };
    };
    const seen = new Set();
    return { tid: value.tid, content: string(value.content, 131072, true, 'INVALID_RESPONSE'), comment_num: total, comments: comments.map(item => {
        const mapped = map(item); if (seen.has(mapped.comment_id)) fail('INVALID_RESPONSE', 'Repeated Qzone parent comment'); seen.add(mapped.comment_id);
        const replies = item.list_3 == null ? [] : item.list_3;
        if (!Array.isArray(replies) || replies.length > 1000) fail('INVALID_RESPONSE', 'Invalid Qzone inline replies');
        const replyIds = new Set();
        return { ...mapped, replies: replies.map(reply => { const row = map(reply); if (replyIds.has(row.comment_id)) fail('INVALID_RESPONSE', 'Repeated Qzone inline reply'); replyIds.add(row.comment_id);
            return { ...row, parent_comment_id: mapped.comment_id, parent_comment_uin: mapped.uin }; }) };
    }) };
}
const numericFields = ['begintime', 'dayspac', 'pagenum', 'aisortEndTime', 'aisortOffset', 'aisortBeginTime', 'aisortNextTime', 'icServerTime'];
const textFields = ['externparam', 'daylist', 'uinlist'];
function feedInteger(value, maximum, minimum, field) {
    try { return integer(value, maximum, minimum, 'INVALID_RESPONSE'); }
    catch {
        // Schema categories only. Never include the source value or feed identity.
        const reason = value === undefined ? 'missing' : value === null ? 'null' : !['number', 'string'].includes(typeof value) ? 'type' :
            !/^(0|[1-9]\d{0,15})$/.test(String(value)) ? 'noncanonical' : !Number.isSafeInteger(Number(value)) ? 'unsafe' :
                Number(value) < minimum ? 'below-minimum' : 'above-maximum';
        fail('INVALID_RESPONSE', 'Qzone requires an exact bounded integer [field=' + field + ';reason=' + reason + ']');
    }
}
function initialState() { return Object.fromEntries([...numericFields.map(key => [key, key === 'pagenum' ? '1' : '0']), ...textFields.map(key => [key, ''])]); }
function nextState(main, previous) {
    if (!object(main)) fail('INVALID_RESPONSE', 'Qzone omitted feed continuation state');
    const next = { ...previous };
    for (const key of numericFields) if (main[key] !== undefined && main[key] !== '') next[key] = String(feedInteger(main[key], Number.MAX_SAFE_INTEGER, key === 'pagenum' ? 1 : 0, 'continuation.' + key));
    for (const key of textFields) if (main[key] !== undefined && (main[key] !== '' || key === 'uinlist')) next[key] = string(main[key], 32768, true, 'INVALID_RESPONSE');
    return next;
}
function position(state) { return JSON.stringify([...numericFields, ...textFields].filter(key => key !== 'icServerTime').map(key => state[key])); }
function more(value) { if ([true, 1, '1'].includes(value)) return true; if ([false, 0, '0'].includes(value)) return false; fail('INVALID_RESPONSE', 'Qzone omitted a real feed end marker'); }
function feeds(value, count) {
    // The CGI can ignore count and return pinned/advertising entries together
    // with its default batch. Parse the complete bounded source page; the
    // worker retains overflow before exposing count-sized public pages.
    integer(count, 50, 1);
    ack(value); if (!object(value.data) || !Array.isArray(value.data.data) || value.data.data.length > 250 || value.data.main !== undefined && !object(value.data.main)) fail('INVALID_RESPONSE', 'Qzone omitted a bounded feed page');
    const main = value.data.main;
    if (main?.error !== undefined && main.error !== '') fail('KERNEL_ERROR', 'Qzone reported a feed retrieval failure');
    const entries = value.data.data.filter(item => item !== null), seen = new Set(); if (entries.length > 150) fail('INVALID_RESPONSE', 'Qzone source feed page exceeded its item budget');
    return { feeds: entries.map(item => {
        if (!object(item)) fail('INVALID_RESPONSE', 'Invalid Qzone feed');
        // The feed CGI uses literal 0 for system/unattributed entries. Preserve
        // that observed sentinel without turning it into a real target QQ ID.
        const author = feedInteger(item.uin, 0xffffffff, 0, 'feed.uin'), key = string(item.key ?? item.feedskey, 1024, false, 'INVALID_RESPONSE');
        const identity = author + ':' + key; if (seen.has(identity)) fail('INVALID_RESPONSE', 'Repeated Qzone feed'); seen.add(identity);
        const counter = name => {
            const value = item[name];
            return ['number', 'string'].includes(typeof value) && /^(0|[1-9]\d{0,9})$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) <= 1000000000 ? Number(value) : null;
        };
        return { uin: author, author_kind: author === 0 ? 'system-or-unattributed' : 'qq-user', key, nickname: string(item.nickname, 4096, true, 'INVALID_RESPONSE'), time: feedInteger(item.abstime, 0xffffffff, 0, 'feed.abstime'),
            appid: feedInteger(item.appid, 0xffffffff, 0, 'feed.appid'), html: string(item.html, 1048576, true, 'INVALID_RESPONSE'),
            tid: null, content: null, content_complete: null, images: null, like_count: counter('likecnt'), comment_count: counter('commentcnt') };
    }), has_more: more(main === undefined ? value.data.hasmore : main.hasMoreFeeds), next_cursor: null };
}
// Permission changes re-submit a complete text/image post. Reject unsupported
// rich content and incomplete image metadata before the first write.
function updatePayload(value, self, tid) {
    ack(value);
    if (value.tid !== tid || uin(value.uin, 'INVALID_RESPONSE') !== self) fail('INVALID_RESPONSE', 'Qzone permission detail does not prove ownership');
    const pics = value.pic == null ? [] : value.pic;
    if (!Array.isArray(pics) || pics.length > 100) fail('INVALID_RESPONSE', 'Invalid Qzone permission image detail');
    const type = value.richtype === undefined || value.richtype === '' ? (pics.length ? 1 : '') : integer(value.richtype, 0xffffffff, 0, 'INVALID_RESPONSE');
    if (!['', 0, 1].includes(type) || value.video?.length || value.music || value.attach) fail('UNSUPPORTED', 'Qzone permission updates support complete text/image posts only');
    if (!pics.length && value.richval || value.video && !Array.isArray(value.video)) fail('UNSUPPORTED', 'Qzone permission detail contains unsupported rich content');
    const richvals = [], bos = [];
    for (const pic of pics) {
        if (!object(pic) || typeof pic.pic_id !== 'string') fail('INVALID_RESPONSE', 'Qzone permission detail omits an image identity');
        const parts = pic.pic_id.split(','), album = parts[1], location = parts[2];
        if (!album || !location || /[\t\r\n]/.test(album + location)) fail('INVALID_RESPONSE', 'Unrebuildable Qzone image identity');
        const picType = integer(pic.pictype ?? pic.type, 0xffffffff, 0, 'INVALID_RESPONSE'), height = integer(pic.height ?? pic.b_height, 65535, 1, 'INVALID_RESPONSE'), width = integer(pic.width ?? pic.b_width, 65535, 1, 'INVALID_RESPONSE');
        richvals.push(',' + [album, location, location, picType, height, width, '', 0, 0].join(','));
        const candidate = [pic.smallurl, pic.url1, pic.url2, pic.url3].find(url => typeof url === 'string' && new URL(imageUrl(url)).searchParams.has('bo'));
        if (!candidate) fail('INVALID_RESPONSE', 'Qzone permission detail omits original image encoding');
        bos.push(new URL(imageUrl(candidate)).searchParams.get('bo'));
    }
    if (type === 1 && !richvals.length || type !== 1 && pics.length) fail('INVALID_RESPONSE', 'Qzone permission rich content is inconsistent');
    let content = string(value.content, 131072, true, 'INVALID_RESPONSE');
    if (value.conlist !== undefined && value.conlist !== null) {
        if (!Array.isArray(value.conlist) || value.conlist.length > 1000) fail('INVALID_RESPONSE', 'Invalid Qzone complete content');
        if (value.conlist.length) content = value.conlist.map(part => { if (!object(part)) fail('INVALID_RESPONSE', 'Invalid Qzone content component'); return string(part.con, 131072, true, 'INVALID_RESPONSE'); }).join('');
        string(content, 131072, true, 'INVALID_RESPONSE');
    }
    const optional = (name, fallback = '') => value[name] === undefined ? fallback : string(value[name], 32768, true, 'INVALID_RESPONSE');
    const numeric = (name, fallback) => value[name] === undefined ? fallback : String(integer(value[name], 0xffffffff, 0, 'INVALID_RESPONSE'));
    const bo = bos.join(',');
    return { syn_tweet_verson: '1', tid, paramstr: '1', pic_template: optional('pic_template'), richtype: String(type), richval: richvals.length ? richvals.join('\t') : optional('richval'),
        special_url: optional('special_url'), subrichtype: value.t1_subtype !== undefined ? String(integer(value.t1_subtype, 1, 0, 'INVALID_RESPONSE')) : numeric('subrichtype', richvals.length ? '1' : ''),
        pic_bo: bo ? bo + '\t' + bo : '', con: content, feedversion: numeric('feedversion', '1'), ver: numeric('ver', '1'), ugc_right: numeric('ugc_right', '1'), to_sign: numeric('to_sign', '0'),
        ugcright_id: optional('ugcright_id', tid), hostuin: self, code_version: numeric('code_version', '1'), format: 'fs', qzreferrer: 'https://user.qzone.qq.com/' + self };
}
module.exports = { fail, object, integer, string, identifier, uin, ack, QUERIES, ACTIONS, validate, parse, imageUrl, list, detail, initialState, nextState, position, feeds, updatePayload };
