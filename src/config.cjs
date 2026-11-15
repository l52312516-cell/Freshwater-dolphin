'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateHeaderValue } = require('node:http');
const { fault } = require('./errors.cjs');
const { workspacePath } = require('./paths.cjs');

function integer(value, fallback, min, max, name) {
    const actual = value === undefined ? fallback : value;
    if (!Number.isInteger(actual) || actual < min || actual > max) throw fault('INVALID_CONFIG', 'Invalid ' + name);
    return actual;
}

function identifier(value, fallback, name) {
    const actual = value === undefined ? fallback : value;
    if (typeof actual !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(actual)) throw fault('INVALID_CONFIG', 'Invalid ' + name);
    return actual;
}

function nodeConfig(value, index) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('INVALID_CONFIG', 'Invalid network node');
    const type = value.type;
    if (!['httpApi', 'httpPost', 'wsServer', 'wsClient'].includes(type)) throw fault('INVALID_CONFIG', 'Invalid node type');
    const id = identifier(value.id, 'node-' + (index + 1), 'node id');
    const label = value.label === undefined ? value.name === undefined ? id : value.name : value.label;
    if (typeof label !== 'string' || label.length > 100 || /[\x00-\x1f\x7f]/.test(label)) throw fault('INVALID_CONFIG', 'Invalid node label');
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw fault('INVALID_CONFIG', 'Invalid node enabled');
    if (value.token !== undefined && (typeof value.token !== 'string' || /[\r\n]/.test(value.token) || value.token.length > 4096)) throw fault('INVALID_CONFIG', 'Invalid node token');
    if (value.token) {
        try { validateHeaderValue('Authorization', 'Bearer ' + value.token); }
        catch { throw fault('INVALID_CONFIG', 'Node token cannot be represented in an HTTP authorization header'); }
    }
    if (value.secret !== undefined && (typeof value.secret !== 'string' || value.secret.length > 4096)) throw fault('INVALID_CONFIG', 'Invalid HTTP signing secret');
    if (value.quickOperations !== undefined && typeof value.quickOperations !== 'boolean') throw fault('INVALID_CONFIG', 'Invalid quickOperations');
    const result = { id, label, type, enabled: value.enabled !== false, token: value.token || '',
        maxPending: integer(value.maxPending, 16, 1, 128, 'node maxPending'),
        ratePerSecond: integer(value.ratePerSecond, 20, 1, 1000, 'node ratePerSecond'),
        burst: integer(value.burst, 40, 1, 2000, 'node burst'),
        eventBufferSize: integer(value.eventBufferSize, 1000, 1, 10000, 'node eventBufferSize'),
        eventMaxAgeMs: integer(value.eventMaxAgeMs, 60000, 1000, 60000, 'node eventMaxAgeMs'),
        heartbeatMs: integer(value.heartbeatMs, 30000, 100, 300000, 'node heartbeatMs'),
        pingTimeoutMs: integer(value.pingTimeoutMs, 10000, 100, 60000, 'node pingTimeoutMs'),
        timeoutMs: integer(value.timeoutMs, 10000, 100, 120000, 'node timeoutMs'),
        reconnectMinMs: integer(value.reconnectMinMs, 1000, 10, 30000, 'node reconnectMinMs'),
        reconnectMaxMs: integer(value.reconnectMaxMs, 30000, 10, 30000, 'node reconnectMaxMs') };
    if (value.secret !== undefined) result.secret = value.secret;
    result.quickOperations = value.quickOperations !== false;
    if (result.reconnectMaxMs < result.reconnectMinMs) throw fault('INVALID_CONFIG', 'Invalid reconnect range');
    const role = value.role === undefined ? 'Universal' : value.role;
    if (!['Universal', 'Api', 'Event'].includes(role)) throw fault('INVALID_CONFIG', 'Invalid node role');
    result.role = role;
    if (type === 'httpPost' || type === 'wsClient') {
        let url;
        try { url = new URL(value.url); } catch (_) { throw fault('INVALID_CONFIG', 'Invalid node URL'); }
        const protocols = type === 'httpPost' ? ['http:', 'https:'] : ['ws:', 'wss:'];
        if (!protocols.includes(url.protocol) || url.username || url.password || url.hash || url.search) throw fault('INVALID_CONFIG', 'Invalid node URL');
        result.url = url.href;
    }
    return result;
}

function loadConfig({ root = path.resolve(__dirname, '..'), file, env = process.env } = {}) {
    const target = path.resolve(root, file || env.FWD_CONFIG || 'config.json');
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('INVALID_CONFIG', 'Configuration must be an object');
    const legacy = value.nodes === undefined;
    if (!legacy && !Array.isArray(value.nodes)) throw fault('INVALID_CONFIG', 'nodes must be an array');
    if (!legacy && value.nodes.length > 64) throw fault('INVALID_CONFIG', 'Too many network nodes');
    const nodes = legacy ? [nodeConfig({ ...value.reverseWs, id: 'legacy', type: 'wsClient' }, 0)] : value.nodes.map(nodeConfig);
    if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw fault('INVALID_CONFIG', 'Duplicate node id');
    function location(name, fallback, override) {
        const text = override || value[name] || fallback;
        if (typeof text !== 'string') throw fault('INVALID_CONFIG', 'Invalid ' + name);
        return workspacePath(root, text);
    }
    const config = { root, file: target,
        rpcDirectory: location('rpcDirectory', 'work/rpc', env.FWD_RPC_DIR),
        dataDirectory: location('dataDirectory', 'work/data'),
        logDirectory: location('logDirectory', 'work/logs'),
        mediaDirectory: location('mediaDirectory', 'work/media'),
        healthFile: location('healthFile', 'work/state/health.json'),
        profileId: identifier(value.profileId, 'default', 'profileId'),
        gatewayPort: integer(value.gatewayPort, 0, 0, 65535, 'gatewayPort'),
        nodes,
        ...(value.authorizationFile !== undefined ? { authorizationFile: location('authorizationFile', value.authorizationFile) } : {}),
        ...(value.mediaSigningKeyFile !== undefined ? { mediaSigningKeyFile: location('mediaSigningKeyFile', value.mediaSigningKeyFile) } : {}),
        actionTimeoutMs: integer(value.actionTimeoutMs, 10000, 100, 120000, 'actionTimeoutMs'),
        mediaActionTimeoutMs: integer(value.mediaActionTimeoutMs, 60000, 100, 60000, 'mediaActionTimeoutMs'),
        eventBufferSize: integer(value.eventBufferSize, 1000, 1, 10000, 'eventBufferSize'),
        eventMaxAgeMs: integer(value.eventMaxAgeMs, 60000, 1000, 60000, 'eventMaxAgeMs'),
        ...(legacy ? { reverseWs: nodes[0] } : {})
    };
    if (value.expectedUin !== undefined && value.expectedUin !== null && value.expectedUin !== '') {
        if (!/^[1-9]\d{0,15}$/.test(String(value.expectedUin)) || !Number.isSafeInteger(Number(value.expectedUin))) throw fault('INVALID_CONFIG', 'Invalid expectedUin');
        config.expectedUin = String(value.expectedUin);
    }
    if (value.mediaBaseUrl !== undefined && value.mediaBaseUrl !== '') {
        let url;
        try { url = new URL(value.mediaBaseUrl); } catch (_) { throw fault('INVALID_CONFIG', 'Invalid mediaBaseUrl'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fault('INVALID_CONFIG', 'Invalid mediaBaseUrl');
        config.mediaBaseUrl = url.href.replace(/\/$/, '');
    }
    return config;
}

module.exports = { loadConfig, nodeConfig };
