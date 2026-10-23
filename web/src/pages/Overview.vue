<script setup lang="ts">
import { computed, onActivated, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../lib/api.ts';
import type { FrpStatus } from '../lib/types.ts';
import MonitorBar from '../components/MonitorBar.vue';
import FrpCard from '../components/FrpCard.vue';
import Icon from '../components/Icon.vue';
import { useWorlds } from '../lib/worlds.ts';

defineOptions({ name: 'Overview' });

const { snapshot, instances, acquireWorlds, releaseWorlds } = useWorlds();
const frp = ref<FrpStatus | null>(null);
const version = ref('');

const hostLabel = computed(() => snapshot.value?.hostname || 'Minecraft');
const runningCount = computed(
  () => instances.value.filter((i) => ['running', 'starting', 'stopping', 'stuck'].includes(i.status)).length,
);
const totalPlayers = computed(() => instances.value.reduce((sum, i) => sum + (i.players || 0), 0));
const totalMaxPlayers = computed(() => instances.value.reduce((sum, i) => sum + (i.maxPlayers || 0), 0));
const heroStatus = computed(() => {
  if (!snapshot.value) return { tone: 'loading', label: '正在读取面板状态…' };
  if (runningCount.value) return { tone: 'ready', label: `${runningCount.value} 个世界正在运行` };
  return { tone: 'ready', label: '面板运行正常 · 所有世界已停止' };
});
const quickActions = [
  { label: '新建世界', desc: '选版本与加载器', to: '/create', icon: 'plus' },
  { label: '导入整合包', desc: 'CurseForge / Modrinth', to: '/import', icon: 'package' },
  { label: '面板设置', desc: '端口、资源与外观', to: '/settings', icon: 'settings' },
];

let frpTimer: number | null = null;

async function loadFrp() {
  try {
    frp.value = await api.get<FrpStatus>('/api/frp/status');
  } catch {
    frp.value = null;
  }
}

onMounted(() => {
  acquireWorlds();
  loadFrp();
  frpTimer = window.setInterval(loadFrp, 8000);
  void api
    .get<{ version: string }>('/api/ping')
    .then((ping) => {
      version.value = ping.version ?? '';
    })
    .catch(() => undefined);
});

onActivated(() => {
  void loadFrp();
});

onUnmounted(() => {
  releaseWorlds();
  if (frpTimer) window.clearInterval(frpTimer);
});
</script>

<template>
  <div class="page col gap-4">
    <!-- 顶部：主机概览 + 快捷入口 -->
    <section class="home-hero" aria-labelledby="home-title">
      <div class="hero-intro">
        <div class="hero-copy">
          <p class="hero-eyebrow">BlockCraft Control Center</p>
          <h1 id="home-title" class="hero-title">你好，{{ hostLabel }}！</h1>
          <p class="hero-sub">方块世界，尽在掌握。启动、备份、玩家与 MOD，都在这一个面板里。</p>
        </div>
        <div class="hero-status" :class="`hero-status-${heroStatus.tone}`" role="status" aria-live="polite">
          <span class="hero-status-dot" aria-hidden="true" />
          <span>{{ heroStatus.label }}<template v-if="version"> · v{{ version }}</template></span>
        </div>
      </div>

      <div class="hero-overview">
        <div class="hero-host">
          <span class="hero-mark" aria-hidden="true"><Icon name="server" :size="21" /></span>
          <div class="hero-host-copy">
            <h2 class="hero-host-name">{{ hostLabel }}</h2>
            <p class="hero-host-meta">
              <span>{{ snapshot ? `${snapshot.platform} / ${snapshot.arch}` : '正在读取主机信息' }}</span>
              <span aria-hidden="true"> · </span>
              <span>{{ instances.length }} 个世界</span>
            </p>
          </div>
        </div>

        <div class="hero-metrics" aria-label="面板数据摘要">
          <div class="hero-metric">
            <span class="hero-metric-icon" aria-hidden="true"><Icon name="overview" :size="15" /></span>
            <span class="hero-metric-value">{{ instances.length }}</span>
            <span class="hero-metric-label">世界</span>
          </div>
          <div class="hero-metric">
            <span class="hero-metric-icon" aria-hidden="true"><Icon name="players" :size="15" /></span>
            <span class="hero-metric-value">{{ totalPlayers }}<small>/{{ totalMaxPlayers }}</small></span>
            <span class="hero-metric-label">在线玩家</span>
          </div>
        </div>

        <nav class="hero-actions" aria-label="快捷入口">
          <RouterLink v-for="action in quickActions" :key="action.to" :to="action.to" class="hero-action">
            <span class="hero-action-icon" aria-hidden="true"><Icon :name="action.icon" :size="16" /></span>
            <span class="hero-action-copy">
              <span>{{ action.label }}</span>
              <small>{{ action.desc }}</small>
            </span>
            <Icon name="chevron-right" class="hero-action-arrow" :size="14" />
          </RouterLink>
        </nav>
      </div>
    </section>

    <!-- 上半：资源监控 + FRP -->
    <div class="top-grid">
      <MonitorBar :snap="snapshot" :instances="instances" />
      <FrpCard :status="frp" @refresh="loadFrp" />
    </div>

  </div>
</template>

<style scoped>
.page { min-width: 0; }
.page > .card { min-width: 0; }

/* ---------------------------------------------------------------- 顶部概览 */
.home-hero {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: calc(var(--r-lg) + 3px);
  background: linear-gradient(145deg, var(--surface-strong), var(--surface));
  box-shadow: var(--sh-2);
  backdrop-filter: blur(24px) saturate(140%);
  -webkit-backdrop-filter: blur(24px) saturate(140%);
}
.home-hero::before {
  content: '';
  position: absolute;
  top: -150px;
  right: 9%;
  width: 320px;
  height: 320px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-soft), transparent 70%);
  pointer-events: none;
}
.home-hero::after {
  content: '';
  position: absolute;
  top: 38px;
  right: 29%;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--accent-soft);
  box-shadow: 28px -18px 0 -2px var(--accent-soft), 56px 7px 0 -3px var(--accent-soft);
  pointer-events: none;
}

.hero-intro {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 22px 24px 18px;
}
.hero-copy { min-width: 0; }
.hero-eyebrow {
  margin: 0 0 7px;
  color: var(--text-3);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.hero-title {
  font-size: clamp(26px, 2.6vw, 34px);
  line-height: 1.12;
  font-weight: 650;
  letter-spacing: -0.035em;
}
.hero-sub {
  max-width: 46rem;
  margin-top: 8px;
  color: var(--text-2);
  font-size: 13.5px;
  line-height: 1.6;
}

.hero-status {
  display: inline-flex;
  max-width: 100%;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.hero-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 18%, transparent);
}
.hero-status-ready {
  border-color: color-mix(in srgb, var(--ok) 34%, transparent);
  background: var(--ok-soft);
  color: var(--ok-text);
}
.hero-status-loading {
  border-color: color-mix(in srgb, var(--warn) 34%, transparent);
  background: var(--warn-soft);
  color: var(--warn-text);
}

.hero-overview {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(220px, 1.1fr) auto minmax(400px, 2fr);
  align-items: center;
  gap: 14px 18px;
  padding: 14px 16px;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 72%, transparent);
}
.hero-host { display: flex; min-width: 0; align-items: center; gap: 13px; }
.hero-mark {
  display: inline-flex;
  width: 44px;
  height: 44px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--accent-border);
  border-radius: 14px;
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22);
}
.hero-host-copy { min-width: 0; }
.hero-host-name {
  overflow: hidden;
  margin: 0;
  font-size: clamp(18px, 1.6vw, 21px);
  font-weight: 650;
  letter-spacing: -0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hero-host-meta { margin: 3px 0 0; color: var(--text-3); font-size: 12px; }

.hero-metrics { display: flex; gap: 8px; }
.hero-metric {
  display: grid;
  grid-template-columns: 28px auto;
  grid-template-rows: auto auto;
  column-gap: 9px;
  align-items: center;
  min-width: 100px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-2);
}
.hero-metric-icon {
  display: inline-flex;
  width: 28px;
  height: 28px;
  grid-row: 1 / 3;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
}
.hero-metric-value {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.hero-metric-value small { margin-left: 1px; color: var(--text-3); font-size: 11px; font-weight: 600; }
.hero-metric-label { color: var(--text-3); font-size: 10.5px; }

.hero-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.hero-action {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  column-gap: 9px;
  align-items: center;
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--text);
  text-decoration: none;
  transition: transform 0.18s var(--ease), border-color 0.18s, background 0.18s, box-shadow 0.18s;
}
.hero-action:hover,
.hero-action:focus-visible {
  border-color: var(--accent-border);
  background: var(--surface-3);
  color: var(--text);
  text-decoration: none;
  transform: translateY(-1px);
  box-shadow: var(--sh-1);
}
.hero-action-icon {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
}
.hero-action-copy { display: block; min-width: 0; }
.hero-action-copy > span,
.hero-action-copy > small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hero-action-copy > span { font-size: 12.5px; font-weight: 650; }
.hero-action-copy > small { color: var(--text-3); font-size: 10.5px; }
.hero-action-arrow { color: var(--text-3); transition: transform 0.18s var(--ease), color 0.18s; }
.hero-action:hover .hero-action-arrow { color: var(--accent); transform: translateX(2px); }


.top-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(300px, 1fr);
  gap: var(--sp-4);
  align-items: stretch;
  width: 100%;
  min-width: 0;
}
.top-grid > * { min-width: 0; }
@media (max-width: 940px) {
  .top-grid { grid-template-columns: minmax(0, 1fr); align-items: start; }
}

/* 顶部概览的响应式：先收窄快捷入口，再整体纵向排布 */
@media (max-width: 1240px) {
  .hero-overview { grid-template-columns: minmax(0, 1fr) auto; }
  .hero-actions { grid-column: 1 / -1; }
}
@media (max-width: 860px) {
  .hero-intro { flex-direction: column; gap: 14px; padding: 18px 18px 15px; }
  .hero-status { align-self: flex-start; }
  .hero-overview { grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 13px; }
  .hero-metrics { justify-content: flex-start; }
  .hero-action { grid-template-columns: 28px minmax(0, 1fr) auto; }
}
@media (max-width: 620px) {
  .hero-title { font-size: 25px; }
  .hero-actions { grid-template-columns: minmax(0, 1fr); }
  .hero-metric { flex: 1; }
  .home-hero::after { display: none; }
}
</style>
