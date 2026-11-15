<script setup lang="ts">
import { computed } from 'vue';
import { stateLabel } from '../labels';

const props = defineProps<{ state: string; label?: string }>();
const text = computed(() => props.label || stateLabel(props.state));
</script>

<template>
  <span class="badge" :class="state">{{ text }}</span>
</template>
