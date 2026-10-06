import { reactive } from 'vue';

export interface Toast {
  id: number;
  type: 'ok' | 'warn' | 'error' | 'info';
  title: string;
  message?: string;
}

const state = reactive<{ items: Toast[] }>({ items: [] });
let seq = 0;

export function useToasts() {
  return state;
}

export function toast(type: Toast['type'], title: string, message?: string, ttl = 4200): void {
  const id = ++seq;
  state.items.push({ id, type, title, message });
  setTimeout(() => {
    const i = state.items.findIndex((t) => t.id === id);
    if (i >= 0) state.items.splice(i, 1);
  }, ttl);
}

export function toastError(err: unknown, fallback = '操作失败'): void {
  const message = err instanceof Error ? err.message : String(err);
  toast('error', fallback, message, 6000);
}
