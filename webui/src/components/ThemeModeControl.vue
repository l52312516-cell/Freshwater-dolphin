<script setup lang="ts">
import { useTheme } from '../theme';
import Icon from './Icon.vue';
import type { IconName } from './Icon.vue';

withDefaults(defineProps<{ labelled?: boolean }>(), { labelled: false });
const { theme, setMode } = useTheme();
const options: { id: 'light' | 'dark' | 'system'; icon: IconName; name: string }[] = [
  { id: 'light', icon: 'sun', name: '浅色模式' },
  { id: 'dark', icon: 'moon', name: '深色模式' },
  { id: 'system', icon: 'monitor', name: '跟随系统' },
];
</script>

<template>
  <div class="theme-control" :class="{ labelled }" role="group" aria-label="显示模式">
    <button
      v-for="option in options"
      :key="option.id"
      type="button"
      :class="{ active: theme.mode === option.id }"
      :aria-pressed="theme.mode === option.id"
      :aria-label="option.name"
      :title="option.name"
      @click="setMode(option.id)"
    >
      <Icon :name="option.icon" :size="labelled ? 15 : 16" /><span v-if="labelled">{{ option.name }}</span>
    </button>
  </div>
</template>
