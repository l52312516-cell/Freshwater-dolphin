<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import type { Account, AccountConfig, Json, NodeConfig } from '../types';
import AccountAvatar from './AccountAvatar.vue';
import SectionCard from './SectionCard.vue';
import EmptyState from './EmptyState.vue';
import AccountNotifications from './AccountNotifications.vue';
import Icon from './Icon.vue';
import type { IconName } from './Icon.vue';
import { stateLabel } from '../labels';

const props = defineProps<{ accounts: Account[]; selectedId: string; config: AccountConfig | null; busy: boolean; dirty: boolean; result: Json | null }>();
const emit = defineEmits<{ select: [id: string]; change: [config: AccountConfig]; save: []; reload: [] }>();
type Kind = 'general' | NodeConfig['type'];
const kinds: { id: Kind; title: string; caption: string; icon: IconName }[] = [
  { id: 'general', title: '通用设置', caption: '账号身份与动作处理策略', icon: 'sliders' },
  { id: 'httpApi', title: 'HTTP API', caption: '通过 HTTP 请求调用当前账号的 OneBot 接口', icon: 'arrowRight' },
  { id: 'httpPost', title: 'HTTP 客户端', caption: '主动向机器人服务上报事件，可配置 HMAC 签名', icon: 'send' },
  { id: 'wsServer', title: 'WS 服务端', caption: '接收机器人主动建立的 WebSocket 连接', icon: 'server' },
  { id: 'wsClient', title: 'WS 客户端', caption: '主动连接外部 WebSocket 服务器（reverse-ws）', icon: 'link' },
];
const selected = computed(() => props.accounts.find(account => account.id === props.selectedId));
const kind = ref<Kind>('wsClient');
const listed = computed(() => props.config?.nodes.filter(node => node.type === kind.value) || []);
const editDialog = ref<HTMLDialogElement | null>(null);
const removeDialog = ref<HTMLDialogElement | null>(null);
const editor = ref<NodeConfig | null>(null);
const editorIndex = ref(-1);
const removing = ref<NodeConfig | null>(null);
const editorError = ref('');
const advanced = ref(false);
const reveal = reactive({ token: false, secret: false });
const copied = ref('');

const LIMITS = {
  maxPending: [1, 128], ratePerSecond: [1, 1000], burst: [1, 2000],
  eventBufferSize: [1, 10000], eventMaxAgeMs: [1000, 60000],
  heartbeatMs: [100, 300000], pingTimeoutMs: [100, 60000], timeoutMs: [100, 120000],
  reconnectMinMs: [10, 30000], reconnectMaxMs: [10, 30000],
} as const;

function count(type: Kind) { return props.config?.nodes.filter(node => node.type === type).length || 0; }
function change(value: Partial<AccountConfig>) { if (props.config) emit('change', { ...props.config, ...value }); }
function accountStatus(account: Account) {
  if (['account_mismatch', 'duplicate_account', 'bridge_unavailable', 'error', 'start_failed', 'apply_failed', 'stop_unconfirmed', 'maintenance_failed', 'maintenance_interrupted'].includes(account.state)) return stateLabel(account.state);
  return account.bridgeInstalled === false ? '仅 QQ 模式' : account.health?.ready === true ? account.health?.online === true ? '在线' : '会话就绪' : account.desired === 'running' ? '等待登录' : '已停止';
}
function address(node: NodeConfig) {
  return ['httpPost', 'wsClient'].includes(node.type) ? node.url || '尚未配置地址' :
    (node.type === 'wsServer' ? location.origin.replace(/^http/, 'ws') : location.origin) + '/onebot/' + encodeURIComponent(props.selectedId) + '/' + encodeURIComponent(node.id);
}
function runtime(node: NodeConfig) {
  const states = selected.value?.health?.nodes;
  return Array.isArray(states) ? states.find((value: Json) => value.id === node.id && value.type === node.type) as Json | undefined : undefined;
}
function status(node: NodeConfig) {
  if (!node.enabled) return { title: props.dirty ? '待保存 · 停用' : '已停用', tone: 'disabled' };
  const actual = runtime(node);
  if (!actual) return { title: '等待应用', tone: 'waiting' };
  if (actual.status === 'connected') return { title: '正常 · 已连接', tone: 'connected' };
  if (actual.status === 'listening') return { title: '正常 · 监听中', tone: 'connected' };
  if (actual.status === 'active') return { title: node.type === 'wsServer' ? actual.connected === true ? '正常 · 已连接' : '监听中 · 等待连接' : node.type === 'httpApi' ? '正常 · 接口就绪' : '正常 · 上报已启用', tone: 'connected' };
  if (actual.status === 'disabled') return { title: '运行态 · 已停用', tone: 'disabled' };
  return { title: ({ waiting: '等待账号就绪', connecting: '正在连接', backoff: '等待重连', degraded: '连接异常', error: '连接错误', idle: '等待请求', ready: '就绪' } as Record<string, string>)[String(actual.status)] || String(actual.status || '状态未知'), tone: actual.lastError ? 'error' : 'waiting' };
}
function toggle(node: NodeConfig) {
  if (!props.config) return;
  change({ nodes: props.config.nodes.map(value => value.id === node.id ? { ...value, enabled: !value.enabled } : value) });
}
async function edit(node?: NodeConfig) {
  if (!props.config || props.busy) return;
  editorError.value = ''; advanced.value = false; reveal.token = false; reveal.secret = false;
  editorIndex.value = node ? props.config.nodes.indexOf(node) : -1;
  editor.value = node ? JSON.parse(JSON.stringify(node)) : {
    id: 'node-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), label: '', type: kind.value === 'general' ? 'wsClient' : kind.value,
    enabled: false, role: 'Universal', heartbeatMs: 30000, timeoutMs: 10000, pingTimeoutMs: 10000,
    quickOperations: true, maxPending: 16, ratePerSecond: 20, burst: 40, eventBufferSize: 1000, eventMaxAgeMs: 60000,
    ...(['httpPost', 'wsClient'].includes(kind.value) ? { url: '' } : {}),
  };
  await nextTick(); editDialog.value?.showModal();
}
function closeEditor() { editDialog.value?.close(); editor.value = null; editorError.value = ''; }
function secretInput(key: 'token' | 'secret', event: Event) {
  if (editor.value) editor.value[key] = (event.target as HTMLInputElement).value || undefined;
}
function generateToken() {
  if (!editor.value) return;
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  editor.value.token = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  reveal.token = true;
}
async function copyValue(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); copied.value = what; setTimeout(() => { if (copied.value === what) copied.value = ''; }, 1600); }
  catch { /* Clipboard can be unavailable on insecure origins. */ }
}
function copyAddress(node: NodeConfig) { void copyValue(address(node), 'address-' + node.id); }
function numeric(value: number | undefined, name: keyof typeof LIMITS, fallback: number) {
  const [min, max] = LIMITS[name];
  const actual = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(actual) || actual < min || actual > max) throw new Error(name + ' 需为 ' + min + '–' + max + ' 之间的整数');
  return actual;
}
function commit() {
  if (!editor.value || !props.config) return;
  editorError.value = '';
  let node: NodeConfig;
  try {
    node = {
      ...editor.value,
      label: editor.value.label?.trim() || undefined,
      heartbeatMs: numeric(editor.value.heartbeatMs, 'heartbeatMs', 30000),
      timeoutMs: numeric(editor.value.timeoutMs, 'timeoutMs', 10000),
      pingTimeoutMs: numeric(editor.value.pingTimeoutMs, 'pingTimeoutMs', 10000),
      maxPending: numeric(editor.value.maxPending, 'maxPending', 16),
      ratePerSecond: numeric(editor.value.ratePerSecond, 'ratePerSecond', 20),
      burst: numeric(editor.value.burst, 'burst', 40),
      eventBufferSize: numeric(editor.value.eventBufferSize, 'eventBufferSize', 1000),
      eventMaxAgeMs: numeric(editor.value.eventMaxAgeMs, 'eventMaxAgeMs', 60000),
      ...(['wsClient'].includes(editor.value.type)
        ? { reconnectMinMs: numeric(editor.value.reconnectMinMs, 'reconnectMinMs', 1000), reconnectMaxMs: numeric(editor.value.reconnectMaxMs, 'reconnectMaxMs', 30000) }
        : {}),
    };
    if ((node.reconnectMinMs || 0) > (node.reconnectMaxMs || 0)) throw new Error('最大重连间隔不能小于最小重连间隔');
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : '参数无效';
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(node.id)) { editorError.value = '节点 ID 请使用 1–64 位字母、数字、下划线或短横线。'; return; }
  if (props.config.nodes.some((value, index) => value.id === node.id && index !== editorIndex.value)) { editorError.value = '节点 ID 已存在。'; return; }
  if (['httpPost', 'wsClient'].includes(node.type)) {
    try {
      const url = new URL(node.url || '');
      if (!(node.type === 'httpPost' ? ['http:', 'https:'] : ['ws:', 'wss:']).includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error();
    } catch { editorError.value = '请填写此连接类型的有效地址，凭据请放在独立 token 字段中。'; return; }
  }
  if (node.enabled && ['httpApi', 'wsServer'].includes(node.type) && (node.token === '' || !node.token && !node.tokenPresent)) {
    editorError.value = '启用 HTTP API 或 WS 服务端前必须设置访问 token。'; return;
  }
  const nodes = [...props.config.nodes];
  if (editorIndex.value >= 0) nodes[editorIndex.value] = node; else nodes.push(node);
  change({ nodes }); closeEditor();
}
async function askRemove(node: NodeConfig) { if (props.busy) return; removing.value = node; await nextTick(); removeDialog.value?.showModal(); }
function remove() {
  if (props.config && removing.value) change({ nodes: props.config.nodes.filter(node => node.id !== removing.value?.id) });
  removeDialog.value?.close(); removing.value = null;
}
function closeEditors() { editDialog.value?.close(); removeDialog.value?.close(); editor.value = null; removing.value = null; editorError.value = ''; }
watch(() => props.selectedId, closeEditors);
</script>

<template>
  <section class="node-workspace">
    <aside class="node-accounts panel">
      <div class="rail-heading"><span>账号连接</span><small>{{ accounts.length }} 个实例</small></div>
      <button v-for="item in accounts" :key="item.id" class="node-account" :class="{ selected: item.id === selectedId }" :disabled="busy" @click="emit('select', item.id)">
        <AccountAvatar :account="item" size="small" /><span><strong>{{ item.label || item.id }}</strong><small>{{ item.expectedUin || '等待身份确认' }}</small></span><i class="account-dot" :class="{ online: item.health?.ready === true && item.health?.online === true }"></i>
      </button>
      <p v-if="!accounts.length" class="note">尚无账号，请先创建账号实例。</p>
    </aside>
    <div class="node-main panel">
      <div class="node-title">
        <div>
          <span class="eyebrow">ONEBOT CONNECTIONS</span>
          <h2>OneBot 协议端点</h2>
          <p v-if="selected">{{ selected.label }} <span>· QQ {{ selected.expectedUin || '身份待确认' }}</span><span class="node-account-status">{{ accountStatus(selected) }}</span></p>
        </div>
        <div class="button-row">
          <button v-if="kind !== 'general'" class="secondary" :disabled="busy || !config || config.nodes.length >= 64" @click="edit()"><Icon name="plus" :size="15" /> 新建{{ kinds.find(item => item.id === kind)?.title }}</button>
          <button class="primary" :disabled="busy || !config || !dirty" @click="emit('save')">保存并应用</button>
        </div>
      </div>
      <div v-if="selected" class="node-tabs" role="tablist" aria-label="连接类型">
        <button v-for="item in kinds" :key="item.id" role="tab" :aria-selected="kind === item.id" :class="{ active: kind === item.id }" @click="kind = item.id">{{ item.title }}<span v-if="item.id !== 'general'">{{ count(item.id) }}</span></button>
      </div>
      <div class="node-save-state">
        <span v-if="dirty" class="draft-dot">● 有未保存的配置</span>
        <span v-else-if="result?.applied === false" class="inline-error">已保存，应用失败：{{ result.error || '请检查账号状态' }}</span>
        <span v-else-if="result?.saved === true">✓ 配置已保存{{ selected?.desired === 'running' ? '，已提交应用' : '，启动账号后生效' }}</span>
        <span v-else-if="config">配置已读取</span>
        <button v-if="config" class="text-button" :disabled="busy" @click="emit('reload')">重新读取</button>
      </div>
      <div v-if="!selected" class="empty compact">选择左侧账号以管理连接节点。</div>
      <div v-else-if="!config" class="empty compact">正在读取账号配置…</div>
      <template v-else-if="kind === 'general'">
        <p class="node-description">{{ kinds[0]?.caption }}。保存时会重新应用当前账号配置，其他账号保持运行。</p>
        <div class="node-general">
          <label>账号备注<input :value="config.label" maxlength="100" :disabled="busy" @input="change({ label: ($event.target as HTMLInputElement).value })" /></label>
          <label>预期 QQ 号<input :value="config.expectedUin" inputmode="numeric" :disabled="busy" @input="change({ expectedUin: ($event.target as HTMLInputElement).value })" /></label>
          <label>动作超时（毫秒）<input :value="config.actionTimeoutMs" type="number" min="100" max="120000" :disabled="busy" @input="change({ actionTimeoutMs: Number(($event.target as HTMLInputElement).value) })" /></label>
        </div>
        <div class="node-hint"><span aria-hidden="true">◇</span><p>每个节点只连接当前 QQ 实例。节点的启用开关属于配置；“已连接”与“监听中”来自实际运行状态。未保存的修改尚未生效。</p></div>
        <AccountNotifications :profile-id="selectedId" :disabled="busy" />
      </template>
      <template v-else-if="config">
        <p class="node-description">{{ kinds.find(item => item.id === kind)?.caption }}</p>
        <div class="node-list">
          <article v-for="node in listed" :key="node.id" class="connection-card">
            <div class="connection-info">
              <div class="connection-name"><h3>{{ node.label || node.id }}</h3><span class="node-status" :class="status(node).tone">{{ status(node).title }}</span></div>
              <p class="connection-url"><code>{{ address(node) }}</code><button type="button" class="copy-inline" :aria-label="'复制地址 ' + (node.label || node.id)" @click="copyAddress(node)"><Icon name="copy" :size="13" /><span>{{ copied === 'address-' + node.id ? '已复制' : '复制' }}</span></button></p>
              <div class="connection-meta">
                <span>{{ node.type.startsWith('ws') ? node.role || 'Universal' : node.type === 'httpPost' ? '事件上报' : '动作接口' }}</span>
                <span>{{ node.tokenPresent || node.token ? '已设置 Token' : '无 Token' }}</span>
                <span v-if="node.type === 'httpPost'">{{ node.secretPresent || node.secret ? 'HMAC 签名' : '无签名' }}</span>
                <span v-if="node.type === 'httpPost'">{{ node.quickOperations !== false ? '允许快速操作' : '快速操作关闭' }}</span>
                <span v-if="Number(runtime(node)?.connections) > 0">{{ runtime(node)?.connections }} 个连接</span>
              </div>
              <p v-if="runtime(node)?.lastError" class="connection-error">{{ runtime(node)?.lastError }}</p>
            </div>
            <div class="connection-actions">
              <button class="switch" :class="{ on: node.enabled }" role="switch" :aria-checked="node.enabled" :aria-label="'启用节点 ' + (node.label || node.id)" :disabled="busy" @click="toggle(node)"><span></span></button>
              <button class="icon-button" :disabled="busy" :aria-label="'编辑节点 ' + (node.label || node.id)" title="编辑节点" @click="edit(node)"><Icon name="edit" :size="16" /></button>
              <button class="icon-button danger-text" :disabled="busy" :aria-label="'删除节点 ' + (node.label || node.id)" title="删除节点" @click="askRemove(node)"><Icon name="trash" :size="16" /></button>
            </div>
          </article>
        </div>
        <EmptyState v-if="!listed.length" class="node-empty" icon="link" :title="'还没有' + (kinds.find(item => item.id === kind)?.title || '') + '节点'" description="点击“新建”添加当前类型的连接。" />
        <p class="node-footnote">{{ dirty ? '列表包含待保存的修改；运行状态仍来自已应用的节点。' : '节点地址、角色与连接状态按当前账号独立管理。' }}</p>
      </template>
    </div>
  </section>
  <dialog ref="editDialog" class="confirm-dialog dialog-wide" @cancel.prevent="closeEditor">
    <form v-if="editor" @submit.prevent="commit">
      <div class="dialog-head">
        <span class="dialog-head-icon" aria-hidden="true"><Icon :name="kinds.find(item => item.id === editor?.type)?.icon || 'link'" :size="20" /></span>
        <div>
          <span class="eyebrow">{{ editorIndex < 0 ? 'NEW CONNECTION' : 'EDIT CONNECTION' }}</span>
          <h2>{{ editorIndex < 0 ? '新建连接节点' : '编辑连接节点' }}</h2>
          <p>修改先保存在当前草稿，点击页面“保存并应用”后生效。</p>
        </div>
        <button type="button" class="icon-button dialog-close" aria-label="关闭编辑器" @click="closeEditor"><Icon name="close" :size="18" /></button>
      </div>
      <div class="dialog-body">
        <fieldset :disabled="busy">
          <SectionCard title="基础" hint="节点标识与连接类型">
            <div class="form-grid">
              <label>节点名称<input v-model="editor.label" maxlength="100" placeholder="例如：AstrBot" /></label>
              <label>节点 ID<input v-model="editor.id" :readonly="editorIndex >= 0" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" required /><small>用于独立接入路径，已有节点保持 ID 不变。</small></label>
              <label>连接类型<select v-model="editor.type"><option value="httpApi">HTTP API</option><option value="httpPost">HTTP 客户端</option><option value="wsServer">WS 服务端</option><option value="wsClient">WS 客户端</option></select></label>
            </div>
            <div class="switch-row">
              <div class="switch-row-text"><strong>启用节点</strong><small>停用后不建立连接，配置保留在本账号。</small></div>
              <button type="button" class="switch" :class="{ on: editor.enabled }" role="switch" :aria-checked="editor.enabled" aria-label="启用节点" @click="editor.enabled = !editor.enabled"><span></span></button>
            </div>
          </SectionCard>

          <SectionCard title="连接" :hint="editor.type.startsWith('ws') ? '地址、角色与心跳' : '上游地址'">
            <div class="form-grid">
              <label v-if="['httpPost', 'wsClient'].includes(editor.type)" class="full-row">连接地址<input v-model="editor.url" :placeholder="editor.type === 'httpPost' ? 'https://bot.example/events' : 'ws://astrbot:6199/ws'" required /></label>
              <label v-if="editor.type.startsWith('ws')">连接角色<select v-model="editor.role"><option value="Universal">Universal · 动作与事件</option><option value="Api">Api · 仅动作</option><option value="Event">Event · 仅事件</option></select></label>
              <label v-if="editor.type.startsWith('ws')">心跳间隔（毫秒）<input v-model.number="editor.heartbeatMs" type="number" min="100" max="300000" required /></label>
              <label>请求超时（毫秒）<input v-model.number="editor.timeoutMs" type="number" min="100" max="120000" /></label>
              <label v-if="editor.type.startsWith('ws')">Ping 超时（毫秒）<input v-model.number="editor.pingTimeoutMs" type="number" min="100" max="60000" /></label>
              <template v-if="editor.type === 'wsClient'">
                <label>最小重连间隔（毫秒）<input v-model.number="editor.reconnectMinMs" type="number" min="10" max="30000" placeholder="1000" /></label>
                <label>最大重连间隔（毫秒）<input v-model.number="editor.reconnectMaxMs" type="number" min="10" max="30000" placeholder="30000" /></label>
              </template>
            </div>
          </SectionCard>

          <SectionCard title="鉴权" hint="留空保留已存值">
            <label class="full-row">访问 token
              <span class="secret-field">
                <input :value="editor.token" :type="reveal.token ? 'text' : 'password'" autocomplete="new-password" :placeholder="editor.tokenPresent ? '已保存，留空保留' : '可选；公开监听节点启用前必填'" @input="secretInput('token', $event)" />
                <span class="secret-actions">
                  <button type="button" class="icon-button" :aria-label="reveal.token ? '隐藏 token' : '显示 token'" :title="reveal.token ? '隐藏 token' : '显示 token'" @click="reveal.token = !reveal.token"><Icon :name="reveal.token ? 'eyeOff' : 'eye'" :size="16" /></button>
                  <button type="button" class="icon-button" :disabled="!editor.token" aria-label="复制 token" title="复制 token" @click="copyValue(String(editor.token), 'token')"><Icon :name="copied === 'token' ? 'check' : 'copy'" :size="16" /></button>
                  <button type="button" class="icon-button" aria-label="生成随机 token" title="生成随机 token" @click="generateToken"><Icon name="refresh" :size="16" /></button>
                </span>
              </span>
              <span class="secret-actions">
                <button v-if="editor.tokenPresent" type="button" class="text-button danger-text" @click="editor.token = ''">明确清除已保存 token</button>
                <button v-if="editor.token === ''" type="button" class="text-button" @click="editor.token = undefined">取消清除</button>
              </span>
              <small v-if="editor.token === ''" class="inline-error">保存后清除 token，公开监听节点不能在无 token 时启用。</small>
            </label>
            <label v-if="editor.type === 'httpPost'" class="full-row">HMAC 签名密钥
              <span class="secret-field">
                <input :value="editor.secret" :type="reveal.secret ? 'text' : 'password'" autocomplete="new-password" :placeholder="editor.secretPresent ? '已保存，留空保留' : '可选：对原始 HTTP 正文签名'" @input="secretInput('secret', $event)" />
                <span class="secret-actions">
                  <button type="button" class="icon-button" :aria-label="reveal.secret ? '隐藏签名密钥' : '显示签名密钥'" :title="reveal.secret ? '隐藏签名密钥' : '显示签名密钥'" @click="reveal.secret = !reveal.secret"><Icon :name="reveal.secret ? 'eyeOff' : 'eye'" :size="16" /></button>
                  <button type="button" class="icon-button" :disabled="!editor.secret" aria-label="复制签名密钥" title="复制签名密钥" @click="copyValue(String(editor.secret), 'secret')"><Icon :name="copied === 'secret' ? 'check' : 'copy'" :size="16" /></button>
                </span>
              </span>
              <span class="secret-actions">
                <button v-if="editor.secretPresent" type="button" class="text-button danger-text" @click="editor.secret = ''">明确清除已保存签名密钥</button>
                <button v-if="editor.secret === ''" type="button" class="text-button" @click="editor.secret = undefined">取消清除</button>
              </span>
              <small v-if="editor.secret === ''" class="inline-error">保存后移除此节点的 HTTP 签名密钥。</small>
            </label>
            <div class="info-row"><span>凭证存储</span><strong>仅本账号私有配置，不回显明文</strong></div>
          </SectionCard>

          <SectionCard title="行为" hint="事件与限流策略">
            <div v-if="editor.type === 'httpPost'" class="switch-row">
              <div class="switch-row-text"><strong>允许响应中的标准快速操作</strong><small>只对已声明的标准操作生效，需要事件响应启用。</small></div>
              <button type="button" class="switch" :class="{ on: editor.quickOperations !== false }" role="switch" :aria-checked="editor.quickOperations !== false" aria-label="允许快速操作" @click="editor.quickOperations = editor.quickOperations === false"><span></span></button>
            </div>
            <div class="info-row"><span>消息格式</span><strong>标准 OneBot v11 数组段</strong></div>
            <div class="info-row"><span>自身回显</span><strong>不作为普通消息再次上报</strong></div>
          </SectionCard>

          <button type="button" class="text-button advanced-toggle" :aria-expanded="advanced" @click="advanced = !advanced"><Icon :name="advanced ? 'chevronUp' : 'chevronDown'" :size="14" />{{ advanced ? '收起' : '展开' }}高级连接参数</button>
          <SectionCard v-if="advanced" title="高级" hint="并发与事件缓冲">
            <div class="form-grid">
              <label>并发请求上限<input v-model.number="editor.maxPending" type="number" min="1" max="128" /></label>
              <label>每秒请求上限<input v-model.number="editor.ratePerSecond" type="number" min="1" max="1000" /></label>
              <label>突发容量<input v-model.number="editor.burst" type="number" min="1" max="2000" /></label>
              <label>事件缓冲条数<input v-model.number="editor.eventBufferSize" type="number" min="1" max="10000" /></label>
              <label>事件最大年龄（毫秒）<input v-model.number="editor.eventMaxAgeMs" type="number" min="1000" max="60000" /></label>
            </div>
            <p class="note">这些参数直接写入账号配置，保存并应用后生效。</p>
          </SectionCard>

          <p v-if="editorError" class="inline-error" role="alert">{{ editorError }}</p>
        </fieldset>
      </div>
      <div class="dialog-foot">
        <button type="button" class="secondary" @click="closeEditor">取消</button>
        <button class="primary">保存到草稿</button>
      </div>
    </form>
  </dialog>
  <dialog ref="removeDialog" class="confirm-dialog" @cancel.prevent="removing = null">
    <template v-if="removing">
      <span class="eyebrow">REMOVE CONNECTION</span>
      <h2>删除连接节点</h2>
      <p>将从当前配置草稿移除“{{ removing.label || removing.id }}”。保存并应用后此连接停止，其他节点保留。</p>
      <div class="button-row">
        <button type="button" class="secondary" @click="removeDialog?.close(); removing = null">取消</button>
        <button type="button" class="danger" @click="remove">移除当前节点</button>
      </div>
    </template>
  </dialog>
</template>

<style scoped>
.node-workspace{display:grid;grid-template-columns:236px minmax(0,1fr);gap:18px;align-items:start}.node-accounts{position:sticky;top:calc(var(--topbar-h) + 20px);padding:16px 10px;margin-bottom:0}.rail-heading{display:flex;justify-content:space-between;align-items:center;padding:0 10px 14px;color:var(--muted);font-size: 12px}.rail-heading small{font-size: 12px;color:var(--faint)}.node-account{width:100%;display:flex;align-items:center;gap:10px;text-align:left;border:1px solid transparent;border-radius:var(--radius-sm);padding:11px 10px;background:transparent;color:var(--text);margin-bottom:4px}.node-account.selected{border-color:var(--accent-line);background:var(--accent-soft)}.node-account:hover{background:var(--surface-3)}.node-account>span:nth-child(2){min-width:0;flex:1}.node-account strong,.node-account small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.node-account strong{font-weight:500;font-size: 12px}.node-account small{font-size: 12px;color:var(--faint);margin-top:4px}.node-account .account-avatar{width:32px;height:32px;border-radius:50%;font-size: 14px;flex-shrink:0}.account-dot{width:5px;height:5px;border-radius:50%;background:var(--neutral);flex-shrink:0}.account-dot.online{background:var(--success);box-shadow:0 0 0 3px var(--success-soft)}.node-main{min-width:0;min-height:420px}.node-title{display:flex;align-items:flex-start;justify-content:space-between;gap:15px}.node-title .eyebrow{font-size: 12px;margin-bottom:8px}.node-title h2{font-size:18px;margin-bottom:6px}.node-title p{font-size: 12px;color:var(--text);margin:0}.node-title p>span{font-size: 12px;color:var(--muted)}.node-title .button-row{flex-wrap:nowrap;gap:8px}.node-account-status{margin-left:10px}.node-tabs{display:flex;border-bottom:1px solid var(--line);margin-top:24px;gap:18px;overflow:auto;scrollbar-width:none}.node-tabs::-webkit-scrollbar{display:none}.node-tabs button{border:0;border-bottom:2px solid transparent;white-space:nowrap;padding:0 0 11px;color:var(--muted);background:transparent;font-size: 13px}.node-tabs button.active{border-color:var(--accent);color:var(--accent)}.node-tabs button>span{margin-left:6px;font-size: 12px;color:var(--faint)}.node-save-state{display:flex;align-items:center;gap:10px;margin:14px 0 18px;font-size: 12px;color:var(--muted);min-height:20px;flex-wrap:wrap}.draft-dot{color:var(--warning)}.node-description{margin:0 0 16px;font-size: 12px;color:var(--muted)}.node-list{display:flex;flex-direction:column;gap:10px}.connection-card{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 18px;background:var(--surface-2);border:1px solid var(--line-soft);border-radius:var(--radius-sm);transition:border-color var(--dur) var(--ease)}.connection-card:hover{border-color:var(--line-strong)}.connection-info{min-width:0}.connection-name{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.connection-name h3{font-size: 15px;font-weight: 500}.node-status{font-size: 12px;padding:3px 8px;border-radius:var(--radius-pill);background:var(--neutral-soft);color:var(--neutral);white-space:nowrap}.node-status.connected{background:var(--success-soft);color:var(--success)}.node-status.waiting{background:var(--warning-soft);color:var(--warning)}.node-status.error{background:var(--danger-soft);color:var(--danger)}.node-status.disabled{background:var(--neutral-soft);color:var(--faint)}.connection-url{display:flex;align-items:center;gap:8px;margin:6px 0 0;font-size: 12px;color:var(--muted);overflow-wrap:anywhere}.connection-url code{font-family:var(--font-mono);font-size: 12px;color:var(--accent)}.copy-inline{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;font-size: 12px;color:var(--faint);border:1px solid var(--line-soft);border-radius:5px;background:transparent}.copy-inline:hover{color:var(--accent);border-color:var(--accent-line)}.connection-meta{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;font-size: 12px;color:var(--faint)}.connection-meta span{display:inline-flex;align-items:center;gap:5px}.connection-meta span::before{content:"";width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.6}.connection-error{margin:8px 0 0;font-size: 12px;color:var(--danger)}.connection-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}.node-empty{margin-top:8px}.node-footnote{margin:14px 0 0;font-size: 12px;color:var(--faint)}.node-general{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:0 18px}.node-hint{display:flex;gap:10px;margin-top:18px;padding:12px 14px;background:var(--surface-2);border:1px solid var(--line-soft);border-radius:var(--radius-sm)}.node-hint>span{color:var(--second)}.node-hint p{margin:0;font-size: 12px;line-height:1.8}.advanced-toggle{margin:4px 0 10px}.full-row{grid-column:1/-1}
@media(max-width:1500px){.node-workspace{grid-template-columns:210px minmax(0,1fr);gap:14px}}
@media(max-width:1100px){.node-workspace{grid-template-columns:minmax(0,1fr)}.node-accounts{position:static;display:flex;align-items:center;gap:8px;overflow:auto;padding:10px;scrollbar-width:none}.node-accounts::-webkit-scrollbar{display:none}.rail-heading{display:none}.node-account{width:205px;min-width:190px;margin:0}.node-account .note{display:none}.node-main{min-height:380px}.node-title{display:block}.node-title .button-row{margin-top:16px}.connection-card{padding:14px}}
@media(max-width:760px){.node-workspace{gap:12px}.node-title h2{font-size:17px}.node-tabs{gap:16px;margin-top:20px;-webkit-mask-image:linear-gradient(90deg,black 94%,transparent);mask-image:linear-gradient(90deg,black 94%,transparent)}.node-tabs button{font-size: 12px}.connection-card{display:block;padding:13px}.connection-name h3{font-size: 14px}.connection-meta{gap:8px;font-size: 12px}.connection-actions{margin-top:10px;justify-content:flex-end;max-width:none;width:100%;flex-wrap:nowrap;gap:6px}.connection-url{flex-wrap:wrap;font-size: 12px}.connection-url code{font-size: 12px}.node-description{font-size: 12px}.node-save-state{font-size: 12px}.node-account-status{display:block;margin:5px 0 0}.node-title p>span:not(.node-account-status){display:inline}}
</style>
