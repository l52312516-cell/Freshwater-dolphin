<script setup lang="ts">
defineProps<{ title: string; hint?: string }>();
</script>

<template>
  <section class="section-card">
    <div class="section-card-title">
      <h3>{{ title }}</h3>
      <small v-if="hint">{{ hint }}</small>
    </div>
    <slot />
  </section>
</template>
