<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import { api } from '../lib/api.ts';
import { readBrowserSnapshot, writeBrowserSnapshot } from '../lib/browserSnapshot.ts';
import type { PerformanceMetric } from '../lib/types.ts';
import {
  PERFORMANCE_METRICS,
  formatMetricValue,
  performanceRangeBounds,
  type PerformanceHistoryResponse,
  type PerformanceRange,
} from '../lib/performance.ts';

defineOptions({ name: 'PerformanceDetail' });

const props = defineProps<{ id: string; metric: string }>();
const router = useRouter();
const ranges: { key: PerformanceRange; label: string }[] = [
  { key: '1h', label: '近 1 小时' },
  { key: '3h', label: '近 3 小时' },
  { key: 'today', label: '今天' },
  { key: '3d', label: '近 3 天' },
];
const selectedRange = ref<PerformanceRange>('1h');
const response = ref<PerformanceHistoryResponse | null>(null);
const hasSnapshot = ref(false);
const loading = ref(false);
const error = ref('');
const selectedIndex = ref<number | null>(null);
const chart = ref<HTMLElement | null>(null);
const pointerRatio = ref<number | null>(null);
let requestRevision = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const historyCacheWrites = new Map<string, number>();
let activeCacheKey = '';

function historyCacheKey(): string {
  return `performance:${props.id}:${props.metric}:${selectedRange.value}`;
}

const metric = computed(() => PERFORMANCE_METRICS[props.metric as PerformanceMetric] ?? null);
const points = computed(() => response.value?.points ?? []);
const numericPoints = computed(() => points.value.filter((point) => point.value !== null));
const latestPoint = computed(() => numericPoints.value[numericPoints.value.length - 1] ?? null);
const averageValue = computed(() => {
  const values = numericPoints.value.map((point) => point.value!);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
});
const highestValue = computed(() => {
  const values = numericPoints.value.map((point) => point.max ?? point.value!).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
});
const historyLimit = computed(() => {
  const limits = numericPoints.value.map((point) => point.limit).filter((value): value is number => value !== null);
  return limits.length ? Math.max(...limits) : null;
});

const plot = { left: 64, top: 22, width: 914, height: 252 };
const maxValue = computed(() => {
  const high = Math.max(
    highestValue.value ?? 0,
    historyLimit.value ?? 0,
    props.metric === 'players' ? response.value?.world.maxPlayers ?? 0 : 0,
  );
  if (high <= 1) return Math.max(1, high * 1.2);
  const roughStep = high / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  return Math.max(step * 4, step);
});
const chartPoints = computed(() => {
  const data = points.value;
  const rangeFrom = response.value?.from ?? 0;
  const rangeTo = response.value?.to ?? rangeFrom + 1;
  return data.map((point) => {
    const x = plot.left + ((point.t - rangeFrom) / Math.max(1, rangeTo - rangeFrom)) * plot.width;
    const value = point.value;
    return {
      ...point,
      x,
      y: value === null ? null : plot.top + plot.height - Math.max(0, Math.min(1, value / maxValue.value)) * plot.height,
      highY: point.max === null ? null : plot.top + plot.height - Math.max(0, Math.min(1, point.max / maxValue.value)) * plot.height,
      lowY: point.min === null ? null : plot.top + plot.height - Math.max(0, Math.min(1, point.min / maxValue.value)) * plot.height,
    };
  });
});
const linePaths = computed(() => {
  const output: string[] = [];
  let segment: { x: number; y: number }[] = [];
  for (const point of chartPoints.value) {
    if (point.y === null) {
      if (segment.length) output.push(segment.map((item, index) => `${index ? 'L' : 'M'}${item.x.toFixed(2)} ${item.y.toFixed(2)}`).join(' '));
      segment = [];
    } else segment.push({ x: point.x, y: point.y });
  }
  if (segment.length) output.push(segment.map((item, index) => `${index ? 'L' : 'M'}${item.x.toFixed(2)} ${item.y.toFixed(2)}`).join(' '));
  return output;
});
const limitPath = computed(() => {
  if (props.metric !== 'heapUsed') return '';
  const pointsWithLimit = chartPoints.value.filter((point) => point.limit !== null);
  return pointsWithLimit.map((point, index) => {
    const y = plot.top + plot.height - Math.max(0, Math.min(1, point.limit! / maxValue.value)) * plot.height;
    return `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
});
const rangePaths = computed(() => {
  const paths: string[] = [];
  let segment: typeof chartPoints.value = [];
  const flush = () => {
    if (segment.length > 1) {
      const upper = segment.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.highY!.toFixed(2)}`).join(' ');
      const lower = [...segment].reverse().map((point) => `L${point.x.toFixed(2)} ${point.lowY!.toFixed(2)}`).join(' ');
      paths.push(`${upper} ${lower} Z`);
    }
    segment = [];
  };
  for (const point of chartPoints.value) {
    if (point.highY === null || point.lowY === null) flush();
    else segment.push(point);
  }
  flush();
  return paths;
});
const yTicks = computed(() => [0, 1, 2, 3, 4].map((step) => ({
  y: plot.top + plot.height - (plot.height * step) / 4,
  label: axisValue((maxValue.value * step) / 4),
})));
const xTicks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
  const from = response.value?.from ?? Date.now();
  const to = response.value?.to ?? Date.now();
  const time = from + (to - from) * fraction;
  const date = new Date(time);
  const span = to - from;
  return {
    x: plot.left + plot.width * fraction,
    label: span > 24 * 60 * 60 * 1000
      ? `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:00`
      : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
  };
}));
const focusedPoint = computed(() => selectedIndex.value === null ? null : chartPoints.value[selectedIndex.value] ?? null);
const tooltipLeft = computed(() => focusedPoint.value ? `${Math.min(88, Math.max(12, (focusedPoint.value.x / 1000) * 100))}%` : '50%');

function axisValue(value: number): string {
  if (value >= 10_000) return `${(value / 1000).toFixed(0)}k`;
  const maximumFractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(value);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formattedPointValue(value: number | null, limit: number | null = null): string {
  const current = formatMetricValue(value, props.metric as PerformanceMetric, metric.value?.unit);
  if (props.metric !== 'heapUsed' || limit === null) return current;
  return `${current} / ${formatMetricValue(limit, 'heapUsed', 'MB')}`;
}

function pointTimeLabel(point: NonNullable<typeof focusedPoint.value>): string {
  return point.to - point.from > 1_000 ? `${formatTime(point.from)} — ${formatTime(point.to)}` : formatTime(point.t);
}

async function loadHistory(): Promise<void> {
  const definition = metric.value;
  if (!definition) return;
  const revision = ++requestRevision;
  const cacheKey = historyCacheKey();
  if (activeCacheKey !== cacheKey) {
    const cached = readBrowserSnapshot<PerformanceHistoryResponse>(cacheKey);
    if (cached && Array.isArray(cached.points)) {
      response.value = cached;
      hasSnapshot.value = true;
      selectedIndex.value = cached.points.length
        ? pointerRatio.value === null
          ? cached.points.length - 1
          : nearestPointIndex(cached.from + pointerRatio.value * (cached.to - cached.from), cached.points)
        : null;
    } else {
      response.value = null;
      hasSnapshot.value = false;
    }
    activeCacheKey = cacheKey;
  }
  const bounds = performanceRangeBounds(selectedRange.value);
  loading.value = true;
  error.value = '';
  try {
    const result = await api.get<PerformanceHistoryResponse>(
      `/api/instances/${encodeURIComponent(props.id)}/performance/${encodeURIComponent(props.metric)}?from=${bounds.from}&to=${bounds.to}`,
    );
    if (revision !== requestRevision) return;
    response.value = result;
    hasSnapshot.value = true;
    activeCacheKey = cacheKey;
    const lastWrite = historyCacheWrites.get(cacheKey) ?? 0;
    if (!lastWrite || Date.now() - lastWrite >= 30_000) {
      writeBrowserSnapshot(cacheKey, result);
      historyCacheWrites.set(cacheKey, Date.now());
    }
    selectedIndex.value = result.points.length
      ? pointerRatio.value === null
        ? result.points.length - 1
        : nearestPointIndex(result.from + pointerRatio.value * (result.to - result.from), result.points)
      : null;
  } catch (err) {
    if (revision !== requestRevision) return;
    error.value = err instanceof Error ? err.message : '读取历史数据失败';
    if (!hasSnapshot.value) response.value = null;
  } finally {
    if (revision === requestRevision) loading.value = false;
  }
}

function focusNearest(event: PointerEvent): void {
  if (!chart.value || !chartPoints.value.length || !response.value) return;
  const rect = chart.value.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  pointerRatio.value = ratio;
  const targetTime = response.value.from + ratio * (response.value.to - response.value.from);
  selectedIndex.value = nearestPointIndex(targetTime, chartPoints.value);
}

function nearestPointIndex(targetTime: number, points: { t: number }[]): number {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].t < targetTime) low = middle + 1;
    else high = middle;
  }
  const previous = Math.max(0, low - 1);
  return Math.abs(points[previous].t - targetTime) <= Math.abs(points[low].t - targetTime) ? previous : low;
}

function moveFocus(event: KeyboardEvent): void {
  if (!chartPoints.value.length) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const current = selectedIndex.value ?? chartPoints.value.length - 1;
  const offset = event.key === 'ArrowRight' ? 1 : -1;
  selectedIndex.value = Math.max(0, Math.min(chartPoints.value.length - 1, current + offset));
}

function backToWorld(): void {
  void router.push(`/w/${encodeURIComponent(props.id)}`);
}

watch(() => [props.id, props.metric, selectedRange.value], () => {
  void loadHistory();
}, { immediate: true });

onMounted(() => {
  // Keep the first request alive: when disk reads take longer than one poll
  // interval, overlapping requests used to supersede each other indefinitely.
  refreshTimer = setInterval(() => {
    if (!loading.value) void loadHistory();
  }, 5_000);
});
onUnmounted(() => {
  requestRevision += 1;
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <div class="page performance-detail-page col gap-4">
    <header class="page-title-row perf-detail-title">
      <button class="btn btn-ghost perf-back" type="button" @click="backToWorld">
        <Icon name="chevron-left" :size="17" />
        返回世界
      </button>
      <div class="page-heading">
        <h1>{{ response?.world.name || '世界' }} · {{ metric?.title || '实时性能' }}</h1>
        <p>{{ metric?.description || '这个性能项不存在，或当前世界不支持。' }}</p>
      </div>
    </header>

    <section v-if="metric" class="card performance-history-card" :aria-label="`${metric.title}历史数据`">
      <div class="card-head perf-history-head">
        <div class="perf-history-name">
          <span class="head-icon"><Icon name="cpu" :size="15" /></span>
          <div>
            <h2>{{ metric.title }}历史</h2>
            <span class="text-3 small">数据来源：{{ response?.metric.source || metric.source }}</span>
          </div>
        </div>
        <div class="perf-range" role="group" aria-label="选择历史时间范围">
          <button
            v-for="range in ranges"
            :key="range.key"
            class="btn btn-ghost perf-range-button"
            :class="{ active: selectedRange === range.key }"
            type="button"
            :aria-pressed="selectedRange === range.key"
            @click="selectedRange = range.key"
          >{{ range.label }}</button>
        </div>
      </div>
      <div class="card-body col gap-4">
        <div class="perf-summary-row">
          <div class="perf-summary-value">
            <span>最新采样</span>
            <span v-if="loading && !hasSnapshot" class="skeleton perf-summary-value-skeleton" aria-hidden="true" />
            <strong v-else>{{ formattedPointValue(latestPoint?.value ?? null, latestPoint?.limit ?? null) }}</strong>
          </div>
          <div class="perf-summary-value">
            <span>区间平均</span>
            <span v-if="loading && !hasSnapshot" class="skeleton perf-summary-value-skeleton" aria-hidden="true" />
            <strong v-else>{{ formattedPointValue(averageValue, latestPoint?.limit ?? null) }}</strong>
          </div>
          <div class="perf-summary-value">
            <span>区间峰值</span>
            <span v-if="loading && !hasSnapshot" class="skeleton perf-summary-value-skeleton" aria-hidden="true" />
            <strong v-else>{{ formattedPointValue(highestValue, latestPoint?.limit ?? null) }}</strong>
          </div>
          <div class="perf-summary-value perf-summary-note">
            <span>有效采样点</span>
            <span v-if="loading && !hasSnapshot" class="skeleton perf-summary-value-skeleton perf-summary-count-skeleton" aria-hidden="true" />
            <strong v-else>{{ numericPoints.length.toLocaleString() }} <small>个</small></strong>
          </div>
        </div>

        <div v-if="error && !hasSnapshot" class="perf-history-message perf-history-error" role="alert">{{ error }}</div>
        <div v-else-if="loading && !hasSnapshot" class="perf-history-chart perf-history-chart-skeleton" role="status" aria-label="正在读取历史数据" aria-busy="true">
          <span v-for="line in 5" :key="line" class="perf-chart-skeleton-gridline" :style="{ top: `${line * 18}%` }" aria-hidden="true" />
          <span class="skeleton perf-chart-skeleton-trend" aria-hidden="true" />
          <span class="skeleton perf-chart-skeleton-point" aria-hidden="true" />
        </div>
        <div v-else-if="!numericPoints.length" class="perf-history-message perf-history-empty">
          <Icon name="info" :size="18" />
          <span>这段时间没有有效采样。世界未运行、服务端状态查询不可用，或性能历史刚开始采集时都会出现这种情况。</span>
        </div>

        <div
          v-else
          ref="chart"
          class="perf-history-chart"
          role="img"
          :aria-label="`${metric.title}趋势图，当前显示 ${ranges.find((range) => range.key === selectedRange)?.label}`"
          tabindex="0"
          @pointermove="focusNearest"
          @pointerleave="pointerRatio = null; selectedIndex = null"
          @keydown="moveFocus"
        >
          <svg viewBox="0 0 1000 330" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="history-gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="currentColor" stop-opacity="0.22" />
                <stop offset="100%" stop-color="currentColor" stop-opacity="0.01" />
              </linearGradient>
            </defs>
            <g v-for="tick in yTicks" :key="`y-${tick.y}`">
              <line :x1="plot.left" :x2="plot.left + plot.width" :y1="tick.y" :y2="tick.y" class="history-grid-line" />
              <text x="52" :y="tick.y + 4" class="history-axis-label" text-anchor="end">{{ tick.label }}</text>
            </g>
            <line :x1="plot.left" :x2="plot.left + plot.width" :y1="plot.top + plot.height" :y2="plot.top + plot.height" class="history-axis-line" />
            <g v-for="tick in xTicks" :key="`x-${tick.x}`">
              <line :x1="tick.x" :x2="tick.x" :y1="plot.top" :y2="plot.top + plot.height" class="history-grid-line history-grid-vertical" />
              <text :x="tick.x" y="308" class="history-axis-label" :text-anchor="tick.x === plot.left ? 'start' : tick.x === plot.left + plot.width ? 'end' : 'middle'">{{ tick.label }}</text>
            </g>
            <path v-for="(area, index) in rangePaths" :key="`range-${index}`" :d="area" class="history-range-area" />
            <path v-if="limitPath" :d="limitPath" class="history-limit-line" />
            <path v-for="(line, index) in linePaths" :key="`line-${index}`" :d="line" class="history-line" />
            <line
              v-if="focusedPoint"
              :x1="focusedPoint.x"
              :x2="focusedPoint.x"
              :y1="plot.top"
              :y2="plot.top + plot.height"
              class="history-crosshair"
            />
            <circle v-if="focusedPoint?.y !== null && focusedPoint?.y !== undefined" :cx="focusedPoint.x" :cy="focusedPoint.y" r="4.5" class="history-focus-dot" />
          </svg>
          <div v-if="focusedPoint" class="history-tooltip" :style="{ left: tooltipLeft }">
            <time>{{ pointTimeLabel(focusedPoint) }}</time>
            <strong>{{ formattedPointValue(focusedPoint.value, focusedPoint.limit) }}</strong>
            <span v-if="focusedPoint.min !== null && focusedPoint.max !== null && focusedPoint.max !== focusedPoint.min">
              该区间 {{ formatMetricValue(focusedPoint.min, props.metric as PerformanceMetric, metric.unit) }} – {{ formatMetricValue(focusedPoint.max, props.metric as PerformanceMetric, metric.unit) }}
            </span>
          </div>
        </div>

        <footer class="perf-history-footer">
          <span>采样间隔 {{ Math.round((response?.sampleIntervalMs ?? 5_000) / 1000) }} 秒 · 历史数据最多保留 3 天</span>
          <span v-if="points.length > (response?.maxPoints ?? 2200)">长时间范围按时间段聚合；悬停可查看区间均值、最低值和最高值</span>
          <span v-else>悬停或使用方向键查看对应时间的采样值</span>
        </footer>
      </div>
    </section>

    <section v-else class="card perf-history-message perf-history-empty">
      <Icon name="info" :size="18" />
      <span>没有这个性能项。请从所属世界的实时性能图表进入。</span>
      <button class="btn btn-secondary" type="button" @click="backToWorld">返回世界</button>
    </section>
  </div>
</template>

<style scoped>
.performance-detail-page { min-width: 0; }
.perf-detail-title { align-items: flex-start; }
.perf-back { flex: none; margin-top: 1px; padding-inline: 9px; }
.perf-detail-title .page-heading { min-width: 0; }
.perf-detail-title h1 { font-size: 22px; }
.performance-history-card { min-width: 0; }
.perf-history-head { align-items: center; gap: 16px; }
.perf-history-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.perf-history-name h2 { font-size: 14px; font-weight: 650; }
.perf-history-name .small { display: block; margin-top: 3px; }
.perf-range { display: flex; gap: 4px; padding: 3px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface-2); }
.perf-range-button { min-height: 30px; padding: 5px 10px; border-color: transparent; font-size: 11px; white-space: nowrap; }
.perf-range-button.active { border-color: var(--accent-border); background: var(--surface-strong); color: var(--accent-text); box-shadow: var(--sh-1); }
.perf-summary-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.perf-summary-value { display: flex; min-width: 0; flex-direction: column; gap: 5px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); }
.perf-summary-value > span { color: var(--text-3); font-size: 11px; }
.perf-summary-value strong { overflow: hidden; color: var(--text); font-size: 17px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.perf-summary-value .perf-summary-value-skeleton { width: 84px; height: 20px; border-radius: 5px; }
.perf-summary-value .perf-summary-count-skeleton { width: 58px; }
.perf-summary-value small { color: var(--text-3); font-size: 11px; font-weight: 500; }
.perf-summary-note strong { font-size: 16px; }
.perf-history-chart { position: relative; min-width: 0; height: clamp(250px, 34vw, 390px); border: 1px solid var(--border); border-radius: var(--r); background: var(--surface-2); color: var(--accent-text); outline: none; touch-action: pan-y; }
.perf-history-chart-skeleton { overflow: hidden; background-color: var(--surface-2); }
.perf-chart-skeleton-gridline { position: absolute; right: 14px; left: 58px; height: 0; border-top: 1px dashed var(--border); }
.perf-chart-skeleton-trend { position: absolute; top: 48%; right: 8%; left: 8%; height: 3px; border-radius: 999px; transform: rotate(-2deg); transform-origin: left center; }
.perf-chart-skeleton-point { position: absolute; top: 44%; right: 7.5%; width: 10px; height: 10px; border-radius: 50%; }
.perf-history-chart:focus-visible { box-shadow: 0 0 0 3px var(--focus-ring); }
.perf-history-chart svg { display: block; width: 100%; height: 100%; overflow: visible; }
.history-grid-line { stroke: var(--border); stroke-width: 1; stroke-dasharray: 4 6; opacity: 0.8; }
.history-grid-vertical { opacity: 0.35; }
.history-axis-line { stroke: var(--border-strong); stroke-width: 1; }
.history-axis-label { fill: var(--text-3); font-size: 11px; font-family: var(--font); }
.history-range-area { fill: currentColor; opacity: 0.11; }
.history-line { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.history-limit-line { fill: none; stroke: var(--danger-text); stroke-width: 1.3; stroke-dasharray: 6 5; opacity: 0.82; vector-effect: non-scaling-stroke; }
.history-crosshair { stroke: var(--text-2); stroke-width: 1; stroke-dasharray: 3 4; opacity: 0.75; vector-effect: non-scaling-stroke; }
.history-focus-dot { fill: currentColor; stroke: var(--surface-solid); stroke-width: 2; vector-effect: non-scaling-stroke; }
.history-tooltip { position: absolute; top: 10px; z-index: 1; display: flex; max-width: min(280px, 80%); flex-direction: column; gap: 3px; padding: 9px 11px; transform: translateX(-50%); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--surface-solid); box-shadow: var(--sh-2); color: var(--text); pointer-events: none; font-size: 11px; font-variant-numeric: tabular-nums; }
.history-tooltip time { color: var(--text-3); }
.history-tooltip strong { font-size: 14px; }
.history-tooltip span { color: var(--text-2); }
.perf-history-message { display: flex; min-height: 180px; align-items: center; justify-content: center; gap: 10px; padding: 24px; color: var(--text-2); text-align: center; }
.perf-history-error { color: var(--danger-text); }
.perf-history-empty { flex-wrap: wrap; }
.perf-history-footer { display: flex; justify-content: space-between; gap: 14px; color: var(--text-3); font-size: 10.5px; line-height: 1.5; }
@media (max-width: 780px) {
  .perf-detail-title { flex-direction: column; gap: 7px; }
  .perf-back { margin-left: -9px; }
  .perf-detail-title h1 { font-size: 19px; }
  .perf-history-head { align-items: flex-start; flex-direction: column; }
  .perf-range { max-width: 100%; overflow-x: auto; }
  .perf-range-button { padding-inline: 8px; }
  .perf-summary-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .perf-history-chart { height: 270px; }
  .perf-history-footer { flex-direction: column; gap: 4px; }
}
@media (prefers-reduced-motion: reduce) {
  .perf-history-chart { scroll-behavior: auto; }
}
</style>
