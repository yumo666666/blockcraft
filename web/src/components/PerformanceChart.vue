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
    values: number[];
    current: string;
    unit?: string;
    subtitle?: string;
    max?: number;
    tone?: 'accent' | 'ok' | 'info';
  }>(),
  { unit: '', subtitle: '', max: 0, tone: 'accent' },
);

const peak = computed(() => Math.max(props.max || 0, ...props.values, 1));
const maxValue = computed(() => {
  if (props.max && props.max > 0) return props.max;
  return Math.max(1, Math.ceil(peak.value * 1.15));
});

const points = computed<[number, number][]>(() => {
  const list = props.values;
  if (!list.length) return [];
  const step = list.length > 1 ? W / (list.length - 1) : W;
  return list.map((value, index) => [
    index * step,
    H - Math.max(0, Math.min(1, value / maxValue.value)) * H,
  ]);
});

const linePath = computed(() =>
  points.value.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' '),
);

const areaPath = computed(() => {
  if (!points.value.length) return '';
  const startX = points.value[0][0];
  return `${linePath.value} L${W} ${H} L${startX} ${H} Z`;
});

const lastPoint = computed(() => points.value[points.value.length - 1] ?? null);
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
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="`${title} 实时曲线`">
        <defs>
          <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="currentColor" stop-opacity="0.3" />
            <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
          </linearGradient>
        </defs>
        <line v-for="tick in ticks" :key="tick" x1="0" :x2="W" :y1="H * tick" :y2="H * tick" class="perf-grid" />
        <path v-if="areaPath" :d="areaPath" :fill="`url(#${gradientId})`" />
        <path v-if="linePath" :d="linePath" class="perf-line" />
        <circle v-if="lastPoint" :cx="lastPoint[0]" :cy="lastPoint[1]" r="2.6" class="perf-dot" />
      </svg>
      <span class="perf-max">{{ peakLabel }}</span>
      <span class="perf-zero">0</span>
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
  color: var(--accent);
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

.perf-plot { position: relative; height: 76px; }
.perf-plot svg { display: block; width: 100%; height: 100%; overflow: visible; }
.perf-grid { stroke: var(--border); stroke-width: 1; stroke-dasharray: 3 4; opacity: 0.7; }
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
.perf-max, .perf-zero {
  position: absolute;
  right: 0;
  color: var(--text-3);
  font-size: 9px;
  line-height: 1;
  pointer-events: none;
}
.perf-max { top: -2px; }
.perf-zero { bottom: 0; }
</style>
