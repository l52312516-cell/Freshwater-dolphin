'use strict';
// Cold guest snapshot tests. They execute the production POSIX helper against
// an ordinary temporary tree; no WSL, Docker, QQ process, or host filesystems
// are touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const project = path.resolve(__dirname, '..');
const supported = process.platform === 'linux' && fs.existsSync('/bin/sh') &&
  spawnSync('/bin/sh', ['-c', 'command -v flock && command -v find && command -v readlink'], { encoding: 'utf8' }).status === 0;

function setup(t) {
  fs.mkdirSync(path.join(project, 'work/temp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(project, 'work/temp/upgrade-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'base');
  const conf = path.join(root, 'conf');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(base, 'work'), { recursive: true });
  fs.mkdirSync(conf, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  // Keep the test deterministic on small CI disks while exercising the
  // production df parsing and the explicit five GiB reserve calculation.
  fs.writeFileSync(path.join(bin, 'df'), '#!/bin/sh\nprintf \'Filesystem 1024-blocks Used Available Capacity Mounted on\\nmock 100000000 1 99999999 1%% /\\n\'\n');
  fs.chmodSync(path.join(bin, 'df'), 0o700);
  const id = 'a'.repeat(32);
  fs.writeFileSync(path.join(conf, 'owner'), id + '\n');
  fs.writeFileSync(path.join(conf, 'runtime.env'), 'INSTANCE_ID=' + id + '\nOLD_RUNTIME=1\n');
  fs.writeFileSync(path.join(base, 'work', 'qq-state.bin'), 'old state\n');
  fs.mkdirSync(path.join(base, 'work', 'nested'));
  fs.writeFileSync(path.join(base, 'work', 'nested', 'private.txt'), 'keep me\n');
  const supervisor = path.join(root, 'supervisor.sh');
  fs.writeFileSync(supervisor, `#!/bin/sh\nprintf '%s\\n' '{"instanceId":"${id}","running":false,"daemonRunning":false,"supervisorRunning":false,"confirmed":true}'\n`);
  fs.chmodSync(supervisor, 0o700);
  let script = fs.readFileSync(path.join(project, 'deploy/windows/upgrade.sh'), 'utf8');
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  script = script.replace(/^BASE=.*$/m, 'BASE=' + quote(base))
    .replace(/^CONF=.*$/m, 'CONF=' + quote(conf))
    .replace(/^SUPERVISOR=.*$/m, 'SUPERVISOR=' + quote(supervisor));
  const helper = path.join(root, 'upgrade.sh');
  fs.writeFileSync(helper, script);
  fs.chmodSync(helper, 0o700);
  const run = (operation, extraEnv = {}) => spawnSync('/bin/sh', [helper, operation, id], {
    encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), TMPDIR: path.join(root, 'temp'), ...extraEnv }
  });
  return { root, base, conf, id, run };
}

function statusValue(stdout) {
  const result = JSON.parse(stdout);
  assert.equal(Number.isSafeInteger(result.workSizeBytes), true);
  assert.ok(result.workSizeBytes > 0);
  assert.equal(result.workSizeBytes % 1024, 0);
  const { workSizeBytes, ...status } = result;
  return status;
}

test('prepare is idempotent, commits the cold snapshot, and rollback restores work plus runtime.env',
  { skip: !supported }, t => {
    const s = setup(t);
    let result = s.run('prepare');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(statusValue(result.stdout), { instanceId: s.id, phase: 'prepared', snapshotAvailable: true, confirmed: true });
    result = s.run('prepare');
    assert.equal(result.status, 0, result.stderr);
    fs.writeFileSync(path.join(s.base, 'work', 'qq-state.bin'), 'new state\n');
    fs.writeFileSync(path.join(s.conf, 'runtime.env'), 'INSTANCE_ID=' + s.id + '\nNEW_RUNTIME=1\n');
    result = s.run('commit');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).phase, 'committed');
    result = s.run('rollback');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(statusValue(result.stdout), { instanceId: s.id, phase: 'rolled_back', snapshotAvailable: false, confirmed: true });
    assert.equal(fs.readFileSync(path.join(s.base, 'work', 'qq-state.bin'), 'utf8'), 'old state\n');
    assert.equal(fs.readFileSync(path.join(s.base, 'work', 'nested', 'private.txt'), 'utf8'), 'keep me\n');
    assert.match(fs.readFileSync(path.join(s.conf, 'runtime.env'), 'utf8'), /OLD_RUNTIME=1/);
    assert.doesNotMatch(fs.readFileSync(path.join(s.conf, 'runtime.env'), 'utf8'), /NEW_RUNTIME=1/);
  });

test('unsafe links are rejected before a snapshot is staged', { skip: !supported }, t => {
  const s = setup(t);
  fs.symlinkSync('/etc/passwd', path.join(s.base, 'work', 'escape'));
  const result = s.run('prepare');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe symbolic link/);
  assert.equal(fs.existsSync(path.join(s.base, 'work', 'escape')), true);
  assert.equal(fs.existsSync(path.join(s.base, 'upgrades', 'current')), false);
});

test('status reports an interrupted copying journal as unconfirmed and rollback cancels only staging',
  { skip: !supported }, t => {
    const s = setup(t);
    fs.mkdirSync(path.join(s.base, 'upgrades'), { recursive: true });
    fs.writeFileSync(path.join(s.base, 'upgrades', 'journal'), 'copying ' + s.id + '\n');
    fs.mkdirSync(path.join(s.base, 'upgrades', 'staging'));
    fs.writeFileSync(path.join(s.base, 'upgrades', 'staging', 'partial'), 'partial\n');
    let result = s.run('status');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(statusValue(result.stdout), { instanceId: s.id, phase: 'preparing', snapshotAvailable: false, confirmed: false });
    result = s.run('rollback');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(statusValue(result.stdout), { instanceId: s.id, phase: 'none', snapshotAvailable: false, confirmed: true });
    assert.equal(fs.existsSync(path.join(s.base, 'upgrades', 'staging')), false);
    assert.equal(fs.readFileSync(path.join(s.base, 'work', 'qq-state.bin'), 'utf8'), 'old state\n');
  });

test('rollback completes a crash during the durable switching rename before restoring the old snapshot',
  { skip: !supported }, t => {
    const s = setup(t);
    let result = s.run('prepare');
    assert.equal(result.status, 0, result.stderr);
    const upgrades = path.join(s.base, 'upgrades');
    const generation = 'b'.repeat(32);
    fs.mkdirSync(path.join(upgrades, 'staging', 'work'), { recursive: true });
    fs.writeFileSync(path.join(upgrades, 'staging', 'owner'), s.id + '\n');
    fs.writeFileSync(path.join(upgrades, 'staging', 'generation'), generation + '\n');
    // Staging is the new cold copy of the pre-upgrade work, not a copy of
    // the runtime after migration. The older current snapshot is retired.
    fs.writeFileSync(path.join(upgrades, 'staging', 'runtime.env'), 'INSTANCE_ID=' + s.id + '\nOLD_RUNTIME=1\n');
    fs.writeFileSync(path.join(upgrades, 'staging', 'work', 'qq-state.bin'), 'old state\n');
    fs.writeFileSync(path.join(upgrades, 'staging', 'ready'), '');
    fs.renameSync(path.join(upgrades, 'current'), path.join(upgrades, 'retired'));
    fs.writeFileSync(path.join(upgrades, 'journal'), 'switching ' + generation + '\n');
    fs.writeFileSync(path.join(s.base, 'work', 'qq-state.bin'), 'migrated\n');
    fs.writeFileSync(path.join(s.conf, 'runtime.env'), 'INSTANCE_ID=' + s.id + '\nMIGRATED=1\n');
    result = s.run('rollback');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(s.base, 'work', 'qq-state.bin'), 'utf8'), 'old state\n');
    assert.match(fs.readFileSync(path.join(s.conf, 'runtime.env'), 'utf8'), /OLD_RUNTIME=1/);
    assert.doesNotMatch(fs.readFileSync(path.join(s.conf, 'runtime.env'), 'utf8'), /MIGRATED=1/);
  });

test('rollback resumes after either live directory rename without feeding migrated work to the old runtime',
  { skip: !supported }, t => {
    const s = setup(t);
    let result = s.run('prepare');
    assert.equal(result.status, 0, result.stderr);
    const upgrades = path.join(s.base, 'upgrades');
    const generation = fs.readFileSync(path.join(upgrades, 'state'), 'utf8').trim().split(/\s+/)[1];
    fs.writeFileSync(path.join(s.base, 'work', 'qq-state.bin'), 'migrated\n');
    fs.writeFileSync(path.join(s.conf, 'runtime.env'), 'INSTANCE_ID=' + s.id + '\nNEW_RUNTIME=1\n');
    fs.renameSync(path.join(s.base, 'work'), path.join(upgrades, 'displaced-work'));
    fs.writeFileSync(path.join(upgrades, 'journal'), 'rollback ' + generation + '\n');
    result = s.run('status');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(statusValue(result.stdout), { instanceId: s.id, phase: 'rolling_back', snapshotAvailable: false, confirmed: false });
    // Simulate the second rename completing immediately before interruption.
    fs.renameSync(path.join(upgrades, 'current', 'work'), path.join(s.base, 'work'));
    result = s.run('rollback');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(s.base, 'work', 'qq-state.bin'), 'utf8'), 'old state\n');
    assert.match(fs.readFileSync(path.join(s.conf, 'runtime.env'), 'utf8'), /OLD_RUNTIME=1/);
    assert.equal(fs.existsSync(path.join(upgrades, 'displaced-work')), false);
  });

test('prepare rejects insufficient guest space and an active runtime before staging private state',
  { skip: !supported }, t => {
    const s = setup(t);
    fs.writeFileSync(path.join(s.root, 'bin', 'df'), '#!/bin/sh\nprintf \'Filesystem 1024-blocks Used Available Capacity Mounted on\\nmock 100 99 1 99%% /\\n\'\n');
    let result = s.run('prepare');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /5 GiB/);
    assert.equal(fs.existsSync(path.join(s.base, 'upgrades', 'journal')), false);
    fs.writeFileSync(path.join(s.root, 'supervisor.sh'), `#!/bin/sh\nprintf '%s\\n' '{"instanceId":"${s.id}","running":true,"daemonRunning":true,"supervisorRunning":true,"confirmed":true}'\n`);
    result = s.run('prepare');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be confirmed stopped/);
    assert.equal(fs.existsSync(path.join(s.base, 'upgrades', 'staging')), false);
    assert.equal(fs.readFileSync(path.join(s.base, 'work', 'qq-state.bin'), 'utf8'), 'old state\n');
  });
