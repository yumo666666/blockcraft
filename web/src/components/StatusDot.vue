<script setup lang="ts">
import { statusClass, STATUS_TEXT } from '../lib/format.ts';
defineProps<{ status: string; label?: string }>();
</script>

<template>
  <span class="row gap-2" style="gap: 6px">
    <i class="dot" :class="statusClass(status)" />
    <span>{{ label ?? STATUS_TEXT[status] ?? status }}</span>
  </span>
</template>
