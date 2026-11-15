<script setup lang="ts">
withDefaults(defineProps<{ label: string; accept?: string; disabled?: boolean; hint?: string }>(), { disabled: false });
const emit = defineEmits<{ file: [file: File] }>();

function change(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) emit('file', file);
  input.value = '';
}
</script>

<template>
  <label class="upload-button">
    {{ label }}
    <input type="file" :accept="accept" :disabled="disabled" @change="change" />
    <small v-if="hint" class="upload-hint">{{ hint }}</small>
  </label>
</template>
