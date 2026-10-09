<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IdleAnimation, SkinViewer } from 'skinview3d';
import { api, subscribe } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import { fmtDuration, statusClass } from '../lib/format.ts';
import type { InstanceDetail, InstanceSummary, PlayerInfo } from '../lib/types.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Modal from '../components/Modal.vue';

const props = defineProps<{ id: string }>();
const router = useRouter();

const base = computed(() => `/api/instances/${encodeURIComponent(props.id)}`);

const instance = ref<InstanceSummary | null>(null);
const players = ref<PlayerInfo[]>([]);
const onlineNames = ref<string[]>([]);
const serverOnline = ref(false);
const loading = ref(false);
const busyName = ref<string | null>(null);
const uploadingSkin = ref<string | null>(null);
const skinEditor = ref<PlayerInfo | null>(null);
const skinUrl = ref('');
const savingSkin = ref(false);

const worldName = computed(() => instance.value?.name ?? props.id);
const onlinePlayers = computed(() => players.value.filter((p) => p.online));

type PlayerAction = 'op' | 'deop' | 'kick' | 'ban' | 'unban' | 'whitelist-add' | 'whitelist-remove';

const ACTION_TEXT: Record<PlayerAction, string> = {
  op: '已设为管理员',
  deop: '已取消管理员',
  kick: '已踢出',
  ban: '已拉黑',
  unban: '已解除拉黑',
  'whitelist-add': '已加入白名单',
  'whitelist-remove': '已移出白名单',
};

/* ------------------------------------------------------------ 数据加载 */

let offStream: (() => void) | null = null;
let disposed = false;

async function loadInstance() {
  try {
    const r = await api.get<InstanceDetail>(base.value);
    instance.value = r.instance;
  } catch (err) {
    toastError(err, '读取世界信息失败');
  }
}

async function loadPlayers() {
  loading.value = true;
  try {
    const r = await api.get<{ online: boolean; onlineNames: string[]; players: PlayerInfo[]; serverOnline: boolean }>(
      `${base.value}/players`,
    );
    players.value = r.players;
    onlineNames.value = r.onlineNames;
    serverOnline.value = r.serverOnline;
    // 皮肤可能刚好补上了，让之前失败的卡片重试一次
    skinFailed.value = {};
    await nextTick();
    scheduleSync();
  } catch (err) {
    toastError(err, '读取玩家列表失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadInstance();
  loadPlayers();
  offStream = subscribe<{ instances: InstanceSummary[] }>(
    '/api/system/stream',
    (data) => {
      const hit = data.instances?.find((i) => i.id === props.id);
      if (hit) instance.value = hit;
    },
    { onError: () => loadInstance() },
  );
});

/* ------------------------------------------------------------ 玩家操作 */

async function act(name: string, action: PlayerAction): Promise<boolean> {
  busyName.value = name;
  try {
    await api.post(`${base.value}/players/${encodeURIComponent(name)}/${action}`);
    toast('ok', `${name} ${ACTION_TEXT[action]}`);
    await loadPlayers();
    return true;
  } catch (err) {
    toastError(err, '操作失败');
    return false;
  } finally {
    busyName.value = null;
  }
}

const pending = ref<{ name: string; action: 'kick' | 'ban'; title: string; message: string; danger: boolean } | null>(null);

function askKick(p: PlayerInfo) {
  if (!serverOnline.value) {
    toast('warn', '踢出需要服务端在运行', '世界没在跑的时候没有可踢的连接');
    return;
  }
  pending.value = {
    name: p.name,
    action: 'kick',
    title: '踢出玩家',
    message: `确定把「${p.name}」踢出服务器吗？\n他只是断开连接，随时可以重新进来（要拦住他用「拉黑」）。`,
    danger: false,
  };
}

function askBan(p: PlayerInfo) {
  pending.value = {
    name: p.name,
    action: 'ban',
    title: '拉黑玩家',
    message: `确定把「${p.name}」加入黑名单吗？\n他将无法再进入这个世界，直到解除拉黑。`,
    danger: true,
  };
}

async function confirmPending() {
  const t = pending.value;
  if (!t) return;
  const ok = await act(t.name, t.action);
  if (ok) pending.value = null;
}

/* ------------------------------------------------------------ 皮肤上传 */

const skinInput = ref<HTMLInputElement | null>(null);
const uploadTarget = ref<string | null>(null);

function pickSkin(name: string) {
  uploadTarget.value = name;
  skinInput.value?.click();
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.onerror = () => reject(new Error('读取图片失败'));
    fr.readAsDataURL(file);
  });
}

async function onSkinFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  const name = uploadTarget.value;
  input.value = '';
  if (!file || !name) return;
  if (file.type !== 'image/png') {
    toast('warn', '请选择 PNG 皮肤文件', 'Minecraft 皮肤是 64×64 或 64×32 的 PNG');
    return;
  }
  if (file.size > 1024 * 1024) {
    toast('warn', '皮肤文件太大', '最大 1MB');
    return;
  }
  uploadingSkin.value = name;
  try {
    const data = await readDataUrl(file);
    await api.post(`${base.value}/players/${encodeURIComponent(name)}/skin`, { data });
    toast('ok', `已绑定 ${name} 的皮肤`, '皮肤已保存在 BlockCraft 的玩家档案中');
    skinEditor.value = null;
    await refreshSkin(name);
  } catch (err) {
    toastError(err, '皮肤上传失败');
  } finally {
    uploadingSkin.value = null;
  }
}

/* ------------------------------------------------------ skinview3d 3D 皮肤 */

const SKIN_W = 96;
const SKIN_H = 148;

/** 每个玩家的皮肤 URL 版本号：手动上传后 +1，绕开浏览器缓存 */
const skinEpochs = reactive<Record<string, number>>({});
const skinFailed = ref<Record<string, boolean>>({});
const canvases = new Map<string, HTMLCanvasElement>();
const viewers = new Map<string, { viewer: SkinViewer; epoch: number }>();
const refSetters = new Map<string, (el: unknown) => void>();

function epochOf(name: string): number {
  return skinEpochs[name.toLowerCase()] ?? 0;
}

function bumpSkinEpoch(name: string) {
  const k = name.toLowerCase();
  skinEpochs[k] = (skinEpochs[k] ?? 0) + 1;
}

/** 皮肤地址：服务端代理，可能 404（没有皮肤） */
function skinPath(name: string): string {
  return `${base.value}/players/${encodeURIComponent(name)}/skin?v=${epochOf(name)}`;
}

function openSkinEditor(p: PlayerInfo) {
  skinEditor.value = p;
  skinUrl.value = '';
}

async function refreshSkin(name: string) {
  bumpSkinEpoch(name);
  const entry = viewers.get(name);
  if (entry) {
    try {
      entry.viewer.dispose();
    } catch {
      /* Ignore a WebGL cleanup failure. */
    }
    viewers.delete(name);
  }
  const next = { ...skinFailed.value };
  delete next[name];
  skinFailed.value = next;
  await loadPlayers();
  await nextTick();
  scheduleSync();
}

async function bindMojangSkin() {
  const p = skinEditor.value;
  if (!p) return;
  savingSkin.value = true;
  try {
    await api.put(`${base.value}/players/${encodeURIComponent(p.name)}/skin`, { kind: 'mojang' });
    toast('ok', `已绑定 ${p.name} 的同名正版皮肤`, '后续会标记为「已绑定」');
    skinEditor.value = null;
    await refreshSkin(p.name);
  } catch (err) {
    toastError(err, '绑定正版皮肤失败');
  } finally {
    savingSkin.value = false;
  }
}

async function bindUrlSkin() {
  const p = skinEditor.value;
  if (!p || !skinUrl.value.trim()) return;
  savingSkin.value = true;
  try {
    await api.put(`${base.value}/players/${encodeURIComponent(p.name)}/skin`, { kind: 'url', url: skinUrl.value.trim() });
    toast('ok', `已绑定 ${p.name} 的 URL 皮肤`, '图片已经下载并保存在玩家档案中');
    skinEditor.value = null;
    await refreshSkin(p.name);
  } catch (err) {
    toastError(err, '绑定皮肤 URL 失败');
  } finally {
    savingSkin.value = false;
  }
}

async function restoreSkin() {
  const p = skinEditor.value;
  if (!p) return;
  savingSkin.value = true;
  try {
    await api.del(`${base.value}/players/${encodeURIComponent(p.name)}/skin`);
    toast('ok', `已恢复 ${p.name} 的自动皮肤来源`, '会重新按服务器记录、正版资料和默认皮肤查找');
    skinEditor.value = null;
    await refreshSkin(p.name);
  } catch (err) {
    toastError(err, '恢复默认来源失败');
  } finally {
    savingSkin.value = false;
  }
}

function canvasSlot(name: string): string {
  return `${name.toLowerCase()}#${epochOf(name)}`;
}

/**
 * 按 (名字, 皮肤版本) 生成稳定的 ref 函数：
 * 版本不变时 Vue 不会重设 ref，版本变了新的 canvas 才会挂到新的 key 上，
 * 旧 key 的清理也不会误删新 canvas。
 */
function canvasRefFor(name: string): (el: unknown) => void {
  const slot = canvasSlot(name);
  let fn = refSetters.get(slot);
  if (!fn) {
    fn = (el: unknown) => {
      if (el instanceof HTMLCanvasElement) canvases.set(slot, el);
      else canvases.delete(slot);
    };
    refSetters.set(slot, fn);
  }
  return fn;
}

/** 先探一次图片：404 / 断网不进 skinview3d，直接回落占位块，也不会有未捕获的 rejection */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('skin unavailable'));
    img.src = src;
  });
}

let syncChain: Promise<void> = Promise.resolve();

function scheduleSync() {
  syncChain = syncChain.then(syncViewers).catch(() => undefined);
}

async function syncViewers(): Promise<void> {
  if (disposed) return;
  const wanted = new Set(onlinePlayers.value.map((p) => p.name));

  // 下线、或者皮肤版本换了的 viewer 先销毁
  for (const [name, entry] of [...viewers]) {
    if (!wanted.has(name) || entry.epoch !== epochOf(name)) {
      try {
        entry.viewer.dispose();
      } catch {
        /* ignore */
      }
      viewers.delete(name);
    }
  }

  for (const p of onlinePlayers.value) {
    if (disposed || viewers.has(p.name) || skinFailed.value[p.name]) continue;
    const slot = canvasSlot(p.name);
    const canvas = canvases.get(slot);
    if (!canvas) continue;
    const img = await loadImage(skinPath(p.name)).catch(() => null);
    if (disposed) return;
    if (!img) {
      skinFailed.value = { ...skinFailed.value, [p.name]: true };
      continue;
    }
    // await 期间可能已经重新渲染/重建，元素换了就放弃这一次
    if (viewers.has(p.name) || canvases.get(slot) !== canvas) continue;
    try {
      const viewer = new SkinViewer({ canvas, width: SKIN_W, height: SKIN_H, skin: img });
      viewer.animation = new IdleAnimation();
      viewer.autoRotate = true;
      viewers.set(p.name, { viewer, epoch: epochOf(p.name) });
    } catch {
      // WebGL 不可用 / 上下文超限：同样回落占位块，不影响其它卡片
      skinFailed.value = { ...skinFailed.value, [p.name]: true };
    }
  }
}

function disposeViewers() {
  for (const { viewer } of viewers.values()) {
    try {
      viewer.dispose();
    } catch {
      /* ignore */
    }
  }
  viewers.clear();
}

onUnmounted(() => {
  disposed = true;
  offStream?.();
  disposeViewers();
});

/* ------------------------------------------------------------ 徽标映射 */

const SKIN_BADGE: Record<string, { label: string; cls: string; title: string } | undefined> = {
  server: { label: '服务器皮肤', cls: 'badge-ok', title: '读取了这个世界的 SkinsRestorer 玩家皮肤记录，代表服务器当前使用的皮肤' },
  bound: { label: '✓ 已绑定', cls: 'badge-ok', title: '管理员已将这个离线玩家绑定到指定皮肤' },
  mojang: { label: '✓ 已验证', cls: 'badge-ok', title: '在线模式下使用服务端验证过的玩家 UUID 获取皮肤' },
  guess: {
    label: '? 同名推测',
    cls: 'badge-warn',
    title: '当前服务器为离线模式，无法验证玩家的 Mojang 身份；这是同名正版账号的皮肤，可能不是本人',
  },
  none: { label: '默认', cls: 'badge-outline', title: '没有找到服务器皮肤或玩家绑定，客户端会显示 Steve / Alex 默认皮肤' },
};

function skinBadge(source: string): { label: string; cls: string; title: string } | undefined {
  return SKIN_BADGE[source];
}

function skinLabel(p: PlayerInfo): string {
  if (p.playtimeSeconds !== null && p.playtimeSeconds !== undefined) return fmtDuration(p.playtimeSeconds);
  const labels: Record<PlayerInfo['skinSource'], string> = {
    server: 'SkinsRestorer 服务器皮肤',
    bound: 'BlockCraft 玩家绑定',
    mojang: '正版账号已验证',
    guess: '离线模式同名推测',
    none: '默认皮肤 Steve / Alex',
  };
  return labels[p.skinSource];
}
</script>

<template>
  <div class="page col gap-4">
    <!-- 头部：返回 + 世界名 + 在线数 -->
    <div class="row-between wrap gap-3">
      <div class="row gap-3 grow" style="min-width: 0">
        <button class="btn btn-ghost btn-sm" @click="router.push('/')">← 返回总览</button>
        <div class="grow" style="min-width: 0">
          <div class="row gap-2">
            <i class="dot" :class="statusClass(instance?.status ?? 'stopped')" />
            <h1 class="ellipsis">{{ worldName }}</h1>
            <span v-if="!serverOnline" class="badge badge-outline nowrap">服务端未运行</span>
          </div>
          <div class="text-3 small">在线 {{ onlineNames.length }} / 共 {{ players.length }} 名玩家</div>
        </div>
      </div>
      <div class="row gap-2 wrap">
        <button class="btn" :disabled="loading" @click="loadPlayers">
          <span v-if="loading" class="spinner" />
          {{ loading ? '刷新中' : '刷新' }}
        </button>
      </div>
    </div>

    <input ref="skinInput" type="file" accept="image/png" style="display: none" @change="onSkinFile" />

    <!-- 在线玩家 -->
    <div class="card">
      <div class="card-head">
        <h2>
          <i class="dot dot-ok" />
          在线玩家
        </h2>
        <span class="text-3 small">{{ onlinePlayers.length }} 人在线</span>
      </div>
      <div class="card-body">
        <div v-if="!onlinePlayers.length" class="empty">
          <div class="empty-icon">🫥</div>
          <div>{{ serverOnline ? '现在没有玩家在线' : '服务端没在运行，看不到在线玩家' }}</div>
        </div>

        <div v-else class="player-grid">
          <div v-for="p in onlinePlayers" :key="p.name" class="player-card">
            <div class="player-skin">
              <div v-if="skinFailed[p.name]" class="skin-blank" :title="`没有可用皮肤：${p.name}`" />
              <canvas v-else :key="canvasSlot(p.name)" :ref="canvasRefFor(p.name)" />
            </div>

            <div class="player-name ellipsis" :title="p.name" style="max-width: 100%">{{ p.name }}</div>

            <div class="row gap-1 wrap center">
              <span v-if="p.op" class="badge badge-accent">管理员 ★</span>
              <span v-if="p.banned" class="badge badge-danger">已拉黑</span>
              <span
                v-if="skinBadge(p.skinSource)"
                class="badge"
                :class="skinBadge(p.skinSource)?.cls"
                :title="skinBadge(p.skinSource)?.title"
                :style="{ cursor: p.skinSource === 'guess' ? 'pointer' : undefined }"
                @click="p.skinSource === 'guess' && openSkinEditor(p)"
              >
                {{ skinBadge(p.skinSource)?.label }}
              </span>
            </div>

            <div class="text-3 small">{{ skinLabel(p) }}</div>

            <div class="row gap-1 wrap center" style="width: 100%">
              <button
                class="btn btn-sm"
                :disabled="busyName === p.name"
                @click="act(p.name, p.op ? 'deop' : 'op')"
              >
                {{ p.op ? '取消管理员' : '设为管理员' }}
              </button>
              <button
                class="btn btn-sm"
                :disabled="busyName === p.name || !serverOnline"
                :title="serverOnline ? '' : '踢出需要服务端在运行'"
                @click="askKick(p)"
              >
                踢出
              </button>
              <button
                class="btn btn-sm"
                :disabled="busyName === p.name"
                @click="act(p.name, p.whitelisted ? 'whitelist-remove' : 'whitelist-add')"
              >
                {{ p.whitelisted ? '移出白名单' : '加白名单' }}
              </button>
              <button class="btn btn-sm btn-soft" :disabled="uploadingSkin === p.name" @click="openSkinEditor(p)">
                更换皮肤
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 全部已知玩家：含只在白名单 / 管理员里的 -->
    <div class="card">
      <div class="card-head">
        <h2>全部已知玩家</h2>
        <span class="text-3 small">含只在白名单 / 管理员名单里的名字</span>
      </div>
      <div class="card-body" style="padding: 0">
        <div v-if="!players.length" class="empty">
          <div class="empty-icon">📇</div>
          <div>还没有任何玩家记录</div>
        </div>
        <div v-else class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>名字</th>
                <th>白名单</th>
                <th>管理员</th>
                <th>状态</th>
                <th>皮肤来源</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in players" :key="p.name">
                <td>
                  <div class="row gap-2">
                    <i class="dot" :class="p.online ? 'dot-ok' : 'dot-idle'" />
                    <span class="ellipsis">{{ p.name }}</span>
                  </div>
                </td>
                <td>
                  <span class="badge" :class="p.whitelisted ? 'badge-ok' : 'badge-outline'">{{ p.whitelisted ? '是' : '否' }}</span>
                </td>
                <td>
                  <span class="badge" :class="p.op ? 'badge-accent' : 'badge-outline'">{{ p.op ? '是' : '否' }}</span>
                </td>
                <td>
                  <span class="badge" :class="p.banned ? 'badge-danger' : p.online ? 'badge-ok' : 'badge-outline'">
                    {{ p.banned ? '已拉黑' : p.online ? '在线' : '离线' }}
                  </span>
                </td>
                <td>
                  <span
                    class="badge"
                    :class="skinBadge(p.skinSource)?.cls"
                    :title="skinBadge(p.skinSource)?.title"
                    :style="{ cursor: p.skinSource === 'guess' ? 'pointer' : undefined }"
                    @click="p.skinSource === 'guess' && openSkinEditor(p)"
                  >
                    {{ skinBadge(p.skinSource)?.label ?? '默认' }}
                  </span>
                </td>
                <td>
                  <div class="row gap-1 wrap">
                    <button
                      class="btn btn-sm"
                      :disabled="busyName === p.name"
                      @click="act(p.name, p.whitelisted ? 'whitelist-remove' : 'whitelist-add')"
                    >
                      {{ p.whitelisted ? '移出白名单' : '加白名单' }}
                    </button>
                    <button class="btn btn-sm" :disabled="busyName === p.name" @click="act(p.name, p.op ? 'deop' : 'op')">
                      {{ p.op ? '取消管理员' : '设管理员' }}
                    </button>
                    <button
                      class="btn btn-sm"
                      :class="p.banned ? '' : 'btn-danger'"
                      :disabled="busyName === p.name || (!p.banned && !serverOnline)"
                      :title="!p.banned && !serverOnline ? '拉黑需要服务端在运行' : ''"
                      @click="p.banned ? act(p.name, 'unban') : askBan(p)"
                    >
                      {{ p.banned ? '解除拉黑' : '拉黑' }}
                    </button>
                    <button class="btn btn-sm btn-soft" @click="openSkinEditor(p)">更换皮肤</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <p class="text-3 small">
      皮肤按可信度显示：SkinsRestorer 在本世界保存的皮肤 → BlockCraft 管理员绑定 → Mojang 同名推测 → 默认皮肤。
      离线模式无法验证玩家身份；点击「同名推测」可绑定、上传 PNG 或填写皮肤 URL。皮肤绑定保存在 BlockCraft 的玩家档案中。
      踢出需要服务端运行；白名单 / 管理员在停服时写入名单文件，下次启动生效。
    </p>

    <Modal v-if="skinEditor" :title="`更换 ${skinEditor.name} 的皮肤`" size="md" @close="skinEditor = null">
      <div class="col gap-3">
        <div class="skin-help">
          <div class="row gap-2 wrap">
            <span class="badge" :class="skinBadge(skinEditor.skinSource)?.cls">{{ skinBadge(skinEditor.skinSource)?.label ?? '默认' }}</span>
            <strong>{{ skinLabel(skinEditor) }}</strong>
          </div>
          <p v-if="skinEditor.skinSource === 'guess'" class="small mt-2">
            当前服务器为离线模式，无法验证 {{ skinEditor.name }} 的 Mojang 身份。这个皮肤来自同名正版账号，可能并非该玩家实际皮肤。
          </p>
          <p v-else class="small mt-2">
            SkinsRestorer 保存的服务器皮肤优先显示；下面的绑定会保存到 BlockCraft。恢复自动来源不会修改游戏服插件数据。
          </p>
        </div>
        <button class="btn" :disabled="savingSkin" @click="bindMojangSkin">绑定同名正版皮肤</button>
        <div class="field">
          <label class="field-label">皮肤图片 URL</label>
          <div class="row gap-2">
            <input v-model="skinUrl" class="input" type="url" placeholder="https://example.com/skin.png" />
            <button class="btn" :disabled="savingSkin || !skinUrl.trim()" @click="bindUrlSkin">绑定</button>
          </div>
          <span class="text-3 small">公开 HTTPS PNG；保存时会检查图片并复制到本地。</span>
        </div>
        <div class="row gap-2 wrap">
          <button class="btn btn-soft" :disabled="savingSkin || uploadingSkin === skinEditor.name" @click="pickSkin(skinEditor.name)">
            {{ uploadingSkin === skinEditor.name ? '上传中' : '上传 PNG' }}
          </button>
          <button class="btn" :disabled="savingSkin" @click="restoreSkin">恢复自动来源</button>
        </div>
        <p class="text-3 small">
          上传和 URL 皮肤保存在 BlockCraft 的 data/skins 中。SkinsRestorer 若使用 FILE 存储，面板读取它的玩家皮肤记录；数据库存储后端无法由面板直接读取。
        </p>
      </div>
      <template #footer>
        <button class="btn" @click="skinEditor = null">关闭</button>
      </template>
    </Modal>

    <ConfirmDialog
      :open="!!pending"
      :title="pending?.title ?? ''"
      :message="pending?.message ?? ''"
      :danger="pending?.danger"
      :confirm-text="pending?.action === 'kick' ? '踢出' : '拉黑'"
      :busy="busyName === pending?.name"
      @close="pending = null"
      @confirm="confirmPending"
    />
  </div>
</template>

<style scoped>
/* 皮肤加载失败时的纯色占位块（skinview3d 没有东西可画时不报错、不空白） */
.skin-blank {
  width: 52px;
  height: 52px;
  border-radius: var(--r-xs);
  background: #c9d1dc;
  box-shadow: inset 0 -8px 0 rgba(0, 0, 0, 0.06);
}

.skin-help {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  padding: 12px;
}
.skin-help p { margin-bottom: 0; line-height: 1.55; }
.skin-help + .btn { justify-content: center; }

.tbl-wrap {
  overflow-x: auto;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
}
.tbl th {
  text-align: left;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  white-space: nowrap;
  border-bottom: 1px solid var(--border);
}
.tbl td {
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.tbl tbody tr:last-child td {
  border-bottom: 0;
}
</style>
