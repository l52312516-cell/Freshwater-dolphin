<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ profileId: string; kind: 'user' | 'group'; id: string; label: string }>();
const element = ref<HTMLElement | null>(null);
const visible = ref(false);
const loaded = ref(false);
const failed = ref(false);
let observer: IntersectionObserver | undefined;
const image = computed(() => props.profileId && /^[1-9]\d{0,15}$/.test(props.id) && Number.isSafeInteger(Number(props.id)) ?
  '/api/accounts/' + encodeURIComponent(props.profileId) + '/avatars/' + props.kind + '/' + encodeURIComponent(props.id) : '');
const fallback = computed(() => [...(props.label || '?')][0]);
function currentImage(event: Event) { return (event.target as HTMLImageElement).getAttribute('src') === image.value; }
function complete(event: Event) { if (currentImage(event)) loaded.value = true; }
function unavailable(event: Event) { if (currentImage(event)) { failed.value = true; loaded.value = false; } }
watch(image, () => { loaded.value = false; failed.value = false; });
onMounted(() => {
  if (!element.value || typeof IntersectionObserver === 'undefined') { visible.value = true; return; }
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) { visible.value = true; observer?.disconnect(); }
  }, { rootMargin: '120px' });
  observer.observe(element.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <span ref="element" class="avatar contact-avatar" :title="label" role="img" :aria-label="label + (kind === 'group' ? ' 的群头像' : ' 的 QQ 头像')">
    <span v-if="!loaded || failed" class="contact-avatar-fallback" aria-hidden="true">{{ fallback }}</span>
    <img v-if="visible && image && !failed" :key="image" :src="image" :class="{ loaded }" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" @load="complete" @error="unavailable" />
  </span>
</template>

<style scoped>
.contact-avatar{position:relative;overflow:hidden}.contact-avatar img{position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:cover;opacity:0}.contact-avatar img.loaded{opacity:1}.contact-avatar-fallback{line-height:1}
</style>
