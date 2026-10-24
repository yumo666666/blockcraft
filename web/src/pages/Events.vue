<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../lib/api.ts';
import { toastError } from '../lib/toast.ts';
import { readBrowserSnapshot, writeBrowserSnapshot } from '../lib/browserSnapshot.ts';

defineOptions({ name: 'Events' });

/**
 * 事件总日志：所有世界的启动 / 就绪 / 关闭 / 崩溃都记在这里，按类型上不同颜色。
 * 只保留最近 200 行，超出的从上面挤掉（用户要求：与控制台一致，窗口内滚动）。
 */
const MAX_LINES = 200;
const POLL_MS = 5000;

interface PanelEvent {
  seq: number;
  ts: number;
  kind: 'start' | 'ready' | 'stop' | 'crash' | 'system';
  worldId: string | null;
  worldName: string | null;
  text: string;
}

const cachedEvents = readBrowserSnapshot<{ events: PanelEvent[] }>('events');
const events = ref<PanelEvent[]>(cachedEvents?.events ?? []);
const hasSnapshot = ref(Boolean(cachedEvents));
const loading = ref(!hasSnapshot.value);
const autoScroll = ref(true);
const boxEl = ref<HTMLElement | null>(null);
let timer: number | null = null;

const KIND_LABEL: Record<string, string> = {
  start: '启动',
  ready: '就绪',
  stop: '关闭',
  crash: '崩溃',
  system: '系统',
};

async function load(): Promise<void> {
  try {
    const r = await api.get<{ events: PanelEvent[] }>(`/api/events?limit=${MAX_LINES}`);
    // 只留最近 200 行
    events.value = (r.events ?? []).slice(-MAX_LINES);
    hasSnapshot.value = true;
    writeBrowserSnapshot('events', { events: events.value });
    if (autoScroll.value) {
      await nextTick();
      const el = boxEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    }
  } catch (err) {
    toastError(err, '读取事件日志失败');
  } finally {
    loading.value = false;
  }
}

/**
 * 事件时间。注意单位：事件里存的 ts 是**毫秒**（Date.now()），
 * 而 lib/format 的 fmtTime() 也是吃毫秒 —— 之前这里画蛇添足除了个 1000，
 * 结果整页时间戳变成了 1970 年（显示成 1-22 01:36）。
 * 日志里同一分钟可能有多个事件，所以这里带上秒。
 */
function fmtTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const empty = computed(() => (!loading.value || hasSnapshot.value) && events.value.length === 0);

onMounted(() => {
  void load();
  timer = window.setInterval(load, POLL_MS);
});
onUnmounted(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <div class="page col gap-4">
    <div class="row-between wrap gap-3">
      <div class="page-heading">
        <h1>事件日志</h1>
        <p>所有世界的启动 / 就绪 / 关闭 / 崩溃都记在这里，最多显示最近 {{ MAX_LINES }} 行</p>
      </div>
      <div class="row gap-2">
        <label class="switch">
          <input v-model="autoScroll" type="checkbox" />
          <span class="switch-track" />
          <span class="switch-text">自动滚动</span>
        </label>
        <button class="btn btn-sm" @click="load">刷新</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>全部事件</h2>
        <span class="text-3 small">{{ events.length }} 行 · 每 {{ POLL_MS / 1000 }} 秒自动刷新</span>
      </div>
      <div class="card-body">
        <div ref="boxEl" class="console event-log" :aria-busy="loading">
          <div v-if="loading && !hasSnapshot" class="event-skeleton-list" role="status" aria-label="正在读取事件日志">
            <div v-for="line in 14" :key="line" class="event-skeleton-row" aria-hidden="true">
              <span class="skeleton event-skeleton-time" />
              <span class="skeleton event-skeleton-kind" />
              <span class="skeleton event-skeleton-world" />
              <span class="skeleton event-skeleton-text" :class="`event-skeleton-text-${line % 3}`" />
            </div>
          </div>
          <div v-else-if="empty" class="console-empty">还没有事件。世界启动、关闭或崩溃时会记录在这里。</div>
          <div v-for="e in events" :key="e.seq" class="console-line" :class="`ev-${e.kind}`">
            <span class="ev-time">{{ fmtTs(e.ts) }}</span>
            <span class="ev-kind">{{ KIND_LABEL[e.kind] ?? e.kind }}</span>
            <span v-if="e.worldName" class="ev-world">{{ e.worldName }}</span>
            <span class="ev-text">{{ e.text }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.event-log {
  /* 与控制台一致的固定高度滚动窗口 */
  height: min(64vh, 620px);
  overflow-y: auto;
}
.event-skeleton-list { display: flex; flex-direction: column; gap: 10px; padding: 2px 0; }
.event-skeleton-row { display: flex; min-height: 14px; align-items: center; gap: 8px; }
.event-skeleton-time, .event-skeleton-kind, .event-skeleton-world, .event-skeleton-text { height: 10px; border-radius: 4px; }
.event-skeleton-time { width: 102px; flex: none; }
.event-skeleton-kind { width: 36px; flex: none; }
.event-skeleton-world { width: 76px; flex: none; }
.event-skeleton-text { width: min(58%, 480px); }
.event-skeleton-text-0 { width: min(72%, 620px); }
.event-skeleton-text-1 { width: min(42%, 360px); }
.ev-time { color: #7b8794; margin-right: 8px; }
.ev-kind {
  display: inline-block;
  min-width: 34px;
  margin-right: 8px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  text-align: center;
  background: rgba(255, 255, 255, 0.08);
}
.ev-world { color: #cbd5e1; font-weight: 600; margin-right: 8px; }
.ev-text { color: inherit; }

/* 类型 → 颜色（用户要求：不同事件用不同颜色） */
.console-line.ev-start .ev-text,
.console-line.ev-start .ev-kind { color: #6db3f2; }
.console-line.ev-ready .ev-text,
.console-line.ev-ready .ev-kind { color: #6ee7a8; }
.console-line.ev-stop .ev-text,
.console-line.ev-stop .ev-kind { color: #9aa5b1; }
.console-line.ev-crash .ev-text,
.console-line.ev-crash .ev-kind { color: #ff8f85; font-weight: 600; }
.console-line.ev-system .ev-text,
.console-line.ev-system .ev-kind { color: #c8b6ff; }
.console-line.ev-start .ev-world { color: #9ecbff; }
.console-line.ev-ready .ev-world { color: #a7f3c8; }
.console-line.ev-crash .ev-world { color: #ffb4ad; }
</style>
