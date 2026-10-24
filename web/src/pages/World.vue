<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import { fmtBytes, fmtDuration, fmtRelative, normalizeTimestamp } from '../lib/format.ts';
import type { InstanceSummary } from '../lib/types.ts';
import WorldNote from '../components/WorldNote.vue';
import WorldPerformance from '../components/WorldPerformance.vue';
import WorldConfigDialog from '../components/WorldConfigDialog.vue';
import PortsDialog from '../components/PortsDialog.vue';
import CopyDialog from '../components/CopyDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import JobProgress from '../components/JobProgress.vue';
import Icon from '../components/Icon.vue';
import WorldPageSkeleton from '../components/WorldPageSkeleton.vue';
import { setBackgroundJob } from '../lib/backgroundJob.ts';
import { useWorlds } from '../lib/worlds.ts';

defineOptions({ name: 'World' });

const props = defineProps<{ id: string }>();
const router = useRouter();
const { instances, worldsReady, acquireWorlds, releaseWorlds, refreshWorlds, setWorldStatus } = useWorlds();

const world = computed(() => instances.value.find((item) => item.id === props.id) ?? null);
const running = computed(() => Boolean(world.value && ['running', 'starting', 'stopping', 'stuck'].includes(world.value.status)));
const archiveAvailable = computed(() => Boolean(world.value && ['stopped', 'crashed'].includes(world.value.status)));
const publicPort = computed(() => {
  if (!world.value) return '—';
  if (world.value.frpPort) return String(world.value.frpPort);
  return world.value.frpEnabled ? '未映射' : '未启用';
});
const createdLabel = computed(() => {
  const timestamp = normalizeTimestamp(world.value?.createdAt);
  if (timestamp === null) return '—';
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
});

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
  if (!archiveAvailable.value || downloadingWorldId.value) return;
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
    <WorldPageSkeleton v-if="!world && !worldsReady" />

    <div v-else-if="!world" class="card empty world-missing">
      <span class="world-missing-icon"><Icon name="globe" :size="26" /></span>
      <div class="world-missing-title">找不到这个世界</div>
      <p class="text-3 small">它可能已被删除，或者链接里的世界 id 不正确。</p>
      <button class="btn btn-primary mt-2" @click="router.push('/')">返回总览</button>
    </div>

    <template v-else>
      <WorldNote
        :item="world"
        :busy="busyId === world.id"
        @start="start(world)"
        @stop="stop(world)"
        @config="showConfig = true"
      />

      <WorldPerformance :world="world" />

      <div class="world-bottom-grid">
        <section class="card world-panel">
          <div class="card-head">
            <h3><span class="head-icon"><Icon name="cpu" :size="15" /></span>连接与运行</h3>
          </div>
          <div class="card-body world-facts">
            <div class="world-fact">
              <span>本地端口</span>
              <strong class="mono">{{ world.port }}</strong>
            </div>
            <div class="world-fact">
              <span>公网端口</span>
              <strong class="mono">{{ publicPort }}</strong>
            </div>
            <div class="world-fact">
              <span>在线玩家</span>
              <strong>{{ world.players }} / {{ world.maxPlayers }}</strong>
            </div>
            <div class="world-fact">
              <span>MOD 数量</span>
              <strong>{{ world.modCount }}</strong>
            </div>
            <div class="world-fact">
              <span>磁盘占用</span>
              <strong>{{ fmtBytes(world.diskUsage) }}</strong>
            </div>
            <div class="world-fact">
              <span>内存上限</span>
              <strong>{{ world.memoryMb }} MB</strong>
            </div>
            <div class="world-fact">
              <span>运行时长</span>
              <strong>{{ running ? fmtDuration(world.uptime) : '—' }}</strong>
            </div>
            <div class="world-fact">
              <span>上次备份</span>
              <strong>{{ world.lastBackup ? fmtRelative(world.lastBackup) : '从未' }}</strong>
            </div>
          </div>
        </section>

        <section class="card world-panel">
          <div class="card-head">
            <h3><span class="head-icon"><Icon name="server" :size="15" /></span>世界信息</h3>
          </div>
          <div class="card-body world-facts">
            <div class="world-fact">
              <span>世界 ID</span>
              <strong class="mono ellipsis">{{ world.id }}</strong>
            </div>
            <div class="world-fact">
              <span>Minecraft</span>
              <strong>{{ world.mc }}</strong>
            </div>
            <div class="world-fact">
              <span>加载器</span>
              <strong>
                {{ world.loader }}
                <template v-if="world.loaderVersion"> {{ world.loaderVersion }}</template>
              </strong>
            </div>
            <div class="world-fact">
              <span>Java</span>
              <strong>{{ world.javaMajor ? `Java ${world.javaMajor}` : '自动选择' }}</strong>
            </div>
            <div class="world-fact">
              <span>自动启动</span>
              <strong>{{ world.autostart ? '开启' : '关闭' }}</strong>
            </div>
            <div class="world-fact">
              <span>创建时间</span>
              <strong>{{ createdLabel }}</strong>
            </div>
            <div class="world-fact world-fact-wide">
              <span>备注</span>
              <strong :class="{ 'text-3': !world.note }">{{ world.note || '—' }}</strong>
            </div>
          </div>
        </section>

        <section class="card world-panel world-actions-card">
          <div class="card-head">
            <h3><span class="head-icon"><Icon name="settings" :size="15" /></span>操作</h3>
          </div>
          <div class="card-body col gap-2">
            <button class="world-action" @click="showPorts = true">
              <Icon name="globe" :size="17" />
              <span><strong>显示端口</strong><small>本地与公网连接地址</small></span>
            </button>
            <button class="world-action" @click="showCopy = true">
              <Icon name="backups" :size="17" />
              <span><strong>复制为新世界</strong><small>保留存档、配置与 MOD</small></span>
            </button>
            <button
              class="world-action"
              :disabled="!archiveAvailable || Boolean(downloadingWorldId)"
              :title="archiveAvailable ? '下载这个世界的完整目录 ZIP' : '请先完全停止世界，再下载完整目录'"
              @click="downloadWorld(world)"
            >
              <span v-if="downloadingWorldId === world.id" class="spinner" />
              <Icon v-else name="download" :size="17" />
              <span><strong>{{ downloadingWorldId === world.id ? '正在打包…' : '下载世界' }}</strong><small>{{ archiveAvailable ? '打包完整实例目录' : '停止世界后可下载' }}</small></span>
            </button>
            <button class="world-action world-action-danger" :disabled="busyId === world.id" @click="((deleteTarget = world), (showDelete = true))">
              <Icon name="trash" :size="17" />
              <span><strong>删除世界</strong><small>移入回收站保留 7 天</small></span>
            </button>
          </div>
        </section>
      </div>
    </template>

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
.world-bottom-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-4);
  align-items: stretch;
}
.world-panel { display: flex; min-width: 0; flex-direction: column; }
.world-panel > .card-body { flex: 1; }
.world-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: start;
  gap: 14px 20px;
}
.world-fact { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.world-fact > span { color: var(--text-3); font-size: 11.5px; }
.world-fact > strong { overflow: hidden; font-size: 13.5px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.world-fact-wide { grid-column: 1 / -1; }
.world-fact-wide > strong { white-space: normal; line-height: 1.5; }
.world-action {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.16s, background 0.16s, transform 0.16s;
}
.world-action > svg { flex: none; color: var(--accent-text); }
.world-action > span { display: flex; min-width: 0; flex-direction: column; gap: 1px; }
.world-action strong { font-size: 12.5px; font-weight: 650; }
.world-action small { color: var(--text-3); font-size: 10.5px; }
.world-action:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--surface-3);
  transform: translateY(-1px);
}
.world-action:disabled { opacity: 0.55; cursor: not-allowed; }
.world-action-danger > svg { color: var(--danger); }
.world-action-danger:hover:not(:disabled) { border-color: var(--danger-border); background: var(--danger-soft); }

.world-missing { gap: 10px; padding: 44px 20px 50px; }
.world-missing-icon {
  display: grid;
  width: 58px;
  height: 58px;
  place-items: center;
  border: 1px solid var(--accent-border);
  border-radius: 18px;
  background: var(--accent-soft);
  color: var(--accent-text);
  box-shadow: var(--sh-1);
}
.world-missing-title { font-size: 15px; font-weight: 650; color: var(--text); }
.world-missing p { max-width: 30rem; }

@media (max-width: 1100px) {
  .world-bottom-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .world-actions-card { grid-column: 1 / -1; }
  .world-actions-card .card-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 780px) {
  .world-bottom-grid { grid-template-columns: minmax(0, 1fr); }
  .world-actions-card { grid-column: auto; }
  .world-actions-card .card-body { display: flex; }
  .world-fact-wide { grid-column: auto; }
}
</style>
