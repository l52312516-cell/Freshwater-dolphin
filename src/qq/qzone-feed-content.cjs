'use strict';

// Small, inert HTML reader for known Qzone feed markup. No browser/DOM execution.
// Unknown markup retains null structured fields and the caller keeps raw HTML.
function entities(text) {
    const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (raw, token) => {
        if (token[0] !== '#') return names[token.toLowerCase()];
        const number = token[1].toLowerCase() === 'x' ? parseInt(token.slice(2), 16) : Number(token.slice(1));
        return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : raw;
    });
}
const has = (node, name) => (node.attributes?.class || '').split(/\s+/).includes(name);
const children = node => { const result = [], pending = [...node.children].reverse(); while (pending.length) { const next = pending.pop(); if (next.tag) result.push(next); for (let i = next.children.length - 1; i >= 0; i--) pending.push(next.children[i]); } return result; };
function tree(html) {
    const root = { tag: '#root', attributes: {}, children: [], parent: null }, stack = [root]; let nodes = 0;
    const tokens = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+|</g;
    for (const match of html.matchAll(tokens)) {
        if (++nodes > 15000 || stack.length > 100) return null;
        const raw = match[0];
        if (raw.startsWith('<!')) continue;
        if (raw.startsWith('</')) {
            const name = /^<\/([\w:-]+)/.exec(raw)?.[1]?.toLowerCase();
            for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === name) { stack.length = i; break; }
            continue;
        }
        const start = /^<([A-Za-z][\w:-]*)\b/.exec(raw);
        const parent = stack[stack.length - 1];
        if (!start) { parent.children.push({ text: entities(raw), children: [], parent }); continue; }
        const tag = start[1].toLowerCase(), attributes = {};
        const body = raw.slice(start[0].length, -1);
        for (const attribute of body.matchAll(/([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"=<>`]+)))?/g)) {
            const name = attribute[1].toLowerCase();
            if (Object.hasOwn(attributes, name) || ['__proto__', 'constructor', 'prototype'].includes(name)) return null;
            attributes[name] = entities(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
        }
        const node = { tag, attributes, children: [], parent }; parent.children.push(node);
        if (!['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag) && !raw.endsWith('/>')) stack.push(node);
    }
    return root;
}
function own(node, root) {
    for (let current = node.parent; current && current !== root; current = current.parent) if (['script', 'style', 'iframe'].includes(current.tag) || ['mod-comments', 'comments-list', 'f-item-passive', 'f-ct-video'].some(name => has(current, name))) return false;
    return true;
}
function text(node) {
    if (node.text !== undefined) return node.text.replace(/\s+/g, ' ');
    if (['script', 'style', 'iframe'].includes(node.tag) || node.attributes['data-cmd'] === 'qz_toggle' || has(node, 'load_img')) return '';
    if (node.tag === 'br') return '\n';
    if (node.tag === 'img') return node.attributes.alt || '';
    const value = node.children.map(text).join('');
    return ['div', 'p', 'li'].includes(node.tag) ? '\n' + value + '\n' : value;
}
function url(value) {
    if (!value || value.length > 8192) return null;
    try { const parsed = new URL(value.startsWith('//') ? 'https:' + value : value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null; } catch { return null; }
}
function parseFeedContent(feed) {
    const result = { tid: null, content: null, content_complete: null, images: null, like_count: feed.like_count, comment_count: feed.comment_count };
    const document = tree(feed.html); if (!document) return result;
    const bodies = children(document).filter(node => has(node, 'f-item') && node.attributes['data-key'] === feed.key && own(node, document));
    if (bodies.length !== 1) return result;
    const body = bodies[0], elements = children(body).filter(node => own(node, body));
    const metadata = elements.filter(node => node.attributes.name === 'feed_data' && node.attributes['data-uin'] === String(feed.uin) && node.attributes['data-fkey'] === feed.key);
    if (feed.appid === 311 && metadata.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(metadata[0].attributes['data-tid'] || '')) result.tid = metadata[0].attributes['data-tid'];
    const contentNodes = elements.filter(node => has(node, 'f-info'));
    const full = contentNodes.find(node => has(node, 'qz_info_complete') && text(node).trim());
    const content = full || contentNodes.find(node => !has(node, 'qz_info_complete'));
    if (content) {
        result.content = text(content).replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        result.content_complete = !!full || !children(content).some(node => node.attributes['data-cmd'] === 'qz_toggle');
    }
    const images = new Set();
    for (const item of elements.filter(node => has(node, 'img-item'))) {
        if (item.attributes['data-v_itemid'] || item.attributes['data-videotype']) continue;
        const fullUrl = url(item.attributes['data-originurl'] || item.attributes['data-url3']);
        if (fullUrl) { images.add(fullUrl); continue; }
        for (const image of children(item).filter(node => node.tag === 'img')) { const imageUrl = url(image.attributes.truesrc || image.attributes.src); if (imageUrl) images.add(imageUrl); }
    }
    result.images = [...images];
    let root = body;
    for (let parent = body.parent; parent; parent = parent.parent) if (has(parent, 'f-single')) { root = parent; break; }
    const like = children(root).find(node => has(node, 'qz_like_btn_v3') && own(node, root));
    const count = like?.attributes['data-likecnt'];
    if (result.like_count === null && /^\d{1,10}$/.test(count || '') && Number(count) <= 1000000000) result.like_count = Number(count);
    return result;
}
module.exports = { parseFeedContent };
