'use strict';

const p = require('./qzone-protocol.cjs');
const { createWeb } = require('./qzone-web.cjs');
const TRACE = 'base64-eyJhcHBpZCI6InRvYWlvIiwicGFnZV9pZCI6IjM3IiwiaXRlbV9pZCI6IiIsIml0ZW1fdHlwZSI6%0AIiJ9%0A';
const UA = 'Mozilla/5.0 (Linux; Android 13; 2109119BC Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0.6167.71 MQQBrowser/6.2 TBS/047925 Mobile Safari/537.36 V1_AND_SQ_9.2.66_13188_YYB_D QQ/9.2.66.33870 NetType/WIFI WebP/0.3.0 AppId/537339358';
const KINDS = Object.freeze({ 2: '气泡', 4: '挂件', 5: '字体', 15: '名片', 17: '来电', 22: '彩色屏保', 23: '头像', 47: '头像双击动作', 352: '输入状态' });
function dressUrl(target) {
    target = p.uin(target);
    const inner = 'https://zb.vip.qq.com/v2/pages/aioDressPage?fromPage=1&targetUin=' + target + '&widgetId=0&fontEffectId=0&bgId=custom&chatId=' + target + '&isGroup=0&traceDetail=' + TRACE;
    return 'https://zb.vip.qq.com/v2/pages/aioDressPage?' + new URLSearchParams({ fromPage: '1', enteranceId: 'aio', url: inner, fontEffectId: '0', chatId: target, widgetId: '0', targetUin: target, isGroup: '0', bgId: 'custom' }) + '&traceDetail=' + TRACE;
}
function parseDress(html, target) {
    p.string(html, 2097152, false, 'INVALID_RESPONSE'); target = p.uin(target);
    const matches = [...html.matchAll(/window\.__INITIAL_ASYNCDATA__\s*=\s*/g)];
    if (matches.length !== 1) p.fail('INVALID_RESPONSE', 'Friend dress page omitted unambiguous initial data (auth, risk control or page revision)');
    const start = matches[0].index + matches[0][0].length; let depth = 0, quoted = false, escaped = false, end;
    if (html[start] !== '{') p.fail('INVALID_RESPONSE', 'Friend dress initial data is not a JSON object');
    for (let i = start; i < html.length; i++) {
        const char = html[i];
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
        if (char === '"') quoted = true;
        else if (char === '{' || char === '[') { if (++depth > 32) p.fail('INVALID_RESPONSE', 'Friend dress initial data is too deep'); }
        else if (char === '}' || char === ']') { if (--depth === 0) { end = i + 1; break; } }
    }
    if (!end || !/^\s*;\s*\(function\b/.test(html.slice(end))) p.fail('INVALID_RESPONSE', 'Friend dress page has no complete known initial-data boundary');
    let raw; try { const source = html.slice(start, end); p.parse(source); raw = JSON.parse(source); } catch { p.fail('INVALID_RESPONSE', 'Friend dress initial data is not bounded exact JSON'); }
    if (!p.object(raw) || p.uin(raw.targetUin, 'INVALID_RESPONSE') !== target) p.fail('INVALID_RESPONSE', 'Friend dress data belongs to another requested user');
    if (!Array.isArray(raw.rawUsingList) || raw.rawUsingList.length > 256 || typeof raw.isSvip !== 'boolean') p.fail('INVALID_RESPONSE', 'Friend dress page omitted a real catalog or membership state');
    const url = value => value === '' ? '' : p.imageUrl(value), seen = new Set();
    return { target_uin: target, is_svip: raw.isSvip, avatar_url: raw.avatarImage === undefined ? '' : url(raw.avatarImage), items: raw.rawUsingList.map(item => {
        if (!p.object(item)) p.fail('INVALID_RESPONSE', 'Invalid friend dress item');
        const app = p.integer(item.appId, 0xffffffff, 1, 'INVALID_RESPONSE'), id = p.integer(item.itemId ?? 0, 0xffffffff, 0, 'INVALID_RESPONSE');
        if (seen.has(app)) p.fail('INVALID_RESPONSE', 'Friend dress page repeats a business category'); seen.add(app);
        const preview = item.image === undefined ? '' : url(item.image); let video = '';
        if (item.extraappinfo !== undefined && !p.object(item.extraappinfo) || item.extraappinfo?.extraInfo !== undefined && !p.object(item.extraappinfo.extraInfo) || item.extrainfo !== undefined && !p.object(item.extrainfo)) p.fail('INVALID_RESPONSE', 'Invalid friend dress extra metadata');
        if (app === 15 && item.extraappinfo?.extraInfo?.immersiveMaterial !== undefined) {
            const source = p.string(item.extraappinfo.extraInfo.immersiveMaterial, 32768, false, 'INVALID_RESPONSE'); let material;
            try { p.parse(source); material = JSON.parse(source); } catch { p.fail('INVALID_RESPONSE', 'Friend dress video metadata is not exact JSON'); }
            video = url(material.videoUrl);
        } else if (app === 17 && /\/(?:web_)?image\.jpg$/.test(preview)) video = preview.replace(/\/(?:web_)?image\.jpg$/, '/media.mp4');
        const price = item.extrainfo?.price ?? 0;
        if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 1000000000) p.fail('INVALID_RESPONSE', 'Invalid friend dress price');
        return { app_id: app, kind: KINDS[app] || 'appId=' + app, item_id: id, name: p.string(item.name ?? '', 4096, true, 'INVALID_RESPONSE'), preview_url: preview, video_url: video, price };
    }).filter(item => ![2, 5, 23].includes(item.app_id)) };
}
function createFriendDress(capture, { fetchImpl = globalThis.fetch } = {}) {
    const web = createWeb(capture, fetchImpl, 'friendDress'), pending = new Set(); let generation = 0;
    const capabilities = () => ({ friendDress: typeof fetchImpl === 'function' && capture.hasMethods('ticket', ['forceFetchClientKey']) });
    async function query(data, context = {}) {
        if (!p.object(data) || Object.keys(data).some(key => !['expectedEpoch', 'targetUin'].includes(key))) p.fail('INVALID_PARAMS', 'Unexpected friend dress query fields');
        capture.ensureReady(); const target = p.uin(data.targetUin), saved = { epoch: capture.epoch, session: capture.session, uin: p.uin(capture.self?.uin), uid: capture.self?.uid, generation };
        if (data.expectedEpoch !== saved.epoch) p.fail('SESSION_CHANGED', 'Friend dress query must bind the current QQ session');
        if (!capabilities().friendDress) p.fail('UNSUPPORTED', 'This QQ session lacks friend dress web authentication');
        if (pending.size >= 4) p.fail('BUSY', 'Too many friend dress queries await physical completion');
        const bounded = { ...context, expiresAt: Math.min(Date.now() + 15000, context.expiresAt ?? Infinity) };
        const active = () => { capture.ensureReady(); if (generation !== saved.generation || capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) p.fail('SESSION_CHANGED', 'QQ changed during friend dress lookup');
            if (bounded.signal?.aborted || Date.now() >= bounded.expiresAt) p.fail('EXPIRED', 'Friend dress query exceeded its deadline'); };
        const scope = { saved, context: bounded, active }, token = {}; pending.add(token);
        const task = Promise.resolve().then(async () => {
            active(); const auth = await web.authenticate(scope); active(); const url = dressUrl(target);
            const response = await web.request(url, { headers: { Cookie: auth.cookie(url), 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' } }, scope);
            if (response.status !== 200) p.fail('QUERY_FAILED', 'Friend dress page request failed; redirects are not followed');
            return { uin: saved.uin, targetUin: target, result: parseDress(response.text, target) };
        });
        task.then(() => pending.delete(token), () => pending.delete(token));
        const result = await capture.deadline(() => task, bounded, 15000); active(); return result;
    }
    return { capabilities, query, clear() { generation++; } };
}
module.exports = { createFriendDress, dressUrl, parseDress };
