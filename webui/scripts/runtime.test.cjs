'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { parse, compileScript } = require('@vue/compiler-sfc');
const vue = require('vue');

const dependencies = Promise.all([import('../src/request-scope.mjs'), import('../src/account-config.mjs'), import('../src/log-key.mjs')]);
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function overview(accounts = [{ id: 'alpha' }, { id: 'beta' }]) { return { accounts, resources: { totalMemory: 1, freeMemory: 1 }, version: 'test', maxAccounts: 2 }; }
async function app(t, api) {
    const [scope, config, logs] = await dependencies;
    const source = fs.readFileSync(path.join(__dirname, '../src/App.vue'), 'utf8');
    const { descriptor } = parse(source);
    const script = compileScript(descriptor, { id: 'audit-ui' });
    const code = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const unmount = [], sources = [], toasts = [];
    class Source {
        constructor() { sources.push(this); this.listeners = new Map(); }
        addEventListener(name, callback) { this.listeners.set(name, callback); }
        close() { this.closed = true; }
        send(name, value) { this.listeners.get(name)?.({ data: JSON.stringify(value) }); }
    }
    const customVue = { ...vue, onMounted() {}, onBeforeUnmount(callback) { unmount.push(callback); } };
    const module = { exports: {} };
    const context = vm.createContext({ module, exports: module.exports, console, AbortController, EventSource: Source,
        setTimeout, clearTimeout, setInterval, clearInterval, document: { hidden: false },
        window: { addEventListener() {}, removeEventListener() {} },
        require(name) {
            if (name === 'vue') return customVue;
            if (name === './api') return { api, download: async () => {}, setCsrf() {} };
            if (name === './request-scope.mjs') return scope;
            if (name === './account-config.mjs') return config;
            if (name === './log-key.mjs') return logs;
            if (name === './toast') return { useToast: () => ({ push: value => toasts.push(value), clear() {} }) };
            if (/\.(?:vue|jpg|jpeg)$/.test(name)) return { default: {} };
            throw new Error('Unexpected UI dependency: ' + name);
        } });
    vm.runInContext(code, context, { filename: 'App.vue' });
    const value = module.exports.default.setup({}, { expose() {} });
    value.auth.value.authenticated = true;
    value.selectedId.value = 'alpha';
    value.overview.value = overview();
    t.after(() => { for (const close of unmount) close(); });
    return { value, sources, toasts };
}

test('switching accounts discards a late configuration response instead of attaching it to the new account', async t => {
    const pending = deferred(); const calls = [];
    const { value } = await app(t, (url) => { calls.push(url); return pending.promise; });
    const loading = value.loadConfig(); value.switchAccount('beta'); pending.resolve({ label: 'private alpha', nodes: [] }); await loading;
    assert.equal(value.draft.value, null); assert.equal(value.error.value, ''); assert.deepEqual(calls, ['/accounts/alpha/config']);
});

test('a configuration save never follows up by reading another account after selection changes', async t => {
    const pending = deferred(), calls = [];
    const { value } = await app(t, (url, method) => { calls.push([url, method]); return pending.promise; });
    value.draft.value = { label: 'alpha', nodes: [] }; value.dirty.value = true;
    const saving = value.saveConfig(); value.switchAccount('beta'); pending.resolve({ saved: true, applied: true }); await saving;
    assert.equal(value.draft.value, null); assert.equal(calls.length, 1); assert.equal(calls[0][0], '/accounts/alpha/config');
});

test('contact and media responses from an earlier account do not contaminate the selected account', async t => {
    const pending = deferred();
    const { value } = await app(t, () => pending.promise);
    const loading = value.loadContacts(); value.switchAccount('beta'); pending.resolve([{ user_id: '11111', nickname: 'old' }]); await loading;
    assert.equal(value.social.contacts.length, 0);
    const image = deferred();
    const second = await app(t, () => image.promise);
    const uploading = second.value.uploadImage({ size: 1, name: 'example.png' }); second.value.switchAccount('beta'); image.resolve({ file: 'private-alpha-image' }); await uploading;
    assert.equal(second.value.messages.uploadedImage, '');
});

test('message confirmation binds the original account, recipient and message', async t => {
    const calls = [];
    const { value } = await app(t, async (url, _method, payload) => { calls.push([url, payload]); return { status: 'ok', data: { message_id: 1 } }; });
    value.messages.form.recipient = '12345'; value.messages.form.text = 'original'; await value.sendMessage();
    value.messages.form.recipient = '54321'; value.messages.form.text = 'changed'; value.messages.form.type = 'group';
    await value.confirmedAction();
    assert.equal(calls[0][0], '/accounts/alpha/action');
    assert.equal(calls[0][1].action, 'send_private_msg'); assert.equal(calls[0][1].params.user_id, '12345');
    assert.equal(calls[0][1].params.message[0].data.text, 'original');
});

test('switching accounts revokes any pending send confirmation', async t => {
    let requests = 0;
    const { value } = await app(t, async () => { requests++; });
    value.messages.form.recipient = '12345'; value.messages.form.text = 'original'; await value.sendMessage();
    value.switchAccount('beta'); await value.confirmedAction();
    assert.equal(value.confirmDialog.value, null); assert.equal(requests, 0);
});

test('closed or replaced event streams cannot repopulate state after logout', async t => {
    const { value, sources } = await app(t, async () => overview());
    value.openStream(); const old = sources[0]; value.openStream();
    old.send('snapshot', overview([{ id: 'stale' }])); assert.equal(value.overview.value.accounts[0].id, 'alpha');
    value.unauthorized(); sources[1].send('snapshot', overview([{ id: 'private' }])); sources[1].send('logs', [{ id: 'private-chat', content: 'secret' }]);
    assert.equal(value.overview.value.accounts.length, 0); assert.equal(value.logs.value.length, 0);
});

test('a newer stream snapshot wins over an in-flight overview polling response', async t => {
    const pending = deferred();
    const { value, sources } = await app(t, () => pending.promise);
    value.openStream(); const polling = value.refreshOverview();
    sources[0].send('snapshot', overview([{ id: 'beta' }])); pending.resolve(overview([{ id: 'alpha' }]));
    await assert.rejects(polling, { name: 'StaleRequestError' }); assert.equal(value.overview.value.accounts[0].id, 'beta');
});

test('navigating while another task is active defers the page load instead of silently skipping it', async t => {
    const pending = deferred(), calls = [];
    const { value } = await app(t, async url => { calls.push(url); return {}; });
    const running = value.task('existing operation', () => pending.promise); value.tab.value = 'settings'; await vue.nextTick();
    assert.equal(calls.length, 0); pending.resolve(); await running; await vue.nextTick();
    assert.equal(calls[0], '/settings');
});

test('reloading an unsaved node draft requires confirmation before discarding it', async t => {
    const calls = [];
    const { value } = await app(t, async url => { calls.push(url); return { label: 'saved', nodes: [] }; });
    value.draft.value = { label: 'unsaved', nodes: [] }; value.dirty.value = true;
    value.reloadConfig(); assert.equal(calls.length, 0); assert.equal(value.draft.value.label, 'unsaved');
    await value.confirmedAction(); assert.equal(calls[0], '/accounts/alpha/config');
    assert.equal(value.draft.value.label, 'saved'); assert.equal(value.dirty.value, false);
});

test('account form success notification is only delivered after an actual create response', async t => {
    let completed = 0;
    const failed = await app(t, async () => { throw new Error('create rejected'); });
    await failed.value.createAccount({ label: 'draft', expectedUin: '12345', onCreated() { completed++; } });
    assert.equal(completed, 0);
    const calls = [];
    const created = await app(t, async (url, _method, payload) => { calls.push([url, payload]); return url === '/accounts' ? { id: 'beta' } : overview(); });
    await created.value.createAccount({ label: 'draft', expectedUin: '12345', onCreated() { completed++; } });
    assert.equal(completed, 1); assert.deepEqual(Object.keys(calls[0][1]).sort(), ['expectedUin', 'label']);
});

test('invalid advanced image input fails before uploading a private resource', async t => {
    let requests = 0;
    const { value } = await app(t, async () => { requests++; });
    value.messages.form.advanced = true; value.messages.form.segments = '{invalid';
    await value.uploadImage({ size: 1, name: 'example.png' });
    assert.equal(requests, 0); assert.ok(value.error.value);
});

test('log streams keep both accounts when their local record IDs are identical', async t => {
    const { value, sources } = await app(t, async () => overview()); value.openStream();
    sources[0].send('logs', [{ profileId: 'alpha', id: 'same-local-id', event: 'ready' }, { profileId: 'beta', id: 'same-local-id', event: 'ready' }]);
    assert.equal(value.logs.value.length, 2);
    sources[0].send('logs', [{ profileId: 'alpha', id: 'same-local-id', event: 'ready' }, { profileId: 'beta', id: 'same-local-id', event: 'ready' }]);
    assert.equal(value.logs.value.length, 2);
});

test('reloading a log snapshot preserves newer records received while it was in flight', async t => {
    const pending = deferred(); const { value, sources } = await app(t, () => pending.promise);
    value.openStream(); const reload = value.loadLogs();
    sources[0].send('logs', [{ profileId: 'alpha', id: 'new', at: 20, content: 'new' }]);
    pending.resolve([{ profileId: 'alpha', id: 'old', at: 10, content: 'old' }]); await reload;
    assert.deepEqual([...value.logs.value].map(row => row.id), ['old', 'new']);
});

test('logging out removes private message drafts, action parameters and password fields', async t => {
    const { value } = await app(t, async () => overview());
    value.messages.form.text = 'private draft'; value.messages.form.segments = '[{"type":"text","data":{"text":"private"}}]';
    value.messages.actionParams = '{"token":"private"}'; value.messages.form.recipient = '12345';
    value.settings.passwords.currentPassword = 'private'; value.backup.form.password = 'private';
    value.unauthorized();
    assert.equal(value.messages.form.text, ''); assert.equal(value.messages.form.recipient, '');
    assert.equal(value.messages.actionParams, '{}'); assert.equal(value.messages.form.segments.includes('private'), false);
    assert.equal(value.settings.passwords.currentPassword, ''); assert.equal(value.backup.form.password, '');
});

test('changing the selected backup invalidates an old preview and a late validation response', async t => {
    const pending = deferred(); const { value } = await app(t, () => pending.promise);
    value.backup.restore.backupId = 'first'; value.backup.restore.password = 'first-password';
    const request = value.previewRestore();
    value.backup.restore.backupId = 'second'; value.backup.restore.password = 'new-password';
    pending.resolve({ backupId: 'first', previewId: 'old-preview', profiles: [] }); await request;
    assert.equal(value.backup.restore.previewId, ''); assert.equal(value.backup.restore.preview, null);
    assert.equal(value.backup.restore.password, 'new-password');
});

test('failed validation removes the previous restore preview instead of leaving apply enabled', async t => {
    const { value } = await app(t, async () => { throw new Error('incorrect backup password'); });
    value.backup.restore.backupId = 'first'; value.backup.restore.previewId = 'old'; value.backup.restore.preview = { backupId: 'first' };
    await value.previewRestore();
    assert.equal(value.backup.restore.previewId, ''); assert.equal(value.backup.restore.preview, null);
    assert.ok(value.error.value);
});

test('a restore confirmation cannot apply after selection changes, even when switching back', async t => {
    const calls = []; const { value } = await app(t, async (url, method, payload) => { calls.push([url, method, payload]); return overview(); });
    value.backup.restore.backupId = 'first'; value.backup.restore.previewId = 'preview'; value.backup.restore.preview = { backupId: 'first' };
    value.applyRestore(); value.backup.restore.backupId = 'second'; value.backup.restore.backupId = 'first';
    await value.confirmedAction(); assert.equal(calls.length, 0);
});

test('a validated restore submits the captured archive and preview together', async t => {
    const calls = []; const { value } = await app(t, async (url, method, payload) => { calls.push([url, method, payload]); return url === '/overview' ? overview() : {}; });
    value.backup.restore.backupId = 'first'; value.backup.restore.previewId = 'preview'; value.backup.restore.preview = { backupId: 'first' };
    value.applyRestore(); await value.confirmedAction();
    assert.equal(calls[0][0], '/backups/restore/apply'); assert.equal(calls[0][2].backupId, 'first'); assert.equal(calls[0][2].previewId, 'preview');
    assert.equal(value.backup.restore.previewId, '');
});

test('runtime and service settings drafts survive page changes and explicit reload needs confirmation', async t => {
    const calls = []; const { value } = await app(t, async url => { calls.push(url); return { maxAccounts: 2, publicBaseUrl: '', statusCommand: { enabled: true, trigger: '#fd' }, musicSignUrl: '', rkey: { fallbackServers: [] } }; });
    value.applySettings({ maxAccounts: 2, publicBaseUrl: '', musicSignUrl: '', rkey: { fallbackServers: [] } });
    value.settings.publicBaseUrl = 'https://draft.example'; value.settings.musicSignKey = 'private-unsaved';
    value.tab.value = 'settings'; await vue.nextTick(); value.tab.value = 'overview'; await vue.nextTick(); value.tab.value = 'settings'; await vue.nextTick();
    assert.equal(calls.length, 0); assert.equal(value.settings.musicSignKey, 'private-unsaved');
    await value.loadSettings(); assert.equal(calls.length, 0); assert.ok(value.confirmDialog.value);
    await value.confirmedAction(); assert.equal(calls[0], '/settings'); assert.equal(value.settings.publicBaseUrl, '');
});

test('settings edited during a reload retain their new draft when the earlier server response arrives', async t => {
    const pending = deferred(); const { value } = await app(t, () => pending.promise);
    const loading = value.loadSettings(); value.settings.publicBaseUrl = 'https://typed-during-request.example';
    value.settings.musicSignKey = 'new-secret'; pending.resolve({ maxAccounts: 2, publicBaseUrl: '', rkey: { fallbackServers: [] }, musicSignUrl: '' });
    await loading; assert.equal(value.settings.publicBaseUrl, 'https://typed-during-request.example'); assert.equal(value.settings.musicSignKey, 'new-secret');
    assert.equal(value.settingsDirty.value, true);
});

test('the log console renders a bounded page while preserving access to all filtered records', async () => {
    const [, , logs] = await dependencies;
    const source = fs.readFileSync(path.join(__dirname, '../src/components/LogConsole.vue'), 'utf8');
    const script = compileScript(parse(source).descriptor, { id: 'audit-log-window' });
    const code = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, console, require(name) {
        if (name === 'vue') return vue;
        if (name === '../log-key.mjs') return logs;
        if (name.endsWith('.vue')) return { default: {} };
        throw new Error('Unexpected log component dependency: ' + name);
    } });
    const props = vue.reactive({ records: Array.from({ length: 1000 }, (_, index) => ({ id: 'row-' + index, profileId: 'a', event: 'ready', time: new Date(index).toISOString() })), accounts: [], paused: false, connected: true, busy: false });
    const value = module.exports.default.setup(props, { expose() {}, emit() {} });
    assert.equal(value.filtered.value.length, 1000); assert.equal(value.visible.value.length, 100); assert.equal(value.pageCount.value, 10);
    value.showPage(10); assert.equal(value.visible.value[0].id, 'row-900'); assert.equal(value.autoScroll.value, false);
    props.records = props.records.slice(-3); await vue.nextTick();
    assert.equal(value.page.value, 1); assert.equal(value.visible.value.length, 3);
});
