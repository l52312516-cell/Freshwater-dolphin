'use strict';

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function uint(value, maximum = 0xffffffff, positive = false) {
    return ['string', 'number'].includes(typeof value) && /^(0|[1-9]\d{0,15})$/.test(String(value)) &&
        Number.isSafeInteger(Number(value)) && Number(value) <= maximum && (!positive || Number(value) > 0);
}
function chinaDay(time = Date.now()) {
    if (!Number.isSafeInteger(time)) fail('INVALID_PARAMS', 'Invalid sign-in calendar time');
    return new Date(time + 8 * 3600000).toISOString().slice(0, 10).replaceAll('-', '');
}
// A page is useful only if its offset and total prove that no members were
// silently omitted. Authentication and the fixed HTTPS destination stay private
// inside group-web; this helper sees only decoded response JSON.
async function collectSignedList(getPage, groupId, dayYmd) {
    let offset = 0, expectedTotal, bytes = 2;
    const members = [], accounts = new Set(), ranks = new Set();
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
        const value = await getPage({ dayYmd, offset, limit: 100 });
        if (!object(value) || value.retCode !== 0 || value.funcCode !== 0) fail('KERNEL_ERROR', 'QQ rejected the group sign-in query');
        const response = value.response;
        // The target official endpoint emits the literal "Succ", including
        // its explicit empty page. Keep only observed/defined success values;
        // arbitrary symbolic codes must not become successful empty lists.
        if (!object(response) || response.ret !== undefined && (!object(response.ret) || ![0, '0', 'Succ'].includes(response.ret.code))) fail('KERNEL_ERROR', 'QQ supplied no successful sign-in business result');
        if (!Array.isArray(response.page) || response.page.length !== 1 || !object(response.page[0])) fail('INVALID_RESPONSE', 'QQ omitted an explicit sign-in page');
        const page = response.page[0];
        if (!uint(page.offset, 10000) || !uint(page.total, 10000)) fail('INVALID_RESPONSE', 'QQ omitted exact sign-in pagination metadata');
        const total = Number(page.total), infos = page.infos === undefined && total === 0 ? [] : page.infos;
        if (!Array.isArray(infos) || infos.length > 100 || expectedTotal !== undefined && total !== expectedTotal || members.length + infos.length > total) fail('INVALID_RESPONSE', 'QQ sign-in pagination changed or exceeded its bounds');
        expectedTotal = total;
        const end = offset + infos.length;
        if (![offset, end].includes(Number(page.offset)) || end > total || end < total && infos.length === 0) fail('INVALID_RESPONSE', 'QQ sign-in page cannot establish contiguous progress');
        for (const info of infos) {
            if (!object(info) || !uint(info.uid, 0xffffffff, true) || !uint(info.signedTimeStamp, Number.MAX_SAFE_INTEGER) ||
                !uint(info.signInRank, 19999, true) || Number(info.signInRank) % 2 !== 1 || typeof info.uidGroupNick !== 'string' ||
                Buffer.byteLength(info.uidGroupNick) > 1024 || info.uidGroupNick.includes('\0') || Buffer.from(info.uidGroupNick).toString('utf8') !== info.uidGroupNick) fail('INVALID_RESPONSE', 'QQ returned an invalid sign-in member');
            const uin = String(info.uid), rank = (Number(info.signInRank) + 1) / 2;
            if (accounts.has(uin) || ranks.has(rank) || rank > total) fail('INVALID_RESPONSE', 'QQ repeated a sign-in member or supplied an inconsistent rank');
            accounts.add(uin); ranks.add(rank);
            const member = { uin, nickname: info.uidGroupNick, time: Number(info.signedTimeStamp), rank };
            bytes += Buffer.byteLength(JSON.stringify(member)) + 1;
            if (bytes > 1024 * 1024) fail('INVALID_RESPONSE', 'QQ sign-in list exceeded its JSON byte budget');
            members.push(member);
        }
        if (end === total) return { groupId, dayYmd, members, complete: true };
        offset = end;
    }
    fail('INVALID_RESPONSE', 'QQ sign-in list exceeded its page budget');
}
module.exports = { chinaDay, collectSignedList };
