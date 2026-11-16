'use strict';

const crypto = require('node:crypto');
const p = require('./qzone-protocol.cjs');
const { parseFeedContent } = require('./qzone-feed-content.cjs');
const { createWeb } = require('./qzone-web.cjs');
const media = require('./media.cjs');
const BASE = 'https://h5.qzone.qq.com/proxy/domain/';
const PATHS = Object.freeze({ list: BASE + 'taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6',
    alternateList: 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6',
    detail: BASE + 'taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6', feeds: BASE + 'ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more',
    publish: BASE + 'taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6', delete: BASE + 'taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6',
    right: BASE + 'taotao.qzone.qq.com/cgi-bin/emotion_cgi_update', like: BASE + 'w.qzone.qq.com/cgi-bin/likes/internal_dolike_app',
    unlike: BASE + 'w.qzone.qq.com/cgi-bin/likes/internal_unlike_app', comment: BASE + 'taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds',
    reply: BASE + 'taotao.qzone.qq.com/cgi-bin/emotion_cgi_addreply_ugc', ban: BASE + 'w.qzone.qq.com/cgi-bin/right/cgi_black_action_new',
    upload: 'https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image' });
const REQUIREMENTS = Object.freeze({ 'qzone.list': 'qzoneRead', 'qzone.detail': 'qzoneRead', 'qzone.feeds': 'qzoneFeeds', 'qzone.publish': 'qzoneWrite',
    'qzone.delete': 'qzoneWrite', 'qzone.right': 'qzoneRight', 'qzone.like': 'qzoneWrite', 'qzone.unlike': 'qzoneUnlike', 'qzone.comment': 'qzoneWrite', 'qzone.ban': 'qzoneWrite' });
function identity(data, self) {
    return { operation: data.operation, uin: self,
        ...(['qzone.list', 'qzone.detail', 'qzone.like', 'qzone.unlike', 'qzone.comment'].includes(data.operation) ? { targetUin: data.targetUin || self } : {}),
        ...(data.tid !== undefined ? { tid: data.tid } : {}), ...(data.operation === 'qzone.ban' ? { userId: data.userId, enable: data.enable } : {}),
        ...(data.ugcRight !== undefined ? { ugcRight: data.ugcRight, targetUins: data.targetUins } : {}) };
}
function createQzone(capture, { fetchImpl = globalThis.fetch, enableUnverifiedUnlike = false } = {}) {
    const web = createWeb(capture, fetchImpl), pending = new Set(), feedPages = new Map(); let writing = false, generation = 0, secret = crypto.randomBytes(32), feedBytes = 0;
    function capabilities() {
        const ready = typeof fetchImpl === 'function' && capture.hasMethods('ticket', ['forceFetchClientKey']);
        return { qzoneRead: ready, qzoneFeeds: ready, qzoneWrite: ready, qzoneRight: ready, qzoneImages: ready && typeof capture.mediaDirectory === 'string', qzoneUnlike: ready && enableUnverifiedUnlike === true };
    }
    function state(data, context) {
        capture.ensureReady();
        if (data.expectedEpoch !== capture.epoch) p.fail('SESSION_CHANGED', 'Qzone operation must bind the current QQ session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: p.uin(capture.self?.uin, 'INVALID_RESPONSE'), uid: capture.self?.uid, generation };
        const bounded = { ...context, expiresAt: Math.min(Date.now() + 60000, context.expiresAt ?? Infinity) };
        const active = () => {
            capture.ensureReady();
            if (saved.generation !== generation || saved.epoch !== capture.epoch || saved.session !== capture.session || saved.uin !== capture.self?.uin || saved.uid !== capture.self?.uid) p.fail('SESSION_CHANGED', 'QQ changed during the Qzone operation');
            if (bounded.signal?.aborted || Date.now() >= bounded.expiresAt) p.fail('EXPIRED', 'Qzone operation expired; any write outcome may be unknown');
        };
        active(); return { saved, context: bounded, active };
    }
    async function call(route, query, form, scope, auth) {
        scope.active(); if (!Object.values(PATHS).includes(route)) p.fail('UNSUPPORTED', 'Unknown fixed Qzone route');
        const url = route + '?' + new URLSearchParams({ ...query, g_tk: auth.key }).toString();
        const response = await web.request(url, { method: form ? 'POST' : 'GET', headers: { Cookie: auth.cookie(url),
            Referer: 'https://user.qzone.qq.com/' + scope.saved.uin, 'Content-Type': 'application/x-www-form-urlencoded' },
            ...(form ? { body: new URLSearchParams(form).toString() } : {}) }, scope);
        if (response.status !== 200) p.fail('QUERY_FAILED', 'Qzone returned a failed HTTP status; redirects are not followed');
        return p.parse(response.text);
    }
    function sweepFeeds() {
        for (const [key, value] of feedPages) if (value.expiresAt <= Date.now()) { feedPages.delete(key); feedBytes -= value.bytes; }
    }
    function saveFeedPage(value) {
        sweepFeeds(); const bytes = Buffer.byteLength(JSON.stringify(value));
        if (bytes > 4 * 1024 * 1024) p.fail('INVALID_RESPONSE', 'Qzone source page exceeded its snapshot byte budget');
        if (feedPages.size >= 32 || feedBytes + bytes > 16 * 1024 * 1024) p.fail('BUSY', 'Qzone feed continuation snapshot budget is full');
        const key = crypto.randomBytes(24).toString('base64url');
        const snapshot = { ...value, bytes, key, expiresAt: Date.now() + 300000 }; feedPages.set(key, snapshot); feedBytes += bytes;
        return snapshot;
    }
    function encodeCursor(scope, page, count, snapshot, offset) {
        const payload = Buffer.from(JSON.stringify({ version: 2, uin: scope.saved.uin, epoch: scope.saved.epoch, generation: scope.saved.generation, page, count,
            expiresAt: snapshot.expiresAt, ref: snapshot.key, offset })).toString('base64url');
        const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
        if (payload.length + signature.length + 1 > 65536) p.fail('INVALID_RESPONSE', 'Qzone feed cursor exceeded its byte budget');
        return payload + '.' + signature;
    }
    function decodeCursor(cursor, scope, count) {
        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor) || cursor.length > 65536) p.fail('INVALID_PARAMS', 'Invalid Qzone continuation cursor');
        const [payload, signature] = cursor.split('.'), wanted = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(wanted))) p.fail('INVALID_PARAMS', 'Qzone cursor was changed or belongs to another session');
        let value; try { const bytes = Buffer.from(payload, 'base64url'); if (bytes.toString('base64url') !== payload) throw new Error(); value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); } catch { p.fail('INVALID_PARAMS', 'Invalid Qzone cursor data'); }
        if (!p.object(value) || Object.keys(value).some(key => !['version', 'uin', 'epoch', 'generation', 'page', 'count', 'expiresAt', 'ref', 'offset'].includes(key)) ||
            value.version !== 2 || value.uin !== scope.saved.uin || value.epoch !== scope.saved.epoch || value.generation !== generation || value.count !== count ||
            !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || typeof value.ref !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.ref)) p.fail('INVALID_PARAMS', 'Qzone cursor no longer matches this account, session or page size');
        p.integer(value.page, 100000, 2);
        sweepFeeds(); const snapshot = feedPages.get(value.ref);
        if (!snapshot || snapshot.expiresAt !== value.expiresAt || !Number.isInteger(value.offset) || value.offset < 0 || value.offset > snapshot.feeds.length || value.offset === snapshot.feeds.length && !snapshot.hasMore) p.fail('INVALID_PARAMS', 'Qzone feed continuation snapshot is unavailable or exhausted');
        return { page: value.page, snapshot, offset: value.offset };
    }
    async function getList(data, scope, auth) {
        const target = data.targetUin || scope.saved.uin;
        const query = { uin: target, ftype: '0', sort: '0', pos: String(data.pos), num: String(data.num), replynum: '100', callback: '_preloadCallback', code_version: '1', format: 'jsonp', need_private_comment: '1' };
        let value = await call(PATHS.list, query, null, scope, auth);
        // One source-confirmed, read-only alternate route, solely on -10000.
        if (value.code === -10000) value = await call(PATHS.alternateList, { uin: target, ftype: '0', sort: '0', pos: String(data.pos), num: String(data.num), code_version: '1', format: 'json' }, null, scope, auth);
        return p.list(value, data);
    }
    async function getDetail(data, scope, auth) {
        const target = data.targetUin || scope.saved.uin;
        const value = await call(PATHS.detail, { tid: data.tid, uin: target, t1_source: '1', not_trunc_con: '1', need_right: '1', not_adapt_outpic: '1',
            ...(data.pos !== undefined ? { pos: String(data.pos), num: String(data.num) } : {}) }, null, scope, auth);
        p.ack(value);
        if (value.tid !== data.tid || value.uin !== undefined && p.uin(value.uin, 'INVALID_RESPONSE') !== target) p.fail('INVALID_RESPONSE', 'Qzone returned another post or owner');
        return value;
    }
    async function getFeeds(data, scope, auth) {
        const start = data.cursor === undefined ? { page: 1, snapshot: null, offset: 0 } : decodeCursor(data.cursor, scope, data.count);
        if (data.cursor !== undefined && data.pageNum !== 1 && data.pageNum !== start.page) p.fail('INVALID_PARAMS', 'Qzone page number does not match its continuation cursor');
        const target = data.cursor === undefined ? data.pageNum : start.page;
        let snapshot = start.snapshot, offset = start.offset;
        const positionHash = value => crypto.createHash('sha256').update(p.position(value)).digest('hex');
        async function fetchPage(feedState, positions) {
            const params = { uin: scope.saved.uin, scope: '0', view: '1', gid: '', flag: '1', filter: 'all', applist: 'all', refresh: '0', firstGetGroup: '0', mixnocache: '0', scene: '0',
                sidomain: 'qzonestyle.gtimg.cn', count: String(data.count), ...feedState, getAisort: feedState.aisortNextTime,
                callback: '_preloadCallback', format: 'jsonp', useutf8: '1', outputhtmlfeed: '1', usertime: String(Date.now()), rd: String(Math.random()), windowId: String(Math.random()) };
            delete params.aisortNextTime;
            const raw = await call(PATHS.feeds, params, null, scope, auth), result = p.feeds(raw, data.count);
            const feeds = result.feeds.map(feed => ({ ...feed, ...parseFeedContent(feed) }));
            let next = feedState, seen = positions;
            if (result.has_more) {
                next = p.nextState(raw.data.main, feedState); const position = positionHash(next);
                if (positions.includes(position)) p.fail('INVALID_RESPONSE', 'Qzone feed continuation made no progress');
                if (positions.length >= 256) p.fail('INVALID_RESPONSE', 'Qzone feed continuation exceeded its source page budget');
                seen = [...positions, position];
            }
            return saveFeedPage({ feeds, hasMore: result.has_more, state: next, positions: seen });
        }
        for (let page = start.page; page <= target; page++) {
            if (!snapshot) { const initial = p.initialState(); snapshot = await fetchPage(initial, [positionHash(initial)]); offset = 0; }
            else if (offset === snapshot.feeds.length) {
                if (!snapshot.hasMore) return { feeds: [], has_more: false, next_cursor: null };
                let following = snapshot.nextKey && feedPages.get(snapshot.nextKey);
                if (!following) {
                    const fetched = await fetchPage(snapshot.state, snapshot.positions);
                    following = snapshot.nextKey && feedPages.get(snapshot.nextKey) || fetched;
                    snapshot.nextKey = following.key;
                }
                snapshot = following; offset = 0;
            }
            const end = Math.min(snapshot.feeds.length, offset + data.count), feeds = snapshot.feeds.slice(offset, end);
            offset = end;
            const hasMore = offset < snapshot.feeds.length || snapshot.hasMore;
            const result = { feeds, has_more: hasMore, next_cursor: hasMore ? encodeCursor(scope, page + 1, data.count, snapshot, offset) : null };
            if (page === target) return result;
            if (!hasMore) return { feeds: [], has_more: false, next_cursor: null };
        }
        p.fail('INVALID_RESPONSE', 'Qzone feed pagination did not produce a page');
    }
    function images(data) {
        let size = 0;
        return (data.images || []).map(file => {
            const resource = media.resourceInfo(capture.mediaDirectory, file), image = media.readImage(capture.mediaDirectory, resource.path);
            size += image.bytes.length; if (size > media.MAX_IMAGE_BYTES) p.fail('INVALID_PARAMS', 'A Qzone action is limited to 10 MiB of decoded images');
            return image;
        });
    }
    async function upload(image, scope, auth) {
        const self = scope.saved.uin;
        const raw = await call(PATHS.upload, {}, { filename: 'filename', uin: self, skey: auth.skey, zzpaneluin: self, p_uin: self, p_skey: auth.p_skey,
            uploadtype: '1', albumtype: '7', exttype: '0', refer: 'shuoshuo', output_type: 'jsonhtml', charset: 'utf-8', output_charset: 'utf-8',
            upload_hd: '1', hd_width: '2048', hd_height: '10000', hd_quality: '96',
            backUrls: 'http://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image,http://119.147.64.75/cgi-bin/upload/cgi_upload_image&url=https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=' + auth.key,
            base64: '1', jsonhtml_callback: 'callback', picfile: image.bytes.toString('base64'), qzreferrer: 'https://user.qzone.qq.com/' + self + '/main' }, scope, auth);
        p.ack(raw); if (!p.object(raw.data)) p.fail('INVALID_RESPONSE', 'Qzone omitted actual image upload metadata; an upload may have completed');
        const album = p.string(raw.data.albumid, 1024, false, 'INVALID_RESPONSE'), location = p.string(raw.data.lloc, 1024, false, 'INVALID_RESPONSE');
        if (/[,\t\r\n]/.test(album + location)) p.fail('INVALID_RESPONSE', 'Qzone returned invalid upload image identities');
        const type = p.integer(raw.data.type, 0xffffffff, 0, 'INVALID_RESPONSE'), height = p.integer(raw.data.height, 65535, 1, 'INVALID_RESPONSE'), width = p.integer(raw.data.width, 65535, 1, 'INVALID_RESPONSE');
        return { url: p.imageUrl(raw.data.url), richval: ',' + [album, location, location, type, height, width, '', height, width].join(',') };
    }
    async function execute(data, scope) {
        const imageData = images(data); // Read all controlled input before login or writes.
        scope.active(); const auth = await web.authenticate(scope); scope.active();
        const self = scope.saved.uin, target = data.targetUin || self, referrer = 'https://user.qzone.qq.com/' + self;
        if (data.operation === 'qzone.list') return { result: await getList(data, scope, auth) };
        if (data.operation === 'qzone.detail') return { result: p.detail(await getDetail(data, scope, auth), { ...data, targetUin: target }) };
        if (data.operation === 'qzone.feeds') return { result: await getFeeds(data, scope, auth) };
        const uploaded = []; for (const image of imageData) uploaded.push(await upload(image, scope, auth));
        let form, route, result = null;
        if (data.operation === 'qzone.publish') {
            route = PATHS.publish; form = { syn_tweet_verson: '1', paramstr: '1', pic_template: '', richtype: uploaded.length ? '1' : '', richval: uploaded.map(item => item.richval).join('\t'), special_url: '', subrichtype: '',
                con: data.content, feedversion: '1', ver: '1', ugc_right: String(data.ugcRight), to_sign: '0', who: '1', hostuin: self, code_version: '1', format: 'json', qzreferrer: referrer,
                ...(data.targetUins.length ? { allow_uins: data.targetUins.join('|') } : {}) };
        } else if (data.operation === 'qzone.delete') {
            // Pre-read proves the account owns the selected post before dispatch.
            const before = await getDetail({ ...data, targetUin: self }, scope, auth);
            if (p.uin(before.uin, 'INVALID_RESPONSE') !== self) p.fail('INVALID_RESPONSE', 'Qzone deletion lacks ownership proof');
            route = PATHS.delete; form = { hostuin: self, tid: data.tid, t1_source: '1', code_version: '1', format: 'fs', qzreferrer: referrer };
        } else if (data.operation === 'qzone.right') {
            const before = await getDetail({ ...data, targetUin: self }, scope, auth);
            route = PATHS.right; form = { ...p.updatePayload(before, self, data.tid), ugc_right: String(data.ugcRight), ...(data.targetUins.length ? { allow_uins: data.targetUins.join('|') } : {}) };
        } else if (data.operation === 'qzone.like' || data.operation === 'qzone.unlike') {
            route = data.operation === 'qzone.like' ? PATHS.like : PATHS.unlike;
            const key = 'http://user.qzone.qq.com/' + target + '/mood/' + data.tid;
            form = { qzreferrer: referrer, opuin: self, unikey: key, curkey: key, appid: '311', typeid: '0', abstime: String(data.abstime), fid: data.tid, from: '1', active: '0', fupdate: '1', format: 'json' };
        } else if (data.operation === 'qzone.ban') {
            if (data.userId === self) p.fail('INVALID_PARAMS', 'Qzone cannot blacklist the current account');
            route = PATHS.ban; form = { uin: self, act_uin: data.userId, action: data.enable ? '1' : '2', fupdate: '1', qzreferrer: referrer + '/main' };
        } else if (data.commentId !== undefined) {
            route = PATHS.reply; let content = data.content;
            if (data.replyUin !== undefined) content = '@{uin:' + data.replyUin + ',nick:' + data.replyName.trim().replace(/%/g, '%25').replace(/,/g, '%2C').replace(/}/g, '%7D') + ',auto:1} ' + content;
            form = { uin: self, hostUin: target, hostuin: self, topicId: target + '_' + data.tid, commentId: data.commentId, commentUin: data.commentUin, content,
                inCharset: 'utf-8', outCharset: 'utf-8', ref: '', code_version: '1', format: 'fs', qzreferrer: 'https://user.qzone.qq.com/' + target };
        } else {
            route = PATHS.comment; form = { qzreferrer: referrer, inCharset: 'utf-8', outCharset: 'utf-8', hostUin: target, format: 'json', ref: 'feeds', topicId: target + '_' + data.tid + '__1',
                feedsType: '100', private: '0', paramstr: '1', richtype: uploaded.length ? '1' : '', richval: uploaded.map(item => item.url).join('\t'), isSignIn: '', uin: self, content: data.content, plat: 'qzone', source: 'ic', platformid: '52' };
        }
        const raw = p.ack(await call(route, {}, form, scope, auth));
        if (raw.tid !== undefined && !['qzone.publish'].includes(data.operation) && raw.tid !== data.tid) p.fail('INVALID_RESPONSE', 'Qzone acknowledged another post; check delivery before retrying');
        if (data.operation === 'qzone.publish') {
            result = { tid: p.identifier(raw.t1_tid ?? raw.tid, 'INVALID_RESPONSE'), time: p.integer(raw.t1_time ?? raw.now, 0xffffffff, 1, 'INVALID_RESPONSE') };
        } else if (data.operation === 'qzone.comment') {
            const value = data.commentId !== undefined ? raw.data?.id : raw.commentid ?? raw.commentId;
            const id = typeof value === 'number' ? String(p.integer(value, Number.MAX_SAFE_INTEGER, 0, 'INVALID_RESPONSE')) : p.identifier(value, 'INVALID_RESPONSE');
            result = { comment_id: id, ...(data.commentId !== undefined ? { parent_comment_id: data.commentId, parent_comment_uin: Number(data.commentUin) } : {}) };
        } else if (data.operation === 'qzone.right') {
            if (raw.ugc_right !== undefined && p.integer(raw.ugc_right, 128, 1, 'INVALID_RESPONSE') !== data.ugcRight) p.fail('INVALID_RESPONSE', 'Qzone acknowledged different post visibility');
            const after = await getDetail({ ...data, targetUin: self }, scope, auth);
            if (p.integer(after.ugc_right, 128, 1, 'INVALID_RESPONSE') !== data.ugcRight) p.fail('INVALID_RESPONSE', 'Qzone did not confirm the requested visibility by readback');
            // Selected-user visibility has no source-confirmed readback field;
            // explicit fixed-request ACK and visibility readback are recorded.
            result = { ugc_right: data.ugcRight };
        }
        return { result, confirmed: true, confirmation: data.operation === 'qzone.right' ? 'ack_and_visibility_readback' : 'server_ack' };
    }
    async function run(input, context = {}, mutation) {
        const data = p.validate(input, mutation), scope = state(data, context), flags = capabilities();
        if (!flags[REQUIREMENTS[data.operation]] || data.images?.length && !flags.qzoneImages) p.fail('UNSUPPORTED', data.operation === 'qzone.unlike' ? 'Qzone unlike endpoint awaits real protocol verification' : 'This QQ session lacks the required Qzone capability');
        if (mutation && writing) p.fail('BUSY', 'A Qzone mutation still awaits its actual outcome');
        if (pending.size >= 4) p.fail('BUSY', 'Too many Qzone operations await physical completion');
        const token = {}; pending.add(token); if (mutation) writing = true;
        const task = Promise.resolve().then(() => { scope.active(); return execute(data, scope); });
        const release = () => { pending.delete(token); if (mutation) writing = false; }; task.then(release, release);
        const value = await capture.deadline(() => task, scope.context, 60000); scope.active();
        const result = { ...identity(data, scope.saved.uin), ...value };
        if (Buffer.byteLength(JSON.stringify(result)) > 1500000) p.fail('INVALID_RESPONSE', 'Qzone result exceeded the IPC byte budget');
        return result;
    }
    // Pending physical operations retain their slots and mutation lock. Clearing
    // invalidates their session proof and all cursors, without pretending they ended.
    function clear() { generation++; secret = crypto.randomBytes(32); feedPages.clear(); feedBytes = 0; }
    return { capabilities, query: (data, context) => run(data, context, false), action: (data, context) => run(data, context, true), clear };
}
module.exports = { createQzone, REQUIREMENTS, identity, PATHS, QUERIES: p.QUERIES, ACTIONS: p.ACTIONS };
