<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';

const props = withDefaults(defineProps<{ open: boolean; title: string; message: string; requiredId?: string; confirmLabel?: string; danger?: boolean }>(), {});
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const titleId = useId(), messageId = useId();
const typed = ref('');
const label = computed(() => props.confirmLabel || (props.requiredId ? '永久删除此账号' : '确认执行一次'));
const ready = computed(() => !props.requiredId || typed.value === props.requiredId);

watch(
  () => props.open,
  async open => {
    if (open) {
      typed.value = '';
      await nextTick();
      if (!dialog.value?.open) dialog.value?.showModal();
    } else if (dialog.value?.open) {
      dialog.value.close();
    }
  },
  { immediate: true },
);

function cancel() {
  if (dialog.value?.open) dialog.value.close();
  emit('cancel');
}
</script>

<template>
  <dialog ref="dialog" class="confirm-dialog" :aria-labelledby="titleId" :aria-describedby="messageId" @cancel.prevent="cancel">
    <template v-if="open">
      <span class="eyebrow">CONFIRM OPERATION</span>
      <h2 :id="titleId">{{ title }}</h2>
      <p :id="messageId">{{ message }}</p>
      <label v-if="requiredId" class="delete-confirm">
        实例编号：<code>{{ requiredId }}</code>
        <input v-model="typed" autocomplete="off" spellcheck="false" placeholder="输入上方完整实例编号" />
      </label>
      <div class="button-row">
        <button type="button" class="secondary" @click="cancel">取消</button>
        <button type="button" :class="requiredId || danger ? 'danger' : 'primary'" :disabled="!ready" @click="emit('confirm')">{{ label }}</button>
      </div>
    </template>
  </dialog>
</template>
