<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import Modal from './Modal.vue';
import type { InstanceDetail } from '../lib/types.ts';

const props = defineProps<{ open: boolean; source: { id: string; name: string } | null }>();
const emit = defineEmits<{ close: []; created: [jobId: string] }>();

const detail = ref<InstanceDetail | null>(null);
const busy = ref(false);
const form = ref({
  name: '',
  levelSeed: '',
  memoryMb: 3072,
  gamemode: 'survival',
  difficulty: 'normal',
  pvp: true,
  allowNether: true,
  generateStructures: true,
  inheritOps: true,
  autostart: false,
  includeWorld: false,
});
/** 源世界的种子是从哪来的（配置 / 存档 / 问服务端），显示给用户看 */
const seedNote = ref('');
const seedValue = ref<string | null>(null);

watch(
  () => props.open,
  async (v) => {
    if (!v || !props.source) return;
    detail.value = null;
    try {
      const d = await api.get<InstanceDetail>(`/api/instances/${props.source.id}`);
      detail.value = d;
      const c = d.config as Record<string, never>;
      form.value = {
        name: `${props.source.name} 副本`,
        levelSeed: '',
        memoryMb: Number(c.memoryMb ?? 3072),
        gamemode: String(c.gamemode ?? 'survival'),
        difficulty: String(c.difficulty ?? 'normal'),
        pvp: Boolean(c.pvp ?? true),
        allowNether: Boolean(c.allowNether ?? true),
        generateStructures: Boolean(c.generateStructures ?? true),
        inheritOps: true,
        autostart: false,
        includeWorld: false,
      };
      // 预填源世界的真实种子：不填的话新世界是随机种子，
      // 那就不是「同一套模组 + 同一片地形」了，用户要的往往正是这个。
      seedNote.value = '读取中…';
      seedValue.value = null;
      api
        .get<{ seed: string | null; source: string | null }>(`/api/instances/${props.source.id}/seed`)
        .then((r) => {
          seedValue.value = r.seed;
          if (r.seed) {
            form.value.levelSeed = r.seed;
            seedNote.value = `已自动填入源世界的种子（来源：${r.source}）。想换一片地形就修改或清空它。`;
          } else {
            seedNote.value = '读不出源世界的种子（这个版本没把它存在存档里），留空则随机生成一片新地形。';
          }
        })
        .catch(() => {
          seedNote.value = '读取源世界种子失败，留空则随机生成。';
        });
    } catch (err) {
      toastError(err, '读取源世界失败');
    }
  },
);

async function submit() {
  if (!props.source) return;
  busy.value = true;
  try {
    const r = await api.post<{ jobId: string }>(`/api/instances/${props.source.id}/copy`, { ...form.value });
    toast('ok', '开始复制', '你可以在任务列表里看进度');
    emit('created', r.jobId);
    emit('close');
  } catch (err) {
    toastError(err, '复制失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal v-if="open" :title="`复制「${source?.name ?? ''}」为新世界`" size="md" @close="emit('close')">
    <div v-if="!detail" class="row gap-2"><span class="spinner" /> 读取源世界…</div>
    <div v-else class="col gap-4">
      <div class="badge badge-accent">MOD 与配置会被完整复制到新世界（真实复制，两个世界互不影响）</div>

      <label class="switch copy-world-switch">
        <input v-model="form.includeWorld" type="checkbox" />
        <span class="switch-track" />
        <span class="col" style="gap: 2px">
          <span class="switch-text" style="font-weight: 600">连存档一起复制</span>
          <span class="text-3 small">
            不开（默认）：只带模组，新世界按下面的种子重新生成 —— 「同一套模组的全新世界」<br />
            打开：把源世界的地图、建筑、玩家数据一起搬过去（此时种子以存档为准，下面填的种子不生效）
          </span>
        </span>
      </label>
      <div class="form-grid-2">
        <div class="field">
          <label class="field-label">新世界名称</label>
          <input v-model="form.name" class="input" />
        </div>
        <div class="field">
          <label class="field-label">世界种子（决定自然地形：生物群系、矿脉、村庄位置）</label>
          <input v-model="form.levelSeed" class="input mono" placeholder="留空 = 随机生成" />
        </div>
        <div class="field">
          <label class="field-label">内存上限（MB）</label>
          <div v-if="!form.includeWorld && seedNote" class="text-3 small">{{ seedNote }}</div>
          <input v-model.number="form.memoryMb" class="input" type="number" />
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
        <label class="switch"><input v-model="form.allowNether" type="checkbox" /><span class="switch-track" /><span class="switch-text">允许下界</span></label>
        <label class="switch"><input v-model="form.generateStructures" type="checkbox" /><span class="switch-track" /><span class="switch-text">生成建筑</span></label>
        <label class="switch"><input v-model="form.inheritOps" type="checkbox" /><span class="switch-track" /><span class="switch-text">继承管理员名单</span></label>
        <label class="switch"><input v-model="form.autostart" type="checkbox" /><span class="switch-track" /><span class="switch-text">随面板自启</span></label>
      </div>
      <p class="text-3 small">
        无论怎么选都不会复制：日志、备份、崩溃报告；端口与 RCON 密码都会重新生成。
        {{
          form.includeWorld
            ? '本次会把存档一起复制过去，建筑与玩家数据都保留。'
            : '本次不复制存档：新世界是全新的，只有模组与配置沿用源世界。'
        }}
      </p>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn btn-primary" :disabled="busy || !form.name" @click="submit">开始复制</button>
    </template>
  </Modal>
</template>
