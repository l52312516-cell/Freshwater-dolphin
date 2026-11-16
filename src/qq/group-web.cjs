'use strict';

const { chinaDay, collectSignedList } = require('./query2-signin.cjs');

// Fixed official QQ Web endpoints. Authentication stays inside this account's
// bridge and never enters RPC results, URLs in logs or persistent storage.
function failure(code, message) { return Object.assign(new Error(message), { code }); }
const cookieNames = new Set(['uin', 'p_uin', 'skey', 'p_skey', 'pt4_token', 'ptcz', 'pt2gguin', 'ptisp', 'RK']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function noticeShape(result, groupId) {
    const values = {};
    for (const key of ['ec', 'srv_code', 'read_only', 'role', 'sta', 'gln']) {
        const value = result[key];
        values[key] = value === undefined ? 'absent' : Number.isSafeInteger(value) && value >= -255 && value <= 255 ? value : 'invalid';
    }
    values.next = !Object.hasOwn(result, 'next_index') ? 'absent' : result.next_index === null ? 'null' : 'present';
    values.groupMatches = String(result.group?.group_id) === groupId;
    values.collections = ['feeds', 'inst'].filter(key => Object.hasOwn(result, key));
    return JSON.stringify(values);
}

// The official notice CGI HTML-escapes its JSON text (a real published ASCII
// space is returned as &nbsp;). Decode once as plain text; never parse markup
// or recursively decode a literal entity that the author intentionally sent.
function noticeText(value) {
    const named = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
    return value.replace(/&(?:nbsp|amp|lt|gt|quot);|&#(?:[0-9]{1,7}|x[0-9a-fA-F]{1,6});/g, entity => {
        if (Object.hasOwn(named, entity)) return named[entity];
        const n = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : entity;
    });
}
const hash = value => { let result = 5381; for (const char of value) result = (Math.imul(result, 33) + char.charCodeAt(0)) | 0; return String(result & 0x7fffffff); };
function credential(value) { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x3a\x3c-\x7e]+$/.test(value); }
function sameAccount(value, uin) { return typeof value === 'string' && /^o?\d{1,15}$/.test(value) && BigInt(value.replace(/^o/, '')) === BigInt(uin); }
function createGroupWeb(capture, { fetchImpl = globalThis.fetch } = {}) {
    function supported() { return typeof fetchImpl === 'function' && capture.hasMethods('ticket', ['forceFetchClientKey']); }
    function active(context, state) {
        capture.ensureReady();
        if (capture.epoch !== state.epoch || capture.self?.uin !== state.uin || capture.self?.uid !== state.uid) throw failure('SESSION_CHANGED', 'QQ changed during group Web operation');
        if (context.signal?.aborted || Date.now() >= (context.expiresAt ?? Infinity)) throw failure('EXPIRED', 'Group Web operation expired; its result may be unknown');
    }
    async function request(url, options, context, state) {
        active(context, state);
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(10000, (context.expiresAt ?? Date.now() + 10000) - Date.now())));
        const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
        let response;
        try {
            response = await fetchImpl(url, { ...options, redirect: 'manual', signal });
            const parts = []; let size = 0;
            if (response.body) for await (const chunk of response.body) {
                size += chunk.length;
                if (size > 2 * 1024 * 1024) { await response.body.cancel?.().catch(() => {}); throw failure('INVALID_RESPONSE', 'QQ Web response exceeded its size limit'); }
                parts.push(Buffer.from(chunk));
            }
            active(context, state);
            return { status: response.status, headers: response.headers, bytes: Buffer.concat(parts) };
        } catch (error) {
            active(context, state);
            if (['INVALID_RESPONSE', 'SESSION_CHANGED', 'EXPIRED'].includes(error.code)) throw error;
            throw failure(signal.aborted ? 'TIMEOUT' : 'QUERY_FAILED', 'QQ Web request failed; no retry was attempted');
        }
    }
    async function authenticate(domain, context, state) {
        if (!supported()) throw failure('UNSUPPORTED', 'QQ has no verified Web ticket service');
        const ticket = await capture.invoke('ticket', 'forceFetchClientKey', ['']); active(context, state);
        if (ticket?.result !== 0 || !credential(ticket.clientKey) || typeof ticket.keyIndex !== 'string' ||
            !/^(0|[1-9]\d{0,9})$/.test(ticket.keyIndex) || BigInt(ticket.keyIndex) > 0xffffffffn) throw failure('INVALID_RESPONSE', 'QQ did not provide a valid client ticket');
        let current = new URL('https://ssl.ptlogin2.qq.com/jump');
        current.search = new URLSearchParams({ ptlang: '1033', clientuin: state.uin, clientkey: ticket.clientKey,
            u1: 'https://qun.qq.com/', keyindex: ticket.keyIndex }).toString();
        const jar = new Map(), visited = new Set();
        const select = target => {
            const output = {};
            const items = [...jar.values()].filter(item => item.expires > Date.now() &&
                (item.hostOnly ? target.hostname === item.domain : target.hostname === item.domain || target.hostname.endsWith('.' + item.domain)) &&
                (target.pathname === item.path || target.pathname.startsWith(item.path) && (item.path.endsWith('/') || target.pathname[item.path.length] === '/')));
            items.sort((a, b) => a.path.length - b.path.length || a.domain.length - b.domain.length);
            for (const item of items) output[item.name] = item.value;
            return output;
        };
        const header = values => Object.entries(values).map(([name, value]) => name + '=' + value).join('; ');
        for (let step = 0; ; step++) {
            if (visited.has(current.href)) throw failure('INVALID_RESPONSE', 'QQ authentication redirect loop');
            visited.add(current.href);
            const response = await request(current, { headers: { Cookie: header(select(current)), 'User-Agent': 'Freshwater/0.2' } }, context, state);
            const cookies = response.headers.getSetCookie?.() || (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
            if (cookies.length > 100) throw failure('INVALID_RESPONSE', 'QQ returned too many login cookies');
            for (const raw of cookies) {
                if (raw.length > 8192 || /[\r\n]/.test(raw)) throw failure('INVALID_RESPONSE', 'Invalid QQ cookie header');
                const [pair, ...attributes] = raw.split(';'), equal = pair.indexOf('=');
                if (equal < 1) continue;
                const name = pair.slice(0, equal).trim(), value = pair.slice(equal + 1).trim();
                if (!cookieNames.has(name)) continue;
                if (value && !credential(value)) throw failure('INVALID_RESPONSE', 'Invalid QQ cookie value');
                let host = current.hostname, hostOnly = true, path = current.pathname.slice(0, current.pathname.lastIndexOf('/')) || '/', expires = Infinity, maxAge;
                for (const part of attributes) {
                    const index = part.indexOf('='), key = (index < 0 ? part : part.slice(0, index)).trim().toLowerCase(), text = index < 0 ? '' : part.slice(index + 1).trim();
                    if (key === 'domain') { host = text.replace(/^\./, '').toLowerCase(); hostOnly = false; }
                    if (key === 'path' && text.startsWith('/')) path = text;
                    if (key === 'expires' && Number.isFinite(Date.parse(text))) expires = Date.parse(text);
                    if (key === 'max-age') { if (!/^-?\d{1,10}$/.test(text)) throw failure('INVALID_RESPONSE', 'Invalid QQ cookie expiry'); maxAge = Number(text); }
                }
                if (!(host === 'qq.com' || host.endsWith('.qq.com')) || !(current.hostname === host || current.hostname.endsWith('.' + host))) continue;
                if (maxAge !== undefined) expires = Date.now() + maxAge * 1000;
                const id = [name, host, path].join('\0');
                if (!value || expires <= Date.now()) jar.delete(id); else jar.set(id, { name, value, domain: host, hostOnly, path, expires });
                if (jar.size > 100) throw failure('INVALID_RESPONSE', 'QQ login cookie limit reached');
            }
            if (![301, 302, 303, 307, 308].includes(response.status)) {
                if (response.status !== 200 || current.hostname !== 'qun.qq.com') throw failure('AUTH_FAILED', 'QQ Web login did not reach its fixed destination');
                break;
            }
            const location = response.headers.get('location');
            if (step >= 3 || !location || location.length > 8192) throw failure('INVALID_RESPONSE', 'QQ authentication redirect limit reached');
            const next = new URL(location, current);
            const check = next.hostname === 'ptlogin2.qun.qq.com' && next.pathname === '/check_sig' && ['ssl.ptlogin2.qq.com', 'ptlogin2.qun.qq.com'].includes(current.hostname);
            if (next.protocol !== 'https:' || next.username || next.password || next.port && next.port !== '443' ||
                !(['ssl.ptlogin2.qq.com', 'qun.qq.com'].includes(next.hostname) || check)) throw failure('INVALID_RESPONSE', 'QQ Web login left its fixed destination');
            if (check && next.searchParams.has('uin') && (next.searchParams.getAll('uin').length !== 1 || !sameAccount(next.searchParams.get('uin'), state.uin))) throw failure('INVALID_RESPONSE', 'QQ login redirect belongs to another account');
            current = next;
        }
        const values = select(new URL('https://' + domain + '/'));
        if (![values.uin, values.p_uin].some(value => sameAccount(value, state.uin)) ||
            [values.uin, values.p_uin].some(value => value !== undefined && !sameAccount(value, state.uin)) || !credential(values.skey)) throw failure('AUTH_FAILED', 'QQ Web credentials do not match the active account');
        if (!values.p_skey && capture.hasMethods('tipOff', ['getPskey'])) {
            const result = await capture.invoke('tipOff', 'getPskey', [['qun.qq.com'], true]); active(context, state);
            if (result?.result !== 0 || !(result.domainPskeyMap instanceof Map)) throw failure('AUTH_FAILED', 'QQ supplied no verified domain key');
            const key = result.domainPskeyMap.get('qun.qq.com');
            if (key) { if (!credential(key)) throw failure('INVALID_RESPONSE', 'Invalid QQ domain key'); values.p_skey = key; }
        }
        return { cookie: header(values), bodyKey: hash(values.skey), urlKey: hash(values.p_skey || values.skey) };
    }
    async function execute(operation, data, context, state) {
        const query = ['group.noticeList', 'group.essenceList', 'group.honor'].includes(operation);
        const domain = operation.startsWith('group.notice') ? 'web.qun.qq.com' : 'qun.qq.com';
        const auth = await authenticate(domain, context, state);
        if (operation === 'group.signedList') {
            const dayYmd = chinaDay();
            return collectSignedList(async page => {
                const response = await request('https://qun.qq.com/v2/signin/trpc/GetDaySignedList?g_tk=' + auth.urlKey,
                    { method: 'POST', headers: { Cookie: auth.cookie, 'Content-Type': 'application/json', Referer: 'https://qun.qq.com/' },
                        body: JSON.stringify({ ...page, uid: state.uin, groupId: data.groupId }) }, context, state);
                if (response.status !== 200) throw failure('QUERY_FAILED', 'QQ sign-in request failed; redirects are not followed');
                try {
                    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes), (_key, value) => {
                        if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error();
                        return value;
                    });
                } catch { throw failure('INVALID_RESPONSE', 'QQ returned no exact sign-in JSON response'); }
            }, data.groupId, dayYmd);
        }
        let url, form;
        if (operation === 'group.noticeList') {
            url = 'https://web.qun.qq.com/cgi-bin/announce/list_announce';
            form = { qid: data.groupId, ft: '23', s: data.page ? String(data.page) : '-1', n: String(data.count ?? 20), i: '1', ni: '1' };
        } else if (operation === 'group.noticePublish') {
            url = 'https://web.qun.qq.com/cgi-bin/announce/add_qun_notice';
            form = { qid: data.groupId, text: data.content, pinned: '0', type: '1', settings: JSON.stringify({ is_show_edit_card: 1, tip_window_type: 1, confirm_required: 0 }) };
        } else if (operation === 'group.noticeDelete') { url = 'https://web.qun.qq.com/cgi-bin/announce/del_feed'; form = { qid: data.groupId, fid: data.noticeId }; }
        else if (operation === 'group.essenceList') url = 'https://qun.qq.com/cgi-bin/group_digest/digest_list?' + new URLSearchParams({ group_code: data.groupId, page_start: String(data.start ?? 0), page_limit: String(data.count ?? 50), bkn: auth.urlKey });
        else if (operation === 'group.honor') {
            const endpoint = data.type === 'talkative' ? 'honor_talkative' : data.type === 'emotion' ? 'honor_emotion' : 'honor_continuous';
            url = 'https://qun.qq.com/cgi-bin/qunapp/' + endpoint + '?' + new URLSearchParams({ gc: data.groupId, num: '3000', bkn: auth.bodyKey,
                ...(['performer', 'legend'].includes(data.type) ? { continuous_type: data.type === 'performer' ? '2' : '3' } : {}) });
        } else throw failure('UNSUPPORTED', 'Unknown fixed group Web operation');
        if (form) url += '?bkn=' + auth.urlKey;
        const response = await request(url, { method: form ? 'POST' : 'GET', headers: { Cookie: auth.cookie,
            'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://web.qun.qq.com/mannounce/index.html?_wv=1031&_bid=148' },
        ...(form ? { body: new URLSearchParams({ ...form, bkn: auth.bodyKey }).toString() } : {}) }, context, state);
        if (response.status !== 200) throw failure('QUERY_FAILED', 'QQ group Web request failed; redirects are not followed');
        let result;
        try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes), (_key, value) => {
            if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error(); return value;
        }); } catch { throw failure('INVALID_RESPONSE', 'QQ returned no valid group JSON result'); }
        if (!object(result) || result[form ? 'ec' : 'retcode'] !== 0) throw failure('KERNEL_ERROR', 'QQ rejected the group Web operation');
        if (!query) return { ...data, confirmed: true, confirmation: 'server_ack' };
        if (operation === 'group.noticeList') {
            const convert = value => { const items = Array.isArray(value) ? value : object(value) ? Object.values(value) : null;
                if (!items || items.length > 1000 || items.some(item => !object(item) || typeof item.fid !== 'string' || !item.fid || !object(item.msg) || typeof item.msg.text !== 'string')) throw failure('INVALID_RESPONSE', 'QQ omitted a valid notice collection');
                return items.map(item => ({ ...item, msg: { ...item.msg, text: noticeText(item.msg.text) } })); };
            if (!Object.hasOwn(result, 'feeds') && !Object.hasOwn(result, 'inst')) {
                if (!(result.srv_code === 0 && result.read_only === 0 && [1, 3].includes(result.role) && result.sta === 1 && result.gln === 0 &&
                    Object.hasOwn(result, 'next_index') && result.next_index === null && String(result.group?.group_id) === data.groupId)) throw failure('INVALID_RESPONSE', 'QQ omitted notice page metadata [' + noticeShape(result, data.groupId) + ']');
                return { groupId: data.groupId, notices: [], hasMore: false };
            }
            const notices = [...(Object.hasOwn(result, 'feeds') ? convert(result.feeds) : []), ...(Object.hasOwn(result, 'inst') ? convert(result.inst) : [])];
            return { groupId: data.groupId, notices, ...(Object.hasOwn(result, 'next_index') ? { hasMore: result.next_index !== null, nextIndex: result.next_index } : {}) };
        }
        if (operation === 'group.essenceList') {
            if (!object(result.data) || typeof result.data.is_end !== 'boolean' || !Array.isArray(result.data.msg_list) && !(result.data.is_end && result.data.msg_list == null)) throw failure('INVALID_RESPONSE', 'QQ omitted explicit essence page metadata');
            const messages = result.data.msg_list || [];
            if (messages.length > (data.count ?? 50) || messages.some(item => !object(item) || String(item.group_code) !== data.groupId ||
                !Number.isInteger(item.msg_seq) || item.msg_seq < 1 || item.msg_seq > 0xffffffff || !Number.isInteger(item.msg_random) || item.msg_random < 0 || item.msg_random > 0xffffffff || !Array.isArray(item.msg_content))) throw failure('INVALID_RESPONSE', 'QQ returned an invalid essence message identity');
            return { groupId: data.groupId, messages, isEnd: result.data.is_end };
        }
        const name = data.type === 'talkative' ? 'talkative_list' : data.type === 'emotion' ? 'emotion_list' : 'continuous_list';
        const entries = result.data?.[name];
        if (!Array.isArray(entries) || entries.length > 3000) throw failure('INVALID_RESPONSE', 'QQ omitted the selected honor collection');
        const members = entries.map(item => {
            if (!object(item) || !/^[1-9]\d{0,9}$/.test(String(item.uin)) || BigInt(item.uin) > 0xffffffffn) throw failure('INVALID_RESPONSE', 'QQ honor item has no account identity');
            const value = { uin: String(item.uin) };
            for (const [from, to] of [['nick', 'nickname'], ['avatar', 'avatar']]) if (item[from] !== undefined) {
                if (typeof item[from] !== 'string' || Buffer.byteLength(item[from]) > 16384) throw failure('INVALID_RESPONSE', 'Invalid QQ honor profile'); value[to] = item[from];
            }
            for (const field of ['day_count', 'day_count_history', 'day_count_max']) if (item[field] !== undefined) {
                if (!Number.isSafeInteger(item[field]) || item[field] < 0 || item[field] > 0xffffffff) throw failure('INVALID_RESPONSE', 'Invalid QQ honor counter'); value[field] = item[field];
            }
            return value;
        });
        return { groupId: data.groupId, type: data.type, members };
    }
    return { supported, execute };
}
module.exports = { createGroupWeb };
