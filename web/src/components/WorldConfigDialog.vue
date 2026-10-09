<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import Modal from './Modal.vue';
import type { InstanceDetail } from '../lib/types.ts';

const props = defineProps<{ open: boolean; instanceId: string | null }>();
const emit = defineEmits<{ close: []; saved: []; job: [jobId: string] }>();

interface Cfg {
  name: string;
  note: string;
  color: string;
  motd: string;
  maxPlayers: number;
  autostart: boolean;
  levelSeed: string;
  gamemode: string;
  difficulty: string;
  pvp: boolean;
  hardcore: boolean;
  allowNether: boolean;
  generateStructures: boolean;
  spawnMonsters: boolean;
  spawnAnimals: boolean;
  spawnNpcs: boolean;
  memoryMb: number;
  minMemoryMb: number;
  jvmExtra: string;
  viewDistance: number;
  simulationDistance: number;
  syncChunkWrites: boolean;
  maxTickTime: number;
  port: number;
  onlineMode: boolean;
  whiteList: boolean;
  enableCommandBlock: boolean;
  gamerules: Record<string, boolean>;
}

const GAMERULE_LABELS: Record<string, string> = {
  keep_inventory: '死亡不掉落',
  mob_griefing: '生物破坏方块',
  advance_time: '时间流动',
  advance_weather: '天气变化',
  spawn_mobs: '刷怪',
  immediate_respawn: '立即重生',
  show_death_messages: '死亡消息',
  natural_health_regeneration: '自然回血',
  show_advancement_messages: '成就播报',
  fall_damage: '摔落伤害',
  spawn_phantoms: '生成幻翼',
  universal_anger: '激怒所有僵尸猪灵',
  tnt_explodes: 'TNT 爆炸',
  block_drops: '方块掉落',
  elytra_movement_check: '鞘翅移动检测',
};

const detail = ref<InstanceDetail | null>(null);
const form = ref<Cfg | null>(null);
const busy = ref(false);
const needsRestart = ref(false);
const missing = ref<string[]>([]);
const launchHow = ref('');
const drift = ref<string[]>([]);
const installed = ref(true);

const RESTART_FIELDS: (keyof Cfg)[] = [
  'port', 'memoryMb', 'minMemoryMb', 'jvmExtra', 'onlineMode', 'whiteList', 'levelSeed',
  'gamemode', 'difficulty', 'pvp', 'hardcore', 'allowNether', 'spawnMonsters', 'spawnAnimals',
  'spawnNpcs', 'generateStructures', 'enableCommandBlock', 'maxPlayers', 'motd', 'viewDistance',
  'syncChunkWrites', 'maxTickTime',
];

function pick(c: Record<string, never>): Cfg {
  return {
    name: String(c.name ?? ''),
    note: String(c.note ?? ''),
    color: String(c.color ?? '#e9e2d0'),
    motd: String(c.motd ?? ''),
    maxPlayers: Number(c.maxPlayers ?? 20),
    autostart: Boolean(c.autostart ?? false),
    levelSeed: String(c.levelSeed ?? ''),
    gamemode: String(c.gamemode ?? 'survival'),
    difficulty: String(c.difficulty ?? 'normal'),
    pvp: Boolean(c.pvp ?? true),
    hardcore: Boolean(c.hardcore ?? false),
    allowNether: Boolean(c.allowNether ?? true),
    generateStructures: Boolean(c.generateStructures ?? true),
    spawnMonsters: Boolean(c.spawnMonsters ?? true),
    spawnAnimals: Boolean(c.spawnAnimals ?? true),
    spawnNpcs: Boolean(c.spawnNpcs ?? true),
    memoryMb: Number(c.memoryMb ?? 3072),
    minMemoryMb: Number(c.minMemoryMb ?? 1024),
    jvmExtra: String(c.jvmExtra ?? ''),
    viewDistance: Number(c.viewDistance ?? 6),
    simulationDistance: Number(c.simulationDistance ?? 4),
    syncChunkWrites: Boolean(c.syncChunkWrites ?? false),
    maxTickTime: Number(c.maxTickTime ?? 60000),
    port: Number(c.port ?? 25565),
    onlineMode: Boolean(c.onlineMode ?? false),
    whiteList: Boolean(c.whiteList ?? false),
    enableCommandBlock: Boolean(c.enableCommandBlock ?? false),
    gamerules: { ...((c.gamerules as unknown as Record<string, boolean>) ?? {}) },
  };
}

watch(
  () => props.open,
  async (v) => {
    if (!v || !props.instanceId) return;
    detail.value = null;
    form.value = null;
    try {
      const d = await api.get<InstanceDetail>(`/api/instances/${props.instanceId}`);
      detail.value = d;
      form.value = pick(d.config as unknown as Record<string, never>);
      installed.value = d.installed;
      missing.value = d.missing;
      launchHow.value = d.launchHow;
      drift.value = d.drift;
    } catch (err) {
      toastError(err, '读取配置失败');
    }
  },
);

async function save(andRestart = false) {
  if (!props.instanceId || !form.value) return;
  busy.value = true;
  const before = detail.value?.config as unknown as Record<string, never> | undefined;
  const changedRestart = before
    ? RESTART_FIELDS.some((k) => JSON.stringify((before as never)[k]) !== JSON.stringify(form.value![k]))
    : false;
  try {
    await api.put(`/api/instances/${props.instanceId}`, form.value);
    toast('ok', '配置已保存', changedRestart ? '部分改动需要重启世界才生效' : '');
    emit('saved');
    if (andRestart) {
      await api.post(`/api/instances/${props.instanceId}/restart`).catch((err) => toastError(err, '重启失败'));
    }
    emit('close');
  } catch (err) {
    toastError(err, '保存失败');
  } finally {
    busy.value = false;
    needsRestart.value = changedRestart;
  }
}

async function reinstall() {
  if (!props.instanceId) return;
  busy.value = true;
  try {
    const result = await api.post<{ jobId: string }>(`/api/instances/${props.instanceId}/reinstall`);
    toast('ok', '已开始重新安装服务端', '可以在总览页的任务里看进度');
    emit('job', result.jobId);
    emit('close');
  } catch (err) {
    toastError(err, '重新安装失败');
  } finally {
    busy.value = false;
  }
}

const COLORS = ['#f6e7cf', '#e3efdd', '#dde9f4', '#f3e2ec', '#fbf1cf', '#e6e5f5', '#f6e3dc', '#dfeeec'];
</script>

<template>
  <Modal v-if="open" :title="`${form?.name ?? ''} · 配置`" size="lg" @close="emit('close')">
    <div v-if="!form" class="row gap-2"><span class="spinner" /> 读取配置…</div>
    <div v-else class="col gap-5">
      <!-- 常用开关放最上面：手机上往下滚才找得到的话，等于没有 -->
      <section class="quick-switches">
        <label class="switch quick-switch">
          <input v-model="form.autostart" type="checkbox" />
          <span class="switch-track" />
          <span class="col" style="gap: 0">
            <span class="switch-text" style="font-weight: 600">随面板自动启动</span>
            <span class="text-3 small">DSH 起来后，看门狗自动把这个世界拉起来</span>
          </span>
        </label>
        <label class="switch quick-switch">
          <input v-model="form.onlineMode" type="checkbox" />
          <span class="switch-track" />
          <span class="col" style="gap: 0">
            <span class="switch-text" style="font-weight: 600">正版验证</span>
            <span class="text-3 small">关闭后玩家名可以随便填</span>
          </span>
        </label>
        <label class="switch quick-switch">
          <input v-model="form.whiteList" type="checkbox" />
          <span class="switch-track" />
          <span class="col" style="gap: 0">
            <span class="switch-text" style="font-weight: 600">白名单</span>
            <span class="text-3 small">只允许名单里的玩家进入</span>
          </span>
        </label>
      </section>

      <div v-if="!installed" class="badge badge-warn">
        服务端文件不完整（缺 {{ missing.join('、') }}），启动会失败。可以点右下角「重新安装」。
      </div>
      <div v-if="drift.length" class="badge badge-warn">检测到配置与磁盘不一致：{{ drift.join('；') }}</div>

      <!-- 基本 -->
      <section class="cfg-section">
        <div class="cfg-title">基本</div>
        <div class="form-grid">
          <div class="field">
            <label class="field-label">名称</label>
            <input v-model="form.name" class="input" />
          </div>
          <div class="field">
            <label class="field-label">便签备注</label>
            <input v-model="form.note" class="input" placeholder="给自己看的说明" />
          </div>
          <div class="field">
            <label class="field-label">MOTD（服务器列表里显示的简介）</label>
            <input v-model="form.motd" class="input" />
          </div>
          <div class="field">
            <label class="field-label">最大玩家数</label>
            <input v-model.number="form.maxPlayers" class="input" type="number" />
          </div>
        </div>
        <div class="row gap-3 mt-3 wrap">
          <div class="row gap-2">
            <span class="text-3 small">便签颜色</span>
            <button
              v-for="c in COLORS"
              :key="c"
              class="color-dot"
              :class="{ active: form.color === c }"
              :style="{ background: c }"
              @click="form.color = c"
            />
          </div>
        </div>
      </section>

      <!-- 世界 -->
      <section class="cfg-section">
        <div class="cfg-title">世界</div>
        <div class="form-grid">
          <div class="field">
            <label class="field-label">种子</label>
            <input v-model="form.levelSeed" class="input mono" placeholder="已有存档后修改不会影响已生成的地形" />
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
        <div class="row gap-4 mt-3 wrap">
          <label class="switch"><input v-model="form.pvp" type="checkbox" /><span class="switch-track" /><span class="switch-text">允许 PVP</span></label>
          <label class="switch"><input v-model="form.hardcore" type="checkbox" /><span class="switch-track" /><span class="switch-text">极限模式</span></label>
          <label class="switch"><input v-model="form.allowNether" type="checkbox" /><span class="switch-track" /><span class="switch-text">允许下界</span></label>
          <label class="switch"><input v-model="form.generateStructures" type="checkbox" /><span class="switch-track" /><span class="switch-text">生成建筑</span></label>
          <label class="switch"><input v-model="form.spawnMonsters" type="checkbox" /><span class="switch-track" /><span class="switch-text">生成怪物</span></label>
          <label class="switch"><input v-model="form.spawnAnimals" type="checkbox" /><span class="switch-track" /><span class="switch-text">生成动物</span></label>
          <label class="switch"><input v-model="form.spawnNpcs" type="checkbox" /><span class="switch-track" /><span class="switch-text">生成村民</span></label>
        </div>
      </section>

      <!-- 性能 -->
      <section class="cfg-section">
        <div class="cfg-title">性能</div>
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
          <div class="field">
            <label class="field-label">存盘强制刷盘（sync-chunk-writes）</label>
            <label class="switch">
              <input v-model="form.syncChunkWrites" type="checkbox" />
              <span class="switch-track" />
              <span class="switch-text">{{ form.syncChunkWrites ? '开启（更安全，但存盘会卡主线程）' : '关闭（推荐，存盘更快）' }}</span>
            </label>
            <div class="text-3 small">
              开启时每次存区块都会强制刷到物理磁盘，手机上会造成明显卡顿；关闭后交给系统缓存，
              正常关服照样完整保存，只有断电或被强杀时可能丢最近几秒。
            </div>
          </div>
          <div class="field">
            <label class="field-label">单 tick 卡死判定（max-tick-time，毫秒）</label>
            <input v-model.number="form.maxTickTime" class="input" type="number" step="10000" min="0" />
            <div class="text-3 small">
              服务端自带看门狗：一次 tick 超过这个时间就判定卡死并强制关服（原版 60000）。
              机器慢、整合包重时建议放宽到 180000 甚至 0（0 = 不自动关，只卡不崩）。
            </div>
          </div>
        </div>
        <div class="field mt-3">
          <label class="field-label">附加 JVM 参数</label>
          <textarea v-model="form.jvmExtra" class="textarea mono" placeholder="每行一个，例如 -XX:+UseG1GC" />
        </div>
      </section>

      <!-- 网络与准入 -->
      <section class="cfg-section">
        <div class="cfg-title">网络与准入</div>
        <div class="form-grid">
          <div class="field">
            <label class="field-label">本地游戏端口</label>
            <input v-model.number="form.port" class="input mono" type="number" />
            <span class="field-hint">改端口请先停服；远端端口在「显示端口」里重新分配</span>
          </div>
        </div>
        <div class="row gap-4 mt-3 wrap">
          <label class="switch"><input v-model="form.enableCommandBlock" type="checkbox" /><span class="switch-track" /><span class="switch-text">允许命令方块</span></label>
          <span class="text-3 small">正版验证 / 白名单在弹窗最上方的常用开关里</span>
        </div>
        <p class="text-3 small mt-2">关掉正版验证后，玩家名可以随便填；在公共网络里建议开白名单。</p>
      </section>

      <!-- 游戏规则 -->
      <section class="cfg-section">
        <div class="cfg-title">游戏规则</div>
        <div class="rule-grid">
          <label v-for="(label, key) in GAMERULE_LABELS" :key="key" class="switch">
            <input v-model="form.gamerules[key]" type="checkbox" />
            <span class="switch-track" />
            <span class="switch-text">{{ label }}<span class="text-3 small mono"> · {{ key }}</span></span>
          </label>
        </div>
      </section>

      <div class="text-3 small">启动方式：{{ launchHow }}</div>
    </div>

    <template #footer>
      <button class="btn btn-danger" :disabled="busy" @click="reinstall">重新安装服务端</button>
      <div class="grow" />
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn" :disabled="busy" @click="save(false)">保存</button>
      <button class="btn btn-primary" :disabled="busy" @click="save(true)">保存并重启</button>
    </template>
  </Modal>
</template>

<style scoped>
/* 顶部常用开关：一眼可见、点得到 */
.quick-switches {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px 18px;
  padding: 14px 16px;
  border: 1px solid var(--accent-border);
  border-radius: var(--r-sm);
  background: var(--accent-soft);
}
.quick-switch { align-items: flex-start; }
.quick-switch .switch-track { margin-top: 2px; }
.cfg-section {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
}
.cfg-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--accent-hover);
  margin-bottom: 12px;
}
.rule-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 10px 16px;
}
.color-dot {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 2px solid transparent;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
}
.color-dot.active { border-color: var(--accent); }
</style>
