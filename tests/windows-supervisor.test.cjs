'use strict';
// Executes the production POSIX supervisor with fake Docker executables on Linux.
// No WSL, Docker daemon, QQ, mounts, or system configuration is used by this test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '..');
const supported = process.platform === 'linux' && spawnSync('/bin/sh', ['-c', 'command -v flock >/dev/null && command -v python3 >/dev/null'], { encoding: 'utf8' }).status === 0;
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
function setup(t, extraEnv = {}) {
    const temp = path.join(project, 'work/temp'); fs.mkdirSync(temp, { recursive: true });
    const root = fs.mkdtempSync(path.join(temp, 'supervisor-mock-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const name of ['base/work', 'base/logs', 'conf', 'run', 'bin']) fs.mkdirSync(path.join(root, name), { recursive: true });
    const instance = 'a'.repeat(32), image = 'sha256:' + 'b'.repeat(64);
    fs.writeFileSync(path.join(root, 'conf/owner'), instance + '\n');
    fs.writeFileSync(path.join(root, 'conf/runtime.env'), `INSTANCE_ID=${quote(instance)}\nINSTANCE_TOKEN=${quote('c'.repeat(64))}\nRELEASE_VERSION='test'\nCONTAINER_NAME='freshwater-test'\nIMAGE_ID=${quote(image)}\nIMAGE_REFERENCE='freshwater:test'\nIMAGE_ARCHIVE='/unused-offline-archive'\nHOST_PORT=4090\nGUEST_PORT=4090\nMEMORY_MIB=4096\nPROCESSORS=4\nSTOP_SECONDS=95\n`);
    let script = fs.readFileSync(path.join(project, 'deploy/windows/supervisor.sh'), 'utf8');
    script = script.replace(/^BASE=.*$/m, 'BASE=' + quote(path.join(root, 'base')))
        .replace(/^CONF=.*$/m, 'CONF=' + quote(path.join(root, 'conf'))).replace(/^RUN=.*$/m, 'RUN=' + quote(path.join(root, 'run')));
    const scriptFile = path.join(root, 'supervisor.sh'); fs.writeFileSync(scriptFile, script);
    const docker = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$MOCK_ROOT/commands"
case "$1" in
info) if [ -f "$MOCK_ROOT/hang-info" ]; then sleep 30; fi; [ -f "$MOCK_ROOT/daemon-ready" ] && [ ! -f "$MOCK_ROOT/daemon-stop" ] || exit 1; [ "$#" -eq 1 ] || echo overlay2;;
container) if [ -f "$MOCK_ROOT/container-started" ]; then echo freshwater-test; fi;;
image) case "$*" in *--format*) echo '${image}';; esac;;
inspect) case "$*" in *io.freshwater.instance*) echo '${instance}';; *State.Running*) [ -f "$MOCK_ROOT/container-started" ] && [ ! -f "$MOCK_ROOT/container-stopped" ] && echo true || echo false;; esac;;
run) touch "$MOCK_ROOT/container-started"; echo fake-container;;
stop) [ "${'${MOCK_FAIL_STOP:-0}'}" -eq 0 ] || exit 1; touch "$MOCK_ROOT/container-stopped" "$MOCK_ROOT/daemon-stop";;
rm) :;;
*) echo unexpected-docker-command >&2; exit 1;;
esac
`;
    const daemon = `#!/usr/bin/env python3
import ctypes, os, signal, sys, time
# Exercise the production /proc identity check using a harmless fake daemon.
ctypes.CDLL(None).prctl(15, b'dockerd', 0, 0, 0)
root=os.environ['MOCK_ROOT']
with open(root+'/run/docker.pid','w') as f: f.write(str(os.getpid()))
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
with open(root+'/daemon-ready','w'): pass
while not os.path.exists(root+'/daemon-stop'): time.sleep(0.05)
`;
    for (const [name, text] of [['docker', docker], ['dockerd', daemon], ['chown', '#!/bin/sh\nexit 0\n']]) { fs.writeFileSync(path.join(root, 'bin', name), text); fs.chmodSync(path.join(root, 'bin', name), 0o700); }
    const child = spawn('/bin/sh', [scriptFile, 'serve', instance], { detached: true, env: { ...process.env, ...extraEnv, MOCK_ROOT: root, PATH: path.join(root, 'bin') + ':' + process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
    const finished = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stderr })); });
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
    const ready = async () => {
        try { await waitFile(path.join(root, 'container-started')); }
        catch (error) {
            const commands = fs.existsSync(path.join(root, 'commands')) ? fs.readFileSync(path.join(root, 'commands'), 'utf8') : '(none)';
            const dockerLog = fs.existsSync(path.join(root, 'base/logs/docker.log')) ? fs.readFileSync(path.join(root, 'base/logs/docker.log'), 'utf8') : '(none)';
            throw new Error(error.message + '\nSupervisor stderr: ' + stderr + '\nDocker mock calls:\n' + commands + '\nDaemon log:\n' + dockerLog);
        }
    };
    return { root, child, finished, ready };
}
async function waitFile(file, timeout = 8000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (fs.existsSync(file)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Mock supervisor did not reach expected state: ' + file);
}
test('guest EOF stops the owned container with 95 seconds grace and exits the foreground daemon', { skip: !supported, timeout: 15000 }, async t => {
    const { root, child, finished, ready } = setup(t);
    child.stdin.write('PING\n'); await ready();
    assert.match(fs.readFileSync(path.join(root, 'conf/container.env'), 'utf8'), /^FWD_RUNTIME_DEFER_ACCOUNTS=1$/m);
    child.stdin.end(); const result = await finished;
    assert.equal(result.code, 0, result.stderr);
    assert.match(fs.readFileSync(path.join(root, 'commands'), 'utf8'), /stop --time 95 freshwater-test/);
    assert.equal(fs.existsSync(path.join(root, 'daemon-stop')), true);
});
test('guest missing-heartbeat lease stops its own container while the stdin pipe remains open', { skip: !supported, timeout: 15000 }, async t => {
    const { root, child, finished, ready } = setup(t);
    child.stdin.write('PING\n'); await ready();
    // Move the last heartbeat into the past instead of sleeping through the lease.
    fs.writeFileSync(path.join(root, 'run/lease'), String(Math.floor(Date.now() / 1000) - 25) + '\n');
    const result = await finished; child.stdin.destroy();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, 'container-stopped')), true);
    const args = fs.readFileSync(path.join(root, 'commands'), 'utf8');
    assert.match(args, /--publish 127\.0\.0\.1:4090:4090/); assert.doesNotMatch(args, /2375|prune/);
});
test('guest stop failure exits nonzero and preserves active state instead of claiming stopped', { skip: !supported, timeout: 15000 }, async t => {
    const { root, child, finished, ready } = setup(t, { MOCK_FAIL_STOP: '1' });
    child.stdin.write('PING\n'); await ready(); child.stdin.end();
    const result = await finished;
    assert.notEqual(result.code, 0); assert.match(result.stderr, /stop is unconfirmed/);
    assert.equal(fs.existsSync(path.join(root, 'run/container-active')), true);
    assert.equal(fs.existsSync(path.join(root, 'container-stopped')), false);
});
test('unresponsive Docker socket is bounded and reports unconfirmed shutdown', { skip: !supported, timeout: 18000 }, async t => {
    const { root, child, finished, ready } = setup(t);
    child.stdin.write('PING\n'); await ready();
    const start = Date.now(); fs.writeFileSync(path.join(root, 'hang-info'), ''); child.stdin.end();
    const result = await finished;
    assert.notEqual(result.code, 0); assert.ok(Date.now() - start < 16000);
    assert.match(result.stderr, /unconfirmed|cannot be confirmed/);
    assert.equal(fs.existsSync(path.join(root, 'run/container-active')), true);
});
