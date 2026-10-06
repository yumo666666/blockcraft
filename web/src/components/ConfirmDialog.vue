<script setup lang="ts">
import { ref, watch } from 'vue';
import Modal from './Modal.vue';

const props = defineProps<{
  open: boolean;
  title: string;
  message: string;
  detail?: string;
  danger?: boolean;
  confirmText?: string;
  /** 需要用户手动输入某个词才能确认（用于删除世界这类不可逆操作） */
  requireText?: string;
  requireLabel?: string;
  busy?: boolean;
}>();
const emit = defineEmits<{ close: []; confirm: [] }>();
const typed = ref('');

watch(
  () => props.open,
  (v) => {
    if (v) typed.value = '';
  },
);

function canConfirm(): boolean {
  if (!props.requireText) return true;
  return typed.value.trim() === props.requireText;
}
</script>

<template>
  <Modal v-if="open" :title="title" size="sm" @close="emit('close')">
    <div class="col gap-3">
      <p style="white-space: pre-wrap">{{ message }}</p>
      <div v-if="detail" class="mono-block small">{{ detail }}</div>
      <div v-if="requireText" class="field">
        <label class="field-label">{{ requireLabel ?? `请输入「${requireText}」以确认` }}</label>
        <input v-model="typed" class="input mono" :placeholder="requireText" />
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button
        class="btn"
        :class="danger ? 'btn-danger-solid' : 'btn-primary'"
        :disabled="!canConfirm() || busy"
        @click="emit('confirm')"
      >
        <span v-if="busy" class="spinner" style="border-top-color: #fff" />
        {{ confirmText ?? '确定' }}
      </button>
    </template>
  </Modal>
</template>
