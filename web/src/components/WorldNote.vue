<script setup lang="ts">
import { computed } from 'vue';
import type { InstanceSummary } from '../lib/types.ts';
import { STATUS_TEXT, statusClass } from '../lib/format.ts';
import Icon from './Icon.vue';

const props = defineProps<{ item: InstanceSummary; busy?: boolean }>();
const emit = defineEmits<{
  start: [];
  stop: [];
  config: [];
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
const createdLabel = computed(() => {
  if (!props.item.createdAt) return '';
  const date = new Date(props.item.createdAt);
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
});
const phaseText = computed(() => {
  if (props.item.status === 'stopped') return '';
  if (props.item.lastError) return '';
  return props.item.phase || '';
});
</script>

<template>
  <section class="card world-hero">
    <div class="world-hero-top">
      <div class="world-hero-copy">
        <div class="world-title-row">
          <i class="dot" :class="statusClass(item.status)" aria-hidden="true" />
          <h1 class="world-title ellipsis">{{ item.name }}</h1>
          <span class="badge" :class="badgeClass">{{ STATUS_TEXT[item.status] ?? item.status }}</span>
          <span v-if="item.autostart" class="badge badge-accent">自启</span>
        </div>
        <p class="world-sub">{{ item.note || '还没有填写备注，可以在「配置」里补充这个世界的说明。' }}</p>
        <div class="world-tags">
          <span class="world-tag">{{ loaderLabel }}</span>
          <span class="world-tag">Minecraft {{ item.mc }}</span>
          <span v-if="item.javaMajor" class="world-tag">Java {{ item.javaMajor }}</span>
          <span v-if="createdLabel" class="world-tag">创建于 {{ createdLabel }}</span>
        </div>
        <p v-if="phaseText" class="world-phase text-3 small">{{ phaseText }}</p>
      </div>

      <div class="world-hero-actions">
        <button class="btn" @click="emit('config')">
          <Icon name="settings" :size="15" /> 配置
        </button>
        <button v-if="!running" class="btn btn-primary" :disabled="busy" @click="emit('start')">
          <span v-if="busy" class="spinner spinner-on-accent" />
          <Icon v-else name="play" :size="15" />
          启动
        </button>
        <button v-else class="btn btn-danger" :disabled="busy" @click="emit('stop')">
          <span v-if="busy" class="spinner" />
          <Icon v-else name="stop" :size="15" />
          停止
        </button>
      </div>
    </div>

    <div v-if="item.lastError" class="note-message-error">
      <Icon name="info" :size="14" />
      <span>上次崩溃 · {{ item.lastError }}</span>
    </div>
  </section>
</template>

<style scoped>
.world-hero {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
  padding: 20px 22px;
}
.world-hero-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}
.world-hero-copy { min-width: 0; }
.world-title-row { display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; }
.world-title { margin: 0; font-size: clamp(22px, 2.2vw, 28px); font-weight: 650; letter-spacing: -0.03em; }
.world-sub { margin: 7px 0 0; color: var(--text-2); font-size: 13px; }
.world-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.world-tag {
  display: inline-flex;
  align-items: center;
  height: 23px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
}
.world-phase { margin: 8px 0 0; }
.world-hero-actions { display: flex; flex: none; align-items: center; gap: 8px; }
.note-message-error {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 2px;
  padding: 8px 10px;
  border: 1px solid var(--danger-border);
  border-radius: var(--r-sm);
  background: var(--danger-soft);
  color: var(--danger-text);
  font-size: 12px;
  line-height: 1.5;
}
.note-message-error svg { flex: none; margin-top: 1px; }
@media (max-width: 720px) {
  .world-hero { padding: 16px; }
  .world-hero-top { flex-direction: column; gap: 14px; }
  .world-hero-actions { width: 100%; }
  .world-hero-actions .btn { flex: 1; }
}
</style>
