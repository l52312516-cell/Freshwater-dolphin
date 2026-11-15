'use strict';

// One 10 MiB image becomes about 14 MiB in a base64 action. Event buffers keep
// their separate smaller bounds; allowing media actions must not enlarge them.
module.exports = { MAX_ACTION_BYTES: 16 * 1024 * 1024 };
