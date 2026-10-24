<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId } from 'vue';

const props = withDefaults(defineProps<{ title: string; size?: 'sm' | 'md' | 'lg'; closable?: boolean }>(), {
  closable: true,
});
const emit = defineEmits<{ close: [] }>();
const modalEl = ref<HTMLDivElement | null>(null);
const titleId = useId();
let previousFocus: HTMLElement | null = null;

function focusableElements(): HTMLElement[] {
  if (!modalEl.value) return [];
  return Array.from(
    modalEl.value.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.closable !== false) {
    e.preventDefault();
    emit('close');
    return;
  }
  if (e.key !== 'Tab' || !modalEl.value) return;

  const focusable = focusableElements();
  if (!focusable.length) {
    e.preventDefault();
    modalEl.value.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === modalEl.value || !modalEl.value.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !modalEl.value.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.addEventListener('keydown', onKey);
  void nextTick(() => {
    const focusable = focusableElements();
    const initialTarget = focusable.find((element) => !element.classList.contains('close-x')) ?? focusable[0] ?? modalEl.value;
    initialTarget?.focus({ preventScroll: true });
  });
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKey);
  if (previousFocus?.isConnected) void nextTick(() => previousFocus?.focus({ preventScroll: true }));
});
</script>

<template>
  <Teleport to="body">
    <div class="modal-mask" @click.self="closable !== false && emit('close')">
      <div
        ref="modalEl"
        class="modal"
        :class="`modal-${size ?? 'md'}`"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
      >
        <div class="modal-head">
          <h2 :id="titleId">{{ title }}</h2>
          <button v-if="closable !== false" type="button" class="close-x" aria-label="关闭" title="关闭" @click="emit('close')">×</button>
        </div>
        <div class="modal-body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="modal-foot">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
