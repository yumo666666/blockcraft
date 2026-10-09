<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import { fmtBytes } from '../lib/format.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';

const router = useRouter();
const panel = ref<{
  config: Record<string, never>;
  addresses: { label: string; value: string; kind: string }[];
  instanceDir: string;
  dataDir: string;
  projectRoot: string;
  java: { installed: { major: number; path: string }[]; managed: boolean };
} | null>(null);
const storage = ref<{
  instances: { id: string; name: string; bytes: number; mods: number }[];
  jdk: number;
  store: number;
  trash: number;
  logs: number;
  total: number;
} | null>(null);
const frpBinary = ref(false);
const busy = ref(false);

const form = ref({
  maxRunningInstances: 3,
  memoryBudget: 'auto' as string,
  sessionHours: 72,
  trashRetentionDays: 7,
  curseforgeApiKey: '',
  curseforgeApiUrl: 'https://api.curseforge.com/v1',
  githubMirror: 'https://gh-proxy.com/',
  exposePanel: false,
  panelRemotePort: 26000,
  configRollback: true,
  gameRangeStart: 25565,
  gameRangeEnd: 25609,
  frpRangeStart: 26000,
  frpRangeEnd: 27000,
});

const newToken = ref('');
const showResetToken = ref(false);
const showClean = ref(false);
const cleanTarget = ref<'trash' | 'logs'>('trash');
const cleanFreed = ref(0);

async function load() {
  const p = await api.get<typeof panel.value>('/api/panel');
  panel.value = p;
  const cfg = p?.config as unknown as {
    limits: { maxRunningInstances: number; memoryBudgetMb: number | 'auto' };
    panel: { sessionHours: number };
    ui: { trashRetentionDays: number };
    mirrors: { curseforgeApiKey: string; curseforgeApi: string; githubMirror: string };
    frp: { exposePanel: boolean; panelRemotePort: number; configRollback: boolean };
    portRanges: { game: [number, number]; frpRemote: [number, number] };
  };
  if (cfg) {
    form.value.maxRunningInstances = cfg.limits.maxRunningInstances;
    form.value.memoryBudget = String(cfg.limits.memoryBudgetMb);
    form.value.sessionHours = cfg.panel.sessionHours;
    form.value.trashRetentionDays = cfg.ui.trashRetentionDays;
    form.value.curseforgeApiKey = cfg.mirrors.curseforgeApiKey === '••••••' ? '' : cfg.mirrors.curseforgeApiKey;
    form.value.curseforgeApiUrl = cfg.mirrors.curseforgeApi;
    form.value.githubMirror = cfg.mirrors.githubMirror;
    form.value.exposePanel = cfg.frp.exposePanel;
    form.value.panelRemotePort = cfg.frp.panelRemotePort;
    form.value.configRollback = cfg.frp.configRollback;
    form.value.gameRangeStart = cfg.portRanges.game[0];
    form.value.gameRangeEnd = cfg.portRanges.game[1];
    form.value.frpRangeStart = cfg.portRanges.frpRemote[0];
    form.value.frpRangeEnd = cfg.portRanges.frpRemote[1];
  }
  storage.value = await api.get('/api/system/storage');
  const st = await api.get<{ binaryReady: boolean }>('/api/frp/status').catch(() => null);
  frpBinary.value = st?.binaryReady ?? false;
}

onMounted(() => {
  load().catch((err) => toastError(err, '读取设置失败'));
});

async function copyAddr(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast('ok', '已复制', value);
  } catch {
    toast('warn', '复制失败', '浏览器拒绝了剪贴板权限，请手动复制');
  }
}

async function saveAll() {
  busy.value = true;
  try {
    await api.put('/api/panel', {
      limits: { maxRunningInstances: form.value.maxRunningInstances, memoryBudgetMb: form.value.memoryBudget === 'auto' ? 'auto' : Number(form.value.memoryBudget) },
      panel: { sessionHours: form.value.sessionHours },
      ui: { trashRetentionDays: form.value.trashRetentionDays },
      portRanges: {
        game: [form.value.gameRangeStart, form.value.gameRangeEnd],
        frpRemote: [form.value.frpRangeStart, form.value.frpRangeEnd],
      },
      mirrors: {
        curseforgeApi: form.value.curseforgeApiUrl,
        githubMirror: form.value.githubMirror,
        ...(form.value.curseforgeApiKey ? { curseforgeApiKey: form.value.curseforgeApiKey } : {}),
      },
    });
    await api.put('/api/frp/config', {
      exposePanel: form.value.exposePanel,
      panelRemotePort: form.value.panelRemotePort,
      configRollback: form.value.configRollback,
    });
    toast('ok', '设置已保存', '端口段改动会在下次分配端口时生效');
  } catch (err) {
    toastError(err, '保存失败');
  } finally {
    busy.value = false;
  }
}

async function resetToken() {
  try {
    const r = await api.post<{ token: string }>('/api/panel/token/reset');
    newToken.value = r.token;
    showResetToken.value = true;
  } catch (err) {
    toastError(err, '重置令牌失败');
  }
}

async function downloadFrpc() {
  busy.value = true;
  try {
    await api.post('/api/frp/install');
    toast('ok', 'frpc 已下载', '现在可以在总览页做一键自检');
    await load();
  } catch (err) {
    toastError(err, '下载 frpc 失败');
  } finally {
    busy.value = false;
  }
}

async function doClean() {
  busy.value = true;
  try {
    const r = await api.post<{ freed: number }>('/api/system/storage/clean', { target: cleanTarget.value });
    toast('ok', '已清理', `释放 ${fmtBytes(r.freed)}`);
    showClean.value = false;
    await load();
  } catch (err) {
    toastError(err, '清理失败');
  } finally {
    busy.value = false;
  }
}

async function killWorld(id: string) {
  try {
    await api.post(`/api/instances/${id}/stop`, {});
    toast('ok', '已停止');
    await load();
  } catch (err) {
    toastError(err, '停止失败');
  }
}
</script>

<template>
  <div class="page col gap-4">
    <div class="row gap-3">
      <button class="btn btn-ghost btn-sm" @click="router.push('/')">← 返回总览</button>
      <h1>面板设置</h1>
    </div>

    <div v-if="!panel" class="row gap-2"><span class="spinner" /> 读取中…</div>

    <template v-else>
      <div class="settings-grid">
        <!-- 访问 -->
        <div class="card settings-access">
          <div class="card-head"><h3>访问</h3></div>
          <div class="card-body col gap-3">
            <div class="field">
              <label class="field-label">局域网地址（点一下复制）</label>
              <div class="col gap-2">
                <button v-for="a in panel.addresses" :key="a.value" class="addr-row" @click="copyAddr(a.value)">
                  <span class="badge badge-outline">{{ a.kind === 'lan' ? '局域网' : a.kind === 'vpn' ? 'VPN' : '其它' }}</span>
                  <span class="mono grow">{{ a.value }}</span>
                </button>
              </div>
            </div>
            <div class="field">
              <label class="field-label">登录令牌</label>
              <div class="row gap-2">
                <button class="btn" @click="resetToken">重置令牌</button>
                <span class="field-hint">重置后所有设备需要重新登录</span>
              </div>
            </div>
            <div class="field">
              <label class="field-label">登录有效期（小时）</label>
              <input v-model.number="form.sessionHours" class="input" type="number" />
            </div>
          </div>
        </div>

        <!-- 限额 -->
        <div class="card settings-limits">
          <div class="card-head"><h3>资源限额</h3></div>
          <div class="card-body col gap-3">
            <div class="field">
              <label class="field-label">最多同时运行的世界数</label>
              <input v-model.number="form.maxRunningInstances" class="input" type="number" min="1" />
            </div>
            <div class="field">
              <label class="field-label">总内存预算（MB，auto = 机器内存的 60%）</label>
              <input v-model="form.memoryBudget" class="input mono" />
            </div>
            <p class="text-3 small">所有在运行世界的 Xmx 之和超过预算时，面板会拒绝启动新世界并说明原因，而不是把机器拖垮。</p>
          </div>
        </div>

        <!-- Java -->
        <div class="card settings-java">
          <div class="card-head"><h3>Java 环境</h3></div>
          <div class="card-body col gap-2">
            <div v-if="!panel.java.installed.length" class="badge badge-warn">本机没有检测到 Java，创建世界前需要先安装</div>
            <div v-for="j in panel.java.installed" :key="j.path" class="row gap-2">
              <span class="badge badge-ok">Java {{ j.major }}</span>
              <span class="mono small ellipsis">{{ j.path }}</span>
            </div>
            <p class="text-3 small">面板按世界的 MC 版本自动挑选 Java（向上取最近的可用版本）。</p>
          </div>
        </div>

        <!-- FRP -->
        <div class="card settings-frp">
          <div class="card-head"><h3>FRP</h3></div>
          <div class="card-body col gap-3">
            <div class="row gap-2">
              <span class="badge" :class="frpBinary ? 'badge-ok' : 'badge-warn'">{{ frpBinary ? 'frpc 已就绪' : 'frpc 未安装' }}</span>
              <button class="btn btn-sm" :disabled="busy" @click="downloadFrpc">下载 frpc</button>
            </div>
            <label class="switch">
              <input v-model="form.exposePanel" type="checkbox" />
              <span class="switch-track" />
              <span class="switch-text">把面板暴露到公网</span>
            </label>
            <div class="field">
              <label class="field-label">面板远端端口</label>
              <input v-model.number="form.panelRemotePort" class="input mono" type="number" />
            </div>
            <label class="switch">
              <input v-model="form.configRollback" type="checkbox" />
              <span class="switch-track" />
              <span class="switch-text">配置自检失败时自动回滚上一版</span>
            </label>
            <p class="text-3 small">面板通道与世界通道是两个独立的 frpc 进程：新建/启停世界不会影响面板连接。</p>
          </div>
        </div>

        <!-- 端口段 -->
        <div class="card settings-ports">
          <div class="card-head"><h3>端口段</h3></div>
          <div class="card-body col gap-3">
            <div class="form-grid-2">
              <div class="field">
                <label class="field-label">本地游戏端口 起</label>
                <input v-model.number="form.gameRangeStart" class="input mono" type="number" />
              </div>
              <div class="field">
                <label class="field-label">本地游戏端口 止</label>
                <input v-model.number="form.gameRangeEnd" class="input mono" type="number" />
              </div>
              <div class="field">
                <label class="field-label">远端 FRP 端口 起</label>
                <input v-model.number="form.frpRangeStart" class="input mono" type="number" />
              </div>
              <div class="field">
                <label class="field-label">远端 FRP 端口 止</label>
                <input v-model.number="form.frpRangeEnd" class="input mono" type="number" />
              </div>
            </div>
            <p class="text-3 small">远端端口段必须落在 frps 允许的范围内，否则服务端会拒绝建立映射。</p>
          </div>
        </div>

        <!-- 数据源 -->
        <div class="card settings-source">
          <div class="card-head"><h3>数据源</h3></div>
          <div class="card-body col gap-3">
            <div class="field">
              <label class="field-label">CurseForge API Key（可选）</label>
              <input v-model="form.curseforgeApiKey" class="input mono" type="password" placeholder="不填则无法自动下载 CurseForge 整合包的 MOD" />
              <span class="field-hint">
                在 console.curseforge.com 免费申请。没有 Key 时：MOD 元数据仍能从 jar 里读出来，整合包会列出人工下载清单。
              </span>
            </div>
            <div class="field">
              <label class="field-label">CurseForge API 地址</label>
              <input v-model="form.curseforgeApiUrl" class="input mono" />
            </div>
            <div class="field">
              <label class="field-label">GitHub 加速前缀</label>
              <input v-model="form.githubMirror" class="input mono" />
              <span class="field-hint">国内直连 GitHub Releases 常常很慢或截断，填一个镜像前缀（如 https://gh-proxy.com/）</span>
            </div>
          </div>
        </div>

        <!-- 存储 -->
        <div class="card settings-storage">
          <div class="card-head"><h3>存储</h3></div>
          <div class="card-body storage-body">
            <div v-if="storage" class="col gap-2">
              <div class="kv storage-metrics">
                <div class="kv-row"><span class="kv-key">世界合计</span><span class="kv-val">{{ fmtBytes(storage.total) }}</span></div>
                <div class="kv-row"><span class="kv-key">下载缓存</span><span class="kv-val">{{ fmtBytes(storage.store) }}</span></div>
                <div class="kv-row"><span class="kv-key">回收站</span><span class="kv-val">{{ fmtBytes(storage.trash) }}</span></div>
                <div class="kv-row"><span class="kv-key">日志</span><span class="kv-val">{{ fmtBytes(storage.logs) }}</span></div>
                <div v-if="storage.jdk" class="kv-row"><span class="kv-key">内置 JDK</span><span class="kv-val">{{ fmtBytes(storage.jdk) }}</span></div>
              </div>
              <div class="divider" />
              <div v-if="storage.instances.length" class="storage-instance-list">
                <div v-for="i in storage.instances" :key="i.id" class="storage-instance row gap-2">
                  <span class="grow ellipsis">{{ i.name }}</span>
                  <span class="text-3 small">{{ i.mods }} MOD</span>
                  <span class="mono small">{{ fmtBytes(i.bytes) }}</span>
                  <button class="btn btn-ghost btn-sm" title="停止这个世界" @click="killWorld(i.id)">停止</button>
                </div>
              </div>
            </div>
            <div class="col gap-3">
              <div class="row gap-2">
                <button class="btn btn-danger" @click="((cleanTarget = 'trash'), (showClean = true))">清空回收站</button>
                <button class="btn" @click="((cleanTarget = 'logs'), (showClean = true))">清理日志</button>
              </div>
              <div class="field">
                <label class="field-label">删除世界的回收站保留天数</label>
                <input v-model.number="form.trashRetentionDays" class="input" type="number" />
              </div>
            </div>
          </div>
        </div>

        <!-- 关于 -->
        <div class="card settings-about">
          <div class="card-head"><h3>关于</h3></div>
          <div class="card-body col gap-2">
            <div class="kv">
              <div class="kv-row"><span class="kv-key">版本</span><span class="kv-val">BlockCraft 2.2.1</span></div>
              <div class="kv-row"><span class="kv-key">项目目录</span><span class="kv-val mono small ellipsis">{{ panel.projectRoot }}</span></div>
              <div class="kv-row"><span class="kv-key">数据目录</span><span class="kv-val mono small ellipsis">{{ panel.dataDir }}</span></div>
              <div class="kv-row"><span class="kv-key">世界目录</span><span class="kv-val mono small ellipsis">{{ panel.instanceDir }}</span></div>
            </div>
            <p class="text-3 small">
              开源项目。不含任何内置密钥与第三方镜像；所有凭据由使用者自己填写。
            </p>
          </div>
        </div>
      </div>

      <div class="row-between card card-pad settings-save-bar">
        <span class="text-3 small">改端口段与令牌后建议重启面板进程。</span>
        <button class="btn btn-primary btn-lg" :disabled="busy" @click="saveAll">保存全部设置</button>
      </div>
    </template>

    <ConfirmDialog
      :open="showResetToken"
      title="新的登录令牌"
      message="请立刻复制保存，这个令牌只会显示这一次："
      :detail="newToken"
      confirm-text="我已保存"
      @close="showResetToken = false"
      @confirm="showResetToken = false"
    />
    <ConfirmDialog
      :open="showClean"
      title="确认清理"
      :message="cleanTarget === 'trash' ? '确定清空回收站？被删除的世界将无法恢复。' : '确定清理日志文件？'"
      :confirm-text="'清理'"
      danger
      :busy="busy"
      @close="showClean = false"
      @confirm="doClean"
    />
  </div>
</template>

<style scoped>
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-areas:
    'access source'
    'limits java'
    'frp ports'
    'storage about';
  gap: var(--sp-4);
  align-items: stretch;
}
.settings-grid > .card { display: flex; flex-direction: column; min-width: 0; }
.settings-grid > .card > .card-body { flex: 1; min-width: 0; }
.settings-access { grid-area: access; }
.settings-source { grid-area: source; }
.settings-limits { grid-area: limits; }
.settings-java { grid-area: java; }
.settings-frp { grid-area: frp; }
.settings-ports { grid-area: ports; }
.settings-storage { grid-area: storage; }
.settings-about { grid-area: about; }
.settings-java > .card-body { justify-content: space-between; }
.storage-body { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(215px, 0.95fr); align-content: start; gap: var(--sp-4); }
.storage-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 20px; }
.storage-instance-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 7px; }
.storage-instance { min-width: 0; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); }
.settings-save-bar { flex-wrap: wrap; gap: var(--sp-3); }
.addr-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 11px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  font: inherit;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}
.addr-row:hover { border-color: var(--accent-border); background: var(--accent-soft); }
@media (max-width: 760px) {
  .settings-grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'access' 'source' 'limits' 'java' 'frp' 'ports' 'storage' 'about';
  }
  .settings-java > .card-body { justify-content: flex-start; }
}
@media (max-width: 560px) {
  .storage-body { grid-template-columns: minmax(0, 1fr); }
  .storage-metrics { grid-template-columns: minmax(0, 1fr); }
  .storage-instance-list { grid-template-columns: minmax(0, 1fr); }
  .settings-save-bar { align-items: flex-start; }
  .settings-save-bar .btn-lg { width: 100%; }
}
</style>
