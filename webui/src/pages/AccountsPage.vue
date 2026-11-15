<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import AccountAvatar from '../components/AccountAvatar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import RemoteLogin from '../components/RemoteLogin.vue';
import { canRecoverMaintenance, healthValue } from '../labels';
import type { Account } from '../types';

const props = defineProps<{ accounts: Account[]; selectedId: string; busy: boolean }>();
const emit = defineEmits<{
  create: [payload: { label: string; expectedUin: string; onCreated: () => void }];
  operation: [payload: { item: Account; operation: 'start' | 'stop' | 'restart' }];
  recover: [item: Account];
  bridge: [payload: { item: Account; operation: 'install' | 'uninstall' }];
  remove: [item: Account];
  select: [id: string];
}>();
const createForm = reactive({ label: '', expectedUin: '' });
const account = computed(() => props.accounts.find(value => value.id === props.selectedId));
const remoteLogin = ref<InstanceType<typeof RemoteLogin> | null>(null);
function create() {
  const label = createForm.label, expectedUin = createForm.expectedUin;
  emit('create', { label, expectedUin, onCreated() {
    if (createForm.label === label && createForm.expectedUin === expectedUin) {
      createForm.label = ''; createForm.expectedUin = '';
    }
  } });
}
defineExpose({ closeRemote: () => remoteLogin.value?.close() });
</script>

<template>
  <div class="account-grid">
    <section v-for="item in accounts" :key="item.id" class="panel account-card" :class="{ selected: selectedId === item.id }">
      <button type="button" class="account-card-title" :aria-pressed="selectedId === item.id" @click="emit('select', item.id)">
        <AccountAvatar :account="item" />
        <div><h2>{{ item.label || item.id }}</h2><p>{{ item.expectedUin || 'QQ 身份未确认' }}</p></div>
        <StatusBadge :state="item.state" />
      </button>
      <dl class="facts"><div><dt>实例编号</dt><dd>{{ item.id }}</dd></div><div><dt>会话 / QQ 在线</dt><dd>{{ healthValue(item, 'ready') }} / {{ healthValue(item, 'online') }}</dd></div></dl>
      <p class="bridge-state" :class="{ removed: item.bridgeInstalled === false }">{{ item.bridgeInstalled === false ? '注入桥已卸载 · OneBot 暂不可用' : '注入桥已安装' }}</p>
      <p v-if="item.error" class="inline-error">{{ item.error }}</p>
      <p v-if="item.maintenance && !canRecoverMaintenance(item)" class="note">该账号正在维护，暂不可启动。</p>
      <p v-if="canRecoverMaintenance(item)" class="note">{{ item.maintenance?.operation === 'delete' ? '删除中断，可确认后继续清理此账号。' : '请先停止账号，再恢复维护状态；恢复后不会自动启动。' }}</p>
      <div class="button-row">
        <button v-if="item.desired !== 'running'" class="primary" :disabled="busy || !!item.maintenance" @click="emit('operation', { item, operation: 'start' })">启动</button>
        <button v-else class="secondary" :disabled="busy" @click="emit('operation', { item, operation: 'stop' })">停止</button>
        <button class="secondary" :disabled="busy || !!item.maintenance" @click="emit('operation', { item, operation: 'restart' })">重启</button>
        <button v-if="canRecoverMaintenance(item)" class="secondary" :disabled="busy || item.desired !== 'stopped'" @click="emit('recover', item)">{{ item.maintenance?.operation === 'delete' ? '继续删除' : '恢复维护状态' }}</button>
        <button class="text-button" :disabled="busy" @click="emit('select', item.id)">远程登录 →</button>
      </div>
      <div class="account-maintenance">
        <button class="text-button" :disabled="busy || !!item.maintenance" @click="emit('bridge', { item, operation: item.bridgeInstalled === false ? 'install' : 'uninstall' })">{{ item.bridgeInstalled === false ? '安装注入桥' : '卸载注入桥' }}</button>
        <button class="text-button danger-text" :disabled="busy || !!item.maintenance" @click="emit('remove', item)">删除账号</button>
      </div>
    </section>
    <section class="panel add-account">
      <h2>添加账号</h2>
      <p>每个实例独立保存 QQ 登录状态、消息映射和节点配置。</p>
      <form @submit.prevent="create">
        <fieldset :disabled="busy || accounts.length >= 32">
          <label>账号备注<input v-model="createForm.label" placeholder="例如：日常机器人" maxlength="80" required /></label>
          <label>预期 QQ 号<input v-model="createForm.expectedUin" inputmode="numeric" pattern="[1-9][0-9]{4,19}" placeholder="登录后核对真实身份" required /></label>
          <button class="primary wide">创建账号实例</button>
        </fieldset>
      </form>
      <small v-if="accounts.length >= 32">已达到保存账号实例上限。</small>
    </section>
  </div>
  <RemoteLogin v-if="account" :key="account.id" ref="remoteLogin" :profile-id="account.id" :expected-uin="account.expectedUin" :label="account.label" :enabled="account.desired === 'running' && !account.maintenance" :ready="account.health?.ready === true && account.health?.authorized === true" />
</template>

<style scoped>
.add-account h2{font-size: 17px;margin-bottom:6px}.add-account p{font-size: 12px;line-height:1.8;margin-bottom:4px}.account-card-title{width:100%;padding:0;text-align:left;cursor:pointer;background:transparent;border:0}.account-card-title:hover h2{color:var(--accent)}.account-card-title>div{min-width:0;flex:1}
</style>
