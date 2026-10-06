<script setup lang="ts">
import { ref } from 'vue';
import type { FrpStatus } from '../lib/types.ts';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import Modal from './Modal.vue';
import { fmtBytes } from '../lib/format.ts';

const props = defineProps<{ status: FrpStatus | null }>();
const emit = defineEmits<{ refresh: [] }>();

const showSettings = ref(false);
const showCheck = ref(false);
const busy = ref(false);
const checkResult = ref<{ ok: boolean; steps: { step: string; ok: boolean; detail: string }[]; latencyMs: number | null } | null>(null);
const form = ref({
  serverAddr: '',
  serverPort: 7000,
  token: '',
  tls: true,
  exposePanel: true,
  panelRemotePort: 26000,
  enabled: true,
});

function openSettings() {
  const s = props.status;
  form.value = {
    serverAddr: s?.server.addr ?? '',
    serverPort: s?.server.port ?? 7000,
    token: '',
    tls: s?.server.tls ?? true,
    exposePanel: Boolean(s?.panelProxy),
    panelRemotePort: s?.panelProxy?.remotePort ?? 26000,
    enabled: s?.enabled ?? true,
  };
  showSettings.value = true;
}

async function save() {
  busy.value = true;
  try {
    const body: Record<string, unknown> = {
      serverAddr: form.value.serverAddr,
      serverPort: form.value.serverPort,
      tls: form.value.tls,
      exposePanel: form.value.exposePanel,
      panelRemotePort: form.value.panelRemotePort,
      enabled: form.value.enabled,
    };
    if (form.value.token) body.token = form.value.token;
    await api.put('/api/frp/config?apply=1', body);
    toast('ok', 'FRP 配置已保存并重载');
    showSettings.value = false;
    emit('refresh');
  } catch (err) {
    toastError(err, '保存 FRP 配置失败');
  } finally {
    busy.value = false;
  }
}

async function runCheck() {
  busy.value = true;
  showCheck.value = true;
  checkResult.value = null;
  try {
    checkResult.value = await api.post('/api/frp/self-check');
  } catch (err) {
    toastError(err, '自检失败');
  } finally {
    busy.value = false;
  }
}

async function reload(channel: string) {
  try {
    const r = await api.post<{ ok: boolean; error?: string }>('/api/frp/reload', { channel });
    if (r.ok) toast('ok', `${channel === 'panel' ? '面板通道' : '世界通道'}已重载`);
    else toast('warn', '重载失败（已回滚）', r.error);
    emit('refresh');
  } catch (err) {
    toastError(err, '重载失败');
  }
}
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>FRP 穿透</h3>
      <span class="badge" :class="status?.server.reachable ? 'badge-ok' : status?.configured ? 'badge-warn' : 'badge-outline'">
        {{ status?.server.reachable ? '已连接' : status?.configured ? '连接异常' : '未配置' }}
      </span>
    </div>
    <div class="card-body col gap-3">
      <template v-if="status">
        <div class="kv">
          <div class="kv-row">
            <span class="kv-key">服务器</span>
            <span class="kv-val mono">{{ status.server.addr || '未填写' }}:{{ status.server.port }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">延迟（面板实测）</span>
            <span class="kv-val">{{ status.server.latencyMs !== null ? status.server.latencyMs + ' ms' : '不可达' }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">远端端口段</span>
            <span class="kv-val mono">{{ status.remoteRange[0] }}–{{ status.remoteRange[1] }}</span>
          </div>
        </div>

        <div class="divider" />

        <!-- 两条通道分开显示：这也是设计上的隔离，世界通道崩了不会影响面板 -->
        <div class="col gap-2">
          <div v-for="ch in status.channels" :key="ch.name" class="channel-row">
            <i class="dot" :class="ch.running ? 'dot-ok' : 'dot-danger'" />
            <div class="grow">
              <div style="font-weight: 600; font-size: 13px">{{ ch.name === 'panel' ? '面板通道' : '世界通道' }}</div>
              <div class="text-3 small">
                {{ ch.running ? `${ch.proxyCount} 条映射` : ch.error || '未运行' }}
                <span v-if="ch.name === 'panel' && status.panelProxy"> · 端口 {{ status.panelProxy.remotePort }}</span>
              </div>
            </div>
            <button class="btn btn-ghost btn-sm" title="热重载" @click="reload(ch.name)">重载</button>
          </div>
        </div>

        <div v-if="status.panelProxy" class="mono-block small">
          公网面板地址：http://{{ status.server.addr }}:{{ status.panelProxy.remotePort }}
        </div>

        <div v-if="status.dashboard.available" class="text-3 small">
          服务端侧可见 {{ status.dashboard.proxies.filter((p) => p.status === 'online').length }} 条在线代理
          <span v-if="status.dashboard.proxies.some((p) => p.name !== 'panel' && !p.name.startsWith('mc-'))">
            （其中包含不属于本面板的条目，面板不会去动它们）
          </span>
        </div>
        <div v-else class="text-3 small">未配置 frps Dashboard，无法做服务端侧校核（可选）</div>
        <div v-if="!status.binaryReady" class="badge badge-warn">本机还没有 frpc，可在设置页一键下载</div>
      </template>
      <div v-else class="text-3 small">正在读取 FRP 状态…</div>
    </div>
    <div class="card-foot row gap-2">
      <button class="btn btn-sm" @click="openSettings">快捷设置</button>
      <button class="btn btn-sm" :disabled="busy" @click="runCheck">一键自检</button>
    </div>

    <Modal v-if="showSettings" title="FRP 快捷设置" size="md" @close="showSettings = false">
      <div class="form-grid-2">
        <div class="field">
          <label class="field-label">服务器地址</label>
          <input v-model="form.serverAddr" class="input mono" placeholder="1.2.3.4" />
        </div>
        <div class="field">
          <label class="field-label">服务端口</label>
          <input v-model.number="form.serverPort" class="input mono" type="number" />
        </div>
        <div class="field">
          <label class="field-label">认证 token</label>
          <input v-model="form.token" class="input mono" type="password" placeholder="留空表示不修改" />
        </div>
        <div class="field">
          <label class="field-label">面板远端端口</label>
          <input v-model.number="form.panelRemotePort" class="input mono" type="number" />
        </div>
      </div>
      <div class="row gap-4 mt-4 wrap">
        <label class="switch">
          <input v-model="form.enabled" type="checkbox" />
          <span class="switch-track" />
          <span class="switch-text">启用 FRP</span>
        </label>
        <label class="switch">
          <input v-model="form.tls" type="checkbox" />
          <span class="switch-track" />
          <span class="switch-text">启用 TLS</span>
        </label>
        <label class="switch">
          <input v-model="form.exposePanel" type="checkbox" />
          <span class="switch-track" />
          <span class="switch-text">把面板暴露到公网</span>
        </label>
      </div>
      <p class="text-3 small mt-3">
        保存后会重写配置并热重载。面板通道与世界通道是两个独立的 frpc 进程，改世界不会影响面板连接。
      </p>
      <template #footer>
        <button class="btn" @click="showSettings = false">取消</button>
        <button class="btn btn-primary" :disabled="busy" @click="save">保存并重载</button>
      </template>
    </Modal>

    <Modal v-if="showCheck" title="FRP 链路自检" size="md" @close="showCheck = false">
      <div v-if="busy" class="row gap-3"><span class="spinner" /> 正在做数据回环测试（约 3~8 秒）…</div>
      <div v-else-if="checkResult" class="col gap-3">
        <div class="badge" :class="checkResult.ok ? 'badge-ok' : 'badge-danger'">
          {{ checkResult.ok ? '链路正常' : '链路有问题' }}
        </div>
        <div v-for="s in checkResult.steps" :key="s.step" class="row gap-3" style="align-items: flex-start">
          <span class="badge" :class="s.ok ? 'badge-ok' : 'badge-danger'" style="margin-top: 2px">{{ s.ok ? '通过' : '失败' }}</span>
          <div class="grow">
            <div style="font-weight: 600; font-size: 13px">{{ s.step }}</div>
            <div class="text-3 small">{{ s.detail }}</div>
          </div>
        </div>
        <p class="text-3 small">
          注意：只探测「端口能不能连上」是不可靠的——服务端可能把整段端口都发布了，没有后端照样能连上。
          所以这里做的是真实的数据回环。
        </p>
      </div>
      <template #footer>
        <button class="btn" @click="showCheck = false">关闭</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.channel-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
}
</style>
