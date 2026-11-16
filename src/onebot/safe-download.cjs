'use strict';

const http = require('node:http'), https = require('node:https'), dns = require('node:dns').promises, net = require('node:net');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function publicAddress(address) {
    if (net.isIP(address) === 4) {
        const [a, b, c] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
            a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
            a === 203 && b === 0 && c === 113);
    }
    if (net.isIP(address) !== 6) return false;
    // Restrict IPv6 to globally routed unicast 2000::/3, excluding protocol
    // transition, benchmarking and documentation ranges. Mapped/NAT64/local
    // addresses are therefore excluded without textual prefix ambiguities.
    const host = new URL('http://[' + address + ']').hostname.slice(1, -1).toLowerCase();
    const first = parseInt(host.split(':')[0], 16);
    const second = host.split(':')[1] || '0';
    return first >= 0x2000 && first <= 0x3fff && !(first === 0x2001 && (parseInt(second, 16) < 0x200 || second === 'db8')) && !/^2002:/.test(host) && !/^3fff:/.test(host);
}
function parseUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 16384 || /[\x00-\x20\x7f]/.test(value)) fail('INVALID_PARAMS', 'Invalid download URL');
    let url; try { url = new URL(value); } catch { fail('INVALID_PARAMS', 'Invalid download URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.port && !['80', '443'].includes(url.port)) fail('INVALID_PARAMS', 'Download requires a public HTTP(S) URL on a standard port');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !publicAddress(host) || !net.isIP(host) && (!host.includes('.') || host.endsWith('.') || /(?:^|\.)(localhost|local|internal|home|lan|test|invalid|onion)$/.test(host))) fail('INVALID_PARAMS', 'Download target is not a public address');
    return url;
}
function headers(value) {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 8) fail('INVALID_PARAMS', 'Download headers must be a bounded object');
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        const lower = key.toLowerCase();
        if (!['accept', 'accept-language', 'user-agent', 'referer'].includes(lower) || Object.hasOwn(result, lower) || typeof entry !== 'string' || Buffer.byteLength(entry) > 1024 || /[\x00-\x1f\x7f]/.test(entry)) fail('INVALID_PARAMS', 'Unsupported download header');
        result[lower] = entry;
    }
    return result;
}
async function openDownload(value, { signal, maximum = 50 * 1024 * 1024, requestHeaders, lookup = dns.lookup, request = null } = {}) {
    const url = parseUrl(value), supplied = headers(requestHeaders), host = url.hostname.replace(/^\[|\]$/g, '');
    if (signal?.aborted) fail('EXPIRED', 'Download cancelled');
    let addresses;
    try { addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true, verbatim: true }); }
    catch { fail('QUERY_FAILED', 'Download host could not be resolved'); }
    if (signal?.aborted) fail('EXPIRED', 'Download cancelled');
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(row => !publicAddress(row.address) || row.family !== net.isIP(row.address))) fail('INVALID_PARAMS', 'Download DNS includes an address outside the public network');
    const pinned = addresses.find(row => row.family === 4) || addresses[0];
    const transport = request || (url.protocol === 'https:' ? https.request : http.request);
    return new Promise((resolve, reject) => {
        let response;
        const req = transport(url, { method: 'GET', headers: { ...supplied, 'accept-encoding': 'identity' }, agent: false, signal,
            // Pin the checked DNS result for the actual connection. No second
            // uncontrolled lookup and no proxy/connection pool are involved.
            family: pinned.family, lookup: (_name, options, callback) => {
                if (typeof options === 'function') { callback = options; options = {}; }
                if (options?.all) callback(null, [{ ...pinned }]); else callback(null, pinned.address, pinned.family);
            }, servername: net.isIP(host) ? undefined : host }, incoming => {
            response = incoming;
            const declared = incoming.headers['content-length'];
            if (incoming.statusCode !== 200 || incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity' ||
                declared !== undefined && (typeof declared !== 'string' || !/^\d+$/.test(declared) || BigInt(declared) > BigInt(maximum))) {
                incoming.destroy(); reject(Object.assign(new Error('Download response was not an accepted bounded file'), { code: 'QUERY_FAILED' })); return;
            }
            incoming.setTimeout?.(10000, () => incoming.destroy(Object.assign(new Error('Download source stalled'), { code: 'TIMEOUT' })));
            resolve({ iterable: incoming, size: declared === undefined ? null : Number(declared), abort: () => { incoming.destroy(); req.destroy(); },
                filename: url.pathname.split('/').pop() || 'download' });
        });
        req.setTimeout?.(10000, () => req.destroy(Object.assign(new Error('Download source timed out'), { code: 'TIMEOUT' })));
        req.once('error', () => { response?.destroy(); reject(Object.assign(new Error('Download network operation failed'), { code: signal?.aborted ? 'EXPIRED' : 'QUERY_FAILED' })); });
        req.end();
    });
}
module.exports = { parseUrl, publicAddress, headers, openDownload };
