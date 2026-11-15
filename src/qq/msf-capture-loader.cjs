'use strict';

// Opt-in live harness for the MSF capture-first detour addon. NOT imported by
// entry.cjs and NOT exposed over RPC or the network. It is enabled only when a
// disposable, logged-in instance is explicitly prepared for the native merge
// experiment. It installs the observation detour, periodically dumps bounded
// captured records to a caller-validated private directory, and uninstalls on
// close. It never constructs callbacks or sends packets.
//
// UNTESTED-LIVE: the addon (src/native/msf-capture.c) is compiled offline; this
// loader and the detour must first run on a confirmed disposable instance,
// never production legacy.

const fs = require('node:fs');
const path = require('node:path');

const MAX_DUMP_BYTES = 2 * 1024 * 1024;

function startCapture({ addonPath, outDir, intervalMs = 2000, log = () => {} } = {}) {
    if (typeof addonPath !== 'string' || !path.isAbsolute(addonPath)) {
        throw new Error('msf-capture: addonPath must be absolute');
    }
    if (typeof outDir !== 'string' || !path.isAbsolute(outDir)) {
        throw new Error('msf-capture: outDir must be an absolute private directory');
    }
    // The caller is responsible for validating outDir ownership (see
    // forward-diagnostics.cjs). Refuse a symlinked target outright.
    if (fs.lstatSync(outDir).isSymbolicLink()) {
        throw new Error('msf-capture: outDir must not be a symbolic link');
    }
    const addon = require(addonPath);
    const probe = addon.probe();
    if (probe.ok !== 'true' || probe.instanceValid !== 'true') {
        throw new Error('msf-capture: probe failed or MSFCoreService instance invalid: ' + JSON.stringify(probe, replacer));
    }
    const installed = addon.install();
    if (installed.ok !== 'true') {
        throw new Error('msf-capture: install failed: ' + JSON.stringify(installed, replacer));
    }
    log({ phase: 'installed', probe: jsonSafe(probe), installed: jsonSafe(installed) });

    const file = path.join(outDir, 'msf-capture.jsonl');
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    let bytes = 0, closed = false;
    function dump() {
        if (closed) return;
        let records;
        try { records = addon.readCapture(); } catch { return; }
        for (const record of records) {
            const text = JSON.stringify(record, replacer) + '\n';
            const size = Buffer.byteLength(text);
            if (bytes + size > MAX_DUMP_BYTES) { closed = true; break; }
            try { fs.writeSync(fd, text); bytes += size; } catch { closed = true; break; }
        }
    }
    const timer = setInterval(dump, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    function close() {
        if (closed && !timer) return;
        clearInterval(timer);
        try { dump(); } catch {}
        try { addon.uninstall(); } catch (error) { log({ phase: 'uninstall-error', message: String(error) }); }
        try { fs.fsyncSync(fd); } catch {}
        try { fs.closeSync(fd); } catch {}
        closed = true;
        log({ phase: 'closed', bytes });
    }
    return { probe: jsonSafe(probe), close, status: () => jsonSafe(addon.status()) };
}

function replacer(_key, value) {
    return typeof value === 'bigint' ? value.toString() : value;
}
function jsonSafe(value) {
    return JSON.parse(JSON.stringify(value, replacer));
}

module.exports = { startCapture };