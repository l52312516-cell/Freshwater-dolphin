'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { loadManifest, verifyRelease, assetPath, spacePlan, assertReleaseRoot } = require('./manifest.cjs');
const { prepareConfig, applyConfig, decodeConfig, inspectConfig } = require('./config.cjs');
const GiB = 1024 ** 3;
function decodeOutput(buffer) { return buffer.includes(0) ? buffer.toString('utf16le').replace(/^\uFEFF/, '') : buffer.toString('utf8').replace(/^\uFEFF/, ''); }
function execute(file, args, { input, env, timeout = 120000, allowedExitCodes = [0] } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: env || process.env });
        let stdout = [], stderr = [], size = 0, settled = false;
        const finish = (err, result) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(result); };
        const timer = setTimeout(() => { child.kill(); finish(new Error(path.basename(file) + ' command timed out')); }, timeout);
        for (const [stream, list] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
            size += chunk.length; if (size > 4 * 1024 ** 2) { child.kill(); finish(new Error('Command output limit exceeded')); } else list.push(chunk);
        });
        child.on('error', error => finish(error));
        child.on('close', code => {
            const result = { code, stdout: decodeOutput(Buffer.concat(stdout)), stderr: decodeOutput(Buffer.concat(stderr)) };
            if (!allowedExitCodes.includes(code)) return finish(Object.assign(new Error(path.basename(file) + ' failed (' + code + '): ' + (result.stderr || result.stdout).trim().slice(0, 800)), { result }));
            finish(null, result);
        });
        child.stdin.on('error', () => {}); child.stdin.end(input);
    });
}
function windowsToWsl(value) {
    if (!/^[A-Za-z]:\\/.test(value) || /[\0\r\n]/.test(value)) throw new Error('Use a local Windows drive path');
    return '/mnt/' + value[0].toLowerCase() + '/' + value.slice(3).replace(/\\/g, '/');
}
function atomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try { fs.renameSync(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function assertWorkPath(root, target) {
    assertReleaseRoot(root);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Runtime path escaped workspace');
    let cursor = root;
    for (const part of relative.split(path.sep)) {
        cursor = path.join(cursor, part);
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Runtime directories must not be symlinks or junctions');
    }
}
function readState(file) {
    if (!fs.existsSync(file)) return null;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.version !== 1 || !/^[a-f0-9]{32}$/.test(state.instanceId || '') || !/^[a-f0-9]{64}$/.test(state.token || '')) throw new Error('Windows runtime state is invalid; preserve it for repair');
    return state;
}
function requestIdentity({ port, instanceId, token, releaseVersion, timeout = 2500 }) {
    return new Promise((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port, path: '/api/runtime/instance', timeout,
            headers: { Authorization: 'Bearer ' + token } }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; if (body.length > 8192) response.destroy(new Error('Identity response exceeds limit')); });
            response.on('error', reject);
            response.on('end', () => {
                try {
                    const value = JSON.parse(body);
                    if (response.statusCode !== 200 || value.instanceId !== instanceId ||
                        (releaseVersion && value.releaseVersion !== releaseVersion)) throw new Error('Loopback identity mismatch; port may belong to another application');
                    resolve(value);
                } catch (err) { reject(err); }
            });
        });
        request.on('timeout', () => request.destroy(new Error('Windows loopback handshake timed out'))); request.on('error', reject);
    });
}
function activateRuntime({ port, instanceId, token, releaseVersion, timeout = 30000 }) {
    return new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port, path: '/api/runtime/activate', method: 'POST', timeout,
            headers: { Authorization: 'Bearer ' + token, 'Content-Length': '0' } }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; if (body.length > 8192) response.destroy(new Error('Activation response exceeds limit')); });
            response.on('error', reject);
            response.on('end', () => {
                try {
                    const value = JSON.parse(body);
                    if (response.statusCode !== 200 || value.instanceId !== instanceId || value.releaseVersion !== releaseVersion || value.activated !== true) throw new Error('Local runtime activation was not confirmed');
                    resolve(value);
                } catch (error) { reject(error); }
            });
        });
        request.on('timeout', () => request.destroy(new Error('Local runtime activation timed out; account result is unknown')));
        request.on('error', reject); request.end();
    });
}
function checkLoopbackPort(port) {
    return new Promise((resolve, reject) => {
        const listener = net.createServer();
        listener.once('error', error => {
            const message = error.code === 'EADDRINUSE' ?
                'Port 127.0.0.1:' + port + ' is already in use; stop the conflicting application before starting Freshwater' :
                'Cannot check port 127.0.0.1:' + port + ' (' + (error.code || 'UNKNOWN') + '): ' + error.message;
            reject(Object.assign(new Error(message), { code: error.code }));
        });
        listener.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
            listener.close(error => error ? reject(new Error('Cannot close loopback port check: ' + error.message)) : resolve());
        });
    });
}
function hostProbeScript() {
    return "$ErrorActionPreference='Stop'; $o=Get-CimInstance Win32_OperatingSystem; $c=Get-CimInstance Win32_Processor | Select-Object -First 1; " +
        "$p=Get-Item -LiteralPath $env:FWD_RELEASE_ROOT; $v=Get-Volume -DriveLetter $p.PSDrive.Name; $system=Get-CimInstance Win32_ComputerSystem; " +
        "$s=Get-Volume -DriveLetter $env:SystemDrive.Substring(0,1); " +
        "$a=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); " +
        "$features=@{}; foreach($n in @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform')) { " +
        "try {$features[$n]=(Get-WindowsOptionalFeature -Online -FeatureName $n -ErrorAction Stop).State.ToString()} catch {$features[$n]='Unknown'} }; " +
        "@{build=[int]$o.BuildNumber; architecture=$o.OSArchitecture; memoryBytes=[long]$o.TotalVisibleMemorySize*1024; " +
        "virtualization=([bool]$c.VirtualizationFirmwareEnabled -or [bool]$system.HypervisorPresent); slat=([bool]$c.SecondLevelAddressTranslationExtensions -or [bool]$system.HypervisorPresent); " +
        "fileSystem=$v.FileSystem; freeBytes=[long]$v.SizeRemaining; systemFreeBytes=[long]$s.SizeRemaining; " +
        "compressed=[bool]($p.Attributes -band [IO.FileAttributes]::Compressed); encrypted=[bool]($p.Attributes -band [IO.FileAttributes]::Encrypted); " +
        "administrator=$a; features=$features} | ConvertTo-Json -Compress";
}
function evaluateHost(host, manifest, plan) {
    const errors = [], warnings = [];
    if (host.build < 19044) errors.push('Windows build 19044 or later is required by this launcher');
    if (!host.virtualization || !host.slat) errors.push('Enable BIOS virtualization and SLAT support');
    if (host.fileSystem !== 'NTFS' || host.compressed || host.encrypted) errors.push('Use an uncompressed, non-EFS directory on a local NTFS volume');
    if (host.memoryBytes < (manifest.runtime.wslMemoryMiB + 2048) * 1024 ** 2) errors.push('Insufficient RAM for the configured WSL limit and Windows');
    if (host.freeBytes < plan.requiredFreeBytes) errors.push('Insufficient project-volume space: need ' + Math.ceil(plan.requiredFreeBytes / GiB) + ' GiB free');
    if (host.systemFreeBytes < 2 * GiB) errors.push('System volume needs at least 2 GiB emergency headroom; Windows feature installation may require more');
    if (host.systemFreeBytes < 8 * GiB) warnings.push('System volume is low; WSL/Windows own components and temporary files may still use it');
    return { errors, warnings };
}
class WindowsRuntime {
    constructor(root, options = {}) {
        this.root = assertReleaseRoot(root); this.options = options;
        this.run = options.execute || execute; this.spawn = options.spawn || spawn;
        this.identity = options.requestIdentity || requestIdentity;
        this.activate = options.activateRuntime || activateRuntime;
        this.checkPort = options.checkPortAvailable || checkLoopbackPort;
        this.out = options.output || (line => process.stdout.write(line + '\n'));
        this.manifest = options.manifest || loadManifest(this.root);
        this.deferAccounts = options.deferAccounts ?? Boolean(this.manifest.runtime.deferAccounts);
        this.base = path.join(this.root, 'work/windows'); this.private = path.join(this.base, 'private');
        this.stateFile = path.join(this.private, 'state.json'); this.guestConfig = path.join(this.private, 'guest.env');
        for (const file of [this.stateFile, this.guestConfig, path.join(this.base, 'distro'), path.join(this.base, 'swap.vhdx')]) assertWorkPath(this.root, file);
        this.configFile = options.configFile || path.join(os.homedir(), '.wslconfig');
        this.wsl = options.wsl || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
        this.powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    }
    get runtime() { return this.manifest.runtime; }
    get url() { return 'http://127.0.0.1:' + this.runtime.hostPort + '/'; }
    async ps(script, env = {}) { return this.run(this.powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env } }); }
    async list(running = false) {
        const result = await this.run(this.wsl, ['--list', ...(running ? ['--running'] : []), '--quiet']);
        return result.stdout.replace(/\u0000/g, '').split(/\r?\n/).map(x => x.replace(/^\*/, '').trim()).filter(Boolean);
    }
    async guest(args, options = {}) {
        return this.run(this.wsl, ['--distribution', this.runtime.distroName, '--user', 'root', '--exec', '/opt/freshwater/supervisor.sh', ...args], options);
    }
    async upgrade(operation, state) {
        const value = JSON.parse((await this.guest(['upgrade', operation, state.instanceId], { timeout: 600000 })).stdout.trim());
        const phases = ['none', 'prepared', 'committed', 'rolled_back', 'preparing', 'rolling_back'];
        if (value.instanceId !== state.instanceId || !phases.includes(value.phase) || typeof value.confirmed !== 'boolean' ||
            (operation !== 'status' && value.confirmed !== true) || !Number.isSafeInteger(value.workSizeBytes) || value.workSizeBytes < 0) throw new Error('Upgrade acknowledgement is unconfirmed');
        return value;
    }
    async waitStopped(state) {
        const deadline = Date.now() + (this.options.stopVerifyTimeoutMs || 15000);
        do {
            if (!(await this.list(true)).includes(this.runtime.distroName)) return;
            const value = JSON.parse((await this.guest(['status', state.instanceId])).stdout.trim());
            if (value.instanceId !== state.instanceId || value.confirmed !== true || value.running !== false || value.daemonRunning !== false) throw new Error('Runtime stop cannot be confirmed; automatic data restore is blocked');
            if (value.supervisorRunning !== true) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        throw new Error('Foreground supervisor is still stopping; automatic data restore is blocked');
    }
    snapshotSpace(workSizeBytes, releaseBytes = 0) {
        if (!Number.isSafeInteger(workSizeBytes) || workSizeBytes < 0 || !Number.isSafeInteger(releaseBytes) || releaseBytes < 0) throw new Error('Cold snapshot space cannot be measured');
        const required = workSizeBytes + releaseBytes + 5 * GiB;
        if (!Number.isSafeInteger(required)) throw new Error('Cold snapshot space budget overflow');
        const space = (this.options.statfs || fs.statfsSync)(this.base);
        if (Number(space.bavail) * Number(space.bsize) < required) throw new Error('Insufficient host space for the cold upgrade snapshot and release (need ' + (required / GiB).toFixed(2) + ' GiB free)');
        return required;
    }
    async recoverUpgrade(state) {
        if (!state?.pendingUpgrade) return state;
        const stopped = await this.stop();
        if (stopped.stopped !== true || stopped.confirmed !== true) throw new Error('Upgrade recovery requires confirmed shutdown');
        await this.waitStopped(state);
        const status = await this.upgrade('status', state);
        if (status.phase === 'committed') {
            // Commit precedes account activation. Once committed, a lost HTTP
            // response must never cause old data to replace possible QQ writes.
            if (status.confirmed !== true) throw new Error('Committed upgrade state is unconfirmed; no automatic rollback');
            const committed = structuredClone(state); delete committed.pendingUpgrade; atomic(this.stateFile, committed); return committed;
        }
        if (status.phase !== 'none' && status.phase !== 'rolled_back') {
            const restored = await this.upgrade('rollback', state);
            // Cancelling an interrupted copy leaves live data intact and may
            // expose the preceding committed snapshot or no prior snapshot.
            const allowed = status.phase === 'preparing' ? ['rolled_back', 'none', 'committed'] : ['rolled_back'];
            if (!allowed.includes(restored.phase) || restored.confirmed !== true) throw new Error('Upgrade rollback requires repair; preserved runtime is stopped');
        } else if (status.confirmed !== true) {
            throw new Error('Upgrade recovery status is unconfirmed');
        }
        const previous = structuredClone(state.pendingUpgrade.previous);
        if (!previous || previous.instanceId !== state.instanceId || previous.token !== state.token) throw new Error('Previous runtime identity is invalid; preserve upgrade state');
        atomic(this.stateFile, previous);
        this.out('已恢复升级前的程序配置和完整数据；实例保持停止。可用 start --previous 启动缓存的旧镜像。');
        return previous;
    }
    configPlan() {
        return prepareConfig(this.configFile, { swapFile: path.join(this.base, 'swap.vhdx'), memoryMiB: this.runtime.wslMemoryMiB,
            processors: this.runtime.processors, swapMiB: this.runtime.swapMiB });
    }
    async doctor() {
        if ((this.options.platform || process.platform) !== 'win32' || (this.options.arch || process.arch) !== 'x64') throw new Error('This launcher requires Windows x64');
        if ((this.options.nodeVersion || process.versions.node) !== this.manifest.node.version) throw new Error('Use the exact bundled Node 22 runtime from this release');
        const plan = spacePlan(this.manifest, { installed: Boolean(readState(this.stateFile)?.installed) });
        const host = JSON.parse((await this.ps(hostProbeScript(), { FWD_RELEASE_ROOT: this.root })).stdout);
        const evaluation = evaluateHost(host, this.manifest, plan);
        this.configPlan();
        return { host, disk: plan, ...evaluation, distroName: this.runtime.distroName, url: this.url };
    }
    async privateDirectory() {
        fs.mkdirSync(this.base, { recursive: true });
        // Protect the VHDX and swap as well as credentials. Unix modes inside the
        // VHDX do not prevent another Windows user from copying that disk offline.
        await this.ps("$ErrorActionPreference='Stop'; $id=[Security.Principal.WindowsIdentity]::GetCurrent().User; " +
            "$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18'); " +
            "$q=New-Object 'Collections.Generic.Queue[IO.FileSystemInfo]'; $q.Enqueue((Get-Item -LiteralPath $env:FWD_RUNTIME_BASE -Force)); " +
            "while($q.Count -gt 0) { $p=$q.Dequeue(); if($p.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Runtime reparse point rejected'}; " +
            "if($p -is [IO.DirectoryInfo]) { $acl=New-Object Security.AccessControl.DirectorySecurity; $flags='ContainerInherit,ObjectInherit'; " +
            "foreach($child in Get-ChildItem -LiteralPath $p.FullName -Force){$q.Enqueue($child)} } " +
            "else {$acl=New-Object Security.AccessControl.FileSecurity; $flags='None'}; " +
            "$acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($id); foreach($sid in @($id,$system)) { " +
            "$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$flags,'None','Allow'); $acl.AddAccessRule($rule) }; " +
            "Set-Acl -LiteralPath $p.FullName -AclObject $acl }", { FWD_RUNTIME_BASE: this.base });
        fs.mkdirSync(this.private, { recursive: true });
    }
    async install(confirm) {
        await verifyRelease(this.root, this.manifest);
        const report = await this.doctor();
        for (const warning of report.warnings) this.out('提示：' + warning);
        if (report.errors.length) throw new Error(report.errors.join('\n'));
        const config = this.configPlan();
        const features = Object.entries(report.host.features || {}).filter(([, value]) => value !== 'Enabled');
        if (features.length && !report.host.administrator) throw new Error('Run install in an administrator terminal to inspect/enable WSL optional features');
        // wsl --list itself fails when the optional feature has not been enabled.
        // Enable only after approval, reboot, then enumerate on the next run.
        const names = features.length ? [] : await this.list(); const running = features.length ? [] : await this.list(true);
        const others = running.filter(name => name !== this.runtime.distroName);
        if (others.length) throw new Error('Stop other running WSL distributions yourself before changing shared WSL settings: ' + others.join(', '));
        let previous = readState(this.stateFile);
        if (previous?.pendingUpgrade) throw new Error('An upgrade is pending; run start to verify it or start --previous to recover before another install');
        if (previous?.distroName && previous.distroName !== this.runtime.distroName) throw new Error('Distribution name differs from persisted runtime state');
        if (names.includes(this.runtime.distroName) && !previous) throw new Error('The WSL distribution name is already occupied; it will not be overwritten');
        if (previous && (previous.installed || names.includes(this.runtime.distroName)) && previous.rootfsSha256 !== this.manifest.alpine.rootfs.sha256) {
            throw new Error('Existing Alpine rootfs differs from this release (or its hash is untracked). Automatic distro replacement is unsupported; preserve the existing VHDX and migrate explicitly');
        }
        if (names.includes(this.runtime.distroName)) {
            // Check ownership before approval or ANY host configuration mutation.
            let owner;
            try { owner = await this.run(this.wsl, ['-d', this.runtime.distroName, '-u', 'root', '--exec', '/bin/cat', '/etc/freshwater/owner']); }
            catch { throw new Error('Cannot confirm existing distribution owner. Import phase: ' + (previous.importPhase || 'unknown') + '; preserve work/windows/distro for manual recovery. Host configuration was not changed'); }
            if (owner.stdout.trim() !== previous.instanceId) throw new Error('Existing distribution ownership mismatch; host configuration was not changed');
        }
        this.out('安装预览：Alpine WSL2 + Docker Engine；发行版、镜像、QQ数据和交换文件位于 ' + this.base);
        this.out('本次额外可用空间要求：' + (report.disk.requiredFreeBytes / GiB).toFixed(2) + ' GiB（包含数据预算与余量）');
        this.out('将备份并合并 ' + this.configFile + '；资源限制和交换文件设置会影响当前用户的其他 WSL2 发行版。');
        this.out('Windows/WSL 自身组件及系统临时数据仍可能写入系统盘。');
        this.out(config.preview);
        if (features.length) this.out('将启用 Windows 功能：' + features.map(([name]) => name).join(', ') + '；可能需要重启。');
        if (running.includes(this.runtime.distroName)) this.out('将先优雅停止本项目已有实例并核实停止，再准备安装。');
        if (!await confirm('输入 INSTALL 执行以上安装：')) throw new Error('Installation cancelled');
        if (!features.length) {
            const nowRunning = await this.list(true);
            const other = nowRunning.filter(name => name !== this.runtime.distroName);
            if (other.length) throw new Error('Another WSL distribution started after preview; stop it yourself before applying shared settings: ' + other.join(', '));
            // Ownership probing may have woken only this idle distro. Terminate
            // that verified distro only, never a global WSL shutdown.
            if (names.includes(this.runtime.distroName)) {
                if (previous?.installed) {
                    const stopped = await this.stop();
                    if (!stopped.confirmed) throw new Error('Existing runtime shutdown is unconfirmed; installation aborted');
                    await this.waitStopped(previous);
                }
                await this.run(this.wsl, ['--terminate', this.runtime.distroName]);
            }
        }
        await this.privateDirectory();
        const backup = applyConfig(config, path.join(this.private, 'backups'));
        if (backup) this.out('已备份配置：' + backup);
        if (features.length) {
            for (const [name] of features) await this.run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'dism.exe'),
                ['/online', '/enable-feature', '/featurename:' + name, '/all', '/norestart'], { timeout: 600000, allowedExitCodes: [0, 3010] });
            this.out('Windows 功能已启用。请重启 Windows 后重新运行 Freshwater。'); return { rebootRequired: true };
        }
        if (backup && names.includes(this.runtime.distroName)) {
            this.out('共享 WSL 配置已更新。已有发行版的身份核验曾启动 WSL VM，请重启 Windows 后重新运行以确保资源设置生效。');
            return { rebootRequired: true };
        }
        const state = previous ? structuredClone(previous) : { version: 1, instanceId: crypto.randomBytes(16).toString('hex'), token: crypto.randomBytes(32).toString('hex'), installed: false };
        if (state.distroName && state.distroName !== this.runtime.distroName) throw new Error('Distribution name differs from persisted runtime state');
        state.distroName = this.runtime.distroName; state.rootfsSha256 = this.manifest.alpine.rootfs.sha256;
        if (!names.includes(this.runtime.distroName)) state.importPhase = 'planned'; atomic(this.stateFile, state);
        if (!names.includes(this.runtime.distroName)) {
            await this.run(this.wsl, ['--import', this.runtime.distroName, path.join(this.base, 'distro'),
                assetPath(this.root, this.manifest.alpine.rootfs.path), '--version', '2'], { timeout: 600000 });
            state.importPhase = 'imported'; atomic(this.stateFile, state);
        }
        // Copy immutable scripts into the owned distro before running. All filenames
        // are argv items; the source path is never interpolated into shell source.
        await this.run(this.wsl, ['-d', this.runtime.distroName, '-u', 'root', '--exec', '/bin/sh',
            windowsToWsl(path.join(this.root, 'deploy/windows/supervisor.sh')), 'install',
            windowsToWsl(this.root), state.instanceId]);
        state.importPhase = 'owned'; atomic(this.stateFile, state);
        if (previous?.installed && previous.imageId !== this.manifest.image.id) {
            const measured = await this.upgrade('status', state);
            if (!measured.confirmed) throw new Error('Interrupted guest upgrade must be recovered before preparing a release');
            this.snapshotSpace(measured.workSizeBytes, this.manifest.image.expandedBytes);
            const oldState = structuredClone(previous); delete oldState.pendingUpgrade;
            state.pendingUpgrade = { previous: oldState, targetImageId: this.manifest.image.id, phase: 'preparing' };
            atomic(this.stateFile, state);
            try {
                const snapshot = await this.upgrade('prepare', state);
                if (snapshot.phase !== 'prepared' || snapshot.snapshotAvailable !== true) throw new Error('Cold upgrade snapshot was not confirmed');
            } catch (error) {
                try { await this.recoverUpgrade(state); } catch (recovery) { throw new Error(error.message + '; recovery unconfirmed: ' + recovery.message); }
                throw error;
            }
        }
        const env = { INSTANCE_ID: state.instanceId, INSTANCE_TOKEN: state.token, RELEASE_VERSION: this.manifest.releaseVersion,
            CONTAINER_NAME: this.runtime.containerName, IMAGE_ID: this.manifest.image.id, IMAGE_REFERENCE: this.manifest.image.reference,
            IMAGE_ARCHIVE: windowsToWsl(assetPath(this.root, this.manifest.image.archive.path)), HOST_PORT: this.runtime.hostPort,
            GUEST_PORT: this.runtime.guestPort, MEMORY_MIB: this.runtime.memoryMiB, PROCESSORS: this.runtime.processors, STOP_SECONDS: 95,
            DOCKER_VERSION: this.manifest.alpine.dockerVersion, COMPOSE_VERSION: this.manifest.alpine.composeVersion };
        for (const value of Object.values(env)) if (/[\r\n'\0]/.test(String(value))) throw new Error('Unsafe guest configuration value');
        fs.writeFileSync(this.guestConfig, Object.entries(env).map(([key, value]) => key + "='" + value + "'").join('\n') + '\n', { mode: 0o600 });
        try { await this.guest(['configure', windowsToWsl(this.guestConfig), state.instanceId]); }
        catch (error) {
            if (state.pendingUpgrade) {
                try { await this.recoverUpgrade(state); } catch (recovery) { throw new Error(error.message + '; recovery unconfirmed: ' + recovery.message); }
            }
            throw error;
        }
        state.installed = true; state.importPhase = 'ready'; state.releaseVersion = this.manifest.releaseVersion; state.imageId = this.manifest.image.id;
        if (state.pendingUpgrade) state.pendingUpgrade.phase = 'configured';
        atomic(this.stateFile, state); this.out('安装准备完成。启动时加载镜像并验证身份，不会跳过管理台登录。');
        return { installed: true };
    }
    async status() {
        const state = readState(this.stateFile); if (!state?.installed) return { installed: false, running: false };
        const running = await this.list(true);
        if (!running.includes(this.runtime.distroName)) return { installed: true, running: false };
        const result = JSON.parse((await this.guest(['status', state.instanceId])).stdout.trim());
        if (result.instanceId !== state.instanceId) throw new Error('Guest ownership mismatch');
        if (result.running) { try { await this.identity({ port: this.runtime.hostPort, instanceId: state.instanceId, token: state.token, releaseVersion: state.releaseVersion || this.manifest.releaseVersion }); result.loopback = true; } catch { result.loopback = false; } }
        return { installed: true, ...result };
    }
    async stop() {
        const state = readState(this.stateFile); if (!state?.installed) return { stopped: true, confirmed: true };
        if (!(await this.list(true)).includes(this.runtime.distroName)) return { stopped: true, confirmed: true };
        const result = JSON.parse((await this.guest(['stop', state.instanceId], { timeout: 200000 })).stdout.trim());
        if (result.instanceId !== state.instanceId || result.stopped !== true || result.confirmed !== true) throw new Error('Guest stop acknowledgement is unconfirmed');
        // A successful command exit alone is insufficient: verify the owned guest
        // state again, unless WSL has already shut that distro down naturally.
        if ((await this.list(true)).includes(this.runtime.distroName)) {
            const status = JSON.parse((await this.guest(['status', state.instanceId])).stdout.trim());
            if (status.instanceId !== state.instanceId || status.confirmed !== true || status.running !== false || status.daemonRunning !== false) throw new Error('Guest runtime is still running or stop cannot be confirmed');
        }
        return { stopped: true, confirmed: true };
    }
    async open() {
        const state = readState(this.stateFile); if (!state?.installed) throw new Error('Install and start Freshwater first');
        if (state.pendingUpgrade) throw new Error('Upgrade verification is pending; open cannot activate accounts before the foreground upgrade commits');
        if (!(await this.list(true)).includes(this.runtime.distroName)) throw new Error('Freshwater is not running');
        await this.identity({ port: this.runtime.hostPort, instanceId: state.instanceId, token: state.token, releaseVersion: state.releaseVersion || this.manifest.releaseVersion });
        if (this.deferAccounts) {
            try { await this.activate({ port: this.runtime.hostPort, instanceId: state.instanceId, token: state.token, releaseVersion: state.releaseVersion || this.manifest.releaseVersion }); }
            catch (error) {
                try { await this.stop(); } catch (stopError) { throw new Error(error.message + '; shutdown unconfirmed: ' + stopError.message); }
                throw error;
            }
        }
        this.out('WebUI：' + this.url);
        // URL is built from a validated numeric port, never arbitrary user input.
        const browser = this.spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [this.url], { detached: true, stdio: 'ignore', windowsHide: true });
        browser.on('error', () => this.out('无法自动打开浏览器，请手动访问上述地址。')); browser.unref();
    }
    async start({ confirm, noOpen = false, previous = false } = {}) {
        let state = readState(this.stateFile);
        if (state?.pendingUpgrade) {
            const pending = state.pendingUpgrade;
            const current = await this.status();
            if (current.supervisorRunning || current.running) throw new Error('An upgrade verification is already running in another foreground terminal; use status or stop first');
            const unverified = pending.phase === 'configured' && !previous && pending.targetImageId === this.manifest.image.id && state.imageId === pending.targetImageId;
            if (!unverified) {
                const target = pending.targetImageId;
                state = await this.recoverUpgrade(state);
                if (state.imageId !== target && !previous) throw new Error('Interrupted upgrade recovered. Use start --previous for the restored runtime, or start again to retry the release');
            }
        }
        if (previous && (!state?.installed || state.rootfsSha256 !== this.manifest.alpine.rootfs.sha256)) throw new Error('No compatible previously installed runtime is available');
        if (!previous && (!state?.installed || state.releaseVersion !== this.manifest.releaseVersion || state.imageId !== this.manifest.image.id ||
            state.rootfsSha256 !== this.manifest.alpine.rootfs.sha256 || (state.distroName && state.distroName !== this.runtime.distroName))) {
            const result = await this.install(confirm); if (result.rebootRequired) return result; state = readState(this.stateFile);
        }
        await verifyRelease(this.root, this.manifest);
        const config = fs.existsSync(this.configFile) ? inspectConfig(decodeConfig(fs.readFileSync(this.configFile)).text) : {};
        if (/^false$/i.test(config.localhostforwarding || '')) throw new Error('localhostForwarding=false; Freshwater requires Windows loopback forwarding');
        const available = (this.options.statfs || fs.statfsSync)(this.base); if (Number(available.bavail) * Number(available.bsize) < 2 * GiB) throw new Error('Less than 2 GiB free on the runtime volume; free space before starting QQ');
        const current = await this.status();
        if (current.running) {
            await this.identity({ port: this.runtime.hostPort, instanceId: state.instanceId, token: state.token, releaseVersion: state.releaseVersion || this.manifest.releaseVersion });
            if (this.deferAccounts) {
                try { await this.activate({ port: this.runtime.hostPort, instanceId: state.instanceId, token: state.token, releaseVersion: state.releaseVersion || this.manifest.releaseVersion }); }
                catch (error) {
                    try { await this.stop(); } catch (stopError) { throw new Error(error.message + '; shutdown unconfirmed: ' + stopError.message); }
                    throw error;
                }
            }
            this.out('Freshwater 已在运行：' + this.url);
            if (!noOpen) await this.open();
            return { running: true, alreadyRunning: true, url: this.url };
        }
        if (current.supervisorRunning) throw new Error('Freshwater is already starting or stopping; use status and wait for its foreground terminal');
        await this.checkPort(this.runtime.hostPort);
        if (state.pendingUpgrade) { state.pendingUpgrade.phase = 'verifying'; atomic(this.stateFile, state); }
        const child = this.spawn(this.wsl, ['-d', this.runtime.distroName, '-u', 'root', '--exec', '/opt/freshwater/supervisor.sh', 'serve', state.instanceId],
            // Separate console group: Ctrl+C is handled by Node and sent over IPC,
            // rather than racing a direct console interrupt against dockerd.
            { windowsHide: true, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let closed = false, stopping = false, stopPromise, stopConfirmed = false, exitError, resolveExit;
        const exit = new Promise(resolve => { resolveExit = resolve; });
        child.on('error', error => { exitError = error; closed = true; resolveExit(); });
        child.on('close', code => { closed = true; if (code) exitError = new Error('WSL supervisor exited (' + code + '); shutdown is unconfirmed'); resolveExit(); });
        child.stdout.on('data', chunk => this.out(chunk.toString('utf8').trimEnd()));
        child.stderr.on('data', chunk => this.out(chunk.toString('utf8').trimEnd()));
        child.stdin.on('error', () => {});
        const heartbeat = setInterval(() => { if (!closed && !stopping) child.stdin.write('PING\n'); }, 3000);
        child.stdin.write('PING\n');
        const stop = () => {
            if (stopPromise) return stopPromise;
            stopping = true; clearInterval(heartbeat);
            this.out('正在停止 Freshwater：容器退出宽限 95 秒，随后核实停止状态…');
            if (!closed) { child.stdin.write('STOP\n'); child.stdin.end(); }
            stopPromise = this.stop().then(result => {
                if (result.stopped !== true || result.confirmed !== true) throw new Error('Runtime shutdown is unconfirmed');
                stopConfirmed = true;
            }).catch(err => { exitError = err; this.out('停止尚未确认：' + err.message); });
            return stopPromise;
        };
        process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGBREAK', stop);
        try {
            const deadline = Date.now() + (this.options.startupTimeoutMs || 600000); let identity;
            while (!closed && !stopping && Date.now() < deadline) {
                try { identity = await this.identity({ port: this.runtime.hostPort, instanceId: state.instanceId, token: state.token, releaseVersion: state.releaseVersion || this.manifest.releaseVersion }); break; }
                catch { await new Promise(resolve => setTimeout(resolve, this.options.startupPollMs || 1000)); }
            }
            if (!identity) { await stop(); throw exitError || new Error('Windows loopback handshake failed; verify WSL forwarding and port conflicts'); }
            if (stopping || closed) throw exitError || new Error('Startup was cancelled before account activation');
            if (state.pendingUpgrade) {
                state.pendingUpgrade.phase = 'committing'; atomic(this.stateFile, state);
                const committed = await this.upgrade('commit', state);
                if (committed.phase !== 'committed') { await stop(); throw new Error('Cold upgrade commit was not confirmed'); }
                delete state.pendingUpgrade; atomic(this.stateFile, state);
            }
            if (stopping || closed) throw exitError || new Error('Startup was cancelled after verification; accounts remain deferred');
            if (this.deferAccounts) await this.activate({ port: this.runtime.hostPort, instanceId: state.instanceId, token: state.token, releaseVersion: state.releaseVersion || this.manifest.releaseVersion });
            this.out('Freshwater 已就绪：' + this.url);
            const setup = (await this.guest(['setup-token', state.instanceId])).stdout.trim();
            if (setup && !/^[A-Za-z0-9_-]{43}$/.test(setup)) throw new Error('Invalid setup credential format; inspect guest authentication state');
            if (setup) this.out('首次初始化口令（仅本终端显示，请勿公开）：' + setup);
            this.out('保持此窗口运行；Ctrl+C 优雅停止。直接关闭窗口会按失联处理，恢复时检查中断状态。');
            if (!noOpen) await this.open();
            await exit; if (stopPromise) await stopPromise; if (exitError) throw exitError;
        } catch (error) {
            await stop();
            if (state.pendingUpgrade && stopConfirmed) {
                try { state = await this.recoverUpgrade(state); }
                catch (recovery) { throw new Error(error.message + '; cold upgrade recovery is unconfirmed: ' + recovery.message); }
            } else if (state.pendingUpgrade) {
                throw new Error(error.message + '; automatic rollback blocked because shutdown is unconfirmed');
            }
            throw error;
        } finally {
            clearInterval(heartbeat); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('SIGBREAK', stop);
            if (!closed) await stop();
        }
        return { stopped: true };
    }
}
module.exports = { WindowsRuntime, execute, decodeOutput, windowsToWsl, requestIdentity, activateRuntime, checkLoopbackPort, evaluateHost, hostProbeScript, readState, atomic, assertWorkPath };
