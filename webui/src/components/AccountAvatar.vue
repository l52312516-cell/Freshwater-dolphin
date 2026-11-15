<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Account } from '../types';

const props = withDefaults(defineProps<{ account: Account; size?: 'small' | 'normal' }>(), { size: 'normal' });
const failed = ref(false);
const verifiedUin = computed(() => {
  const candidates = [props.account.health?.authorized === true ? props.account.health.selfId : undefined, props.account.boundUin];
  for (const candidate of candidates) {
    const text = candidate == null ? '' : String(candidate);
    if (/^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text))) return text;
  }
  return '';
});
const image = computed(() => verifiedUin.value ? '/api/accounts/' + encodeURIComponent(props.account.id) + '/avatar?v=' + encodeURIComponent(verifiedUin.value) : '');
const label = computed(() => props.account.label || verifiedUin.value || props.account.id);
const fallback = computed(() => label.value.slice(0, 1) || 'Q');
watch(image, () => { failed.value = false; });
</script>

<template>
  <span class="account-avatar" :class="size" :title="label"><img v-if="image && !failed" :key="image" :src="image" :alt="label + ' 的 QQ 头像'" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="failed = true" /><span v-else aria-hidden="true">{{ fallback }}</span><span class="avatar-accessible" v-if="!image || failed">{{ label }}的账号头像</span></span>
</template>

<style scoped>
.account-avatar{width:44px;height:44px;flex-shrink:0;position:relative;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;border-radius:var(--radius-md);color:var(--second);background:linear-gradient(135deg,var(--surface-3),var(--surface-2));border:1px solid var(--line-soft);box-shadow:var(--shadow-1);font-size:18px;font-weight:400;vertical-align:middle}.account-avatar img{width:100%;height:100%;object-fit:cover;display:block}.account-avatar.small{width:32px;height:32px;border-radius:50%;font-size: 14px}.avatar-accessible{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:760px){.account-avatar{width:41px;height:41px;border-radius:var(--radius-sm)}.account-avatar.small{width:32px;height:32px;border-radius:50%}}
</style>
