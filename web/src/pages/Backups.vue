<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import { fmtBytes, fmtRelative, fmtTime, STATUS_TEXT, statusClass } from '../lib/format.ts';
import type { BackupEntry, InstanceDetail } from '../lib/types.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Modal from '../components/Modal.vue';

defineOptions({ name: 'Backups' });

const props = defineProps<{ id: string }>();
const router = useRouter();

/** web 端 types.ts 还没有备份策略类型，先在本页声明（与 server/src/types.ts 的 BackupPolicy 对齐） */
interface BackupPolicy {
  autoEnabled: boolean;
  intervalMin: number;
  keepN: number;
  maxAgeDays: number;
  maxTotalMb: number;
  protectManual: boolean;
}

interface CleanupPlan {
  remove: BackupEntry[];
  freed: number;
  kept: BackupEntry[];
  totalAfter: number;
}

interface BackupsPayload {
  backups: BackupEntry[];
  usage: { bytes: number; count: number };
  policy: BackupPolicy;
  running: boolean;
}

/** 回退的阶段提示：接口要等几十秒到几分钟，期间只能靠这段文案告诉用户进行到哪了 */
const ROLLBACK_STAGES = [
  { key: 'stop', label: '正在停服（先保存世界再关闭服务器）' },
  { key: 'safety', label: '正在把当前存档另存为保底目录' },
  { key: 'extract', label: '正在解压这份备份到存档目录' },
  { key: 'start', label: '正在启动服务器' },
];
const STAGE_MS = 5000;

const detail = ref<InstanceDetail | null>(null);
const backups = ref<BackupEntry[]>([]);
const usage = ref<{ bytes: number; count: number }>({ bytes: 0, count: 0 });
const policy = ref<BackupPolicy | null>(null);
const running = ref(false);
const loading = ref(false);

const backing = ref(false);
const savingPolicy = ref(false);

const deleteTarget = ref<BackupEntry | null>(null);
const showDelete = ref(false);
const deleting = ref(false);

const rollbackTarget = ref<BackupEntry | null>(null);
const showRollback = ref(false);
const rolling = ref(false);
const rollStage = ref(0);

const showCleanup = ref(false);
const cleanupPlan = ref<CleanupPlan | null>(null);
const planBusy = ref(false);
const cleaning = ref(false);
const uploading = ref(false);
const backupInput = ref<HTMLInputElement | null>(null);

let stageTimer: number | null = null;
let pollTimer: number | null = null;
let listPollTimer: number | null = null;
let closed = false;
let pollingLiveState = false;

const name = computed(() => detail.value?.instance?.name ?? props.id);
const status = computed(() => detail.value?.instance?.status ?? 'stopped');

function badgeClass(s: string): string {
  switch (s) {
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
}

function typeText(type: string): string {
  switch (type) {
    case 'manual':
      return '手动';
    case 'auto':
      return '自动';
    case 'pre-rollback':
      return '回退前';
    case 'startup':
      return '启动时';
    default:
      return type;
  }
}

function typeBadge(type: string): string {
  switch (type) {
    case 'manual':
      return 'badge-accent';
    case 'pre-rollback':
      return 'badge-warn';
    default:
      return 'badge-outline';
  }
}

function statusText(s: string): string {
  switch (s) {
    case 'ok':
      return '完整';
    case 'partial':
      return '不完整';
    case 'rejected':
      return '已拒绝';
    default:
      return s;
  }
}

const policyText = computed(() => {
  const p = policy.value;
  if (!p) return '读取中…';
  if (!p.autoEnabled) return '自动备份已关闭';
  return `每 ${p.intervalMin} 分钟 · 保留 ${p.keepN} 份`;
});

async function loadDetail(): Promise<void> {
  try {
    detail.value = await api.get<InstanceDetail>(`/api/instances/${props.id}`);
  } catch (err) {
    toastError(err, '读取世界信息失败');
  }
}

async function pollLiveState(): Promise<void> {
  if (pollingLiveState || closed) return;
  pollingLiveState = true;
  try {
    const [nextDetail, nextBackups] = await Promise.all([
      api.get<InstanceDetail>(`/api/instances/${props.id}`),
      api.get<BackupsPayload>(`/api/instances/${props.id}/backups`),
    ]);
    detail.value = nextDetail;
    running.value = Boolean(nextBackups.running);
  } catch {
    // Background refreshes should not interrupt the page with a toast every few seconds.
  } finally {
    pollingLiveState = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const r = await api.get<BackupsPayload>(`/api/instances/${props.id}/backups`);
    backups.value = r.backups ?? [];
    usage.value = r.usage ?? { bytes: 0, count: 0 };
    policy.value = r.policy ?? null;
    running.value = Boolean(r.running);
  } catch (err) {
    toastError(err, '读取备份列表失败');
  } finally {
    loading.value = false;
  }
}

async function reload(): Promise<void> {
  await Promise.all([load(), loadDetail()]);
}

// ---------------------------------------------------------------- 立即备份

async function backupNow(): Promise<void> {
  backing.value = true;
  try {
    const r = await api.post<{ ok: boolean; entry: BackupEntry }>(`/api/instances/${props.id}/backups`);
    toast('ok', '备份完成', r.entry?.file ?? '');
    await reload();
  } catch (err) {
    // 世界没生成完会返回 425（缺少区域文件），错误原样告诉用户
    toastError(err, '立即备份失败');
  } finally {
    backing.value = false;
  }
}

// ---------------------------------------------------------------- 删除

function askDelete(b: BackupEntry): void {
  deleteTarget.value = b;
  showDelete.value = true;
}

async function doDelete(): Promise<void> {
  const b = deleteTarget.value;
  if (!b) return;
  deleting.value = true;
  try {
    await api.del(`/api/instances/${props.id}/backups/${encodeURIComponent(b.file)}?confirm=1`);
    toast('ok', '备份已删除', b.file);
    showDelete.value = false;
    deleteTarget.value = null;
    await load();
  } catch (err) {
    toastError(err, '删除备份失败');
  } finally {
    deleting.value = false;
  }
}

// ---------------------------------------------------------------- 回退

function askRollback(b: BackupEntry): void {
  if (b.status !== 'ok') return;
  rollbackTarget.value = b;
  showRollback.value = true;
}

async function doRollback(): Promise<void> {
  const b = rollbackTarget.value;
  if (!b) return;
  showRollback.value = false;
  rolling.value = true;
  rollStage.value = 0;
  stageTimer = window.setInterval(() => {
    if (rollStage.value < ROLLBACK_STAGES.length - 1) rollStage.value += 1;
  }, STAGE_MS);
  try {
    await api.post(`/api/instances/${props.id}/backups/${encodeURIComponent(b.file)}/rollback`, { confirm: b.file });
    toast('ok', '回退完成', `存档已恢复为 ${b.file}`);
    await reload();
  } catch (err) {
    toastError(err, '回退失败');
  } finally {
    if (stageTimer) window.clearInterval(stageTimer);
    stageTimer = null;
    rolling.value = false;
    rollbackTarget.value = null;
  }
}

function chooseBackupUpload(): void {
  if (!uploading.value) backupInput.value?.click();
}

async function uploadBackup(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  uploading.value = true;
  try {
    const result = await api.uploadFile<{ ok: boolean; entry: BackupEntry }>(`/api/instances/${props.id}/backups/upload`, file);
    toast('ok', '备份上传完成', `${result.entry.file} · ${fmtBytes(result.entry.bytes)}`);
    await reload();
  } catch (err) {
    toastError(err, '备份上传失败');
  } finally {
    uploading.value = false;
    input.value = '';
  }
}

function downloadBackup(entry: BackupEntry): void {
  const link = document.createElement('a');
  link.href = `/api/instances/${encodeURIComponent(props.id)}/backups/${encodeURIComponent(entry.file)}/download`;
  link.download = entry.file;
  document.body.append(link);
  link.click();
  link.remove();
}

// ---------------------------------------------------------------- 清理（先预演再执行）

async function planCleanup(): Promise<void> {
  planBusy.value = true;
  try {
    const r = await api.post<{ ok: boolean; plan: CleanupPlan }>(`/api/instances/${props.id}/backups/cleanup`, { dryRun: true });
    cleanupPlan.value = r.plan;
    showCleanup.value = true;
  } catch (err) {
    toastError(err, '预演清理失败');
  } finally {
    planBusy.value = false;
  }
}

async function runCleanup(): Promise<void> {
  cleaning.value = true;
  try {
    const r = await api.post<{ ok: boolean; result: { removed: BackupEntry[]; freed: number } }>(
      `/api/instances/${props.id}/backups/cleanup`,
      { dryRun: false },
    );
    toast('ok', '清理完成', `删除 ${r.result?.removed?.length ?? 0} 份 · 释放 ${fmtBytes(r.result?.freed ?? 0)}`);
    showCleanup.value = false;
    cleanupPlan.value = null;
    await load();
  } catch (err) {
    toastError(err, '清理失败');
  } finally {
    cleaning.value = false;
  }
}

function closeCleanup(): void {
  if (cleaning.value) return;
  showCleanup.value = false;
  cleanupPlan.value = null;
}

// ---------------------------------------------------------------- 自动备份策略

async function savePolicy(): Promise<void> {
  const p = policy.value;
  if (!p) return;
  savingPolicy.value = true;
  try {
    // 只提交 backup 字段；saveConfig 是浅合并，所以整个备份策略一起发，避免丢掉 maxTotalMb / protectManual
    await api.put(`/api/instances/${props.id}`, { backup: { ...p } });
    toast('ok', '自动备份设置已保存', policyText.value);
    await load();
  } catch (err) {
    toastError(err, '保存自动备份设置失败');
  } finally {
    savingPolicy.value = false;
  }
}

// ---------------------------------------------------------------- 生命周期

onMounted(async () => {
  await reload();
  if (closed) return;
  // A rollback restarts the server asynchronously. Keep the live badge in sync
  // after the request returns instead of leaving the initial "starting" snapshot.
  pollTimer = window.setInterval(pollLiveState, 3000);
  listPollTimer = window.setInterval(load, 10000);
});

onUnmounted(() => {
  closed = true;
  if (stageTimer) window.clearInterval(stageTimer);
  if (pollTimer) window.clearInterval(pollTimer);
  if (listPollTimer) window.clearInterval(listPollTimer);
});

watch(
  () => props.id,
  async () => {
    detail.value = null;
    backups.value = [];
    usage.value = { bytes: 0, count: 0 };
    policy.value = null;
    await reload();
  },
);
</script>

<template>
  <div class="page col gap-4">
    <!-- 头部：返回 + 世界名 + 占用 + 立即备份 -->
    <div class="row-between wrap gap-3">
      <div class="row gap-3 wrap">
        <button class="btn btn-ghost btn-sm" @click="router.push('/')">← 返回总览</button>
        <div class="row gap-2">
          <i class="dot" :class="statusClass(status)" />
          <h1 class="ellipsis">{{ name }}</h1>
        </div>
        <span class="badge" :class="badgeClass(status)">{{ STATUS_TEXT[status] ?? status }}</span>
        <span class="badge badge-outline">当前备份占用 {{ fmtBytes(usage.bytes) }}（{{ usage.count }} 份）</span>
        <span v-if="running" class="badge badge-warn">世界运行中，备份前要先停服</span>
      </div>
      <button class="btn btn-primary" :disabled="backing" @click="backupNow">
        <span v-if="backing" class="spinner" style="border-top-color: #fff" />
        立即备份
      </button>
    </div>

    <!-- 一排统计 -->
    <div class="card card-pad stat-row">
      <div class="stat">
        <span class="stat-label">备份总占用</span>
        <span class="stat-value">{{ fmtBytes(usage.bytes) }}</span>
      </div>
      <div class="stat">
        <span class="stat-label">备份份数</span>
        <span class="stat-value">{{ usage.count }}</span>
      </div>
      <div class="stat">
        <span class="stat-label">自动备份策略</span>
        <span class="stat-value">{{ policyText }}</span>
      </div>
      <div class="stat">
        <span class="stat-label">最近一次</span>
        <span class="stat-value">{{ backups.length ? fmtRelative(backups[0].created) : '—' }}</span>
      </div>
    </div>

    <!-- 备份列表 -->
    <div class="card">
      <div class="card-head">
        <h2>📦 备份列表</h2>
        <div class="row gap-2">
          <span v-if="loading" class="spinner" />
          <button class="btn btn-sm" :disabled="uploading" @click="chooseBackupUpload">
            <span v-if="uploading" class="spinner" />
            {{ uploading ? '正在上传…' : '上传备份 ZIP' }}
          </button>
          <button class="btn btn-sm" :disabled="planBusy || cleaning" @click="planCleanup">
            <span v-if="planBusy" class="spinner" />
            清理旧备份
          </button>
        </div>
      </div>

      <div class="card-body col gap-3">
        <p class="text-3 small">只上传由 BlockCraft 导出的 ZIP 备份，单个文件最大 20 GB。备份只含世界存档，不含 MOD 和服务器配置；迁移后请让目标世界的 Minecraft 版本、加载器与模组保持一致。</p>
        <div v-if="!backups.length && !loading" class="empty">
          <div class="empty-icon">📦</div>
          <div>还没有任何备份</div>
          <div class="small">停服后点右上角「立即备份」，或在下面打开自动备份。</div>
        </div>

        <div v-for="b in backups" :key="b.file" class="mod-card">
          <div class="row-between wrap gap-3">
            <div class="grow col gap-1">
              <div class="row gap-2 wrap">
                <span class="mono ellipsis">{{ b.file }}</span>
                <span class="badge" :class="typeBadge(b.type)">{{ typeText(b.type) }}</span>
                <span class="badge" :class="b.status === 'ok' ? 'badge-ok' : 'badge-danger'">{{ statusText(b.status) }}</span>
              </div>
              <div class="row gap-3 wrap text-3 small">
                <span>{{ fmtBytes(b.bytes) }}</span>
                <span>{{ fmtTime(b.created) }} · {{ fmtRelative(b.created) }}</span>
                <span>区域文件 {{ b.regions }}</span>
                <span class="mono">sha256 {{ (b.sha256 || '').slice(0, 12) || '—' }}</span>
                <span v-if="b.note">{{ b.note }}</span>
              </div>
            </div>

            <div class="row gap-2 wrap-right">
              <span v-if="b.status !== 'ok'" class="text-3 small">该备份不完整，禁止回退</span>
              <button class="btn btn-sm" :disabled="rolling" @click="downloadBackup(b)">下载</button>
              <button class="btn btn-sm btn-danger" :disabled="rolling" @click="askDelete(b)">删除</button>
              <button
                class="btn btn-sm btn-primary"
                :disabled="b.status !== 'ok' || rolling"
                :title="b.status !== 'ok' ? '该备份不完整，禁止回退' : '回退到这个备份'"
                @click="askRollback(b)"
              >
                回退
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <input
      ref="backupInput"
      type="file"
      accept=".zip,application/zip"
      style="display: none"
      @change="uploadBackup"
    />

    <!-- 自动备份设置 -->
    <div class="card">
      <div class="card-head">
        <h2>🗂 自动备份</h2>
        <span class="text-3 small">{{ policyText }}</span>
      </div>

      <div v-if="policy" class="card-body col gap-4">
        <label class="switch">
          <input v-model="policy.autoEnabled" type="checkbox" />
          <span class="switch-track" />
          <span class="switch-text">按间隔自动备份</span>
        </label>
        <div class="form-grid">
          <div class="field">
            <label class="field-label">间隔分钟</label>
            <input v-model.number="policy.intervalMin" class="input" type="number" min="5" max="1440" />
            <span class="field-hint">每隔这么久自动备份一次</span>
          </div>
          <div class="field">
            <label class="field-label">保留份数</label>
            <input v-model.number="policy.keepN" class="input" type="number" min="1" max="200" />
            <span class="field-hint">只保留最近 N 份，多出来的交给「清理」</span>
          </div>
          <div class="field">
            <label class="field-label">最大保留天数</label>
            <input v-model.number="policy.maxAgeDays" class="input" type="number" min="0" max="3650" />
            <span class="field-hint">超过这个天数的备份会被清理</span>
          </div>
        </div>
      </div>
      <div v-else class="card-body">
        <div class="row gap-2">
          <span class="spinner" />
          <span class="text-3">正在读取自动备份设置…</span>
        </div>
      </div>

      <div v-if="policy" class="card-foot row gap-2">
        <span class="text-3 small grow">自动备份只在世界停止时执行；运行中会先跳过，等你停服后的下一次间隔。</span>
        <button class="btn btn-primary" :disabled="savingPolicy" @click="savePolicy">
          <span v-if="savingPolicy" class="spinner" style="border-top-color: #fff" />
          保存设置
        </button>
      </div>
    </div>

    <!-- 删除二次确认：要求输入完整文件名 -->
    <ConfirmDialog
      :open="showDelete"
      title="删除备份"
      :message="`将要删除这份备份文件，删除后无法恢复：\n\n${deleteTarget?.file ?? ''}\n\n如果还想留着，请先复制出去。`"
      :detail="deleteTarget ? `${fmtBytes(deleteTarget.bytes)} · ${typeText(deleteTarget.type)} · ${fmtTime(deleteTarget.created)}` : ''"
      :require-text="deleteTarget?.file ?? ''"
      require-label="输入完整的备份文件名以确认删除"
      confirm-text="删除备份"
      danger
      :busy="deleting"
      @close="((showDelete = false), (deleteTarget = null))"
      @confirm="doDelete"
    />

    <!-- 回退二次确认：把四步流程写清楚 -->
    <ConfirmDialog
      :open="showRollback"
      title="回退到这个备份"
      :message="`回退会做四件事：\n1. 先停服（停服前会保存世界）\n2. 把当前存档另存为保底目录，万一后悔还能找回来\n3. 解压这份备份覆盖存档\n4. 自动把服务器启动起来\n\n整个过程可能需要几十秒到几分钟，期间请不要关闭页面。\n\n将要使用：${rollbackTarget?.file ?? ''}`"
      :detail="rollbackTarget ? `${fmtBytes(rollbackTarget.bytes)} · 区域文件 ${rollbackTarget.regions} · ${fmtTime(rollbackTarget.created)}` : ''"
      :require-text="rollbackTarget?.file ?? ''"
      require-label="输入完整的备份文件名以确认回退"
      confirm-text="开始回退"
      :busy="rolling"
      @close="((showRollback = false), (rollbackTarget = null))"
      @confirm="doRollback"
    />

    <!-- 回退进行中：不可关闭，按阶段给提示 -->
    <Modal v-if="rolling" title="正在回退备份" size="sm" :closable="false">
      <div class="col gap-3">
        <div class="mono-block small">{{ rollbackTarget?.file }}</div>
        <div class="col gap-2">
          <div v-for="(s, i) in ROLLBACK_STAGES" :key="s.key" class="row gap-2">
            <span v-if="i < rollStage" class="dot dot-ok" />
            <span v-else-if="i === rollStage" class="spinner" />
            <span v-else class="dot dot-idle" />
            <span class="small" :class="i === rollStage ? '' : 'text-3'">{{ s.label }}</span>
          </div>
        </div>
        <p class="text-3 small">停服 → 保底 → 解压 → 启动，完成前请不要关闭或刷新页面。</p>
      </div>
    </Modal>

    <!-- 清理：先预演再执行 -->
    <Modal v-if="showCleanup && cleanupPlan" title="清理旧备份（预演结果）" size="md" @close="closeCleanup">
      <div class="col gap-3">
        <p>
          按当前策略计算，将删除 <b>{{ cleanupPlan.remove.length }}</b> 份备份，可释放
          <b>{{ fmtBytes(cleanupPlan.freed) }}</b>；清理后占用约 <b>{{ fmtBytes(cleanupPlan.totalAfter) }}</b>。
        </p>
        <div v-if="!cleanupPlan.remove.length" class="text-3 small">没有需要清理的备份，什么都不会删。</div>
        <div v-else class="col gap-2 plan-list scroll-y">
          <div v-for="b in cleanupPlan.remove" :key="b.file" class="row-between gap-2 small">
            <span class="mono ellipsis">{{ b.file }}</span>
            <span class="text-3 nowrap">{{ fmtBytes(b.bytes) }} · {{ typeText(b.type) }}</span>
          </div>
        </div>
        <div class="text-3 small">删除后无法恢复；上面这些文件里如果有你还要的，请先取消并手动处理。</div>
      </div>
      <template #footer>
        <button class="btn" :disabled="cleaning" @click="closeCleanup">取消</button>
        <button
          class="btn btn-danger-solid"
          :disabled="!cleanupPlan.remove.length || cleaning"
          @click="runCleanup"
        >
          <span v-if="cleaning" class="spinner" style="border-top-color: #fff" />
          确认删除 {{ cleanupPlan.remove.length }} 份
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/* 只做栅格与宽度微调，视觉一律来自 base.css */
.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--sp-4);
}
.wrap-right { justify-content: flex-end; margin-left: auto; }
.plan-list { max-height: 260px; }
</style>
