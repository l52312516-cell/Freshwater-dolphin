'use strict';

function fault(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

module.exports = { fault };
