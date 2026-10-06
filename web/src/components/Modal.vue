<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';

const props = defineProps<{ title: string; size?: 'sm' | 'md' | 'lg'; closable?: boolean }>();
const emit = defineEmits<{ close: [] }>();

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.closable !== false) emit('close');
}
onMounted(() => document.addEventListener('keydown', onKey));
onUnmounted(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="modal-mask" @click.self="closable !== false && emit('close')">
    <div class="modal" :class="`modal-${size ?? 'md'}`">
      <div class="modal-head">
        <h2>{{ title }}</h2>
        <button v-if="closable !== false" class="close-x" title="关闭" @click="emit('close')">×</button>
      </div>
      <div class="modal-body">
        <slot />
      </div>
      <div v-if="$slots.footer" class="modal-foot">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>
