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
const running = computed(() => props.instances.filter((i) => i.status === 'running' || i.status === 'starting' || i.status === 'stopping'));
const activeList = computed(() => props.instances.filter((i) => i.status !== 'stopped').slice(0, 4));

const batteryText = computed(() => {
  const d = props.snap?.device;
  if (!d || d.battery === null) return '不可用';
  return `${d.battery}%${d.charging ? ' ⚡ 充电中' : ''}`;
});
const netText = computed(() => {
  const d = props.snap?.device;
  if (!d) return props.snap ? '容器内运行' : '—';
  return d.network === 'wifi' ? 'Wi-Fi' : d.network === 'cellular' ? '移动网络' : d.network || '未知';
});
const deviceLabel = computed(() => {
  const d = props.snap?.device;
  if (d?.model) return d.model;
  return props.snap ? `${props.snap.platform}/${props.snap.arch}` : '—';
});
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>资源监控</h3>
      <span class="text-3 small">{{ running.length }} 个世界在跑 / 共 {{ instances.length }} 个</span>
    </div>
    <div class="card-body col gap-4">
      <!-- 手机 -->
      <div class="monitor-section">
        <div class="monitor-label">手机</div>
        <div class="monitor-grid">
          <div class="stat">
            <span class="stat-label">电量</span>
            <span class="stat-value">{{ batteryText }}</span>
            <span class="text-3 small ellipsis">{{ deviceLabel }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">网络</span>
            <span class="stat-value">{{ netText }}</span>
            <span class="text-3 small">屏幕 {{ snap?.device?.screen ?? '—' }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">内存</span>
            <span class="stat-value">
              {{ snap ? `${(snap.memory.usedMb / 1024).toFixed(1)} / ${(snap.memory.totalMb / 1024).toFixed(1)} G` : '—' }}
            </span>
            <div class="meter"><div class="meter-fill" :class="memClass" :style="{ width: memPct + '%' }" /></div>
          </div>
          <div class="stat">
            <span class="stat-label">存储</span>
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
              {{ snap ? `${(snap.memory.swapUsedMb / 1024).toFixed(1)} G` : '—' }}
            </span>
          </div>
        </div>
      </div>

      <!-- 各世界 -->
      <div class="monitor-section">
        <div class="monitor-label">世界进程</div>
        <div v-if="!activeList.length" class="text-3 small">目前没有世界在运行</div>
        <div v-else class="col gap-2">
          <div v-for="i in activeList" :key="i.id" class="row gap-3" style="align-items: center">
            <i class="dot" :class="statusClass(i.status)" />
            <span class="grow ellipsis" style="font-weight: 550">{{ i.name }}</span>
            <span class="text-3 small mono nowrap">CPU {{ i.cpu.toFixed(0) }}%</span>
            <span class="text-3 small mono nowrap">RSS {{ fmtBytes(i.rss) }}</span>
            <span class="text-3 small mono nowrap">{{ fmtDuration(i.uptime) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.monitor-section { display: flex; flex-direction: column; gap: 10px; }
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
</style>
