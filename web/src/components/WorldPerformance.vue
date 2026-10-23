<script setup lang="ts">
import { computed } from 'vue';
import type { InstanceSummary } from '../lib/types.ts';
import { useWorldHistory } from '../lib/worlds.ts';
import PerformanceChart from './PerformanceChart.vue';
import Icon from './Icon.vue';

const props = defineProps<{ world: InstanceSummary }>();

const history = useWorldHistory(computed(() => props.world.id));
const running = computed(() => ['running', 'starting', 'stopping', 'stuck'].includes(props.world.status));
const hasData = computed(() => history.value.some((sample) => sample.cpu > 0 || sample.rss > 0 || sample.players > 0));

const cpuSeries = computed(() => history.value.map((sample) => Math.round(sample.cpu * 10) / 10));
const memSeries = computed(() => history.value.map((sample) => sample.rss / 1024 / 1024));
const playerSeries = computed(() => history.value.map((sample) => sample.players));

const cpuMax = computed(() => Math.max(100, ...cpuSeries.value.map((value) => Math.ceil(value))));
const memMax = computed(() => Math.max(props.world.memoryMb || 0, ...memSeries.value, 1));
const playerMax = computed(() => Math.max(props.world.maxPlayers || 0, ...playerSeries.value, 1));

const currentCpu = computed(() => (props.world.status === 'stopped' ? '—' : (props.world.cpu || 0).toFixed(0)));
const currentMem = computed(() => (props.world.status === 'stopped' ? '—' : (props.world.rss / 1024 / 1024).toFixed(0)));
const currentPlayers = computed(() => String(props.world.players || 0));
</script>

<template>
  <section class="card perf-panel">
    <div class="card-head">
      <h3>
        <span class="head-icon"><Icon name="cpu" :size="15" /></span>
        实时性能
      </h3>
      <div class="row gap-2 wrap">
        <span class="perf-live" :class="{ active: running }">
          <i aria-hidden="true" />
          {{ running ? '实时采样' : '世界未运行' }}
        </span>
        <span class="text-3 small">最近 2 分钟 · 每秒采样</span>
      </div>
    </div>
    <div class="card-body col gap-3">
      <div class="perf-wrap">
        <div class="perf-grid" :class="{ 'perf-dim': !running && !hasData }">
          <PerformanceChart
            title="CPU 使用率"
            :values="cpuSeries"
            :current="currentCpu"
            unit="%"
            :max="cpuMax"
            tone="accent"
            subtitle="单核百分比"
          />
          <PerformanceChart
            title="进程内存"
            :values="memSeries"
            :current="currentMem"
            unit="MB"
            :max="memMax"
            tone="info"
            :subtitle="`Xmx ${world.memoryMb} MB`"
          />
          <PerformanceChart
            title="在线玩家"
            :values="playerSeries"
            :current="currentPlayers"
            :unit="`/ ${world.maxPlayers}`"
            :max="playerMax"
            tone="ok"
            :subtitle="`上限 ${world.maxPlayers} 人`"
          />
        </div>
        <div v-if="!running && !hasData" class="perf-overlay">
          <span class="perf-overlay-icon"><Icon name="play" :size="17" /></span>
          <strong>世界未运行</strong>
          <p>启动后这里会每秒刷新 CPU、内存与在线人数曲线</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.perf-panel { min-width: 0; }
.perf-wrap { position: relative; }
.perf-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.perf-dim { opacity: 0.4; filter: saturate(0.7); transition: opacity 0.2s; }
.perf-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: color-mix(in srgb, var(--surface) 58%, transparent);
  color: var(--text-2);
  text-align: center;
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.perf-overlay-icon {
  display: grid;
  width: 34px;
  height: 34px;
  margin-bottom: 4px;
  place-items: center;
  border: 1px solid var(--accent-border);
  border-radius: 11px;
  background: var(--accent-soft);
  color: var(--accent);
}
.perf-overlay strong { font-size: 13px; font-weight: 650; color: var(--text); }
.perf-overlay p { margin: 0; color: var(--text-3); font-size: 11.5px; }
.perf-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
  font-size: 11px;
  white-space: nowrap;
}
.perf-live i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}
.perf-live.active { color: var(--ok-text); }
.perf-live.active i {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-soft);
  animation: pulse 1.8s ease-in-out infinite;
}
@media (max-width: 1100px) {
  .perf-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 780px) {
  .perf-grid { grid-template-columns: minmax(0, 1fr); }
  .perf-overlay p { max-width: 18rem; }
}
</style>
