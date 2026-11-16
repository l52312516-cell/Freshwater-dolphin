'use strict';

// Explicit gaps in the reference catalog. Presence here never registers a
// business handler or turns a reference placeholder into a successful action.
const REASONS = Object.freeze({
    _get_model_show: 'Reference synthesizes model variants; no verified QQ model query is available.',
    _set_model_show: 'Reference returns success without changing a QQ model.',
    '.get_word_slices': 'Reference does not implement word segmentation.',
    bot_exit: 'An account-scoped persistent shutdown contract is required by the multi-account manager.',
    check_url_safely: 'Reference returns a constant safety level without checking a URL.',
    clean_cache: 'Reference performs no cache cleanup; account data must not be deleted by a placeholder.',
    create_collection: 'Reference does not implement collection creation.',
    get_clientkey: 'Raw QQ authentication material is not exposed by the public adapter.',
    get_cookies: 'Raw QQ authentication material is not exposed by the public adapter.',
    get_credentials: 'Raw QQ authentication material is not exposed by the public adapter.',
    get_csrf_token: 'Raw QQ authentication material is not exposed by the public adapter.',
    get_msg_emoji_likes: 'No verified complete message reaction summary or last reaction time is available; per-emoji paging is separate.',
    nc_get_packet_status: 'Reference returns null without packet statistics.',
    request_decrypt_key: 'Raw protocol decryption keys are not exposed by the public adapter.',
    send_packet: 'Caller-selected raw SSO requests are not exposed; only fixed business protocols are supported.',
    set_restart: 'Reference does not support restart; use the account manager lifecycle controls.',
    set_group_anonymous: 'Reference acknowledges a placeholder without changing anonymous group settings.',
    set_group_anonymous_ban: 'Reference acknowledges a placeholder without banning an anonymous participant.'
});

module.exports = { REASONS };
