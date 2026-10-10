<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue';
import { subscribe } from '../lib/api.ts';
import type { Job } from '../lib/types.ts';
import Modal from './Modal.vue';

const props = defineProps<{ open: boolean; jobId: string | null }>();
const emit = defineEmits<{ close: []; background: [] }>();

const job = ref<Job | null>(null);
const logEl = ref<HTMLElement | null>(null);
const followLog = ref(true);
let off: (() => void) | null = null;

watch(
  () => [props.open, props.jobId],
  ([open, id]) => {
    off?.();
    off = null;
    job.value = null;
    followLog.value = true;
    if (!open || !id) return;
    off = subscribe<Job>(`/api/jobs/${id}/stream`, (data) => {
      job.value = data;
      void nextTick(scrollLogToBottom);
    });
  },
  { immediate: true },
);

onUnmounted(() => off?.());

function stageClass(status: string): string {
  if (status === 'done') return 'badge-ok';
  if (status === 'failed') return 'badge-danger';
  if (status === 'running') return 'badge-warn';
  return 'badge-outline';
}

function scrollLogToBottom(): void {
  const el = logEl.value;
  if (el && followLog.value) el.scrollTop = el.scrollHeight;
}

function onLogScroll(event: Event): void {
  const el = event.currentTarget as HTMLElement;
  // 人为向上翻时先暂停；滚回底部（24px 容差）后自动恢复跟随。
  followLog.value = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
}
</script>

<template>
  <Modal v-if="open" :title="job?.title ?? '任务进度'" size="md" :closable="job?.status !== 'running'" @close="emit('close')">
    <div v-if="!job" class="row gap-2"><span class="spinner" /> 连接任务…</div>
    <div v-else class="col gap-4">
      <div class="row gap-3">
        <span class="badge" :class="job.status === 'done' ? 'badge-ok' : job.status === 'failed' ? 'badge-danger' : 'badge-warn'">
          {{ job.status === 'done' ? '已完成' : job.status === 'failed' ? '失败' : job.status === 'interrupted' ? '已中断' : '进行中' }}
        </span>
        <div class="grow meter"><div class="meter-fill" :style="{ width: job.progress + '%' }" /></div>
      </div>

      <div class="col gap-2">
        <div v-for="s in job.stages" :key="s.key" class="row gap-3">
          <span class="badge" :class="stageClass(s.status)">{{ s.status === 'done' ? '完成' : s.status === 'running' ? '进行中' : s.status === 'failed' ? '失败' : '等待' }}</span>
          <span class="grow" style="font-size: 13px">{{ s.label }}</span>
        </div>
      </div>

      <div v-if="job.error" class="badge badge-danger">{{ job.error }}</div>

      <div ref="logEl" class="console" data-testid="job-log" style="height: 200px" @scroll="onLogScroll">
        <div v-for="(l, i) in job.lines" :key="i" class="console-line">{{ l }}</div>
        <div v-if="!job.lines.length" class="console-empty">暂无输出</div>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="job?.status === 'running' ? emit('background') : emit('close')">{{ job?.status === 'running' ? '后台继续' : '关闭' }}</button>
    </template>
  </Modal>
</template>
