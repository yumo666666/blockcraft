<script setup lang="ts">
import { computed } from 'vue';
import type { InstanceSummary, SystemSnapshot } from '../lib/types.ts';
import { fmtBytes, fmtDuration, statusClass } from '../lib/format.ts';

const props = defineProps<{ snap: SystemSnapshot | null; instances: InstanceSummary[] }>();

const memPct = computed(() => {
  if (!props.snap) return 0;
  const m = props.snap.memory;
  return m.totalMb ? Math.min(100, Math.round((m.usedMb / m.totalMb) * 100)) : 0;
});
const diskPct = computed(() => {
  if (!props.snap) return 0;
  const d = props.snap.disk;
  return d.totalGb ? Math.min(100, Math.round((d.usedGb / d.totalGb) * 100)) : 0;
});
const memClass = computed(() => (memPct.value > 88 ? 'danger' : memPct.value > 72 ? 'warn' : ''));
const diskClass = computed(() => (diskPct.value > 92 ? 'danger' : diskPct.value > 82 ? 'warn' : ''));
const cpuPct = computed(() => props.snap?.cpuPercent ?? 0);
const cpuClass = computed(() => (cpuPct.value > 88 ? 'danger' : cpuPct.value > 72 ? 'warn' : ''));
const running = computed(() => props.instances.filter((i) => i.status === 'running' || i.status === 'starting' || i.status === 'stopping'));
const activeList = computed(() => props.instances.filter((i) => i.status !== 'stopped').slice(0, 4));
</script>

<template>
  <div class="card monitor-card">
    <div class="card-head">
      <h3>资源监控</h3>
      <span class="text-3 small">{{ running.length }} 个世界在跑 / 共 {{ instances.length }} 个</span>
    </div>
    <div class="card-body col gap-4">
      <!-- 主机 -->
      <div class="monitor-section">
        <div class="monitor-label">主机资源</div>
        <div class="monitor-grid">
          <div class="stat">
            <span class="stat-label">主机</span>
            <span class="stat-value ellipsis">{{ snap?.hostname ?? '—' }}</span>
            <span class="text-3 small">{{ snap ? `${snap.platform} / ${snap.arch}` : '—' }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">CPU 使用率</span>
            <span class="stat-value">{{ snap?.cpuPercent === null || snap?.cpuPercent === undefined ? '采集中…' : `${snap.cpuPercent.toFixed(0)}%` }}</span>
            <div class="meter"><div class="meter-fill" :class="cpuClass" :style="{ width: cpuPct + '%' }" /></div>
          </div>
          <div class="stat">
            <span class="stat-label">系统内存</span>
            <span class="stat-value">
              {{ snap ? `${(snap.memory.usedMb / 1024).toFixed(1)} / ${(snap.memory.totalMb / 1024).toFixed(1)} G` : '—' }}
            </span>
            <div class="meter"><div class="meter-fill" :class="memClass" :style="{ width: memPct + '%' }" /></div>
          </div>
          <div class="stat">
            <span class="stat-label">项目磁盘</span>
            <span class="stat-value">
              {{ snap ? `${snap.disk.freeGb} G 可用` : '—' }}
            </span>
            <div class="meter"><div class="meter-fill" :class="diskClass" :style="{ width: diskPct + '%' }" /></div>
          </div>
        </div>
      </div>

      <!-- 容器 / 面板 -->
      <div class="monitor-section">
        <div class="monitor-label">面板进程</div>
        <div class="monitor-grid">
          <div class="stat">
            <span class="stat-label">内存占用</span>
            <span class="stat-value">{{ fmtBytes(snap?.panel.rss) }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">已运行</span>
            <span class="stat-value">{{ fmtDuration(snap?.panel.uptime ?? 0) }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">CPU 核数</span>
            <span class="stat-value">{{ snap?.cpuCount ?? '—' }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Swap 使用</span>
            <span class="stat-value">
              {{ !snap ? '—' : snap.memory.swapAvailable ? `${(snap.memory.swapUsedMb / 1024).toFixed(1)} G` : '系统未提供' }}
            </span>
          </div>
        </div>
      </div>

      <!-- 各世界 -->
      <div class="monitor-section">
        <div class="monitor-label">世界进程</div>
        <div v-if="!activeList.length" class="text-3 small">目前没有世界在运行</div>
        <div v-else class="col gap-2">
          <div v-for="i in activeList" :key="i.id" class="monitor-world-row">
            <i class="dot" :class="statusClass(i.status)" />
            <span class="monitor-world-name ellipsis">{{ i.name }}</span>
            <div class="monitor-world-stats text-3 small mono">
              <span class="nowrap">CPU {{ i.cpu.toFixed(0) }}%</span>
              <span class="nowrap">RSS {{ fmtBytes(i.rss) }}</span>
              <span class="nowrap">{{ fmtDuration(i.uptime) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.monitor-card { display: flex; flex-direction: column; }
.monitor-card > .card-body { flex: 1; justify-content: space-between; }
.monitor-section { display: flex; flex-direction: column; gap: 10px; }
.monitor-world-row {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.monitor-world-name { min-width: 0; font-weight: 550; }
.monitor-world-stats { display: flex; align-items: center; gap: 12px; }
.monitor-label {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-3);
  text-transform: uppercase;
}
.monitor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(146px, 1fr));
  gap: 12px 18px;
}
@media (max-width: 600px) {
  .monitor-world-row { grid-template-columns: 8px minmax(0, 1fr); column-gap: 10px; row-gap: 2px; }
  .monitor-world-row > .dot { grid-row: 1 / span 2; }
  .monitor-world-name, .monitor-world-stats { grid-column: 2; }
  .monitor-world-stats { justify-content: space-between; gap: 6px; }
}
</style>
