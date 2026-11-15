<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type RFB from '@novnc/novnc';
import { api } from '../api';
import Icon from './Icon.vue';
import type { RemoteMetadata, RemoteSession } from '../types';

const props = defineProps<{ profileId: string; expectedUin?: string; label: string; enabled: boolean; ready: boolean }>();
type Phase = 'closed' | 'opening' | 'connecting' | 'connected' | 'failed' | 'expired';
const phase = ref<Phase>('closed');
const viewport = ref<HTMLElement | null>(null);
const expanded = ref(false);
const pending = ref(false);
const remoteError = ref('');
const message = ref('按需打开当前账号的 QQ 登录画面，可直接操作窗口完成扫码或切换登录方式。');
const expiresAt = ref<number | null>(null);
const clock = ref(Date.now());
const serverActive = ref(false);
const countdown = computed(() => {
  const seconds = Math.max(0, Math.ceil(((expiresAt.value || clock.value) - clock.value) / 1000));
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
});
const status = computed(() => props.ready ? '登录已完成' : ({ closed: '尚未打开', opening: '正在准备', connecting: '正在连接', connected: '已连接', failed: '连接受阻', expired: '会话已到期' })[phase.value]);
let client: RFB | undefined;
let generation = 0;
let disposed = false;
let unloading = false;
let backendMayExist = false;
let cleanup: Promise<void> | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
let detachEvents: (() => void) | undefined;

function current(value: number) { return !disposed && !unloading && value === generation; }
function disconnect() {
  if (tick) clearInterval(tick); tick = undefined;
  detachEvents?.(); detachEvents = undefined;
  const old = client; client = undefined;
  const canvases = [...(viewport.value?.querySelectorAll('canvas') || [])];
  try { old?.disconnect(); } catch { /* A partial handshake can already be closed. */ }
  for (const canvas of canvases) { canvas.width = 0; canvas.height = 0; }
  viewport.value?.replaceChildren();
  expiresAt.value = null;
}
async function closeBackend() {
  if (unloading) return;
  if (cleanup) return cleanup;
  if (!backendMayExist) return;
  backendMayExist = false;
  cleanup = api('/accounts/' + encodeURIComponent(props.profileId) + '/remote', 'DELETE').then(() => { serverActive.value = false; }).finally(() => { cleanup = undefined; });
  return cleanup;
}
async function closeRemote(next: Phase = 'closed', silent = false) {
  generation++; disconnect(); expanded.value = next === 'failed'; phase.value = next;
  if (next === 'expired') message.value = '本次远程登录已到期，连接已关闭。需要时请手动重新打开。';
  else if (next === 'closed') message.value = props.ready ? 'QQ 接入已就绪，远程登录已自动关闭。' : '远程登录已关闭，需要时可再次手动打开。';
  try { await closeBackend(); }
  catch { if (!silent && !disposed) remoteError.value = '远程连接已断开，服务器会话暂未确认关闭，将按到期时间回收。'; }
}
function socketUrl(value: RemoteSession) {
  if (value.profileId !== props.profileId || !value.sessionId || !value.password || typeof value.path !== 'string') throw new Error('远程登录响应与当前账号不匹配');
  const url = new URL(value.path, location.origin);
  if (url.origin !== location.origin || url.username || url.password || url.hash ||
      url.pathname !== '/api/accounts/' + encodeURIComponent(props.profileId) + '/remote/socket' || url.searchParams.get('session') !== value.sessionId) throw new Error('远程登录地址不属于当前账号');
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
async function openRemote() {
  if (pending.value || client || !props.enabled || props.ready || disposed || unloading) return;
  pending.value = true; remoteError.value = ''; expanded.value = true; phase.value = 'opening';
  const request = ++generation;
  try {
    if (cleanup) await cleanup;
    backendMayExist = true;
    const session = await api<RemoteSession>('/accounts/' + encodeURIComponent(props.profileId) + '/remote/open', 'POST');
    if (!current(request)) { session.password = ''; backendMayExist = true; await closeBackend(); return; }
    const url = socketUrl(session);
    const deadline = typeof session.expiresAt === 'number' ? session.expiresAt : Date.parse(session.expiresAt);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('远程登录会话已经到期，请重新打开');
    expiresAt.value = Math.min(deadline, Date.now() + 5 * 60 * 1000); clock.value = Date.now(); serverActive.value = true;
    await nextTick();
    const { default: RemoteFramebuffer } = await import('@novnc/novnc');
    if (!current(request) || !viewport.value) { session.password = ''; await closeBackend(); return; }
    const rfb = new RemoteFramebuffer(viewport.value, url, { credentials: { password: session.password }, shared: false });
    session.password = ''; client = rfb;
    rfb.scaleViewport = true; rfb.resizeSession = false; rfb.clipViewport = false; rfb.viewOnly = false; rfb.focusOnClick = true; rfb.background = 'var(--bg-deep)';
    // noVNC 1.7 exposes paste as this explicit method and received text as an
    // event. Neither direction is bridged to the browser's system clipboard.
    rfb.clipboardPasteFrom = () => {};
    const clipboard = (event: Event) => { event.stopImmediatePropagation(); event.preventDefault(); };
    const connected = () => { if (current(request) && client === rfb) { phase.value = 'connected'; message.value = '已连接当前实例。可用鼠标操作 QQ 窗口；完成登录后会自动关闭。'; } };
    const failed = () => {
      if (!current(request) || client !== rfb) return;
      remoteError.value = '连接已断开或验证失败。请核对账号运行状态，手动重新打开；不会自动反复重连。';
      void closeRemote('failed', true);
    };
    rfb.addEventListener('clipboard', clipboard);
    rfb.addEventListener('connect', connected); rfb.addEventListener('disconnect', failed); rfb.addEventListener('securityfailure', failed); rfb.addEventListener('credentialsrequired', failed);
    detachEvents = () => { rfb.removeEventListener('clipboard', clipboard); rfb.removeEventListener('connect', connected); rfb.removeEventListener('disconnect', failed); rfb.removeEventListener('securityfailure', failed); rfb.removeEventListener('credentialsrequired', failed); };
    phase.value = 'connecting';
    tick = setInterval(() => {
      clock.value = Date.now();
      if (expiresAt.value !== null && clock.value >= expiresAt.value) void closeRemote('expired', true);
    }, 1000);
  } catch (value) {
    if (current(request)) {
      remoteError.value = value instanceof Error ? value.message : '暂时无法打开远程登录';
      await closeRemote('failed', true);
    }
  } finally { pending.value = false; }
}
function beforeUnload() {
  unloading = true; generation++; disconnect(); expanded.value = false; phase.value = 'closed';
  // If another page guard cancels navigation, the user can open a new session.
  setTimeout(() => { unloading = false; }, 0);
}
watch(() => props.ready, value => { if (value) void closeRemote('closed', true); });
watch(() => props.enabled, value => { if (!value && (client || pending.value)) void closeRemote('closed', true); });
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  const request = generation;
  try {
    const value = await api<RemoteMetadata>('/accounts/' + encodeURIComponent(props.profileId) + '/remote');
    if (current(request) && value.active) {
      backendMayExist = true; serverActive.value = true;
      if (props.ready) await closeRemote('closed', true);
      else message.value = '服务器尚有未到期的登录会话。可手动关闭，或重新打开当前连接。';
    }
  } catch { /* Remote login remains manual when metadata is unavailable. */ }
});
onBeforeUnmount(() => { disposed = true; generation++; disconnect(); window.removeEventListener('beforeunload', beforeUnload); if (!unloading) void closeBackend().catch(() => {}); });
defineExpose({ close: () => closeRemote('closed', true) });
</script>

<template>
  <section class="panel remote-login" aria-label="当前账号远程登录">
    <div class="remote-heading"><div class="remote-heading-main"><span class="remote-symbol" aria-hidden="true"><Icon name="monitor" :size="22" /></span><div><span class="eyebrow">REMOTE QQ LOGIN</span><h2>远程登录</h2><p>QQ {{ expectedUin || '身份待确认' }} <span>·</span> 实例 {{ profileId }}</p></div></div><span class="badge" :class="phase === 'connected' ? 'running' : phase === 'failed' ? 'blocked' : phase === 'opening' || phase === 'connecting' ? 'starting' : 'stopped'">{{ status }}</span></div>
    <p class="remote-description">{{ message }}</p>
    <div class="button-row"><button class="primary" :disabled="pending || !enabled || ready || phase === 'connected' || phase === 'connecting'" @click="openRemote">{{ pending ? '正在打开…' : phase === 'connected' || phase === 'connecting' ? '远程登录已打开' : phase === 'failed' || phase === 'expired' ? '重新打开远程登录' : '打开远程登录' }}</button><button v-if="expanded || serverActive" class="secondary" @click="closeRemote()">关闭远程登录</button><span v-if="expiresAt" class="remote-timer"><span class="dot" :class="{ online: phase === 'connected' }"></span>{{ countdown }} 后关闭</span></div>
    <p v-if="remoteError" class="inline-error remote-error" role="alert">{{ remoteError }}</p>
    <div v-if="expanded" class="remote-shell"><div class="remote-toolbar"><span><span class="dot" :class="{ online: phase === 'connected' }"></span>{{ label }} · QQ 登录画面</span><small>鼠标与键盘可操作</small></div><div class="remote-viewport" :class="{ 'has-screen': phase === 'connected' }"><div ref="viewport" class="remote-framebuffer"></div><div v-if="phase === 'opening' || phase === 'connecting'" class="remote-placeholder"><span class="spinner"></span><p>{{ phase === 'opening' ? '正在准备当前账号的登录窗口' : '正在连接登录画面' }}</p></div><div v-else-if="phase === 'failed'" class="remote-placeholder"><Icon name="alert" :size="40" :stroke="1.4" /><p>连接未建立，请手动重新打开</p></div></div></div>
    <p class="remote-footnote">默认关闭，每次最多 5 分钟。切换页面、账号、退出管理台或接入就绪后关闭；剪贴板同步与文件传输不开放。登录完成后立即释放浏览器画面与临时远程会话。</p>
  </section>
</template>

<style scoped>
.remote-login{overflow:hidden}.remote-heading,.remote-heading-main{display:flex;align-items:center;gap:14px}.remote-heading{justify-content:space-between;gap:18px}.remote-heading-main{min-width:0}.remote-symbol{width:47px;height:47px;display:flex;align-items:center;justify-content:center;border:1px solid var(--accent-line);background:var(--accent-soft);border-radius:var(--radius-md);font-size:24px;color:var(--accent);flex-shrink:0}.remote-heading .eyebrow{font-size: 12px;margin-bottom:6px}.remote-heading h2{margin-bottom:4px}.remote-heading p{font-size: 12px;margin:0;overflow-wrap:anywhere}.remote-heading p span{margin:0 7px;color:var(--faint)}.remote-description{margin:18px 0 16px;font-size: 13px}.remote-timer{font-size: 12px;color:var(--muted);display:flex;align-items:center;gap:8px;margin-left:7px;font-variant-numeric:tabular-nums}.remote-error{font-size: 13px;margin:14px 0 0;line-height:1.8}.remote-shell{margin-top:20px;border:1px solid var(--line-soft);border-radius:var(--radius-md);overflow:hidden;background:var(--bg-deep)}.remote-toolbar{display:flex;justify-content:space-between;align-items:center;gap:15px;padding:12px 15px;background:var(--surface-2);border-bottom:1px solid var(--line-soft);font-size: 12px;color:var(--text)}.remote-toolbar>span{display:flex;align-items:center;gap:8px}.remote-toolbar small{font-size: 12px;color:var(--faint)}.remote-viewport{height:clamp(320px,50vh,520px);position:relative;overflow:auto;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 40%,var(--surface-2),var(--bg-deep) 72%)}.remote-viewport.has-screen{background:var(--bg-deep)}.remote-framebuffer{width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:auto}.remote-placeholder{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;pointer-events:none}.remote-placeholder>.icon{color:var(--second)}.remote-placeholder p{font-size: 13px;color:var(--muted)}.remote-footnote{font-size: 12px;color:var(--faint);margin:16px 0 0;line-height:1.9}
@media(max-width:760px){.remote-heading{display:block}.remote-heading-main{margin-bottom:14px}.remote-symbol{width:40px;height:40px;font-size:20px}.remote-viewport{height:clamp(280px,46vh,420px)}.remote-description{font-size: 12px}.remote-toolbar{font-size: 12px}}
</style>
