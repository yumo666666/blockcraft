<script setup lang="ts">
import { computed } from 'vue';

let seq = 0;
const gradientId = `perf-grad-${++seq}`;
const W = 260;
const H = 76;
const ticks = [0.25, 0.5, 0.75];

const props = withDefaults(
  defineProps<{
    title: string;
    values: Array<number | null>;
    current: string;
    unit?: string;
    subtitle?: string;
    max?: number;
    limit?: number | null;
    tone?: 'accent' | 'ok' | 'info';
  }>(),
  { unit: '', subtitle: '', max: 0, limit: null, tone: 'accent' },
);

const validValues = computed(() => props.values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));
const peak = computed(() => Math.max(props.max || 0, ...validValues.value, 1));
const maxValue = computed(() => {
  const ceiling = Math.max(props.max || 0, props.limit || 0);
  if (ceiling > 0) return ceiling;
  return Math.max(1, Math.ceil(peak.value * 1.15));
});
const limitY = computed(() => typeof props.limit === 'number' && props.limit > 0
  ? H - Math.max(0, Math.min(1, props.limit / maxValue.value)) * H
  : null);

const segments = computed<[number, number][][]>(() => {
  const list = props.values;
  if (!list.length) return [];
  const step = list.length > 1 ? W / (list.length - 1) : W;
  const out: [number, number][][] = [];
  let segment: [number, number][] = [];
  list.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      if (segment.length) out.push(segment);
      segment = [];
      return;
    }
    segment.push([index * step, H - Math.max(0, Math.min(1, value / maxValue.value)) * H]);
  });
  if (segment.length) out.push(segment);
  return out;
});

const linePaths = computed(() => segments.value.map((segment) =>
  segment.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' '),
));
const areaPaths = computed(() => segments.value.filter((segment) => segment.length > 1).map((segment) => {
  const line = segment.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return `${line} L${segment[segment.length - 1][0].toFixed(1)} ${H} L${segment[0][0].toFixed(1)} ${H} Z`;
}));
const lastPoint = computed(() => segments.value[segments.value.length - 1]?.at(-1) ?? null);
const peakLabel = computed(() => {
  const value = maxValue.value;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
});
</script>

<template>
  <div class="perf-chart" :class="`perf-${props.tone}`">
    <div class="perf-head">
      <div class="perf-heading">
        <div class="perf-title">{{ title }}</div>
        <div v-if="subtitle" class="perf-sub">{{ subtitle }}</div>
      </div>
      <div class="perf-now">
        <strong>{{ current }}</strong>
        <span v-if="unit">{{ unit }}</span>
      </div>
    </div>

    <div class="perf-plot">
      <div class="perf-canvas">
        <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="`${title} 实时曲线`">
          <defs>
            <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="currentColor" stop-opacity="0.3" />
              <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
            </linearGradient>
          </defs>
          <line v-for="tick in ticks" :key="tick" x1="0" :x2="W" :y1="H * tick" :y2="H * tick" class="perf-grid" />
          <line v-if="limitY !== null" x1="0" :x2="W" :y1="limitY" :y2="limitY" class="perf-limit" />
          <path v-for="(path, index) in areaPaths" :key="`area-${index}`" :d="path" :fill="`url(#${gradientId})`" />
          <path v-for="(path, index) in linePaths" :key="`line-${index}`" :d="path" class="perf-line" />
          <circle v-if="lastPoint" :cx="lastPoint[0]" :cy="lastPoint[1]" r="2.6" class="perf-dot" />
        </svg>
        <span v-if="!validValues.length" class="perf-empty">暂无数据</span>
      </div>
      <div class="perf-axis" aria-hidden="true">
        <span>{{ peakLabel }}</span>
        <span>0</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.perf-chart {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 9px;
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--surface-2);
  color: var(--accent-text);
}
.perf-ok { color: var(--ok); }
.perf-info { color: var(--info); }

.perf-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.perf-heading { min-width: 0; }
.perf-title { color: var(--text-2); font-size: 12px; font-weight: 600; }
.perf-sub { margin-top: 1px; color: var(--text-3); font-size: 10px; }
.perf-now { flex: none; white-space: nowrap; }
.perf-now strong { color: var(--text); font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.perf-now span { margin-left: 2px; color: var(--text-3); font-size: 11px; }

.perf-plot { display: flex; gap: 8px; height: 76px; }
.perf-canvas { position: relative; flex: 1; min-width: 0; }
.perf-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-3); font-size: 10px; }
.perf-canvas svg { display: block; width: 100%; height: 100%; overflow: visible; }
.perf-axis {
  display: flex;
  width: 30px;
  flex: none;
  flex-direction: column;
  justify-content: space-between;
  padding: 1px 0 0;
  color: var(--text-3);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-align: left;
}
.perf-grid { stroke: var(--border); stroke-width: 1; stroke-dasharray: 3 4; opacity: 0.7; }
.perf-limit { stroke: var(--danger-text); stroke-width: 1.1; stroke-dasharray: 5 4; opacity: 0.78; vector-effect: non-scaling-stroke; }
.perf-line {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.perf-dot {
  fill: currentColor;
  stroke: var(--surface);
  stroke-width: 1.4;
  vector-effect: non-scaling-stroke;
}
</style>
