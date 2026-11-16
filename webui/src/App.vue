<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { api, download, setCsrf } from './api';
import { writableAccountConfig } from './account-config.mjs';
import { createRequestScope, isStaleRequest } from './request-scope.mjs';
import { logRecordKey, mergeLogRecords } from './log-key.mjs';
import logo from './assets/logo.jpeg';
import artWide from './assets/login-wide.jpg';
import artPortrait from './assets/login-portrait.jpg';
import PageHeading from './components/PageHeading.vue';
import Icon from './components/Icon.vue';
import type { IconName } from './components/Icon.vue';
import ThemeModeControl from './components/ThemeModeControl.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import ToastStack from './components/ToastStack.vue';
import NodeManager from './components/NodeManager.vue';
import LogConsole from './components/LogConsole.vue';
import OverviewPage from './pages/OverviewPage.vue';
import AccountsPage from './pages/AccountsPage.vue';
import SocialPage from './pages/SocialPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import { useToast } from './toast';
import type { Account, AccountConfig, AuthState, BackupState, CapabilityCatalogue, CapabilityState, Json, MessageState, Overview, SettingsState, SocialState, StorageCleanup, StorageCleanupRequest, StorageSnapshot } from './types';

const tabs: { id: 'overview' | 'accounts' | 'nodes' | 'social' | 'logs' | 'settings'; icon: IconName; title: string; caption: string }[] = [
  { id: 'overview', icon: 'grid', title: '运行总览', caption: '服务与连接' },
  { id: 'accounts', icon: 'user', title: 'QQ 账号', caption: '远程登录与管理' },
  { id: 'nodes', icon: 'share', title: '连接节点', caption: 'OneBot v11' },
  { id: 'social', icon: 'message', title: '好友与消息', caption: '资料查询与手动调试' },
  { id: 'logs', icon: 'list', title: '运行日志', caption: '诊断与排障' },
  { id: 'settings', icon: 'sliders', title: '系统设置', caption: '外观、备份与安全' },
];
type Tab = typeof tabs[number]['id'];
const subtitles: Record<Tab, string> = {
  overview: '从真实会话到每个连接，运行状态一目了然。',
  accounts: '独立账号、独立空间，让每次连接都有边界。',
  nodes: '为你的机器人配置清晰、可靠的消息通道。',
  social: '从当前 QQ 会话读取好友、群与成员资料，并核对每一次真实发送。',
  logs: '保留关键诊断，让运行中的问题有迹可循。',
  settings: '管理外观、访问、备份与这个工作空间的运行方式。',
};

const tab = ref<Tab>('overview');
const title = computed(() => tabs.find(item => item.id === tab.value)?.title || '管理台');
const auth = ref<AuthState>({ initialized: true, authenticated: false });
const loading = ref(true);
const authForm = reactive({ setupToken: '', password: '', confirm: '' });
const busy = ref('');
const error = ref('');
const streamConnected = ref(false);
const overview = ref<Overview>({ accounts: [], resources: { totalMemory: 0, freeMemory: 0 }, version: '', maxAccounts: 2 });
const selectedId = ref('');
const draft = ref<AccountConfig | null>(null);
const dirty = ref(false);
const nodeResult = ref<Json | null>(null);
const logs = ref<Json[]>([]);
const logPaused = ref(false);
const social = reactive<SocialState>({
  tab: 'contacts', contacts: [], kind: 'friends', search: '', detail: null,
  queryForm: { kind: 'get_stranger_info', id: '', member: '' },
});
const messages = reactive<MessageState>({
  form: { type: 'private', recipient: '', text: '', at: '', reply: '', advanced: false, segments: '[\n  { "type": "text", "data": { "text": "" } }\n]' },
  actionName: 'get_status', actionParams: '{}', actionResult: null, uploadedImage: '',
});
const capabilityState = reactive<CapabilityState>({ catalogue: null, loading: false, error: '' });
const capabilitySession = computed(() => {
  const account = overview.value.accounts.find(item => item.id === selectedId.value);
  return JSON.stringify([selectedId.value, account?.desired, account?.bridgeInstalled, account?.health?.sessionEpoch, account?.health?.ready, account?.health?.authorized]);
});
const settings = reactive<SettingsState>({ text: '{}', maxAccounts: 2, publicBaseUrl: '', statusCommand: { enabled: true, trigger: '#fd' }, rkey: { fallbackServers: [] }, musicSignUrl: '', musicSignKey: '', hasMusicSignKey: false, clearMusicSignKey: false, passwords: { currentPassword: '', newPassword: '', confirm: '' } });
const savedSettings = reactive({ runtime: '', global: '' });
const settingsLoaded = ref(false);
function runtimeDraft() { return JSON.stringify([settings.maxAccounts, settings.publicBaseUrl, settings.statusCommand]); }
function globalDraft() { return JSON.stringify([settings.rkey.fallbackServers, settings.musicSignUrl, settings.musicSignKey, settings.clearMusicSignKey]); }
const settingsDirty = computed(() => settingsLoaded.value && (runtimeDraft() !== savedSettings.runtime || globalDraft() !== savedSettings.global));
const storage = ref<StorageSnapshot | null>(null);
const storageResult = ref<StorageCleanup | null>(null);
const backup = reactive<BackupState>({
  list: [], form: { profileIds: [], kind: 'ordinary', password: '' },
  restore: { backupId: '', password: '', previewId: '', preview: null },
});
const accountsPage = ref<InstanceType<typeof AccountsPage> | null>(null);
const settingsPage = ref<InstanceType<typeof SettingsPage> | null>(null);
const confirmDialog = ref<{ title: string; message: string; action: () => Promise<void>; requiredId?: string; confirmLabel?: string; danger?: boolean } | null>(null);
const { push: toast, clear: clearToasts } = useToast();
let stream: EventSource | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const accountRequests = createRequestScope();
const capabilityRequests = createRequestScope();
const overviewRequests = createRequestScope();
const restoreRequests = createRequestScope();
let clearingRestorePassword = false;
function invalidateRestore() {
  restoreRequests.invalidate(); backup.restore.previewId = ''; backup.restore.preview = null;
}
watch(() => [backup.restore.backupId, backup.restore.password], () => {
  if (!clearingRestorePassword) invalidateRestore();
}, { flush: 'sync' });
let taskRevision = 0;
let pendingPageLoad: Tab | null = null;

function accountContext() { return { profileId: selectedId.value, ...accountRequests.capture() }; }
async function accountApi<T = Json>(context: ReturnType<typeof accountContext>, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  context.assertCurrent();
  if (!context.profileId) throw new Error('请先选择账号');
  const value = await api<T>('/accounts/' + encodeURIComponent(context.profileId) + path, method, body, headers, context.signal);
  context.assertCurrent();
  return value;
}

function queuePageLoad(value: Tab) {
  pendingPageLoad = ['nodes', 'logs', 'settings'].includes(value) ? value : null;
  flushPageLoad();
}
function flushPageLoad() {
  if (busy.value || !auth.value.authenticated || pendingPageLoad !== tab.value) return;
  const value = pendingPageLoad; pendingPageLoad = null;
  if (value === 'nodes' && !draft.value) void loadConfig();
  if (value === 'logs') void loadLogs();
  if (value === 'settings' && !settingsLoaded.value) void loadSettings();
}

async function task(name: string, action: () => Promise<void>, success = '') {
  if (busy.value) return;
  const revision = ++taskRevision;
  busy.value = name; error.value = ''; clearToasts();
  try {
    await action();
    if (revision === taskRevision && success) toast(success);
  } catch (value) {
    if (revision === taskRevision && !isStaleRequest(value)) error.value = value instanceof Error ? value.message : '操作失败';
  } finally {
    if (revision === taskRevision) { busy.value = ''; flushPageLoad(); }
  }
}

function unauthorized() {
  taskRevision++; busy.value = ''; pendingPageLoad = null;
  accountRequests.invalidate(); overviewRequests.invalidate(); invalidateRestore();
  resetCapabilities();
  auth.value.authenticated = false; setCsrf(''); stream?.close(); stream = undefined; streamConnected.value = false;
  confirmDialog.value = null; selectedId.value = '';
  overview.value = { accounts: [], resources: { totalMemory: 0, freeMemory: 0 }, version: '', maxAccounts: 2 };
  draft.value = null; dirty.value = false; nodeResult.value = null;
  social.contacts = []; social.detail = null; social.search = '';
  messages.actionResult = null; messages.uploadedImage = '';
  Object.assign(social.queryForm, { kind: 'get_stranger_info', id: '', member: '' });
  Object.assign(messages.form, { type: 'private', recipient: '', text: '', at: '', reply: '', advanced: false, segments: '[\n  { "type": "text", "data": { "text": "" } }\n]' });
  messages.actionName = 'get_status'; messages.actionParams = '{}';
  logs.value = []; backup.list = [];
  backup.restore.password = ''; backup.restore.preview = null; backup.restore.previewId = '';
  backup.form.password = '';
  backup.form.profileIds = []; backup.restore.backupId = '';
  settings.rkey.fallbackServers = []; settings.musicSignUrl = ''; settings.text = '{}';
  settings.musicSignKey = ''; settings.hasMusicSignKey = false; settings.clearMusicSignKey = false;
  settings.statusCommand = { enabled: true, trigger: '#fd' };
  settings.passwords.currentPassword = ''; settings.passwords.newPassword = ''; settings.passwords.confirm = '';
  settingsLoaded.value = false; savedSettings.runtime = ''; savedSettings.global = '';
  storage.value = null; storageResult.value = null;
}

async function checkAuth() {
  try {
    auth.value = await api<AuthState>('/auth/state'); setCsrf(auth.value.csrf);
    if (auth.value.authenticated) await initialize();
  } catch (value) { if (!isStaleRequest(value)) error.value = value instanceof Error ? value.message : '无法连接管理服务'; }
  finally { loading.value = false; }
}

async function login() {
  await task('登录', async () => {
    if (!auth.value.initialized && authForm.password !== authForm.confirm) throw new Error('两次密码不一致');
    const value = await api<{ csrf: string }>('/auth/' + (auth.value.initialized ? 'login' : 'bootstrap'), 'POST',
      auth.value.initialized ? { password: authForm.password } : { setupToken: authForm.setupToken, password: authForm.password });
    setCsrf(value.csrf); auth.value = { initialized: true, authenticated: true, csrf: value.csrf };
    authForm.password = ''; authForm.confirm = ''; authForm.setupToken = ''; await initialize();
  });
}

async function logout() {
  await task('退出', async () => {
    await accountsPage.value?.closeRemote();
    await api('/auth/logout', 'POST');
    unauthorized();
  });
}

async function refreshOverview() {
  overviewRequests.invalidate();
  const ticket = overviewRequests.capture();
  const value = await api<Overview>('/overview', 'GET', undefined, {}, ticket.signal);
  ticket.assertCurrent(); acceptOverview(value);
}

function acceptOverview(value: Overview) {
  if (!value || !Array.isArray(value.accounts) || !value.resources) throw new Error('状态响应格式异常，已保留上次状态');
  overview.value = value;
  if (!value.accounts.some(item => item.id === selectedId.value)) switchAccount(value.accounts[0]?.id || '');
}

function openStream() {
  stream?.close();
  const source = new EventSource('/api/events', { withCredentials: true }); stream = source;
  const current = () => stream === source && auth.value.authenticated;
  source.onopen = () => { if (current()) streamConnected.value = true; };
  source.onerror = () => { if (current()) streamConnected.value = false; };
  source.addEventListener('snapshot', event => {
    if (!current()) return;
    try { const value = JSON.parse((event as MessageEvent).data); acceptOverview(value.data || value); overviewRequests.invalidate(); }
    catch { error.value = '状态流格式异常，已保留上次状态'; }
  });
  source.addEventListener('logs', event => {
    if (!current() || logPaused.value) return;
    try {
      const value = JSON.parse((event as MessageEvent).data); const records = Array.isArray(value) ? value : [value];
      logs.value = mergeLogRecords(logs.value, records);
    } catch { error.value = '日志流格式异常'; }
  });
}

async function initialize() { await refreshOverview(); openStream(); }

function confirm(title: string, message: string, action: () => Promise<void>, requiredId?: string, confirmLabel?: string, danger = false) {
  confirmDialog.value = { title, message, action, requiredId, confirmLabel, danger };
}

async function confirmedAction() {
  const value = confirmDialog.value;
  if (!value) return;
  confirmDialog.value = null;
  await task(value.title, value.action, value.title + '完成');
}

function switchAccount(id: string) {
  confirmDialog.value = null;
  selectedId.value = id; dirty.value = false; draft.value = null; nodeResult.value = null;
  social.contacts = []; social.detail = null; social.search = '';
  messages.uploadedImage = ''; messages.actionResult = null;
  messages.form.recipient = ''; messages.form.at = ''; messages.form.reply = '';
  if (tab.value === 'nodes') queuePageLoad('nodes');
}

async function selectAccount(id: string) {
  if (dirty.value) {
    confirm('放弃未保存的修改', '当前节点配置尚未保存，切换账号将丢弃这些修改。是否继续？', async () => switchAccount(id));
    return;
  }
  switchAccount(id);
}

function openAccount(id: string) {
  void selectAccount(id);
  tab.value = 'accounts';
}

async function createAccount(payload: { label: string; expectedUin: string; onCreated?: () => void }) {
  await task('创建账号', async () => {
    const value = await api<Account>('/accounts', 'POST', { label: payload.label, expectedUin: payload.expectedUin });
    payload.onCreated?.();
    await refreshOverview(); await selectAccount(value.id);
  }, '账号实例已创建，启动后打开远程登录');
}

async function accountOperation(payload: { item: Account; operation: string }) {
  const { item, operation } = payload;
  const action = async () => { await api('/accounts/' + encodeURIComponent(item.id) + '/' + operation, 'POST'); await refreshOverview(); };
  if (operation === 'start') await task('启动账号', action, '启动请求已接受，请等待真实会话状态');
  else confirm(operation === 'stop' ? '停止账号' : '重启账号', '将中断此账号的 QQ 与 OneBot 连接；其他账号继续运行。未确认的发送不会自动重试。', action);
}

async function recoverMaintenance(item: Account) {
  const deleting = item.maintenance?.operation === 'delete';
  confirm(deleting ? '继续删除账号' : '恢复维护状态', deleting ? '此账号的删除曾中断。继续后会清理剩余私有数据并移除账号实例，无法恢复此前已删除的数据；其他账号不受影响。请输入实例编号再次确认。' : '请先停止该账号。将核验并清理此账号的遗留进程，解除中断或失败的维护状态；不会替换账号数据，完成后保持停止。', async () => {
    await refreshOverview();
    const current = overview.value.accounts.find(value => value.id === item.id);
    if (!current || current.desired !== 'stopped' || ['running', 'starting', 'stopping', 'online', 'offline', 'online_unknown'].includes(current.state)) throw new Error('请先停止账号，再恢复维护状态');
    await api('/accounts/' + encodeURIComponent(item.id) + '/maintenance/recover', 'POST');
    if (deleting && selectedId.value === item.id) { selectedId.value = ''; draft.value = null; dirty.value = false; }
    await refreshOverview();
  }, deleting ? item.id : undefined);
}

async function bridgeOperation(payload: { item: Account; operation: 'install' | 'uninstall' }) {
  const { item, operation } = payload;
  const uninstall = operation === 'uninstall';
  confirm(uninstall ? '卸载注入桥' : '安装注入桥', uninstall
    ? '若账号正在运行，将重启此账号的 QQ，卸载当前进程中的注入桥。QQ 程序、账号配置、登录资料和消息映射全部保留；仅 QQ 模式不能使用 OneBot 接口。'
    : '将重新安装注入桥；若账号正在运行，将重启此账号的 QQ。完成后需等待真实身份和接入会话确认，其他账号保持运行。', async () => {
    if (selectedId.value === item.id) await accountsPage.value?.closeRemote();
    const result = await api<Json>('/accounts/' + encodeURIComponent(item.id) + '/' + operation, 'POST', {});
    await refreshOverview();
    if (result.applied === false) throw new Error('注入桥设置已保存，但运行中的账号未能成功应用。请检查账号状态后重试启动' + (result.error ? '（' + String(result.error) + '）' : '。'));
  });
}

function deleteAccount(item: Account) {
  confirm('删除账号实例', '将停止所选账号并永久删除它的配置、QQ 私有程序副本、登录资料、缓存和消息 ID 映射。其他账号不受影响。此操作无法撤销，请输入下方实例编号确认。', async () => {
    if (selectedId.value === item.id) await accountsPage.value?.closeRemote();
    await api('/accounts/' + encodeURIComponent(item.id), 'DELETE', { confirmId: item.id });
    if (selectedId.value === item.id) { selectedId.value = ''; draft.value = null; dirty.value = false; nodeResult.value = null; }
    backup.form.profileIds = backup.form.profileIds.filter(id => id !== item.id);
    await refreshOverview();
  }, item.id);
}

async function loadConfig() {
  if (!selectedId.value) return;
  const context = accountContext();
  await task('读取配置', async () => { draft.value = await accountApi<AccountConfig>(context, '/config'); dirty.value = false; });
}

function reloadConfig() {
  if (!dirty.value) { void loadConfig(); return; }
  const context = accountContext();
  confirm('重新读取配置', '当前有未保存的节点修改，重新读取会丢弃这些修改。是否继续？', async () => {
    draft.value = await accountApi<AccountConfig>(context, '/config'); dirty.value = false; nodeResult.value = null;
  });
}

async function saveConfig() {
  if (!draft.value) return;
  const context = accountContext(), payload = writableAccountConfig(draft.value);
  await task('保存节点', async () => {
    const value = await accountApi<Json>(context, '/config', 'PATCH', payload);
    dirty.value = false; nodeResult.value = value; draft.value = await accountApi<AccountConfig>(context, '/config'); await refreshOverview();
  }, '配置已提交；保存与应用结果见节点页，连接状态来自实际运行结果');
}

async function loadContacts() {
  const context = accountContext(), kind = social.kind;
  await task('查询资料', async () => {
    const value = await accountApi<Json[]>(context, '/' + kind);
    if (social.kind !== kind) return;
    if (!Array.isArray(value)) throw new Error('资料响应不是列表'); social.contacts = value; social.detail = null;
  });
}

async function invoke(action: string, params: unknown, context = accountContext()) {
  const response = await accountApi<Json>(context, '/action', 'POST', { action, params });
  if (response.status === 'failed') throw new Error(String(response.message || response.wording || 'QQ 操作失败') + ' (' + String(response.retcode) + ')');
  return response;
}

function resetCapabilities() {
  capabilityRequests.invalidate();
  capabilityState.catalogue = null; capabilityState.loading = false; capabilityState.error = '';
}

function validateCapabilities(value: unknown): CapabilityCatalogue {
  const object = (item: unknown): item is Json => Boolean(item) && typeof item === 'object' && !Array.isArray(item);
  const strings = (item: unknown): item is string[] => Array.isArray(item) && item.every(entry => typeof entry === 'string');
  const action = (item: unknown) => {
    if (!object(item) || typeof item.name !== 'string' || typeof item.implemented !== 'boolean' || typeof item.available !== 'boolean' || typeof item.verification !== 'string') return false;
    if (item.variants !== undefined && (!object(item.variants) || typeof item.variants.custom_text_image_nodes !== 'boolean' || typeof item.variants.existing_message_id_nodes !== 'boolean' || typeof item.variants.existing_scope !== 'string')) return false;
    const target = item.target_validation;
    return target === undefined || object(target) && ['qq_version', 'platform', 'date', 'reference'].every(key => typeof target[key] === 'string') && strings(target.scopes);
  };
  const segment = (item: unknown) => object(item) && typeof item.name === 'string' && typeof item.implemented === 'boolean' && typeof item.send === 'boolean' && typeof item.receive === 'boolean' && typeof item.verification === 'string' &&
    (item.receive_scope === undefined || typeof item.receive_scope === 'string') && (item.send_contexts === undefined || strings(item.send_contexts)) && (item.receive_contexts === undefined || strings(item.receive_contexts));
  if (!object(value) || value.schema_version !== 1 || typeof value.ready !== 'boolean' || !(value.qq_version === null || typeof value.qq_version === 'string') ||
      !Array.isArray(value.actions) || !value.actions.every(action) || !Array.isArray(value.extensions) || !value.extensions.every(action) ||
      !Array.isArray(value.segments) || !value.segments.every(segment) || !Array.isArray(value.segment_extensions) || !value.segment_extensions.every(segment) ||
      !Array.isArray(value.events) || !value.events.every(item => object(item) && typeof item.name === 'string' && typeof item.implemented === 'boolean' && typeof item.available === 'boolean' && strings(item.subtypes)) || !strings(value.notes)) {
    throw new Error('账号能力响应格式无效，请刷新后重试');
  }
  return value as unknown as CapabilityCatalogue;
}

async function loadCapabilities() {
  if (!selectedId.value || !auth.value.authenticated) return;
  resetCapabilities();
  const context = accountContext(), ticket = capabilityRequests.capture();
  capabilityState.loading = true;
  try {
    const value = await accountApi<unknown>(context, '/capabilities');
    ticket.assertCurrent();
    capabilityState.catalogue = validateCapabilities(value);
  } catch (value) {
    if (ticket.isCurrent() && !isStaleRequest(value)) capabilityState.error = value instanceof Error ? value.message : '无法读取当前账号能力';
  } finally {
    if (ticket.isCurrent()) capabilityState.loading = false;
  }
}

function selectCapability(name: string) {
  const catalogue = capabilityState.catalogue;
  if (busy.value || !catalogue || ![...catalogue.actions, ...catalogue.extensions].some(item => item.name === name)) return;
  messages.actionName = name; messages.actionResult = null;
}

async function queryInfo() {
  const context = accountContext(), form = { ...social.queryForm };
  await task('查询详情', async () => {
    const params = form.kind === 'get_stranger_info' ? { user_id: form.id } : form.kind === 'get_group_member_info' ? { group_id: form.id, user_id: form.member } : { group_id: form.id };
    const value = await invoke(form.kind, params, context);
    if (Object.keys(form).every(key => form[key as keyof typeof form] === social.queryForm[key as keyof typeof form])) social.detail = value;
  });
}

async function sendMessage() {
  if (!selectedId.value) { error.value = '请先选择账号'; return; }
  const context = accountContext(), type = messages.form.type, recipient = messages.form.recipient;
  let segments: unknown;
  try {
    segments = messages.form.advanced ? JSON.parse(messages.form.segments) : [
      ...(messages.form.reply ? [{ type: 'reply', data: { id: messages.form.reply } }] : []),
      ...(messages.form.at ? [{ type: 'at', data: { qq: messages.form.at } }] : []),
      ...(messages.form.text ? [{ type: 'text', data: { text: messages.form.text } }] : []),
      ...(messages.uploadedImage ? [{ type: 'image', data: { file: messages.uploadedImage } }] : []),
    ];
    if (!Array.isArray(segments) || !segments.length) throw new Error('请填写非空消息段数组');
  } catch (value) { error.value = value instanceof Error ? value.message : '消息段 JSON 无效'; return; }
  confirm('确认发送消息', '将以实例 ' + context.profileId + ' 向' + (type === 'private' ? ' QQ ' : '群 ') + recipient + ' 发送一次真实消息。请核对账号和接收方；超时不会自动重发。', async () => {
    messages.actionResult = await invoke(type === 'private' ? 'send_private_msg' : 'send_group_msg',
      { [type === 'private' ? 'user_id' : 'group_id']: recipient, message: segments }, context);
  });
}

async function uploadImage(file: File) {
  if (file.size > 10 * 1024 * 1024) { error.value = '图片不能超过 10 MiB'; return; }
  const context = accountContext(), advanced = messages.form.advanced, originalSegments = messages.form.segments;
  let segments: unknown[] | undefined;
  if (advanced) {
    try { const value: unknown = JSON.parse(originalSegments); if (!Array.isArray(value)) throw new Error('消息段必须为数组'); segments = value; }
    catch (value) { error.value = value instanceof Error ? value.message : '消息段 JSON 无效'; return; }
  }
  await task('上传图片', async () => {
    const value = await accountApi<{ file: string }>(context, '/media', 'POST', file,
      { 'X-Filename': encodeURIComponent(file.name) });
    if (advanced !== messages.form.advanced || advanced && originalSegments !== messages.form.segments) throw new Error('消息编辑内容已变化，请重新选择要附加的图片');
    if (segments) {
      segments.push({ type: 'image', data: { file: value.file } });
      messages.form.segments = JSON.stringify(segments, null, 2);
    } else messages.uploadedImage = value.file;
  }, '图片已暂存，确认发送后才会交给 QQ');
}

async function uploadFile(file: File) {
  if (file.size > 50 * 1024 * 1024) { error.value = '文件不能超过 50 MiB'; return; }
  const context = accountContext(), type = messages.form.type, recipient = messages.form.recipient;
  await task('上传文件', async () => {
    const value = await accountApi<{ file: string; name: string; size: number }>(context, '/files', 'POST', file,
      { 'X-Filename': encodeURIComponent(file.name) });
    if (type !== messages.form.type || recipient !== messages.form.recipient) throw new Error('文件接收对象已变化，请核对后重新上传');
    messages.actionName = type === 'private' ? 'upload_private_file' : 'upload_group_file';
    messages.actionParams = JSON.stringify({ file: value.file, name: value.name, [type === 'private' ? 'user_id' : 'group_id']: recipient }, null, 2);
  }, '文件已暂存并填入接口参数，核对后点击“调用接口”才会执行发送');
}

async function executeAction() {
  const context = accountContext(), actionName = messages.actionName;
  let params: unknown;
  try { params = JSON.parse(messages.actionParams); } catch { error.value = '参数 JSON 无效'; return; }
  const action = async () => { messages.actionResult = await invoke(actionName, params, context); };
  const readOnly = new Set(['get_status', 'get_login_info', 'get_version_info', 'get_friend_list', 'get_group_list', 'get_group_info', 'get_group_member_info', 'get_group_member_list', 'get_stranger_info', 'get_msg', 'get_group_file_url', 'get_file', 'get_image', 'get_record']);
  if (readOnly.has(actionName)) await task('调用接口', action);
  else confirm('执行操作接口', '将以实例 ' + context.profileId + ' 执行 ' + actionName + '。该接口可能发送消息或修改 QQ 状态，请核对参数；操作只执行一次。', action);
}

async function loadLogs() {
  const existing = new Set(logs.value.map(logRecordKey));
  await task('读取日志', async () => {
    const value = await api<Json[]>('/logs?limit=1000');
    if (!Array.isArray(value)) throw new Error('日志响应不是列表');
    // Keep records that arrived over SSE while this older HTTP snapshot was in
    // flight, while still discarding old rows absent from the explicit reload.
    logs.value = mergeLogRecords(value, logs.value.filter(item => !existing.has(logRecordKey(item))));
  });
}

async function loadBackups() {
  await task('读取备份', async () => { backup.list = await api<typeof backup.list>('/backups'); });
}

function deleteBackup(id: string) {
  if (busy.value || !backup.list.some(item => item.id === id)) return;
  confirm('删除备份', '将永久删除备份「' + id + '」及其备份文件。删除后无法恢复此备份，请确认已另行保存需要的副本。', async () => {
    await api('/backups/' + encodeURIComponent(id), 'DELETE');
    backup.list = backup.list.filter(item => item.id !== id);
    if (backup.restore.backupId === id) {
      backup.restore.backupId = ''; backup.restore.previewId = '';
      backup.restore.preview = null; backup.restore.password = '';
    }
    try { backup.list = await api<typeof backup.list>('/backups'); }
    catch (value) {
      throw new Error('备份已删除，但列表刷新失败，请点击刷新重试。' + (value instanceof Error ? '（' + value.message + '）' : ''));
    }
  }, undefined, '永久删除备份', true);
}

async function createBackup() {
  if (!backup.form.profileIds.length) { error.value = '请至少选择一个账号'; return; }
  if (backup.form.kind === 'full' && backup.form.password.length < 12) { error.value = '完整备份请使用至少 12 位的独立密码'; return; }
  confirm('创建备份', backup.form.kind === 'full' ? '将停止所选账号以取得一致快照。完整备份包含 QQ 登录状态、token 与消息映射；独立密码丢失后无法恢复。' : '将短暂停止所选账号，导出脱敏配置与消息 ID 映射，排除登录数据、token 和聊天正文。', async () => {
    try { await api('/backups', 'POST', { profileIds: backup.form.profileIds, kind: backup.form.kind, ...(backup.form.kind === 'full' ? { password: backup.form.password } : {}) }); }
    finally { backup.form.password = ''; }
    backup.list = await api<typeof backup.list>('/backups');
  });
}

async function uploadBackup(file: File) {
  await task('上传备份', async () => {
    const value = await api<{ id: string }>('/backups/upload', 'POST', file);
    backup.restore.backupId = value.id;
    backup.list = await api<typeof backup.list>('/backups');
  }, '备份已上传，验证预览后才能恢复');
}

async function previewRestore() {
  const backupId = backup.restore.backupId, password = backup.restore.password;
  invalidateRestore();
  const ticket = restoreRequests.capture();
  await task('验证备份', async () => {
    try {
      const value = await api<Json>('/backups/restore/preview', 'POST', { backupId, password: password || undefined }, {}, ticket.signal);
      ticket.assertCurrent();
      if (value.backupId !== backupId || typeof value.previewId !== 'string' || !value.previewId) throw new Error('备份预览与当前选择不一致，请重新验证');
      backup.restore.previewId = String(value.previewId || ''); backup.restore.preview = value;
    } finally {
      if (backup.restore.password === password) {
        clearingRestorePassword = true; backup.restore.password = ''; clearingRestorePassword = false;
      }
    }
  });
}

function applyRestore() {
  const { backupId, previewId, preview } = backup.restore;
  if (!previewId || !preview || (preview as Json).backupId !== backupId) { error.value = '请先验证当前选择的备份'; return; }
  const ticket = restoreRequests.capture();
  confirm('确认恢复数据', '将停止并替换预览中列出的账号状态，保留回滚数据。恢复后账号保持停止，需要你明确启动。', async () => {
    ticket.assertCurrent();
    if (backup.restore.backupId !== backupId || backup.restore.previewId !== previewId) throw new Error('备份选择已改变，请重新验证');
    invalidateRestore();
    await api('/backups/restore/apply', 'POST', { previewId, backupId });
    await refreshOverview();
  });
}

function applySettings(value: Json, scope: 'all' | 'runtime' | 'global' = 'all', expected?: { runtime?: string; global?: string }) {
  const keepRuntime = expected?.runtime !== undefined && expected.runtime !== runtimeDraft()
    ? { maxAccounts: settings.maxAccounts, publicBaseUrl: settings.publicBaseUrl, statusCommand: { ...settings.statusCommand } } : null;
  const keepGlobal = expected?.global !== undefined && expected.global !== globalDraft()
    ? { rkey: { fallbackServers: [...settings.rkey.fallbackServers] }, musicSignUrl: settings.musicSignUrl, musicSignKey: settings.musicSignKey, clearMusicSignKey: settings.clearMusicSignKey } : null;
  if (scope !== 'global') {
    settings.maxAccounts = Number(value.maxAccounts) || 2;
    settings.publicBaseUrl = String(value.publicBaseUrl || '');
    const command = value.statusCommand && typeof value.statusCommand === 'object' && !Array.isArray(value.statusCommand) ? value.statusCommand as Json : {};
    settings.statusCommand = { enabled: command.enabled !== false, trigger: typeof command.trigger === 'string' ? command.trigger : '#fd' };
    savedSettings.runtime = runtimeDraft();
  }
  if (scope !== 'runtime') {
    const rkey = value.rkey && typeof value.rkey === 'object' && !Array.isArray(value.rkey) ? value.rkey as Json : {};
    settings.rkey.fallbackServers = Array.isArray(rkey.fallbackServers) ? rkey.fallbackServers.map(String) : [];
    settings.musicSignUrl = String(value.musicSignUrl || '');
    settings.hasMusicSignKey = value.hasMusicSignKey === true;
    settings.musicSignKey = ''; settings.clearMusicSignKey = false;
    savedSettings.global = globalDraft();
  }
  // Service URLs may carry private query parameters. Keep them in their own
  // authenticated editor rather than the general runtime summary.
  settings.text = JSON.stringify({ maxAccounts: value.maxAccounts, publicBaseUrl: value.publicBaseUrl, statusCommand: value.statusCommand, needsRestart: value.needsRestart }, null, 2);
  settingsLoaded.value = true;
  if (keepRuntime) Object.assign(settings, keepRuntime);
  if (keepGlobal) Object.assign(settings, keepGlobal);
}

async function loadSettings() {
  const reload = async () => {
    const expected = { runtime: runtimeDraft(), global: globalDraft() };
    applySettings(await api<Json>('/settings'), 'all', expected);
  };
  if (settingsDirty.value) {
    confirm('重新读取设置', '存在尚未保存的运行或全局配置。重新读取将丢弃这些修改。', reload);
    return;
  }
  await task('读取设置', reload);
}

function saveSettings() {
  let statusCommand: { enabled: boolean; trigger: string };
  try {
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(settings.statusCommand.trigger)) throw new Error('状态指令触发词不能包含控制字符');
    const trigger = settings.statusCommand.trigger.trim().toLowerCase();
    if (!trigger || [...trigger].length > 32 || /\s/u.test(trigger)) throw new Error('状态指令触发词需为 1–32 个字符，不能包含内部空白');
    statusCommand = { enabled: settings.statusCommand.enabled, trigger };
  } catch (value) { error.value = value instanceof Error ? value.message : '状态指令配置无效'; return; }
  const payload = { maxAccounts: settings.maxAccounts, publicBaseUrl: settings.publicBaseUrl, statusCommand };
  const expected = { runtime: runtimeDraft() };
  confirm('保存系统设置', '将更新运行上限、对外资源链接地址与内置状态指令。状态指令对所有账号即时生效，无需重启 QQ；启用后任何人均可在私聊或群聊触发。降低运行上限前请先停止多余账号。', async () => {
    const value = await api<Json>('/settings', 'PATCH', payload);
    applySettings(value, 'runtime', expected); await refreshOverview();
  });
}

function serviceUrl(input: string, label: string) {
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new Error(label + '不能包含控制字符');
  const value = input.trim();
  if (!value) return '';
  if (value.length > 2048) throw new Error(label + '最多 2048 个字符');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(label + '需为有效的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) throw new Error(label + '仅支持 HTTP(S)，不能包含用户名、密码或片段');
  return value;
}

function saveGlobalSettings() {
  let payload: { rkey: { fallbackServers: string[] }; musicSignUrl: string; musicSignKey?: string; clearMusicSignKey?: true };
  try {
    if (settings.rkey.fallbackServers.length > 8) throw new Error('rkey 回退服务器最多 8 个');
    const fallbackServers = settings.rkey.fallbackServers.map((value, index) => serviceUrl(value, '第 ' + (index + 1) + ' 个 rkey 地址')).filter(Boolean);
    payload = { rkey: { fallbackServers }, musicSignUrl: serviceUrl(settings.musicSignUrl, '音乐卡片签名地址') };
    if (settings.clearMusicSignKey) payload.clearMusicSignKey = true;
    else if (settings.musicSignKey) payload.musicSignKey = settings.musicSignKey;
  } catch (value) { error.value = value instanceof Error ? value.message : '全局配置无效'; return; }
  const expected = { global: globalDraft() };
  confirm('保存全局配置', '将更新所有账号共用的 rkey 回退服务器和音乐卡片签名设置，无需重启 QQ。服务地址留空会禁用对应服务；密钥留空保留，只有明确勾选才清除。此操作不会试连服务或发送消息。', async () => {
    applySettings(await api<Json>('/settings', 'PATCH', payload), 'global', expected);
  });
}

async function loadStorage() {
  await task('统计存储', async () => { storage.value = await api<StorageSnapshot>('/storage'); });
}

function saveStoragePolicy(policy: { logMaxMiB: number; logRetentionDays: number }) {
  if (!Number.isInteger(policy.logMaxMiB) || policy.logMaxMiB < 1 || policy.logMaxMiB > 102400 || !Number.isInteger(policy.logRetentionDays) || policy.logRetentionDays < 0 || policy.logRetentionDays > 3650) {
    error.value = '日志总限额需为 1–102400 MiB，保留天数需为 0–3650 天，且均为整数；0 表示仅按容量清理'; return;
  }
  confirm('保存日志清理策略', '将立即应用所有账号与管理服务共用的日志总限额和保留天数，并启用每 5 分钟一次的策略清理。超期或超限的日志可能被删除；消息历史与媒体缓存不受此策略影响。', async () => {
    const value = await api<{ cleanup: StorageCleanup }>('/storage/policy', 'PATCH', policy);
    storageResult.value = value.cleanup;
    storage.value = await api<StorageSnapshot>('/storage');
    if (value.cleanup.partial) throw new Error('日志策略已保存，清理部分完成。请查看存储管理中的处理结果，再刷新确认。');
  });
}

function cleanupStorage(request: StorageCleanupRequest) {
  const item = request.scope === 'account' ? storage.value?.accounts.find(value => value.profileId === request.profileId) : undefined;
  if (request.scope === 'account' && (!item || !item.canClean)) { error.value = item?.blockedReason || '账号尚未完全停止，不能清理历史或媒体缓存'; return; }
  const category = request.scope === 'account' && request.category === 'history' ? '消息历史正文' : '媒体缓存';
  const policy = storage.value?.policy;
  const message = request.scope === 'logs'
    ? '将按当前已保存的日志策略（总限额 ' + (policy?.logMaxMiB ?? 1024) + ' MiB、' + (policy?.logRetentionDays === 0 ? '不按时间清理' : '保留 ' + (policy?.logRetentionDays ?? 7) + ' 天') + '）执行一次清理，不会清空全部日志。消息历史、媒体缓存和 QQ 登录资料保持不变。'
    : '将清理此账号的' + category + '。必须保持账号完全停止；程序不会自动停止账号。保留 QQ 程序、配置、登录资料与 OneBot 消息 ID 和定位映射。请输入完整实例编号确认。';
  confirm(request.scope === 'logs' ? '按策略清理日志' : '清理' + category, message, async () => {
    if (request.scope === 'account') {
      storage.value = await api<StorageSnapshot>('/storage');
      const current = storage.value.accounts.find(value => value.profileId === request.profileId);
      if (!current?.canClean) throw new Error(current?.blockedReason || '账号状态已变化，请完全停止后再清理');
    }
    storageResult.value = await api<StorageCleanup>('/storage/cleanup', 'POST', request.scope === 'account' ? { ...request, confirmId: request.profileId } : request);
    storage.value = await api<StorageSnapshot>('/storage');
    if (storageResult.value.partial) throw new Error('清理部分完成，存在未能核验或已变化的文件。请查看存储管理中的处理结果，再刷新确认。');
  }, request.scope === 'account' ? request.profileId : undefined, request.scope === 'account' ? '确认清理' : undefined);
}

async function changePassword() {
  if (settings.passwords.newPassword !== settings.passwords.confirm) { error.value = '两次新密码不一致'; return; }
  await task('修改密码', async () => {
    await api('/auth/password', 'POST', { currentPassword: settings.passwords.currentPassword, newPassword: settings.passwords.newPassword });
    settings.passwords.currentPassword = ''; settings.passwords.newPassword = ''; settings.passwords.confirm = '';
    unauthorized();
    toast('密码已更新，请重新登录');
  });
}

async function openAccessPassword() {
  tab.value = 'settings';
  await nextTick();
  settingsPage.value?.openSection('password');
}

function settingsSubnav(id: string) {
  if (id === 'backup' && !backup.list.length) void loadBackups();
}

watch(selectedId, () => { accountRequests.invalidate(); resetCapabilities(); }, { flush: 'sync' });
watch(capabilitySession, resetCapabilities, { flush: 'sync' });
watch(() => [tab.value, social.tab, selectedId.value, capabilitySession.value], () => {
  if (tab.value === 'social' && social.tab === 'messages' && selectedId.value) void loadCapabilities();
});
watch(tab, value => {
  error.value = '';
  queuePageLoad(value);
});

function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || settingsDirty.value) { event.preventDefault(); event.returnValue = ''; } }

onMounted(() => {
  window.addEventListener('freshwater:unauthorized', unauthorized);
  window.addEventListener('beforeunload', beforeUnload);
  void checkAuth();
  timer = setInterval(() => { if (auth.value.authenticated && !document.hidden && !busy.value) refreshOverview().catch(value => { if (!isStaleRequest(value)) error.value = value instanceof Error ? value.message : '状态刷新失败'; }); }, 15000);
});

onBeforeUnmount(() => {
  taskRevision++; pendingPageLoad = null;
  accountRequests.invalidate(); overviewRequests.invalidate(); setCsrf('');
  resetCapabilities();
  stream?.close(); stream = undefined;
  if (timer) clearInterval(timer);
  window.removeEventListener('freshwater:unauthorized', unauthorized);
  window.removeEventListener('beforeunload', beforeUnload);
});

function downloadBackup(id: string) {
  void task('下载备份', () => download('/backups/' + encodeURIComponent(id) + '/download', id));
}
</script>

<template>
  <div v-if="loading" class="loading-screen">
    <img :src="logo" alt="Freshwater-dolphin" class="brand-logo" />
    <p><span class="spinner" aria-hidden="true"></span> 正在连接管理服务…</p>
  </div>

  <main v-else-if="!auth.authenticated" class="auth-page">
    <picture class="auth-art">
      <source media="(min-width: 761px)" :srcset="artWide" type="image/jpeg" />
      <img :src="artPortrait" alt="" aria-hidden="true" fetchpriority="high" decoding="async" />
    </picture>
    <div class="auth-veil" aria-hidden="true"></div>
    <div class="auth-moon" aria-hidden="true"></div>
    <div class="auth-comet" aria-hidden="true"></div>
    <div class="auth-theme"><ThemeModeControl /></div>
    <div class="auth-story">
      <a class="brand"><img :src="logo" alt="Freshwater-dolphin" class="brand-logo" /><span>Freshwater<span class="brand-sub">DOLPHIN</span></span></a>
      <div class="auth-story-body">
        <span class="eyebrow">YOUR QQ, CONNECTED.</span>
        <h1>让每一次连接，<br /><span>清晰而从容。</span></h1>
        <p>独立管理你的 QQ 账号与 OneBot 连接。<br />从这一次安全登录开始。</p>
      </div>
      <small class="auth-story-foot">独立协议服务 · 私有账号状态 · 密码访问</small>
    </div>
    <div class="auth-card-wrap">
      <section class="auth-card">
        <span class="eyebrow">MANAGEMENT CONSOLE</span>
        <h2>{{ auth.initialized ? '欢迎回来' : '初始化管理台' }}</h2>
        <p>{{ auth.initialized ? '输入 WebUI 访问密码，进入面板管理 QQ 账号和连接。' : '使用服务器私有目录中的一次性初始化凭据，设置至少 12 位的 WebUI 访问密码。' }}</p>
        <form @submit.prevent="login">
          <fieldset :disabled="!!busy">
            <label v-if="!auth.initialized">一次性初始化凭据<input v-model="authForm.setupToken" type="password" autocomplete="off" required /></label>
            <label>{{ auth.initialized ? 'WebUI 访问密码' : '设置 WebUI 访问密码' }}<input v-model="authForm.password" type="password" :autocomplete="auth.initialized ? 'current-password' : 'new-password'" required :minlength="auth.initialized ? 1 : 12" /></label>
            <label v-if="!auth.initialized">确认密码<input v-model="authForm.confirm" type="password" autocomplete="new-password" required minlength="12" /></label>
            <div v-if="error" role="alert" class="alert error">{{ error }}</div>
            <button class="primary wide" :disabled="!!busy">{{ busy || (auth.initialized ? '登录管理台' : '设置访问密码') }} <span aria-hidden="true">→</span></button>
          </fieldset>
        </form>
        <small>登录状态通过安全会话管理。请勿向他人提供初始化凭据或 QQ 登录二维码。</small>
      </section>
    </div>
  </main>

  <div v-else class="app-shell">
    <aside class="sidebar">
      <a class="brand" @click="tab = 'overview'"><img :src="logo" alt="Freshwater-dolphin" class="brand-logo" /><span>Freshwater<span class="brand-sub">DOLPHIN CONSOLE</span></span></a>
      <div class="nav-label">工作空间</div>
      <nav aria-label="主导航">
        <button v-for="item in tabs" :key="item.id" :class="{ active: tab === item.id }" :aria-current="tab === item.id ? 'page' : undefined" @click="tab = item.id">
          <span class="nav-icon" aria-hidden="true"><Icon :name="item.icon" :size="18" /></span><span>{{ item.title }}<small>{{ item.caption }}</small></span>
        </button>
      </nav>
      <div class="sidebar-footer"><span class="dot" :class="{ online: streamConnected }"></span>{{ streamConnected ? '实时状态已连接' : '实时流重连中' }}<small>v{{ overview.version || '—' }}</small></div>
    </aside>

    <div class="main-shell">
      <header class="topbar">
        <span class="crumb"><span class="workspace-dot" aria-hidden="true"></span>工作空间<span class="sep">/</span>{{ title }}</span>
        <div class="top-actions">
          <span class="live-chip"><span class="dot" :class="{ online: streamConnected }"></span>{{ streamConnected ? '实时同步' : '连接中' }}</span>
          <ThemeModeControl />
          <button type="button" class="ghost access-password" title="设置 WebUI 访问密码" aria-label="设置 WebUI 访问密码" :disabled="!!busy" @click="openAccessPassword"><Icon name="lock" :size="15" /><span>访问密码</span></button>
          <button class="ghost" :disabled="!!busy" @click="logout">退出</button>
        </div>
      </header>

      <main class="content">
        <PageHeading :eyebrow="'FRESHWATER / ' + tab.toUpperCase()" :title="title" :description="subtitles[tab]">
          <template #actions><button class="secondary" :disabled="!!busy" @click="task('刷新状态', refreshOverview)"><Icon name="refresh" :size="15" /> 刷新状态</button></template>
        </PageHeading>

        <div v-if="busy" class="operation" role="status"><span class="spinner"></span>{{ busy }}…</div>
        <div v-if="error" class="alert error" role="alert"><span>{{ error }}</span><button class="ghost" @click="error = ''">关闭</button></div>

        <OverviewPage v-if="tab === 'overview'" :overview="overview" :busy="!!busy" @refresh="task('刷新状态', refreshOverview)" @open-accounts="tab = 'accounts'" @select="openAccount" />

        <AccountsPage
          v-else-if="tab === 'accounts'"
          ref="accountsPage"
          :accounts="overview.accounts"
          :selected-id="selectedId"
          :busy="!!busy"
          @create="createAccount"
          @operation="accountOperation"
          @recover="recoverMaintenance"
          @bridge="bridgeOperation"
          @remove="deleteAccount"
          @select="selectAccount"
        />

        <NodeManager
          v-else-if="tab === 'nodes'"
          :accounts="overview.accounts"
          :selected-id="selectedId"
          :config="draft"
          :busy="!!busy"
          :dirty="dirty"
          :result="nodeResult"
          @select="selectAccount"
          @change="draft = $event; dirty = true; nodeResult = null"
          @save="saveConfig"
          @reload="reloadConfig"
        />

        <SocialPage
          v-else-if="tab === 'social'"
          :accounts="overview.accounts"
          :selected-id="selectedId"
          :busy="!!busy"
          :social="social"
          :messages="messages"
          :capability-state="capabilityState"
          @select="selectAccount"
          @load-contacts="loadContacts"
          @query-info="queryInfo"
          @send-message="sendMessage"
          @upload-image="uploadImage"
          @upload-file="uploadFile"
          @execute-action="executeAction"
          @load-capabilities="loadCapabilities"
          @select-capability="selectCapability"
        />

        <LogConsole
          v-else-if="tab === 'logs'"
          :records="logs"
          :accounts="overview.accounts"
          :paused="logPaused"
          :connected="streamConnected"
          :busy="!!busy"
          @pause="logPaused = $event"
          @reload="loadLogs"
        />

        <SettingsPage
          v-else-if="tab === 'settings'"
          ref="settingsPage"
          :overview="overview"
          :busy="!!busy"
          :settings="settings"
          :settings-dirty="settingsDirty"
          :backup="backup"
          :storage="storage"
          :storage-result="storageResult"
          @subnav="settingsSubnav"
          @save-settings="saveSettings"
          @save-global-settings="saveGlobalSettings"
          @load-storage="loadStorage"
          @save-storage-policy="saveStoragePolicy"
          @cleanup-storage="cleanupStorage"
          @load-settings="loadSettings"
          @change-password="changePassword"
          @create-backup="createBackup"
          @upload-backup="uploadBackup"
          @preview-restore="previewRestore"
          @apply-restore="applyRestore"
          @load-backups="loadBackups"
          @download="downloadBackup"
          @delete-backup="deleteBackup"
        />
      </main>

      <footer class="page-footer"><span>Freshwater-dolphin</span><span>独立维护 · 私有部署</span></footer>
    </div>

    <ConfirmDialog
      :open="!!confirmDialog"
      :title="confirmDialog?.title || ''"
      :message="confirmDialog?.message || ''"
      :required-id="confirmDialog?.requiredId"
      :confirm-label="confirmDialog?.confirmLabel"
      :danger="confirmDialog?.danger"
      @confirm="confirmedAction"
      @cancel="confirmDialog = null"
    />
  </div>
  <ToastStack />
</template>
