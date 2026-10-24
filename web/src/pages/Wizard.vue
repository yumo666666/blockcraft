<script setup lang="ts">
import UiSelect from '../components/UiSelect.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type UploadProgress } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import { readBrowserSnapshot, writeBrowserSnapshot } from '../lib/browserSnapshot.ts';
import JobProgress from '../components/JobProgress.vue';
import Icon from '../components/Icon.vue';
import { setBackgroundJob } from '../lib/backgroundJob.ts';

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
const uploadingPack = ref(false);
const packUploadProgress = ref<(UploadProgress & { state: 'uploading' | 'done' | 'failed' }) | null>(null);
const showJob = ref(false);
const jobId = ref<string | null>(null);

// 新建
const cachedVersions = readBrowserSnapshot<{ id: string; type: string }[]>('wizard:minecraft-versions');
const versions = ref<{ id: string; type: string }[]>(cachedVersions ?? []);
const versionsLoaded = ref(cachedVersions !== null);
const loadingMinecraftVersions = ref(!versionsLoaded.value);
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
  allowFlight: false,
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
const cachedLoaders = readBrowserSnapshot<{ mc: string; loaders: LoaderAvailability[] }>(`wizard:loaders:${form.value.mc}`);
const loaders = ref<LoaderAvailability[]>(cachedLoaders?.loaders ?? []);
const loaderSnapshotMc = ref(cachedLoaders?.mc ?? '');
const loadingVersions = ref(loaderSnapshotMc.value !== form.value.mc);
let versionsRequest = 0;
let loadersRequest = 0;

// 导入
type PackInfo = { id: string; file: string; bytes: number; uploadedAt: number; format?: string | null };
const cachedPacks = readBrowserSnapshot<PackInfo[]>('wizard:packs');
const packs = ref<PackInfo[]>(cachedPacks ?? []);
const packsLoaded = ref(cachedPacks !== null);
const packsLoading = ref(!packsLoaded.value);
const cachedCurseForgeKeyConfigured = readBrowserSnapshot<boolean>('wizard:curseforge-key-configured');
const curseForgeKeyConfigured = ref(cachedCurseForgeKeyConfigured ?? false);
const hasImportSettingsSnapshot = ref(cachedCurseForgeKeyConfigured !== null);
const importSettingsLoading = ref(!hasImportSettingsSnapshot.value);
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
  optionalFiles: number;
  recommendedRamMb: number | null;
  needManual: string[];
  note: string;
}
const inspection = ref<PackInspection | null>(null);
const inspecting = ref(false);

const steps = ['基本信息', '版本与加载器', '世界参数', '性能', '确认'];
const currentLoader = computed(() => loaders.value.find((l) => l.loader === form.value.loader));
const newSkinSupportHint = computed(() => skinSupportHint(form.value.loader));
const importSkinSupportHint = computed(() => skinSupportHint(importForm.value.loader));
const importRamBelowRecommended = computed(() => Boolean(
  inspection.value?.recommendedRamMb && importForm.value.memoryMb < inspection.value.recommendedRamMb,
));

function skinSupportHint(loader: string): string {
  if (loader === 'vanilla') return '原版 Vanilla 不支持服务端模组或插件，因此不能应用服务器皮肤。要让离线玩家互相看到皮肤，请选择 Paper、Fabric、Forge 或 NeoForge。';
  if (loader === 'paper') return '创建后会检查整合包是否已有 SkinsRestorer；缺少时会自动安装兼容的 Paper 插件。客户端无需安装模组。';
  return '创建后会检查整合包是否已有 Skin Restorer；缺少时会自动安装对应 Minecraft 版本与加载器的服务端模组。客户端无需安装模组。';
}

async function loadVersions() {
  const request = ++versionsRequest;
  if (!versionsLoaded.value) loadingMinecraftVersions.value = true;
  try {
    const r = await api.get<{ versions: { id: string; type: string }[] }>('/api/versions');
    if (request !== versionsRequest) return;
    versions.value = r.versions;
    versionsLoaded.value = true;
    writeBrowserSnapshot('wizard:minecraft-versions', r.versions);
    if (r.versions.length && !r.versions.some((v) => v.id === form.value.mc)) form.value.mc = r.versions[0].id;
  } catch (err) {
    if (request === versionsRequest) toastError(err, '读取 Minecraft 版本列表失败（可以手动填写版本号）');
  } finally {
    if (request === versionsRequest) loadingMinecraftVersions.value = false;
  }
  if (request === versionsRequest) void refreshLoaders();
}

function resetFlowForm() {
  step.value = 1;
  inspection.value = null;
  Object.assign(form.value, {
    name: '', mc: '1.20.1', loader: 'forge', loaderVersion: '', memoryMb: 3072, minMemoryMb: 1024,
    levelSeed: '', gamemode: 'survival', difficulty: 'normal', pvp: true, hardcore: false,
    allowNether: true, allowFlight: false, generateStructures: true, onlineMode: false, whiteList: false,
    maxPlayers: 20, motd: '', viewDistance: 6, simulationDistance: 5, autostart: false, start: true,
  });
  Object.assign(importForm.value, { packId: '', name: '', mc: '', loader: 'forge', loaderVersion: '', memoryMb: 4096, start: true });
}

function loadFlowOptions() {
  resetFlowForm();
  if (mode.value === 'new') void loadVersions();
  else void Promise.all([loadPacks(), loadImportSettings()]);
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
  const mc = form.value.mc;
  const request = ++loadersRequest;
  const cached = readBrowserSnapshot<LoaderAvailability[]>(`wizard:loaders:${mc}`);
  if (cached !== null) {
    loaders.value = cached;
    loaderSnapshotMc.value = mc;
  } else if (loaderSnapshotMc.value !== mc) {
    loaders.value = [];
    loaderSnapshotMc.value = '';
  }
  loadingVersions.value = true;
  try {
    const r = await api.get<{ loaders: LoaderAvailability[] }>(`/api/loaders?mc=${encodeURIComponent(mc)}`);
    if (request !== loadersRequest || mc !== form.value.mc) return;
    loaders.value = r.loaders;
    loaderSnapshotMc.value = mc;
    writeBrowserSnapshot(`wizard:loaders:${mc}`, r.loaders);
    const cur = r.loaders.find((l) => l.loader === form.value.loader) ?? r.loaders.find((l) => l.available);
    if (cur) {
      form.value.loader = cur.loader;
      form.value.loaderVersion = cur.suggested ?? '';
    }
  } catch (err) {
    if (request === loadersRequest && mc === form.value.mc) toastError(err, '读取加载器版本失败（网络可能不通，可以稍后重试）');
  } finally {
    if (request === loadersRequest) loadingVersions.value = false;
  }
}

async function loadPacks() {
  packsLoading.value = true;
  try {
    const r = await api.get<{ packs: PackInfo[] }>('/api/packs');
    packs.value = r.packs;
    packsLoaded.value = true;
    writeBrowserSnapshot('wizard:packs', r.packs);
  } catch {
    if (!packsLoaded.value) packs.value = [];
  } finally {
    packsLoading.value = false;
    packsLoaded.value = true;
  }
}

async function loadImportSettings() {
  if (!hasImportSettingsSnapshot.value) importSettingsLoading.value = true;
  try {
    const r = await api.get<{ config: { mirrors: { curseforgeApiKey: string } } }>('/api/panel');
    curseForgeKeyConfigured.value = Boolean(r.config.mirrors.curseforgeApiKey);
    hasImportSettingsSnapshot.value = true;
    writeBrowserSnapshot('wizard:curseforge-key-configured', curseForgeKeyConfigured.value);
  } catch {
    if (!hasImportSettingsSnapshot.value) curseForgeKeyConfigured.value = false;
  } finally {
    importSettingsLoading.value = false;
  }
}

async function uploadPack(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  uploadingPack.value = true;
  packUploadProgress.value = { loaded: 0, total: file.size, percent: 0, state: 'uploading' };
  try {
    await api.uploadFile('/api/packs/upload', file, (progress) => {
      packUploadProgress.value = { ...progress, state: 'uploading' };
    });
    packUploadProgress.value = { loaded: file.size, total: file.size, percent: 100, state: 'done' };
    toast('ok', '整合包已上传', file.name);
    await loadPacks();
  } catch (err) {
    packUploadProgress.value = { ...(packUploadProgress.value ?? { loaded: 0, total: file.size, percent: 0 }), state: 'failed' };
    if (err instanceof TypeError) {
      toast('error', '上传失败 / Upload failed', '网络连接中断或面板暂时不可用，请检查连接后重试 / The connection was interrupted or the panel is unavailable. Check your connection and try again.', 8000);
    } else {
      toastError(err, '上传失败 / Upload failed');
    }
  } finally {
    uploadingPack.value = false;
    input.value = '';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
    if (r?.recommendedRamMb) importForm.value.memoryMb = r.recommendedRamMb;
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
  if (inspection.value?.format === 'curseforge' && !curseForgeKeyConfigured.value) {
    toast('error', '请先设置 CurseForge API Key / Configure the CurseForge API Key first', '保存后返回导入页，重新选择整合包再导入 / Save it, then return and select the pack again.');
    return;
  }
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

function backgroundJob() {
  if (jobId.value && mode.value !== 'new') setBackgroundJob(jobId.value);
  showJob.value = false;
}
</script>

<template>
  <div class="page col gap-4 wizard-page">
    <div class="page-heading">
      <h1>{{ mode === 'new' ? '新建世界' : '导入整合包' }}</h1>
      <p>{{ mode === 'new' ? '选择 Minecraft 版本与加载器，面板会自动下载服务端并生成配置。' : '支持 CurseForge、Modrinth 与 BlockCraft 备份包。' }}</p>
    </div>

    <div class="wizard-layout" :class="{ 'wizard-fixed': mode === 'new' }">
      <div class="wizard-main">
        <!-- 新建世界（分步） -->
        <div v-if="mode === 'new'" class="card wizard-form-card">
      <div class="card-head">
        <h3><span class="head-icon"><Icon name="plus" :size="15" /></span>新建世界</h3>
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
            <div class="field" style="grid-column: 1 / -1">
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
              <div v-if="loadingMinecraftVersions && !versionsLoaded" class="skeleton wizard-field-skeleton" aria-label="正在读取 Minecraft 版本" />
              <UiSelect v-else-if="versions.length" v-model="form.mc" class="select" @change="refreshLoaders">
                <option v-for="v in versions" :key="v.id" :value="v.id">{{ v.id }}</option>
              </UiSelect>
              <input v-else v-model="form.mc" class="input mono" @change="refreshLoaders" />
            </div>
            <div class="field" style="min-width: 200px">
              <label class="field-label">加载器</label>
              <div v-if="loadingVersions && loaderSnapshotMc !== form.mc" class="skeleton wizard-field-skeleton" aria-label="正在读取加载器" />
              <UiSelect v-else v-model="form.loader" class="select" :disabled="loadingVersions && loaderSnapshotMc !== form.mc" @change="form.loaderVersion = currentLoader?.suggested ?? ''">
                <option v-for="l in loaders" :key="l.loader" :value="l.loader" :disabled="!l.available">
                  {{ l.label }}{{ l.available ? '' : '（不可用）' }}
                </option>
              </UiSelect>
            </div>
            <div class="field" style="min-width: 200px">
              <label class="field-label">加载器版本</label>
              <div v-if="loadingVersions && loaderSnapshotMc !== form.mc" class="skeleton wizard-field-skeleton" aria-label="正在读取加载器版本" />
              <UiSelect v-else-if="currentLoader?.versions.length" v-model="form.loaderVersion" class="select" :disabled="loadingVersions && loaderSnapshotMc !== form.mc">
                <option v-for="v in currentLoader.versions" :key="v" :value="v">{{ v }}</option>
              </UiSelect>
              <input v-else v-model="form.loaderVersion" class="input mono" placeholder="原版无需填写" />
            </div>
          </div>
          <div v-if="loadingVersions && loaderSnapshotMc !== form.mc" class="wizard-loader-note-skeleton" role="status" aria-label="正在查询可用版本" aria-busy="true">
            <span class="skeleton wizard-loader-note-line" />
            <span class="skeleton wizard-loader-note-line short" />
          </div>
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
              <UiSelect v-model="form.gamemode" class="select">
                <option value="survival">生存</option>
                <option value="creative">创造</option>
                <option value="adventure">冒险</option>
                <option value="spectator">旁观</option>
              </UiSelect>
            </div>
            <div class="field">
              <label class="field-label">难度</label>
              <UiSelect v-model="form.difficulty" class="select">
                <option value="peaceful">和平</option>
                <option value="easy">简单</option>
                <option value="normal">普通</option>
                <option value="hard">困难</option>
              </UiSelect>
            </div>
          </div>
          <div class="col gap-3">
            <div class="row gap-4 wrap">
              <label class="switch"><input v-model="form.pvp" type="checkbox" /><span class="switch-track" /><span class="switch-text">允许 PVP</span></label>
              <label class="switch"><input v-model="form.hardcore" type="checkbox" /><span class="switch-track" /><span class="switch-text">极限模式</span></label>
              <label class="switch"><input v-model="form.allowNether" type="checkbox" /><span class="switch-track" /><span class="switch-text">允许下界</span></label>
              <label class="switch"><input v-model="form.allowFlight" type="checkbox" /><span class="switch-track" /><span class="switch-text">允许飞行</span></label>
              <label class="switch"><input v-model="form.generateStructures" type="checkbox" /><span class="switch-track" /><span class="switch-text">生成建筑</span></label>
            </div>
            <div class="row gap-4 wrap">
              <label class="switch"><input v-model="form.onlineMode" type="checkbox" /><span class="switch-track" /><span class="switch-text">正版验证</span></label>
              <label class="switch"><input v-model="form.whiteList" type="checkbox" /><span class="switch-track" /><span class="switch-text">开启白名单</span></label>
            </div>
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
          <button v-else class="btn btn-primary" :disabled="busy" @click="submitNew">创建世界</button>
        </div>
      </div>
    </div>

    <!-- 导入整合包 -->
    <div v-else class="card wizard-form-card">
      <div class="card-head"><h3><span class="head-icon"><Icon name="package" :size="15" /></span>导入整合包</h3></div>
      <div class="card-body col gap-4">
        <div class="row gap-2 wrap">
          <label class="btn btn-soft" :class="{ 'pack-upload-disabled': uploadingPack }" :aria-disabled="uploadingPack">
            + 上传压缩包（.zip / .mrpack）
            <input type="file" accept=".zip,.mrpack" style="display: none" :disabled="uploadingPack" @change="uploadPack" />
          </label>
          <span class="text-3 small">也可以把包放到 <code class="mono">data/store/packs/</code> 下再刷新</span>
        </div>

        <div
          v-if="packUploadProgress"
          class="pack-upload-progress"
          :class="{ 'pack-upload-failed': packUploadProgress.state === 'failed', 'pack-upload-done': packUploadProgress.state === 'done' }"
          role="status"
          aria-live="polite"
        >
          <div class="row-between wrap gap-2">
            <span>{{ packUploadProgress.state === 'uploading' ? '正在上传整合包' : packUploadProgress.state === 'done' ? '上传完成' : '上传失败，可重新选择文件' }}</span>
            <span class="small text-3">{{ formatBytes(packUploadProgress.loaded) }} / {{ formatBytes(packUploadProgress.total) }} · {{ packUploadProgress.percent }}%</span>
          </div>
          <div class="meter" role="progressbar" :aria-valuenow="packUploadProgress.percent" aria-valuemin="0" aria-valuemax="100" :aria-label="`整合包上传进度 ${packUploadProgress.percent}%`">
            <div class="meter-fill" :class="{ danger: packUploadProgress.state === 'failed' }" :style="{ width: `${packUploadProgress.percent}%` }" />
          </div>
        </div>

        <div v-if="packsLoading && !packsLoaded" class="import-pack-skeleton-list" role="status" aria-label="正在读取整合包" aria-busy="true">
          <div v-for="slot in 3" :key="slot" class="pack-row import-pack-skeleton-row" aria-hidden="true">
            <span class="skeleton import-pack-skeleton-name" />
            <span class="skeleton import-pack-skeleton-size" />
          </div>
        </div>
        <div v-else-if="!packs.length" class="import-empty">
          <div class="import-empty-head">
            <span class="import-empty-icon"><Icon name="package" :size="22" /></span>
            <div>
              <strong>还没有整合包</strong>
              <p class="text-3 small">上传一个，或把文件放进 <code class="mono">data/store/packs/</code> 再刷新。</p>
            </div>
          </div>
          <div class="import-formats">
            <div class="import-format">
              <Icon name="package" :size="17" />
              <strong>CurseForge</strong>
              <span>.zip · 需要 API Key</span>
            </div>
            <div class="import-format">
              <Icon name="globe" :size="17" />
              <strong>Modrinth</strong>
              <span>.mrpack · 无需 Key</span>
            </div>
            <div class="import-format">
              <Icon name="backups" :size="17" />
              <strong>BlockCraft 备份</strong>
              <span>.zip · 直接导入</span>
            </div>
          </div>
        </div>
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

        <div v-if="inspection?.format === 'curseforge' && !importSettingsLoading && !curseForgeKeyConfigured" class="import-key-warning">
          <div>
            <strong>需要先设置 CurseForge API Key / CurseForge API Key required</strong>
            <p>此整合包需要 API Key 才能下载模组和必需依赖。请到设置页填写并保存，然后返回本页重新选择整合包再导入。新建世界不受影响。</p>
            <p>This pack needs an API Key to download mods and required dependencies. Save the key in Settings, then return here and select the pack again. Creating a new world is unaffected.</p>
          </div>
          <button class="btn btn-soft" @click="router.push('/settings')">去设置 / Settings</button>
        </div>

        <div v-if="inspecting" class="card card-pad import-inspection-skeleton" role="status" aria-label="正在解析整合包" aria-busy="true">
          <div class="row gap-2 wrap">
            <span class="skeleton import-inspection-badge" />
            <span class="skeleton import-inspection-badge wide" />
            <span class="skeleton import-inspection-badge" />
          </div>
          <span class="skeleton import-inspection-line" />
          <span class="skeleton import-inspection-line short" />
        </div>
        <div v-else-if="inspection" class="card card-pad" style="background: var(--surface-2)">
          <div class="col gap-2">
            <div class="row gap-2 wrap">
              <span class="badge badge-accent">{{ inspection.format }}</span>
              <span v-if="inspection.packName" class="badge badge-outline">{{ inspection.packName }}</span>
              <span v-if="inspection.mc" class="badge badge-info">MC {{ inspection.mc }}</span>
              <span v-if="inspection.loader" class="badge badge-info">{{ inspection.loader }} {{ inspection.loaderVersion }}</span>
            </div>
            <div class="text-3 small">{{ inspection.note }}</div>
            <div v-if="inspection.filesToDownload || inspection.optionalFiles" class="text-3 small">
              必需文件 {{ inspection.filesToDownload }} 个<span v-if="inspection.optionalFiles">；另有 {{ inspection.optionalFiles }} 个可选文件，默认跳过</span>
            </div>
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
              <UiSelect v-model="importForm.loader" class="select">
                <option value="forge">Forge</option>
                <option value="neoforge">NeoForge</option>
                <option value="fabric">Fabric</option>
                <option value="paper">Paper</option>
                <option value="vanilla">原版</option>
              </UiSelect>
            </div>
            <div class="field">
              <label class="field-label">加载器版本</label>
              <input v-model="importForm.loaderVersion" class="input mono" />
            </div>
            <div class="field">
              <label class="field-label">内存上限（MB）</label>
              <input v-model.number="importForm.memoryMb" class="input" type="number" step="512" />
              <span v-if="inspection.recommendedRamMb" class="text-3 small">整合包建议至少 {{ inspection.recommendedRamMb }} MB；已按建议值预填。</span>
            </div>
          </div>
          <div v-if="importRamBelowRecommended" class="import-key-warning">
            <div>
              <strong>内存低于整合包建议值 / Below pack recommendation</strong>
              <p>当前设置 {{ importForm.memoryMb }} MB，整合包建议 {{ inspection.recommendedRamMb }} MB；大型整合包可能无法启动或运行不稳定。</p>
              <p>Current setting: {{ importForm.memoryMb }} MB. The pack recommends {{ inspection.recommendedRamMb }} MB; large packs may fail to start or run unreliably.</p>
            </div>
            <button class="btn btn-soft" @click="importForm.memoryMb = inspection?.recommendedRamMb ?? importForm.memoryMb">使用建议值</button>
          </div>
          <label class="switch"><input v-model="importForm.start" type="checkbox" /><span class="switch-track" /><span class="switch-text">导入完成后立即启动</span></label>
          <p class="text-3 small skin-support-hint">{{ importSkinSupportHint }} 如果整合包已包含组件会保留；只有上游发布了兼容版本时才会补装。</p>
        </template>
      </div>
      <div class="card-foot row-between">
        <span class="text-3 small">CurseForge 整合包需要在设置页保存 API Key 后才能导入；新建世界不受影响。</span>
        <button class="btn btn-primary" :disabled="busy || importSettingsLoading || !inspection || !importForm.name || !importForm.mc || (inspection.format === 'curseforge' && !curseForgeKeyConfigured)" @click="submitImport">
          开始导入
        </button>
      </div>
    </div>

        <section class="card wizard-summary-card">
          <div class="card-head">
            <h3><span class="head-icon"><Icon name="server" :size="15" /></span>当前配置</h3>
          </div>
          <div class="card-body col gap-2">
            <template v-if="mode === 'new'">
              <div class="aside-kv"><span>名称</span><strong>{{ form.name || '未命名' }}</strong></div>
              <div class="aside-kv"><span>版本</span><strong>Minecraft {{ form.mc }}</strong></div>
              <div class="aside-kv"><span>加载器</span><strong>{{ currentLoader?.label ?? form.loader }} <template v-if="form.loaderVersion">{{ form.loaderVersion }}</template></strong></div>
              <div class="aside-kv"><span>内存</span><strong>{{ form.minMemoryMb }}–{{ form.memoryMb }} MB</strong></div>
              <div class="aside-kv"><span>最大玩家</span><strong>{{ form.maxPlayers }}</strong></div>
            </template>
            <template v-else>
              <div class="aside-kv"><span>整合包</span><strong class="mono">{{ importForm.packId || '未选择' }}</strong></div>
              <div class="aside-kv"><span>名称</span><strong>{{ importForm.name || '未命名' }}</strong></div>
              <div class="aside-kv"><span>版本</span><strong>{{ importForm.mc || '未识别' }}</strong></div>
              <div class="aside-kv"><span>加载器</span><strong>{{ importForm.loader }} <template v-if="importForm.loaderVersion">{{ importForm.loaderVersion }}</template></strong></div>
              <div class="aside-kv"><span>内存</span><strong>{{ importForm.memoryMb }} MB</strong></div>
            </template>
          </div>
        </section>
      </div>

      <aside class="wizard-aside col gap-4">
        <section class="card aside-card wizard-flow-card">
          <div class="card-head">
            <h3><span class="head-icon"><Icon name="sparkle" :size="15" /></span>{{ mode === 'new' ? '创建流程' : '导入流程' }}</h3>
          </div>
          <div class="card-body col gap-2">
            <template v-if="mode === 'new'">
              <div
                v-for="(s, i) in steps"
                :key="s"
                class="aside-step"
                :class="{ active: step === i + 1, done: step > i + 1 }"
              >
                <span class="aside-step-index">{{ i + 1 }}</span>
                <span class="grow">{{ s }}</span>
                <Icon v-if="step > i + 1" name="check" :size="14" />
              </div>
            </template>
            <template v-else>
              <div class="aside-step" :class="{ active: !inspection, done: Boolean(inspection) }">
                <span class="aside-step-index">1</span>
                <span class="grow">上传或选择整合包</span>
                <Icon v-if="inspection" name="check" :size="14" />
              </div>
              <div class="aside-step" :class="{ active: Boolean(inspection) }">
                <span class="aside-step-index">2</span>
                <span class="grow">确认版本、内存与名称</span>
              </div>
              <div class="aside-step">
                <span class="aside-step-index">3</span>
                <span class="grow">开始导入并等待任务</span>
              </div>
            </template>
          </div>
        </section>

        <section class="card aside-card wizard-tips-card">
          <div class="card-head">
            <h3><span class="head-icon"><Icon name="info" :size="15" /></span>提示</h3>
          </div>
          <div class="card-body col gap-3 aside-tips">
            <template v-if="mode === 'new'">
              <p>服务端与加载器依赖由面板自动下载；本机没有对应 Java 时会自动安装。</p>
              <p>端口和 FRP 映射在创建完成后自动分配，不需要手填。</p>
              <p>内存预算会在启动时校验，超出机器可用内存的面板会拒绝启动并说明原因。</p>
              <button class="btn btn-soft" @click="router.push('/import')">
                <Icon name="package" :size="15" /> 改为导入整合包
              </button>
            </template>
            <template v-else>
              <p>支持 CurseForge、Modrinth 以及 BlockCraft 导出的备份包。</p>
              <p>CurseForge 整合包需要先在设置页保存 API Key；Modrinth 不需要。</p>
              <p>导入会在后台继续，离开本页不会中断，可在任务中心查看进度。</p>
              <button class="btn btn-soft" @click="router.push('/create')">
                <Icon name="plus" :size="15" /> 改为新建世界
              </button>
            </template>
          </div>
        </section>
      </aside>
    </div>

    <JobProgress :open="showJob" :job-id="jobId" @close="closeJob" @background="backgroundJob" />
  </div>
</template>

<style scoped>
.wizard-page { min-height: calc(100vh - var(--header-h)); justify-content: flex-start; padding-top: clamp(18px, 3vh, 34px); }
.wizard-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(280px, 1fr);
  align-items: stretch;
  gap: var(--sp-4);
}
/* The wrappers only group the cards semantically; display:contents lets the
   four cards share the same grid rows, so the 2x2 block edges line up. */
.wizard-main, .wizard-aside { display: contents; }
.wizard-form-card { grid-column: 1; grid-row: 1; }
.wizard-flow-card { grid-column: 2; grid-row: 1; }
.wizard-summary-card { grid-column: 1; grid-row: 2; }
.wizard-tips-card { grid-column: 2; grid-row: 2; }
.wizard-form-card, .wizard-flow-card, .wizard-summary-card, .wizard-tips-card { min-width: 0; }
.wizard-form-card > .card-head, .wizard-flow-card > .card-head { min-height: 53px; }
/* Keep the four blocks at the step-1 dimensions for every step. Longer step
   bodies scroll inside the card instead of resizing the whole grid. */
.wizard-layout.wizard-fixed { grid-template-rows: 338px 219px; }
.wizard-fixed .wizard-form-card,
.wizard-fixed .wizard-flow-card,
.wizard-fixed .wizard-summary-card,
.wizard-fixed .wizard-tips-card { display: flex; min-height: 0; flex-direction: column; }
.wizard-fixed .wizard-form-card > .card-head,
.wizard-fixed .wizard-flow-card > .card-head,
.wizard-fixed .wizard-summary-card > .card-head,
.wizard-fixed .wizard-tips-card > .card-head,
.wizard-fixed .wizard-form-card > .card-foot { flex: none; }
.wizard-fixed .wizard-form-card > .card-body { flex: 1; min-height: 0; overflow-y: auto; }
.wizard-fixed .wizard-flow-card > .card-body,
.wizard-fixed .wizard-summary-card > .card-body,
.wizard-fixed .wizard-tips-card > .card-body { flex: 1; min-height: 0; overflow: hidden; }
.wizard-fixed .wizard-form-card .kv { gap: 4px; }
.aside-step {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--text-3);
  font-size: 12.5px;
  transition: background 0.16s, border-color 0.16s, color 0.16s;
}
.aside-step.active { border-color: var(--accent-border); background: var(--accent-soft); color: var(--text); }
.aside-step.done { color: var(--text-2); }
.aside-step > svg { flex: none; color: var(--ok); }
.aside-step-index {
  display: grid;
  width: 22px;
  height: 22px;
  flex: none;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-2);
  font-size: 11px;
  font-weight: 700;
}
.aside-step.active .aside-step-index { border-color: var(--accent-strong); background: var(--accent-strong); color: var(--accent-contrast); }
.aside-step.done .aside-step-index { border-color: var(--ok); background: var(--ok-soft); color: var(--ok-text); }
.aside-tips p { margin: 0; color: var(--text-2); font-size: 12.5px; line-height: 1.65; }
.aside-tips .btn { justify-content: flex-start; }
.aside-kv { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 12.5px; }
.aside-kv > span { flex: none; color: var(--text-3); }
.aside-kv > strong { overflow: hidden; font-weight: 600; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.import-empty {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r);
  background: var(--surface-2);
}
.import-empty-head { display: flex; align-items: center; gap: 12px; }
.import-empty-head strong { display: block; font-size: 13.5px; }
.import-empty-head p { margin: 3px 0 0; }
.import-empty-icon {
  display: grid;
  width: 46px;
  height: 46px;
  flex: none;
  place-items: center;
  border: 1px solid var(--accent-border);
  border-radius: 14px;
  background: var(--accent-soft);
  color: var(--accent-text);
}
.import-formats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.import-format {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  padding: 10px 11px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-strong);
}
.import-format > svg { color: var(--accent-text); }
.import-format strong { margin-top: 2px; font-size: 12px; font-weight: 650; }
.import-format span { color: var(--text-3); font-size: 10.5px; }
.import-pack-skeleton-list { display: grid; gap: 8px; }
.import-pack-skeleton-row { cursor: default; }
.import-pack-skeleton-name { width: min(54%, 360px); height: 13px; }
.import-pack-skeleton-size { width: 56px; height: 11px; }
.import-inspection-skeleton { display: grid; gap: 11px; background: var(--surface-2); }
.import-inspection-badge { width: 70px; height: 22px; border-radius: 999px; }
.import-inspection-badge.wide { width: 130px; }
.import-inspection-line { width: 92%; height: 12px; }
.import-inspection-line.short { width: 58%; }
.skin-support-hint {
  max-width: 860px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent-strong);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  line-height: 1.6;
}
.wizard-steps { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; }
.wizard-step { max-width: 100%; }
.wizard-steps { min-width: 0; }
.wizard-field-skeleton { height: 38px; }
.wizard-loader-note-skeleton { display: grid; gap: 7px; width: min(100%, 440px); padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); }
.wizard-loader-note-line { height: 11px; }
.wizard-loader-note-line.short { width: 56%; }
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
.pack-row.active { border-color: var(--accent-strong); background: var(--accent-soft); }
.pack-upload-progress { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); }
.pack-upload-done { border-color: var(--ok); }
.pack-upload-failed { border-color: var(--danger); }
.pack-upload-disabled { cursor: progress; opacity: .65; }
.import-key-warning { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px; border: 1px solid var(--border); border-left: 3px solid var(--warn); border-radius: var(--r-sm); background: var(--surface-2); }
.import-key-warning p { margin: 6px 0 0; }
@media (max-width: 620px) { .import-key-warning { align-items: flex-start; flex-direction: column; } }
@media (max-width: 1100px) {
  .wizard-layout { grid-template-columns: minmax(0, 1fr); }
  .wizard-layout.wizard-fixed { grid-template-rows: none; }
  .wizard-main, .wizard-aside { display: flex; flex-direction: column; gap: var(--sp-4); }
  .wizard-form-card, .wizard-flow-card, .wizard-summary-card, .wizard-tips-card { grid-column: auto; grid-row: auto; }
  .wizard-fixed .wizard-form-card > .card-body,
  .wizard-fixed .wizard-flow-card > .card-body,
  .wizard-fixed .wizard-summary-card > .card-body,
  .wizard-fixed .wizard-tips-card > .card-body { overflow: visible; }
}
@media (max-width: 720px) {
  .import-formats { grid-template-columns: minmax(0, 1fr); }
}
</style>
