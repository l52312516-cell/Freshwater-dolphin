<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ActionCapability, CapabilityState } from '../types';

const props = defineProps<{ state: CapabilityState; busy: boolean }>();
const emit = defineEmits<{ refresh: []; select: [name: string] }>();
const query = ref('');
const filter = ref('all');
const rows = computed(() => {
  const catalogue = props.state.catalogue;
  const needle = query.value.trim().toLowerCase();
  return catalogue ? [...catalogue.actions.map(item => ({ ...item, kind: '标准' })), ...catalogue.extensions.map(item => ({ ...item, kind: '扩展' }))]
    .filter(item => (!needle || item.name.toLowerCase().includes(needle)) &&
      (filter.value === 'all' || (filter.value === 'available' ? item.available : !item.available))) : [];
});
const availableCount = computed(() => {
  const catalogue = props.state.catalogue;
  return catalogue ? [...catalogue.actions, ...catalogue.extensions].filter(item => item.available).length : 0;
});
function availability(item: ActionCapability) {
  if (!item.implemented) return '尚未实现';
  if (item.available) return '当前可用';
  return props.state.catalogue?.ready ? '当前会话未提供所需能力' : '当前会话尚未就绪';
}
function verification(value: string) {
  return ({ verified: '已验证', 'offline-tested': '已离线测试 · 待目标 QQ 验证', unsupported: '未支持',
    unverified: '当前构建尚未验证', 'historical-scope': '此精确构建有指定场景历史验证',
    'previous-target-validation': '有历史目标验证', 'target-rendering-failed': '目标客户端渲染失败' } as Record<string, string>)[value] || value;
}
</script>

<template>
  <div class="capability-browser">
    <div class="section-heading">
      <div><h3>当前账号能力</h3><p>选择接口仅填入下方名称，参数 JSON 保留；核对后仍需主动调用。</p></div>
      <button type="button" class="secondary" :disabled="busy || state.loading" @click="emit('refresh')">{{ state.loading ? '正在读取…' : '刷新能力' }}</button>
    </div>
    <p v-if="state.loading" class="note" role="status">正在读取当前账号的会话能力…</p>
    <p v-else-if="state.error" class="inline-error" role="alert">{{ state.error }}。可刷新重试，也可在下方手动填写接口。</p>
    <template v-else-if="state.catalogue">
      <p class="note">QQ {{ state.catalogue.qq_version || '版本未知' }} · {{ state.catalogue.ready ? '会话已就绪' : '会话未就绪' }} · {{ availableCount }} 个接口当前可用。可用表示会话提供了所需方法；离线测试不代表已在此 QQ 客户端完成真实验证。</p>
      <p v-if="state.catalogue.runtime_profile" class="note">运行环境：{{ state.catalogue.runtime_profile.platform }} / {{ state.catalogue.runtime_profile.architecture }} · 配置 {{ state.catalogue.runtime_profile.profile_id }} · {{ state.catalogue.runtime_profile.admission }}。{{ state.catalogue.runtime_profile.native_eligible ? '精确程序摘要匹配，高阶本机通道仍需运行时检查。' : '未认证高阶本机通道。' }} 宿主系统与 QQ 所在运行环境分别记录。</p>
      <div class="capability-filters">
        <label>搜索接口<input v-model="query" type="search" placeholder="例如 get_group" /></label>
        <label>可用性<select v-model="filter"><option value="all">全部接口</option><option value="available">当前可用</option><option value="unavailable">当前不可用</option></select></label>
      </div>
      <div class="capability-list" aria-label="当前账号 OneBot 接口能力">
        <p v-if="!rows.length" class="note">没有符合筛选条件的接口。</p>
        <article v-for="item in rows" :key="item.kind + ':' + item.name" class="capability-row">
          <div class="capability-title"><code>{{ item.name }}</code><span class="capability-kind">{{ item.kind }}</span><button type="button" class="ghost" :disabled="busy" :aria-label="'填入接口 ' + item.name" @click="emit('select', item.name)">填入接口</button></div>
          <p class="capability-status"><span :class="{ available: item.available }">{{ availability(item) }}</span><span>{{ item.implemented ? '已实现' : '未实现' }} · {{ verification(item.verification) }}</span></p>
          <p v-if="item.runtime_verification" class="capability-detail">构建业务证据：{{ verification(item.runtime_verification) }}<template v-if="item.reason"> · 原因：{{ item.reason }}</template></p>
          <p v-if="item.variants" class="capability-detail">自定义文本/图片节点：{{ item.variants.custom_text_image_nodes ? '可用' : '不可用' }}；已有消息 ID 节点：{{ item.variants.existing_message_id_nodes ? '可用' : '不可用' }}。已有节点范围：{{ item.variants.existing_scope }}</p>
          <p v-if="item.target_validation" class="capability-detail">目标验证：QQ {{ item.target_validation.qq_version }} / {{ item.target_validation.platform }} / {{ item.target_validation.date }}。仅覆盖：{{ item.target_validation.scopes.join('、') }}；其他场景仍需验证。</p>
        </article>
      </div>
      <details class="capability-details">
        <summary>消息段、事件与实现边界</summary>
        <div class="capability-segments">
          <article v-for="item in [...state.catalogue.segments, ...state.catalogue.segment_extensions]" :key="item.name" class="capability-segment"><code>{{ item.name }}</code><span>发送 {{ item.send ? '可用' : '不可用' }} / 接收 {{ item.receive ? '可用' : '不可用' }}</span><small>{{ item.implemented ? '已实现' : '未实现' }} · {{ verification(item.verification) }}<template v-if="item.receive_scope"> · 接收范围：{{ item.receive_scope }}</template><template v-if="item.send_contexts"> · 发送场景：{{ item.send_contexts.join('、') }}</template><template v-if="item.receive_contexts"> · 接收场景：{{ item.receive_contexts.join('、') || '无' }}</template></small></article>
        </div>
        <p v-for="item in state.catalogue.events" :key="item.name" class="capability-detail">{{ item.name }}：{{ item.available ? '当前可用' : item.implemented ? '当前会话不可用' : '未实现' }} · {{ item.subtypes.join('、') }}</p>
        <p class="note">以下为服务端提供的原始实现说明，包含协议和验证范围：</p>
        <p v-for="(note, index) in state.catalogue.notes" :key="index" class="capability-detail">{{ note }}</p>
      </details>
    </template>
    <p v-else class="note">尚未读取当前账号能力，可点击刷新。</p>
  </div>
</template>

<style scoped>
.capability-browser{margin:20px 0;padding:18px;border:1px solid var(--line-soft);border-radius:var(--radius-md);background:var(--surface-1)}
.capability-browser h3{font-size:14px;font-weight:500}.capability-browser .section-heading p{font-size:12px;color:var(--muted);margin:6px 0 0;line-height:1.8}
.capability-filters{display:grid;grid-template-columns:minmax(0,1fr) 160px;gap:12px;margin:14px 0}.capability-filters label{margin:0}
.capability-list{max-height:360px;overflow:auto;border:1px solid var(--line-soft);border-radius:var(--radius-sm)}.capability-row{padding:12px 14px;border-bottom:1px solid var(--line-soft)}.capability-row:last-child{border-bottom:0}
.capability-title{display:flex;align-items:center;gap:10px}.capability-title code{overflow-wrap:anywhere;color:var(--text);font-size:12px}.capability-kind{color:var(--faint);font-size:11px;white-space:nowrap}.capability-title button{margin-left:auto;min-height:30px;padding:4px 10px;font-size:12px;flex-shrink:0}
.capability-status{display:flex;flex-wrap:wrap;gap:8px 16px;margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.8}.capability-status .available{color:var(--success)}
.capability-detail{margin:8px 0;color:var(--muted);font-size:12px;line-height:1.9;overflow-wrap:anywhere}.capability-details{margin-top:16px}.capability-details summary{cursor:pointer;font-size:13px;color:var(--text)}
.capability-segments{margin:14px 0}.capability-segment{display:grid;grid-template-columns:100px minmax(0,1fr);gap:5px 12px;padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:12px;color:var(--muted)}.capability-segment code{color:var(--text)}.capability-segment small{grid-column:1/-1;font-size:12px;line-height:1.8}
@media(max-width:760px){.capability-browser{padding:12px}.capability-filters{grid-template-columns:minmax(0,1fr)}.capability-title{flex-wrap:wrap;gap:6px}.capability-title code{flex-basis:100%}.capability-title button{margin-left:auto}.capability-segment{grid-template-columns:70px minmax(0,1fr)}}
</style>
