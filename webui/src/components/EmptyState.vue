<script setup lang="ts">
import Icon from './Icon.vue';
import type { IconName } from './Icon.vue';

withDefaults(defineProps<{ icon?: IconName; title: string; description?: string }>(), { icon: 'box' });
</script>

<template>
  <div class="empty">
    <span class="empty-icon" aria-hidden="true"><Icon :name="icon" :size="30" :stroke="1.5" /></span>
    <h3>{{ title }}</h3>
    <p v-if="description">{{ description }}</p>
    <slot />
  </div>
</template>
