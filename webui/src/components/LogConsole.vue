<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import Icon from './Icon.vue';
import type { Account, Json } from '../types';
import { logRecordKey } from '../log-key.mjs';

const props = defineProps<{ records: Json[]; accounts: Account[]; paused: boolean; connected: boolean; busy: boolean }>();
const emit = defineEmits<{ pause: [value: boolean]; reload: [] }>();
const query = ref('');
const accountId = ref('');
const component = ref('');
const selectedLevel = ref('');
const autoScroll = ref(true);
const page = ref(1);
const pageSize = 100;
const wrap = ref(true);
const viewport = ref<HTMLElement | null>(null);
const hidden = ref(new Set<string>());
const searchIndex = new WeakMap<Json, string>();
const levels = ['TRACE', 'DEBUG', 'INFO', 'SUCCESS', 'WARN', 'ERROR'];
const key = logRecordKey;
const isMessage = (item: Json) => item.kind === 'message' || typeof item.content === 'string';
function searchable(item: Json) {
  let value = searchIndex.get(item);
  if (value === undefined) { value = JSON.stringify(item).toLocaleLowerCase(); searchIndex.set(item, value); }
  return value;
}
function level(item: Json) {
  if (levels.includes(String(item.level).toUpperCase())) return String(item.level).toUpperCase();
  if (isMessage(item)) return 'SUCCESS';
  return /fail|error/i.test(String(item.event)) ? 'ERROR' : /gap|overflow|timeout|backoff/i.test(String(item.event)) ? 'WARN' : 'INFO';
}
function module(item: Json) { return String(item.component || (isMessage(item) ? 'message' : String(item.event || 'adapter').split('_')[0])); }
const components = computed(() => [...new Set(props.records.map(module))].sort());
const counts = computed(() => {
  const map: Record<string, number> = {};
  for (const item of props.records) {
    const name = level(item);
    map[name] = (map[name] || 0) + 1;
  }
  return map;
});
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return props.records.filter(item => !hidden.value.has(key(item)) &&
    (!accountId.value || item.profileId === accountId.value || item.accountId === accountId.value) &&
    (!component.value || module(item) === component.value) && (!selectedLevel.value || level(item) === selectedLevel.value) &&
    (!needle || searchable(item).includes(needle)));
});
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)));
const visible = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize));
function showPage(value: number) { autoScroll.value = false; page.value = Math.max(1, Math.min(pageCount.value, value)); }
function clock(item: Json) {
  const value = item.time ?? item.at;
  if (!value) return '—';
  const time = new Date(typeof value === 'number' ? value : String(value));
  return Number.isFinite(time.getTime()) ? time.toLocaleTimeString('zh-CN', { hour12: false }) : String(value);
}
function accountLabel(item: Json) { return props.accounts.find(account => account.id === item.profileId)?.label || String(item.profileId || '管理服务'); }
function messageLocation(item: Json) {
  const direction = item.event === 'message_sent' ? '发送' : '接收';
  const actor = String(item.card || item.senderName || item.userId || '未知发送者');
  const origin = item.messageType === 'group' ? '群 [' + String(item.groupName || item.groupId || '未知群') + (item.groupName && item.groupId ? '(' + item.groupId + ')' : '') + ']' : '私聊 [' + String(item.peerId || item.userId || '未知对象') + ']';
  return direction + ' · ' + origin + ' | ' + actor + (item.userId && actor !== String(item.userId) ? '(' + item.userId + ')' : '') + (item.messageId !== undefined ? ' · ID: ' + item.messageId : '');
}
function description(item: Json) {
  if (typeof item.message === 'string') return item.message;
  const labels: Record<string, string> = { start: '适配器启动', ready: '接入会话就绪', shutdown: '适配器停止', connected: '连接已建立', disconnected: '连接已断开', message_received: '收到消息', message_sent: '消息已发送', event_gap: '事件队列存在缺口' };
  const event = String(item.event || item.code || '诊断记录');
  const details = Object.entries(item).filter(([name]) => ['code', 'count', 'online', 'ready', 'connected', 'bridge', 'gap'].includes(name)).map(([name, value]) => name + '=' + JSON.stringify(value)).join(' · ');
  return (labels[event] || event) + (details ? ' · ' + details : '');
}
function toggleLevel(name: string) { selectedLevel.value = selectedLevel.value === name ? '' : name; }
function clearView() { hidden.value = new Set(props.records.map(key)); }
function exportDiagnostics() {
  // Original chat bodies remain visible in this authenticated page. Diagnostic
  // files deliberately keep only operational metadata, never message text.
  const fields = ['id', 'time', 'at', 'profileId', 'event', 'code', 'count', 'online', 'ready', 'connected', 'bridge', 'gap'];
  const records = filtered.value.map(item => {
    const record: Json = { level: level(item), component: module(item) };
    for (const name of fields) if (Object.hasOwn(item, name)) record[name] = item[name];
    if (isMessage(item)) { record.kind = 'message'; record.message = '[聊天正文和对象资料已省略]'; }
    return record;
  });
  const url = URL.createObjectURL(new Blob([records.map(item => JSON.stringify(item)).join('\n') + '\n'], { type: 'application/x-ndjson' }));
  const link = document.createElement('a'); link.href = url; link.download = 'freshwater-diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function scroll() { if (!autoScroll.value) return; await nextTick(); const element = viewport.value; if (element) element.scrollTop = element.scrollHeight; }
// Records are immutable snapshots. Avoid recursively watching every message
// field, and let filtering/clearing use the same post-render scroll path.
watch(filtered, () => { page.value = autoScroll.value ? pageCount.value : Math.min(page.value, pageCount.value); void scroll(); }, { flush: 'post' });
watch(() => props.records, records => {
  if (!hidden.value.size) return;
  const retained = new Set(records.map(key));
  const next = new Set([...hidden.value].filter(id => retained.has(id)));
  if (next.size !== hidden.value.size) hidden.value = next;
});
watch(autoScroll, () => { if (autoScroll.value) page.value = pageCount.value; void scroll(); });
</script>

<template>
  <section class="panel log-console">
    <div class="log-heading">
      <div>
        <h2>运行日志 <span class="log-live" :class="{ active: connected && !paused }"><i></i>{{ paused ? '已暂停' : connected ? '实时' : '重连中' }}</span></h2>
        <p>{{ filtered.length }}/{{ records.length }} 条 · 最多保留最近 1000 条 · 接收与发送消息显示原文</p>
      </div>
      <div class="log-toolbar">
        <label class="log-search"><Icon name="search" :size="15" /><input v-model="query" placeholder="搜索消息 / 模块 / 错误码" aria-label="搜索日志" /></label>
        <button class="log-tool" :class="{ active: autoScroll }" title="自动滚动到底部" aria-label="自动滚动" :aria-pressed="autoScroll" @click="autoScroll = !autoScroll"><Icon name="downToLine" :size="16" /></button>
        <button class="log-tool" :class="{ active: wrap }" title="消息自动换行" aria-label="自动换行" :aria-pressed="wrap" @click="wrap = !wrap"><Icon name="wrap" :size="16" /></button>
        <button class="log-tool" :class="{ active: paused }" :title="paused ? '继续接收' : '暂停接收'" :aria-label="paused ? '继续接收日志' : '暂停接收日志'" @click="emit('pause', !paused)"><Icon :name="paused ? 'play' : 'pause'" :size="16" /></button>
        <span class="toolbar-divider"></span>
        <button class="log-tool" title="重新读取最近日志" aria-label="重新读取日志" :disabled="busy" @click="emit('reload')"><Icon name="refresh" :size="16" /></button>
        <button class="log-tool" title="导出当前筛选的脱敏诊断（不含聊天正文）" aria-label="导出脱敏诊断" :disabled="!filtered.length" @click="exportDiagnostics"><Icon name="download" :size="16" /></button>
        <button class="log-tool" title="清空当前视图，不删除日志文件" aria-label="清空当前日志视图" :disabled="!filtered.length" @click="clearView"><Icon name="eraser" :size="16" /></button>
      </div>
    </div>
    <div class="log-filters">
      <div class="level-filters" role="group" aria-label="日志级别">
        <span class="filter-symbol" aria-hidden="true"><Icon name="filter" :size="14" /></span>
        <button
          v-for="name in levels"
          :key="name"
          :class="['level-chip', name.toLowerCase(), { selected: selectedLevel === name, dim: selectedLevel && selectedLevel !== name }]"
          :aria-pressed="selectedLevel === name"
          @click="toggleLevel(name)"
        ><i aria-hidden="true"></i>{{ name }}<span v-if="counts[name]" class="level-count" aria-hidden="true">{{ counts[name] }}</span></button>
      </div>
      <div class="log-scopes">
        <select v-model="accountId" aria-label="日志账号范围"><option value="">全部账号</option><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.label || account.id }}</option></select>
        <select v-model="component" aria-label="日志组件"><option value="">全部模块</option><option v-for="name in components" :key="name" :value="name">{{ name }}</option></select>
      </div>
    </div>
    <div ref="viewport" class="log-table" :class="{ nowrap: !wrap }" role="log" aria-label="运行日志" :aria-live="paused ? 'off' : 'polite'">
      <table>
        <thead><tr><th>时间</th><th>级别</th><th>模块</th><th>消息</th></tr></thead>
        <tbody>
          <tr v-for="item in visible" :key="key(item)">
            <td class="log-time"><span class="cell-label" aria-hidden="true">时间</span><span :title="String(item.time || item.at || '')">{{ clock(item) }}</span><small>{{ accountLabel(item) }}</small></td>
            <td><span class="cell-label" aria-hidden="true">级别</span><span class="log-level" :class="level(item).toLowerCase()"><i></i>{{ level(item) }}</span></td>
            <td class="log-module"><span class="cell-label" aria-hidden="true">模块</span>[{{ module(item) }}]</td>
            <td class="log-message">
              <span class="cell-label" aria-hidden="true">消息</span>
              <template v-if="isMessage(item)"><span class="message-source">{{ messageLocation(item) }}：</span><span class="message-content">{{ item.content ?? item.message }}</span><small v-if="item.truncated" class="truncated">[内容过长，已截断]</small></template>
              <template v-else>{{ description(item) }}</template>
            </td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="4" class="empty compact">{{ records.length ? '暂无匹配日志，可调整筛选条件。' : '暂无日志，收到消息后将在这里显示原文。' }}</td></tr>
        </tbody>
      </table>
    </div>
    <div v-if="pageCount > 1" class="button-row" aria-label="日志分页">
      <button :disabled="page <= 1" @click="showPage(page - 1)">上一页</button>
      <span>{{ page }} / {{ pageCount }} 页 · 每页 {{ pageSize }} 条</span>
      <button :disabled="page >= pageCount" @click="showPage(page + 1)">下一页</button>
      <button @click="autoScroll = true">跟随最新</button>
    </div>
    <div class="log-notes"><span>聊天原文仅供管理员查看；下载的诊断文件排除正文和对象资料。</span><span>{{ paused ? '暂停期间不保证补发全部记录' : autoScroll ? '自动跟随最新日志' : '已关闭自动滚动' }}</span></div>
  </section>
</template>

<style scoped>
.log-console{min-width:0}.log-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.log-heading h2{font-size:17px;margin:0 0 6px;display:flex;align-items:center;gap:10px}.log-heading p{font-size: 12px;color:var(--muted);margin:0;line-height:1.7}.log-live{display:inline-flex;align-items:center;gap:5px;font-size: 12px;font-weight:400;color:var(--muted)}.log-live i{width:4px;height:4px;background:var(--faint);border-radius:50%}.log-live.active{color:var(--success)}.log-live.active i{background:var(--success)}.log-toolbar{display:flex;align-items:center;gap:4px}.log-search{display:flex;align-items:center;position:relative;min-width:220px;max-width:280px;margin:0 6px 0 0}.log-search>.icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--faint);pointer-events:none}.log-search input{padding:8px 9px 8px 30px;font-size: 12px;border-radius:var(--radius-sm);width:100%;height:34px}.log-tool{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:var(--radius-xs);background:transparent;color:var(--muted);border:1px solid transparent;padding:0}.log-tool:hover{background:var(--surface-3);color:var(--text)}.log-tool.active{background:var(--accent-soft);border-color:var(--accent-line);color:var(--accent)}.toolbar-divider{height:17px;width:1px;background:var(--line);margin:0 5px}.log-filters{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:20px 0 16px;flex-wrap:wrap}.level-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.filter-symbol{display:inline-flex;align-items:center;color:var(--faint);margin-right:2px}.level-chip{font-size: 12px;letter-spacing:.5px;display:flex;align-items:center;gap:5px;padding:5px 9px;border-radius:var(--radius-pill);background:var(--surface-2);border:1px solid var(--line-soft);color:var(--muted)}.level-chip:hover{border-color:var(--line-strong);color:var(--text)}.level-chip.dim{opacity:.55}.level-chip.selected{background:var(--surface-3);border-color:currentColor;opacity:1}.level-chip i,.log-level i{width:5px;height:5px;background:currentColor;border-radius:50%;display:inline-block;flex-shrink:0}.level-count{font-size: 12px;color:var(--faint);font-variant-numeric:tabular-nums}.level-chip.trace,.log-level.trace{color:var(--faint)}.level-chip.debug,.log-level.debug{color:var(--second)}.level-chip.info,.log-level.info{color:var(--info)}.level-chip.success,.log-level.success{color:var(--success)}.level-chip.warn,.log-level.warn{color:var(--warning)}.level-chip.error,.log-level.error{color:var(--danger)}.log-scopes{display:flex;gap:8px}.log-scopes select{width:auto;min-width:132px;padding:8px 30px 8px 11px;font-size: 12px;height:34px}.log-table{max-height:540px;overflow:auto;border:1px solid var(--line-soft);border-radius:var(--radius-sm);background:var(--surface-1)}.log-table table{min-width:720px}.log-table thead th{position:sticky;top:0;z-index:1;background:var(--surface-2);font-size: 12px}.log-table td{font-size: 13px;padding:10px 14px;vertical-align:top;white-space:normal}.log-time{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--text)}.log-time small{display:block;font-size: 12px;color:var(--faint);margin-top:2px}.log-level{font-size: 12px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.log-module{color:var(--muted);white-space:nowrap;font-family:var(--font-mono);font-size: 12px}.log-message{line-height:1.7;overflow-wrap:anywhere}.log-message .message-source{color:var(--faint);font-size: 12px}.message-content{white-space:pre-wrap;color:var(--text)}.log-table.nowrap .message-content{white-space:pre}.truncated{display:block;margin-top:2px;font-size: 12px;color:var(--warning)}.cell-label{display:none}.log-notes{display:flex;justify-content:space-between;gap:15px;margin-top:14px;font-size: 12px;color:var(--faint);line-height:1.8}
@media(max-width:1100px){.log-heading{display:block}.log-toolbar{margin-top:16px}.log-search{flex:1;max-width:none;min-width:120px}.log-filters{margin-top:18px}.log-table table{min-width:640px}}
@media(max-width:760px){.log-console{padding:18px 13px}.log-heading h2{font-size: 17px}.log-heading p{font-size: 12px}.log-toolbar{gap:2px;flex-wrap:wrap}.log-search{min-width:0;flex:1 0 100%;margin:0 0 6px}.log-search input{font-size: 12px}.log-tool{width:28px;height:28px;font-size: 16px;flex-shrink:0}.toolbar-divider{margin:0 2px}.log-filters{gap:10px;margin:16px 0 12px}.level-filters{gap:4px}.level-chip{padding:5px 7px;font-size: 12px;gap:4px}.filter-symbol{display:none}.log-scopes{width:100%}.log-scopes select{flex:1;min-width:0;font-size: 12px}.log-table{max-height:none;border:0;background:transparent;overflow:visible}.log-table table{min-width:0;display:block}.log-table thead{display:none}.log-table tbody{display:block}.log-table tr{display:block;margin-bottom:8px;padding:10px 12px;background:var(--surface-2);border:1px solid var(--line-soft);border-radius:var(--radius-sm)}.log-table tbody tr:hover{background:var(--surface-3)}.log-table td{display:block;padding:0 0 6px;border:0;font-size: 12px;white-space:normal}.log-table td:last-child{padding-bottom:0}.cell-label{display:inline-block;min-width:34px;margin-right:6px;font-size: 12px;color:var(--faint)}.log-time span:not(.cell-label){font-size: 12px}.log-time small{display:inline;margin-left:6px}.log-notes{display:block;font-size: 12px}.log-notes span{display:block}}
</style>
