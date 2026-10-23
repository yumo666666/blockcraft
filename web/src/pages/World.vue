<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { InstanceSummary } from '../lib/types.ts';
import WorldNote from '../components/WorldNote.vue';
import WorldConfigDialog from '../components/WorldConfigDialog.vue';
import PortsDialog from '../components/PortsDialog.vue';
import CopyDialog from '../components/CopyDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import JobProgress from '../components/JobProgress.vue';
import Icon from '../components/Icon.vue';
import { setBackgroundJob } from '../lib/backgroundJob.ts';
import { useWorlds } from '../lib/worlds.ts';

defineOptions({ name: 'World' });

const props = defineProps<{ id: string }>();
const router = useRouter();
const { instances, worldsReady, acquireWorlds, releaseWorlds, refreshWorlds, setWorldStatus } = useWorlds();

const world = computed(() => instances.value.find((item) => item.id === props.id) ?? null);

const busyId = ref<string | null>(null);
const downloadingWorldId = ref<string | null>(null);
const showConfig = ref(false);
const showPorts = ref(false);
const showCopy = ref(false);
const showDelete = ref(false);
const showJob = ref(false);
const jobId = ref<string | null>(null);
const deleteTarget = ref<InstanceSummary | null>(null);

onMounted(acquireWorlds);
onUnmounted(releaseWorlds);

/** 侧边栏直接切换世界时组件会被复用：把上一个世界的弹窗和忙碌状态清掉。 */
watch(
  () => props.id,
  () => {
    showConfig.value = false;
    showPorts.value = false;
    showCopy.value = false;
    showDelete.value = false;
    showJob.value = false;
    jobId.value = null;
    deleteTarget.value = null;
    busyId.value = null;
    downloadingWorldId.value = null;
  },
);

async function start(item: InstanceSummary) {
  busyId.value = item.id;
  try {
    await api.post(`/api/instances/${item.id}/start`);
    // 启动接口对长启动返回 202；先显示 accepted 状态，后续以 SSE 快照为准。
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
    void router.replace('/');
  } catch (err) {
    toastError(err, '删除失败');
  } finally {
    busyId.value = null;
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
    <div class="world-heading">
      <button class="btn btn-ghost btn-sm back-link" @click="router.push('/')">
        <Icon name="chevron-left" :size="14" /> 返回总览
      </button>
      <div class="page-heading grow">
        <h1 class="ellipsis">{{ world?.name ?? props.id }}</h1>
        <p>{{ world ? '世界状态、端口、MOD 与常用操作' : '正在读取世界信息…' }}</p>
      </div>
    </div>

    <div v-if="!world && !worldsReady" class="row gap-2"><span class="spinner" /> 读取世界…</div>

    <div v-else-if="!world" class="card empty world-missing">
      <span class="world-missing-icon"><Icon name="globe" :size="26" /></span>
      <div class="world-missing-title">找不到这个世界</div>
      <p class="text-3 small">它可能已被删除，或者链接里的世界 id 不正确。</p>
      <button class="btn btn-primary mt-2" @click="router.push('/')">返回总览</button>
    </div>

    <WorldNote
      v-else
      :item="world"
      :busy="busyId === world.id"
      :downloading="downloadingWorldId === world.id"
      @start="start(world)"
      @stop="stop(world)"
      @config="showConfig = true"
      @ports="showPorts = true"
      @copy="showCopy = true"
      @console="router.push(`/w/${world.id}/console`)"
      @backups="router.push(`/w/${world.id}/backups`)"
      @mods="router.push(`/w/${world.id}/mods`)"
      @players="router.push(`/w/${world.id}/players`)"
      @remove="((deleteTarget = world), (showDelete = true))"
      @download="downloadWorld(world)"
    />

    <WorldConfigDialog
      :open="showConfig"
      :instance-id="world?.id ?? null"
      @close="showConfig = false"
      @saved="refreshWorlds"
      @job="openJob"
    />
    <PortsDialog :open="showPorts" :instance-id="world?.id ?? ''" :name="world?.name ?? ''" @close="showPorts = false" @changed="refreshWorlds" />
    <CopyDialog
      :open="showCopy"
      :source="world ? { id: world.id, name: world.name } : null"
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
.world-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
.world-heading .page-heading { min-width: 0; }
.world-heading .page-heading h1 { font-size: 24px; }
.world-missing { gap: 10px; padding: 44px 20px 50px; }
.world-missing-icon {
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
.world-missing-title { font-size: 15px; font-weight: 650; color: var(--text); }
.world-missing p { max-width: 30rem; }
@media (max-width: 620px) {
  .world-heading { align-items: flex-start; flex-wrap: wrap; }
}
</style>
