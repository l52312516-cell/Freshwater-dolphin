<script setup lang="ts">
import { useTheme } from '../theme';

const { theme, accents, setAccent } = useTheme();
const names: Record<string, string> = { tide: '潮汐青', moon: '月华金', nebula: '星云紫', abyss: '深潮蓝' };
</script>

<template>
  <div class="accent-picker" role="group" aria-label="强调色">
    <button
      v-for="accent in accents"
      :key="accent"
      type="button"
      class="accent-swatch"
      :class="[accent, { active: theme.accent === accent }]"
      :aria-pressed="theme.accent === accent"
      @click="setAccent(accent)"
    >
      <i aria-hidden="true"></i>{{ names[accent] }}
    </button>
  </div>
</template>
