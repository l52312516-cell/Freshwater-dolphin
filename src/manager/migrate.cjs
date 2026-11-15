'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Accounts } = require('./accounts.cjs');
const { read, atomic, privateDirectory, fail } = require('./files.cjs');
const { workspacePath } = require('../paths.cjs');

function copyTree(from, to) {
    const info = fs.lstatSync(from);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw fail('UNSAFE_FILE', 'Migration refuses links and special files');
    if (info.isDirectory()) {
        fs.mkdirSync(to, { recursive: true, mode: 0o700 });
        for (const name of fs.readdirSync(from)) {
            if (/^(?:Singleton\w*|\.lock)$/.test(name)) continue;
            copyTree(path.join(from, name), path.join(to, name));
        }
    } else fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
}

function migrate(root) {
    const accounts = new Accounts(root);
    if (accounts.document.profiles.length) throw fail('ALREADY_MIGRATED', 'Migration requires an empty account registry');
    const health = read(path.join(root, 'work/state/health.json'), null);
    if (health && Date.now() - health.at < 15000 && health.bridge) throw fail('BUSY', 'Stop the legacy adapter and QQ before migration');
    // QQ can remain alive after a legacy adapter failure: require explicit offline operator acknowledgement.
    if (process.env.FWD_LEGACY_STOPPED !== '1') throw fail('CONFIRM_STOPPED', 'Set FWD_LEGACY_STOPPED=1 only after stopping legacy QQ and the adapter');
    const config = read(path.join(root, 'config.json'));
    const rollback = privateDirectory(root, 'work/migration-rollback-' + crypto.randomBytes(8).toString('hex'));
    copyTree(path.join(root, 'config.json'), path.join(rollback, 'config.json'));
    const item = accounts.create({ id: 'legacy', label: 'Migrated account', nodes: config.nodes || [{ ...config.reverseWs, id: 'legacy', type: 'wsClient' }] });
    const base = accounts.location(item.id);
    const locations = { home: 'work/home', config: 'work/config', data: config.dataDirectory || 'work/data' };
    try {
        for (const [name, input] of Object.entries(locations)) {
            const from = workspacePath(root, input);
            if (!fs.existsSync(from)) continue;
            copyTree(from, path.join(base, name));
        }
        atomic(path.join(rollback, 'migration.json'), { version: 1, profileId: item.id, at: Date.now(), originalDataPreserved: true });
        return { migrated: true, profileId: item.id, rollback, started: false, originalDataPreserved: true };
    } catch (error) {
        accounts.document.profiles = []; accounts.persist();
        // Keep the staged instance for operator inspection, never overwrite original login or ID data.
        throw error;
    }
}
module.exports = { migrate, copyTree };
