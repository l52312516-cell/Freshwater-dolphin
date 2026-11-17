'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const names = Object.freeze({ manifest: '.freshwater-entry.json', backup: '.freshwater-package.original', proxy: 'freshwater-entry.cjs' });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function regular(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected an ordinary file: ' + path.basename(file));
}

function applicationMain(app, main) {
  // Node outside Electron cannot stat virtual paths inside an ASAR archive.
  // Validate the real archive boundary, then leave internal resolution to Electron.
  const candidate = path.resolve(app, main);
  if (!inside(app, candidate)) throw new Error('Original QQ main module escapes the application directory');
  try {
    if (path.extname(candidate).toLowerCase() === '.asar' && fs.lstatSync(candidate).isSymbolicLink()) {
      throw new Error('Original QQ ASAR archive must not be a symbolic link');
    }
    const resolved = fs.realpathSync(candidate);
    if (!inside(app, resolved)) throw new Error('Original QQ main module escapes the application directory');
    regular(resolved);
    return resolved;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  let ancestor = path.dirname(candidate);
  while (inside(app, ancestor)) {
    let info;
    try { info = fs.lstatSync(ancestor); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (info) {
      if (info.isSymbolicLink()) throw new Error('Original QQ ASAR archive must not be a symbolic link');
      if (info.isFile()) {
        if (path.extname(ancestor).toLowerCase() !== '.asar') break;
        const archive = fs.realpathSync(ancestor);
        if (!inside(app, archive)) throw new Error('Original QQ ASAR archive escapes the application directory');
        regular(archive);
        return path.join(archive, path.relative(ancestor, candidate));
      }
    }
    ancestor = path.dirname(ancestor);
  }
  throw new Error('Original QQ main module does not exist as a file or within an ordinary ASAR archive');
}

function prepare(options = {}) {
  const root = fs.realpathSync(options.root || path.resolve(__dirname, '..'));
  const accountRoot = options.accountRoot;
  let permittedPath = path.join(root, 'work', 'qq-root');
  if (accountRoot !== undefined) {
    const accounts = path.join(root, 'work', 'accounts');
    const requested = path.resolve(accountRoot);
    const relative = path.relative(accounts, requested);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(relative) || path.dirname(requested) !== accounts) {
      throw new Error('Account directory must be a direct workspace work/accounts child');
    }
    for (const directory of [path.join(root, 'work'), accounts, requested]) {
      const info = fs.lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
        throw new Error('Account directory must not contain symbolic links');
      }
    }
    permittedPath = path.join(requested, 'qq-root');
  }
  const permitted = fs.realpathSync(permittedPath);
  if (accountRoot !== undefined && permitted !== permittedPath) throw new Error('Account QQ directory must not be a symbolic link');
  if (!inside(root, permitted)) throw new Error('Workspace QQ directory must not resolve outside this project');
  const app = fs.realpathSync(options.appDir || path.join(permitted, 'opt', 'QQ', 'resources', 'app'));
  if (!inside(permitted, app)) throw new Error('QQ application must remain inside this workspace QQ directory');
  const packageFile = path.join(app, 'package.json');
  regular(packageFile);
  const runtime = options.runtimeIdentity || (process.env.FWD_QQ_VERSION ? {
    profileId: process.env.FWD_QQ_PROFILE_ID, qqVersion: process.env.FWD_QQ_VERSION,
    packageSha256: process.env.FWD_QQ_PACKAGE_SHA256, wrapperSha256: process.env.FWD_QQ_WRAPPER_SHA256
  } : null);
  if (runtime) {
    const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const version = metadata.version?.includes('-') ? metadata.version : metadata.buildVersion ? metadata.version + '-' + metadata.buildVersion : metadata.version;
    if (version !== runtime.qqVersion || !/^[a-f0-9]{64}$/.test(runtime.packageSha256 || '') || !/^[a-f0-9]{64}$/.test(runtime.wrapperSha256 || '')) {
      throw new Error('Private QQ copy does not match the selected runtime identity');
    }
  }
  const files = Object.fromEntries(Object.entries(names).map(([name, value]) => [name, path.join(app, value)]));

  if (fs.existsSync(files.manifest)) {
    regular(files.manifest);
    regular(files.backup);
    regular(files.proxy);
    const state = JSON.parse(fs.readFileSync(files.manifest, 'utf8'));
    const original = fs.readFileSync(files.backup);
    const current = fs.readFileSync(packageFile);
    if (state.version !== 1 || state.originalHash !== digest(original) ||
        state.preparedHash !== digest(current) || state.proxyHash !== digest(fs.readFileSync(files.proxy))) {
      throw new Error('QQ entry ownership check failed; preserve local changes and repair the workspace copy manually');
    }
    if (runtime && state.runtime && ['profileId', 'qqVersion', 'packageSha256', 'wrapperSha256'].some(key => state.runtime[key] !== runtime[key])) {
      throw new Error('Prepared QQ entry belongs to another runtime; preserve and explicitly migrate the private copy');
    }
    if (runtime && !state.runtime && !options.restore) fs.writeFileSync(files.manifest, JSON.stringify({ ...state, runtime }) + '\n');
    if (!options.restore) return { prepared: true, changed: false, appDir: app };
    fs.writeFileSync(packageFile, original);
    fs.unlinkSync(files.proxy);
    fs.unlinkSync(files.backup);
    fs.unlinkSync(files.manifest);
    return { prepared: false, changed: true, appDir: app };
  }
  if (options.restore) return { prepared: false, changed: false, appDir: app };
  if (fs.existsSync(files.proxy) || fs.existsSync(files.backup)) {
    throw new Error('Reserved Freshwater entry files already exist without an ownership manifest');
  }
  const original = fs.readFileSync(packageFile);
  const metadata = JSON.parse(original.toString('utf8'));
  if (typeof metadata.main !== 'string' || !metadata.main || metadata.main === names.proxy) {
    throw new Error('QQ package must identify an original application main module');
  }
  const originalMain = applicationMain(app, metadata.main);
  const bootstrap = path.join(root, 'src', 'qq', 'entry.cjs');
  regular(bootstrap);
  const proxy = Buffer.from("'use strict';\nmodule.exports = require(" + JSON.stringify(bootstrap) + ').bootstrap(' + JSON.stringify(originalMain) + ');\n');
  const prepared = Buffer.from(JSON.stringify({ ...metadata, main: names.proxy }, null, 2) + '\n');
  const state = { version: 1, originalHash: digest(original), preparedHash: digest(prepared), proxyHash: digest(proxy), ...(runtime ? { runtime } : {}) };
  const created = [];
  try {
    for (const [file, body] of [[files.backup, original], [files.proxy, proxy], [files.manifest, JSON.stringify(state) + '\n']]) {
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
      created.push(file);
    }
    fs.writeFileSync(packageFile, prepared);
  } catch (error) {
    // Restore only this operation's writes. Never remove pre-existing files.
    try { fs.writeFileSync(packageFile, original); } catch {}
    for (const file of created.reverse()) { try { fs.unlinkSync(file); } catch {} }
    throw error;
  }
  return { prepared: true, changed: true, appDir: app };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--restore') options.restore = true;
      else if (args[index] === '--app-dir' && args[index + 1]) options.appDir = args[++index];
      else if (args[index] === '--account-root' && args[index + 1]) options.accountRoot = args[++index];
      else throw new Error('Usage: node tools/prepare-qq.cjs [--account-root PATH] [--app-dir PATH] [--restore]');
    }
    console.log(JSON.stringify(prepare(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { prepare };
