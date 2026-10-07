<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, subscribe } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import { fmtDuration, fmtTime, STATUS_TEXT, statusClass } from '../lib/format.ts';
import type { ConsoleLine, InstanceDetail, ScheduleInfo } from '../lib/types.ts';
import { applySuggestion, suggest, type Suggestion } from '../lib/commands.ts';

const props = defineProps<{ id: string }>();
const router = useRouter();

/** 本地最多留多少行（服务端缓冲也是有限长度，两边都封顶才不会越看越卡） */
const MAX_LINES = 200;
/** 重连等待时间 */
const RETRY_MS = 1500;
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const RUNNING_STATUS = ['running', 'starting', 'stopping', 'stuck'];

const detail = ref<InstanceDetail | null>(null);
const lines = ref<ConsoleLine[]>([]);
const paused = ref(false);
const pending = ref<ConsoleLine[]>([]);
const autoScroll = ref(true);
const filter = ref('');
const consoleEl = ref<HTMLElement | null>(null);
const streaming = ref('');

interface Shortcut {
  label: string;
  cmd: string;
  group: string;
  needsArg?: boolean;
  danger?: boolean;
  hint?: string;
}

const shortcuts = ref<Shortcut[]>([]);
const cmd = ref('');
const sending = ref(false);
const history = ref<string[]>([]);

/** 按 group 分组后的快捷命令，模板里按组渲染 */
const shortcutGroups = computed(() => {
  const map = new Map<string, Shortcut[]>();
  for (const s of shortcuts.value) {
    const arr = map.get(s.group) ?? [];
    arr.push(s);
    map.set(s.group, arr);
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }));
});

// ---------------------------------------------------------------- 命令补全
const suggestions = ref<Suggestion[]>([]);
const suggestIndex = ref(0);
const suggestOpen = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);
const onlinePlayers = ref<string[]>([]);

function refreshSuggest(): void {
  suggestions.value = suggest(cmd.value, onlinePlayers.value);
  suggestIndex.value = 0;
  suggestOpen.value = suggestions.value.length > 0 && cmd.value.trim().length > 0;
}

async function loadOnlinePlayers(): Promise<void> {
  try {
    const r = await api.get<{ names: string[] }>(`/api/instances/${props.id}/players/online`);
    onlinePlayers.value = r.names ?? [];
  } catch {
    onlinePlayers.value = [];
  }
}

/** 当前高亮的候选（用于底部那行中文说明） */
const currentHint = computed(() => suggestions.value[suggestIndex.value] ?? null);

function pickSuggestion(s?: Suggestion): void {
  const target = s ?? suggestions.value[suggestIndex.value];
  if (!target) return;
  cmd.value = applySuggestion(cmd.value, target);
  suggestions.value = suggest(cmd.value, onlinePlayers.value);
  suggestIndex.value = 0;
  suggestOpen.value = false;
  nextTick(() => inputEl.value?.focus());
}

function onCmdKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    suggestOpen.value = false;
    return;
  }
  if (e.key === 'Tab') {
    if (suggestions.value.length) {
      e.preventDefault();
      pickSuggestion();
    }
    return;
  }
  if (e.key === 'ArrowDown' && suggestions.value.length) {
    e.preventDefault();
    suggestOpen.value = true;
    suggestIndex.value = (suggestIndex.value + 1) % suggestions.value.length;
    return;
  }
  if (e.key === 'ArrowUp' && suggestions.value.length) {
    e.preventDefault();
    suggestOpen.value = true;
    suggestIndex.value = (suggestIndex.value - 1 + suggestions.value.length) % suggestions.value.length;
    return;
  }
  if (e.key === 'Enter') {
    const typed = cmd.value.trim();
    const hit = suggestions.value[suggestIndex.value];
    // 只是「打了半个命令名」时，回车先补全，不把半截命令发出去（游戏里也是这个手感）
    if (suggestOpen.value && hit && hit.value.trim().startsWith(typed) && hit.value.trim() !== typed) {
      e.preventDefault();
      pickSuggestion(hit);
      return;
    }
    suggestOpen.value = false;
    void send(cmd.value);
  }
}

/** 点快捷命令：需要参数的只填前缀并把光标放好，不需要的直接发 */
function useShortcut(s: Shortcut): void {
  if (s.needsArg) {
    cmd.value = s.cmd;
    refreshSuggest();
    nextTick(() => inputEl.value?.focus());
    return;
  }
  void send(s.cmd);
}

const sched = ref<ScheduleInfo | null>(null);
const startTimesText = ref('');
const stopTimesText = ref('');
const savingSchedule = ref(false);
const testingWarn = ref(false);

let offStream: (() => void) | null = null;
let retryTimer: number | null = null;
let pollTimer: number | null = null;
let lastSeq = 0;
let closed = false;

const instance = computed(() => detail.value?.instance ?? null);
const running = computed(() => (instance.value ? RUNNING_STATUS.includes(instance.value.status) : false));

const filteredLines = computed(() => {
  const kw = filter.value.trim().toLowerCase();
  if (!kw) return lines.value;
  return lines.value.filter((l) => l.text.toLowerCase().includes(kw));
});

function lineClass(text: string): string {
  if (/ERROR|FATAL|Exception/.test(text)) return 'error';
  if (/WARN/.test(text)) return 'warn';
  if (text.startsWith('[面板]')) return 'panel';
  return '';
}

function badgeClass(status: string): string {
  switch (status) {
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

// ---------------------------------------------------------------- 日志

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const el = consoleEl.value;
  if (el && autoScroll.value) el.scrollTop = el.scrollHeight;
}

function pushLine(row: ConsoleLine): void {
  lines.value.push(row);
  if (lines.value.length > MAX_LINES) lines.value.splice(0, lines.value.length - MAX_LINES);
}

/** 收到一批日志：按 seq 去重、排序，暂停时先存进待显示缓冲 */
function receive(rows: ConsoleLine[]): void {
  const fresh = rows.filter((r) => r.seq > lastSeq).sort((a, b) => a.seq - b.seq);
  if (!fresh.length) return;
  lastSeq = fresh[fresh.length - 1].seq;
  if (streaming.value) streaming.value = '';
  if (paused.value) {
    for (const r of fresh) pending.value.push(r);
    if (pending.value.length > MAX_LINES) pending.value.splice(0, pending.value.length - MAX_LINES);
    return;
  }
  for (const r of fresh) pushLine(r);
  void scrollToBottom();
}

/** 按 seq 拉一次（首次只拉最近 MAX_LINES 行，断线后补拉断线期间的） */
async function fetchConsole(): Promise<void> {
  try {
    // 首次就只要 200 行：反正界面上也只保留这么多，别白拉几千行过来
    const q = lastSeq > 0 ? `?since=${lastSeq}` : `?lines=${MAX_LINES}`;
    const r = await api.get<{ lines: ConsoleLine[]; seq: number }>(`/api/instances/${props.id}/console${q}`);
    if (r.lines?.length) {
      receive(r.lines);
    } else if (lastSeq > 0 && r.seq > lastSeq) {
      // 服务端缓冲已经滚过这一段，追不回来了，只把游标对齐
      lastSeq = r.seq;
    }
  } catch (err) {
    toastError(err, '读取控制台日志失败');
  }
}

function connect(): void {
  offStream?.();
  offStream = subscribe<ConsoleLine>(
    `/api/instances/${props.id}/console/stream?since=${lastSeq}`,
    (line) => receive([line]),
    {
      onError: () => {
        streaming.value = '连接断开，正在重连…';
        reconnect();
      },
    },
  );
}

/** 断线：先停掉内置重连（它会带着旧 since 重连），再用最新 seq 补拉 + 重订阅 */
function reconnect(): void {
  offStream?.();
  offStream = null;
  if (closed || retryTimer) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    if (closed) return;
    void fetchConsole().then(() => {
      if (closed) return;
      connect();
    });
  }, RETRY_MS);
}

function onConsoleScroll(): void {
  const el = consoleEl.value;
  if (!el) return;
  // 手动往上滚就关掉自动滚动；滚回底部再打开
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

function togglePause(): void {
  paused.value = !paused.value;
  if (!paused.value) {
    for (const r of pending.value) pushLine(r);
    pending.value = [];
    void scrollToBottom();
  }
}

// ---------------------------------------------------------------- 命令

function remember(text: string): void {
  history.value = [text, ...history.value.filter((h) => h !== text)].slice(0, 8);
}

async function send(text: string): Promise<void> {
  const value = (text ?? '').trim();
  if (!value || sending.value) return;
  sending.value = true;
  try {
    // 命令与回显由服务端推进日志缓冲，SSE 会带回来，本地不重复插
    await api.post<{ ok: boolean; output: string }>(`/api/instances/${props.id}/command`, { cmd: value });
    cmd.value = '';
    suggestions.value = [];
    suggestOpen.value = false;
    remember(value);
    autoScroll.value = true;
    void scrollToBottom();
    void loadOnlinePlayers();
  } catch (err) {
    toastError(err, '命令发送失败');
  } finally {
    sending.value = false;
  }
}

// ---------------------------------------------------------------- 数据加载

async function loadDetail(): Promise<void> {
  try {
    detail.value = await api.get<InstanceDetail>(`/api/instances/${props.id}`);
  } catch (err) {
    toastError(err, '读取世界信息失败');
  }
}

async function loadShortcuts(): Promise<void> {
  try {
    const r = await api.get<{ shortcuts: Shortcut[] }>(`/api/instances/${props.id}/shortcuts`);
    shortcuts.value = r.shortcuts ?? [];
  } catch (err) {
    toastError(err, '读取快捷命令失败');
  }
}

function parseTimes(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function fillTimes(r: ScheduleInfo): void {
  startTimesText.value = (r.schedule.start.times ?? []).join(', ');
  stopTimesText.value = (r.schedule.stop.times ?? []).join(', ');
}

async function loadSchedule(): Promise<void> {
  try {
    const r = await api.get<ScheduleInfo>(`/api/instances/${props.id}/schedule`);
    sched.value = r;
    fillTimes(r);
  } catch (err) {
    toastError(err, '读取定时设置失败');
  }
}

function toggleDay(which: 'start' | 'stop', day: number): void {
  const cur = sched.value;
  if (!cur) return;
  const days = cur.schedule[which].days;
  const i = days.indexOf(day);
  if (i >= 0) days.splice(i, 1);
  else days.push(day);
  days.sort((a, b) => a - b);
}

async function saveSchedule(): Promise<void> {
  const cur = sched.value;
  if (!cur) return;
  savingSchedule.value = true;
  try {
    const payload = {
      ...cur.schedule,
      start: { ...cur.schedule.start, times: parseTimes(startTimesText.value) },
      stop: { ...cur.schedule.stop, times: parseTimes(stopTimesText.value) },
    };
    const r = await api.put<{ ok: boolean; schedule: ScheduleInfo['schedule']; describe: string; nextStart: number | null; nextStop: number | null }>(
      `/api/instances/${props.id}/schedule`,
      payload,
    );
    sched.value = { ...cur, schedule: r.schedule, describe: r.describe, nextStart: r.nextStart, nextStop: r.nextStop };
    fillTimes(sched.value);
    toast('ok', '定时设置已保存', r.describe);
  } catch (err) {
    toastError(err, '保存定时设置失败');
  } finally {
    savingSchedule.value = false;
  }
}

async function testWarn(): Promise<void> {
  testingWarn.value = true;
  try {
    const minutes = Number(sched.value?.schedule.warnMinutes ?? 5);
    const r = await api.post<{ ok: boolean; text: string }>(`/api/instances/${props.id}/schedule/test-warn`, { minutes });
    toast('ok', '测试公告已发送', r.text);
  } catch (err) {
    toastError(err, '测试公告失败');
  } finally {
    testingWarn.value = false;
  }
}

// ---------------------------------------------------------------- 生命周期

function reset(): void {
  offStream?.();
  offStream = null;
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  closed = false;
  lastSeq = 0;
  lines.value = [];
  pending.value = [];
  paused.value = false;
  autoScroll.value = true;
  filter.value = '';
  streaming.value = '';
  detail.value = null;
  sched.value = null;
}

async function boot(): Promise<void> {
  await Promise.all([loadDetail(), loadShortcuts(), loadSchedule(), loadOnlinePlayers()]);
  await fetchConsole();
  if (closed) return;
  connect();
}

onMounted(async () => {
  await boot();
  if (closed) return;
  pollTimer = window.setInterval(loadDetail, 8000);
});

onUnmounted(() => {
  closed = true;
  offStream?.();
  offStream = null;
  if (retryTimer) window.clearTimeout(retryTimer);
  if (pollTimer) window.clearInterval(pollTimer);
});

// 同一个组件实例在不同世界之间跳转时要整套重来，否则会把上一个世界的日志留在屏幕上
watch(
  () => props.id,
  async () => {
    reset();
    await boot();
  },
);
</script>

<template>
  <div class="page col gap-4">
    <!-- 头部：返回 + 世界名 + 状态 + 运行时长 + 在线人数 -->
    <div class="row-between wrap gap-3">
      <div class="row gap-3">
        <button class="btn btn-ghost btn-sm" @click="router.push('/')">← 返回总览</button>
        <div class="row gap-2">
          <i class="dot" :class="instance ? statusClass(instance.status) : 'dot-idle'" />
          <h1 class="ellipsis">{{ instance?.name ?? props.id }}</h1>
        </div>
        <span class="badge" :class="instance ? badgeClass(instance.status) : 'badge-outline'">
          {{ instance ? STATUS_TEXT[instance.status] ?? instance.status : '读取中' }}
        </span>
      </div>
      <div class="head-stats">
        <div class="stat">
          <span class="stat-label">运行时长</span>
          <span class="stat-value">{{ instance && running ? fmtDuration(instance.uptime) : '—' }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">在线人数</span>
          <span class="stat-value">{{ instance ? `${instance.players}/${instance.maxPlayers}` : '—' }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">端口</span>
          <span class="stat-value mono">{{ instance?.port ?? '—' }}</span>
        </div>
      </div>
    </div>

    <!-- 左右两栏：左宽（日志）右窄（快捷命令） -->
    <div class="console-grid">
      <div class="card console-card">
        <div class="card-head">
          <h2>🖥 控制台</h2>
          <div class="row gap-2 wrap">
            <span v-if="streaming" class="badge badge-warn">{{ streaming }}</span>
            <span v-if="paused" class="badge badge-info">已暂停{{ pending.length ? ` · 待显示 ${pending.length}` : '' }}</span>
            <label class="switch">
              <input v-model="autoScroll" type="checkbox" />
              <span class="switch-track" />
              <span class="switch-text">自动滚动</span>
            </label>
            <button class="btn btn-sm" @click="togglePause">{{ paused ? '继续' : '暂停' }}</button>
            <input v-model="filter" class="input filter-input" placeholder="过滤关键字" />
          </div>
        </div>
        <div class="card-body console-body">
          <div ref="consoleEl" class="console" @scroll.passive="onConsoleScroll">
            <div v-if="!filteredLines.length" class="console-empty">
              {{ filter ? '没有匹配的日志行' : '还没有日志。世界启动后这里会实时输出。' }}
            </div>
            <div v-for="l in filteredLines" :key="l.seq" class="console-line" :class="lineClass(l.text)">{{ l.text }}</div>
          </div>
        </div>

        <!-- 命令输入放在控制台正下方：和日志连成一体，也让左右两栏底部对齐 -->
        <div class="console-cmd">
            <div class="cmd-wrap">
              <div v-if="suggestOpen" class="suggest">
                <button
                  v-for="(s, i) in suggestions"
                  :key="s.kind + s.label"
                  class="suggest-item"
                  :class="{ active: i === suggestIndex, danger: s.kind === 'command' && s.desc.includes('关闭') }"
                  @mousedown.prevent="pickSuggestion(s)"
                >
                  <span class="suggest-name">{{ s.label }}</span>
                  <span v-if="s.desc" class="suggest-desc">{{ s.desc }}</span>
                  <span class="suggest-kind">{{ s.kind === 'player' ? '玩家' : s.kind === 'rule' ? '规则' : s.kind === 'value' ? '取值' : '命令' }}</span>
                </button>
              </div>
              <div class="cmd-input">
                <input
                  ref="inputEl"
                  v-model="cmd"
                  data-test="cmd"
                  class="input grow mono"
                  placeholder="输入命令，Tab 补全 · ↑↓ 选择 · 回车发送"
                  :disabled="sending"
                  autocomplete="off"
                  spellcheck="false"
                  @input="refreshSuggest"
                  @keydown="onCmdKeydown"
                  @focus="refreshSuggest"
                  @blur="suggestOpen = false"
                />
                <button class="btn btn-primary" :disabled="sending || !cmd.trim()" @click="send(cmd)">
                  <span v-if="sending" class="spinner" style="border-top-color: #fff" />
                  发送
                </button>
              </div>
              <div class="suggest-hint">
                <template v-if="currentHint && suggestOpen">
                  <span class="badge badge-accent">{{ currentHint.label }}</span>
                  {{ currentHint.desc || '按 Tab 补全' }}
                </template>
                <template v-else>
                  支持 Tab 补全、↑↓ 选择、回车发送；打一半按回车会先补全。参数位会提示在线玩家与常用取值。
                </template>
              </div>
            </div>
          <div v-if="!running" class="text-3 small">世界没有在运行，命令会被拒绝，先去总览启动它。</div>
        </div>
      </div>

      <div class="col gap-4 console-side">
        <div class="card">
          <div class="card-head">
            <h3>⚡ 快捷命令</h3>
            <span class="text-3 small">{{ shortcuts.length }} 条 · 按组排</span>
          </div>
          <div class="card-body col gap-3">
            <div v-if="shortcutGroups.length" class="col gap-3">
              <div v-for="g in shortcutGroups" :key="g.group" class="col gap-1">
                <div class="chip-group-label">{{ g.group }}</div>
                <div class="chips">
                  <button
                    v-for="s in g.items"
                    :key="s.group + s.cmd + s.label"
                    class="chip"
                    :class="{ 'chip-danger': s.danger, 'chip-arg': s.needsArg }"
                    :title="s.needsArg ? `${s.cmd}…` : s.cmd"
                    :disabled="sending"
                    @click="useShortcut(s)"
                  >
                    {{ s.label }}<span v-if="s.needsArg" class="chip-dots">…</span>
                  </button>
                </div>
              </div>
            </div>
            <div v-else class="text-3 small">没有可用的快捷命令</div>

            <div class="divider" />


            <div v-if="history.length" class="col gap-1">
              <div class="field-label">最近用过（点击回填）</div>
              <div class="chips">
                <button v-for="h in history" :key="h" class="chip" @click="cmd = h">{{ h }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 定时开服 / 停服 -->
    <div class="card">
      <div class="card-head">
        <h2>⏰ 定时开服 / 停服</h2>
        <span class="text-3 small ellipsis">{{ sched?.describe ?? '读取中…' }}</span>
      </div>

      <div v-if="sched" class="card-body col gap-4">
        <div class="form-grid-2">
          <!-- 开服 -->
          <div class="col gap-3">
            <label class="switch">
              <input v-model="sched.schedule.start.enabled" type="checkbox" />
              <span class="switch-track" />
              <span class="switch-text">定时开服</span>
            </label>
            <div class="field">
              <label class="field-label">开服时间点</label>
              <input v-model="startTimesText" class="input mono" placeholder="08:00, 20:30" />
              <span class="field-hint">24 小时制，多个时间点用逗号分隔</span>
            </div>
            <div class="field">
              <label class="field-label">星期（都不选 = 每天）</label>
              <div class="seg">
                <button
                  v-for="(w, i) in WEEK"
                  :key="`s${w}`"
                  :class="{ active: sched.schedule.start.days.includes(i + 1) }"
                  @click="toggleDay('start', i + 1)"
                >
                  {{ w }}
                </button>
              </div>
            </div>
          </div>

          <!-- 停服 -->
          <div class="col gap-3">
            <label class="switch">
              <input v-model="sched.schedule.stop.enabled" type="checkbox" />
              <span class="switch-track" />
              <span class="switch-text">定时停服</span>
            </label>
            <div class="field">
              <label class="field-label">停服时间点</label>
              <input v-model="stopTimesText" class="input mono" placeholder="23:30" />
              <span class="field-hint">24 小时制，多个时间点用逗号分隔</span>
            </div>
            <div class="field">
              <label class="field-label">星期（都不选 = 每天）</label>
              <div class="seg">
                <button
                  v-for="(w, i) in WEEK"
                  :key="`e${w}`"
                  :class="{ active: sched.schedule.stop.days.includes(i + 1) }"
                  @click="toggleDay('stop', i + 1)"
                >
                  {{ w }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="divider" />

        <div class="form-grid">
          <div class="field">
            <label class="field-label">停服前几分钟公告</label>
            <input v-model.number="sched.schedule.warnMinutes" class="input" type="number" min="0" max="120" />
          </div>
          <div class="field">
            <label class="field-label">公告文案</label>
            <input v-model="sched.schedule.warnText" class="input" placeholder="服务器将在 {n} 分钟后关闭" />
            <span class="field-hint">用 {n} 表示剩余分钟数</span>
          </div>
          <div class="field">
            <label class="field-label">自定义公告命令（可选）</label>
            <input v-model="sched.schedule.warnCommand" class="input mono" placeholder="say 服务器将在 {n} 分钟后关闭" />
            <span class="field-hint">留空则用 say 发送公告文案</span>
          </div>
        </div>

        <div class="row gap-4 wrap">
          <label class="switch">
            <input v-model="sched.schedule.skipIfPlayers" type="checkbox" />
            <span class="switch-track" />
            <span class="switch-text">到点还有玩家在线就等最后一人下线</span>
          </label>
          <div class="row gap-2">
            <span class="text-2 small">最多等</span>
            <input v-model.number="sched.schedule.graceMinutes" class="input grace-input" type="number" min="0" max="720" />
            <span class="text-2 small">分钟（0 = 一直等）</span>
          </div>
        </div>

        <div class="divider" />

        <div class="kv">
          <div class="kv-row">
            <span class="kv-key">下次开服</span>
            <span class="kv-val">{{ fmtTime(sched.nextStart) }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">下次停服</span>
            <span class="kv-val">{{ fmtTime(sched.nextStop) }}</span>
          </div>
          <div v-if="sched.pendingStop" class="kv-row">
            <span class="kv-key">挂起中</span>
            <span class="kv-val">已挂起，等最后一名玩家下线，最晚 {{ fmtTime(sched.pendingStop.deadline) }}</span>
          </div>
        </div>
      </div>

      <div v-else class="card-body">
        <div class="row gap-2">
          <span class="spinner" />
          <span class="text-3">正在读取定时设置…</span>
        </div>
      </div>

      <div v-if="sched" class="card-foot row gap-2">
        <button class="btn btn-soft" :disabled="testingWarn" @click="testWarn">
          <span v-if="testingWarn" class="spinner" />
          立即测试公告
        </button>
        <div class="grow" />
        <button class="btn btn-primary" :disabled="savingSchedule" @click="saveSchedule">
          <span v-if="savingSchedule" class="spinner" style="border-top-color: #fff" />
          保存定时设置
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 只做栅格与宽度微调，视觉一律来自 base.css */
.console-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 330px);
  gap: var(--sp-4);
  /* 两栏等高：左栏是「日志 + 命令输入」，右栏是快捷命令，底部正好平齐 */
  align-items: stretch;
}
@media (max-width: 940px) {
  .console-grid { grid-template-columns: 1fr; }
}
.head-stats { display: flex; gap: var(--sp-5); }
.filter-input { width: 150px; }
.grace-input { width: 84px; }

/* 两栏同高、高度固定：日志在窗口内滚动，永远不会被内容撑长。
   （之前用「弹性高度」的两头都被坑过：设上限会露出空白，不设上限则无限延长。） */
.console-card,
.console-side .card:first-child {
  height: min(70vh, 680px);
}
.console-card { display: flex; flex-direction: column; }
.console-body { flex: 1; display: flex; min-height: 0; }
.console-body .console {
  flex: 1;
  height: 100%;
  /* flex 链路上每一级都要给 min-height: 0，否则内容会把容器顶开 */
  min-height: 0;
  max-height: none;
  overflow-y: auto;
}
.console-cmd {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
  border-top: 1px solid var(--border);
  background: var(--surface-2);
  border-radius: 0 0 var(--r) var(--r);
}
/* 右栏：卡片与左栏同高，快捷命令多了就在卡片内滚动 */
.console-side { display: flex; flex-direction: column; }
.console-side .card:first-child { display: flex; flex-direction: column; min-height: 0; }
.console-side .card:first-child .card-body {
  flex: 1;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
}
</style>
