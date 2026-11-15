<script setup lang="ts">
import Icon from './Icon.vue';
import type { IconName } from './Icon.vue';

defineProps<{ items: { id: string; title: string; icon?: IconName }[]; modelValue: string }>();
defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <nav class="subnav" aria-label="设置分区">
    <span class="subnav-label">系统设置</span>
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      :class="{ active: modelValue === item.id }"
      :aria-current="modelValue === item.id ? 'page' : undefined"
      @click="$emit('update:modelValue', item.id)"
    >
      <span v-if="item.icon" class="nav-icon" aria-hidden="true"><Icon :name="item.icon" :size="16" /></span>{{ item.title }}
    </button>
  </nav>
</template>
