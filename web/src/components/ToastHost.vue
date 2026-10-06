<script setup lang="ts">
import { useToasts } from '../lib/toast.ts';
const state = useToasts();
</script>

<template>
  <div class="toasts">
    <div v-for="t in state.items" :key="t.id" class="toast" :class="`toast-${t.type}`">
      <div class="grow">
        <div class="toast-title">{{ t.title }}</div>
        <div v-if="t.message" class="toast-msg">{{ t.message }}</div>
      </div>
    </div>
  </div>
</template>
