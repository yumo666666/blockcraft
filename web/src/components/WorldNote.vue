<script setup lang="ts">
import { computed } from 'vue';
import type { InstanceSummary } from '../lib/types.ts';
import { fmtBytes, fmtDuration, STATUS_TEXT, statusClass } from '../lib/format.ts';

const props = defineProps<{ item: InstanceSummary; busy?: boolean }>();
const emit = defineEmits<{
  start: [];
  stop: [];
  config: [];
  console: [];
  backups: [];
  mods: [];
  players: [];
  copy: [];
  remove: [];
  ports: [];
}>();

const running = computed(() => ['running', 'starting', 'stopping', 'stuck'].includes(props.item.status));
const badgeClass = computed(() => {
  switch (props.item.status) {
    case 'running':
      return 'badge-ok';
    case 'starting':
    case 'stopping':
      return 'badge-warn';
    case 'stuck':
    case 'crashed':
      return 'badge-danger';
    default:
      return 'badge-outline';
  }
});
const loaderLabel = computed(() => {
  const map: Record<string, string> = { vanilla: '原版', paper: 'Paper', forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric' };
  const base = map[props.item.loader] ?? props.item.loader;
  return props.item.loaderVersion ? `${base} ${props.item.loaderVersion}` : base;
});
</script>

<template>
  <div class="note-card">
    <div class="note-strip" :style="{ background: item.color }" />
    <div class="note-head">
      <div class="row-between">
        <div class="grow" style="min-width: 0">
          <div class="row gap-2">
            <i class="dot" :class="statusClass(item.status)" />
            <h2 class="ellipsis">{{ item.name }}</h2>
          </div>
          <div v-if="item.lastError" class="note-crash" :title="item.lastError">
            <span class="badge badge-danger">上次崩溃</span>
            <span class="ellipsis">{{ item.lastError }}</span>
          </div>
          <div class="row gap-2 mt-2 wrap">
            <span v-if="item.autostart" class="badge badge-accent" title="随面板自动启动">自启</span>
            <span class="text-3 small ellipsis">{{ item.note || `${loaderLabel} · Minecraft ${item.mc}` }}</span>
          </div>
        </div>
        <span class="badge" :class="badgeClass">{{ STATUS_TEXT[item.status] ?? item.status }}</span>
      </div>
    </div>

    <div class="note-body col gap-3">
      <!-- 连接信息：本地端口 + 公网端口，一眼能看到 -->
      <div class="conn-row">
        <div class="conn-item">
          <span class="text-3 small">本地</span>
          <span class="mono conn-value">{{ item.port }}</span>
        </div>
        <div class="conn-item">
          <span class="text-3 small">公网</span>
          <span class="mono conn-value">{{ item.frpPort ?? '未映射' }}</span>
        </div>
        <div class="conn-item">
          <span class="text-3 small">在线</span>
          <span class="mono conn-value">{{ item.players }}/{{ item.maxPlayers }}</span>
        </div>
        <div class="conn-item">
          <span class="text-3 small">MOD</span>
          <span class="mono conn-value">{{ item.modCount }}</span>
        </div>
      </div>

      <div class="note-stats">
        <div class="stat">
          <span class="stat-label">CPU</span>
          <span class="stat-value">{{ item.status === 'stopped' ? '—' : item.cpu.toFixed(0) + '%' }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">内存</span>
          <span class="stat-value">{{ item.status === 'stopped' ? `Xmx ${item.memoryMb}M` : fmtBytes(item.rss) }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">运行时长</span>
          <span class="stat-value">{{ item.status === 'stopped' ? '—' : fmtDuration(item.uptime) }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">占用</span>
          <span class="stat-value">{{ fmtBytes(item.diskUsage) }}</span>
        </div>
      </div>

      <div v-if="item.phase && item.status !== 'stopped'" class="text-3 small ellipsis">{{ item.phase }}</div>

      <!-- 操作区：等宽网格，永远对齐 -->
      <div class="btn-grid">
        <button class="btn btn-sm" @click="emit('ports')">显示端口</button>
        <button
          v-if="!running"
          class="btn btn-sm btn-primary"
          :disabled="busy"
          @click="emit('start')"
        >
          启动
        </button>
        <button v-else class="btn btn-sm btn-danger" :disabled="busy" @click="emit('stop')">停止</button>
        <button class="btn btn-sm" @click="emit('config')">配置</button>
        <button class="btn btn-sm" @click="emit('console')">控制台</button>
        <button class="btn btn-sm" @click="emit('backups')">备份与回退</button>
        <button class="btn btn-sm" @click="emit('mods')">MOD 管理</button>
        <button class="btn btn-sm" @click="emit('players')">玩家管理</button>
        <button class="btn btn-sm" @click="emit('copy')">复制为新世界</button>
      </div>
      <button class="btn btn-sm btn-danger btn-block" @click="emit('remove')">删除这个世界</button>
    </div>
  </div>
</template>

<style scoped>
.conn-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  padding: 9px 11px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--surface-2);
}
.conn-item { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.conn-value { font-size: 13.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; }
</style>
