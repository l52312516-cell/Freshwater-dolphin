'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fault } = require('./errors.cjs');

function workspacePath(root, input) {
    if (typeof input !== 'string' || !input) throw fault('INVALID_CONFIG', 'Expected a workspace path');
    const absolute = path.resolve(root, input);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw fault('INVALID_CONFIG', 'Path must remain inside workspace');
    let ancestor = absolute;
    while (!fs.existsSync(ancestor)) {
        // A dangling symlink is not an absent directory which may be created.
        try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw fault('INVALID_CONFIG', 'Workspace path is a dangling symlink'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        ancestor = path.dirname(ancestor);
    }
    const resolved = path.relative(fs.realpathSync(root), fs.realpathSync(ancestor));
    if (resolved.startsWith('..') || path.isAbsolute(resolved)) throw fault('INVALID_CONFIG', 'Path resolves outside workspace');
    return absolute;
}

module.exports = { workspacePath };
