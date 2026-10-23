<script setup lang="ts">
import { computed, nextTick, onActivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { FrpStatus, InstanceSummary } from '../lib/types.ts';
import MonitorBar from '../components/MonitorBar.vue';
import FrpCard from '../components/FrpCard.vue';
import WorldNote from '../components/WorldNote.vue';
import WorldConfigDialog from '../components/WorldConfigDialog.vue';
import PortsDialog from '../components/PortsDialog.vue';
import CopyDialog from '../components/CopyDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import JobProgress from '../components/JobProgress.vue';
import Icon from '../components/Icon.vue';
import { setBackgroundJob } from '../lib/backgroundJob.ts';
import { useWorlds } from '../lib/worlds.ts';

defineOptions({ name: 'Overview' });

const route = useRoute();
const router = useRouter();
const {
  snapshot,
  instances,
  worldsReady,
  acquireWorlds,
  releaseWorlds,
  refreshWorlds,
  setWorldStatus,
} = useWorlds();
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

/** 当前世界由 URL 的 ?world= 决定：刷新、分享、从侧边栏切换都能回到同一个世界。 */
const queryWorldId = computed(() => (typeof route.query.world === 'string' ? route.query.world : null));
const activeId = computed(() => {
  const list = instances.value;
  const fromQuery = queryWorldId.value;
  if (fromQuery && list.some((item) => item.id === fromQuery)) return fromQuery;
  return list[0]?.id ?? null;
});
const active = computed(() => instances.value.find((item) => item.id === activeId.value) ?? null);

/** 世界列表就绪后把选择落进 URL；世界被删掉或首次进入时自动选第一个。 */
watch(
  () => [instances.value, worldsReady.value, queryWorldId.value] as const,
  ([list, ready, queryWorld]) => {
    if (!ready || route.name !== 'overview') return;
    const ids = new Set(list.map((item) => item.id));
    if (list.length && (!queryWorld || !ids.has(queryWorld))) {
      void router.replace({ query: { ...route.query, world: list[0].id } });
      return;
    }
    if (!list.length && queryWorld) {
      const next = { ...route.query };
      delete next.world;
      void router.replace({ query: next });
    }
  },
  { immediate: true },
);

/** 从侧边栏切换世界时，把下方世界详情滚进视野；首次进入页面不跳。 */
const worldSection = ref<HTMLElement | null>(null);
let knownActiveId = activeId.value;
watch(activeId, async (id) => {
  const hadSelection = Boolean(knownActiveId);
  const changed = id !== knownActiveId;
  knownActiveId = id;
  if (!changed || !hadSelection || !id || route.name !== 'overview') return;
  await nextTick();
  const el = worldSection.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.top < 0 || rect.top > window.innerHeight * 0.6) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

const showConfig = ref(false);
const showPorts = ref(false);
const showCopy = ref(false);
const showDelete = ref(false);
const showJob = ref(false);
const jobId = ref<string | null>(null);
const deleteTarget = ref<InstanceSummary | null>(null);
const worldImportInput = ref<HTMLInputElement | null>(null);
const importingWorld = ref(false);
const downloadingWorldId = ref<string | null>(null);
const busyId = ref<string | null>(null);

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

async function start(item: InstanceSummary) {
  busyId.value = item.id;
  try {
    await api.post(`/api/instances/${item.id}/start`);
    // The start endpoint deliberately acknowledges long starts with HTTP 202.
    // Show the accepted state immediately; the SSE snapshot will replace it with
    // the authoritative starting/running state (or stopped if startup fails).
    setWorldStatus(item.id, 'starting', '正在启动');
    toast('ok', `${item.name} 正在启动`, '状态会自己刷新，进度看卡片上的说明');
  } catch (err) {
    toastError(err, '启动失败');
  } finally {
    busyId.value = null;
  }
}

async function stop(item: InstanceSummary) {
  busyId.value = item.id;
  try {
    const r = await api.post<{ message?: string }>(`/api/instances/${item.id}/stop`, { message: '服务器正在关闭，感谢游玩' });
    setWorldStatus(item.id, 'stopping', '正在保存并关闭');
    toast('ok', `${item.name} 正在关闭`, r?.message ?? '保存完成后会自动停止，状态会自己刷新');
  } catch (err) {
    toastError(err, '停止失败');
  } finally {
    busyId.value = null;
  }
}

async function doDelete() {
  if (!deleteTarget.value) return;
  busyId.value = deleteTarget.value.id;
  try {
    await api.del(`/api/instances/${deleteTarget.value.id}?confirm=${encodeURIComponent(deleteTarget.value.id)}&purge=0`);
    toast('ok', '世界已移入回收站', '默认保留 7 天，可在设置里清理');
    showDelete.value = false;
    deleteTarget.value = null;
    await refreshWorlds();
    loadFrp();
  } catch (err) {
    toastError(err, '删除失败');
  } finally {
    busyId.value = null;
  }
}

function chooseWorldImport(): void {
  if (!importingWorld.value) worldImportInput.value?.click();
}

async function importWorld(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.zip')) {
    toast('error', '世界导入失败', '请选择 BlockCraft 导出的完整世界 ZIP 文件');
    input.value = '';
    return;
  }
  if (file.size > 20 * 1024 * 1024 * 1024) {
    toast('error', '世界导入失败', '单个世界 ZIP 不能超过 20 GB');
    input.value = '';
    return;
  }
  importingWorld.value = true;
  try {
    const result = await api.uploadFile<{ ok: boolean; instance: InstanceSummary }>('/api/instances/import', file);
    await refreshWorlds();
    void router.replace({ query: { ...route.query, world: result.instance.id } });
    toast('ok', '世界导入完成', `「${result.instance.name}」已导入并保持停止状态`);
    await loadFrp();
  } catch (err) {
    toastError(err, '世界导入失败');
  } finally {
    importingWorld.value = false;
    input.value = '';
  }
}

async function downloadWorld(item: InstanceSummary): Promise<void> {
  if (!['stopped', 'crashed'].includes(item.status) || downloadingWorldId.value) return;
  downloadingWorldId.value = item.id;
  try {
    await api.downloadFile(`/api/instances/${encodeURIComponent(item.id)}/download`, `${item.id}.zip`);
    toast('ok', '世界下载已开始', `${item.id}.zip · 包含该世界的完整实例目录`);
  } catch (err) {
    toastError(err, '世界下载失败');
  } finally {
    downloadingWorldId.value = null;
  }
}

function openJob(id: string) {
  jobId.value = id;
  showJob.value = true;
}

function backgroundJob() {
  if (jobId.value) setBackgroundJob(jobId.value);
  showJob.value = false;
}
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

    <!-- 下半：当前世界详情。世界列表在左侧边栏，一个世界一行 -->
    <section ref="worldSection" class="world-section" aria-labelledby="world-section-title">
      <div class="world-section-head">
        <div class="world-section-copy">
          <span class="head-icon" aria-hidden="true"><Icon name="server" :size="15" /></span>
          <div class="world-section-text">
            <h2 id="world-section-title">世界详情</h2>
            <p class="text-3 small">{{ active ? `当前：${active.name}` : '从左侧选择世界，或先创建一个' }}</p>
          </div>
        </div>
        <div class="world-quick-actions">
          <button class="btn btn-sm" :disabled="importingWorld" title="上传 BlockCraft 导出的完整世界 ZIP；导入后保持停止" @click="chooseWorldImport">
            <span v-if="importingWorld" class="spinner" />
            {{ importingWorld ? '正在导入…' : '＋ 导入世界' }}
          </button>
          <button class="btn btn-sm" @click="router.push('/create')">＋ 新建世界</button>
          <button class="btn btn-sm" @click="router.push('/import')">＋ 导入整合包</button>
        </div>
      </div>

      <div v-if="!active" class="card empty world-empty">
        <span class="world-empty-icon"><Icon name="globe" :size="26" /></span>
        <div class="world-empty-title">还没有任何世界</div>
        <p class="text-3 small">从一个轻量的原版世界开始，或者导入已有的整合包或世界备份。</p>
        <div class="row gap-2 wrap mt-2">
          <button class="btn" :disabled="importingWorld" @click="chooseWorldImport">{{ importingWorld ? '正在导入…' : '导入世界' }}</button>
          <button class="btn btn-primary" @click="router.push('/create')">新建世界</button>
          <button class="btn" @click="router.push('/import')">导入整合包</button>
        </div>
      </div>

      <WorldNote
        v-else
        :item="active"
        :busy="busyId === active.id"
        :downloading="downloadingWorldId === active.id"
        @start="start(active)"
        @stop="stop(active)"
        @config="showConfig = true"
        @ports="showPorts = true"
        @copy="showCopy = true"
        @console="router.push(`/w/${active.id}/console`)"
        @backups="router.push(`/w/${active.id}/backups`)"
        @mods="router.push(`/w/${active.id}/mods`)"
        @players="router.push(`/w/${active.id}/players`)"
        @remove="((deleteTarget = active), (showDelete = true))"
        @download="downloadWorld(active)"
      />
    </section>

    <WorldConfigDialog
      :open="showConfig"
      :instance-id="active?.id ?? null"
      @close="showConfig = false"
      @saved="refreshWorlds"
      @job="openJob"
    />
    <PortsDialog :open="showPorts" :instance-id="active?.id ?? ''" :name="active?.name ?? ''" @close="showPorts = false" @changed="refreshWorlds" />
    <CopyDialog
      :open="showCopy"
      :source="active ? { id: active.id, name: active.name } : null"
      @close="showCopy = false"
      @created="openJob"
    />
    <ConfirmDialog
      :open="showDelete"
      title="删除世界"
      :message="`将要删除「${deleteTarget?.name ?? ''}」的全部内容：\n· 存档与配置\n· ${deleteTarget?.modCount ?? 0} 个 MOD\n· 该世界的所有备份\n· 占用的端口与 FRP 映射\n\n删除后默认进入回收站保留 7 天。`"
      :detail="`磁盘占用：${deleteTarget ? (deleteTarget.diskUsage / 1024 / 1024).toFixed(0) : 0} MB`"
      :require-text="deleteTarget?.id ?? ''"
      require-label="输入世界 id 以确认删除"
      confirm-text="删除"
      danger
      :busy="busyId === deleteTarget?.id"
      @close="showDelete = false"
      @confirm="doDelete"
    />
    <JobProgress :open="showJob" :job-id="jobId" @close="showJob = false" @background="backgroundJob" />
    <input ref="worldImportInput" type="file" accept=".zip,application/zip" hidden @change="importWorld" />
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

.world-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  scroll-margin-top: calc(var(--topbar-h) + 10px);
}
.world-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: linear-gradient(150deg, var(--surface-strong), var(--surface-2));
  box-shadow: var(--sh-1);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
}
.world-section-copy { display: flex; min-width: 0; align-items: center; gap: 10px; }
.world-section-text { min-width: 0; }
.world-section-text h2 { margin: 0; font-size: 14px; font-weight: 650; }
.world-section-text p {
  max-width: 34rem;
  margin: 1px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.world-quick-actions { display: flex; flex: none; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; }
.world-quick-actions .btn { white-space: nowrap; }

.world-empty { gap: 10px; padding: 46px 20px 54px; }
.world-empty-icon {
  display: grid;
  width: 58px;
  height: 58px;
  place-items: center;
  border: 1px solid var(--accent-border);
  border-radius: 18px;
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: var(--sh-1);
}
.world-empty-title { font-size: 15px; font-weight: 650; color: var(--text); }
.world-empty p { max-width: 30rem; }

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
@media (max-width: 760px) {
  .world-section-head { align-items: flex-start; flex-direction: column; }
  .world-quick-actions { width: 100%; justify-content: flex-start; }
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
