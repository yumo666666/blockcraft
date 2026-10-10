<script setup lang="ts">
import { computed, nextTick, onActivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, subscribe } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { FrpStatus, InstanceSummary, SystemSnapshot } from '../lib/types.ts';
import MonitorBar from '../components/MonitorBar.vue';
import FrpCard from '../components/FrpCard.vue';
import WorldNote from '../components/WorldNote.vue';
import WorldConfigDialog from '../components/WorldConfigDialog.vue';
import PortsDialog from '../components/PortsDialog.vue';
import CopyDialog from '../components/CopyDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import JobProgress from '../components/JobProgress.vue';
import { setBackgroundJob } from '../lib/backgroundJob.ts';
import { STATUS_TEXT, statusClass } from '../lib/format.ts';

defineOptions({ name: 'Overview' });

const router = useRouter();
const snap = ref<SystemSnapshot | null>(null);
const instances = ref<InstanceSummary[]>([]);
const frp = ref<FrpStatus | null>(null);
const ACTIVE_WORLD_KEY = 'blockcraft.overview.activeWorld';
function readActiveWorld(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_WORLD_KEY);
  } catch {
    return null;
  }
}
const activeId = ref<string | null>(readActiveWorld());
const busyId = ref<string | null>(null);

watch(activeId, (id) => {
  try {
    if (id) sessionStorage.setItem(ACTIVE_WORLD_KEY, id);
    else sessionStorage.removeItem(ACTIVE_WORLD_KEY);
  } catch {
    /* session storage may be disabled; the in-memory selection still works */
  }
});

/** 选中的世界标签滚进视野（世界多了以后，当前看的世界可能被挤出可见区域） */
const tabsEl = ref<HTMLElement | null>(null);
watch(activeId, async () => {
  await nextTick();
  const el = tabsEl.value?.querySelector<HTMLElement>('.tab.active');
  el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
});

const showConfig = ref(false);
const showPorts = ref(false);
const showCopy = ref(false);
const showDelete = ref(false);
const showJob = ref(false);
const jobId = ref<string | null>(null);
const deleteTarget = ref<InstanceSummary | null>(null);

const active = computed(() => instances.value.find((i) => i.id === activeId.value) ?? instances.value[0] ?? null);

let offSystem: (() => void) | null = null;
let frpTimer: number | null = null;
let instanceRevision = 0;
let instanceLoadRequest = 0;
const pendingStatuses = new Map<string, { status: string; phase: string; at: number }>();

function applyInstances(next: InstanceSummary[], sampledAt = Date.now()) {
  instanceRevision += 1;
  const fresh = next.map((item) => {
    const pending = pendingStatuses.get(item.id);
    if (!pending) return item;
    // A snapshot that started before the button press may finish after it. Keep
    // the accepted local state until the next fresh server snapshot arrives.
    if (sampledAt <= pending.at) return { ...item, status: pending.status, phase: pending.phase };
    pendingStatuses.delete(item.id);
    return item;
  });
  instances.value = fresh;
  if (!activeId.value && fresh.length) activeId.value = fresh[0].id;
  if (activeId.value && !fresh.some((item) => item.id === activeId.value)) activeId.value = fresh[0]?.id ?? null;
}

function setInstanceStatus(id: string, status: string, phase: string) {
  const at = Date.now();
  pendingStatuses.set(id, { status, phase, at });
  instanceRevision += 1;
  instances.value = instances.value.map((item) => item.id === id ? { ...item, status, phase } : item);
}

async function loadFrp() {
  try {
    frp.value = await api.get<FrpStatus>('/api/frp/status');
  } catch {
    frp.value = null;
  }
}

async function loadInstances() {
  const requestId = ++instanceLoadRequest;
  const revisionAtRequest = instanceRevision;
  try {
    const r = await api.get<{ instances: InstanceSummary[] }>('/api/instances');
    // SSE 或更新的列表请求已经返回时，丢弃这份较旧的 GET 结果。
    if (requestId !== instanceLoadRequest || revisionAtRequest !== instanceRevision) return;
    applyInstances(r.instances);
  } catch (err) {
    if (requestId !== instanceLoadRequest || revisionAtRequest !== instanceRevision) return;
    toastError(err, '读取世界列表失败');
  }
}

onMounted(() => {
  offSystem = subscribe<{ sampledAt: number; snap: SystemSnapshot; instances: InstanceSummary[] }>(
    '/api/system/stream',
    (data) => {
      snap.value = data.snap;
      applyInstances(data.instances, data.sampledAt);
    },
    {
      onError: () => {
        // SSE 断了就退回轮询，保证界面不会停在旧数据上
        api
          .get<SystemSnapshot & { sampledAt: number; instances: InstanceSummary[] }>('/api/system')
          .then((d) => {
            snap.value = d;
            applyInstances(d.instances, d.sampledAt);
          })
          .catch(() => undefined);
      },
    },
  );
  loadFrp();
  frpTimer = window.setInterval(loadFrp, 8000);
});

onActivated(() => {
  void loadFrp();
});

onUnmounted(() => {
  offSystem?.();
  if (frpTimer) window.clearInterval(frpTimer);
});

async function start(item: InstanceSummary) {
  busyId.value = item.id;
  try {
    await api.post(`/api/instances/${item.id}/start`);
    // The start endpoint deliberately acknowledges long starts with HTTP 202.
    // Show the accepted state immediately; the SSE snapshot will replace it with
    // the authoritative starting/running state (or stopped if startup fails).
    setInstanceStatus(item.id, 'starting', '正在启动');
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
    setInstanceStatus(item.id, 'stopping', '正在保存并关闭');
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
    activeId.value = null;
    loadInstances();
    loadFrp();
  } catch (err) {
    toastError(err, '删除失败');
  } finally {
    busyId.value = null;
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
    <!-- 上半：资源监控 + FRP -->
    <div class="top-grid">
      <MonitorBar :snap="snap" :instances="instances" />
      <FrpCard :status="frp" @refresh="loadFrp" />
    </div>

    <!-- 下半：世界便签页 -->
    <div class="card">
      <div class="world-tab-bar">
        <div ref="tabsEl" class="tabs world-tabs">
          <button
            v-for="i in instances"
            :key="i.id"
            class="tab"
            :class="{ active: active?.id === i.id }"
            @click="activeId = i.id"
          >
            <i class="dot" :class="statusClass(i.status)" aria-hidden="true" />
            {{ i.name }}
            <span class="tab-state" :class="`tab-state-${i.status}`">{{ STATUS_TEXT[i.status] ?? i.status }}</span>
          </button>
        </div>
        <div class="world-quick-actions">
          <button class="btn btn-sm" @click="router.push('/create')">＋ 新建世界</button>
          <button class="btn btn-sm" @click="router.push('/import')">＋ 导入整合包</button>
        </div>
      </div>

      <div class="card-body">
        <div v-if="!active" class="empty">
          <div class="empty-icon">🌍</div>
          <div>还没有任何世界</div>
          <div class="row gap-2 wrap mt-2">
            <button class="btn btn-primary" @click="router.push('/create')">新建世界</button>
            <button class="btn" @click="router.push('/import')">导入整合包</button>
          </div>
        </div>

        <WorldNote
          v-else
          :item="active"
          :busy="busyId === active.id"
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
        />
      </div>
    </div>

    <WorldConfigDialog
      :open="showConfig"
      :instance-id="active?.id ?? null"
      @close="showConfig = false"
      @saved="loadInstances"
      @job="openJob"
    />
    <PortsDialog :open="showPorts" :instance-id="active?.id ?? ''" :name="active?.name ?? ''" @close="showPorts = false" @changed="loadInstances" />
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
  </div>
</template>

<style scoped>
.page { min-width: 0; }
.page > .card { min-width: 0; }
.world-tab-bar { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); min-width: 0; }
.world-tabs { flex: 1 1 0; min-width: 0; border-bottom: 0; }
.world-quick-actions { display: flex; align-items: center; gap: 6px; padding: 4px 8px 4px 0; flex: none; }
.world-quick-actions .btn { white-space: nowrap; }
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
@media (max-width: 680px) {
  .world-tab-bar { align-items: stretch; flex-direction: column; gap: 0; }
  .world-quick-actions { justify-content: flex-end; padding: 0 8px 8px; }
}
</style>
