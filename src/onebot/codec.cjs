'use strict';

const { decodeBase64Image, MAX_IMAGE_BYTES } = require('../qq/media.cjs');
const { normalizeMusicData, MAX_CARD_BYTES } = require('../qq/music.cjs');
const { descriptor: forwardDescriptor } = require('../qq/forward.cjs');
const { decodeInlineMedia } = require('./media-input.cjs');

function problem(code, message) { return Object.assign(new Error(message), { code }); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function decode(value) { return value.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&'); }
function escape(value, parameter = false) {
    let escaped = String(value).replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
    if (parameter) escaped = escaped.replace(/,/g, '&#44;');
    return escaped;
}
function localMediaFile(value, type) {
    if (typeof value === 'string' && value.startsWith('base64://')) return value;
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f]/.test(value)) {
        throw problem('INVALID_REQUEST', type + ' requires an account-local file');
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^file:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
        throw problem('UNSUPPORTED', 'Only account-local ' + type + ' files are available');
    }
    return value;
}
function normalizeShare(data) {
    if (!plain(data) || Object.keys(data).some(key => !['url', 'title', 'content', 'image'].includes(key))) {
        throw problem('INVALID_REQUEST', 'Unsupported share parameters');
    }
    const url = (value, label) => {
        if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 2048 || /[\x00-\x20\x7f]/.test(value)) {
            throw problem('INVALID_REQUEST', 'Invalid share ' + label);
        }
        let parsed;
        try { parsed = new URL(value); } catch { throw problem('INVALID_REQUEST', 'Invalid share ' + label); }
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
            throw problem('INVALID_REQUEST', 'Invalid share ' + label);
        }
        return value;
    };
    if (typeof data.title !== 'string' || !data.title.trim() || Buffer.byteLength(data.title) > 1024 || /[\x00-\x1f\x7f]/.test(data.title)) {
        throw problem('INVALID_REQUEST', 'Invalid share title');
    }
    if (data.content !== undefined && (typeof data.content !== 'string' || Buffer.byteLength(data.content) > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.content))) {
        throw problem('INVALID_REQUEST', 'Invalid share content');
    }
    return { url: url(data.url, 'URL'), title: data.title,
        ...(data.content === undefined ? {} : { content: data.content }),
        ...(data.image === undefined ? {} : { image: data.image === '' ? '' : url(data.image, 'image URL') }) };
}

function parse(message, autoEscape = false) {
    let segments;
    if (typeof message === 'string') {
        if (autoEscape) segments = [{ type: 'text', data: { text: message } }];
        else {
            segments = [];
            let cursor = 0;
            const pattern = /\[CQ:([A-Za-z0-9_]+)((?:,[^\]]*)?)\]/g;
            let match;
            while ((match = pattern.exec(message))) {
                if (match.index > cursor) segments.push({ type: 'text', data: { text: decode(message.slice(cursor, match.index)) } });
                const data = {};
                if (match[2]) for (const pair of match[2].slice(1).split(',')) {
                    const separator = pair.indexOf('=');
                    if (separator < 1) throw problem('INVALID_REQUEST', 'Invalid CQ parameter');
                    const key = pair.slice(0, separator);
                    if (!/^[A-Za-z0-9_]+$/.test(key) || Object.hasOwn(data, key)) throw problem('INVALID_REQUEST', 'Invalid CQ parameter');
                    Object.defineProperty(data, key, { value: decode(pair.slice(separator + 1)), enumerable: true });
                }
                segments.push({ type: match[1], data });
                cursor = pattern.lastIndex;
            }
            if (cursor < message.length) segments.push({ type: 'text', data: { text: decode(message.slice(cursor)) } });
        }
    } else if (Array.isArray(message)) segments = message;
    else throw problem('INVALID_REQUEST', 'message must be a string or segment array');
    if (!segments.length || segments.length > 1000) throw problem('INVALID_REQUEST', 'Message is empty or has too many segments');
    let textBytes = 0, replies = 0, inlineImageBytes = 0;
    const result = segments.map(segment => {
        if (!segment || typeof segment !== 'object' || !segment.data || typeof segment.data !== 'object' || Array.isArray(segment.data)) {
            throw problem('INVALID_REQUEST', 'Invalid message segment');
        }
        const { type, data } = segment;
        if (type === 'text') {
            if (typeof data.text !== 'string') throw problem('INVALID_REQUEST', 'text segment requires text');
            textBytes += Buffer.byteLength(data.text);
            return { type, data: { text: data.text } };
        }
        if (type === 'at') {
            const qq = String(data.qq ?? '');
            if (qq !== 'all' && (!/^[1-9]\d{0,15}$/.test(qq) || !Number.isSafeInteger(Number(qq)))) {
                throw problem('INVALID_REQUEST', 'at segment requires a valid QQ number or all');
            }
            return { type, data: { qq } };
        }
        if (type === 'face') {
            const id = String(data.id ?? '');
            // Ordinary built-in faces have two stable kernel families. Animated
            // stickers and game faces need additional metadata and stay unsupported.
            if (!/^(0|[1-9]\d{0,5})$/.test(id) || Number(id) > 65535) {
                throw problem('INVALID_REQUEST', 'face requires a nonnegative built-in face ID');
            }
            if (['358', '359'].includes(id)) throw problem('UNSUPPORTED', 'Game faces are not ordinary face segments');
            return { type, data: { id } };
        }
        if (type === 'record') {
            if (Object.keys(data).some(key => key !== 'file')) throw problem('INVALID_REQUEST', 'record accepts only its audio file');
            const file = localMediaFile(data.file, type);
            if (file.startsWith('base64://')) {
                inlineImageBytes += decodeInlineMedia(file, type).bytes.length;
                if (inlineImageBytes > MAX_IMAGE_BYTES) throw problem('INVALID_REQUEST', 'Inline media in one message exceed 10 MiB in total');
            }
            return { type, data: { file } };
        }
        if (type === 'file' || type === 'video') {
            if (Object.keys(data).some(key => key !== 'file' && !(type === 'file' && key === 'name'))) {
                throw problem('UNSUPPORTED', 'Unsupported ' + type + ' options');
            }
            const file = localMediaFile(data.file, type);
            if (file.startsWith('base64://')) {
                inlineImageBytes += decodeInlineMedia(file, type).bytes.length;
                if (inlineImageBytes > MAX_IMAGE_BYTES) throw problem('INVALID_REQUEST', 'Inline media in one message exceed 10 MiB in total');
            }
            if (data.name !== undefined && (typeof data.name !== 'string' || !data.name.trim() || ['.', '..'].includes(data.name) ||
                Buffer.byteLength(data.name) > 255 || /[\\/\x00-\x1f\x7f-\x9f]/.test(data.name))) {
                throw problem('INVALID_REQUEST', 'Invalid file display name');
            }
            return { type, data: { file, ...(data.name === undefined ? {} : { name: data.name }) } };
        }
        if (type === 'share') return { type, data: normalizeShare(data) };
        if (type === 'image') {
            if (typeof data.file !== 'string' || !data.file) {
                throw problem('INVALID_REQUEST', 'image requires an account-local file or a bounded base64:// image');
            }
            if (data.file.startsWith('base64://')) {
                let image;
                try { image = decodeBase64Image(data.file); }
                catch (error) { throw problem(error.code === 'INVALID_PARAMS' ? 'INVALID_REQUEST' : error.code || 'INVALID_REQUEST', error.message); }
                inlineImageBytes += image.bytes.length;
                if (inlineImageBytes > MAX_IMAGE_BYTES) throw problem('INVALID_REQUEST', 'Inline images in one message exceed 10 MiB in total');
            } else {
                if (data.file.length > 4096 || /[\x00-\x1f]/.test(data.file)) throw problem('INVALID_REQUEST', 'Invalid account-local image filename');
                if (/^(https?|base64):/i.test(data.file)) throw problem('UNSUPPORTED', 'Remote image URLs and noncanonical base64 inputs are unavailable');
            }
            if (data.type !== undefined && data.type !== 'image') throw problem('UNSUPPORTED', 'Flash and sticker images are unavailable');
            if (data.summary !== undefined && (typeof data.summary !== 'string' || Buffer.byteLength(data.summary) > 1024)) throw problem('INVALID_REQUEST', 'Invalid image summary');
            return { type, data: { file: data.file, ...(data.summary === undefined ? {} : { summary: data.summary }) } };
        }
        if (type === 'reply') {
            if (!['string', 'number'].includes(typeof data.id) || !/^-?[1-9]\d*$/.test(String(data.id))) {
                throw problem('INVALID_REQUEST', 'reply requires a valid message ID');
            }
            const id = Number(data.id);
            if (!Number.isInteger(id) || !id || id < -0x80000000 || id > 0x7fffffff || ++replies > 1) {
                throw problem('INVALID_REQUEST', 'reply requires one valid message ID');
            }
            return { type, data: { id: String(id) } };
        }
        if (type === 'music') {
            try { return { type, data: normalizeMusicData(data) }; }
            catch (error) { throw problem(error.code === 'INVALID_PARAMS' ? 'INVALID_REQUEST' : error.code, error.message); }
        }
        throw problem('UNSUPPORTED', 'Unsupported message segment: ' + String(type));
    });
    if (textBytes > 65536 || result.every(item => item.type === 'text' && !item.data.text)) {
        throw problem('INVALID_REQUEST', 'Message text is empty or too long');
    }
    if (result.length !== 1 && result.some(segment => ['file', 'video'].includes(segment.type))) {
        throw problem('UNSUPPORTED', 'File and video sends require one standalone segment');
    }
    return result;
}

function stringify(segments) {
    return segments.map(segment => segment.type === 'text' ? escape(segment.data.text) :
        '[CQ:' + segment.type + Object.entries(segment.data).map(([key, value]) => ',' + key + '=' + escape(value, true)).join('') + ']').join('');
}

function mentionUin(value) {
    if (value === undefined || value === null || value === '' || value === 0 || value === '0') return null;
    if (!['string', 'number'].includes(typeof value) || !/^-?[1-9]\d*$/.test(String(value))) {
        throw problem('INVALID_RESPONSE', 'QQ mention account is not an integer');
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw problem('INVALID_RESPONSE', 'QQ mention account is outside the safe integer range');
    if (number < 0) {
        if (number < -0x80000000) throw problem('INVALID_RESPONSE', 'QQ signed mention account is outside int32');
        return String(number + 0x100000000);
    }
    return String(number);
}

async function mentionedAccount(text, context, isSelfMention) {
    const raw = mentionUin(text.atUid);
    const uid = text.atNtUid === undefined || text.atNtUid === null || text.atNtUid === '' ? null : text.atNtUid;
    if (uid !== null && (typeof uid !== 'string' || uid.length > 128 || !/^u_[A-Za-z0-9_-]+$/.test(uid))) throw problem('INVALID_RESPONSE', 'QQ mention has an invalid kernel UID');
    let verified = null;
    if (uid) {
        if (uid === context.selfUid && context.selfUin) verified = mentionUin(context.selfUin);
        else {
            if (typeof context.resolveUid !== 'function') throw problem('NOT_FOUND', 'QQ mention UID cannot be verified');
            const resolved = await context.resolveUid(uid);
            verified = mentionUin(resolved?.uin);
            if (!verified || resolved.uid !== uid) {
                throw problem('INVALID_RESPONSE', 'QQ mention UID mapping is inconsistent');
            }
        }
        if (raw && raw !== verified) throw problem('INVALID_RESPONSE', 'QQ mention UID and UIN identify different accounts');
    }
    const uin = verified || raw;
    if (!uin) throw problem('NOT_FOUND', 'QQ mention has no real UIN');
    if (isSelfMention) {
        const selfUin = mentionUin(context.selfUin);
        if (!selfUin || typeof context.selfUid !== 'string' || context.selfUid.length > 128 || !/^u_[A-Za-z0-9_-]+$/.test(context.selfUid)) {
            throw problem('NOT_READY', 'A verified self account is required for a self mention');
        }
        if (uin !== selfUin || (uid && uid !== context.selfUid)) throw problem('INVALID_RESPONSE', 'QQ self mention does not target this account');
    }
    return uin;
}

async function toKernel(segments, context) {
    const elements = [];
    for (const segment of segments) {
        if (segment.type === 'text') elements.push({ elementType: 1, elementId: '', textElement: {
            content: segment.data.text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' } });
        else if (segment.type === 'face') elements.push({ elementType: 6, elementId: '', faceElement: {
            faceIndex: Number(segment.data.id), faceType: Number(segment.data.id) < 222 ? 1 : 2 } });
        else if (segment.type === 'image') {
            if (typeof context.prepareMedia !== 'function') throw problem('UNSUPPORTED', 'Native image preparation is unavailable');
            const element = await context.prepareMedia(segment.data);
            if (element?.elementType !== 2 || !element.picElement) throw problem('INVALID_RESPONSE', 'QQ returned no prepared image');
            elements.push(element);
        }
        else if (segment.type === 'record') {
            if (typeof context.prepareRecord !== 'function') throw problem('UNSUPPORTED', 'Local native voice preparation is unavailable');
            const element = await context.prepareRecord(segment.data);
            if (element?.elementType !== 4 || !element.pttElement) throw problem('INVALID_RESPONSE', 'QQ returned no prepared voice');
            elements.push(element);
        }
        else if (segment.type === 'file' || segment.type === 'video') {
            if (segments.length !== 1) throw problem('UNSUPPORTED', 'File and video sends require one standalone segment');
            const type = segment.type, prepare = type === 'file' ? context.prepareFile : context.prepareVideo;
            if (typeof prepare !== 'function') throw problem('UNSUPPORTED', 'Native ' + type + ' preparation is unavailable');
            const element = await prepare(segment.data);
            if (element?.elementType !== (type === 'file' ? 3 : 5) || !plain(element[type === 'file' ? 'fileElement' : 'videoElement'])) {
                throw problem('INVALID_RESPONSE', 'QQ returned no prepared ' + type);
            }
            elements.push(element);
        }
        else if (segment.type === 'share') {
            if (typeof context.prepareShare !== 'function') throw problem('UNSUPPORTED', 'Fixed share preparation is unavailable');
            const data = normalizeShare(segment.data), element = await context.prepareShare(data);
            if (element?.elementType !== 10 || typeof element.shareToken !== 'string' || !element.shareToken || !plain(element.arkElement)) {
                throw problem('INVALID_RESPONSE', 'QQ returned no prepared share card');
            }
            const card = JSON.parse(arkJson(element)), news = card.meta?.news;
            if (card.app !== 'com.tencent.structmsg' || card.view !== 'news' || !plain(news) || news.title !== data.title ||
                news.jumpUrl !== data.url || news.desc !== (data.content || '') || news.preview !== (data.image || '')) {
                throw problem('INVALID_RESPONSE', 'QQ prepared another share card');
            }
            elements.push(element);
        }
        else if (segment.type === 'music') {
            if (typeof context.prepareMusic !== 'function') throw problem('UNSUPPORTED', 'Music signing and native preparation are unavailable');
            const element = await context.prepareMusic(normalizeMusicData(segment.data));
            if (element?.elementType !== 10 || typeof element.arkElement?.bytesData !== 'string' || typeof element.musicToken !== 'string') {
                throw problem('INVALID_RESPONSE', 'QQ returned no prepared music card');
            }
            elements.push(element);
        }
        else if (segment.type === 'at') {
            if (context.peer.chatType !== 2) throw problem('UNSUPPORTED', 'Mentions require a group conversation');
            let name = '全体成员', uid = 'all';
            if (segment.data.qq !== 'all') {
                const resolved = await context.resolve(segment.data.qq);
                uid = resolved.uid;
                if (typeof uid !== 'string' || uid.length > 128 || !/^u_[A-Za-z0-9_-]+$/.test(uid) || String(resolved.uin) !== segment.data.qq) throw problem('NOT_FOUND', 'Cannot resolve mentioned QQ account');
                const member = await context.member(segment.data.qq);
                name = member.card || member.nickname || segment.data.qq;
            }
            elements.push({ elementType: 1, elementId: '', textElement: { content: '@' + name,
                atType: segment.data.qq === 'all' ? 1 : 2, atUid: segment.data.qq,
                atTinyId: '', atNtUid: uid } });
        } else if (segment.type === 'reply') {
            const record = await context.reply(Number(segment.data.id));
            if (!record || record.chatType !== context.peer.chatType || String(record.peerUid) !== context.peer.peerUid) {
                throw problem('INVALID_REQUEST', 'Quoted message does not belong to this conversation');
            }
            const integer = value => ['string', 'number'].includes(typeof value) && /^\d+$/.test(String(value)) &&
                (typeof value !== 'number' || Number.isSafeInteger(value));
            if (!integer(record.msgId) || String(record.msgId) === '0' ||
                !integer(record.senderUin) || !Number.isSafeInteger(Number(record.senderUin)) || Number(record.senderUin) <= 0 ||
                typeof record.senderUid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(record.senderUid) ||
                !integer(record.msgTime) || !Number.isSafeInteger(Number(record.msgTime)) || Number(record.msgTime) <= 0 ||
                !integer(record.msgSeq ?? '0') || !integer(record.clientSeq ?? '0') ||
                (context.peer.chatType === 1 && (!record.clientSeq || String(record.clientSeq) === '0'))) {
                throw problem('NOT_FOUND', 'Quoted message has no complete verified native locator');
            }
            elements.push({ elementType: 7, elementId: '', replyElement: {
                replayMsgId: String(record.msgId), replayMsgSeq: String(record.msgSeq || '0'),
                senderUin: String(record.senderUin), senderUidStr: record.senderUid, replyMsgTime: String(record.msgTime),
                replyMsgClientSeq: String(record.clientSeq || '0') } });
        } else throw problem('UNSUPPORTED', 'Unsupported outgoing message segment');
    }
    return elements;
}

function arkJson(element) {
    const source = element.arkElement?.bytesData;
    if (typeof source !== 'string' || !source || Buffer.byteLength(source) > MAX_CARD_BYTES) {
        throw problem('INVALID_RESPONSE', 'QQ JSON card is absent or too large');
    }
    let parsed;
    try { parsed = JSON.parse(source); } catch { throw problem('INVALID_RESPONSE', 'QQ JSON card is invalid'); }
    if (!plain(parsed)) throw problem('INVALID_RESPONSE', 'QQ JSON card must contain an object');
    // Keep the original bytes, including whitespace and provider signatures.
    // This is a receive-only JSON segment; card content is never executed.
    return source;
}
function exactSize(value) {
    if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value)) return null;
    const size = String(value);
    return /^(0|[1-9]\d{0,19})$/.test(size) && BigInt(size) <= 0xffffffffffffffffn ? size : null;
}
function queriedFile(element) {
    const source = element.fileElement, size = exactSize(source.fileSize);
    if (typeof source.fileUuid !== 'string' || !source.fileUuid || Buffer.byteLength(source.fileUuid) > 1024 ||
        /[\x00-\x1f\x7f-\x9f]/.test(source.fileUuid) || typeof source.fileName !== 'string' ||
        !source.fileName.trim() || ['.', '..'].includes(source.fileName) || Buffer.byteLength(source.fileName) > 255 ||
        /[\\/\x00-\x1f\x7f-\x9f]/.test(source.fileName) || size === null) {
        throw problem('INVALID_RESPONSE', 'QQ file has no complete verified metadata');
    }
    // Query-only metadata keeps the opaque native resource identity. It does
    // not promise a retrievable URL or expose QQ's private local cache path.
    return { file: source.fileUuid, file_id: source.fileUuid, name: source.fileName, file_size: size };
}
function resourceDetails(type, element, data) {
    const source = type === 'image' ? element.picElement : type === 'record' ? element.pttElement : element.videoElement;
    const result = { ...data };
    const size = exactSize(data.file_size) ?? exactSize(source.fileSize);
    if (size !== null) result.file_size = size;
    if (typeof source.fileName === 'string' && source.fileName && Buffer.byteLength(source.fileName) <= 1024 &&
        !/[\\/\x00-\x1f\x7f]/.test(source.fileName)) result.file_name = source.fileName;
    for (const [target, field] of type === 'image' ? [['width', 'picWidth'], ['height', 'picHeight']] :
        type === 'video' ? [['width', 'fileWidth'], ['height', 'fileHeight']] : []) {
        const value = Number.isSafeInteger(data[target]) && data[target] > 0 ? data[target] : source[field];
        if (Number.isSafeInteger(value) && value > 0) result[target] = value;
        else delete result[target];
    }
    const validDuration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
    const duration = validDuration(data.duration) ? data.duration : type === 'record' ? source.duration : type === 'video' ? source.fileTime : undefined;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= Number.MAX_SAFE_INTEGER) result.duration = duration;
    else delete result.duration;
    if (type === 'image' && Number.isInteger(source.picSubType) && source.picSubType >= 0 && source.picSubType <= 7) result.sub_type = source.picSubType;
    if (type === 'image' && typeof source.summary === 'string' && Buffer.byteLength(source.summary) <= 1024 && data.summary === undefined) result.summary = source.summary;
    return result;
}
function validateElements(elements, context) {
    const payloads = { 1: 'textElement', 2: 'picElement', 3: 'fileElement', 4: 'pttElement', 5: 'videoElement', 6: 'faceElement', 7: 'replyElement', 10: 'arkElement', 16: 'multiForwardMsgElement' };
    for (const element of elements) {
        if (!plain(element) || !Number.isInteger(element.elementType) || !Object.hasOwn(payloads, element.elementType)) throw problem('UNSUPPORTED', 'QQ message contains unsupported media');
        const key = payloads[element.elementType], payload = element[key];
        if (!plain(payload)) throw problem('INVALID_RESPONSE', 'QQ message is missing its native element payload');
        // Native envelopes contain many nullable payload fields. A second
        // non-null payload would otherwise be silently dropped by conversion.
        if (Object.entries(element).some(([name, value]) => name.endsWith('Element') && name !== key && value !== null && value !== undefined)) {
            throw problem('UNSUPPORTED', 'QQ message contains conflicting native element payloads');
        }
        if (element.elementType === 1) {
            if (typeof payload.content !== 'string') throw problem('INVALID_RESPONSE', 'Invalid QQ text element');
            if (payload.atType !== undefined && ![0, 1, 2, 4].includes(payload.atType)) throw problem('UNSUPPORTED', 'Unsupported QQ mention type');
        } else if (element.elementType === 3) {
            if (context.queryFiles !== true && typeof context.file !== 'function') throw problem('UNSUPPORTED', 'QQ file metadata is only available in explicit message queries');
            queriedFile(element);
        } else if ([2, 4, 5].includes(element.elementType)) {
            const type = ({ 2: 'image', 4: 'record', 5: 'video' })[element.elementType];
            if (typeof context[type] !== 'function') throw problem('UNSUPPORTED', 'QQ media has no resource converter');
        } else if (element.elementType === 6) {
            if (!Number.isInteger(payload.faceIndex) || payload.faceIndex < 0 || payload.faceIndex > 65535) throw problem('INVALID_RESPONSE', 'Invalid QQ face element');
            if (![1, 2].includes(payload.faceType) || [358, 359].includes(payload.faceIndex)) throw problem('UNSUPPORTED', 'Animated, game and poke faces need a separate segment implementation');
        } else if (element.elementType === 7) {
            if (typeof context.reply !== 'function') throw problem('UNSUPPORTED', 'QQ quote has no locator converter');
        } else if (element.elementType === 16) {
            forwardDescriptor(element);
            if (typeof context.forward !== 'function') throw problem('UNSUPPORTED', 'QQ merged forward has no account-bound resource converter');
        } else arkJson(element);
    }
}

async function fromKernel(record, context = {}) {
    const elements = record.elements || record.elementList;
    if (!Array.isArray(elements) || !elements.length || elements.length > 1000) throw problem('UNSUPPORTED', 'QQ message has no supported bounded elements');
    // Validate every native payload before any media download or UID lookup.
    validateElements(elements, context);
    const result = [];
    for (const element of elements) {
        if (element.elementType === 1) {
            const text = element.textElement;
            if (!text || typeof text.content !== 'string') throw problem('INVALID_RESPONSE', 'Invalid QQ text element');
            if (text.atType === 0 || text.atType === undefined) result.push({ type: 'text', data: { text: text.content } });
            else if (text.atType === 1) result.push({ type: 'at', data: { qq: 'all' } });
            else if (text.atType === 2 || text.atType === 4) {
                const qq = await mentionedAccount(text, context, text.atType === 4);
                result.push({ type: 'at', data: { qq } });
            } else throw problem('UNSUPPORTED', 'Unsupported QQ mention type');
        } else if (element.elementType === 2) {
            const data = await context.image(element);
            if (!data || typeof data.file !== 'string' || typeof data.url !== 'string') throw problem('UNSUPPORTED', 'QQ image has no retrievable resource');
            result.push({ type: 'image', data: resourceDetails('image', element, data) });
        } else if (element.elementType === 3) {
            const base = queriedFile(element);
            const data = typeof context.file === 'function' ? await context.file(element, base) : base;
            result.push({ type: 'file', data });
        } else if (element.elementType === 4 || element.elementType === 5) {
            const type = element.elementType === 4 ? 'record' : 'video';
            const data = await context[type](element);
            if (!data || typeof data.file !== 'string' || typeof data.url !== 'string') throw problem('UNSUPPORTED', 'QQ ' + type + ' has no retrievable resource');
            result.push({ type, data: resourceDetails(type, element, data) });
        } else if (element.elementType === 6) {
            const face = element.faceElement;
            if (!face || !Number.isInteger(face.faceIndex) || face.faceIndex < 0 || face.faceIndex > 65535) {
                throw problem('INVALID_RESPONSE', 'Invalid QQ face element');
            }
            if (![1, 2].includes(face.faceType) || [358, 359].includes(face.faceIndex)) {
                throw problem('UNSUPPORTED', 'Animated, game and poke faces need a separate segment implementation');
            }
            result.push({ type: 'face', data: { id: String(face.faceIndex) } });
        } else if (element.elementType === 16) {
            const data = await context.forward(element);
            if (!data || typeof data.id !== 'string' || !/^fwd_[A-Za-z0-9_-]{24,80}$/.test(data.id)) throw problem('INVALID_RESPONSE', 'QQ merged forward has no valid account-bound handle');
            result.push({ type: 'forward', data: { id: data.id } });
        } else if (element.elementType === 10) {
            if (forwardDescriptor(element)) {
                const data = await context.forward(element);
                if (!data || typeof data.id !== 'string' || !/^fwd_[A-Za-z0-9_-]{24,80}$/.test(data.id)) throw problem('INVALID_RESPONSE', 'QQ merged forward has no valid account-bound handle');
                result.push({ type: 'forward', data: { id: data.id } });
            } else result.push({ type: 'json', data: { data: arkJson(element) } });
        } else {
            const reference = element.replyElement;
            if (!reference) throw problem('INVALID_RESPONSE', 'Invalid QQ reply element');
            const id = await context.reply(reference);
            if (!Number.isInteger(id) || !id || id < -0x80000000 || id > 0x7fffffff) throw problem('NOT_FOUND', 'Quoted message cannot be located');
            result.push({ type: 'reply', data: { id: String(id) } });
        }
    }
    return result;
}

module.exports = { parse, stringify, toKernel, fromKernel, escape, decode };
