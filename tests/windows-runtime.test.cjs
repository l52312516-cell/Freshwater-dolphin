'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { validateManifest, verifyRelease, spacePlan, assetPath } = require('../tools/windows/manifest.cjs');
const { mergeWslConfig, decodeConfig, encodeConfig, prepareConfig, applyConfig } = require('../tools/windows/config.cjs');
const { WindowsRuntime, requestIdentity, checkLoopbackPort, evaluateHost, windowsToWsl, atomic, decodeOutput, execute } = require('../tools/windows/runtime.cjs');
const project = path.resolve(__dirname, '..');
const temp = path.join(project, 'work/temp'); fs.mkdirSync(temp, { recursive: true });
function fixture(t) {
    const root = fs.mkdtempSync(path.join(temp, 'windows 测试-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const make = file => { const bytes = Buffer.from('fixture ' + file); fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), bytes); return { path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }; };
    const files = ['tools/windows/cli.cjs', 'tools/windows/runtime.cjs', 'tools/windows/manifest.cjs', 'tools/windows/config.cjs', 'deploy/windows/supervisor.sh', 'deploy/windows/upgrade.sh', 'Freshwater.cmd'].map(make);
    const manifest = { schemaVersion: 1, platform: 'windows-x64', releaseVersion: '0.2.0-test',
        node: { ...make('runtime/node/node.exe'), version: '22.23.5' },
        alpine: { version: '3.22.1', architecture: 'x86_64', dockerVersion: '28.3.3', composeVersion: '2.36.2', rootfs: { ...make('assets/alpine.tar'), expandedBytes: 1000 } },
        image: { reference: 'freshwater-dolphin:0.2.0-test', id: 'sha256:' + 'a'.repeat(64), archive: make('assets/image.tar'), expandedBytes: 2000 },
        runtime: { distroName: 'FreshwaterDolphin', containerName: 'freshwater-dolphin', hostPort: 4090, guestPort: 4090,
            memoryMiB: 4096, wslMemoryMiB: 6144, processors: 4, swapMiB: 2048, dataBudgetBytes: 3000, stopSeconds: 95 }, files };
    fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify(manifest));
    const host = { build: 19044, memoryBytes: 16 * 1024 ** 3, virtualization: true, slat: true, fileSystem: 'NTFS', freeBytes: 30 * 1024 ** 3,
        systemFreeBytes: 6 * 1024 ** 3, compressed: false, encrypted: false, administrator: false,
        features: { 'Microsoft-Windows-Subsystem-Linux': 'Enabled', VirtualMachinePlatform: 'Enabled' } };
    return { root, manifest, host };
}
function createRuntime(root, options) {
    const runtime = new WindowsRuntime(root, { checkPortAvailable: async () => {}, ...options });
    // Production requires an actual Windows drive path; Linux CI supplies one
    // through the test seam rather than weakening that production validation.
    if (process.platform !== 'win32') runtime.configPlan = () => prepareConfig(runtime.configFile, {
        swapFile: 'E:\\Freshwater Test\\work\\windows\\swap.vhdx', memoryMiB: runtime.runtime.wslMemoryMiB,
        processors: runtime.runtime.processors, swapMiB: runtime.runtime.swapMiB
    });
    return runtime;
}
test('release integrity rejects changed bytes, traversal and non-pinned image identity', async t => {
    const { root, manifest } = fixture(t); assert.equal(await verifyRelease(root, manifest), true);
    fs.appendFileSync(path.join(root, manifest.image.archive.path), 'changed');
    await assert.rejects(verifyRelease(root, manifest), /verification failed/);
    assert.throws(() => assetPath(root, '../escape'), /unsafe/);
    assert.throws(() => assetPath(root, 'C:/escape'), /unsafe/);
    assert.throws(() => validateManifest({ ...manifest, image: { ...manifest.image, id: 'latest' } }), /identity/);
    assert.throws(() => validateManifest({ ...manifest, files: [] }), /files missing/);
});
test('space budget counts expanded data and future swap, without counting already-present archives twice', t => {
    const { manifest } = fixture(t); const plan = spacePlan(manifest);
    assert.equal(plan.requiredFreeBytes, 1000 + 2000 + 2048 * 1024 ** 2 + 3000 + 5 * 1024 ** 3);
    assert.equal(spacePlan(manifest, { installed: true }).rootfsBytes, 0);
});
test('WSL config merge preserves unrelated sections/settings and BOM while changing only the approved limits', () => {
    const original = '; user comment\r\n[wsl2]\r\nnetworkingMode=nat\r\nMEMORY=8GB\r\nlocalhostForwarding=true\r\n[experimental]\r\nfoo=bar\r\n';
    const next = mergeWslConfig(original, { swapFile: 'E:\\Freshwater Space\\work\\swap.vhdx', memoryMiB: 6144, processors: 4, swapMiB: 2048 });
    assert.match(next, /; user comment\r\n/); assert.match(next, /networkingMode=nat/); assert.match(next, /memory=6144MB/);
    assert.match(next, /swapFile=E:\\\\Freshwater Space\\\\work\\\\swap.vhdx/);
    assert.match(next, /localhostForwarding=true/); assert.match(next, /\[experimental\]\r\nfoo=bar/);
    const encoded = encodeConfig(next, { encoding: 'utf16le', bom: true });
    assert.deepEqual(decodeConfig(encoded), { text: next, encoding: 'utf16le', bom: true });
    assert.throws(() => mergeWslConfig('[wsl2]\nlocalhostForwarding=false\n', { swapFile: 'E:\\swap.vhdx', memoryMiB: 6144, processors: 4, swapMiB: 2048 }), /localhostForwarding=false/);
    assert.throws(() => mergeWslConfig('[wsl2]\nmemory=4GB\n[wsl2]\n', { swapFile: 'E:\\swap.vhdx', memoryMiB: 6144, processors: 4, swapMiB: 2048 }), /Duplicate/);
});
test('preview cannot overwrite a concurrently changed .wslconfig; backup preserves original bytes', t => {
    const { root } = fixture(t); const file = path.join(root, '.wslconfig'); const backups = path.join(root, 'work/backups');
    fs.writeFileSync(file, '[wsl2]\nfoo=bar\n');
    const settings = { swapFile: 'E:\\Freshwater\\swap.vhdx', memoryMiB: 6144, processors: 4, swapMiB: 2048 };
    const plan = prepareConfig(file, settings); fs.appendFileSync(file, '; new user edit\n');
    assert.throws(() => applyConfig(plan, backups), /changed after preview/); assert.equal(fs.existsSync(backups), false);
    const updatedPlan = prepareConfig(file, settings); const original = fs.readFileSync(file); const backup = applyConfig(updatedPlan, backups);
    assert.deepEqual(fs.readFileSync(backup), original); assert.match(fs.readFileSync(file, 'utf8'), /; new user edit/);
});
test('host precheck uses physical volume free space and diagnoses compressed VHDX directories', t => {
    const { manifest, host } = fixture(t); const plan = spacePlan(manifest);
    assert.equal(evaluateHost(host, manifest, plan).errors.length, 0);
    assert.match(evaluateHost({ ...host, freeBytes: 1000 }, manifest, plan).errors.join(), /space/);
    assert.match(evaluateHost({ ...host, compressed: true }, manifest, plan).errors.join(), /NTFS/);
    assert.equal(evaluateHost(host, manifest, plan).warnings.length, 1);
    assert.equal(windowsToWsl('E:\\Freshwater Space\\file.tar'), '/mnt/e/Freshwater Space/file.tar');
    assert.throws(() => windowsToWsl('\\\\server\\share'), /local Windows/);
    assert.equal(decodeOutput(Buffer.from('FreshwaterDolphin\r\n', 'utf16le')), 'FreshwaterDolphin\r\n');
});
test('loopback readiness requires token and matching instance/release, rather than any HTTP listener', async t => {
    const instanceId = 'b'.repeat(32), token = 'c'.repeat(64); let value = { instanceId: 'wrong', releaseVersion: 'v1' };
    const server = http.createServer((req, res) => {
        assert.equal(req.url, '/api/runtime/instance'); assert.equal(req.headers.authorization, 'Bearer ' + token);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    const options = { port: server.address().port, instanceId, token, releaseVersion: 'v1' };
    await assert.rejects(requestIdentity(options), /identity mismatch/);
    value = { instanceId, releaseVersion: 'old' }; await assert.rejects(requestIdentity(options), /identity mismatch/);
    value.releaseVersion = 'v1'; assert.deepEqual(await requestIdentity(options), value);
});
test('cancelled installer performs no config write, import, guest launch, or OS feature mutation', async t => {
    const { root, manifest, host } = fixture(t); const calls = [];
    const runtime = createRuntime(root, { manifest, platform: 'win32', arch: 'x64', nodeVersion: '22.23.5', configFile: path.join(root, '.wslconfig'),
        output() {}, execute: async (file, args) => { calls.push({ file, args }); return { stdout: file.endsWith('powershell.exe') ? JSON.stringify(host) : '', stderr: '', code: 0 }; } });
    await assert.rejects(runtime.install(async () => false), /cancelled/);
    assert.equal(fs.existsSync(runtime.configFile), false);
    assert.equal(fs.existsSync(runtime.stateFile), false);
    assert.ok(calls.every(call => !call.args.includes('--import') && !call.args.includes('--exec') && !call.args.some(arg => arg.includes('/enable-feature'))));
});
test('insufficient disk prevents installation before confirmation, and foreign distro cannot be adopted', async t => {
    const { root, manifest, host } = fixture(t); let confirmed = false; let free = 1; let occupied = false;
    const runtime = createRuntime(root, { manifest, platform: 'win32', arch: 'x64', nodeVersion: '22.23.5', configFile: path.join(root, '.wslconfig'), output() {},
        execute: async (file, args) => ({ stdout: file.endsWith('powershell.exe') ? JSON.stringify({ ...host, freeBytes: free }) : occupied && !args.includes('--running') ? 'FreshwaterDolphin\r\n' : '', stderr: '', code: 0 }) });
    const confirm = async () => { confirmed = true; return true; };
    await assert.rejects(runtime.install(confirm), /Insufficient project-volume space/); assert.equal(confirmed, false);
    free = host.freeBytes; occupied = true;
    await assert.rejects(runtime.install(confirm), /already occupied/); assert.equal(confirmed, false);
});
test('status/stop do not start a stopped distro and stop argv stays inside the owned distro', async t => {
    const { root, manifest } = fixture(t); const calls = []; let running = false;
    const state = { version: 1, instanceId: 'b'.repeat(32), token: 'c'.repeat(64), installed: true, distroName: 'FreshwaterDolphin' };
    const runtime = createRuntime(root, { manifest, output() {}, execute: async (file, args) => {
        calls.push(args); return { stdout: args.includes('--list') ? running ? 'FreshwaterDolphin\n' : '' : args.includes('stop') ?
            JSON.stringify({ instanceId: state.instanceId, stopped: true, confirmed: true }) : JSON.stringify({ instanceId: state.instanceId, confirmed: true, running: false, daemonRunning: false }), code: 0, stderr: '' };
    } });
    atomic(runtime.stateFile, state);
    assert.deepEqual(await runtime.status(), { installed: true, running: false }); await runtime.stop();
    assert.ok(calls.every(args => args.includes('--list')));
    running = true; await runtime.stop();
    const stop = calls.find(args => args.includes('stop')); assert.deepEqual(stop, ['--distribution', 'FreshwaterDolphin', '--user', 'root', '--exec', '/opt/freshwater/supervisor.sh', 'stop', state.instanceId]);
    assert.ok(calls.every(args => !args.includes('--shutdown') && !args.includes('--unregister')));
});
test('approved installation imports into project VHDX and uses fixed argv without starting QQ or Docker', { skip: process.platform !== 'win32' }, async t => {
    const { root, manifest, host } = fixture(t); const calls = [], output = [];
    const runtime = createRuntime(root, { manifest, platform: 'win32', arch: 'x64', nodeVersion: '22.23.5', configFile: path.join(root, '.wslconfig'),
        output: value => output.push(value), execute: async (file, args) => {
            calls.push({ file, args });
            return { stdout: file.endsWith('powershell.exe') ? JSON.stringify(host) : '', code: 0, stderr: '' };
        } });
    assert.deepEqual(await runtime.install(async () => true), { installed: true });
    const state = JSON.parse(fs.readFileSync(runtime.stateFile, 'utf8'));
    assert.equal(state.installed, true); assert.equal(state.imageId, manifest.image.id);
    const imported = calls.find(call => call.args.includes('--import'));
    assert.deepEqual(imported.args, ['--import', manifest.runtime.distroName, path.join(root, 'work/windows/distro'), path.join(root, 'assets/alpine.tar'), '--version', '2']);
    assert.ok(calls.some(call => call.args.includes('/bin/sh') && call.args.includes('install')));
    assert.ok(calls.some(call => call.args.includes('configure')));
    assert.ok(calls.every(call => !call.args.includes('serve') && !call.args.includes('--shutdown') && !call.args.includes('--unregister')));
    assert.ok(!output.join('\n').includes(state.token));
    assert.match(fs.readFileSync(runtime.configFile, 'utf8'), /swap=2048MB/);
});
test('foreground host sends heartbeat, handles Ctrl+C idempotently, and removes its signal handlers', async t => {
    const { root, manifest } = fixture(t); const calls = [], frames = [], spawned = [];
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on('data', chunk => frames.push(chunk.toString())); child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
    const before = process.listenerCount('SIGINT');
    let activations = 0;
    const runtime = createRuntime(root, { manifest, deferAccounts: true, activateRuntime: async value => { activations++; assert.equal(value.instanceId, 'b'.repeat(32)); return { ...value, activated: true }; }, output() {},
        spawn: (file, args, options) => { spawned.push({ file, args, options }); return child; },
        requestIdentity: async () => { setImmediate(() => { process.emit('SIGINT'); process.emit('SIGINT'); }); return { instanceId: 'b'.repeat(32), releaseVersion: manifest.releaseVersion }; },
        execute: async (file, args) => { calls.push(args); return { stdout: args.includes('--list') ? 'FreshwaterDolphin\n' : args.includes('setup-token') ? '' :
            args.includes('stop') ? JSON.stringify({ instanceId: 'b'.repeat(32), stopped: true, confirmed: true }) :
                JSON.stringify({ instanceId: 'b'.repeat(32), confirmed: true, running: false, daemonRunning: false }), code: 0, stderr: '' }; } });
    atomic(runtime.stateFile, { version: 1, instanceId: 'b'.repeat(32), token: 'c'.repeat(64), installed: true,
        releaseVersion: manifest.releaseVersion, imageId: manifest.image.id, rootfsSha256: manifest.alpine.rootfs.sha256, distroName: manifest.runtime.distroName });
    await runtime.start({ noOpen: true });
    assert.equal(spawned.length, 1); assert.equal(spawned[0].options.shell, false);
    assert.deepEqual(spawned[0].args.slice(-3), ['/opt/freshwater/supervisor.sh', 'serve', 'b'.repeat(32)]);
    assert.ok(frames.includes('PING\n')); assert.equal(frames.filter(frame => frame === 'STOP\n').length, 1);
    assert.equal(activations, 1);
    assert.equal(calls.filter(args => args.includes('stop')).length, 1);
    assert.equal(process.listenerCount('SIGINT'), before);
});
test('open rejects a foreign loopback listener before opening a browser, and only opens the validated local URL', async t => {
    const { root, manifest } = fixture(t); const browsers = []; let allowed = false;
    const runtime = createRuntime(root, { manifest, output() {},
        requestIdentity: async () => { if (!allowed) throw new Error('identity mismatch'); return {}; },
        execute: async () => ({ stdout: 'FreshwaterDolphin\n', code: 0, stderr: '' }),
        spawn: (file, args) => { const child = new EventEmitter(); child.unref = () => {}; browsers.push({ file, args }); return child; } });
    atomic(runtime.stateFile, { version: 1, instanceId: 'b'.repeat(32), token: 'c'.repeat(64), installed: true });
    await assert.rejects(runtime.open(), /identity mismatch/); assert.equal(browsers.length, 0);
    allowed = true; await runtime.open(); assert.equal(browsers.length, 1);
    assert.deepEqual(browsers[0].args, ['http://127.0.0.1:4090/']); assert.match(browsers[0].file, /explorer\.exe$/);
});
test('disabled WSL features are enabled only after approval without invoking an unavailable WSL feature first', async t => {
    const { root, manifest, host } = fixture(t); const calls = [];
    const disabled = { ...host, administrator: true, features: { 'Microsoft-Windows-Subsystem-Linux': 'Disabled', VirtualMachinePlatform: 'Disabled' } };
    const runtime = createRuntime(root, { manifest, platform: 'win32', arch: 'x64', nodeVersion: '22.23.5', configFile: path.join(root, '.wslconfig'), output() {},
        execute: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: file.endsWith('powershell.exe') ? JSON.stringify(disabled) : '', code: 3010, stderr: '' }; } });
    assert.deepEqual(await runtime.install(async () => true), { rebootRequired: true });
    assert.equal(calls.filter(call => call.file.endsWith('wsl.exe')).length, 0);
    const enable = calls.filter(call => call.file.endsWith('dism.exe')); assert.equal(enable.length, 2);
    assert.ok(enable.every(call => call.args.includes('/norestart') && call.options.allowedExitCodes.includes(3010)));
    assert.equal(fs.existsSync(runtime.stateFile), false);
});
test('host stop rejects zero-exit false acknowledgements and a daemon that remains running', async t => {
    const { root, manifest } = fixture(t); let acknowledgement = { stopped: true }; let daemonRunning = true;
    const instanceId = 'b'.repeat(32);
    const runtime = createRuntime(root, { manifest, output() {}, execute: async (file, args) => ({ stdout: args.includes('--list') ? 'FreshwaterDolphin\n' :
        args.includes('stop') ? JSON.stringify(acknowledgement) : JSON.stringify({ instanceId, confirmed: true, running: false, daemonRunning }), code: 0, stderr: '' }) });
    atomic(runtime.stateFile, { version: 1, instanceId, token: 'c'.repeat(64), installed: true });
    await assert.rejects(runtime.stop(), /acknowledgement is unconfirmed/);
    acknowledgement = { instanceId, stopped: true, confirmed: true };
    await assert.rejects(runtime.stop(), /still running or stop cannot be confirmed/);
    daemonRunning = false; assert.deepEqual(await runtime.stop(), { stopped: true, confirmed: true });
});
test('repeated start checks authenticated identity and returns without a second supervisor', async t => {
    const { root, manifest } = fixture(t); let handshakes = 0;
    const instanceId = 'b'.repeat(32);
    let activations = 0;
    const runtime = createRuntime(root, { manifest, deferAccounts: true, activateRuntime: async () => { activations++; return { instanceId, releaseVersion: manifest.releaseVersion, activated: true }; }, output() {}, requestIdentity: async () => { handshakes++; return { instanceId, releaseVersion: manifest.releaseVersion }; },
        spawn: () => { throw new Error('must not spawn another foreground process'); }, execute: async (file, args) => ({
            stdout: args.includes('--list') ? 'FreshwaterDolphin\n' : JSON.stringify({ instanceId, confirmed: true, running: true, daemonRunning: true, supervisorRunning: true }), code: 0, stderr: '' }) });
    atomic(runtime.stateFile, { version: 1, instanceId, token: 'c'.repeat(64), installed: true, releaseVersion: manifest.releaseVersion, imageId: manifest.image.id, rootfsSha256: manifest.alpine.rootfs.sha256 });
    const result = await runtime.start({ noOpen: true });
    assert.equal(result.alreadyRunning, true); assert.ok(handshakes >= 1); assert.equal(activations, 1);
});
test('existing ownership/rootfs mismatch is rejected before changing config or requesting approval', async t => {
    const { root, manifest, host } = fixture(t); const configFile = path.join(root, '.wslconfig'); fs.writeFileSync(configFile, '[wsl2]\nmemory=8GB\n');
    let confirmed = false; const instanceId = 'b'.repeat(32);
    const runtime = createRuntime(root, { manifest, platform: 'win32', arch: 'x64', nodeVersion: '22.23.5', configFile, output() {},
        execute: async (file, args) => ({ stdout: file.endsWith('powershell.exe') ? JSON.stringify(host) : args.includes('--list') ? args.includes('--running') ? '' : 'FreshwaterDolphin\n' : 'foreign-owner\n', code: 0, stderr: '' }) });
    const state = { version: 1, instanceId, token: 'c'.repeat(64), installed: true, rootfsSha256: manifest.alpine.rootfs.sha256 };
    atomic(runtime.stateFile, state); const original = fs.readFileSync(configFile);
    const confirm = async () => { confirmed = true; return true; };
    await assert.rejects(runtime.install(confirm), /ownership mismatch/); assert.equal(confirmed, false); assert.deepEqual(fs.readFileSync(configFile), original);
    atomic(runtime.stateFile, { ...state, rootfsSha256: 'f'.repeat(64) });
    await assert.rejects(runtime.install(confirm), /rootfs differs/); assert.equal(confirmed, false); assert.deepEqual(fs.readFileSync(configFile), original);
});
test('foreground shutdown failures remain failures after Ctrl+C and nonzero guest exit', async t => {
    const { root, manifest } = fixture(t); const instanceId = 'b'.repeat(32); const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.resume(); child.stdin.on('finish', () => setImmediate(() => child.emit('close', 1)));
    const runtime = createRuntime(root, { manifest, output() {}, spawn: () => child,
        requestIdentity: async () => { setImmediate(() => process.emit('SIGINT')); return { instanceId, releaseVersion: manifest.releaseVersion }; },
        execute: async (file, args) => {
            if (args.includes('stop')) throw new Error('stop state unconfirmed');
            return { stdout: args.includes('--list') ? 'FreshwaterDolphin\n' : args.includes('setup-token') ? '' : JSON.stringify({ instanceId, running: false, confirmed: true, daemonRunning: false }), code: 0, stderr: '' };
        } });
    atomic(runtime.stateFile, { version: 1, instanceId, token: 'c'.repeat(64), installed: true, releaseVersion: manifest.releaseVersion, imageId: manifest.image.id, rootfsSha256: manifest.alpine.rootfs.sha256 });
    await assert.rejects(runtime.start({ noOpen: true }), /unconfirmed/);
});
test('host command timeout bounds a hung child process', async () => {
    const started = Date.now();
    await assert.rejects(execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 150 }), /timed out/);
    assert.ok(Date.now() - started < 5000);
});
function oldRuntimeState(manifest) {
    return { version: 1, instanceId: 'b'.repeat(32), token: 'c'.repeat(64), installed: true, distroName: manifest.runtime.distroName,
        importPhase: 'ready', releaseVersion: '0.1.0-old', imageId: 'sha256:' + 'd'.repeat(64), rootfsSha256: manifest.alpine.rootfs.sha256 };
}
function transactionRuntime(t, { phase = 'prepared', failStop = false, failCommit = false, failActivate = false, failHandshake = false } = {}) {
    const { root, manifest } = fixture(t); const previous = oldRuntimeState(manifest); const operations = [];
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.resume(); child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
    let currentPhase = phase, live = false;
    const runtime = createRuntime(root, { manifest, deferAccounts: true, startupTimeoutMs: 25, startupPollMs: 5,
        statfs: () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }), output() {}, spawn: () => { live = true; return child; },
        requestIdentity: async () => { if (failHandshake) throw new Error('handshake failure'); return { instanceId: previous.instanceId, releaseVersion: manifest.releaseVersion }; },
        activateRuntime: async () => { operations.push('activate'); if (failActivate) throw new Error('activation result unknown'); setImmediate(() => process.emit('SIGINT')); return { activated: true }; },
        execute: async (file, args) => {
            if (args.includes('upgrade')) {
                const op = args[args.indexOf('upgrade') + 1]; operations.push(op);
                if (op === 'commit') { currentPhase = 'committed'; if (failCommit) throw new Error('commit response lost'); }
                if (op === 'rollback') currentPhase = 'rolled_back';
                return { stdout: JSON.stringify({ instanceId: previous.instanceId, phase: currentPhase, confirmed: !['preparing', 'rolling_back'].includes(currentPhase), snapshotAvailable: ['prepared', 'committed'].includes(currentPhase), workSizeBytes: 1024 }), code: 0, stderr: '' };
            }
            return { stdout: args.includes('--list') ? live ? 'FreshwaterDolphin\n' : '' : args.includes('setup-token') ? '' :
                JSON.stringify({ instanceId: previous.instanceId, running: false, daemonRunning: false, supervisorRunning: false, confirmed: true }), code: 0, stderr: '' };
        } });
    runtime.stop = async () => { operations.push('stop'); if (failStop) throw new Error('shutdown unconfirmed'); live = false; return { stopped: true, confirmed: true }; };
    runtime.waitStopped = async () => { if (failStop) throw new Error('shutdown unconfirmed'); };
    const state = { ...structuredClone(previous), releaseVersion: manifest.releaseVersion, imageId: manifest.image.id,
        pendingUpgrade: { previous: structuredClone(previous), targetImageId: manifest.image.id, phase: 'configured' } };
    atomic(runtime.stateFile, state);
    return { root, manifest, previous, runtime, state, operations, child };
}
test('interrupted preparing/rolling_back upgrade status is recoverable, and committed status never rolls back', async t => {
    for (const phase of ['preparing', 'rolling_back', 'committed']) {
        const f = transactionRuntime(t, { phase });
        const recovered = await f.runtime.recoverUpgrade(f.state);
        assert.equal(recovered.imageId, phase === 'committed' ? f.manifest.image.id : f.previous.imageId);
        assert.equal(Boolean(recovered.pendingUpgrade), false);
        assert.equal(f.operations.includes('rollback'), phase !== 'committed');
        assert.ok(f.operations.indexOf('stop') < f.operations.indexOf('status'));
    }
});
test('new release handshake failure stops with confirmation before restoring old data and state', async t => {
    const f = transactionRuntime(t, { failHandshake: true });
    await assert.rejects(f.runtime.start({ noOpen: true }), /handshake/);
    assert.ok(f.operations.indexOf('stop') < f.operations.indexOf('rollback'));
    assert.equal(f.operations.includes('commit'), false); assert.equal(f.operations.includes('activate'), false);
    assert.equal(JSON.parse(fs.readFileSync(f.runtime.stateFile)).imageId, f.previous.imageId);
});
test('failed stop blocks automatic rollback and preserves pending upgrade evidence', async t => {
    const f = transactionRuntime(t, { failHandshake: true, failStop: true });
    await assert.rejects(f.runtime.start({ noOpen: true }), /automatic rollback blocked/);
    assert.equal(f.operations.includes('rollback'), false);
    assert.ok(JSON.parse(fs.readFileSync(f.runtime.stateFile)).pendingUpgrade);
});
test('lost commit reply consults committed guest state and never restores an old account snapshot', async t => {
    const f = transactionRuntime(t, { failCommit: true });
    await assert.rejects(f.runtime.start({ noOpen: true }), /commit response lost/);
    assert.equal(f.operations.includes('rollback'), false);
    const state = JSON.parse(fs.readFileSync(f.runtime.stateFile)); assert.equal(state.imageId, f.manifest.image.id); assert.equal(state.pendingUpgrade, undefined);
    assert.equal(f.operations.includes('activate'), false);
});
test('unknown activation result after commit stops the new runtime without automatic rollback', async t => {
    const f = transactionRuntime(t, { failActivate: true });
    await assert.rejects(f.runtime.start({ noOpen: true }), /activation result unknown/);
    assert.ok(f.operations.indexOf('commit') < f.operations.indexOf('activate'));
    assert.equal(f.operations.includes('rollback'), false);
    const state = JSON.parse(fs.readFileSync(f.runtime.stateFile)); assert.equal(state.imageId, f.manifest.image.id); assert.equal(state.pendingUpgrade, undefined);
});
test('snapshot budget uses measured work size and physical host space, including a five GiB reserve', t => {
    const f = transactionRuntime(t); f.runtime.options.statfs = () => ({ bavail: 8 * 1024 ** 3, bsize: 1 });
    assert.throws(() => f.runtime.snapshotSpace(4 * 1024 ** 3), /Insufficient host space/);
    assert.equal(f.runtime.snapshotSpace(1024), 5 * 1024 ** 3 + 1024);
    assert.throws(() => f.runtime.snapshotSpace(undefined), /cannot be measured/);
});
test('cold install stops only the approved running instance and preserves the exact previous state for rollback', { skip: process.platform !== 'win32' }, async t => {
    const { root, manifest, host } = fixture(t); const previous = oldRuntimeState(manifest); const operations = []; let running = true, phase = 'none';
    const runtime = createRuntime(root, { manifest, platform: 'win32', arch: 'x64', nodeVersion: '22.23.5', configFile: path.join(root, '.wslconfig'),
        statfs: () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }), output() {}, execute: async (file, args) => {
            if (file.endsWith('powershell.exe')) return { stdout: JSON.stringify(host), code: 0, stderr: '' };
            if (args.includes('--list')) return { stdout: args.includes('--running') ? running ? 'FreshwaterDolphin\n' : '' : 'FreshwaterDolphin\n', code: 0, stderr: '' };
            if (args.includes('/bin/cat')) return { stdout: previous.instanceId + '\n', code: 0, stderr: '' };
            if (args.includes('stop')) { operations.push('stop'); running = false; return { stdout: JSON.stringify({ instanceId: previous.instanceId, stopped: true, confirmed: true }), code: 0, stderr: '' }; }
            if (args.includes('upgrade')) {
                const op = args[args.indexOf('upgrade') + 1]; operations.push(op); if (op === 'prepare') phase = 'prepared';
                return { stdout: JSON.stringify({ instanceId: previous.instanceId, phase, confirmed: true, snapshotAvailable: phase === 'prepared', workSizeBytes: 10 * 1024 ** 3 }), code: 0, stderr: '' };
            }
            if (args.includes('configure')) operations.push('configure');
            return { stdout: JSON.stringify({ instanceId: previous.instanceId, running: false, daemonRunning: false, supervisorRunning: false, confirmed: true }), code: 0, stderr: '' };
        } });
    fs.writeFileSync(runtime.configFile, runtime.configPlan().next); atomic(runtime.stateFile, previous);
    let approved = false;
    const result = await runtime.install(async () => { assert.equal(operations.includes('stop'), false); approved = true; return true; });
    assert.equal(approved, true); assert.equal(result.installed, true);
    assert.ok(operations.indexOf('stop') < operations.indexOf('prepare')); assert.ok(operations.indexOf('prepare') < operations.indexOf('configure'));
    const state = JSON.parse(fs.readFileSync(runtime.stateFile)); assert.deepEqual(state.pendingUpgrade.previous, previous);
    assert.equal(state.pendingUpgrade.phase, 'configured'); assert.equal(state.imageId, manifest.image.id); assert.equal(state.releaseVersion, manifest.releaseVersion);
});
test('pending upgrade blocks open and a second foreground start from activating accounts', async t => {
    const f = transactionRuntime(t); let activated = false;
    f.runtime.activate = async () => { activated = true; throw new Error('must not activate'); };
    await assert.rejects(f.runtime.open(), /Upgrade verification is pending/);
    f.runtime.status = async () => ({ running: true, supervisorRunning: true, confirmed: true });
    await assert.rejects(f.runtime.start({ noOpen: true }), /already running in another foreground terminal/);
    assert.equal(activated, false); assert.equal(f.operations.includes('commit'), false); assert.equal(f.operations.includes('rollback'), false);
});
test('start --previous verifies and activates the restored release version rather than the current package version', async t => {
    const { root, manifest } = fixture(t); const previous = oldRuntimeState(manifest); const versions = [];
    const runtime = createRuntime(root, { manifest, deferAccounts: true, output() {},
        requestIdentity: async options => { versions.push(options.releaseVersion); return { instanceId: previous.instanceId, releaseVersion: previous.releaseVersion }; },
        activateRuntime: async options => { versions.push(options.releaseVersion); return { activated: true }; },
        execute: async (file, args) => ({ stdout: args.includes('--list') ? 'FreshwaterDolphin\n' :
            JSON.stringify({ instanceId: previous.instanceId, running: true, daemonRunning: true, supervisorRunning: true, confirmed: true }), code: 0, stderr: '' }),
        spawn: () => { throw new Error('must reuse running previous image'); } });
    atomic(runtime.stateFile, previous);
    const result = await runtime.start({ previous: true, noOpen: true });
    assert.equal(result.alreadyRunning, true); assert.ok(versions.every(value => value === previous.releaseVersion));
});
test('an occupied loopback port fails immediately before spawning the WSL supervisor', async t => {
    const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => listener.close(resolve)));
    const { root, manifest } = fixture(t); manifest.runtime.hostPort = listener.address().port;
    let spawned = false, checked = false;
    const runtime = createRuntime(root, { manifest, output() {}, checkPortAvailable: async port => { checked = true; await checkLoopbackPort(port); },
        execute: async () => ({ stdout: '', code: 0, stderr: '' }), spawn: () => { spawned = true; throw new Error('must not spawn'); } });
    atomic(runtime.stateFile, { ...oldRuntimeState(manifest), releaseVersion: manifest.releaseVersion, imageId: manifest.image.id });
    await assert.rejects(runtime.start({ noOpen: true }), error => error.code === 'EADDRINUSE' && error.message.includes('127.0.0.1:' + listener.address().port) && /already in use/.test(error.message));
    assert.equal(checked, true); assert.equal(spawned, false);
});
test('loopback availability probe closes its listener before a caller binds the same port', async () => {
    const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    await checkLoopbackPort(port);
    const reused = net.createServer();
    try { await new Promise((resolve, reject) => { reused.once('error', reject); reused.listen(port, '127.0.0.1', resolve); }); }
    finally { if (reused.listening) await new Promise(resolve => reused.close(resolve)); }
});
