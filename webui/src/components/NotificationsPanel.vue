<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon.vue';
import ConfirmDialog from './ConfirmDialog.vue';

interface Channel {
  id: string; name: string; type: 'email' | 'webhook'; enabled: boolean;
  subjectTemplate: string; bodyTemplate: string;
  host?: string; port?: number; secure?: boolean; user?: string; password?: string;
  from?: string; to?: string[]; url?: string; token?: string;
  passwordPresent?: boolean; tokenPresent?: boolean; urlPresent?: boolean; endpoint?: string;
  clearPassword?: boolean; clearToken?: boolean;
}
interface Delivery {
  at?: string | number; channelId?: string; profileId?: string; event?: string;
  status?: string; success?: boolean; code?: string;
}
interface Configuration { offlineDelaySeconds: number; channels: Channel[]; deliveries?: Delivery[] }
type Editor = Channel & { recipients: string };

const toast = useToast();
const channels = ref<Channel[]>([]);
const deliveries = ref<Delivery[]>([]);
const delay = ref(30);
const savedDelay = ref(30);
const loading = ref(true);
const loaded = ref(false);
const busy = ref(false);
const error = ref('');
const editor = ref<Editor | null>(null);
const editorError = ref('');
const editDialog = ref<HTMLDialogElement | null>(null);
const originalId = ref('');
const reveal = ref(false);
const confirming = ref<{ kind: 'test' | 'remove'; channel: Channel } | null>(null);
let active = true;
const delayDirty = computed(() => delay.value !== savedDelay.value);
const DEFAULT_SUBJECT = '账号{event}：{nickname} ({uin})';
const DEFAULT_BODY = '账号状态发生了改变。\n\n昵称：{nickname}\nQQ 号：{uin}\n当前状态：{event}\n适配器状态：{status}\n进程 ID：{pid}\n时间：{time}\n错误：{error}\n实例：{profileId}';

function apply(value: Configuration) {
  channels.value = value.channels;
  savedDelay.value = value.offlineDelaySeconds;
  delay.value = value.offlineDelaySeconds;
  deliveries.value = Array.isArray(value.deliveries) ? value.deliveries.slice(-10).reverse() : [];
  loaded.value = true;
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : '操作失败，请稍后重试'; }
async function load() {
  if (busy.value) return;
  const draftDelay = delay.value, keepDraft = loaded.value && delayDirty.value;
  loading.value = true; error.value = '';
  try {
    const value = await api<Configuration>('/notifications');
    if (active) { apply(value); if (keepDraft) delay.value = draftDelay; }
  }
  catch (cause) { if (active) error.value = message(cause); }
  finally { if (active) loading.value = false; }
}
function writable(value: Channel): Channel {
  const result: Channel = { id: value.id, name: value.name, type: value.type, enabled: value.enabled,
    subjectTemplate: value.subjectTemplate, bodyTemplate: value.bodyTemplate };
  if (value.type === 'email') {
    Object.assign(result, { host: value.host, port: value.port, secure: value.secure, user: value.user,
      from: value.from, to: value.to });
    if (value.clearPassword) result.clearPassword = true;
    else if (value.password) result.password = value.password;
  } else {
    if (value.url?.trim()) result.url = value.url.trim();
    if (value.clearToken) result.clearToken = true;
    else if (value.token) result.token = value.token;
  }
  return result;
}
async function save(next: Channel[], seconds = savedDelay.value, success = '通知配置已保存') {
  if (busy.value || loading.value || !loaded.value) return false;
  busy.value = true; error.value = '';
  const draftDelay = delay.value;
  const preserveDelayDraft = seconds === savedDelay.value && delayDirty.value;
  try {
    const value = await api<Configuration>('/notifications', 'PUT', { offlineDelaySeconds: seconds, channels: next.map(writable) });
    if (!active) return true;
    apply(value);
    if (preserveDelayDraft) delay.value = draftDelay;
    toast.push(success);
    return true;
  } catch (cause) { if (active) error.value = message(cause); return false; }
  finally { if (active) busy.value = false; }
}
async function saveDelay() {
  if (!Number.isInteger(delay.value) || delay.value < 0 || delay.value > 86400) { error.value = '去抖窗口需为 0–86400 秒之间的整数'; return; }
  await save(channels.value, delay.value, '通知去抖窗口已保存');
}
function address(channel: Channel) {
  return channel.type === 'email' ? `${(channel.to || []).join('、')} · ${channel.host || 'SMTP'}` : channel.endpoint || 'Webhook 地址已保存';
}
async function edit(channel?: Channel) {
  if (busy.value || loading.value) return;
  editorError.value = ''; reveal.value = false; originalId.value = channel?.id || '';
  editor.value = channel ? { ...JSON.parse(JSON.stringify(channel)), password: '', token: '', url: '', recipients: (channel.to || []).join(', ') } : {
    id: 'channel-' + Date.now().toString(36), name: '', type: 'email', enabled: true,
    subjectTemplate: DEFAULT_SUBJECT, bodyTemplate: DEFAULT_BODY, host: '', port: 465,
    secure: true, user: '', password: '', from: '', to: [], recipients: '', url: '', token: '',
  };
  await nextTick(); editDialog.value?.showModal();
}
function closeEditor() {
  if (busy.value) return;
  editDialog.value?.close(); editor.value = null; editorError.value = ''; reveal.value = false;
}
function changeType(type: Channel['type']) {
  if (!editor.value || originalId.value || busy.value) return;
  editor.value.type = type;
  editorError.value = ''; reveal.value = false;
}
async function commit() {
  const value = editor.value;
  if (!value || busy.value) return;
  editorError.value = '';
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value.id)) throw new Error('渠道 ID 请使用 1–64 位字母、数字、点号、短横线或下划线，首位为字母或数字');
    if (!originalId.value && channels.value.some(channel => channel.id === value.id)) throw new Error('渠道 ID 已存在');
    if (!value.name.trim()) throw new Error('请填写渠道显示名');
    if (!value.subjectTemplate.trim() || /[\r\n]/.test(value.subjectTemplate)) throw new Error('主题模板不能为空或包含换行');
    if (!value.bodyTemplate.trim()) throw new Error('请填写正文模板');
    const candidate = { ...value, name: value.name.trim() };
    if (value.type === 'email') {
      if (!value.host?.trim()) throw new Error('请填写 SMTP 主机');
      if (!Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) throw new Error('SMTP 端口需为 1–65535 之间的整数');
      if (!value.from?.trim()) throw new Error('请填写发件人');
      candidate.to = value.recipients.split(/[,，;；\n]/).map(item => item.trim()).filter(Boolean);
      if (!candidate.to.length) throw new Error('请填写至少一个收件人');
      candidate.host = value.host.trim(); candidate.from = value.from.trim();
    } else if (value.url?.trim()) {
      const target = new URL(value.url.trim());
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) throw new Error('Webhook 需为不含用户名、密码或片段的 HTTP(S) 地址');
    } else if (!value.urlPresent) throw new Error('请填写 Webhook URL');
    const next = originalId.value ? channels.value.map(channel => channel.id === originalId.value ? candidate : channel) : [...channels.value, candidate];
    if (await save(next, savedDelay.value, originalId.value ? '通知渠道已更新' : '通知渠道已创建')) closeEditor();
  } catch (cause) { editorError.value = message(cause); }
}
async function toggle(channel: Channel) {
  await save(channels.value.map(item => item.id === channel.id ? { ...item, enabled: !item.enabled } : item), savedDelay.value,
    channel.enabled ? '通知渠道已停用' : '通知渠道已启用');
}
async function confirm() {
  const action = confirming.value;
  if (!action || busy.value || loading.value) return;
  confirming.value = null;
  if (action.kind === 'remove') { await save(channels.value.filter(item => item.id !== action.channel.id), savedDelay.value, '通知渠道已删除'); return; }
  busy.value = true; error.value = '';
  let testError = '';
  try {
    await api('/notifications/channels/' + encodeURIComponent(action.channel.id) + '/test', 'POST', {});
    if (active) toast.push('测试通知已发送，请检查接收端');
  } catch (cause) { testError = message(cause); }
  finally {
    if (active) {
      busy.value = false;
      await load();
      if (testError && active) error.value = testError;
    }
  }
}
function deliveryTime(at?: number | string) { return at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '时间未知'; }
function deliveryStatus(item: Delivery) {
  if (item.success === true) return '已投递';
  if (item.success === false) return ({ SMTP_REJECTED: 'SMTP 拒绝', WEBHOOK_REJECTED: 'Webhook 拒绝',
    NOTIFICATION_TIMEOUT: '投递超时', QUEUE_FULL: '队列已满', CONFIG_CHANGED: '配置已变更', CLOSING: '服务停止' } as Record<string, string>)[item.code || ''] || '投递失败';
  return '结果未知';
}

onMounted(() => { void load(); });
onBeforeUnmount(() => { active = false; editor.value = null; editDialog.value?.close(); });
</script>

<template>
  <div class="notification-settings" :aria-busy="busy || loading">
    <section class="panel notification-intro">
      <div class="notification-heading">
        <div><span class="eyebrow">NOTIFICATIONS</span><h2>通知</h2><p>及时了解 QQ 的掉线与恢复，让每个账号都有自己的通知去向。</p></div>
        <span class="notification-symbol" aria-hidden="true"><Icon name="bell" :size="24" /></span>
      </div>
      <div class="notification-tip"><Icon name="info" :size="16" /><p>先在此管理通知渠道，再到账号的「连接节点 → 通用设置」选择启用。正常停止、维护不触发掉线通知。</p></div>
      <form class="delay-form" @submit.prevent="saveDelay">
        <label>去抖窗口（秒）<input v-model.number="delay" type="number" min="0" max="86400" step="1" :disabled="busy || !loaded" required /><small>下线持续超过此时长才通知，恢复时再通知。0 表示立即通知。</small></label>
        <button type="submit" class="secondary" :disabled="busy || !loaded || !delayDirty"><Icon name="check" :size="15" />保存去抖窗口</button>
      </form>
    </section>

    <p v-if="error" class="notification-error" role="alert"><Icon name="alert" :size="16" />{{ error }}</p>

    <section class="notification-channels" aria-label="通知渠道">
      <div class="notification-section-heading"><div><h3>通知渠道 <span class="notification-count">{{ channels.length }} / 32</span></h3><p>一个渠道可供多个账号使用，停用时保留配置。</p></div><div class="button-row"><button class="icon-button" type="button" aria-label="刷新通知配置" title="刷新通知配置" :disabled="busy || loading || delayDirty" @click="load"><Icon name="refresh" :size="16" /></button><button type="button" class="secondary" :disabled="busy || !loaded || channels.length >= 32" @click="edit()"><Icon name="plus" :size="15" />新增渠道</button></div></div>
      <div v-if="loading && !loaded" class="notification-empty" role="status">正在读取通知配置…</div>
      <div v-else-if="!loaded" class="notification-empty"><span class="empty-bell"><Icon name="alert" :size="28" /></span><strong>暂时无法读取通知配置</strong><p>请检查上方错误后重试，已有配置不会被覆盖。</p><button type="button" class="secondary" :disabled="busy || loading" @click="load"><Icon name="refresh" :size="15" />重新读取</button></div>
      <div v-else-if="!channels.length" class="notification-empty"><span class="empty-bell"><Icon name="bell" :size="28" /></span><strong>还没有通知渠道</strong><p>添加邮件或 Webhook，接收已选账号的状态通知。</p><button type="button" class="text-button" :disabled="!loaded || busy" @click="edit()">创建第一个渠道 <Icon name="arrowRight" :size="15" /></button></div>
      <div v-else class="notification-channel-list">
        <article v-for="channel in channels" :key="channel.id" class="notification-channel" :class="{ inactive: !channel.enabled }">
          <span class="channel-symbol" aria-hidden="true"><Icon :name="channel.type === 'email' ? 'mail' : 'link'" :size="21" /></span>
          <div class="channel-info"><div class="channel-title"><h4>{{ channel.name }}</h4><code>{{ channel.id }}</code><span class="channel-kind">{{ channel.type === 'email' ? '邮件' : 'Webhook' }}</span></div><p class="channel-address">{{ address(channel) }}</p><p class="channel-template">{{ channel.subjectTemplate }}</p></div>
          <div class="channel-actions"><button type="button" class="switch" :class="{ on: channel.enabled }" role="switch" :aria-checked="channel.enabled" :aria-label="(channel.enabled ? '停用' : '启用') + channel.name" :disabled="busy" @click="toggle(channel)"><span></span></button><button type="button" class="icon-button" :disabled="busy || !channel.enabled" :aria-label="'测试通知渠道 ' + channel.name" title="发送测试通知" @click="confirming = { kind: 'test', channel }"><Icon name="send" :size="17" /></button><button type="button" class="icon-button" :disabled="busy" :aria-label="'编辑通知渠道 ' + channel.name" title="编辑渠道" @click="edit(channel)"><Icon name="edit" :size="17" /></button><button type="button" class="icon-button danger-text" :disabled="busy" :aria-label="'删除通知渠道 ' + channel.name" title="删除渠道" @click="confirming = { kind: 'remove', channel }"><Icon name="trash" :size="17" /></button></div>
        </article>
      </div>
    </section>

    <section v-if="deliveries.length" class="panel notification-deliveries"><div class="notification-section-heading"><h3>最近投递</h3><span>仅显示结果，不保存通知正文</span></div><div v-for="(item, index) in deliveries" :key="index" class="delivery-row"><span class="delivery-dot" :class="{ failed: item.success === false, unknown: item.success === undefined }"></span><div><strong>{{ item.channelId || '通知渠道' }}<span v-if="item.profileId"> · {{ item.profileId }}</span></strong><small>{{ deliveryTime(item.at) }}<template v-if="item.event"> · {{ item.event === 'offline' ? '下线' : item.event === 'online' ? '恢复' : '测试' }}</template></small></div><span class="delivery-status">{{ deliveryStatus(item) }}</span></div></section>

    <dialog ref="editDialog" class="confirm-dialog dialog-wide notification-dialog" @cancel.prevent="closeEditor">
      <form v-if="editor" @submit.prevent="commit">
        <div class="dialog-head"><span class="dialog-head-icon" aria-hidden="true"><Icon name="bell" :size="20" /></span><div><span class="eyebrow">{{ originalId ? 'EDIT CHANNEL' : 'NEW CHANNEL' }}</span><h2>{{ originalId ? '编辑通知渠道' : '新建通知渠道' }}</h2><p>保存后生效；测试通知需要单独确认发送。</p></div><button type="button" class="icon-button dialog-close" aria-label="关闭通知渠道编辑器" :disabled="busy" @click="closeEditor"><Icon name="close" :size="18" /></button></div>
        <div class="dialog-body"><fieldset :disabled="busy">
          <div class="notification-type-tabs" role="group" aria-label="通知渠道类型"><button v-for="kind in (['webhook', 'email'] as const)" :key="kind" type="button" :class="{ active: editor.type === kind }" :aria-pressed="editor.type === kind" :disabled="!!originalId && editor.type !== kind" @click="changeType(kind)"><Icon :name="kind === 'email' ? 'mail' : 'link'" :size="16" />{{ kind === 'email' ? '邮件' : 'Webhook' }}</button></div>
          <div class="form-grid"><label>渠道 ID<input v-model="editor.id" :readonly="!!originalId" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}" required /><small>账号通过 ID 选择渠道，保存后不可修改。</small></label><label>显示名<input v-model="editor.name" maxlength="100" placeholder="例如：账号状态通知" required /></label></div>
          <template v-if="editor.type === 'email'">
            <div class="form-grid smtp-address"><label>SMTP 主机<input v-model="editor.host" maxlength="253" placeholder="smtp.qq.com" spellcheck="false" required /></label><label>端口<input v-model.number="editor.port" type="number" min="1" max="65535" required /></label></div>
            <div class="form-grid"><label>SMTP 用户名<input v-model="editor.user" maxlength="320" placeholder="bot@qq.com" autocomplete="off" /><small>不需要认证的服务器可以留空。</small></label><div><label>SMTP 密码<span class="secret-field"><input v-model="editor.password" :type="reveal ? 'text' : 'password'" :disabled="editor.clearPassword" autocomplete="new-password" :placeholder="editor.passwordPresent ? '已保存，留空保留' : '授权码 / 密码'" /><span class="secret-actions"><button type="button" class="icon-button" :aria-label="reveal ? '隐藏 SMTP 密码' : '显示 SMTP 密码'" @click="reveal = !reveal"><Icon :name="reveal ? 'eyeOff' : 'eye'" :size="16" /></button></span></span></label><label v-if="editor.passwordPresent" class="check"><input v-model="editor.clearPassword" type="checkbox" />清除已保存密码</label></div></div>
            <div class="switch-row"><div class="switch-row-text"><strong>隐式 TLS</strong><small>465 通常开启，587 通常关闭并使用 STARTTLS。</small></div><button type="button" class="switch" :class="{ on: editor.secure }" role="switch" :aria-checked="editor.secure === true" aria-label="隐式 TLS" @click="editor.secure = !editor.secure"><span></span></button></div>
            <div class="form-grid"><label>发件人<input v-model="editor.from" maxlength="320" placeholder="Freshwater <bot@qq.com>" required /></label><label>收件人<input v-model="editor.recipients" maxlength="4096" placeholder="ops@example.com, a@b.com" required /><small>多个地址以逗号或分号分隔。</small></label></div>
          </template>
          <template v-else>
            <label>Webhook URL<input v-model="editor.url" type="url" maxlength="4096" spellcheck="false" autocomplete="off" :placeholder="editor.urlPresent ? '地址已保存，留空保留；输入新地址替换' : 'https://your-service.example/notify'" :required="!editor.urlPresent" /><small>向此地址 POST JSON；不会跟随重定向。已保存 URL 不回显。</small></label>
            <label>Bearer token（可选）<span class="secret-field"><input v-model="editor.token" :type="reveal ? 'text' : 'password'" :disabled="editor.clearToken" autocomplete="new-password" :placeholder="editor.tokenPresent ? '已保存，留空保留' : '接收端要求时填写'" /><span class="secret-actions"><button type="button" class="icon-button" :aria-label="reveal ? '隐藏 Webhook token' : '显示 Webhook token'" @click="reveal = !reveal"><Icon :name="reveal ? 'eyeOff' : 'eye'" :size="16" /></button></span></span></label><label v-if="editor.tokenPresent" class="check"><input v-model="editor.clearToken" type="checkbox" />清除已保存 token</label>
          </template>
          <div class="notification-template-section"><label>主题模板<input v-model="editor.subjectTemplate" maxlength="256" required /></label><label>正文模板<textarea v-model="editor.bodyTemplate" rows="7" maxlength="16000" required /></label><p class="template-help">可用变量：<code>{uin}</code> QQ 号、<code>{nickname}</code> 昵称、<code>{event}</code> offline / online、<code>{time}</code> 时间、<code>{status}</code> 适配器状态、<code>{pid}</code> 适配器进程 ID、<code>{error}</code> 错误、<code>{profileId}</code> 实例。未知信息为空；邮件正文以 &lt; 开头时按 HTML 发送。</p></div>
          <div class="switch-row"><div class="switch-row-text"><strong>启用</strong><small>关闭后停止推送，保留配置。</small></div><button type="button" class="switch" :class="{ on: editor.enabled }" role="switch" :aria-checked="editor.enabled" aria-label="启用通知渠道" @click="editor.enabled = !editor.enabled"><span></span></button></div>
          <p v-if="editorError" class="inline-error" role="alert">{{ editorError }}</p><p v-if="error" class="inline-error" role="alert">{{ error }}</p>
        </fieldset></div><div class="dialog-foot"><button type="button" class="secondary" :disabled="busy" @click="closeEditor">取消</button><button type="submit" class="primary" :disabled="busy">{{ busy ? '正在保存…' : originalId ? '保存渠道' : '创建渠道' }}</button></div>
      </form>
    </dialog>
    <ConfirmDialog :open="!!confirming" :title="confirming?.kind === 'test' ? '发送测试通知' : '删除通知渠道'" :message="confirming?.kind === 'test' ? '将向渠道「' + (confirming?.channel.name || '') + '」已配置的地址发送一条测试通知，确认后仅发送一次。' : '删除渠道「' + (confirming?.channel.name || '') + '」后，使用它的账号将不再向此渠道发送通知。账号本身保持不变。'" :confirm-label="confirming?.kind === 'test' ? '发送一条测试通知' : '删除渠道'" :danger="confirming?.kind === 'remove'" @confirm="confirm" @cancel="confirming = null" />
  </div>
</template>

<style scoped>
.delivery-dot.unknown{background:var(--neutral)}
.notification-settings{min-width:0}.notification-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.notification-heading h2{font-size:20px;margin:0 0 8px}.notification-heading p{font-size:12px;margin:0;color:var(--muted);line-height:1.8}.notification-symbol{display:grid;place-items:center;flex-shrink:0;width:48px;height:48px;border:1px solid var(--accent-line);border-radius:14px;background:var(--accent-soft);color:var(--accent)}.notification-tip{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;background:var(--surface-2);border:1px solid var(--line-soft);border-radius:var(--radius-sm);margin-top:22px;color:var(--muted)}.notification-tip>.icon{flex-shrink:0;margin-top:2px;color:var(--accent)}.notification-tip p{font-size:12px;line-height:1.8;margin:0}.delay-form{display:flex;align-items:center;justify-content:space-between;gap:20px;border-top:1px solid var(--line-soft);padding-top:18px;margin-top:20px}.delay-form label{margin:0;flex:1;font-size:12px}.delay-form input{max-width:160px;margin:8px 0}.delay-form small{display:block;font-size:12px;line-height:1.8;color:var(--faint)}.delay-form>button{align-self:center}.notification-error{display:flex;gap:9px;align-items:flex-start;padding:12px 15px;border:1px solid var(--danger-line,var(--line));background:var(--danger-soft);border-radius:var(--radius-sm);color:var(--danger);font-size:12px;line-height:1.8}.notification-error>.icon{flex-shrink:0;margin-top:3px}.notification-section-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:25px 0 14px}.notification-section-heading h3{font-size:14px;font-weight:500;margin:0}.notification-section-heading p{font-size:12px;margin:6px 0 0;color:var(--faint)}.notification-section-heading>span{font-size:12px;color:var(--faint)}.notification-count{font-size:11px;font-weight:400;color:var(--faint);padding-left:7px}.notification-section-heading .button-row{gap:8px;flex-wrap:nowrap;margin:0}.notification-channel-list{display:flex;flex-direction:column;gap:12px}.notification-channel{display:flex;align-items:center;gap:16px;padding:19px 20px;background:var(--surface-1,var(--surface));border:1px solid var(--line);border-radius:var(--radius-lg);transition:border-color var(--dur) var(--ease)}.notification-channel:hover{border-color:var(--accent-line)}.channel-symbol{width:42px;height:42px;flex-shrink:0;display:grid;place-items:center;border-radius:12px;background:var(--accent-soft);color:var(--accent)}.inactive .channel-symbol{color:var(--faint);background:var(--surface-2)}.channel-info{min-width:0;flex:1}.channel-title{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.channel-title h4{font-size:14px;font-weight:500;color:var(--text-strong);margin:0}.channel-title code,.channel-kind{font-size:11px;line-height:1.5;padding:2px 8px;border:1px solid var(--line-soft);border-radius:var(--radius-pill);background:var(--surface-2);color:var(--muted)}.channel-title code{font-family:var(--font-mono)}.channel-address{font-size:12px;margin:7px 0 0;color:var(--muted);overflow-wrap:anywhere}.channel-template{font-size:11px;color:var(--faint);margin:5px 0 0;font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.channel-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}.channel-actions>.switch{margin-right:7px}.notification-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:230px;padding:35px 24px;background:var(--surface-2);border:1px dashed var(--line-strong);border-radius:var(--radius-lg);text-align:center;color:var(--muted);font-size:12px}.empty-bell{display:grid;place-items:center;width:58px;height:58px;border:1px solid var(--accent-line);border-radius:18px;background:var(--accent-soft);color:var(--accent);margin-bottom:18px}.notification-empty strong{font-size:14px;font-weight:500;color:var(--text)}.notification-empty p{font-size:12px;line-height:1.8;color:var(--faint);margin:9px 0 15px}.notification-empty .text-button{display:inline-flex;align-items:center;gap:8px}.notification-dialog{max-width:620px}.notification-type-tabs{display:flex;gap:4px;padding:4px;background:var(--surface-2);border:1px solid var(--line-soft);border-radius:var(--radius-sm);margin-bottom:22px}.notification-type-tabs>button{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;border:1px solid transparent;background:transparent;color:var(--faint);font-size:13px;padding:9px 12px;border-radius:calc(var(--radius-sm) - 3px)}.notification-type-tabs>button.active{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}.smtp-address{grid-template-columns:minmax(0,1fr) 120px}.notification-template-section{border-top:1px solid var(--line-soft);padding-top:20px;margin-top:12px}.notification-template-section textarea{line-height:1.9;resize:vertical;min-height:145px;font-family:var(--font-mono);font-size:12px}.template-help{font-size:11px;line-height:1.9;margin:8px 0 18px;color:var(--faint)}.template-help code{font-family:var(--font-mono);color:var(--muted)}.notification-deliveries{margin-top:26px}.notification-deliveries .notification-section-heading{margin:0 0 8px}.delivery-row{display:flex;align-items:center;gap:10px;padding:13px 0;border-bottom:1px solid var(--line-soft)}.delivery-row:last-child{border-bottom:0}.delivery-dot{width:6px;height:6px;flex-shrink:0;border-radius:50%;background:var(--success)}.delivery-dot.failed{background:var(--danger)}.delivery-row>div{min-width:0;flex:1}.delivery-row strong{display:block;color:var(--text);font-size:12px;font-weight:500;overflow-wrap:anywhere}.delivery-row strong>span{color:var(--muted);font-weight:400}.delivery-row small{display:block;margin-top:4px;font-size:11px;color:var(--faint)}.delivery-status{color:var(--muted);font-size:11px;white-space:nowrap}
@media(max-width:900px){.notification-channel{gap:12px;padding:16px}.channel-symbol{display:none}.channel-actions{gap:4px}.channel-title{gap:6px}}
@media(max-width:640px){.notification-heading h2{font-size:18px}.notification-symbol{width:40px;height:40px;border-radius:12px}.notification-tip{padding:12px}.delay-form{align-items:flex-start;flex-direction:column;gap:14px}.delay-form>button{align-self:flex-start}.notification-section-heading{gap:12px}.notification-section-heading p{line-height:1.7}.notification-channel{display:block}.channel-actions{margin-top:14px;justify-content:flex-end;padding-top:12px;border-top:1px solid var(--line-soft)}.channel-actions>.switch{margin-right:auto}.channel-template{white-space:normal;overflow-wrap:anywhere}.notification-section-heading>span{display:none}.notification-empty{min-height:210px;padding:28px 18px}.smtp-address{grid-template-columns:minmax(0,1fr) 96px}}
</style>
