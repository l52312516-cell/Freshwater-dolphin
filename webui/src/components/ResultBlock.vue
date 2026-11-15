<script setup lang="ts">
import { computed, ref } from 'vue';

const props = withDefaults(defineProps<{ value: unknown; raw?: boolean; maxHeight?: string }>(), { raw: false });
const copied = ref(false);
const text = computed(() => {
  if (props.raw) return String(props.value ?? '');
  if (typeof props.value === 'string') return props.value;
  try {
    return JSON.stringify(props.value, null, 2);
  } catch {
    return String(props.value);
  }
});
const style = computed(() => (props.maxHeight ? { maxHeight: props.maxHeight } : undefined));

async function copy() {
  try {
    await navigator.clipboard.writeText(text.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1600);
  } catch {
    /* Clipboard can be unavailable on non-secure origins; keep the text visible. */
  }
}
</script>

<template>
  <div>
    <div class="result-actions">
      <button type="button" class="text-button" @click="copy">{{ copied ? '已复制' : '复制内容' }}</button>
    </div>
    <pre class="result" :style="style">{{ text }}</pre>
  </div>
</template>
