'use strict';

const { fail, integer } = require('./qzone-protocol.cjs');
const cookieNames = new Set(['uin', 'p_uin', 'skey', 'p_skey', 'pt4_token', 'ptcz', 'pt2gguin', 'ptisp', 'RK']);
const credential = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x3a\x3c-\x7e]+$/.test(value);
const sameAccount = (value, uin) => typeof value === 'string' && /^o?\d{1,15}$/.test(value) && BigInt(value.replace(/^o/, '')) === BigInt(uin);
const hash = value => { let result = 5381; for (const char of value) result = (Math.imul(result, 33) + char.charCodeAt(0)) | 0; return String(result & 0x7fffffff); };
function createWeb(capture, fetchImpl, purpose = 'qzone', { onDiagnostic } = {}) {
    const fixed = { qzone: { domain: 'qzone.qq.com', checkHost: 'ptlogin2.qzone.qq.com', hosts: ['h5.qzone.qq.com', 'user.qzone.qq.com', 'up.qzone.qq.com'] },
        friendDress: { domain: 'vip.qq.com', checkHost: 'ptlogin2.vip.qq.com', hosts: ['zb.vip.qq.com'] },
        modelShow: { domain: 'vip.qq.com', checkHost: 'ptlogin2.vip.qq.com', hosts: ['proxy.vip.qq.com'] },
        anonymousBan: { domain: 'qqweb.qq.com', checkHost: 'ptlogin2.qqweb.qq.com', hosts: ['qqweb.qq.com'] } }[purpose];
    if (!fixed) fail('UNSUPPORTED', 'Unknown fixed QQ Web purpose');
    async function request(target, options, scope, maximum = 2 * 1024 * 1024) {
        scope.active(); const href = String(target);
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(10000, scope.context.expiresAt - Date.now())));
        const signal = scope.context.signal ? AbortSignal.any([scope.context.signal, timeout]) : timeout;
        let response, reader;
        try {
            response = await fetchImpl(href, { ...options, redirect: 'manual', credentials: 'omit', signal }); scope.active();
            if (!response || response.redirected || response.url && response.url !== href || !Number.isInteger(response.status)) fail('INVALID_RESPONSE', 'Qzone returned no fixed-destination HTTP response');
            const declared = response.headers.get('content-length');
            if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) fail('INVALID_RESPONSE', 'Qzone response exceeded its byte budget');
            const chunks = []; let size = 0;
            if (response.body) {
                reader = response.body.getReader();
                for (;;) {
                    const { value, done } = await reader.read(); scope.active(); if (done) break;
                    size += value.byteLength; if (size > maximum) fail('INVALID_RESPONSE', 'Qzone response exceeded its byte budget'); chunks.push(Buffer.from(value));
                }
            }
            scope.active(); const bytes = Buffer.concat(chunks);
            let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('INVALID_RESPONSE', 'Qzone returned invalid UTF-8'); }
            return { status: response.status, headers: response.headers, text };
        } catch (error) {
            Promise.resolve(reader?.cancel()).catch(() => {}); if (!reader) Promise.resolve(response?.body?.cancel?.()).catch(() => {});
            scope.active(); if (['INVALID_RESPONSE', 'INVALID_PARAMS', 'SESSION_CHANGED', 'EXPIRED', 'AUTH_FAILED', 'UNSUPPORTED'].includes(error.code)) throw error;
            fail(signal.aborted ? 'TIMEOUT' : 'QUERY_FAILED', 'Qzone network operation failed; no write retry was attempted');
        } finally { reader?.releaseLock(); }
    }
    async function authenticate(scope) {
        const { uin } = scope.saved;
        let current = new URL('https://ssl.ptlogin2.qq.com/jump'), lastStatus;
        const phase = () => current.hostname === 'ssl.ptlogin2.qq.com' ? 'initial-jump' : current.hostname === fixed.checkHost ? 'check-sign' : 'business-destination';
        const loginFail = (code, message, status = lastStatus) => fail(code, message + ' (phase=' + phase() + ', status=' + (Number.isInteger(status) ? status : 'unavailable') + ')');
        try {
        scope.active(); const ticket = await capture.invoke('ticket', 'forceFetchClientKey', ['']); scope.active();
        if (ticket?.result !== 0 || !credential(ticket.clientKey) || typeof ticket.keyIndex !== 'string') loginFail('AUTH_FAILED', 'QQ supplied no Qzone client ticket');
        integer(ticket.keyIndex, 0xffffffff, 0, 'INVALID_RESPONSE');
        // Each purpose has one exact existing landing page. VIP has no
        // account-specific Qzone infocenter route; its cookie domain stays VIP.
        const destination = purpose === 'qzone' ? 'https://user.qzone.qq.com/' + uin + '/infocenter' : purpose === 'anonymousBan' ? 'https://qqweb.qq.com/' : 'https://vip.qq.com/';
        current.search = new URLSearchParams({ ptlang: '1033', clientuin: uin, clientkey: ticket.clientKey, u1: destination, keyindex: ticket.keyIndex }).toString();
        const jar = new Map(), visited = new Set();
        const select = target => {
            const output = {}, items = [...jar.values()].filter(item => item.expires > Date.now() && (item.hostOnly ? target.hostname === item.domain : target.hostname === item.domain || target.hostname.endsWith('.' + item.domain)) &&
                (target.pathname === item.path || target.pathname.startsWith(item.path) && (item.path.endsWith('/') || target.pathname[item.path.length] === '/')));
            items.sort((a, b) => a.path.length - b.path.length || a.domain.length - b.domain.length);
            for (const item of items) output[item.name] = item.value;
            return output;
        };
        const header = values => Object.entries(values).map(([key, value]) => key + '=' + value).join('; ');
        const diagnose = response => {
            if (typeof onDiagnostic !== 'function') return;
            const cookieDomains = { parent: 0, purpose: 0, login: 0, business: 0 };
            for (const cookie of jar.values()) {
                const kind = cookie.domain === 'qq.com' ? 'parent' : cookie.domain === fixed.domain ? 'purpose' : fixed.hosts.includes(cookie.domain) ? 'business' : 'login';
                cookieDomains[kind]++;
            }
            // Diagnostics deliberately contain no account, URL, path, query,
            // cookie name/value, or native ticket material.
            try { onDiagnostic(Object.freeze({ purpose, phase: phase(), status: response.status, cookieDomains: Object.freeze(cookieDomains) })); } catch {}
        };
        for (let step = 0; ; step++) {
            if (visited.has(current.href)) loginFail('INVALID_RESPONSE', 'Qzone login redirected in a loop'); visited.add(current.href);
            let response;
            try { response = await request(current.href, { headers: { Cookie: header(select(current)), 'User-Agent': 'Freshwater/0.2' } }, scope, 262144); }
            catch (error) { loginFail(error.code || 'QUERY_FAILED', 'Qzone login request failed', null); }
            lastStatus = response.status;
            const cookies = response.headers.getSetCookie?.() || (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
            if (cookies.length > 100) fail('INVALID_RESPONSE', 'Qzone login returned too many cookies');
            for (const raw of cookies) {
                if (raw.length > 8192 || /[\r\n]/.test(raw)) fail('INVALID_RESPONSE', 'Invalid Qzone login cookie');
                const [pair, ...attributes] = raw.split(';'), equal = pair.indexOf('='); if (equal < 1) continue;
                const name = pair.slice(0, equal).trim(), value = pair.slice(equal + 1).trim(); if (!cookieNames.has(name)) continue;
                if (value && !credential(value)) fail('INVALID_RESPONSE', 'Invalid Qzone cookie value');
                let domain = current.hostname, hostOnly = true, path = current.pathname.slice(0, current.pathname.lastIndexOf('/')) || '/', expires = Infinity, maxAge;
                for (const attribute of attributes) {
                    const index = attribute.indexOf('='), key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase(), text = index < 0 ? '' : attribute.slice(index + 1).trim();
                    if (key === 'domain') { domain = text.replace(/^\./, '').toLowerCase(); hostOnly = false; }
                    if (key === 'path' && text.startsWith('/')) path = text;
                    if (key === 'expires' && Number.isFinite(Date.parse(text))) expires = Date.parse(text);
                    if (key === 'max-age') { if (!/^-?\d{1,10}$/.test(text)) fail('INVALID_RESPONSE', 'Invalid Qzone cookie expiry'); maxAge = Number(text); }
                }
                if (!(domain === 'qq.com' || domain.endsWith('.qq.com')) || !(current.hostname === domain || current.hostname.endsWith('.' + domain))) continue;
                if (maxAge !== undefined) expires = Date.now() + maxAge * 1000;
                const key = [name, domain, path].join('\0');
                if (!value || expires <= Date.now()) jar.delete(key); else jar.set(key, { name, value, domain, hostOnly, path, expires });
                if (jar.size > 100) fail('INVALID_RESPONSE', 'Qzone cookie budget exceeded');
            }
            diagnose(response);
            if (![301, 302, 303, 307, 308].includes(response.status)) {
                // QQ Web has no public root page (404). For its anonymous-ban
                // purpose the exact root may end the login chain, but the same
                // account and domain cookie checks below are still mandatory.
                const reached = response.status === 200 || purpose === 'anonymousBan' && response.status === 404;
                if (!reached || current.href !== destination) loginFail('AUTH_FAILED', 'Qzone login did not reach its fixed destination'); break;
            }
            const location = response.headers.get('location'); if (step >= 4 || !location || location.length > 8192) loginFail('INVALID_RESPONSE', 'Qzone login redirect limit exceeded');
            let next; try { next = new URL(location, current); } catch { loginFail('INVALID_RESPONSE', 'Invalid Qzone login redirect'); }
            const check = next.hostname === fixed.checkHost && next.pathname === '/check_sig' && ['ssl.ptlogin2.qq.com', fixed.checkHost].includes(current.hostname);
            if (next.protocol !== 'https:' || next.username || next.password || next.port || !(next.href === destination || check)) loginFail('INVALID_RESPONSE', 'Qzone login left its fixed destination');
            if (check && next.searchParams.has('uin') && (next.searchParams.getAll('uin').length !== 1 || !sameAccount(next.searchParams.get('uin'), uin))) loginFail('AUTH_FAILED', 'Qzone login redirect names another account');
            current = next;
        }
        const values = select(new URL('https://' + fixed.domain + '/'));
        if (![values.uin, values.p_uin].some(value => sameAccount(value, uin)) || [values.uin, values.p_uin].some(value => value !== undefined && !sameAccount(value, uin)) || !credential(values.skey)) loginFail('AUTH_FAILED', 'Qzone credentials do not match the current account');
        let fallback;
        if (!values.p_skey && capture.hasMethods('tipOff', ['getPskey'])) {
            const result = await capture.invoke('tipOff', 'getPskey', [[fixed.domain], true]); scope.active();
            if (result?.result !== 0 || !(result.domainPskeyMap instanceof Map)) loginFail('AUTH_FAILED', 'QQ supplied no domain-bound Qzone key');
            fallback = result.domainPskeyMap.get(fixed.domain); if (!credential(fallback)) loginFail('AUTH_FAILED', 'QQ supplied no valid QQ domain key');
        }
        const p_skey = values.p_skey || fallback;
        return { key: hash(p_skey || values.skey), skey: values.skey, p_skey: p_skey || '',
            domainCookie() { return header({ ...values, ...(fallback ? { p_skey: fallback } : {}) }); }, cookie(target) {
            const url = new URL(target); if (!fixed.hosts.includes(url.hostname) || url.protocol !== 'https:' || url.port || url.username || url.password) fail('INVALID_PARAMS', 'QQ cookies are limited to their fixed business hosts');
            const selected = select(url); if (fallback) selected.p_skey = fallback;
            if (![selected.uin, selected.p_uin].some(value => sameAccount(value, uin)) || [selected.uin, selected.p_uin].some(value => value !== undefined && !sameAccount(value, uin)) || selected.skey !== values.skey || p_skey && selected.p_skey !== p_skey) loginFail('AUTH_FAILED', 'Qzone cookies do not authorize the fixed business destination');
            return header(selected);
        } };
        } catch (error) {
            if (/\(phase=(?:initial-jump|check-sign|business-destination), status=(?:\d{3}|unavailable)\)$/.test(error?.message || '')) throw error;
            loginFail(error?.code || 'AUTH_FAILED', 'Qzone login failed');
        }
    }
    return { request, authenticate };
}
module.exports = { createWeb };
