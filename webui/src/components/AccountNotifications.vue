<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api';
import Icon from './Icon.vue';

interface Channel {
  id: string;
  name: string;
  type: 'email' | 'webhook';
  enabled: boolean;
}
interface Binding { enabled: boolean; channelIds: string[] }

const props = withDefaults(defineProps<{ profileId?: string; disabled?: boolean }>(), { profileId: '', disabled: false });
const enabled = ref(false);
const channelIds = ref<string[]>([]);
const channels = ref<Channel[]>([]);
const loaded = ref(false);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const success = ref('');
const saved = ref('');
let generation = 0;
let disposed = false;

const binding = () => ({ enabled: enabled.value, channelIds: [...channelIds.value] });
const dirty = computed(() => loaded.value && JSON.stringify(binding()) !== saved.value);
const locked = computed(() => loading.value || saving.value || props.disabled || !loaded.value);
const missing = computed(() => channelIds.value.filter(id => !channels.value.some(channel => channel.id === id)));
const selectedEnabled = computed(() => channels.value.filter(channel => channel.enabled && channelIds.value.includes(channel.id)).length);

function message(value: unknown) { return value instanceof Error ? value.message : '通知设置操作失败，请重试。'; }
function accept(value: Binding) {
  if (typeof value?.enabled !== 'boolean' || !Array.isArray(value.channelIds) || value.channelIds.some(id => typeof id !== 'string')) {
    throw new Error('账号通知配置格式无效，请刷新后重试。');
  }
  enabled.value = value.enabled;
  channelIds.value = [...new Set(value.channelIds)];
  saved.value = JSON.stringify(binding());
}
async function load() {
  const ticket = ++generation;
  const id = props.profileId;
  loading.value = Boolean(id); saving.value = false; loaded.value = false;
  enabled.value = false; channelIds.value = []; channels.value = [];
  error.value = ''; success.value = ''; saved.value = '';
  if (!id) return;
  try {
    const [value, catalog] = await Promise.all([
      api<Binding>('/accounts/' + encodeURIComponent(id) + '/notifications'),
      api<{ channels: Channel[] }>('/notifications'),
    ]);
    if (disposed || generation !== ticket || props.profileId !== id) return;
    if (!Array.isArray(catalog?.channels)) throw new Error('通知渠道列表格式无效，请刷新后重试。');
    channels.value = catalog.channels;
    accept(value); loaded.value = true;
  } catch (value) {
    if (!disposed && generation === ticket && props.profileId === id) error.value = message(value);
  } finally {
    if (!disposed && generation === ticket && props.profileId === id) loading.value = false;
  }
}
async function save() {
  if (locked.value || !props.profileId || !dirty.value) return;
  const ticket = ++generation;
  const id = props.profileId;
  const payload = binding();
  saving.value = true; error.value = ''; success.value = '';
  try {
    const value = await api<Binding>('/accounts/' + encodeURIComponent(id) + '/notifications', 'PATCH', payload);
    if (disposed || generation !== ticket || props.profileId !== id) return;
    accept(value);
    success.value = '通知设置已保存并生效，无需重启 QQ。';
  } catch (value) {
    if (!disposed && generation === ticket && props.profileId === id) error.value = message(value);
  } finally {
    if (!disposed && generation === ticket && props.profileId === id) saving.value = false;
  }
}
function changed() { success.value = ''; }
function deselect(id: string) { channelIds.value = channelIds.value.filter(value => value !== id); changed(); }

watch(() => props.profileId, () => { void load(); }, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation++; });
</script>

<template>
  <section class="account-notifications" aria-labelledby="account-notifications-title">
    <header class="notification-heading">
      <div><span class="eyebrow">ACCOUNT NOTIFICATIONS</span><h3 id="account-notifications-title">账号通知</h3><p>为当前账号选择掉线与恢复通知的接收渠道。</p></div>
      <span class="badge" :class="enabled ? 'running' : 'stopped'">{{ enabled ? '已开启' : '已关闭' }}</span>
    </header>
    <p v-if="!profileId" class="note">请选择账号后配置通知。</p>
    <p v-else-if="loading" class="note" role="status">正在读取通知渠道…</p>
    <template v-else>
      <fieldset :disabled="locked" class="notification-fields">
        <div class="switch-row">
          <div class="switch-row-text"><strong>开启此账号的状态通知</strong><small>关闭后停止推送，保留已选渠道。手动停止与维护不触发掉线通知。</small></div>
          <button type="button" class="switch" :class="{ on: enabled }" role="switch" :aria-checked="enabled" aria-label="开启当前账号的状态通知" @click="enabled = !enabled; changed()"><span></span></button>
        </div>
        <div v-if="loaded && !channels.length" class="notification-empty">
          <Icon name="inbox" :size="21" /><div><strong>尚未配置通知渠道</strong><p>请先前往“系统设置 → 通知”添加邮件或 Webhook 渠道，再返回此处选择。</p></div>
        </div>
        <div v-else-if="channels.length" class="notification-channel-list" role="group" aria-label="此账号使用的通知渠道">
          <label v-for="channel in channels" :key="channel.id" class="notification-channel" :class="{ checked: channelIds.includes(channel.id), inactive: !channel.enabled }">
            <input v-model="channelIds" class="channel-input" type="checkbox" :value="channel.id" @change="changed" />
            <span class="channel-icon" aria-hidden="true"><Icon :name="channel.type === 'email' ? 'mail' : 'link'" :size="19" /></span>
            <span class="channel-copy"><strong>{{ channel.name || channel.id }}</strong><small>{{ channel.id }} · {{ channel.type === 'email' ? '邮件' : 'Webhook' }}</small></span>
            <span class="channel-state" :class="{ inactive: !channel.enabled }">{{ channel.enabled ? '可用' : '渠道已停用' }}</span>
            <span class="channel-check" aria-hidden="true"><Icon name="check" :size="13" /></span>
          </label>
        </div>
        <div v-if="missing.length" class="missing-channels">
          <p>以下已选渠道已删除，选择记录仍保留；可手动取消。</p>
          <div class="notification-channel-list">
            <div v-for="id in missing" :key="id" class="notification-channel missing-channel">
              <span class="channel-icon" aria-hidden="true"><Icon name="link" :size="19" /></span>
              <span class="channel-copy"><strong>{{ id }}</strong><small>已保存的渠道选择</small></span>
              <span class="channel-state inactive">已删除</span>
              <button type="button" class="icon-button danger-text" :aria-label="'取消已删除的通知渠道 ' + id" title="取消选择" @click="deselect(id)"><Icon name="close" :size="15" /></button>
            </div>
          </div>
        </div>
        <p v-if="loaded && enabled && !selectedEnabled" class="notification-warning"><Icon name="info" :size="15" />尚未选择已启用的渠道，当前不会发送通知。</p>
      </fieldset>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
      <p v-if="success" class="notification-success" role="status"><Icon name="check" :size="15" />{{ success }}</p>
      <footer class="notification-footer">
        <small>{{ dirty ? '有未保存的通知设置' : '通知设置单独保存，不重启账号或连接节点。' }}</small>
        <div class="button-row"><button type="button" class="secondary" :disabled="loading || saving || disabled || !profileId" @click="load"><Icon name="refresh" :size="14" />刷新渠道</button><button type="button" class="primary" :disabled="locked || !dirty" @click="save">{{ saving ? '保存中…' : '保存通知设置' }}</button></div>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.account-notifications{margin-top:24px;padding-top:24px;border-top:1px solid var(--line-soft)}
.notification-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.notification-heading .eyebrow{font-size:11px;margin-bottom:8px}.notification-heading h3{font-size:16px;margin:0 0 8px}.notification-heading p{font-size:12px;line-height:1.8;color:var(--muted);margin:0}.notification-heading>.badge{white-space:nowrap}
.notification-fields{margin:0;padding:0;border:0;min-width:0}.notification-fields .switch-row{margin:18px 0}.notification-fields:disabled{opacity:.65}
.notification-channel-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(330px,100%),1fr));gap:10px}
.account-notifications .notification-channel{position:relative;display:grid;grid-template-columns:36px minmax(0,1fr) auto 20px;align-items:center;justify-content:normal;gap:11px;box-sizing:border-box;width:100%;min-height:76px;padding:12px 14px;margin:0;text-align:left;border:1px solid var(--line-soft);border-radius:var(--radius-sm);background:var(--surface-2);cursor:pointer;transition:border-color var(--dur) var(--ease),background var(--dur) var(--ease),box-shadow var(--dur) var(--ease)}
.account-notifications .notification-channel:hover{border-color:var(--line-strong)}.account-notifications .notification-channel.checked{border-color:var(--accent-line);background:var(--accent-soft)}.account-notifications .notification-channel:focus-within{outline:2px solid var(--accent);outline-offset:3px}.account-notifications .notification-channel .channel-input{position:absolute;top:0;left:0;width:1px;height:1px;padding:0;margin:0;border:0;opacity:0;overflow:hidden;clip-path:inset(50%)}
.channel-icon{display:grid;place-items:center;width:36px;height:36px;flex-shrink:0;border:1px solid var(--line-soft);border-radius:10px;color:var(--muted);background:var(--surface-3)}.checked .channel-icon{color:var(--accent);border-color:var(--accent-line);background:var(--surface-2)}.channel-copy{display:block;min-width:0;text-align:left}.channel-copy strong,.channel-copy small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.channel-copy strong{font-size:13px;line-height:1.5;font-weight:500;color:var(--text)}.channel-copy small{font-size:11px;line-height:1.5;margin-top:4px;color:var(--faint)}.channel-state{display:inline-flex;align-items:center;gap:5px;color:var(--success);font-size:11px;line-height:1.5;white-space:nowrap}.channel-state::before{content:'';width:4px;height:4px;border-radius:50%;background:currentColor}.channel-state.inactive{color:var(--faint)}
.channel-check{display:grid;place-items:center;box-sizing:border-box;width:19px;height:19px;border:1px solid var(--line-strong);border-radius:6px;color:var(--accent-contrast);background:var(--surface);transition:background var(--dur) var(--ease),border-color var(--dur) var(--ease)}.channel-check>.icon{opacity:0}.checked .channel-check{border-color:var(--accent);background:var(--accent)}.checked .channel-check>.icon{opacity:1}.notification-fields:disabled .notification-channel{cursor:not-allowed}
.notification-empty{display:flex;align-items:flex-start;gap:12px;padding:17px;border:1px dashed var(--line-strong);border-radius:var(--radius-sm);background:var(--surface-2)}.notification-empty>.icon{color:var(--accent);margin-top:2px;flex-shrink:0}.notification-empty strong{font-size:13px;font-weight:500}.notification-empty p{font-size:12px;color:var(--faint);line-height:1.8;margin:5px 0 0}
.missing-channels{margin-top:14px}.missing-channels>p{font-size:12px;color:var(--muted);line-height:1.8;margin:0 0 10px}.account-notifications .missing-channel{grid-template-columns:36px minmax(0,1fr) auto 24px;cursor:default}.missing-channel .channel-icon{color:var(--faint)}.missing-channel .channel-copy strong{color:var(--muted)}.missing-channel .icon-button{min-width:24px;width:24px;height:24px;padding:3px}
.notification-warning,.notification-success{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.8;margin:12px 0 0}.notification-warning{color:var(--warning)}.notification-success{color:var(--success)}.notification-warning>.icon,.notification-success>.icon{margin-top:3px;flex-shrink:0}
.notification-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:18px}.notification-footer>small{font-size:12px;color:var(--faint);line-height:1.8}.notification-footer>.button-row{flex-shrink:0;flex-wrap:nowrap}.inline-error{margin:12px 0 0}
@media(max-width:760px){.notification-heading h3{font-size:15px}.notification-footer{flex-direction:column;align-items:stretch;gap:12px}.notification-footer>.button-row{justify-content:flex-end}.notification-channel-list{grid-template-columns:minmax(0,1fr)}.account-notifications .notification-channel{padding:12px;gap:9px}.channel-state{font-size:11px}}
</style>
