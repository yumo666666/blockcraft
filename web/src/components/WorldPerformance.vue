<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { InstanceSummary } from '../lib/types.ts';
import { useWorldHistory, type WorldSample } from '../lib/worlds.ts';
import { fmtBytes } from '../lib/format.ts';
import PerformanceChart from './PerformanceChart.vue';
import Icon from './Icon.vue';

const props = defineProps<{ world: InstanceSummary }>();

const history = useWorldHistory(computed(() => props.world.id));
const running = computed(() => ['running', 'starting', 'stopping', 'stuck'].includes(props.world.status));
const latest = computed<WorldSample | undefined>(() => history.value[history.value.length - 1]);
function series(key: keyof WorldSample): (number | null)[] {
  return history.value.map((sample) => sample[key] as number | null);
}
function maxOf(values: (number | null)[], floor = 1): number {
  return Math.max(floor, ...values.filter((value): value is number => value !== null));
}
function shown(value: number | null | undefined, decimals = 0): string {
  return value == null ? '—' : value.toFixed(decimals);
}

const metrics = computed(() => [
  {
    key: 'cpu', title: 'CPU 使用率', values: series('cpu'),
    current: shown(latest.value?.cpu), unit: '%',
    max: maxOf(series('cpu'), 100), tone: 'accent' as const, subtitle: '服务端进程 · 单核 100%',
  },
  {
    key: 'memory', title: '进程内存', values: history.value.map((sample) => sample.rss === null ? null : sample.rss / 1024 / 1024),
    current: latest.value?.rss == null ? '—' : (latest.value.rss / 1024 / 1024).toFixed(0), unit: 'MB',
    max: Math.max(props.world.memoryMb || 0, maxOf(history.value.map((sample) => sample.rss === null ? null : sample.rss / 1024 / 1024))),
    tone: 'info' as const, subtitle: 'Java 进程驻留内存',
  },
  {
    key: 'players', title: '在线玩家', values: series('players'),
    current: latest.value?.players == null ? '—' : String(latest.value.players), unit: `/ ${props.world.maxPlayers}`,
    max: Math.max(props.world.maxPlayers || 0, maxOf(series('players'))),
    tone: 'ok' as const, subtitle: '状态协议实测',
  },
  {
    key: 'latency', title: '状态探测耗时', values: series('latency'),
    current: latest.value?.latency == null ? '—' : latest.value.latency.toFixed(0), unit: 'ms',
    max: maxOf(series('latency'), 50),
    tone: 'accent' as const, subtitle: '面板主机到游戏端口',
  },
  {
    key: 'threads', title: '进程线程数', values: series('threads'),
    current: latest.value?.threads == null ? '—' : String(latest.value.threads), unit: '个',
    max: maxOf(series('threads'), 20),
    tone: 'info' as const, subtitle: '服务端 Java 进程',
  },
  {
    key: 'storage', title: '实例目录占用', values: history.value.map((sample) => sample.storage === null ? null : sample.storage / 1024 / 1024),
    current: latest.value?.storage == null ? '—' : fmtBytes(latest.value.storage), unit: '',
    max: maxOf(history.value.map((sample) => sample.storage === null ? null : sample.storage / 1024 / 1024)),
    tone: 'ok' as const, subtitle: '目录大小约每分钟更新',
  },
  {
    key: 'tps', title: 'TPS', values: series('tps'), current: shown(latest.value?.tps, 1), unit: 'TPS',
    max: Math.max(20, maxOf(series('tps'))), tone: 'ok' as const, subtitle: '最近 5 秒 · 目标 20',
  },
  {
    key: 'msptMean', title: '平均 MSPT', values: series('msptMean'), current: shown(latest.value?.msptMean, 1), unit: 'ms',
    max: maxOf(series('msptMean'), 50), tone: 'accent' as const, subtitle: '最近 10 秒平均每刻耗时',
  },
  {
    key: 'msptP95', title: 'MSPT P95', values: series('msptP95'), current: shown(latest.value?.msptP95, 1), unit: 'ms',
    max: maxOf(series('msptP95'), 50), tone: 'accent' as const, subtitle: '最近 10 秒 · 第 95 百分位',
  },
  {
    key: 'msptPeak', title: 'MSPT 峰值', values: series('msptPeak'), current: shown(latest.value?.msptPeak, 1), unit: 'ms',
    max: maxOf(series('msptPeak'), 50), tone: 'accent' as const, subtitle: '最近 10 秒最长单刻',
  },
  {
    key: 'heapUsed', title: 'Java 堆内存', values: history.value.map((sample) => sample.heapUsed === null ? null : sample.heapUsed / 1024 / 1024),
    current: latest.value?.heapUsed == null ? '—' : (latest.value.heapUsed / 1024 / 1024).toFixed(0),
    unit: latest.value?.heapMax == null ? 'MB' : `/ ${(latest.value.heapMax / 1024 / 1024).toFixed(0)} MB`,
    max: latest.value?.heapMax == null ? maxOf(history.value.map((sample) => sample.heapUsed === null ? null : sample.heapUsed / 1024 / 1024)) : latest.value.heapMax / 1024 / 1024,
    limit: latest.value?.heapMax == null ? null : latest.value.heapMax / 1024 / 1024,
    tone: 'info' as const, subtitle: '已用 / 最大堆容量',
  },
  {
    key: 'gcCount', title: 'GC 次数', values: series('gcCount'), current: shown(latest.value?.gcCount), unit: '次/分',
    max: maxOf(series('gcCount'), 10), tone: 'info' as const, subtitle: '滚动 60 秒',
  },
  {
    key: 'gcPause', title: 'GC 停顿时间', values: series('gcPause'), current: shown(latest.value?.gcPause), unit: 'ms/分',
    max: maxOf(series('gcPause'), 100), tone: 'info' as const, subtitle: '滚动 60 秒累计',
  },
  {
    key: 'pingMedian', title: '玩家 Ping 中位数', values: series('pingMedian'), current: shown(latest.value?.pingMedian), unit: 'ms',
    max: maxOf(series('pingMedian'), 100), tone: 'accent' as const, subtitle: 'Spark · 最近 15 分钟',
  },
  {
    key: 'pingP95', title: '玩家 Ping P95', values: series('pingP95'), current: shown(latest.value?.pingP95), unit: 'ms',
    max: maxOf(series('pingP95'), 100), tone: 'accent' as const, subtitle: 'Spark · 最近 15 分钟',
  },
  {
    key: 'networkRx', title: '主机网络接收', values: history.value.map((sample) => sample.networkRx === null ? null : sample.networkRx / 1024 / 1024),
    current: latest.value?.networkRx == null ? '—' : (latest.value.networkRx / 1024 / 1024).toFixed(2), unit: 'MB/s',
    max: maxOf(history.value.map((sample) => sample.networkRx === null ? null : sample.networkRx / 1024 / 1024), 1), tone: 'ok' as const, subtitle: 'Spark / 系统网卡合计',
  },
  {
    key: 'networkTx', title: '主机网络发送', values: history.value.map((sample) => sample.networkTx === null ? null : sample.networkTx / 1024 / 1024),
    current: latest.value?.networkTx == null ? '—' : (latest.value.networkTx / 1024 / 1024).toFixed(2), unit: 'MB/s',
    max: maxOf(history.value.map((sample) => sample.networkTx === null ? null : sample.networkTx / 1024 / 1024), 1), tone: 'ok' as const, subtitle: 'Spark / 系统网卡合计',
  },
  {
    key: 'chunks', title: '已加载区块', values: series('chunks'), current: shown(latest.value?.chunks), unit: '个',
    max: maxOf(series('chunks'), 100), tone: 'info' as const, subtitle: 'Spark · 世界采样',
  },
  {
    key: 'entities', title: '已加载实体', values: series('entities'), current: shown(latest.value?.entities), unit: '个',
    max: maxOf(series('entities'), 100), tone: 'info' as const, subtitle: 'Spark · 世界采样',
  },
]);

const viewport = ref<HTMLElement | null>(null);
const viewportWidth = ref(0);
const position = ref(0);
const animate = ref(true);
let observer: ResizeObserver | null = null;
let wheelLockedUntil = 0;

const visibleCount = computed(() => viewportWidth.value < 620 ? 1 : viewportWidth.value < 980 ? 2 : 3);
const extendedMetrics = computed(() => {
  const count = visibleCount.value;
  const list = metrics.value;
  return [...list.slice(-count), ...list, ...list.slice(0, count)];
});
const cardWidth = computed(() => {
  const count = visibleCount.value;
  return Math.max(0, (viewportWidth.value - 10 * (count - 1)) / count);
});
const trackStyle = computed(() => ({
  gap: '10px',
  transform: `translate3d(-${position.value * (cardWidth.value + 10)}px, 0, 0)`,
}));

function positionStorageKey(): string {
  return `blockcraft.performance-strip.${props.world.id}`;
}

function storedMetricIndex(): number {
  try {
    const key = sessionStorage.getItem(positionStorageKey());
    const index = metrics.value.findIndex((metric) => metric.key === key);
    return index < 0 ? 0 : index;
  } catch {
    return 0;
  }
}

function restorePosition(count = visibleCount.value): void {
  position.value = count + storedMetricIndex();
}

function persistPosition(): void {
  const list = metrics.value;
  if (!list.length) return;
  const index = ((position.value - visibleCount.value) % list.length + list.length) % list.length;
  try {
    sessionStorage.setItem(positionStorageKey(), list[index].key);
  } catch {
    // The carousel still works when session storage is unavailable.
  }
}

function updateViewport(): void {
  viewportWidth.value = viewport.value?.clientWidth ?? 0;
}

function moveBy(amount: number): void {
  position.value += amount;
}

function normalizeLoop(): void {
  const count = metrics.value.length;
  if (position.value >= count + visibleCount.value) {
    animate.value = false;
    position.value = visibleCount.value;
    void nextTick(() => { requestAnimationFrame(() => { animate.value = true; }); });
  } else if (position.value < visibleCount.value) {
    animate.value = false;
    position.value = count + visibleCount.value - 1;
    void nextTick(() => { requestAnimationFrame(() => { animate.value = true; }); });
  }
}

function onWheel(event: WheelEvent): void {
  if (Math.abs(event.deltaY) < 2 && Math.abs(event.deltaX) < 2) return;
  event.preventDefault();
  const now = Date.now();
  if (now < wheelLockedUntil) return;
  wheelLockedUntil = now + 360;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  moveBy(delta > 0 ? 1 : -1);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    moveBy(1);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    moveBy(-1);
  }
}

watch(visibleCount, (count) => {
  animate.value = false;
  restorePosition(count);
  void nextTick(() => { requestAnimationFrame(() => { animate.value = true; }); });
});
watch(() => props.world.id, () => restorePosition());
watch(position, persistPosition);

onMounted(() => {
  updateViewport();
  restorePosition();
  if (viewport.value) {
    observer = new ResizeObserver(updateViewport);
    observer.observe(viewport.value);
  }
});
onUnmounted(() => observer?.disconnect());
</script>

<template>
  <section class="card perf-panel" aria-labelledby="world-performance-heading">
    <div class="card-head perf-headline">
      <h3 id="world-performance-heading">
        <span class="head-icon"><Icon name="cpu" :size="15" /></span>
        实时性能
      </h3>
      <div class="perf-head-tools">
        <span class="perf-live" :class="{ active: running }">
          <i aria-hidden="true" />{{ running ? '实时采样' : '动态指标已暂停' }}
        </span>
        <span class="text-3 small">近 6 分钟预览 · 每 5 秒记录</span>
        <div class="perf-arrows" aria-label="切换性能图表">
          <button class="btn btn-ghost perf-arrow" type="button" aria-label="上一个性能图" @click="moveBy(-1)">
            <Icon name="chevron-left" :size="17" />
          </button>
          <button class="btn btn-ghost perf-arrow" type="button" aria-label="下一个性能图" @click="moveBy(1)">
            <Icon name="chevron-right" :size="17" />
          </button>
        </div>
      </div>
    </div>
    <div class="card-body perf-body">
      <div
        ref="viewport"
        class="perf-viewport"
        role="region"
        aria-label="实时性能图表，可用鼠标滚轮或左右方向键横向切换，选择图表查看历史数据"
        aria-roledescription="carousel"
        tabindex="0"
        @wheel="onWheel"
        @keydown="onKeydown"
      >
        <div class="perf-track" :class="{ 'perf-track-animated': animate }" :style="trackStyle" @transitionend="normalizeLoop">
          <RouterLink
            v-for="(metric, index) in extendedMetrics"
            :key="`${metric.key}-${index}`"
            class="perf-link"
            :style="{ width: `${cardWidth}px` }"
            :to="`/w/${world.id}/performance/${metric.key}`"
            :aria-label="`${metric.title}，当前 ${metric.current} ${metric.unit}。点击查看此世界的历史数据`"
          >
            <PerformanceChart
              :title="metric.title"
              :values="metric.values"
              :current="metric.current"
              :unit="metric.unit"
              :max="metric.max"
              :limit="'limit' in metric ? metric.limit : null"
              :tone="metric.tone"
              :subtitle="metric.subtitle"
            />
          </RouterLink>
        </div>
      </div>
      <div class="perf-footnote">
        <span>滚动查看其他图表</span>
        <span>点击图表查看该世界此项指标的历史与说明</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.perf-panel { min-width: 0; }
.perf-headline { gap: 14px; }
.perf-head-tools { display: flex; align-items: center; gap: 12px; min-width: 0; }
.perf-live { display: inline-flex; align-items: center; gap: 7px; color: var(--text-3); font-size: 11px; white-space: nowrap; }
.perf-live i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); }
.perf-live.active { color: var(--ok-text); }
.perf-live.active i { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); animation: pulse 1.8s ease-in-out infinite; }
.perf-arrows { display: flex; align-items: center; gap: 2px; }
.perf-arrow { width: 32px; height: 32px; padding: 0; }
.perf-body { min-width: 0; }
.perf-viewport { overflow: hidden; min-width: 0; outline: none; border-radius: var(--r-sm); }
.perf-viewport:focus-visible { box-shadow: 0 0 0 3px var(--focus-ring); }
.perf-track { display: flex; align-items: stretch; width: max-content; }
.perf-track-animated { transition: transform 320ms var(--ease); }
.perf-link { display: block; flex: 0 0 auto; min-width: 0; color: inherit; text-decoration: none; border-radius: var(--r); }
.perf-link:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
.perf-link :deep(.perf-chart) { height: 100%; transition: border-color 160ms, background 160ms, transform 160ms; }
.perf-link:hover :deep(.perf-chart) { border-color: var(--border-strong); background: var(--surface-3); transform: translateY(-1px); }
.perf-footnote { display: flex; justify-content: space-between; gap: 12px; margin-top: 9px; color: var(--text-3); font-size: 10.5px; }
@media (max-width: 780px) {
  .perf-head-tools { gap: 8px; }
  .perf-head-tools > .small { display: none; }
  .perf-footnote { justify-content: center; }
  .perf-footnote span:first-child { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .perf-track-animated { transition: none; }
  .perf-live.active i { animation: none; }
}
</style>
