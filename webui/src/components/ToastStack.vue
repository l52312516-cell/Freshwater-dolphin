<script setup lang="ts">
import { useToast } from '../toast';
import Icon from './Icon.vue';

const { toasts, dismiss } = useToast();
</script>

<template>
  <div class="toast-stack" aria-live="polite">
    <div v-for="item in toasts" :key="item.id" class="toast" :class="item.tone" role="status">
      <Icon class="toast-icon" :name="item.tone === 'error' ? 'alert' : item.tone === 'info' ? 'info' : 'check'" :size="16" /><span>{{ item.message }}</span>
      <button class="toast-close" aria-label="关闭提示" @click="dismiss(item.id)"><Icon name="close" :size="14" /></button>
    </div>
  </div>
</template>
