<script setup lang="ts">
import { computed, onMounted, reactive, watch } from 'vue';
import Icon from './Icon.vue';
import StatusBadge from './StatusBadge.vue';
import type { StorageCleanup, StorageCleanupRequest, StorageSnapshot } from '../types';

const props = defineProps<{ snapshot: StorageSnapshot | null; result: StorageCleanup | null; busy: boolean }>();
const emit = defineEmits<{
  refresh: [];
  savePolicy: [policy: { logMaxMiB: number; logRetentionDays: number }];
  cleanup: [request: StorageCleanupRequest];
}>();
const draft = reactive({ logMaxMiB: 1024, logRetentionDays: 7 });
const recent = computed(() => props.result || props.snapshot?.lastCleanup || null);
let requested = false;
function requestInitial() {
  if (!props.busy && !props.snapshot && !requested) { requested = true; emit('refresh'); }
}
watch(() => props.snapshot?.policy, value => {
  if (value) { draft.logMaxMiB = value.logMaxMiB; draft.logRetentionDays = value.logRetentionDays; }
}, { immediate: true });
watch(() => props.busy, requestInitial);
onMounted(requestInitial);

function bytes(value?: number) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return value + ' B';
  if (value < 1024 ** 2) return (value / 1024).toFixed(1) + ' KiB';
  if (value < 1024 ** 3) return (value / 1024 ** 2).toFixed(1) + ' MiB';
  return (value / 1024 ** 3).toFixed(2) + ' GiB';
}
function date(value?: string | number) {
  if (value === undefined) return '—';
  const time = new Date(value); return Number.isFinite(time.getTime()) ? time.toLocaleString('zh-CN', { hour12: false }) : '—';
}
function category(value: StorageCleanup) { return value.scope === 'logs' ? '日志策略清理' : value.category === 'history' ? '消息历史正文' : '媒体缓存'; }
</script>

<template>
  <div class="storage-panel">
    <section class="panel">
      <div class="section-heading"><div><span class="eyebrow">WORKSPACE STORAGE</span><h2>存储管理</h2><p>查看日志、消息历史与媒体缓存占用，按范围维护当前工作空间。</p></div><button class="secondary" :disabled="busy" @click="emit('refresh')"><Icon name="refresh" :size="15" /> 刷新统计</button></div>
      <div class="storage-totals">
        <div><span><Icon name="box" :size="16" />统计总占用</span><strong>{{ bytes(snapshot?.totals.totalBytes) }}</strong><small>{{ snapshot ? snapshot.totals.files + ' 个文件' : '等待统计' }}</small></div>
        <div><span><Icon name="list" :size="16" />日志</span><strong>{{ bytes(snapshot?.totals.logsBytes) }}</strong><small>管理服务与所有账号</small></div>
        <div><span><Icon name="message" :size="16" />消息历史</span><strong>{{ bytes(snapshot?.totals.historyBytes) }}</strong><small>保留消息 ID 与定位映射</small></div>
        <div><span><Icon name="inbox" :size="16" />媒体缓存</span><strong>{{ bytes(snapshot?.totals.mediaBytes) }}</strong><small>账号范围内的媒体文件</small></div>
      </div>
      <p v-if="snapshot?.partial" class="note storage-warning">部分目录或文件未能完整统计，当前数字仅代表可确认部分。清理会跳过无法安全核验的项目。</p>
      <p class="storage-scan">{{ snapshot ? '已扫描 ' + snapshot.scanned.accounts + ' 个账号、' + snapshot.scanned.files + ' 个文件' : busy ? '正在统计，请稍候…' : '尚未取得统计结果，可点击刷新重试。' }}</p>
    </section>

    <section class="panel">
      <div class="section-heading"><div><h2>日志保留策略</h2><p>全局总限额覆盖管理服务与所有账号日志，消息历史和媒体缓存不计入此限额。</p></div><span class="badge" :class="snapshot?.policy.enabled ? 'running' : 'stopped'">{{ snapshot?.policy.enabled ? '周期清理已启用' : '周期清理未启用' }}</span></div>
      <form @submit.prevent="emit('savePolicy', { ...draft })">
        <fieldset :disabled="busy || !snapshot">
          <div class="storage-policy-fields"><label>日志总限额（MiB）<input v-model.number="draft.logMaxMiB" type="number" min="1" max="102400" step="1" required /><small>1–102400 MiB，达到上限时按策略移除旧日志。</small></label><label>日志保留天数<input v-model.number="draft.logRetentionDays" type="number" min="0" max="3650" step="1" required /><small>0–3650 天；设为 0 不按时间删除，仅执行容量策略。</small></label></div>
          <p class="note">首次保存前不会自动清理。保存即刻应用并启用每 5 分钟一次的日志策略；“立即清理日志”使用已保存策略执行一次，不会清空全部日志。</p>
          <div class="storage-policy-actions"><button type="button" class="secondary" @click="emit('cleanup', { scope: 'logs' })"><Icon name="eraser" :size="15" /> 立即清理日志</button><button type="submit" class="primary">保存日志策略</button></div>
        </fieldset>
      </form>
    </section>

    <section class="panel">
      <div class="section-heading"><div><h2>账号存储</h2><p>历史与媒体仅允许在账号完全停止、没有维护或备份操作时清理。不会替你停止账号。</p></div></div>
      <div v-if="!snapshot?.accounts.length" class="empty compact">{{ snapshot ? '尚无账号存储可展示。' : '取得统计后将在这里显示各账号占用。' }}</div>
      <div v-else class="storage-account-list">
        <article v-for="item in snapshot.accounts" :key="item.profileId" class="storage-account">
          <div class="storage-account-heading"><div><h3>{{ item.label || item.profileId }}</h3><p><code>{{ item.profileId }}</code><span v-if="item.uin"> · QQ {{ item.uin }}</span></p></div><StatusBadge :state="item.state" /></div>
          <dl class="storage-account-usage"><div><dt>日志</dt><dd>{{ bytes(item.logs.bytes) }}<small v-if="item.logs.partial">部分统计</small></dd></div><div><dt>消息历史</dt><dd>{{ bytes(item.history.bytes) }}<small v-if="item.history.partial">部分统计</small></dd></div><div><dt>媒体缓存</dt><dd>{{ bytes(item.media.bytes) }}<small v-if="item.media.partial">部分统计</small></dd></div><div><dt>合计</dt><dd>{{ bytes(item.totalBytes) }}</dd></div></dl>
          <div class="storage-account-actions"><p :class="{ 'storage-warning': !item.canClean }">{{ item.canClean ? '账号已停止，可在输入实例编号确认后清理。' : item.blockedReason || '账号未完全停止，暂不可清理。' }}</p><div class="button-row"><button class="secondary" :disabled="busy || !item.canClean" @click="emit('cleanup', { scope: 'account', profileId: item.profileId, category: 'history' })">清理消息历史</button><button class="secondary" :disabled="busy || !item.canClean" @click="emit('cleanup', { scope: 'account', profileId: item.profileId, category: 'media' })">清理媒体缓存</button></div></div>
        </article>
      </div>
      <p class="storage-footnote">历史清理仅剥离聊天正文与事件内容，保留 OneBot 消息 ID、定位映射和去重标记；清理不会删除账号配置、QQ 登录资料或 QQ 程序。</p>
    </section>

    <section v-if="recent" class="panel storage-cleanup-result" aria-label="最近清理结果">
      <div class="section-heading"><div><h2>最近清理结果</h2><p>{{ date(recent.at) }} · {{ category(recent) }}<span v-if="recent.profileId"> · {{ recent.profileId }}</span></p></div><span class="badge" :class="recent.partial ? 'blocked' : 'running'">{{ recent.partial ? '部分完成' : '处理完成' }}</span></div>
      <div class="storage-result-values"><span>回收空间<strong>{{ bytes(recent.reclaimedBytes) }}</strong></span><span>删除文件<strong>{{ recent.deletedFiles }}</strong></span><span>跳过项目<strong>{{ recent.skipped }}</strong></span></div>
      <p v-if="recent.partial" class="note storage-warning">存在未能核验或已变化的文件，已安全跳过；可刷新统计，确认账号及文件状态后再决定是否重试。</p>
    </section>
  </div>
</template>

<style scoped>
.storage-panel{min-width:0}.storage-panel .section-heading{align-items:flex-start}.storage-panel .section-heading>.badge{flex-shrink:0;white-space:nowrap}.storage-panel .eyebrow{display:block;margin-bottom:8px}.storage-totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:22px}.storage-totals>div{min-width:0;padding:17px;background:var(--surface-2);border:1px solid var(--line-soft);border-radius:var(--radius-sm)}.storage-totals>div>span{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted)}.storage-totals strong{display:block;margin:14px 0 7px;font-size:22px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--text-strong)}.storage-totals small{display:block;font-size:11px;line-height:1.7;color:var(--faint)}.storage-scan,.storage-footnote{font-size:12px;line-height:1.8;color:var(--faint);margin:16px 0 0}.storage-warning{color:var(--warning)}.storage-policy-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.storage-policy-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:18px}.storage-account-list{display:flex;flex-direction:column;gap:14px}.storage-account{min-width:0;padding:18px;background:var(--surface-2);border:1px solid var(--line-soft);border-radius:var(--radius-sm)}.storage-account-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.storage-account-heading>div{min-width:0}.storage-account-heading h3{font-size:15px;margin:0 0 6px;overflow-wrap:anywhere}.storage-account-heading p{font-size:12px;color:var(--faint);line-height:1.7;margin:0;overflow-wrap:anywhere}.storage-account-heading code{font-family:var(--font-mono);font-size:12px}.storage-account-usage{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}.storage-account-usage>div{min-width:0}.storage-account-usage dt{font-size:12px;color:var(--faint);margin-bottom:5px}.storage-account-usage dd{margin:0;font-size:15px;color:var(--text);font-variant-numeric:tabular-nums}.storage-account-usage small{display:block;font-size:11px;color:var(--warning);margin-top:4px}.storage-account-actions{display:flex;align-items:center;justify-content:space-between;gap:14px;border-top:1px solid var(--line-soft);padding-top:14px}.storage-account-actions>p{max-width:330px;margin:0;font-size:12px;line-height:1.8;color:var(--faint)}.storage-account-actions>.storage-warning{color:var(--warning)}.storage-account-actions .button-row{flex-shrink:0;justify-content:flex-end}.storage-account-actions button{font-size:12px}.storage-result-values{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.storage-result-values>span{font-size:12px;color:var(--muted)}.storage-result-values strong{display:block;margin-top:8px;font-size:19px;font-weight:500;color:var(--text);font-variant-numeric:tabular-nums}
@media(max-width:1200px){.storage-totals{grid-template-columns:repeat(2,minmax(0,1fr))}.storage-account-actions{display:block}.storage-account-actions>p{max-width:none;margin-bottom:12px}}
@media(max-width:760px){.storage-totals{gap:9px}.storage-totals>div{padding:13px}.storage-totals strong{font-size:19px}.storage-policy-fields{grid-template-columns:minmax(0,1fr);gap:0}.storage-account{padding:14px}.storage-account-usage{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:16px}.storage-account-usage dd{font-size:14px}.storage-account-actions .button-row{justify-content:flex-start}.storage-panel .section-heading{flex-wrap:wrap;gap:12px}.storage-result-values{gap:10px}.storage-result-values strong{font-size:16px}}
</style>
