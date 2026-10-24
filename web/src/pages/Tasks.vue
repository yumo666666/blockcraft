<script setup lang="ts">
import UiSelect from '../components/UiSelect.vue';
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { InstanceSummary, Job } from '../lib/types.ts';
import { readBrowserSnapshot, writeBrowserSnapshot } from '../lib/browserSnapshot.ts';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import { useWorlds } from '../lib/worlds.ts';

defineOptions({ name: 'Tasks' });

interface ScheduledTask {
  id: string;
  name: string;
  instanceId: string;
  action: string;
  message: string;
  command: string;
  recurrence: { mode: 'daily' | 'weekdays' | 'once' | 'interval'; time: string; date: string; intervalDays: number; weekdays?: number[] };
  announcement: { enabled: boolean; minutes: number; text: string };
  enabled: boolean;
  createdAt: number;
  lastOccurrence: string | null;
}

interface TaskCenterSnapshot {
  version: 1;
  scheduled: ScheduledTask[];
  panelTimeZone: string;
  records: Job[];
  total: number;
  page: number;
  typeFilter: string;
  targetFilter: string;
  statusFilter: string;
}

interface TaskForm {
  id: string | null;
  name: string;
  instanceId: string;
  action: string;
  message: string;
  command: string;
  mode: 'weekdays' | 'once' | 'interval';
  time: string;
  date: string;
  intervalDays: number;
  weekdays: number[];
  announce: boolean;
  announceMinutes: number;
  announceText: string;
  enabled: boolean;
}

const ACTIONS = [
  { value: 'start', label: '启动世界' },
  { value: 'stop', label: '停止世界' },
  { value: 'save', label: '保存世界（save-all）' },
  { value: 'broadcast', label: '发送公告' },
  { value: 'restart', label: '重启世界' },
  { value: 'backup', label: '创建备份' },
  { value: 'command', label: '执行命令' },
];
const WEEKDAYS = [
  { value: 1, label: '周一' }, { value: 2, label: '周二' }, { value: 3, label: '周三' },
  { value: 4, label: '周四' }, { value: 5, label: '周五' }, { value: 6, label: '周六' }, { value: 7, label: '周日' },
];
const TYPES = [
  { value: 'create', label: '创建世界' },
  { value: 'import', label: '导入（旧记录）' },
  { value: 'world-import', label: '导入世界' },
  { value: 'pack-import', label: '导入整合包' },
  { value: 'backup-import', label: '导入备份' },
  { value: 'copy', label: '复制世界' },
  { value: 'install', label: '安装服务端' },
  { value: 'start', label: '启动' },
  { value: 'stop', label: '停止' },
  { value: 'save', label: '保存' },
  { value: 'broadcast', label: '公告' },
  { value: 'restart', label: '重启' },
  { value: 'command', label: '执行命令' },
  { value: 'backup', label: '备份' },
  { value: 'rollback', label: '回退' },
  { value: 'panel', label: '面板' },
];
const STATUSES = [
  { value: 'queued', label: '排队中' },
  { value: 'waiting', label: '延后等待中' },
  { value: 'running', label: '执行中' },
  { value: 'done', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'skipped', label: '已跳过' },
  { value: 'cancelled', label: '已取消' },
  { value: 'interrupted', label: '中断' },
];
const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUSES.map((item) => [item.value, item.label]));
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPES.map((item) => [item.value, item.label]));
const STATUS_CLASS: Record<string, string> = {
  queued: 'queued', waiting: 'waiting', running: 'running', done: 'done', failed: 'failed', skipped: 'skipped', cancelled: 'cancelled', interrupted: 'failed',
};

const cachedTasks = readBrowserSnapshot<TaskCenterSnapshot>('tasks');
const hasValidSnapshot = Boolean(
  cachedTasks?.version === 1
  && Array.isArray(cachedTasks.scheduled)
  && Array.isArray(cachedTasks.records)
  && Number.isFinite(cachedTasks.total)
  && Number.isFinite(cachedTasks.page)
);
const restoredTasks = hasValidSnapshot ? cachedTasks : null;
const { instances: worlds, acquireWorlds, releaseWorlds } = useWorlds();
const scheduled = ref<ScheduledTask[]>(restoredTasks?.scheduled ?? []);
const panelTimeZone = ref(restoredTasks?.panelTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
const records = ref<Job[]>(restoredTasks?.records ?? []);
const total = ref(restoredTasks?.total ?? 0);
const page = ref(restoredTasks?.page ?? 1);
const pageSize = 20;
const typeFilter = ref(restoredTasks?.typeFilter ?? 'all');
const targetFilter = ref(restoredTasks?.targetFilter ?? 'all');
const statusFilter = ref(restoredTasks?.statusFilter ?? 'all');
const loading = ref(!hasValidSnapshot);
const hasLoaded = ref(hasValidSnapshot);
const busy = ref(false);
const formOpen = ref(false);
const detailOpen = ref(false);
const selectedRecord = ref<Job | null>(null);
let refreshTimer: number | null = null;
let worldsHeld = false;
let firstActivation = true;

function holdWorlds(): void {
  if (worldsHeld) return;
  worldsHeld = true;
  acquireWorlds();
}
function freeWorlds(): void {
  if (!worldsHeld) return;
  worldsHeld = false;
  releaseWorlds();
}

function blankForm(): TaskForm {
  const target = panelDateTime(Date.now() + 10 * 60_000);
  return {
    id: null, name: '', instanceId: worlds.value[0]?.id ?? '', action: 'start', message: '', command: '',
    mode: 'weekdays', time: target.time, date: target.date, intervalDays: 2, weekdays: WEEKDAYS.map((day) => day.value), announce: false, announceMinutes: 5,
    announceText: '服务器将在 {n} 分钟后执行预定操作', enabled: true,
  };
}
const form = ref<TaskForm>(blankForm());
const canAnnounce = computed(() => ['start', 'stop', 'restart', 'command'].includes(form.value.action));
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const worldNames = computed(() => new Map(worlds.value.map((world) => [world.id, world.name])));

function formatTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: panelTimeZone.value, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(timestamp);
}

function panelDateTime(timestamp: number): { date: string; time: string; second: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: panelTimeZone.value,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '00';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}`, second: part('second') };
}

function duration(task: Job): string {
  const start = task.createdAt ?? task.startedAt;
  const end = task.endedAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function recurrenceLabel(task: ScheduledTask): string {
  if (task.recurrence.mode === 'daily') return `每天 ${task.recurrence.time}`;
  if (task.recurrence.mode === 'once') return `${task.recurrence.date} ${task.recurrence.time} · 单次`;
  if (task.recurrence.mode === 'weekdays') {
    const selected = (task.recurrence.weekdays ?? []).map((value) => WEEKDAYS.find((day) => day.value === value)?.label).filter(Boolean);
    return `${selected.length === 7 ? '每天' : `每周${selected.join('、')}`} ${task.recurrence.time}`;
  }
  return `每 ${task.recurrence.intervalDays} 天 · 从 ${task.recurrence.date} ${task.recurrence.time} 起`;
}

function nextRunLabel(task: ScheduledTask): string {
  if (!task.enabled) return '已停用';
  const now = panelDateTime(Date.now());
  const baseDay = new Date(`${now.date}T00:00:00Z`);
  const nowKey = `${now.date}T${now.time}:${now.second}`;
  for (let offset = 0; offset <= 366; offset += 1) {
    const day = new Date(baseDay.getTime() + offset * 86_400_000);
    const date = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
    if (task.recurrence.mode === 'once' && date !== task.recurrence.date) continue;
    if (task.recurrence.mode === 'weekdays' && !task.recurrence.weekdays?.includes(day.getUTCDay() === 0 ? 7 : day.getUTCDay())) continue;
    if (task.recurrence.mode === 'interval') {
      const anchor = new Date(`${task.recurrence.date}T00:00:00Z`);
      const difference = Math.floor((day.getTime() - anchor.getTime()) / 86_400_000);
      if (difference < 0 || difference % Math.max(1, task.recurrence.intervalDays) !== 0) continue;
    }
    if (`${date}T${task.recurrence.time}:00` <= nowKey) continue;
    return `${date} ${task.recurrence.time}`;
  }
  return '无后续执行时间';
}

function persistTaskSnapshot(): void {
  if (!hasLoaded.value) return;
  writeBrowserSnapshot<TaskCenterSnapshot>('tasks', {
    version: 1,
    scheduled: scheduled.value,
    panelTimeZone: panelTimeZone.value,
    records: records.value,
    total: total.value,
    page: page.value,
    typeFilter: typeFilter.value,
    targetFilter: targetFilter.value,
    statusFilter: statusFilter.value,
  });
}

async function load(): Promise<void> {
  const query = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize), type: typeFilter.value, target: targetFilter.value, status: statusFilter.value });
  try {
    const [scheduleData, recordData] = await Promise.all([
      api.get<{ tasks: ScheduledTask[]; timeZone?: string }>('/api/tasks/scheduled'),
      api.get<{ tasks: Job[]; total: number }>(`/api/tasks?${query}`),
    ]);
    scheduled.value = scheduleData.tasks ?? [];
    if (scheduleData.timeZone) panelTimeZone.value = scheduleData.timeZone;
    records.value = recordData.tasks ?? [];
    total.value = recordData.total ?? 0;
    hasLoaded.value = true;
    persistTaskSnapshot();
    if (detailOpen.value && selectedRecord.value && ['queued', 'waiting', 'running', 'cancelling'].includes(selectedRecord.value.status)) {
      const taskId = selectedRecord.value.id;
      void api.get<Job>(`/api/tasks/${taskId}`).then((task) => {
        if (selectedRecord.value?.id === taskId) selectedRecord.value = task;
      }).catch(() => undefined);
    }
  } catch (err) {
    toastError(err, '读取任务中心失败');
  } finally {
    loading.value = false;
  }
}

function beginRefresh(): void {
  if (refreshTimer !== null) return;
  refreshTimer = window.setInterval(() => void load(), 5000);
}
function stopRefresh(): void {
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = null;
}
function refreshFilters(): void {
  page.value = 1;
  void load();
}

function openCreate(): void {
  form.value = blankForm();
  formOpen.value = true;
}
function openEdit(task: ScheduledTask): void {
  form.value = {
    id: task.id,
    name: task.name,
    instanceId: task.instanceId,
    action: task.action,
    message: task.message,
    command: task.command,
    mode: task.recurrence.mode === 'once' || task.recurrence.mode === 'interval' ? task.recurrence.mode : 'weekdays',
    time: task.recurrence.time,
    date: task.recurrence.date || panelDateTime(Date.now()).date,
    intervalDays: task.recurrence.intervalDays,
    weekdays: task.recurrence.weekdays?.length ? [...task.recurrence.weekdays] : WEEKDAYS.map((day) => day.value),
    announce: task.announcement.enabled,
    announceMinutes: task.announcement.minutes,
    announceText: task.announcement.text,
    enabled: task.enabled,
  };
  formOpen.value = true;
}

async function saveTask(): Promise<void> {
  if (!form.value.instanceId) {
    toast('error', '还没有可选世界', '请先创建或导入一个世界');
    return;
  }
  if (form.value.mode === 'weekdays' && form.value.weekdays.length === 0) {
    toast('error', '请选择执行日期', '至少勾选周一到周日中的一天');
    return;
  }
  if (form.value.action === 'broadcast' && !form.value.message.trim()) {
    toast('error', '公告内容不能为空');
    return;
  }
  if (form.value.action === 'command' && !form.value.command.trim()) {
    toast('error', '请输入服务器命令');
    return;
  }
  busy.value = true;
  const payload = {
    name: form.value.name,
    instanceId: form.value.instanceId,
    action: form.value.action,
    message: form.value.message,
    command: form.value.command,
    recurrence: {
      mode: form.value.mode,
      time: form.value.time,
      date: form.value.mode === 'weekdays' ? '' : form.value.date,
      intervalDays: form.value.intervalDays,
      weekdays: [...form.value.weekdays].sort((a, b) => a - b),
    },
    announcement: { enabled: canAnnounce.value && form.value.announce, minutes: form.value.announceMinutes, text: form.value.announceText },
    enabled: form.value.enabled,
  };
  try {
    if (form.value.id) await api.put(`/api/tasks/scheduled/${form.value.id}`, payload);
    else await api.post('/api/tasks/scheduled', payload);
    formOpen.value = false;
    toast('ok', form.value.id ? '定时任务已更新' : '定时任务已创建');
    await load();
  } catch (err) {
    toastError(err, '保存定时任务失败');
  } finally {
    busy.value = false;
  }
}

async function toggleTask(task: ScheduledTask): Promise<void> {
  try {
    const result = await api.patch<{ task: ScheduledTask }>(`/api/tasks/scheduled/${task.id}`, { enabled: !task.enabled });
    scheduled.value = scheduled.value.map((item) => item.id === task.id ? result.task : item);
    persistTaskSnapshot();
  } catch (err) {
    toastError(err, '更新任务状态失败');
  }
}

async function deleteTask(task: ScheduledTask): Promise<void> {
  if (!window.confirm(`删除定时任务「${task.name}」？`)) return;
  try {
    await api.del(`/api/tasks/scheduled/${task.id}`);
    scheduled.value = scheduled.value.filter((item) => item.id !== task.id);
    persistTaskSnapshot();
    toast('ok', '定时任务已删除');
  } catch (err) {
    toastError(err, '删除定时任务失败');
  }
}

async function runTask(task: ScheduledTask): Promise<void> {
  try {
    const result = await api.post<{ status?: string }>(`/api/tasks/scheduled/${task.id}/run`);
    if (task.action === 'backup' && result.status === 'waiting') toast('ok', '备份任务已延后等待', '目标世界停止后会自动开始备份');
    else toast('ok', '任务已加入执行队列');
    await load();
  } catch (err) {
    toastError(err, '启动任务失败');
  }
}

async function openRecord(record: Job): Promise<void> {
  try {
    selectedRecord.value = await api.get<Job>(`/api/tasks/${record.id}`);
    detailOpen.value = true;
  } catch (err) {
    toastError(err, '读取任务详情失败');
  }
}

onMounted(() => { holdWorlds(); void load(); beginRefresh(); });
onActivated(() => {
  holdWorlds();
  if (firstActivation) { firstActivation = false; return; }
  void load();
  beginRefresh();
});
onDeactivated(() => { stopRefresh(); freeWorlds(); });
onUnmounted(() => { stopRefresh(); freeWorlds(); });
</script>

<template>
  <div class="page task-center col gap-4">
    <header class="task-page-heading row-between wrap gap-3">
      <div class="page-heading">
        <h1>任务中心</h1>
        <p>管理定时操作，并查看世界和面板的执行记录。</p>
      </div>
      <button class="btn btn-primary" @click="openCreate"><Icon name="plus" :size="16" />新建定时任务</button>
    </header>

    <section class="card">
      <div class="card-head row-between wrap gap-3">
        <h2><span class="head-icon"><Icon name="clock" :size="15" /></span>定时任务</h2>
        <span class="text-3 small">{{ scheduled.length }} 项</span>
      </div>
      <div v-if="loading && !hasLoaded" class="card-body task-schedule-skeleton" aria-hidden="true">
        <div v-for="item in 3" :key="item" class="task-skeleton-row"><span class="skeleton" /><span class="skeleton" /><span class="skeleton" /></div>
      </div>
      <div v-else-if="!scheduled.length" class="empty task-empty">
        <span class="empty-icon"><Icon name="clock" :size="20" /></span>
        <strong>还没有定时任务</strong>
        <span>创建每日、指定日期或按间隔重复执行的世界操作。</span>
        <button class="btn btn-soft" @click="openCreate">创建第一个任务</button>
      </div>
      <div v-else class="task-schedule-list">
        <article v-for="task in scheduled" :key="task.id" class="task-schedule-item" :class="{ disabled: !task.enabled }">
          <div class="task-schedule-main">
            <div class="row gap-2 wrap">
              <strong>{{ task.name }}</strong>
              <span class="task-state" :class="task.enabled ? 'state-on' : 'state-off'">{{ task.enabled ? '已启用' : '已停用' }}</span>
            </div>
            <div class="task-schedule-meta">
              <span>{{ worldNames.get(task.instanceId) ?? task.instanceId }}</span>
              <span>{{ ACTIONS.find((action) => action.value === task.action)?.label ?? task.action }}</span>
              <span>{{ recurrenceLabel(task) }}</span>
              <span>下次：{{ nextRunLabel(task) }}</span>
              <span v-if="task.announcement.enabled">提前 {{ task.announcement.minutes }} 分钟公告</span>
              <span v-if="task.lastOccurrence">上次执行：{{ task.lastOccurrence.replace('T', ' ') }}</span>
            </div>
          </div>
          <div class="row gap-2 wrap task-schedule-actions">
            <button class="btn btn-xs btn-soft" title="立即执行" @click="runTask(task)"><Icon name="play" :size="14" />运行</button>
            <button class="btn btn-xs btn-soft" @click="openEdit(task)">编辑</button>
            <button class="btn btn-xs btn-soft" @click="toggleTask(task)">{{ task.enabled ? '停用' : '启用' }}</button>
            <button class="btn btn-xs btn-danger-soft" @click="deleteTask(task)">删除</button>
          </div>
        </article>
      </div>
    </section>

    <section class="card">
      <div class="card-head row-between wrap gap-3">
        <h2><span class="head-icon"><Icon name="events" :size="15" /></span>任务记录</h2>
        <span class="text-3 small">共 {{ total }} 条 · 每页 {{ pageSize }} 条</span>
      </div>
      <div class="card-body task-filters">
        <label class="field"><span class="field-label">类型</span><UiSelect v-model="typeFilter" class="input" @change="refreshFilters"><option value="all">全部类型</option><option v-for="item in TYPES" :key="item.value" :value="item.value">{{ item.label }}</option></UiSelect></label>
        <label class="field"><span class="field-label">目标</span><UiSelect v-model="targetFilter" class="input" @change="refreshFilters"><option value="all">全部目标</option><option value="panel">面板任务</option><option v-for="world in worlds" :key="world.id" :value="world.id">{{ world.name }}</option></UiSelect></label>
        <label class="field"><span class="field-label">状态</span><UiSelect v-model="statusFilter" class="input" @change="refreshFilters"><option value="all">全部状态</option><option v-for="item in STATUSES" :key="item.value" :value="item.value">{{ item.label }}</option></UiSelect></label>
        <button class="btn btn-soft task-refresh" :disabled="loading" @click="load"><Icon name="undo" :size="15" />刷新</button>
      </div>
      <div v-if="loading && !hasLoaded" class="card-body task-record-skeleton" aria-hidden="true"><span v-for="item in 6" :key="item" class="skeleton" /></div>
      <div v-else-if="!records.length" class="empty task-record-empty">没有符合筛选条件的任务记录。</div>
      <div v-else class="task-table-wrap">
        <table class="task-table">
          <thead><tr><th>任务</th><th>目标</th><th>状态</th><th>提交时间</th><th>耗时</th><th>阶段</th></tr></thead>
          <tbody>
            <tr v-for="record in records" :key="record.id" tabindex="0" @click="openRecord(record)" @keydown.enter="openRecord(record)" @keydown.space.prevent="openRecord(record)">
              <td><strong>{{ record.title }}</strong><small>{{ TYPE_LABEL[record.kind] ?? record.kind }}<template v-if="record.source === 'scheduled'"> · 定时任务</template><template v-else-if="record.source === 'system'"> · 系统任务</template></small></td>
              <td>{{ record.instanceId ? (worldNames.get(record.instanceId) ?? record.instanceId) : '面板' }}</td>
              <td><span class="task-status" :class="`status-${STATUS_CLASS[record.status] ?? 'failed'}`">{{ STATUS_LABEL[record.status] ?? record.status }}</span></td>
              <td>{{ formatTime(record.createdAt ?? record.startedAt) }}</td>
              <td>{{ duration(record) }}</td>
              <td><span class="task-stage">{{ record.stages.find((stage) => stage.status === 'running')?.label ?? record.stages.at(-1)?.label ?? '—' }}</span><small v-if="record.status === 'queued'">队列中</small><small v-else-if="record.status === 'waiting'">等待目标世界停止</small><small v-else>{{ record.progress }}%</small></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="total > pageSize" class="card-foot row-between task-pagination">
        <span class="text-3 small">第 {{ page }} / {{ pageCount }} 页</span>
        <div class="row gap-2"><button class="btn btn-xs btn-soft" :disabled="page <= 1" @click="page--; load()">上一页</button><button class="btn btn-xs btn-soft" :disabled="page >= pageCount" @click="page++; load()">下一页</button></div>
      </div>
    </section>

    <Modal v-if="formOpen" :title="form.id ? '编辑定时任务' : '新建定时任务'" size="lg" @close="formOpen = false">
      <form class="task-form col gap-4" @submit.prevent="saveTask">
        <div class="form-grid-2">
          <label class="field"><span class="field-label">任务名称</span><input v-model="form.name" class="input" maxlength="80" placeholder="例如：每日自动保存" /></label>
          <label class="field"><span class="field-label">目标世界</span><UiSelect v-model="form.instanceId" class="input" required><option value="" disabled>选择世界</option><option v-for="world in worlds" :key="world.id" :value="world.id">{{ world.name }}</option></UiSelect></label>
          <label class="field"><span class="field-label">任务内容</span><UiSelect v-model="form.action" class="input"><option v-for="action in ACTIONS" :key="action.value" :value="action.value">{{ action.label }}</option></UiSelect></label>
          <fieldset class="task-mode-group field-span-2">
            <legend class="field-label">执行方式</legend>
            <div class="task-mode-options">
              <label class="task-mode-option" :class="{ active: form.mode === 'weekdays' }"><input v-model="form.mode" type="radio" value="weekdays" /><span>按星期重复</span></label>
              <label class="task-mode-option" :class="{ active: form.mode === 'once' }"><input v-model="form.mode" type="radio" value="once" /><span>指定日期一次</span></label>
              <label class="task-mode-option" :class="{ active: form.mode === 'interval' }"><input v-model="form.mode" type="radio" value="interval" /><span>每隔几天</span></label>
            </div>
          </fieldset>
          <fieldset v-if="form.mode === 'weekdays'" class="task-weekdays-group field-span-2">
            <legend class="field-label">执行日期 <small>全选即每天</small></legend>
            <div class="task-weekday-options">
              <label v-for="day in WEEKDAYS" :key="day.value" class="task-weekday-option" :class="{ active: form.weekdays.includes(day.value) }">
                <input v-model="form.weekdays" type="checkbox" :value="day.value" />{{ day.label }}
              </label>
            </div>
          </fieldset>
          <label v-if="form.mode !== 'weekdays'" class="field"><span class="field-label">{{ form.mode === 'once' ? '执行日期' : '开始日期' }}</span><input v-model="form.date" class="input" type="date" required /></label>
          <label class="field"><span class="field-label">执行时间</span><input v-model="form.time" class="input" type="time" required /></label>
          <label v-if="form.mode === 'interval'" class="field"><span class="field-label">间隔天数</span><input v-model.number="form.intervalDays" class="input" type="number" min="1" max="365" required /></label>
        </div>
        <label v-if="form.action === 'broadcast'" class="field"><span class="field-label">公告内容</span><textarea v-model="form.message" class="input task-textarea" maxlength="500" required placeholder="发送给当前世界在线玩家的公告" /></label>
        <label v-if="form.action === 'command'" class="field"><span class="field-label">服务器命令</span><input v-model="form.command" class="input mono" maxlength="1000" required placeholder="例如：weather clear" /></label>
        <div v-if="canAnnounce" class="task-announcement">
          <label class="switch"><input v-model="form.announce" type="checkbox" /><span class="switch-track" /><span class="switch-text">执行前在世界里发送公告</span></label>
          <div v-if="form.announce" class="form-grid-2 task-announcement-fields">
            <label class="field"><span class="field-label">提前分钟数</span><input v-model.number="form.announceMinutes" class="input" type="number" min="1" max="1440" /></label>
            <label class="field field-span-2"><span class="field-label">公告内容</span><input v-model="form.announceText" class="input" maxlength="500" placeholder="用 {n} 代表剩余分钟数" /></label>
          </div>
        </div>
        <p class="task-form-note">停止、保存、重启、命令和公告任务会在执行时检查世界状态：世界未运行则标记为“已跳过”，之后不会补执行；启动任务遇到已运行的世界也会跳过。备份任务遇到运行中的世界时会延后等待，世界停止后再自动执行。</p>
      </form>
      <template #footer><button class="btn btn-soft" @click="formOpen = false">取消</button><button class="btn btn-primary" :disabled="busy || !form.instanceId" @click="saveTask"><span v-if="busy" class="spinner spinner-on-accent" />保存任务</button></template>
    </Modal>

    <Modal v-if="detailOpen && selectedRecord" :title="selectedRecord.title" size="lg" @close="detailOpen = false">
      <div class="task-detail col gap-4">
        <div class="task-detail-summary">
          <div><span>任务类型</span><strong>{{ TYPE_LABEL[selectedRecord.kind] ?? selectedRecord.kind }}</strong></div>
          <div><span>目标</span><strong>{{ selectedRecord.instanceId ? (worldNames.get(selectedRecord.instanceId) ?? selectedRecord.instanceId) : '面板' }}</strong></div>
          <div><span>状态</span><strong><span class="task-status" :class="`status-${STATUS_CLASS[selectedRecord.status] ?? 'failed'}`">{{ STATUS_LABEL[selectedRecord.status] ?? selectedRecord.status }}</span></strong></div>
          <div><span>耗时</span><strong>{{ duration(selectedRecord) }}</strong></div>
          <div><span>开始</span><strong>{{ formatTime(selectedRecord.startedAt) }}</strong></div>
          <div><span>结束</span><strong>{{ formatTime(selectedRecord.endedAt) }}</strong></div>
        </div>
        <section class="task-detail-section"><h3>执行阶段</h3><div v-if="selectedRecord.stages.length" class="task-detail-stages"><div v-for="stage in selectedRecord.stages" :key="stage.key"><span class="task-stage-dot" :class="`stage-${stage.status}`" /><span>{{ stage.label }}</span><small>{{ stage.status === 'done' ? '完成' : stage.status === 'running' ? '执行中' : stage.status === 'failed' ? '失败' : stage.status === 'cancelled' ? '跳过/取消' : '等待' }}</small></div></div><p v-else class="text-3 small">没有分阶段信息。</p></section>
        <section class="task-detail-section"><h3>执行日志</h3><pre class="task-log">{{ selectedRecord.lines.length ? selectedRecord.lines.join('\n') : '暂无日志' }}</pre></section>
        <p v-if="selectedRecord.error" class="task-error">{{ selectedRecord.error }}</p>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.task-center { min-width: 0; }
.task-page-heading { align-items: flex-end; }
.task-page-heading .page-heading { min-width: 230px; }
.task-page-heading .page-heading p { max-width: min(72vw, 920px); }
.task-filters { display: grid; grid-template-columns: minmax(170px, 1fr) minmax(190px, 1.2fr) minmax(150px, .8fr) auto; align-items: end; gap: var(--sp-3); }
.task-refresh { min-height: 38px; }
.task-schedule-list { display: flex; flex-direction: column; }
.task-schedule-item { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px 20px; border-top: 1px solid var(--border); }
.task-schedule-item.disabled { opacity: .7; }
.task-schedule-main { min-width: 0; display: grid; gap: 8px; }
.task-schedule-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--text-3); font-size: 12px; }
.task-state, .task-status { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 9px; font-size: 12px; font-weight: 700; white-space: nowrap; }
.state-on, .status-done { color: var(--success-strong, #16856e); background: var(--success-soft, #dff5ed); }
.state-off, .status-cancelled { color: var(--text-3); background: var(--surface-2); }
.status-running { color: var(--accent-strong); background: var(--accent-soft); }
.status-queued { color: #946000; background: #fff1c9; }
.status-waiting { color: #5b63a8; background: #eceeff; }
.status-failed { color: var(--danger); background: var(--danger-soft); }
.status-skipped { color: #796225; background: #fff2d5; }
.task-table-wrap { overflow-x: auto; }
.task-table { width: 100%; border-collapse: collapse; text-align: left; min-width: 740px; }
.task-table th { padding: 11px 16px; color: var(--text-3); font-size: 12px; font-weight: 650; white-space: nowrap; border-top: 1px solid var(--border); }
.task-table td { padding: 13px 16px; border-top: 1px solid var(--border); font-size: 13px; }
.task-table tbody tr { cursor: pointer; transition: background .15s; }
.task-table tbody tr:hover { background: var(--surface-hover, rgba(39, 116, 173, .06)); }
.task-table tbody tr:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; background: var(--surface-hover, rgba(39, 116, 173, .06)); }
.task-table td:first-child { min-width: 250px; }
.task-table td strong, .task-table td small { display: block; }
.task-table td small { color: var(--text-3); margin-top: 4px; font-size: 11px; }
.task-stage { display: block; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-pagination { padding-top: 12px; }
.task-empty { display: grid; justify-items: center; gap: 10px; padding: 34px 16px; }
.task-empty > span:not(.empty-icon) { color: var(--text-3); font-size: 13px; text-align: center; }
.task-record-empty { padding: 28px; }
.empty-icon { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 12px; color: var(--accent); background: var(--accent-soft); }
.task-form { min-width: 0; }
.task-mode-group, .task-weekdays-group { min-width: 0; margin: 0; padding: 0; border: 0; }
.task-mode-group legend, .task-weekdays-group legend { margin-bottom: 5px; }
.task-mode-options, .task-weekday-options { display: flex; flex-wrap: wrap; gap: 8px; }
.task-mode-option, .task-weekday-option { position: relative; display: inline-flex; align-items: center; justify-content: center; height: 35px; min-height: 35px; padding: 0 13px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); color: var(--text-2); cursor: pointer; transition: border-color .15s, background .15s, color .15s; }
.task-mode-option input, .task-weekday-option input { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; clip-path: inset(50%); }
.task-mode-option.active, .task-weekday-option.active { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
.task-mode-option:focus-within, .task-weekday-option:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.task-weekday-options { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.task-weekday-option { justify-content: center; white-space: nowrap; }
.task-weekdays-group legend small { margin-left: 8px; color: var(--text-3); font-size: 12px; font-weight: 400; }
.task-textarea { min-height: 92px; resize: vertical; }
.task-announcement { display: grid; gap: 14px; border: 1px solid var(--border); border-radius: var(--r); padding: 14px; background: var(--surface-2); }
.task-announcement-fields { padding-left: 32px; }
.task-form-note { margin: 0; color: var(--text-3); font-size: 12px; line-height: 1.6; }
.task-detail-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.task-detail-summary > div { display: grid; gap: 5px; padding: 11px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm); min-width: 0; }
.task-detail-summary > div > span { color: var(--text-3); font-size: 11px; }
.task-detail-summary strong { overflow-wrap: anywhere; font-size: 13px; }
.task-detail-section { display: grid; gap: 10px; }
.task-detail-section h3 { margin: 0; font-size: 14px; }
.task-detail-stages { display: grid; gap: 8px; }
.task-detail-stages > div { display: grid; grid-template-columns: 10px 1fr auto; align-items: center; gap: 9px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-sm); font-size: 13px; }
.task-detail-stages small { color: var(--text-3); }
.task-stage-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border-strong, #aab8c8); }
.stage-done { background: var(--success, #17977a); }.stage-running { background: var(--accent); }.stage-failed { background: var(--danger); }.stage-cancelled { background: #be8a14; }
.task-log { max-height: 320px; overflow: auto; margin: 0; padding: 13px 15px; color: #e7ebf1; background: #343941; border-radius: var(--r-sm); font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.task-error { margin: 0; padding: 10px 12px; color: var(--danger); background: var(--danger-soft); border-radius: var(--r-sm); font-size: 13px; }
.task-schedule-skeleton, .task-record-skeleton { display: grid; gap: 10px; }
.task-skeleton-row { display: grid; grid-template-columns: 1fr 2fr 100px; gap: 14px; padding: 12px 0; border-top: 1px solid var(--border); }
.task-skeleton-row .skeleton { height: 20px; border-radius: 6px; }
.task-record-skeleton .skeleton { height: 38px; border-radius: 6px; }
@media (max-width: 760px) {
  .task-page-heading { align-items: stretch; }
  .task-page-heading > .btn { align-self: flex-start; }
  .task-page-heading .page-heading { min-width: 0; }
  .task-page-heading .page-heading p { max-width: 100%; }
  .task-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .task-refresh { width: 100%; }
  .task-schedule-item { align-items: flex-start; flex-direction: column; }
  .task-schedule-actions { width: 100%; }
  .task-detail-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
  .task-weekday-options { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .task-mode-option, .task-weekday-option { height: 44px; min-height: 44px; }
}
@media (max-width: 480px) {
  .task-filters { grid-template-columns: 1fr; }
  .task-detail-summary { grid-template-columns: 1fr; }
  .task-weekday-option { justify-content: center; padding-inline: 8px; }
}
</style>
