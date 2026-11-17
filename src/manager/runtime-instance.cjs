'use strict';

const { equalSecret, fail } = require('./files.cjs');

function runtimeInstance(env = process.env) {
    const instanceId = env.FWD_INSTANCE_ID, token = env.FWD_INSTANCE_TOKEN;
    if (!instanceId && !token) return null;
    if (typeof instanceId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(instanceId) ||
        typeof token !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(token)) {
        throw fail('INVALID_CONFIG', 'Invalid local runtime identity');
    }
    return request => {
        if (request.headers.origin || !equalSecret(request.headers.authorization || '', 'Bearer ' + token)) {
            throw fail('AUTH_REQUIRED', 'Local runtime authorization required', 401);
        }
        return { instanceId, releaseVersion: require('../../package.json').version };
    };
}

module.exports = { runtimeInstance };
