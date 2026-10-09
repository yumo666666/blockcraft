<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
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

const router = useRouter();
const snap = ref<SystemSnapshot | null>(null);
const instances = ref<InstanceSummary[]>([]);
const frp = ref<FrpStatus | null>(null);
const activeId = ref<string | null>(null);
const busyId = ref<string | null>(null);

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

async function loadFrp() {
  try {
    frp.value = await api.get<FrpStatus>('/api/frp/status');
  } catch {
    frp.value = null;
  }
}

async function loadInstances() {
  try {
    const r = await api.get<{ instances: InstanceSummary[] }>('/api/instances');
    instances.value = r.instances;
    if (!activeId.value && r.instances.length) activeId.value = r.instances[0].id;
    if (activeId.value && !r.instances.some((i) => i.id === activeId.value)) activeId.value = r.instances[0]?.id ?? null;
  } catch (err) {
    toastError(err, '读取世界列表失败');
  }
}

onMounted(() => {
  offSystem = subscribe<{ snap: SystemSnapshot; instances: InstanceSummary[] }>(
    '/api/system/stream',
    (data) => {
      snap.value = data.snap;
      instances.value = data.instances;
      if (!activeId.value && data.instances.length) activeId.value = data.instances[0].id;
    },
    {
      onError: () => {
        // SSE 断了就退回轮询，保证界面不会停在旧数据上
        api
          .get<SystemSnapshot & { instances: InstanceSummary[] }>('/api/system')
          .then((d) => {
            snap.value = d;
            instances.value = d.instances;
          })
          .catch(() => undefined);
      },
    },
  );
  loadFrp();
  frpTimer = window.setInterval(loadFrp, 8000);
});

onUnmounted(() => {
  offSystem?.();
  if (frpTimer) window.clearInterval(frpTimer);
});

async function start(item: InstanceSummary) {
  busyId.value = item.id;
  try {
    await api.post(`/api/instances/${item.id}/start`);
    toast('ok', `${item.name} 正在启动`, '状态会自己刷新，进度看卡片上的说明');
    loadInstances();
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
    toast('ok', `${item.name} 正在关闭`, r?.message ?? '保存完成后会自动停止，状态会自己刷新');
    loadInstances();
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
      <div ref="tabsEl" class="tabs" style="border-bottom: 1px solid var(--border); border-radius: 0">
        <button
          v-for="i in instances"
          :key="i.id"
          class="tab"
          :class="{ active: active?.id === i.id }"
          @click="activeId = i.id"
        >
          <i class="dot" :class="i.status === 'running' ? 'dot-ok' : i.status === 'stopped' ? 'dot-idle' : 'dot-warn dot-pulse'" />
          {{ i.name }}
        </button>
        <button class="tab tab-add" @click="router.push('/new')">＋ 新建世界 / 导入整合包</button>
      </div>

      <div class="card-body">
        <div v-if="!active" class="empty">
          <div class="empty-icon">🌍</div>
          <div>还没有任何世界</div>
          <button class="btn btn-primary mt-2" @click="router.push('/new')">创建第一个世界</button>
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
    <JobProgress :open="showJob" :job-id="jobId" @close="showJob = false" />
  </div>
</template>

<style scoped>
.page { min-width: 0; }
.page > .card { min-width: 0; }
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
</style>
