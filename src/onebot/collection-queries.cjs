'use strict';

const { request, validateCollectionPage } = require('../qq/collection-queries.cjs');
const ACTION_REQUIREMENTS = Object.freeze({ get_collection_list: 'collectionList' });
const ACTIONS = new Set(Object.keys(ACTION_REQUIREMENTS));
function problem(code, message) { return Object.assign(new Error(message), { code }); }
async function runCollectionQueries(service, state, action, params) {
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unknown collection action');
    if (!params || typeof params !== 'object' || Array.isArray(params) || ![Object.prototype, null].includes(Object.getPrototypeOf(params)) ||
        Object.keys(params).some(key => !['self_id', 'category', 'count', 'time_stamp'].includes(key))) {
        throw problem('INVALID_PARAMS', 'Unexpected collection action parameters');
    }
    const input = request({ category: params.category, count: params.count, timeStamp: params.time_stamp });
    if (state.capabilities?.collectionList !== true) throw problem('UNSUPPORTED', 'This QQ session has no collection-list query');
    const result = await service.sessionCall(state, 'collectionQuery', input);
    if (!result || result.category !== input.category || result.count !== input.count || result.timeStamp !== input.timeStamp) {
        throw problem('INVALID_RESPONSE', 'QQ returned a different collection query');
    }
    return validateCollectionPage(result.page, input);
}
module.exports = { ACTIONS, ACTION_REQUIREMENTS, REQUIREMENTS: ACTION_REQUIREMENTS, runCollectionQueries };
