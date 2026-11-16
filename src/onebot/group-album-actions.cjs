'use strict';

const protocol = require('../qq/group-album-protocol.cjs');
const { fields, plain, fail, budget } = protocol;
const { source } = require('../qq/group-album-upload.cjs');
const EXTENSION_REQUIREMENTS = Object.freeze({ get_group_album_list: 'groupAlbumList', get_qun_album_list: 'groupAlbumList', get_group_album_media_list: 'groupAlbumMediaList',
    set_group_album_media_like: 'groupAlbumLike', cancel_group_album_media_like: 'groupAlbumLike', do_group_album_comment: 'groupAlbumComment', del_group_album_media: 'groupAlbumDelete',
    upload_image_to_qun_album: 'groupAlbumUploadImage', upload_video_to_qun_album: 'groupAlbumUploadVideo' });
const ACTIONS = new Set(Object.keys(EXTENSION_REQUIREMENTS)), READ_ONLY_ACTIONS = new Set(['get_group_album_list', 'get_qun_album_list', 'get_group_album_media_list']);
async function runGroupAlbum(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown group album action');
    const media = action === 'get_group_album_media_list', write = !READ_ONLY_ACTIONS.has(action), like = ['set_group_album_media_like', 'cancel_group_album_media_like'].includes(action),
        uploading = ['upload_image_to_qun_album', 'upload_video_to_qun_album'].includes(action);
    fields(params, ['self_id', 'group_id', ...(uploading ? ['album_id', 'album_name', 'file'] : write ? ['album_id', 'lloc', ...(like ? ['batch_id'] : action === 'do_group_album_comment' ? ['content'] : [])] :
        [...(action === 'get_group_album_list' ? [] : ['attach_info']), ...(media ? ['album_id'] : [])])]);
    const groupId = protocol.uint(params.group_id, 'group_id', 0xffffffffn, 1n);
    if (params.self_id !== undefined && protocol.uint(params.self_id, 'self_id', 0xffffffffn, 1n) !== String(state.self.uin)) fail('INVALID_PARAMS', 'Album action belongs to another account');
    if (state.capabilities?.[EXTENSION_REQUIREMENTS[action]] !== true) fail('UNSUPPORTED', 'This QQ session lacks the required album capability');
    if (uploading) {
        const type = action === 'upload_video_to_qun_album' ? 'video' : 'image', image = source(params.file, service.mediaDirectory, type);
        const request = { operation: type === 'video' ? 'album.uploadVideo' : 'album.uploadImage', groupId, albumId: protocol.identifier(params.album_id),
            albumName: protocol.text(params.album_name, 'album_name', 1024, false), file: params.file };
        const result = await service.sessionCall(state, 'groupAlbumAction', request);
        if (!plain(result) || result.operation !== request.operation || result.groupId !== groupId || result.albumId !== request.albumId || result.albumName !== request.albumName ||
            result.type !== type || result.md5 !== image.md5 || result.size !== image.bytes.length || typeof result.mediaId !== 'string' || !result.mediaId || result.confirmed !== true || result.confirmation !== 'media_readback') fail('INVALID_RESPONSE', 'QQ did not confirm the exact uploaded account media in the requested album');
        await service.assertSession(state); return type === 'image' ? null : { id: result.mediaId };
    }
    if (write) {
        const operation = like ? 'album.like' : action === 'do_group_album_comment' ? 'album.comment' : 'album.delete';
        const request = { operation, groupId, albumId: protocol.identifier(params.album_id),
            lloc: like ? params.lloc === undefined ? '' : protocol.text(params.lloc, 'lloc', 1024) : protocol.identifier(params.lloc, 'lloc'),
            ...(like ? { batchId: protocol.uint(params.batch_id, 'batch_id', 0xffffffffffffffffn, 1n), isLike: action === 'set_group_album_media_like' } :
                operation === 'album.comment' ? { content: protocol.text(params.content, 'album comment', 4096, false) } : {}) };
        const result = await service.sessionCall(state, 'groupAlbumAction', request);
        const confirmation = { 'album.like': 'target_ack', 'album.comment': 'authored_comment_ack', 'album.delete': 'media_absence' }[operation];
        if (!plain(result) || result.confirmed !== true || result.confirmation !== confirmation || Object.keys(request).some(key => result[key] !== request[key])) fail('INVALID_RESPONSE', 'QQ did not confirm the exact group album operation');
        if (like) {
            if (result.like?.id !== protocol.cellId(request) || result.like.status !== (request.isLike ? 0 : 1)) fail('INVALID_RESPONSE', 'QQ returned an unrelated album like acknowledgement');
            return { id: result.like.id, status: result.like.status };
        }
        if (operation === 'album.delete') { if (result.success !== true) fail('INVALID_RESPONSE', 'QQ did not confirm album media absence'); return { success: true }; }
        const comment = result.comment;
        if (!plain(comment) || typeof comment.id !== 'string' || !comment.id || comment.user?.uin !== String(state.self.uin) || comment.content?.length !== 1 || comment.content[0].type !== 0 || comment.content[0].content !== request.content ||
            typeof comment.time !== 'string' || !/^[1-9]\d{0,19}$/.test(comment.time) || typeof comment.clientKey !== 'string' || !comment.clientKey.length) fail('INVALID_RESPONSE', 'QQ did not confirm the authored album comment');
        return budget(comment);
    }
    const operation = media ? 'album.media' : action === 'get_group_album_list' ? 'album.listAll' : 'album.list';
    const request = { operation, groupId, ...(operation === 'album.listAll' ? {} : { attachInfo: protocol.cursor(params.attach_info) }), ...(media ? { albumId: protocol.identifier(params.album_id) } : {}) };
    const result = await service.sessionCall(state, 'groupAlbumQuery', request);
    if (!plain(result) || result.operation !== operation || result.groupId !== groupId || media && result.albumId !== request.albumId) fail('INVALID_RESPONSE', 'QQ returned another album query target');
    let value;
    if (media) {
        if (!Array.isArray(result.mediaList) || result.mediaList.length > protocol.MAX_ITEMS || typeof result.nextAttachInfo !== 'string') fail('INVALID_RESPONSE', 'QQ omitted album media page data');
        protocol.cursor(result.nextAttachInfo); value = { mediaList: result.mediaList, nextAttachInfo: result.nextAttachInfo };
    } else {
        if (!Array.isArray(result.albums) || result.albums.length > protocol.MAX_ITEMS) fail('INVALID_RESPONSE', 'QQ omitted group album data');
        if (operation === 'album.listAll') { if (result.complete !== true) fail('INVALID_RESPONSE', 'QQ supplied an incomplete legacy album list'); value = result.albums; }
        else { if (typeof result.hasMore !== 'boolean') fail('INVALID_RESPONSE', 'QQ omitted the album continuation flag'); protocol.cursor(result.attachInfo); value = { album_list: result.albums, attach_info: result.attachInfo, has_more: result.hasMore }; }
    }
    await service.assertSession(state); return budget(value);
}
module.exports = { ACTIONS, READ_ONLY_ACTIONS, EXTENSION_REQUIREMENTS, runGroupAlbum };
