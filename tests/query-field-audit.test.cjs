'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runQueryExtension } = require('../src/onebot/query-extensions.cjs');
const { runSocial, convertSocialEvent } = require('../src/onebot/social-actions.cjs');
const { Capture } = require('../src/qq/capture.cjs');
const { createSocial } = require('../src/qq/social.cjs');

function queryFixture() {
    const state = { self: { uin: '12345', uid: 'u_self' }, epoch: 'one', capabilities: { groupFiles: true, groupFileInfo: true } };
    const source = { fileId: 'exact-file', fileSize: '18446744073709551614', busId: 102, fileName: 'document.txt',
        uploadedSize: '18446744073709551614', uploadTime: 0, deadTime: 0, modifyTime: 7, downloadTimes: 2,
        uploaderUin: '22222', uploaderName: 'Uploader', md5: 'ab'.repeat(16), sha: 'cd'.repeat(20), sha3: 'ef'.repeat(32),
        uploaderLocalPath: '/private/account/file', localPath: '/private/download/file' };
    const folder = { folderId: 'folder', folderName: 'Documents', creatorName: 'Creator', createUin: '22222',
        createTime: 1, modifyTime: 7, modifyUin: '33333', modifyName: 'Modifier', usedSpace: '18446744073709551614',
        totalFileCount: 2, parentFolderId: '/' };
    let result = { groupId: '200', directory: '/', startIndex: 0, nextIndex: 2, isEnd: true, allFileCount: 2,
        items: [{ peerId: '200', type: 1, fileInfo: source }, { peerId: '200', type: 2, folderInfo: folder }] };
    const service = { sessionCall: async () => result };
    return { source, folder, setResult(value) { result = value; }, query: (action = 'get_group_root_files', params = {}) => runQueryExtension(service, state, action, { group_id: 200, ...params }) };
}

test('group file fields preserve exact sizes, hashes and folder creator/modifier metadata without local paths', async () => {
    const f = queryFixture(), result = await f.query(), file = result.files[0], folder = result.folders[0];
    assert.equal(file.size, '18446744073709551614');
    assert.equal(file.size, file.file_size);
    assert.equal(file.uploaded_size, file.size);
    assert.equal(file.md5, 'ab'.repeat(16)); assert.equal(file.sha, 'cd'.repeat(20)); assert.equal(file.sha3, 'ef'.repeat(32));
    assert.equal(file.upload_time, 0); assert.equal(file.dead_time, 0); assert.equal(file.download_times, 2);
    assert.equal(folder.creator_name, 'Creator'); assert.equal(folder.modifier, '33333'); assert.equal(folder.modifier_name, 'Modifier');
    assert.equal(folder.modify_time, 7); assert.equal(folder.used_space, '18446744073709551614');
    assert.equal(JSON.stringify(result).includes('/private/'), false);
});

test('unknown owners and empty native hashes are omitted while actual optional values remain intact', async () => {
    const f = queryFixture();
    Object.assign(f.source, { uploaderUin: '0', md5: '', sha: '', sha3: '' });
    Object.assign(f.folder, { createUin: '', modifyUin: 0 });
    const result = await f.query();
    for (const key of ['uploader', 'md5', 'sha', 'sha3']) assert.equal(Object.hasOwn(result.files[0], key), false);
    for (const key of ['creator', 'modifier']) assert.equal(Object.hasOwn(result.folders[0], key), false);
});

test('optional file and folder metadata must remain typed and precise at the OneBot boundary', async () => {
    for (const patch of [{ uploadTime: -1 }, { downloadTimes: 1.5 }, { uploadedSize: 9007199254740992 },
        { uploadedSize: '18446744073709551616' }, { uploaderUin: 'u_target' }, { fileName: {} }]) {
        const f = queryFixture(); Object.assign(f.source, patch);
        await assert.rejects(f.query(), { code: 'INVALID_RESPONSE' });
    }
    for (const patch of [{ folderId: 'bad\nidentity' }, { creatorName: {} }, { totalFileCount: -1 }, { usedSpace: true }, { modifyUin: '0.5' }]) {
        const f = queryFixture(); Object.assign(f.folder, patch);
        await assert.rejects(f.query(), { code: 'INVALID_RESPONSE' });
    }
});

test('opaque native file digests do not invalidate a verified file page or acquire guessed checksum values', async () => {
    for (const [md5, sha] of [['\ufffd'.repeat(14), '\ufffd'.repeat(19)], ['\u0081'.repeat(16), '\ufffd'.repeat(21)]]) {
        const f = queryFixture(); Object.assign(f.source, { md5, sha, sha3: '' });
        const result = await f.query();
        assert.equal(result.files.length, 1); assert.equal(result.folders.length, 1);
        assert.equal(result.files[0].file_id, 'exact-file'); assert.equal(result.files[0].file_name, 'document.txt');
        assert.equal(result.files[0].file_size, '18446744073709551614');
        assert.equal(result.files[0].uploader, '22222'); assert.equal(result.files[0].upload_time, 0);
        for (const key of ['md5', 'sha', 'sha3']) assert.equal(Object.hasOwn(result.files[0], key), false);
    }
});

test('unverified digest types and wrong hex lengths are omitted consistently from file details', async () => {
    for (const digest of ['not-a-digest', {}, ['ab'], true, 'ab', 'ab'.repeat(65), null, '']) {
        const f = queryFixture(); Object.assign(f.source, { md5: digest, sha: digest, sha3: digest });
        f.setResult({ groupId: '200', fileInfo: f.source });
        const result = await f.query('get_group_file_info', { file_id: 'exact-file' });
        assert.equal(result.file_id, 'exact-file'); assert.equal(result.file_size, '18446744073709551614');
        for (const key of ['md5', 'sha', 'sha3']) assert.equal(Object.hasOwn(result, key), false);
    }
});

test('file detail exposes the same metadata and size alias as list results', async () => {
    const f = queryFixture();
    f.setResult({ groupId: '200', fileInfo: f.source });
    const detail = await f.query('get_group_file_info', { file_id: 'exact-file' });
    assert.equal(detail.sha, f.source.sha); assert.equal(detail.uploaded_size, detail.size);
    assert.equal(detail.uploader, '22222');
});

test('OneBot file pages reject duplicate identities, impossible totals and uint32 cursor overflow', async () => {
    for (const mutate of [page => { page.items.push(page.items[0]); page.allFileCount = 3; },
        page => { page.allFileCount = 0; }, page => { page.nextIndex = 0x100000000; }, page => { page.allFileCount = 0x100000000; }]) {
        const f = queryFixture();
        const page = { groupId: '200', directory: '/', startIndex: 0, nextIndex: 2, isEnd: true, allFileCount: 2,
            items: [{ peerId: '200', type: 1, fileInfo: f.source }, { peerId: '200', type: 2, folderInfo: f.folder }] };
        mutate(page); f.setResult(page);
        await assert.rejects(f.query(), { code: 'INVALID_RESPONSE' });
    }
});

function socialFixture(t) {
    const capture = new Capture({ install: false });
    t.after(() => capture.close());
    capture.epoch = 'one'; capture.ready = true; capture.readyAt = Date.now() - 1000;
    capture.qqVersion = '3.2.35-54395'; capture.self = { uin: '12345', uid: 'u_self' };
    capture.session = {};
    const services = { buddy: {}, group: {}, profile: {} };
    capture.service = name => { capture.ensureReady(); return services[name]; };
    capture.registrations = [{ name: 'buddy' }, { name: 'group' }];
    capture.remember('22222', 'u_friend');
    const events = [], social = createSocial(capture);
    capture.on('event', event => events.push(event));
    const service = { store: { get: () => ({ locator: { peer: { chatType: 2, peerUid: '200' } } }) },
        assertSession: async () => {}, sessionCall: async (_state, method, params) => {
            if (method === 'resolve') return { uid: params.uid || 'u_friend', uin: params.uin || '22222' };
            if (method === 'socialQuery') return social.query(params, { expiresAt: Date.now() + 1000 });
            throw new Error('Unexpected native request');
        } };
    return { capture, services, events, social, service, state: { ...capture.state(), readyAt: capture.readyAt } };
}

test('friend request nickname and source metadata survive both queries and published OneBot events', async t => {
    const f = socialFixture(t), request = { friendUid: 'u_friend', reqTime: String(Math.floor(Date.now() / 1000)),
        reqType: 1, isDecide: false, isUnread: true, isInitiator: false, extWords: 'line 1\nline 2',
        friendNick: 'Applicant', sourceId: 0, groupCode: '200', commFriendNum: 0 };
    f.services.buddy.approvalFriendRequest = () => {};
    f.services.buddy.getBuddyReq = () => {
        f.social.listenerMethods.buddy.onBuddyReqChange({ buddyReqs: [request] }); return { result: 0 };
    };
    const rows = await runSocial(f.service, f.state, 'get_friend_requests', {});
    assert.equal(rows[0].nickname, 'Applicant'); assert.equal(rows[0].source_id, 0);
    assert.equal(rows[0].source_group_id, 200); assert.equal(rows[0].common_friend_count, 0);
    assert.equal(rows[0].comment, request.extWords);
    const event = await convertSocialEvent(f.service, f.state, f.events[0]);
    assert.equal(event.nickname, rows[0].nickname); assert.equal(event.source_group_id, 200);
    assert.equal(event.common_friend_count, 0);
});

test('group request metadata identifies the actual applicant and retains group name and doubt state', async t => {
    const f = socialFixture(t), request = { seq: '18446744073709551614', type: 7, status: 1,
        group: { groupCode: '200', groupName: 'Real Group' }, user1: { uid: 'u_friend', nickName: 'Applicant' },
        user2: { uid: 'u_operator', nickName: 'Operator' }, warningTips: 'Official warning',
        actionTime: String(Math.floor(Date.now() / 1000)), postscript: 'Join please' };
    f.services.group.operateSysNotify = () => {};
    f.services.group.getSingleScreenNotifies = doubt => {
        f.social.listenerMethods.group.onGroupSingleScreenNotifies(doubt, '', doubt ? [request] : []); return { result: 0 };
    };
    const result = await runSocial(f.service, f.state, 'get_group_system_msg', {});
    assert.equal(result.join_requests.length, 1);
    assert.equal(result.join_requests[0].group_name, 'Real Group'); assert.equal(result.join_requests[0].nickname, 'Applicant');
    assert.equal(result.join_requests[0].warning_tips, 'Official warning'); assert.equal(result.join_requests[0].doubt, true);
    f.social.listenerMethods.group.onGroupNotifiesUpdated(true, [request]);
    const event = await convertSocialEvent(f.service, f.state, f.events[0]);
    assert.equal(event.group_name, 'Real Group'); assert.equal(event.nickname, 'Applicant'); assert.equal(event.doubt, true);
});

test('ambiguous mark-read selectors fail before resolving or changing any conversation', async () => {
    let calls = 0;
    const service = { sessionCall: async () => { calls++; return { read: true }; }, store: { get() { calls++; } } };
    for (const [action, params] of [
        ['mark_msg_as_read', { message_id: 1, user_id: 22222 }], ['mark_msg_as_read', { message_id: 1, group_id: 200 }],
        ['mark_msg_as_read', { user_id: 22222, group_id: 200 }], ['mark_private_msg_as_read', { user_id: 22222, group_id: 200 }],
        ['mark_group_msg_as_read', { message_id: 1, group_id: 200 }], ['mark_msg_as_read', {}]
    ]) await assert.rejects(runSocial(service, {}, action, params), { code: 'INVALID_PARAMS' });
    assert.equal(calls, 0);
});

test('friend category snapshots reject duplicate category IDs and duplicate members', async t => {
    const f = socialFixture(t);
    const category = { categoryId: 0, categroyName: 'Friends', categroyMbCount: 1, buddyUids: ['u_friend'] };
    f.services.buddy.getBuddyListV2 = () => ({ result: 0, data: [category, { ...category }] });
    await assert.rejects(f.social.query({ operation: 'categories' }), { code: 'INVALID_RESPONSE' });
    f.services.buddy.getBuddyListV2 = () => ({ result: 0, data: [{ ...category, buddyUids: ['u_friend', 'u_friend'] }] });
    await assert.rejects(f.social.query({ operation: 'categories' }), { code: 'INVALID_RESPONSE' });
    f.services.buddy.getBuddyListV2 = () => ({ result: 0, data: [{ ...category, categoryId: 0x100000000 }] });
    await assert.rejects(f.social.query({ operation: 'categories' }), { code: 'INVALID_RESPONSE' });
    f.services.buddy.getBuddyListV2 = () => ({ result: 0, data: [{ ...category, categroyMbCount: 9007199254740992 }] });
    await assert.rejects(f.social.query({ operation: 'categories' }), { code: 'INVALID_RESPONSE' });
});

test('invalid request subtypes and optional metadata fail instead of silently dropping request records', async () => {
    const row = { uid: 'u_friend', flag: 'fwd_req_' + 'a'.repeat(48), comment: '', time: 1, groupId: '200', subType: 'unknown' };
    const service = { sessionCall: async (_state, method) => method === 'resolve' ? { uid: 'u_friend', uin: '22222' } : [row] };
    await assert.rejects(runSocial(service, {}, 'get_group_system_msg', {}), { code: 'INVALID_RESPONSE' });
    row.subType = 'add'; row.nickname = {};
    await assert.rejects(runSocial(service, {}, 'get_group_system_msg', {}), { code: 'INVALID_RESPONSE' });
});
