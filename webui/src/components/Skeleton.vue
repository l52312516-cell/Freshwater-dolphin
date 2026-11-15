<script setup lang="ts">
withDefaults(defineProps<{ lines?: number }>(), { lines: 3 });
</script>

<template>
  <div class="skeleton-group" aria-hidden="true">
    <span v-for="line in lines" :key="line" class="skeleton" :style="{ width: 100 - (line - 1) * 12 + '%' }"></span>
  </div>
</template>
