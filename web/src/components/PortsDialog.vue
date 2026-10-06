<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import Modal from './Modal.vue';

const props = defineProps<{ open: boolean; instanceId: string; name: string }>();
const emit = defineEmits<{ close: []; changed: [] }>();

interface Ports {
  local: number;
  rcon: number;
  remote: number | null;
  frpEnabled: boolean;
  connectPublic: string | null;
  range: [number, number];
}
const ports = ref<Ports | null>(null);
const busy = ref(false);

watch(
  () => props.open,
  async (v) => {
    if (!v) return;
    ports.value = null;
    try {
      ports.value = await api.get<Ports>(`/api/instances/${props.instanceId}/ports`);
    } catch (err) {
      toastError(err, '读取端口失败');
    }
  },
);

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('ok', '已复制', text);
  } catch {
    toast('warn', '复制失败', '浏览器拒绝了剪贴板权限');
  }
}

async function reassign() {
  busy.value = true;
  try {
    const r = await api.post<{ port: number; remotePort: number }>(`/api/instances/${props.instanceId}/ports/reassign`);
    toast('ok', '端口已重新分配', `本地 ${r.port} · 公网 ${r.remotePort}`);
    ports.value = await api.get<Ports>(`/api/instances/${props.instanceId}/ports`);
    emit('changed');
  } catch (err) {
    toastError(err, '重新分配失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal v-if="open" :title="`${name} · 端口`" size="sm" @close="emit('close')">
    <div v-if="!ports" class="row gap-2"><span class="spinner" /> 读取中…</div>
    <div v-else class="col gap-3">
      <div class="field">
        <label class="field-label">游戏端口（本地）</label>
        <div class="row gap-2">
          <div class="mono-block grow">{{ ports.local }}</div>
          <button class="btn btn-sm" @click="copy(String(ports.local))">复制</button>
        </div>
      </div>
      <div class="field">
        <label class="field-label">公网地址（经 FRP）</label>
        <div class="row gap-2">
          <div class="mono-block grow">{{ ports.connectPublic ?? '未启用或未分配' }}</div>
          <button v-if="ports.connectPublic" class="btn btn-sm" @click="copy(ports.connectPublic)">复制</button>
        </div>
        <span class="field-hint">把它发给朋友就能进服；世界停止时这个地址会连不上，但端口保持不变</span>
      </div>
      <div class="kv">
        <div class="kv-row"><span class="kv-key">RCON 端口（不对公网开放）</span><span class="kv-val mono">{{ ports.rcon }}</span></div>
        <div class="kv-row"><span class="kv-key">远端端口段</span><span class="kv-val mono">{{ ports.range[0] }}–{{ ports.range[1] }}</span></div>
      </div>
    </div>
    <template #footer>
      <button class="btn" :disabled="busy" @click="reassign">重新分配端口</button>
      <button class="btn btn-primary" @click="emit('close')">关闭</button>
    </template>
  </Modal>
</template>
