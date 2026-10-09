<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import JobProgress from '../components/JobProgress.vue';

defineOptions({ name: 'Wizard' });

interface LoaderAvailability {
  loader: string;
  label: string;
  available: boolean;
  versions: string[];
  suggested: string | null;
  note: string;
  javaMajor: number;
}

const router = useRouter();
const route = useRoute();
const mode = ref<'new' | 'import'>(route.path === '/import' ? 'import' : 'new');
const step = ref(1);
const busy = ref(false);
const showJob = ref(false);
const jobId = ref<string | null>(null);

// 新建
const versions = ref<{ id: string; type: string }[]>([]);
const loaders = ref<LoaderAvailability[]>([]);
const loadingVersions = ref(false);
const form = ref({
  name: '',
  mc: '1.20.1',
  loader: 'forge',
  loaderVersion: '',
  memoryMb: 3072,
  minMemoryMb: 1024,
  levelSeed: '',
  gamemode: 'survival',
  difficulty: 'normal',
  pvp: true,
  hardcore: false,
  allowNether: true,
  generateStructures: true,
  onlineMode: false,
  whiteList: false,
  maxPlayers: 20,
  motd: '',
  viewDistance: 6,
  simulationDistance: 5,
  autostart: false,
  start: true,
});

// 导入
const packs = ref<{ id: string; file: string; bytes: number; uploadedAt: number }[]>([]);
const importForm = ref({
  packId: '',
  name: '',
  mc: '',
  loader: 'forge',
  loaderVersion: '',
  memoryMb: 4096,
  start: true,
});
interface PackInspection {
  format: string;
  mc: string | null;
  loader: string | null;
  loaderVersion: string | null;
  packName: string | null;
  filesToDownload: number;
  needManual: string[];
  note: string;
}
const inspection = ref<PackInspection | null>(null);
const inspecting = ref(false);

const steps = ['基本信息', '版本与加载器', '世界参数', '性能', '确认'];
const currentLoader = computed(() => loaders.value.find((l) => l.loader === form.value.loader));
const newSkinSupportHint = computed(() => skinSupportHint(form.value.loader));
const importSkinSupportHint = computed(() => skinSupportHint(importForm.value.loader));

function skinSupportHint(loader: string): string {
  if (loader === 'vanilla') return '原版 Vanilla 不支持服务端模组或插件，因此不能应用服务器皮肤。要让离线玩家互相看到皮肤，请选择 Paper、Fabric、Forge 或 NeoForge。';
  if (loader === 'paper') return '创建后会检查整合包是否已有 SkinsRestorer；缺少时会自动安装兼容的 Paper 插件。客户端无需安装模组。';
  return '创建后会检查整合包是否已有 Skin Restorer；缺少时会自动安装对应 Minecraft 版本与加载器的服务端模组。客户端无需安装模组。';
}

async function loadVersions() {
  try {
    const r = await api.get<{ versions: { id: string; type: string }[] }>('/api/versions');
    versions.value = r.versions;
    if (r.versions.length && !r.versions.some((v) => v.id === form.value.mc)) form.value.mc = r.versions[0].id;
  } catch (err) {
    toastError(err, '读取 Minecraft 版本列表失败（可以手动填写版本号）');
  }
  void refreshLoaders();
}

function resetFlowForm() {
  step.value = 1;
  inspection.value = null;
  Object.assign(form.value, {
    name: '', mc: '1.20.1', loader: 'forge', loaderVersion: '', memoryMb: 3072, minMemoryMb: 1024,
    levelSeed: '', gamemode: 'survival', difficulty: 'normal', pvp: true, hardcore: false,
    allowNether: true, generateStructures: true, onlineMode: false, whiteList: false,
    maxPlayers: 20, motd: '', viewDistance: 6, simulationDistance: 5, autostart: false, start: true,
  });
  Object.assign(importForm.value, { packId: '', name: '', mc: '', loader: 'forge', loaderVersion: '', memoryMb: 4096, start: true });
}

function loadFlowOptions() {
  resetFlowForm();
  if (mode.value === 'new') void loadVersions();
  else void loadPacks();
}

onMounted(loadFlowOptions);
watch(() => route.path, (path) => {
  if (path !== '/create' && path !== '/import') return;
  mode.value = path === '/import' ? 'import' : 'new';
  showJob.value = false;
  jobId.value = null;
  loadFlowOptions();
});

async function refreshLoaders() {
  loadingVersions.value = true;
  try {
    const r = await api.get<{ loaders: LoaderAvailability[] }>(`/api/loaders?mc=${encodeURIComponent(form.value.mc)}`);
    loaders.value = r.loaders;
    const cur = r.loaders.find((l) => l.loader === form.value.loader) ?? r.loaders.find((l) => l.available);
    if (cur) {
      form.value.loader = cur.loader;
      form.value.loaderVersion = cur.suggested ?? '';
    }
  } catch (err) {
    toastError(err, '读取加载器版本失败（网络可能不通，可以稍后重试）');
  } finally {
    loadingVersions.value = false;
  }
}

async function loadPacks() {
  try {
    const r = await api.get<{ packs: { id: string; file: string; bytes: number; uploadedAt: number }[] }>('/api/packs');
    packs.value = r.packs;
  } catch {
    packs.value = [];
  }
}

async function uploadPack(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  busy.value = true;
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    await api.post('/api/packs/upload', { name: file.name, data });
    toast('ok', '整合包已上传', file.name);
    await loadPacks();
  } catch (err) {
    toastError(err, '上传失败');
  } finally {
    busy.value = false;
    input.value = '';
  }
}

async function inspect(packId: string) {
  inspecting.value = true;
  inspection.value = null;
  importForm.value.packId = packId;
  try {
    const r = await api.get<PackInspection>(`/api/packs/inspect/${encodeURIComponent(packId)}`);
    inspection.value = r;
    if (r?.mc) importForm.value.mc = r.mc;
    if (r?.loader && ['forge', 'fabric', 'neoforge', 'paper', 'vanilla'].includes(r.loader)) importForm.value.loader = r.loader;
    if (r?.loaderVersion) importForm.value.loaderVersion = r.loaderVersion;
    if (r?.packName && !importForm.value.name) importForm.value.name = r.packName;
  } catch (err) {
    toastError(err, '解析整合包失败');
  } finally {
    inspecting.value = false;
  }
}

async function submitNew() {
  busy.value = true;
  try {
    const r = await api.post<{ jobId: string }>('/api/instances', { ...form.value, createdFrom: { type: 'new' } });
    jobId.value = r.jobId;
    showJob.value = true;
    toast('ok', '开始创建世界', '安装过程会下载服务端，需要几分钟');
  } catch (err) {
    toastError(err, '创建失败');
  } finally {
    busy.value = false;
  }
}

async function submitImport() {
  busy.value = true;
  try {
    const r = await api.post<{ jobId: string }>(`/api/packs/${encodeURIComponent(importForm.value.packId)}/import`, {
      name: importForm.value.name,
      mc: importForm.value.mc,
      loader: importForm.value.loader,
      loaderVersion: importForm.value.loaderVersion,
      memoryMb: importForm.value.memoryMb,
      start: importForm.value.start,
    });
    jobId.value = r.jobId;
    showJob.value = true;
    toast('ok', '开始导入整合包');
  } catch (err) {
    toastError(err, '导入失败');
  } finally {
    busy.value = false;
  }
}

function closeJob() {
  showJob.value = false;
  jobId.value = null;
  step.value = 1;
  resetFlowForm();
  router.push('/');
}
</script>

<template>
  <div class="page col gap-4 wizard-page">
    <div class="row gap-3">
      <button class="btn btn-ghost btn-sm" @click="router.push('/')">← 返回总览</button>
      <h1>{{ mode === 'new' ? '新建世界' : '导入整合包' }}</h1>
    </div>

    <!-- 新建世界（分步） -->
    <div v-if="mode === 'new'" class="card">
      <div class="card-head">
        <h3>新建世界</h3>
        <div class="wizard-steps">
          <span v-for="(s, i) in steps" :key="s" class="badge wizard-step" :class="step === i + 1 ? 'badge-accent' : step > i + 1 ? 'badge-ok' : 'badge-outline'">
            {{ i + 1 }}. {{ s }}
          </span>
        </div>
      </div>
      <div class="card-body col gap-4">
        <!-- 1 基本 -->
        <template v-if="step === 1">
          <div class="form-grid-2">
            <div class="field">
              <label class="field-label">世界名称</label>
              <input v-model="form.name" class="input" placeholder="例如：温馨禅意 二周目" />
              <span class="field-hint">会用它生成目录 id（字母数字下划线）</span>
            </div>
            <div class="field">
              <label class="field-label">MOTD（服务器列表里显示）</label>
              <input v-model="form.motd" class="input" :placeholder="form.name || '留空则用世界名'" />
            </div>
            <div class="field">
              <label class="field-label">最大玩家数</label>
              <input v-model.number="form.maxPlayers" class="input" type="number" />
            </div>
          </div>
          <div class="row gap-4 wrap">
            <label class="switch"><input v-model="form.autostart" type="checkbox" /><span class="switch-track" /><span class="switch-text">随面板自动启动</span></label>
            <label class="switch"><input v-model="form.start" type="checkbox" /><span class="switch-track" /><span class="switch-text">创建完成后立即启动</span></label>
          </div>
        </template>

        <!-- 2 版本 -->
        <template v-else-if="step === 2">
          <div class="row gap-3 wrap">
            <div class="field" style="min-width: 220px">
              <label class="field-label">Minecraft 版本</label>
              <select v-model="form.mc" class="select" @change="refreshLoaders">
                <option v-for="v in versions" :key="v.id" :value="v.id">{{ v.id }}</option>
              </select>
            </div>
            <div class="field" style="min-width: 200px">
              <label class="field-label">加载器</label>
              <select v-model="form.loader" class="select" @change="form.loaderVersion = currentLoader?.suggested ?? ''">
                <option v-for="l in loaders" :key="l.loader" :value="l.loader" :disabled="!l.available">
                  {{ l.label }}{{ l.available ? '' : '（不可用）' }}
                </option>
              </select>
            </div>
            <div class="field" style="min-width: 200px">
              <label class="field-label">加载器版本</label>
              <select v-if="currentLoader?.versions.length" v-model="form.loaderVersion" class="select">
                <option v-for="v in currentLoader.versions" :key="v" :value="v">{{ v }}</option>
              </select>
              <input v-else v-model="form.loaderVersion" class="input mono" placeholder="原版无需填写" />
            </div>
          </div>
          <div v-if="loadingVersions" class="row gap-2"><span class="spinner" /> 正在查询可用版本…</div>
          <div v-else-if="currentLoader" class="badge badge-info">{{ currentLoader.note }} · 需要 Java {{ currentLoader.javaMajor }}</div>
          <p class="text-3 small skin-support-hint">{{ newSkinSupportHint }} 只有上游发布了该组合的兼容版本时才能自动安装。</p>
        </template>

        <!-- 3 世界参数 -->
        <template v-else-if="step === 3">
          <div class="form-grid">
            <div class="field">
              <label class="field-label">世界种子</label>
              <input v-model="form.levelSeed" class="input mono" placeholder="留空 = 随机" />
            </div>
            <div class="field">
              <label class="field-label">游戏模式</label>
              <select v-model="form.gamemode" class="select">
                <option value="survival">生存</option>
                <option value="creative">创造</option>
                <option value="adventure">冒险</option>
                <option value="spectator">旁观</option>
              </select>
            </div>
            <div class="field">
              <label class="field-label">难度</label>
              <select v-model="form.difficulty" class="select">
                <option value="peaceful">和平</option>
                <option value="easy">简单</option>
                <option value="normal">普通</option>
                <option value="hard">困难</option>
              </select>
            </div>
          </div>
          <div class="row gap-4 wrap">
            <label class="switch"><input v-model="form.pvp" type="checkbox" /><span class="switch-track" /><span class="switch-text">允许 PVP</span></label>
            <label class="switch"><input v-model="form.hardcore" type="checkbox" /><span class="switch-track" /><span class="switch-text">极限模式</span></label>
            <label class="switch"><input v-model="form.allowNether" type="checkbox" /><span class="switch-track" /><span class="switch-text">允许下界</span></label>
            <label class="switch"><input v-model="form.generateStructures" type="checkbox" /><span class="switch-track" /><span class="switch-text">生成建筑</span></label>
          </div>
          <div class="divider" />
          <div class="row gap-4 wrap">
            <label class="switch"><input v-model="form.onlineMode" type="checkbox" /><span class="switch-track" /><span class="switch-text">正版验证</span></label>
            <label class="switch"><input v-model="form.whiteList" type="checkbox" /><span class="switch-track" /><span class="switch-text">开启白名单</span></label>
          </div>
          <p class="text-3 small">关掉正版验证后任何人都能进（名字可以随便填）；公共网络建议开白名单。</p>
        </template>

        <!-- 4 性能 -->
        <template v-else-if="step === 4">
          <div class="form-grid">
            <div class="field">
              <label class="field-label">内存上限 Xmx（MB）</label>
              <input v-model.number="form.memoryMb" class="input" type="number" step="256" />
            </div>
            <div class="field">
              <label class="field-label">初始内存 Xms（MB）</label>
              <input v-model.number="form.minMemoryMb" class="input" type="number" step="256" />
            </div>
            <div class="field">
              <label class="field-label">视距</label>
              <input v-model.number="form.viewDistance" class="input" type="number" min="2" max="32" />
            </div>
            <div class="field">
              <label class="field-label">模拟距离</label>
              <input v-model.number="form.simulationDistance" class="input" type="number" min="2" max="32" />
            </div>
          </div>
          <p class="text-3 small">
            内存给多了会挤占其它世界；面板会在启动时检查所有世界的 Xmx 之和，超出机器预算会拒绝启动并说明原因。
          </p>
        </template>

        <!-- 5 确认 -->
        <template v-else>
          <div class="kv">
            <div class="kv-row"><span class="kv-key">名称</span><span class="kv-val">{{ form.name }}</span></div>
            <div class="kv-row"><span class="kv-key">版本</span><span class="kv-val">Minecraft {{ form.mc }} · {{ currentLoader?.label ?? form.loader }} {{ form.loaderVersion }}</span></div>
            <div class="kv-row"><span class="kv-key">世界</span><span class="kv-val">{{ form.gamemode }} / {{ form.difficulty }} / 种子 {{ form.levelSeed || '随机' }}</span></div>
            <div class="kv-row"><span class="kv-key">内存</span><span class="kv-val">{{ form.minMemoryMb }}M ~ {{ form.memoryMb }}M</span></div>
            <div class="kv-row"><span class="kv-key">端口</span><span class="kv-val">自动分配（本地 + FRP 远端）</span></div>
            <div class="kv-row"><span class="kv-key">准入门槛</span><span class="kv-val">{{ form.onlineMode ? '正版验证' : '离线模式' }}{{ form.whiteList ? ' · 白名单' : '' }}</span></div>
          </div>
          <p class="text-3 small">创建过程会下载服务端与加载器依赖，完成后会自动分配端口并映射 FRP。</p>
        </template>
      </div>
      <div class="card-foot row-between">
        <button class="btn" :disabled="step === 1" @click="step--">上一步</button>
        <div class="row gap-2">
          <button v-if="step < 5" class="btn btn-primary" :disabled="step === 1 && !form.name" @click="step++">下一步</button>
          <button v-else class="btn btn-primary btn-lg" :disabled="busy" @click="submitNew">创建世界</button>
        </div>
      </div>
    </div>

    <!-- 导入整合包 -->
    <div v-else class="card">
      <div class="card-head"><h3>导入整合包</h3></div>
      <div class="card-body col gap-4">
        <div class="row gap-2 wrap">
          <label class="btn btn-soft">
            + 上传压缩包（.zip / .mrpack）
            <input type="file" accept=".zip,.mrpack" style="display: none" @change="uploadPack" />
          </label>
          <span class="text-3 small">也可以把包放到 <code class="mono">data/store/packs/</code> 下再刷新</span>
        </div>

        <div v-if="!packs.length" class="empty"><div class="empty-icon">📦</div><div>还没有整合包</div></div>
        <div v-else class="col gap-2">
          <button
            v-for="p in packs"
            :key="p.id"
            class="pack-row"
            :class="{ active: importForm.packId === p.id }"
            @click="inspect(p.id)"
          >
            <span class="grow ellipsis mono">{{ p.id }}</span>
            <span class="text-3 small">{{ (p.bytes / 1024 / 1024).toFixed(1) }} MB</span>
          </button>
        </div>

        <div v-if="inspecting" class="row gap-2"><span class="spinner" /> 解析中…</div>
        <div v-else-if="inspection" class="card card-pad" style="background: var(--surface-2)">
          <div class="col gap-2">
            <div class="row gap-2 wrap">
              <span class="badge badge-accent">{{ inspection.format }}</span>
              <span v-if="inspection.packName" class="badge badge-outline">{{ inspection.packName }}</span>
              <span v-if="inspection.mc" class="badge badge-info">MC {{ inspection.mc }}</span>
              <span v-if="inspection.loader" class="badge badge-info">{{ inspection.loader }} {{ inspection.loaderVersion }}</span>
            </div>
            <div class="text-3 small">{{ inspection.note }}</div>
            <div v-if="inspection.filesToDownload" class="text-3 small">清单里共有 {{ inspection.filesToDownload }} 个待下载文件</div>
          </div>
        </div>

        <template v-if="inspection">
          <div class="form-grid-2">
            <div class="field">
              <label class="field-label">新世界名称</label>
              <input v-model="importForm.name" class="input" />
            </div>
            <div class="field">
              <label class="field-label">Minecraft 版本</label>
              <input v-model="importForm.mc" class="input mono" placeholder="识别不到时请手动填写" />
            </div>
            <div class="field">
              <label class="field-label">加载器</label>
              <select v-model="importForm.loader" class="select">
                <option value="forge">Forge</option>
                <option value="neoforge">NeoForge</option>
                <option value="fabric">Fabric</option>
                <option value="paper">Paper</option>
                <option value="vanilla">原版</option>
              </select>
            </div>
            <div class="field">
              <label class="field-label">加载器版本</label>
              <input v-model="importForm.loaderVersion" class="input mono" />
            </div>
            <div class="field">
              <label class="field-label">内存上限（MB）</label>
              <input v-model.number="importForm.memoryMb" class="input" type="number" step="512" />
            </div>
          </div>
          <label class="switch"><input v-model="importForm.start" type="checkbox" /><span class="switch-track" /><span class="switch-text">导入完成后立即启动</span></label>
          <p class="text-3 small skin-support-hint">{{ importSkinSupportHint }} 如果整合包已包含组件会保留；只有上游发布了兼容版本时才会补装。</p>
        </template>
      </div>
      <div class="card-foot row-between">
        <span class="text-3 small">CurseForge 格式的包需要 API Key 才能自动下载 MOD；没有 Key 时会列出人工清单</span>
        <button class="btn btn-primary" :disabled="busy || !inspection || !importForm.name || !importForm.mc" @click="submitImport">
          开始导入
        </button>
      </div>
    </div>

    <JobProgress :open="showJob" :job-id="jobId" @close="closeJob" />
  </div>
</template>

<style scoped>
.wizard-page { min-height: calc(100vh - var(--header-h)); justify-content: flex-start; padding-top: clamp(18px, 3vh, 34px); }
.skin-support-hint {
  max-width: 860px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  line-height: 1.6;
}
.wizard-steps { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; }
.wizard-step { max-width: 100%; }
.wizard-steps { min-width: 0; }
.pack-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface);
  font: inherit;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}
@media (max-width: 620px) {
  .wizard-page > .row { flex-wrap: wrap; }
  .wizard-page > .row h1 { flex: 1 1 180px; min-width: 0; }
  .wizard-page .card > .card-head { flex-wrap: wrap; align-items: flex-start; }
  .wizard-steps { flex: 1 1 240px; justify-content: flex-start; }
}
.pack-row:hover { border-color: var(--border-strong); }
.pack-row.active { border-color: var(--accent); background: var(--accent-soft); }
</style>
