'use strict';

const { types } = require('node:util');
const codec = require('./codec.cjs');
const { MAX_IMAGE_BYTES } = require('../qq/media.cjs');

const MAX_NODES = 100;
const MAX_SEGMENTS = 1000;
const MAX_TEXT_BYTES = 65536;
const MAX_NAME_BYTES = 512;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const BASE64_PREFIX = 'base64://';

function problem(code, message) { return Object.assign(new Error(message), { code }); }
function record(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw problem('INVALID_PARAMS', 'Invalid merged ' + label);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value), result = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
        const item = descriptors[key];
        if (typeof key !== 'string' || !item.enumerable || !Object.hasOwn(item, 'value')) {
            throw problem('INVALID_PARAMS', 'Merged inputs must contain only ordinary JSON fields');
        }
        if (!allowed.includes(key)) throw problem('UNSUPPORTED', 'Unsupported merged ' + label + ' field');
        result[key] = item.value;
    }
    return result;
}
function array(value, maximum, label) {
    if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        throw problem('INVALID_PARAMS', 'Merged ' + label + ' must be a JSON array');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value), length = descriptors.length.value;
    if (!length || length > maximum) throw problem('INVALID_PARAMS', 'Merged ' + label + ' exceeds its count bounds');
    if (Reflect.ownKeys(descriptors).length !== length + 1) throw problem('INVALID_PARAMS', 'Merged arrays must be dense ordinary JSON arrays');
    const result = [];
    for (let index = 0; index < length; index++) {
        const item = descriptors[index];
        if (!item || !item.enumerable || !Object.hasOwn(item, 'value')) {
            throw problem('INVALID_PARAMS', 'Merged arrays cannot contain holes or accessors');
        }
        result.push(item.value);
    }
    return result;
}
function account(value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value)) || Number(value) > 0xffffffff) throw problem('INVALID_PARAMS', 'Merged node requires an exact uint32 QQ account');
    return String(value);
}
function author(data) {
    const first = Object.hasOwn(data, 'user_id'), second = Object.hasOwn(data, 'uin');
    if (!first && !second) throw problem('INVALID_PARAMS', 'Merged node requires a user_id');
    const primary = account(first ? data.user_id : data.uin);
    if (first && second && primary !== account(data.uin)) throw problem('INVALID_PARAMS', 'Merged author aliases conflict');
    return primary;
}
function time(value) {
    if (!['string', 'number'].includes(typeof value) || !/^(?:0|[1-9]\d{0,9})$/.test(String(value)) ||
        !Number.isInteger(Number(value)) || Number(value) > 0xffffffff) throw problem('INVALID_PARAMS', 'Merged time requires exact uint32 seconds');
    // Explicit zero is retained for the sending layer to resolve server time.
    return Number(value) || 0;
}
function nickname(data) {
    const first = Object.hasOwn(data, 'nickname'), second = Object.hasOwn(data, 'name');
    if (!first && !second) throw problem('INVALID_PARAMS', 'Merged node requires a nickname');
    const name = first ? data.nickname : data.name;
    if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > MAX_NAME_BYTES || /[\x00-\x1f\x7f]/.test(name)) {
        throw problem('INVALID_PARAMS', 'Merged nickname must be a bounded display name');
    }
    if (first && second && name !== data.name) throw problem('INVALID_PARAMS', 'Merged nickname aliases conflict');
    return name;
}
function inputSegments(content) {
    if (typeof content !== 'string') return array(content, MAX_SEGMENTS, 'content');
    if (!content || Buffer.byteLength(content) > MAX_REQUEST_BYTES) throw problem('INVALID_PARAMS', 'Merged content is empty or too large');
    // Preserve CQ fields until strict validation; codec.parse intentionally
    // ignores some ordinary-send options and must not hide them here.
    const result = [], pattern = /\[CQ:([A-Za-z0-9_]+)((?:,[^\]]*)?)\]/g;
    let cursor = 0, match;
    while ((match = pattern.exec(content))) {
        if (match.index > cursor) result.push({ type: 'text', data: { text: codec.decode(content.slice(cursor, match.index)) } });
        const data = Object.create(null);
        if (match[2]) for (const pair of match[2].slice(1).split(',')) {
            const separator = pair.indexOf('=');
            const key = pair.slice(0, separator);
            if (separator < 1 || !/^[A-Za-z0-9_]+$/.test(key) || Object.hasOwn(data, key)) {
                throw problem('INVALID_PARAMS', 'Invalid merged CQ parameter');
            }
            data[key] = codec.decode(pair.slice(separator + 1));
        }
        result.push({ type: match[1], data });
        if (result.length > MAX_SEGMENTS) throw problem('INVALID_PARAMS', 'Merged content has too many segments');
        cursor = pattern.lastIndex;
    }
    if (cursor < content.length) result.push({ type: 'text', data: { text: codec.decode(content.slice(cursor)) } });
    return array(result, MAX_SEGMENTS, 'content');
}
function imageSize(file) {
    if (typeof file !== 'string' || !file) throw problem('INVALID_PARAMS', 'Merged image requires a base64:// image');
    if (!file.startsWith(BASE64_PREFIX)) throw problem('UNSUPPORTED', 'Merged images currently accept only base64:// input');
    const length = file.length - BASE64_PREFIX.length;
    if (!length || length % 4 || length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) {
        throw problem('INVALID_PARAMS', 'Merged image is malformed or exceeds 10 MiB');
    }
    const padding = file.endsWith('==') ? 2 : file.endsWith('=') ? 1 : 0;
    const bytes = length / 4 * 3 - padding;
    if (bytes < 1 || bytes > MAX_IMAGE_BYTES) throw problem('INVALID_PARAMS', 'Merged image exceeds 10 MiB');
    return bytes;
}
function content(value, budget) {
    const segments = inputSegments(value), result = [];
    budget.segments += segments.length;
    if (budget.segments > MAX_SEGMENTS) throw problem('INVALID_PARAMS', 'Merged request has too many segments');
    for (const source of segments) {
        const segment = record(source, ['type', 'data'], 'segment');
        if (!['text', 'image'].includes(segment.type)) throw problem('UNSUPPORTED', 'Merged nodes currently support only text and image segments');
        const data = record(segment.data, segment.type === 'text' ? ['text'] : ['file', 'type', 'summary'], 'segment data');
        if (segment.type === 'text') {
            if (typeof data.text !== 'string') throw problem('INVALID_PARAMS', 'Merged text segment requires text');
            budget.textBytes += Buffer.byteLength(data.text);
            if (budget.textBytes > MAX_TEXT_BYTES) throw problem('INVALID_PARAMS', 'Merged text exceeds 64 KiB in total');
            result.push({ type: 'text', data: { text: data.text } });
        } else {
            budget.imageBytes += imageSize(data.file);
            if (budget.imageBytes > MAX_IMAGE_BYTES) throw problem('INVALID_PARAMS', 'Merged images exceed 10 MiB in total');
            if (data.type !== undefined && data.type !== 'image') throw problem('UNSUPPORTED', 'Merged flash and sticker images are unavailable');
            if (data.summary !== undefined && (typeof data.summary !== 'string' || Buffer.byteLength(data.summary) > 1024)) {
                throw problem('INVALID_PARAMS', 'Invalid merged image summary');
            }
            result.push({ type: 'image', data: { file: data.file, ...(data.summary === undefined ? {} : { summary: data.summary }) } });
        }
    }
    return result;
}

function normalizeMergedNodes(messages, options) {
    if (options === undefined) throw problem('NOT_READY', 'A verified self account is required for merged nodes');
    const settings = record(options, ['selfId'], 'options');
    if (!Object.hasOwn(settings, 'selfId')) throw problem('NOT_READY', 'A verified self account is required for merged nodes');
    account(settings.selfId);
    const budget = { segments: 0, textBytes: 0, imageBytes: 0 };
    const result = [];
    // This first pass validates every shape, author and aggregate budget before
    // decoding media. No filesystem, network, native calls or input mutation.
    for (const source of array(messages, MAX_NODES, 'nodes')) {
        const node = record(source, ['type', 'data'], 'node');
        if (node.type !== 'node') throw problem('UNSUPPORTED', 'Merged messages require custom node segments');
        const data = record(node.data, ['user_id', 'uin', 'nickname', 'name', 'time', 'content'], 'node data');
        result.push({ user_id: author(data), nickname: nickname(data), ...(Object.hasOwn(data, 'time') ? { time: time(data.time) } : {}),
            content: content(data.content, budget) });
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_REQUEST_BYTES) throw problem('INVALID_PARAMS', 'Merged request exceeds 16 MiB');
    // Reuse the existing canonical base64 and actual PNG/JPEG/GIF validation.
    // Its return value also makes every content array independent of the input.
    for (const node of result) {
        try { node.content = codec.parse(node.content); }
        catch (error) {
            throw problem(error.code === 'INVALID_REQUEST' ? 'INVALID_PARAMS' : error.code || 'INVALID_PARAMS', error.message);
        }
    }
    return result;
}

function existingNodeIds(messages) {
    let anyId = false, allIds = true;
    const ids = [];
    for (const source of array(messages, MAX_NODES, 'nodes')) {
        const node = record(source, ['type', 'data'], 'node');
        if (node.type !== 'node') throw problem('UNSUPPORTED', 'Merged messages require node segments');
        const data = record(node.data, ['id', 'user_id', 'uin', 'nickname', 'name', 'time', 'content'], 'node data');
        if (!Object.hasOwn(data, 'id')) { allIds = false; continue; }
        anyId = true;
        if (Object.keys(data).length !== 1 || !['string', 'number'].includes(typeof data.id) || !/^-?[1-9]\d*$/.test(String(data.id)) ||
            !Number.isInteger(Number(data.id)) || Number(data.id) < -0x80000000 || Number(data.id) > 0x7fffffff) throw problem('INVALID_PARAMS', 'Existing node requires only one nonzero 32-bit message id');
        ids.push(Number(data.id));
    }
    if (anyId && !allIds) throw problem('UNSUPPORTED', 'Existing ID nodes cannot be mixed with custom nodes');
    if (anyId && (ids.length > 20 || new Set(ids).size !== ids.length)) throw problem('INVALID_PARAMS', 'Existing merged nodes require 1 to 20 distinct message IDs');
    return anyId ? ids : null;
}

module.exports = { normalizeMergedNodes, existingNodeIds, MAX_NODES, MAX_SEGMENTS, MAX_TEXT_BYTES, MAX_NAME_BYTES, MAX_IMAGE_BYTES, MAX_REQUEST_BYTES };
