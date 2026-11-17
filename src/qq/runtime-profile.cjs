'use strict';

// The package and wrapper identities below describe the historical Linux
// reference, not a Tencent signature. Sources: work/native-final-report-draft-
// 20261116.md and work/qqapi-flash-native-contract-r1-20261116.md.
const BASELINE_PROFILE_ID = 'linux-x64-3.2.35-54395';
const BASELINE = Object.freeze({ profileId: BASELINE_PROFILE_ID, platform: 'linux', architecture: 'x64',
    qqVersion: '3.2.35-54395', packageSha256: '7de03862327abbd16da27130413698c9517782b27194afc593bc3abf9b55f9ac',
    wrapperSha256: 'dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328' });
const BASIC_METHODS = new Set(['status', 'resolve', 'user', 'friends', 'groups', 'groupInfo', 'groupMember', 'groupMembers', 'getMessage', 'history', 'sendMessage']);
const BASIC_FLAGS = new Set(['compatible', 'messages', 'text', 'resolve', 'user', 'friends', 'groups', 'groupInfo', 'groupMember', 'groupMembers', 'history', 'reply', 'wordSlices']);
function invalid() { throw Object.assign(new Error('Invalid QQ runtime selection'), { code: 'INVALID_CONFIG' }); }
function normalizeRuntimeSelection(value, previous) {
    if (value === undefined) value = previous === undefined ? {} : previous;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['packageId', 'profileId', 'experimental'].includes(key))) invalid();
    const packageId = value.packageId === undefined ? previous?.packageId ?? null : value.packageId;
    const profileId = value.profileId === undefined ? previous?.profileId ?? BASELINE_PROFILE_ID : value.profileId;
    const experimental = value.experimental === undefined ? previous?.experimental ?? false : value.experimental;
    if (packageId !== null && (typeof packageId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(packageId)) ||
        typeof profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(profileId) || typeof experimental !== 'boolean') invalid();
    return { packageId, profileId, experimental };
}
function hash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null; }
function evaluateRuntimeIdentity(value = {}) {
    const selection = normalizeRuntimeSelection({ packageId: value.packageId ?? null, profileId: value.profileId ?? BASELINE_PROFILE_ID, experimental: value.experimental ?? false });
    const platform = value.platform || 'unknown', architecture = value.architecture || 'unknown';
    const qqVersion = typeof value.qqVersion === 'string' && /^3\.2\.\d+-[A-Za-z0-9.]+$/.test(value.qqVersion) ? value.qqVersion : null;
    const packageHash = hash(value.packageSha256), wrapperHash = hash(value.wrapperSha256);
    const baselineVersion = platform === 'linux' && architecture === 'x64' && qqVersion === BASELINE.qqVersion && selection.profileId === BASELINE_PROFILE_ID;
    const exact = baselineVersion && packageHash === BASELINE.packageSha256 && wrapperHash === BASELINE.wrapperSha256;
    const conflicting = baselineVersion && (packageHash && packageHash !== BASELINE.packageSha256 || wrapperHash && wrapperHash !== BASELINE.wrapperSha256);
    const legacy = baselineVersion && !conflicting && (!packageHash || !wrapperHash);
    const experimental = platform === 'linux' && architecture === 'x64' && Boolean(qqVersion) && selection.experimental;
    const admission = exact ? 'stable' : legacy ? 'legacy-unverified' : experimental ? 'experimental-basic' : 'denied';
    return { profile_id: selection.profileId, package_id: selection.packageId, platform, architecture, qq_version: qqVersion,
        package_sha256: packageHash, wrapper_sha256: wrapperHash, admission, evidence: exact ? 'exact-build-history' : 'unverified',
        native_eligible: exact, experimental: selection.experimental,
        reason: exact ? 'exact_build_match' : legacy ? 'build_identity_missing' : experimental ? 'experimental_basic_only' :
            platform !== 'linux' || architecture !== 'x64' ? 'guest_platform_unsupported' : conflicting ? 'build_identity_mismatch' : 'version_not_admitted' };
}
function fromEnvironment(env = process.env, overrides = {}) {
    return evaluateRuntimeIdentity({ platform: overrides.platform || process.platform, architecture: overrides.architecture || process.arch,
        qqVersion: env.FWD_QQ_VERSION, packageId: env.FWD_QQ_PACKAGE_ID || null, profileId: env.FWD_QQ_PROFILE_ID || BASELINE_PROFILE_ID,
        experimental: env.FWD_QQ_EXPERIMENTAL === '1', packageSha256: env.FWD_QQ_PACKAGE_SHA256,
        wrapperSha256: env.FWD_QQ_WRAPPER_SHA256, ...overrides });
}
function permitsMethod(profile, method, params = {}) {
    if (method === 'status') return true;
    if (profile.admission === 'denied') return false;
    if (profile.admission !== 'experimental-basic') return true;
    if (!BASIC_METHODS.has(method)) return false;
    // A basic text send must never reach a media/native preparer or accept at,
    // reply, Ark, or other elements through direct bridge RPC.
    if (method === 'sendMessage') return Array.isArray(params.elements) && params.elements.length > 0 && params.elements.every(item =>
        item?.elementType === 1 && item.textElement && item.textElement.atType === 0 && typeof item.textElement.content === 'string' &&
        Object.keys(item).every(key => ['elementType', 'elementId', 'textElement'].includes(key)) &&
        Object.keys(item.textElement).every(key => ['content', 'atType', 'atUid', 'atNtUid'].includes(key)) &&
        !item.textElement.atUid && !item.textElement.atNtUid);
    return true;
}
function limitFlags(profile, flags) {
    if (!['experimental-basic', 'denied'].includes(profile.admission)) return flags;
    return Object.fromEntries(Object.entries(flags).map(([key, value]) => [key, profile.admission !== 'denied' && BASIC_FLAGS.has(key) && value === true]));
}
module.exports = { BASELINE, BASELINE_PROFILE_ID, BASIC_METHODS, normalizeRuntimeSelection, evaluateRuntimeIdentity, fromEnvironment, permitsMethod, limitFlags };
