import { ref } from 'vue';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

const toasts = ref<ToastItem[]>([]);
let seq = 0;

function dismiss(id: number) {
  toasts.value = toasts.value.filter(item => item.id !== id);
}

function clear() {
  toasts.value = [];
}

/** 成功与提示用 Toast 短暂展示；持久错误仍由页内 role="alert" 承担。 */
function push(message: string, tone: ToastTone = 'success', ttl = 3600) {
  const id = ++seq;
  toasts.value = [...toasts.value.slice(-3), { id, message, tone }];
  if (ttl > 0) setTimeout(() => dismiss(id), ttl);
  return id;
}

export function useToast() {
  return { toasts, push, dismiss, clear };
}
