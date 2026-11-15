<script setup lang="ts">
import { computed } from 'vue';
import AccountAvatar from '../components/AccountAvatar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import EmptyState from '../components/EmptyState.vue';
import { healthValue } from '../labels';
import type { Overview } from '../types';

const props = defineProps<{ overview: Overview; busy: boolean }>();
const emit = defineEmits<{ refresh: []; openAccounts: []; select: [id: string] }>();

const free = computed(() => props.overview.resources?.freeMemory || 0);
const total = computed(() => props.overview.resources?.totalMemory || 0);
const usedPercent = computed(() => {
  if (!total.value) return 0;
  return Math.min(100, Math.max(0, Math.round(((total.value - free.value) / total.value) * 100)));
});

function size(value = 0) {
  return value >= 1024 ** 3 ? (value / 1024 ** 3).toFixed(1) + ' GiB' : (value / 1024 ** 2).toFixed(1) + ' MiB';
}
</script>

<template>
  <div class="metrics">
    <div class="metric"><span>QQ 账号</span><strong>{{ overview.accounts.length }}</strong><p>当前同时运行上限 {{ overview.maxAccounts }} 个</p></div>
    <div class="metric"><span>接入会话就绪</span><strong>{{ overview.accounts.filter(item => item.health?.ready === true).length }}</strong><p>来自 QQ 的真实会话状态</p></div>
    <div class="metric"><span>QQ 在线</span><strong>{{ overview.accounts.filter(item => item.health?.online === true).length }}</strong><p>未确认的在线状态不计数</p></div>
    <div class="metric">
      <span>可用内存</span><strong>{{ size(free) }}</strong><p>总内存 {{ size(total) }} · 已用 {{ usedPercent }}%</p>
      <div class="meter" role="img" :aria-label="'内存已使用 ' + usedPercent + '%'" :title="'内存已使用 ' + usedPercent + '%'"><span :style="{ width: usedPercent + '%' }"></span></div>
    </div>
  </div>
  <section class="panel">
    <div class="section-heading">
      <div><h2>账号运行状态</h2><p>QQ 进程、会话、在线状态与连接分别确认。</p></div>
      <button class="text-button" @click="emit('openAccounts')">管理账号 →</button>
    </div>
    <div class="legend" aria-label="状态图例">
      <span><i class="ok" aria-hidden="true"></i>已确认</span>
      <span><i class="bad" aria-hidden="true"></i>未连接</span>
      <span><i class="unknown" aria-hidden="true"></i>未知（不冒充成功）</span>
    </div>
    <EmptyState v-if="!overview.accounts.length" icon="server" title="从第一个 QQ 账号开始" description="创建独立账号实例，再启动并打开官方 QQ 登录窗口。">
      <button class="primary" @click="emit('openAccounts')">添加账号</button>
    </EmptyState>
    <div v-else class="table-wrap">
      <table>
        <thead><tr><th>账号</th><th>运行状态</th><th>接入桥</th><th>会话就绪</th><th>QQ 在线</th><th>连接</th></tr></thead>
        <tbody>
          <tr v-for="item in overview.accounts" :key="item.id">
            <td><div class="overview-account"><AccountAvatar :account="item" size="small" /><button class="account-link" @click="emit('select', item.id)">{{ item.label || item.id }}<small>{{ item.expectedUin || '等待 QQ 确认身份' }}</small></button></div></td>
            <td><StatusBadge :state="item.state" /></td>
            <td>{{ healthValue(item, 'bridge') }}</td>
            <td>{{ healthValue(item, 'ready') }}</td>
            <td>{{ healthValue(item, 'online') }}</td>
            <td>{{ healthValue(item, 'connected') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <div class="note">单容器中的账号进程与状态相互隔离；宿主机内存耗尽仍可能影响整个容器。QQ 未确认的状态保留为“未知”。</div>
</template>
