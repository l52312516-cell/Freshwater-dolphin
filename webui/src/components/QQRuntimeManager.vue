<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../api';
import type { Account } from '../types';

interface RuntimePackage { packageId: string; profileId?: string; qqVersion?: string; packageSha256?: string; state?: string }
const props = defineProps<{ account: Account; disabled: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const packages = ref<RuntimePackage[]>([]), packageId = ref(''), experimental = ref(false), busy = ref(false);
const filename = ref(''), sha256 = ref(''), error = ref(''), result = ref(''), edited = ref(false), stale = ref(false);
let generation = 0;
async function refresh() {
  const current = ++generation;
  try {
    const value = await api<{ packages: RuntimePackage[] }>('/qq-runtimes');
    if (current === generation) packages.value = value.packages;
  } catch (value) { if (current === generation) error.value = value instanceof Error ? value.message : '版本列表读取失败'; }
}
watch(() => props.account.id, () => {
  generation++; packageId.value = props.account.qqRuntime?.packageId || ''; experimental.value = props.account.qqRuntime?.experimental === true;
  error.value = ''; result.value = ''; void refresh();
}, { immediate: true });
function reloadSelection() {
  packageId.value = props.account.qqRuntime?.packageId || ''; experimental.value = props.account.qqRuntime?.experimental === true;
  edited.value = false; stale.value = false;
}
watch(() => JSON.stringify(props.account.qqRuntime), () => {
  if (edited.value || busy.value) stale.value = true; else reloadSelection();
});
async function importPackage() {
  busy.value = true; error.value = ''; result.value = '';
  try {
    await api('/qq-runtimes/import', 'POST', { file: filename.value, expectedSha256: sha256.value.toLowerCase() });
    result.value = '安装包已校验并登记，尚未切换账号。'; await refresh();
  } catch (value) { error.value = value instanceof Error ? value.message : '安装包登记失败'; }
  finally { busy.value = false; }
}
async function switchRuntime() {
  if (stale.value) return;
  const candidate = packages.value.find(item => item.packageId === packageId.value);
  if (!candidate?.profileId) return;
  if (!window.confirm(`切换账号 ${props.account.label || props.account.id} 的 QQ 版本？将停止此账号、保存完整回滚状态；其他账号继续运行。未认证版本需启用实验兼容。`)) return;
  busy.value = true; error.value = ''; result.value = '';
  try {
    const value = await api<{ identityVerified: boolean }>('/accounts/' + encodeURIComponent(props.account.id) + '/runtime', 'POST', {
      packageId: candidate.packageId, profileId: candidate.profileId, experimental: experimental.value
    }, props.account.revision ? { 'If-Match': String(props.account.revision) } : {});
    edited.value = false; stale.value = false;
    result.value = value.identityVerified ? '版本切换完成，QQ 身份已确认。' : '版本已切换；启动并登录后确认 QQ 身份。'; emit('changed');
  } catch (value) { error.value = value instanceof Error ? value.message : '版本切换失败'; emit('changed'); }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="panel runtime-panel">
    <h2>QQ 运行版本</h2>
    <p>当前：{{ account.qqRuntime?.profileId || 'linux-x64-3.2.35-54395' }} · {{ account.qqRuntime?.experimental ? '实验兼容' : '稳定模式' }}</p>
    <p class="note">版本按账号选择。方法存在不代表已验证；升级失败将恢复此账号的程序、数据和配置。</p>
    <fieldset :disabled="disabled || busy || !!account.maintenance">
      <label>已登记的 Linux QQ 安装包
        <select v-model="packageId" @change="edited = true"><option value="">请选择安装包</option><option v-for="item in packages" :key="item.packageId" :value="item.packageId" :disabled="item.state === 'invalid'">{{ item.qqVersion || item.packageId }} · {{ item.packageId }}</option></select>
      </label>
      <label class="runtime-check"><input v-model="experimental" type="checkbox" @change="edited = true" />启用实验兼容（未认证构建仅开放基础功能）</label>
      <p v-if="stale" class="note">账号版本已在其他操作中改变，请先重新载入当前选择。</p>
      <div class="button-row"><button class="primary" :disabled="!packageId || stale" @click="switchRuntime">{{ busy ? '处理中…' : '切换此账号版本' }}</button><button v-if="stale" class="secondary" @click="reloadSelection">重新载入</button><button class="secondary" @click="refresh">刷新安装包</button></div>
      <details><summary>登记其他 Linux QQ 版本</summary>
        <p class="note">先将安装包放入运行环境的 work/qq-imports，再填写文件名和独立核对的 SHA256。此操作不会启动 QQ。</p>
        <form @submit.prevent="importPackage"><label>安装包文件名<input v-model="filename" placeholder="QQ.deb" pattern="[A-Za-z0-9][A-Za-z0-9_.-]*\.deb" required /></label><label>SHA256<input v-model="sha256" pattern="[A-Fa-f0-9]{64}" minlength="64" maxlength="64" required /></label><button class="secondary">校验并登记</button></form>
      </details>
    </fieldset>
    <p v-if="error" role="alert" class="inline-error">{{ error }}</p><p v-if="result" role="status" class="note">{{ result }}</p>
  </section>
</template>

<style scoped>
.runtime-panel{margin-top:16px}.runtime-panel h2{font-size:17px}.runtime-panel fieldset{display:grid;gap:12px;margin-top:12px}.runtime-check{display:flex;align-items:center;gap:8px}.runtime-check input{width:auto}.runtime-panel details{margin-top:8px}.runtime-panel form{display:grid;gap:10px;margin-top:10px}
</style>
