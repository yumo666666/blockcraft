<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, subscribe } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import { fmtBytes, statusClass } from '../lib/format.ts';
import type { InstanceDetail, InstanceSummary, ModInfo } from '../lib/types.ts';
import Modal from '../components/Modal.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';

defineOptions({ name: 'Mods' });

const props = defineProps<{ id: string }>();
const router = useRouter();

const base = computed(() => `/api/instances/${encodeURIComponent(props.id)}`);

const instance = ref<InstanceSummary | null>(null);
const mods = ref<ModInfo[]>([]);
const total = ref(0);
const page = ref(1);
const pages = ref(1);
const pageSize = ref(24);
const modsDir = ref('');
const loading = ref(false);
const busyFile = ref<string | null>(null);

const q = ref('');
const source = ref('all');
const status = ref<'all' | 'enabled' | 'disabled'>('all');

/** 世界只要还有进程在，任何 MOD 写操作都先拦下来（服务端也会拒绝） */
const running = computed(() => (instance.value ? ['running', 'starting', 'stopping', 'stuck'].includes(instance.value.status) : false));
const worldName = computed(() => instance.value?.name ?? props.id);

const SOURCE_OPTIONS = [
  { value: 'all', label: '全部来源' },
  { value: 'modrinth', label: 'Modrinth' },
  { value: 'curseforge', label: 'CurseForge' },
  { value: 'local', label: '本地' },
  { value: 'unknown', label: '未知' },
];

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  modrinth: { label: 'Modrinth', cls: 'badge-info' },
  curseforge: { label: 'CurseForge', cls: 'badge-warn' },
  local: { label: '本地', cls: 'badge-outline' },
  unknown: { label: '未知', cls: 'badge-outline' },
};

function sourceBadge(s: string): { label: string; cls: string } {
  return SOURCE_BADGE[s] ?? SOURCE_BADGE.unknown;
}

function modName(m: ModInfo): string {
  return m.name || m.file;
}

/* ------------------------------------------------------------ 数据加载 */

let offStream: (() => void) | null = null;
let qTimer: number | null = null;

async function loadInstance() {
  try {
    const r = await api.get<InstanceDetail>(base.value);
    instance.value = r.instance;
  } catch (err) {
    toastError(err, '读取世界信息失败');
  }
}

async function load(p = page.value) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(p), size: String(pageSize.value), status: status.value });
    if (q.value.trim()) params.set('q', q.value.trim());
    if (source.value !== 'all') params.set('source', source.value);
    const r = await api.get<{ total: number; page: number; size: number; pages: number; items: ModInfo[]; dir: string }>(
      `${base.value}/mods?${params.toString()}`,
    );
    mods.value = r.items;
    total.value = r.total;
    page.value = r.page;
    pages.value = r.pages;
    modsDir.value = r.dir;
  } catch (err) {
    toastError(err, '读取 MOD 列表失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadInstance();
  load(1);
  // 顶栏的实例流已经有世界状态，直接复用它来判断能不能改 MOD
  offStream = subscribe<{ instances: InstanceSummary[] }>(
    '/api/system/stream',
    (data) => {
      const hit = data.instances?.find((i) => i.id === props.id);
      if (hit) instance.value = hit;
    },
    { onError: () => loadInstance() },
  );
});

onUnmounted(() => {
  offStream?.();
  if (qTimer) window.clearTimeout(qTimer);
});

watch([source, status, pageSize], () => load(1));

watch(q, () => {
  if (qTimer) window.clearTimeout(qTimer);
  qTimer = window.setTimeout(() => load(1), 300);
});

function searchNow() {
  if (qTimer) window.clearTimeout(qTimer);
  load(1);
}

/* ------------------------------------------------------------ 运行时拦截 */

function guardRunning(): boolean {
  if (!running.value) return true;
  toast('warn', '请先停服再改 MOD', '服务器运行中，改文件会让正在加载的 MOD 出错；请先在总览页停止这个世界');
  return false;
}

/* ------------------------------------------------------------ 启用 / 停用 */

async function toggleMod(m: ModInfo) {
  if (!guardRunning()) return;
  busyFile.value = m.file;
  try {
    await api.put(`${base.value}/mods/${encodeURIComponent(m.file)}`, { enabled: !m.enabled });
    toast('ok', m.enabled ? `已停用 ${modName(m)}` : `已启用 ${modName(m)}`, m.enabled ? '文件已改名为 .jar.disabled' : '文件已改回 .jar');
    await load();
  } catch (err) {
    toastError(err, '切换失败');
  } finally {
    busyFile.value = null;
  }
}

/* ------------------------------------------------------------ 删除 */

const deleteTarget = ref<ModInfo | null>(null);

function askDelete(m: ModInfo) {
  if (!guardRunning()) return;
  deleteTarget.value = m;
}

async function doDelete() {
  const m = deleteTarget.value;
  if (!m) return;
  busyFile.value = m.file;
  try {
    await api.del(`${base.value}/mods/${encodeURIComponent(m.file)}?confirm=1`);
    toast('ok', '已删除', m.file);
    deleteTarget.value = null;
    if (mods.value.length === 1 && page.value > 1) page.value -= 1;
    await load();
  } catch (err) {
    toastError(err, '删除失败');
  } finally {
    busyFile.value = null;
  }
}

/* ------------------------------------------------------------ 本地导入 */

const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const importDone = ref(0);
const importTotal = ref(0);
const importResult = ref<{ added: string[]; skipped: { file: string; reason: string }[] } | null>(null);
const showImport = ref(false);

function pickFiles() {
  if (!guardRunning()) return;
  fileInput.value?.click();
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result ?? '');
      const comma = s.indexOf(',');
      // readAsDataURL 给的是 data:application/java-archive;base64,xxx，接口只认逗号后面那截
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

async function onFiles(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) return;

  importing.value = true;
  importDone.value = 0;
  importTotal.value = files.length;
  importResult.value = null;

  const payload: { name: string; data: string }[] = [];
  const readErrors: { file: string; reason: string }[] = [];
  for (const f of files) {
    try {
      payload.push({ name: f.name, data: await readBase64(f) });
    } catch (err) {
      readErrors.push({ file: f.name, reason: err instanceof Error ? err.message : '读取失败' });
    }
    importDone.value += 1;
  }

  if (!payload.length) {
    importing.value = false;
    importResult.value = { added: [], skipped: readErrors };
    showImport.value = true;
    toast('error', '导入失败', '这些文件都没能读出来');
    return;
  }

  try {
    const r = await api.post<{ added: string[]; skipped: { file: string; reason: string }[] }>(`${base.value}/mods/upload`, {
      files: payload,
    });
    importResult.value = { added: r.added, skipped: [...readErrors, ...r.skipped] };
    showImport.value = true;
    toast(r.skipped.length + readErrors.length ? 'warn' : 'ok', `导入完成：新增 ${r.added.length} 个`, importResult.value.skipped.length ? `跳过 ${importResult.value.skipped.length} 个，详见结果` : undefined);
    await load(1);
  } catch (err) {
    toastError(err, '导入失败');
  } finally {
    importing.value = false;
  }
}

/* ------------------------------------------------------------ 从链接下载 */

const showUrl = ref(false);
const urlValue = ref('');
const urlBusy = ref(false);

function openUrlDialog() {
  if (!guardRunning()) return;
  urlValue.value = '';
  showUrl.value = true;
}

async function submitUrl() {
  const url = urlValue.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    toast('warn', '链接格式不对', '请填 http(s) 开头的直链，或 Modrinth / CurseForge 项目页链接');
    return;
  }
  urlBusy.value = true;
  try {
    const r = await api.post<{ file: string; source: string }>(`${base.value}/mods/from-url`, { url });
    toast('ok', '下载完成', `${r.file}（来源：${r.source}）`);
    showUrl.value = false;
    await load(1);
  } catch (err) {
    toastError(err, '下载失败');
  } finally {
    urlBusy.value = false;
  }
}

/* ------------------------------------------------------------ 检查更新 */

const checking = ref(false);

async function checkUpdates() {
  checking.value = true;
  try {
    const r = await api.post<{ updates: ModInfo[] }>(`${base.value}/mods/check-updates`);
    await load();
    if (!r.updates.length) {
      toast('ok', '全部都是最新版', '没有发现可更新的 MOD');
      return;
    }
    const names = r.updates.slice(0, 3).map((m) => `${modName(m)}${m.latestVersion ? ` → ${m.latestVersion}` : ''}`);
    toast('warn', `${r.updates.length} 个 MOD 有新版本`, `${names.join('；')}${r.updates.length > 3 ? ' …' : ''}（卡片上有「有新版本」标记）`);
  } catch (err) {
    toastError(err, '检查更新失败');
  } finally {
    checking.value = false;
  }
}

/* ------------------------------------------------------------ 缺失依赖 */

const showDeps = ref(false);
const depsBusy = ref(false);
const missing = ref<{ modId: string; requestedBy: string[]; versionRange: string }[]>([]);

async function checkDeps() {
  depsBusy.value = true;
  try {
    const r = await api.get<{ missing: { modId: string; requestedBy: string[]; versionRange: string }[] }>(
      `${base.value}/mods/missing-deps`,
    );
    missing.value = r.missing;
    showDeps.value = true;
    if (!r.missing.length) toast('ok', '依赖完整', '启用的 MOD 里没有发现缺前置');
  } catch (err) {
    toastError(err, '检查依赖失败');
  } finally {
    depsBusy.value = false;
  }
}

function modrinthSearch(modId: string): string {
  return `https://modrinth.com/mods?q=${encodeURIComponent(modId)}`;
}
</script>

<template>
  <div class="page col gap-4">
    <!-- 头部：返回 + 世界名 + 操作 -->
    <div class="row-between wrap gap-3">
      <div class="row gap-3 grow" style="min-width: 0">
        <button class="btn btn-ghost btn-sm" @click="router.push('/')">← 返回总览</button>
        <div class="grow" style="min-width: 0">
          <div class="row gap-2">
            <i class="dot" :class="statusClass(instance?.status ?? 'stopped')" />
            <h1 class="ellipsis">{{ worldName }}</h1>
            <span v-if="running" class="badge badge-warn nowrap">运行中 · 已锁定修改</span>
          </div>
          <div class="text-3 small ellipsis" :title="modsDir">
            共 {{ total }} 个 MOD<template v-if="modsDir"> · {{ modsDir }}</template>
          </div>
        </div>
      </div>

      <div class="row gap-2 wrap">
        <button
          class="btn btn-primary"
          :disabled="importing"
          :title="running ? '请先停服再改 MOD' : '选择本地的 .jar 文件导入'"
          @click="pickFiles"
        >
          <span v-if="importing" class="spinner" style="border-top-color: #fff" />
          {{ importing ? `导入中 ${importDone}/${importTotal}` : '＋ 导入 MOD' }}
        </button>
        <button class="btn" :title="running ? '请先停服再改 MOD' : '从直链或项目页链接下载'" @click="openUrlDialog">从链接下载</button>
        <button class="btn" :disabled="checking" @click="checkUpdates">
          <span v-if="checking" class="spinner" />
          {{ checking ? '检查中' : '检查更新' }}
        </button>
        <button class="btn" :disabled="depsBusy" @click="checkDeps">
          <span v-if="depsBusy" class="spinner" />
          {{ depsBusy ? '检查中' : '补依赖检查' }}
        </button>
      </div>
    </div>

    <input ref="fileInput" type="file" multiple accept=".jar" style="display: none" @change="onFiles" />

    <!-- 搜索与筛选 -->
    <div class="card">
      <div class="card-body row wrap gap-3">
        <div class="field grow" style="min-width: 190px">
          <label class="field-label">搜索</label>
          <input v-model="q" class="input" placeholder="名称 / 文件名 / modId / 描述" @keyup.enter="searchNow" />
        </div>
        <div class="field" style="width: 148px">
          <label class="field-label">来源</label>
          <select v-model="source" class="select">
            <option v-for="o in SOURCE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <div class="field" style="width: 132px">
          <label class="field-label">状态</label>
          <select v-model="status" class="select">
            <option value="all">全部</option>
            <option value="enabled">已启用</option>
            <option value="disabled">已停用</option>
          </select>
        </div>
        <div class="field" style="width: 106px">
          <label class="field-label">每页</label>
          <select v-model.number="pageSize" class="select">
            <option :value="12">12</option>
            <option :value="24">24</option>
            <option :value="48">48</option>
          </select>
        </div>
        <button class="btn" :disabled="loading" @click="load(1)">
          <span v-if="loading" class="spinner" />
          刷新
        </button>
      </div>
    </div>

    <!-- MOD 卡片网格 -->
    <div v-if="loading && !mods.length" class="card">
      <div class="card-body center" style="padding: 44px">
        <span class="spinner" />
      </div>
    </div>

    <div v-else-if="!mods.length" class="card">
      <div class="empty">
        <div class="empty-icon">🧩</div>
        <div>{{ total ? '没有符合条件的 MOD' : 'mods 目录还是空的' }}</div>
        <button class="btn btn-primary mt-2" @click="pickFiles">导入第一个 MOD</button>
      </div>
    </div>

    <template v-else>
      <div class="mod-grid">
        <div v-for="m in mods" :key="m.file" class="mod-card" :class="{ disabled: !m.enabled }">
          <div class="row-between gap-2">
            <div class="mod-title ellipsis grow" :title="`${modName(m)}\n${m.file}`">{{ modName(m) }}</div>
            <span class="badge" :class="sourceBadge(m.source).cls">{{ sourceBadge(m.source).label }}</span>
          </div>

          <div v-if="!m.enabled || m.missingDeps.length || m.hasUpdate" class="row gap-1 wrap">
            <span v-if="!m.enabled" class="badge badge-outline">已停用</span>
            <span v-if="m.missingDeps.length" class="badge badge-danger" :title="`缺少：${m.missingDeps.join('、')}`">
              缺少依赖 {{ m.missingDeps.length }} 个
            </span>
            <span v-if="m.hasUpdate" class="badge badge-accent" :title="m.latestVersion ? `最新版本 ${m.latestVersion}` : '有新版本'">有新版本</span>
          </div>

          <div class="mod-desc">{{ m.description || '（这个 MOD 没有提供描述）' }}</div>

          <div class="text-3 small row gap-2 wrap">
            <span class="mono">{{ m.version ? `v${m.version}` : '版本未知' }}</span>
            <span>·</span>
            <span>{{ fmtBytes(m.bytes) }}</span>
            <template v-if="m.hasUpdate && m.latestVersion">
              <span>·</span>
              <span class="mono">最新 {{ m.latestVersion }}</span>
            </template>
          </div>

          <div class="mod-foot">
            <button class="btn btn-sm grow" :disabled="busyFile === m.file" @click="toggleMod(m)">
              {{ m.enabled ? '停用' : '启用' }}
            </button>
            <button class="btn btn-sm btn-danger grow" :disabled="busyFile === m.file" @click="askDelete(m)">删除</button>
            <a v-if="m.sourceUrl" class="btn btn-sm grow" :href="m.sourceUrl" target="_blank" rel="noreferrer">查看原站</a>
          </div>
        </div>
      </div>

      <div class="row-between wrap gap-3">
        <div class="text-3 small">共 {{ total }} 个 MOD，第 {{ page }} / {{ pages }} 页</div>
        <div class="seg">
          <button :disabled="page <= 1 || loading" @click="load(page - 1)">‹ 上一页</button>
          <button class="active" disabled>第 {{ page }} / {{ pages }} 页</button>
          <button :disabled="page >= pages || loading" @click="load(page + 1)">下一页 ›</button>
        </div>
      </div>
    </template>

    <!-- 从链接下载 -->
    <Modal v-if="showUrl" title="从链接下载 MOD" @close="showUrl = false">
      <div class="col gap-3">
        <div class="field">
          <label class="field-label">下载链接</label>
          <input v-model="urlValue" class="input mono" placeholder="https://modrinth.com/mod/xxx 或直链 .jar" @keyup.enter="submitUrl" />
          <span class="field-hint">支持 Modrinth / CurseForge 项目页链接，也支持 http(s) 直链；下载会按当前世界的加载器挑选版本。</span>
        </div>
      </div>
      <template #footer>
        <button class="btn" @click="showUrl = false">取消</button>
        <button class="btn btn-primary" :disabled="urlBusy || !urlValue.trim()" @click="submitUrl">
          <span v-if="urlBusy" class="spinner" style="border-top-color: #fff" />
          下载
        </button>
      </template>
    </Modal>

    <!-- 导入结果 -->
    <Modal v-if="showImport" title="导入结果" @close="showImport = false">
      <div class="col gap-3">
        <div class="row gap-2 wrap">
          <span class="badge badge-ok">新增 {{ importResult?.added.length ?? 0 }} 个</span>
          <span v-if="importResult?.skipped.length" class="badge badge-warn">跳过 {{ importResult.skipped.length }} 个</span>
        </div>
        <div v-if="importResult?.added.length" class="col gap-1">
          <div class="text-3 small">已导入</div>
          <div v-for="f in importResult.added" :key="f" class="mono small ellipsis">{{ f }}</div>
        </div>
        <div v-if="importResult?.skipped.length" class="col gap-1">
          <div class="text-3 small">跳过</div>
          <div v-for="s in importResult.skipped" :key="s.file" class="small">
            <span class="mono">{{ s.file }}</span><span class="text-2"> — {{ s.reason }}</span>
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn btn-primary" @click="showImport = false">知道了</button>
      </template>
    </Modal>

    <!-- 缺失依赖 -->
    <Modal v-if="showDeps" title="缺失的前置 MOD" @close="showDeps = false">
      <div v-if="!missing.length" class="empty">
        <div class="empty-icon">✅</div>
        <div>启用的 MOD 依赖都齐了</div>
      </div>
      <div v-else class="col gap-3">
        <p class="text-2 small">下面这些前置没有被任何已启用的 MOD 提供，缺了可能启动失败：</p>
        <div v-for="d in missing" :key="d.modId" class="card card-pad">
          <div class="row-between gap-2 wrap">
            <div class="grow" style="min-width: 0">
              <div class="mono ellipsis">{{ d.modId }}</div>
              <div class="text-3 small">需要版本：{{ d.versionRange }}</div>
              <div class="text-3 small ellipsis" :title="d.requestedBy.join('、')">被依赖：{{ d.requestedBy.join('、') }}</div>
            </div>
            <a class="btn btn-sm" :href="modrinthSearch(d.modId)" target="_blank" rel="noreferrer">去 Modrinth 找</a>
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn btn-primary" @click="showDeps = false">关闭</button>
      </template>
    </Modal>

    <!-- 删除确认：要求输入文件名 -->
    <ConfirmDialog
      :open="!!deleteTarget"
      title="删除 MOD"
      :message="`将要删除「${deleteTarget ? modName(deleteTarget) : ''}」：\n· 文件 ${deleteTarget?.file ?? ''}\n· 大小 ${deleteTarget ? fmtBytes(deleteTarget.bytes) : ''}\n\n删除不可撤销（建议先备份 mods 目录）。`"
      :detail="deleteTarget?.file"
      :require-text="deleteTarget?.file ?? ''"
      require-label="输入上面的完整文件名以确认删除"
      confirm-text="删除"
      danger
      :busy="busyFile === deleteTarget?.file"
      @close="deleteTarget = null"
      @confirm="doDelete"
    />
  </div>
</template>
