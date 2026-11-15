'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { read, fail, syncDirectory } = require('./files.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function processTable() {
    const result = new Map();
    for (const name of fs.readdirSync('/proc')) {
        if (!/^[1-9]\d*$/.test(name)) continue;
        try {
            const raw = fs.readFileSync('/proc/' + name + '/stat', 'utf8');
            const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/);
            if (fields[0] !== 'Z') result.set(Number(name), { pid: Number(name), group: Number(fields[2]), startTime: fields[19] });
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    }
    return result;
}
function environment(pid) {
    return fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0');
}
function inspect(base, { table = processTable, environ = environment } = {}) {
    const file = path.join(base, 'state/processes.json');
    if (!fs.existsSync(file)) return { file, ledger: null, owner: null, groups: [] };
    if (fs.lstatSync(file).isSymbolicLink()) throw fail('PROCESS_OWNERSHIP', 'Process ledger cannot be a symbolic link', 503);
    let ledger;
    try { ledger = read(file); } catch (_) { throw fail('PROCESS_OWNERSHIP', 'Invalid process ownership ledger', 503); }
    if (ledger.version !== 1 || ledger.accountRoot !== base || !Number.isInteger(ledger.ownerPid) || ledger.ownerPid <= 1 ||
        !/^[1-9]\d*$/.test(ledger.ownerStartTime) || !Array.isArray(ledger.groups) || ledger.groups.length > 128) {
        throw fail('PROCESS_OWNERSHIP', 'Unknown account process ownership', 503);
    }
    const processes = table();
    const owns = process => {
        try { return environ(process.pid).includes('FWD_ACCOUNT_ROOT=' + base); }
        catch (_) { return false; }
    };
    const owner = processes.get(ledger.ownerPid);
    const liveOwner = owner && owner.startTime === ledger.ownerStartTime ? owner : null;
    if (liveOwner && !owns(liveOwner)) throw fail('PROCESS_OWNERSHIP', 'Account supervisor ownership cannot be verified', 503);
    const groups = [];
    for (const group of ledger.groups) {
        if (!group || !Number.isInteger(group.pid) || group.pid <= 1 || !/^[1-9]\d*$/.test(group.startTime)) throw fail('PROCESS_OWNERSHIP', 'Invalid process group ownership', 503);
        const members = [...processes.values()].filter(item => item.group === group.pid);
        if (!members.length) continue;
        const leader = processes.get(group.pid);
        if ((leader && leader.startTime !== group.startTime) || members.some(member => !owns(member))) {
            throw fail('PROCESS_OWNERSHIP', 'Process group ownership changed; refusing to signal it', 503);
        }
        groups.push(group.pid);
    }
    return { file, ledger, owner: liveOwner, groups };
}
function assertStopped(base) {
    if (process.platform !== 'linux' && fs.existsSync(path.join(base, 'state/processes.json'))) throw fail('PROCESS_OWNERSHIP', 'Process ownership recovery requires Linux', 503);
    const state = inspect(base);
    if (state.owner || state.groups.length) throw fail('ACTIVE_PROCESSES', 'Earlier account processes remain; recover them before continuing', 409);
    if (state.ledger) { fs.unlinkSync(state.file); syncDirectory(path.dirname(state.file)); }
}
async function recover(base) {
    if (process.platform !== 'linux') return assertStopped(base);
    const signal = (state, name, groups) => {
        // Re-read and verify start times plus account environments immediately before every signal.
        const fresh = inspect(base);
        if (fresh.owner) { try { process.kill(fresh.owner.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
        if (groups) for (const group of fresh.groups) {
            try { process.kill(-group, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        return state;
    };
    let state = inspect(base);
    if (!state.ledger) return;
    signal(state, 'SIGTERM', false);
    for (let attempt = 0; attempt < 80; attempt++) {
        state = inspect(base); if (!state.owner && !state.groups.length) return assertStopped(base);
        await pause(250);
    }
    signal(state, 'SIGTERM', true);
    for (let attempt = 0; attempt < 20; attempt++) {
        state = inspect(base); if (!state.owner && !state.groups.length) return assertStopped(base);
        await pause(250);
    }
    signal(state, 'SIGKILL', true);
    for (let attempt = 0; attempt < 12; attempt++) {
        state = inspect(base); if (!state.owner && !state.groups.length) return assertStopped(base);
        await pause(250);
    }
    throw fail('STOP_UNCONFIRMED', 'Account process cleanup could not be confirmed; ledger retained', 503);
}

module.exports = { inspect, assertStopped, recover };
