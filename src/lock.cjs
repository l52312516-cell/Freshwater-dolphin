'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, remove, privateDirectory, claimOwner } = require('./ipc/common.cjs');

function acquireLock(directory) {
    privateDirectory(directory);
    const file = path.join(directory, '.adapter-owner.json');
    const instance = crypto.randomUUID();
    claimOwner(file, { instance });
    return () => { try { if (readJson(file).instance === instance) remove(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
}

module.exports = { acquireLock };
