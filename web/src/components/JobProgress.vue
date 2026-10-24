<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { api, subscribe } from '../lib/api.ts';
import type { Job } from '../lib/types.ts';
import Modal from './Modal.vue';
import { toast, toastError } from '../lib/toast.ts';

const props = defineProps<{ open: boolean; jobId: string | null }>();
const emit = defineEmits<{ close: []; background: [] }>();

const job = ref<Job | null>(null);
const logEl = ref<HTMLElement | null>(null);
const followLog = ref(true);
const cancelPending = ref(false);
const active = computed(() => job.value?.status === 'running' || job.value?.status === 'cancelling');
const canCancel = computed(() => ['create', 'import'].includes(job.value?.kind ?? '') && job.value?.status === 'running' && !cancelPending.value);
let off: (() => void) | null = null;

watch(
  () => [props.open, props.jobId],
  ([open, id]) => {
    off?.();
    off = null;
    job.value = null;
    cancelPending.value = false;
    followLog.value = true;
    if (!open || !id) return;
    off = subscribe<Job>(`/api/jobs/${id}/stream`, (data) => {
      job.value = data;
      if (data.status !== 'running') cancelPending.value = false;
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

function stageLabel(status: string): string {
  if (status === 'done') return '完成';
  if (status === 'running') return '进行中';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  return '等待';
}

const cancelLabel = computed(() => job.value?.kind === 'create' ? '取消创建' : '取消导入');

function scrollLogToBottom(): void {
  const el = logEl.value;
  if (el && followLog.value) el.scrollTop = el.scrollHeight;
}

function onLogScroll(event: Event): void {
  const el = event.currentTarget as HTMLElement;
  // 人为向上翻时先暂停；滚回底部（24px 容差）后自动恢复跟随。
  followLog.value = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
}

async function cancelJob(): Promise<void> {
  if (!job.value || !canCancel.value) return;
  const kind = job.value.kind;
  cancelPending.value = true;
  try {
    const result = await api.post<{ job: Job }>(`/api/jobs/${encodeURIComponent(job.value.id)}/cancel`);
    job.value = result.job;
    toast('ok', `已请求${kind === 'create' ? '取消创建' : '取消导入'}`, '正在停止当前下载或安装。已创建世界和已下载文件会保留，可以之后在总览中删除。');
  } catch (err) {
    cancelPending.value = false;
    toastError(err, `取消${kind === 'create' ? '创建' : '导入'}失败`);
  }
}
</script>

<template>
  <Modal v-if="open" :title="job?.title ?? '任务进度'" size="md" :closable="!active" @close="emit('close')">
    <div v-if="!job" class="job-progress-skeleton col gap-4" role="status" aria-label="正在连接任务" aria-busy="true">
      <div class="row gap-3">
        <span class="skeleton job-skeleton-badge" />
        <span class="skeleton job-skeleton-meter grow" />
      </div>
      <div class="col gap-2">
        <div v-for="slot in 5" :key="slot" class="row gap-3">
          <span class="skeleton job-skeleton-badge" />
          <span class="skeleton job-skeleton-stage grow" />
        </div>
      </div>
      <div class="job-skeleton-log" aria-hidden="true">
        <span v-for="slot in 8" :key="slot" class="skeleton job-skeleton-log-line" />
      </div>
    </div>
    <div v-else class="col gap-4">
      <div class="row gap-3">
        <span class="badge" :class="job.status === 'done' ? 'badge-ok' : job.status === 'failed' ? 'badge-danger' : job.status === 'cancelled' || job.status === 'interrupted' ? 'badge-outline' : 'badge-warn'">
          {{ job.status === 'done' ? '已完成' : job.status === 'failed' ? '失败' : job.status === 'cancelled' ? '已取消' : job.status === 'cancelling' ? '正在取消' : job.status === 'interrupted' ? '已中断' : '进行中' }}
        </span>
        <div class="grow meter"><div class="meter-fill" :style="{ width: job.progress + '%' }" /></div>
      </div>

      <div class="col gap-2">
        <div v-for="s in job.stages" :key="s.key" class="row gap-3">
          <span class="badge" :class="stageClass(s.status)">{{ stageLabel(s.status) }}</span>
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
      <div v-if="active" class="row gap-2">
        <button v-if="job?.kind === 'create' || job?.kind === 'import'" class="btn btn-danger" :disabled="!canCancel" @click="cancelJob">
          {{ job?.status === 'cancelling' || cancelPending ? '正在取消…' : cancelLabel }}
        </button>
        <button class="btn" @click="emit('background')">后台继续</button>
      </div>
      <button v-else class="btn" @click="emit('close')">关闭</button>
    </template>
  </Modal>
</template>

<style scoped>
.job-skeleton-badge { width: 74px; height: 25px; border-radius: 999px; }
.job-skeleton-meter { height: 10px; border-radius: 999px; }
.job-skeleton-stage { height: 14px; max-width: 72%; }
.job-skeleton-log { display: flex; height: 200px; flex-direction: column; gap: 10px; overflow: hidden; padding: 16px; border-radius: var(--r); background: var(--skeleton-base); }
.job-skeleton-log-line { display: block; height: 11px; flex: none; background: linear-gradient(100deg, color-mix(in srgb, var(--skeleton-highlight) 72%, var(--skeleton-base)) 25%, var(--skeleton-highlight) 48%, color-mix(in srgb, var(--skeleton-highlight) 72%, var(--skeleton-base)) 72%); background-size: 220% 100%; animation: sk 1.35s ease-in-out infinite; }
.job-skeleton-log-line:nth-child(3n + 1) { width: 91%; }
.job-skeleton-log-line:nth-child(3n + 2) { width: 74%; }
.job-skeleton-log-line:nth-child(3n) { width: 84%; }
@media (prefers-reduced-motion: reduce) { .job-skeleton-log-line { animation: none; background-position: 50% 50%; } }
</style>
