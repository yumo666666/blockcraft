<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { WalkingAnimation, SkinViewer } from 'skinview3d';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { api, subscribe } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import { fmtDuration, statusClass } from '../lib/format.ts';
import type { InstanceDetail, InstanceSummary, PlayerInfo, SkinPoolEntry } from '../lib/types.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Modal from '../components/Modal.vue';

defineOptions({ name: 'Players' });

const props = defineProps<{ id: string }>();
const router = useRouter();
const playerNameCollator = new Intl.Collator('zh-CN-u-co-pinyin', { sensitivity: 'base', numeric: true });

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
const skinPool = ref<SkinPoolEntry[]>([]);
const skinPoolPage = ref(0);
const poolPageSize = 8;
const skinPoolPageCount = computed(() => Math.max(1, Math.ceil(skinPool.value.length / poolPageSize)));
const visibleSkinPool = computed(() => skinPool.value.slice(skinPoolPage.value * poolPageSize, (skinPoolPage.value + 1) * poolPageSize));
const skinPoolBusy = ref(false);
const poolInput = ref<HTMLInputElement | null>(null);
const skinUploadTarget = ref<string | null>(null);
const skinUrlModel = ref<'classic' | 'slim'>('classic');

const worldName = computed(() => instance.value?.name ?? props.id);
const knownPlayers = computed(() => [...players.value].sort((a, b) => playerNameCollator.compare(a.name, b.name)));

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
let rosterTimer: number | null = null;
let hasBeenDeactivated = false;

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
    void restoreBrowserSkinAnimations(r.players);
    scheduleSync();
  } catch (err) {
    toastError(err, '读取玩家列表失败');
  } finally {
    loading.value = false;
  }
}

function rosterKey(names: string[], isRunning: boolean): string {
  return `${isRunning ? 'running' : 'stopped'}:${names.map((name) => name.toLocaleLowerCase()).sort().join(',')}`;
}

async function refreshOnlineRoster() {
  const id = props.id;
  try {
    const r = await api.get<{ names: string[]; serverOnline: boolean }>(`/api/instances/${encodeURIComponent(id)}/players/online`);
    if (props.id !== id || disposed) return;
    const changed = rosterKey(onlineNames.value, serverOnline.value) !== rosterKey(r.names, r.serverOnline);
    onlineNames.value = r.names;
    serverOnline.value = r.serverOnline;
    if (changed) await loadPlayers();
  } catch {
    // A temporary RCON disconnect should not interrupt the player page.
  }
}

function startRosterPolling() {
  if (rosterTimer !== null) return;
  rosterTimer = window.setInterval(() => void refreshOnlineRoster(), 5000);
}

function stopRosterPolling() {
  if (rosterTimer === null) return;
  window.clearInterval(rosterTimer);
  rosterTimer = null;
}

async function loadSkinPool() {
  try {
    const r = await api.get<{ skins: SkinPoolEntry[] }>('/api/skin-pool');
    skinPool.value = r.skins;
    if (skinPoolPage.value >= skinPoolPageCount.value) skinPoolPage.value = skinPoolPageCount.value - 1;
    void renderMissingPoolPreviews(r.skins);
  } catch (err) {
    toastError(err, '读取公共皮肤池失败');
  }
}

onMounted(() => {
  loadInstance();
  loadPlayers();
  loadSkinPool();
  offStream = subscribe<{ instances: InstanceSummary[] }>(
    '/api/system/stream',
    (data) => {
      const hit = data.instances?.find((i) => i.id === props.id);
      if (hit) instance.value = hit;
    },
    { onError: () => loadInstance() },
  );
  startRosterPolling();
});

onActivated(() => {
  if (!hasBeenDeactivated) return;
  hasBeenDeactivated = false;
  startRosterPolling();
  void refreshOnlineRoster();
});

onDeactivated(() => {
  hasBeenDeactivated = true;
  stopRosterPolling();
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

function pickSkin(name: string) {
  skinUploadTarget.value = name;
  skinInput.value?.click();
}

function pickPoolUpload() {
  poolInput.value?.click();
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
  const name = skinUploadTarget.value;
  input.value = '';
  if (!file) return;
  if (!name) return;
  await addSkinFiles([file], name);
}

async function onPoolFiles(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (files.length) await addSkinFiles(files, null);
}

async function addSkinFiles(files: File[], playerName: string | null) {
  const selected = playerName ? files.slice(0, 1) : files.slice(0, 30);
  const added: SkinPoolEntry[] = [];
  const failures: string[] = [];
  if (playerName) uploadingSkin.value = playerName;
  else skinPoolBusy.value = true;
  try {
    for (const file of selected) {
      if (file.type !== 'image/png' && !file.name.toLowerCase().endsWith('.png')) {
        failures.push(`${file.name}: 不是 PNG`);
        continue;
      }
      if (file.size > 1024 * 1024) {
        failures.push(`${file.name}: 超过 1MB`);
        continue;
      }
      try {
        const data = await readDataUrl(file);
        const rendered = await renderSkinPreview(data);
        const animationData = await renderSkinAnimation(data);
        const created = await api.post<{ skin: SkinPoolEntry }>('/api/skin-pool', {
          name: file.name.replace(/\.png$/i, ''),
          model: rendered.model,
          data,
          previewData: rendered.previewData,
          animationData,
        });
        added.push(created.skin);
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (added.length) {
      skinPool.value = [...skinPool.value, ...added].sort((a, b) => a.name.localeCompare(b.name));
      if (playerName) {
        const chosen = added[0];
        const selectedIndex = skinPool.value.findIndex((skin) => skin.id === chosen.id);
        if (selectedIndex >= 0) skinPoolPage.value = Math.floor(selectedIndex / poolPageSize);
        try {
          const result = await api.post<{ appliedToServer: boolean; message: string }>(`${base.value}/players/${encodeURIComponent(playerName)}/skin`, { poolId: chosen.id });
          toast(result.appliedToServer ? 'ok' : 'warn', result.appliedToServer ? `${playerName} 已选用「${chosen.name}」` : `已加入皮肤池并保存 ${playerName} 的预览`, result.message);
          skinEditor.value = null;
          await refreshSkin(playerName);
        } catch (err) {
          toast('warn', `已加入皮肤池，但没有应用到 ${playerName}`, err instanceof Error ? err.message : String(err));
          await refreshSkin(playerName);
        }
      } else {
        toast('ok', `已添加 ${added.length} 套皮肤`, added.map((skin) => skin.name).join('、'));
      }
    }
    if (failures.length) toast('warn', `有 ${failures.length} 个文件未添加`, failures.slice(0, 5).join('\n'));
    if (!added.length && !failures.length) toast('warn', '没有可添加的皮肤');
  } finally {
    uploadingSkin.value = null;
    skinPoolBusy.value = false;
  }
}

async function selectPoolSkin(item: SkinPoolEntry) {
  const player = skinEditor.value;
  if (!player) return;
  savingSkin.value = true;
  try {
    const result = await api.post<{ appliedToServer: boolean; message: string }>(`${base.value}/players/${encodeURIComponent(player.name)}/skin`, { poolId: item.id });
    toast(result.appliedToServer ? 'ok' : 'warn', result.appliedToServer ? `${player.name} 已换成「${item.name}」` : `已保存 ${player.name} 的皮肤预览`, result.message);
    skinEditor.value = null;
    await refreshSkin(player.name);
  } catch (err) {
    toastError(err, '应用皮肤失败');
    await refreshSkin(player.name);
  } finally {
    savingSkin.value = false;
  }
}

async function removePoolSkin(item: SkinPoolEntry) {
  if (!window.confirm(`从公共皮肤池删除「${item.name}」？已应用给玩家的皮肤副本会保留。`)) return;
  skinPoolBusy.value = true;
  try {
    await api.del(`/api/skin-pool/${encodeURIComponent(item.id)}`);
    skinPool.value = skinPool.value.filter((skin) => skin.id !== item.id);
    toast('ok', '已从公共皮肤池删除', `「${item.name}」已不可供新的选择。`);
  } catch (err) {
    toastError(err, '删除皮肤失败');
  } finally {
    skinPoolBusy.value = false;
  }
}

/* ------------------------------------------------------ skinview3d 3D 皮肤 */

const SKIN_W = 96;
const SKIN_H = 148;

/** 每个玩家的皮肤 URL 版本号：手动上传后 +1，绕开浏览器缓存 */
const skinEpochs = reactive<Record<string, number>>({});
const skinFailed = ref<Record<string, boolean>>({});
const liveSkinReady = reactive<Record<string, boolean>>({});
const browserSkinAnimations = reactive<Record<string, string>>({});
const canvases = new Map<string, HTMLCanvasElement>();
const viewers = new Map<string, { viewer: SkinViewer; epoch: number; url: string }>();
const refSetters = new Map<string, (el: unknown) => void>();
let previewViewer: SkinViewer | null = null;
const browserAnimationObjectUrls = new Map<string, string>();
const browserAnimationSources = new Map<string, string>();
const PLAYER_SKIN_CACHE = 'blockcraft-player-skin-preview-v1';

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

function animationCacheKey(name: string, source: string): string {
  let hash = 2166136261;
  const input = `${props.id}\0${name.toLowerCase()}\0${source}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return new URL(`/__blockcraft_skin_cache__/${(hash >>> 0).toString(16)}`, window.location.origin).toString();
}

function setBrowserAnimation(name: string, source: string, blob: Blob): void {
  const key = name.toLowerCase();
  const prior = browserAnimationObjectUrls.get(key);
  if (prior) URL.revokeObjectURL(prior);
  const objectUrl = URL.createObjectURL(blob);
  browserAnimationObjectUrls.set(key, objectUrl);
  browserAnimationSources.set(key, source);
  browserSkinAnimations[key] = objectUrl;
}

async function restoreBrowserSkinAnimations(items: PlayerInfo[]): Promise<void> {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(PLAYER_SKIN_CACHE);
    for (const player of items) {
      const source = player.skinAnimationUrl || player.skinPreviewUrl;
      if (!source) continue;
      const key = player.name.toLowerCase();
      if (browserAnimationSources.get(key) === source) continue;
      const prior = browserAnimationObjectUrls.get(key);
      if (prior) URL.revokeObjectURL(prior);
      delete browserSkinAnimations[key];
      browserAnimationObjectUrls.delete(key);
      browserAnimationSources.delete(key);
      const request = animationCacheKey(player.name, source);
      let response = await cache.match(request);
      if (!response) {
        const fetched = await fetch(source, { headers: { 'X-Blockcraft': '1' }, cache: 'force-cache' });
        if (fetched.ok) response = fetched;
        if (response) await cache.put(request, response.clone());
      }
      if (response) setBrowserAnimation(player.name, source, await response.blob());
    }
  } catch {
    // Cache Storage is an optimization; the server image remains the fallback.
  }
}

function openSkinEditor(p: PlayerInfo) {
  skinEditor.value = p;
  skinUrl.value = '';
}

async function refreshSkin(name: string) {
  bumpSkinEpoch(name);
  liveSkinReady[name.toLowerCase()] = false;
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
    const result = await api.put<{ appliedToServer: boolean; message: string }>(`${base.value}/players/${encodeURIComponent(p.name)}/skin`, { kind: 'mojang' });
    toast(result.appliedToServer ? 'ok' : 'warn', result.appliedToServer ? '皮肤已应用到服务端' : '皮肤已绑定到面板', result.message);
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
    const result = await api.put<{ appliedToServer: boolean; message: string }>(`${base.value}/players/${encodeURIComponent(p.name)}/skin`, { kind: 'url', url: skinUrl.value.trim(), variant: skinUrlModel.value });
    toast(result.appliedToServer ? 'ok' : 'warn', result.appliedToServer ? '皮肤已应用到服务端' : '皮肤已绑定到面板', result.message);
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
    const result = await api.del<{ appliedToServer: boolean; message: string }>(`${base.value}/players/${encodeURIComponent(p.name)}/skin`);
    toast(result.appliedToServer ? 'ok' : 'warn', '已清除 BlockCraft 皮肤绑定', result.message);
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

function readBlobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.onerror = () => reject(new Error('读取皮肤图片失败'));
    fr.readAsDataURL(blob);
  });
}

async function renderSkinPreview(skinDataUrl: string): Promise<{ previewData: string; model: 'classic' | 'slim' }> {
  const image = await loadImage(skinDataUrl);
  if (!previewViewer) {
    const canvas = document.createElement('canvas');
    previewViewer = new SkinViewer({
      canvas,
      width: 128,
      height: 192,
      pixelRatio: 1,
      fov: 38,
      zoom: 0.86,
      enableControls: false,
      preserveDrawingBuffer: true,
      renderPaused: true,
    });
  }
  await previewViewer.loadSkin(image, { model: 'auto-detect' });
  const model = previewViewer.playerObject.skin.modelType === 'slim' ? 'slim' : 'classic';
  previewViewer.autoRotate = false;
  previewViewer.playerWrapper.rotation.set(0, 0, 0);
  previewViewer.playerObject.resetJoints();
  previewViewer.playerObject.rotation.set(0, 0, 0);
  previewViewer.resetCameraPose();
  previewViewer.render();
  return { previewData: previewViewer.canvas.toDataURL('image/png'), model };
}

/** Capture a 360° orbit over one complete, repeatable walking gait and cache it as GIF. */
async function renderSkinAnimation(skinDataUrl: string): Promise<string> {
  const image = await loadImage(skinDataUrl);
  const frames = 20;
  if (!previewViewer) {
    previewViewer = new SkinViewer({
      canvas: document.createElement('canvas'), width: 128, height: 192, pixelRatio: 1, fov: 38, zoom: 0.86,
      enableControls: false, preserveDrawingBuffer: true, renderPaused: true,
    });
  }
  const viewer = previewViewer;
  const width = viewer.canvas.width;
  const height = viewer.canvas.height;
  await viewer.loadSkin(image, { model: 'auto-detect' });
  viewer.autoRotate = false;
  viewer.resetCameraPose();
  viewer.playerObject.resetJoints();
  viewer.playerWrapper.rotation.set(0, 0, 0);
  const walk = new WalkingAnimation();
  walk.headBobbing = false;
  const animateWalk = walk as unknown as { animate: (player: typeof viewer.playerObject, delta: number) => void };
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建皮肤动图画布');
  const rgbaFrames: Uint8ClampedArray[] = [];
  for (let index = 0; index < frames; index += 1) {
    // WalkingAnimation's leg and arm cycle is sin(8 * progress); one gait is π/4.
    walk.progress = (index / frames) * (Math.PI / 4);
    animateWalk.animate(viewer.playerObject, 0);
    viewer.playerWrapper.rotation.y = (index / frames) * Math.PI * 2;
    viewer.render();
    const rendered = await loadImage(viewer.canvas.toDataURL('image/png'));
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(rendered, 0, 0, width, height);
    rgbaFrames.push(ctx.getImageData(0, 0, width, height).data);
  }

  const allPixels = new Uint8Array(rgbaFrames.reduce((sum, frame) => sum + frame.length, 0));
  let offset = 0;
  for (const frame of rgbaFrames) {
    allPixels.set(frame, offset);
    offset += frame.length;
  }
  const palette = quantize(allPixels, 256, { format: 'rgba4444', oneBitAlpha: true });
  const transparentIndex = palette.findIndex((color: number[]) => color[3] === 0);
  const gif = GIFEncoder();
  rgbaFrames.forEach((frame, index) => {
    const indexed = applyPalette(frame, palette, 'rgba4444');
    gif.writeFrame(indexed, width, height, {
      palette: index === 0 ? palette : undefined,
      delay: 90,
      repeat: index === 0 ? 0 : undefined,
      transparent: transparentIndex >= 0,
      transparentIndex: transparentIndex >= 0 ? transparentIndex : 0,
    });
  });
  gif.finish();
  const bytes = gif.bytes();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  viewer.playerObject.resetJoints();
  viewer.playerWrapper.rotation.set(0, 0, 0);
  return `data:image/gif;base64,${btoa(binary)}`;
}

async function renderMissingPoolPreviews(items: SkinPoolEntry[]) {
  let changed = false;
  for (const item of items) {
    if (disposed || (item.previewReady && item.animationReady)) continue;
    try {
      const response = await fetch(item.imageUrl, {
        headers: { 'X-Blockcraft': '1' },
        cache: 'force-cache',
      });
      if (!response.ok) throw new Error(`读取皮肤失败（HTTP ${response.status}）`);
      const skinData = await readBlobDataUrl(await response.blob());
      if (!item.previewReady) {
        const rendered = await renderSkinPreview(skinData);
        await api.post(`/api/skin-pool/${encodeURIComponent(item.id)}/preview`, { data: rendered.previewData });
        item.previewReady = true;
      }
      if (!item.animationReady) {
        const animationData = await renderSkinAnimation(skinData);
        await api.post(`/api/skin-pool/${encodeURIComponent(item.id)}/animation`, { data: animationData });
        item.animationReady = true;
        changed = true;
      }
      skinPool.value = skinPool.value.map((skin) => skin.id === item.id ? { ...skin, previewReady: item.previewReady, animationReady: item.animationReady } : skin);
    } catch (err) {
      toastError(err, `生成「${item.name}」的皮肤展示失败`);
    }
  }
  if (changed && !disposed) await loadPlayers();
}

let syncChain: Promise<void> = Promise.resolve();

function scheduleSync() {
  syncChain = syncChain.then(syncViewers).catch(() => undefined);
}

async function syncViewers(): Promise<void> {
  if (disposed) return;
  const renderPlayers = knownPlayers.value.filter((p) => p.skinUrl);
  const wanted = new Set(renderPlayers.map((p) => p.name.toLowerCase()));

  // 下线、或者皮肤版本换了的 viewer 先销毁
  for (const [name, entry] of [...viewers]) {
    const player = renderPlayers.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!wanted.has(name.toLowerCase()) || entry.epoch !== epochOf(name) || entry.url !== (player ? skinPath(player.name) : '')) {
      try {
        entry.viewer.dispose();
      } catch {
        /* ignore */
      }
      viewers.delete(name);
      liveSkinReady[name.toLowerCase()] = false;
    }
  }

  for (const p of renderPlayers) {
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
      const viewer = new SkinViewer({ canvas, width: SKIN_W, height: SKIN_H, skin: img, enableControls: true });
      viewer.animation = new WalkingAnimation();
      viewer.autoRotate = true;
      viewers.set(p.name, { viewer, epoch: epochOf(p.name), url: skinPath(p.name) });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (disposed || viewers.get(p.name)?.viewer !== viewer) continue;
      liveSkinReady[p.name.toLowerCase()] = true;
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
  for (const [name, objectUrl] of browserAnimationObjectUrls) {
    URL.revokeObjectURL(objectUrl);
    delete browserSkinAnimations[name];
  }
  browserAnimationObjectUrls.clear();
  browserAnimationSources.clear();
  previewViewer?.dispose();
  previewViewer = null;
}

onUnmounted(() => {
  disposed = true;
  stopRosterPolling();
  offStream?.();
  disposeViewers();
});

/* ------------------------------------------------------------ 徽标映射 */

function skinBadge(p: PlayerInfo): { label: string; cls: string; title: string } {
  switch (p.skinSource) {
    case 'server':
      return { label: '服务器皮肤', cls: 'badge-ok', title: '读取自本世界 SkinsRestorer 保存的玩家皮肤记录' };
    case 'bound':
      return p.skinAppliedToServer
        ? { label: '✓ 服务端已应用', cls: 'badge-ok', title: 'BlockCraft 已绑定此皮肤，且服务端皮肤集成已接受设置' }
        : { label: '面板预览', cls: 'badge-warn', title: '皮肤已保存在 BlockCraft，仅能在面板预览，尚未应用到游戏服务端' };
    case 'mojang':
      return { label: '✓ 已验证', cls: 'badge-ok', title: '来自在线模式验证过的玩家 UUID 对应的 Mojang 皮肤' };
    default:
      return { label: '未读取', cls: 'badge-outline', title: '服务端没有提供可验证的皮肤来源；无法据此判断玩家客户端实际显示什么皮肤' };
  }
}

function skinLabel(p: PlayerInfo): string {
  if (p.playtimeSeconds !== null && p.playtimeSeconds !== undefined) return fmtDuration(p.playtimeSeconds);
  const labels: Record<PlayerInfo['skinSource'], string> = {
    server: '服务端已记录',
    bound: p.skinAppliedToServer ? '已绑定并应用到服务端' : 'BlockCraft 预览绑定',
    mojang: '正版账号已验证',
    none: '尚无可验证的皮肤来源',
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
    <input ref="poolInput" type="file" accept="image/png" multiple style="display: none" @change="onPoolFiles" />

    <!-- 在线与离线玩家合并显示 -->
    <div class="card">
      <div class="card-head">
        <h2>全部已知玩家</h2>
        <span class="text-3 small">{{ knownPlayers.length }} 名玩家 · {{ onlineNames.length }} 人在线</span>
      </div>
      <div class="card-body">
        <div v-if="!knownPlayers.length" class="empty">
          <div class="empty-icon">🫥</div>
          <div>{{ serverOnline ? '还没有已知玩家' : '服务端未运行，暂无已知玩家记录' }}</div>
        </div>

        <div v-else class="player-grid">
          <div v-for="p in knownPlayers" :key="p.name" class="player-card" :class="{ 'is-offline': !p.online }">
            <i class="dot player-status-dot" :class="p.online ? 'dot-ok' : 'dot-idle'" :title="p.online ? '在线' : '离线'" :aria-label="p.online ? '在线' : '离线'" />
            <div class="player-skin">
              <img
                v-if="browserSkinAnimations[p.name.toLowerCase()] || p.skinAnimationUrl || p.skinPreviewUrl"
                class="skin-fallback"
                :class="{ 'skin-fallback-hidden': liveSkinReady[p.name.toLowerCase()] }"
                :src="browserSkinAnimations[p.name.toLowerCase()] || p.skinAnimationUrl || p.skinPreviewUrl!"
                :alt="`${p.name} 的皮肤预览`"
                loading="lazy"
              />
              <div v-else-if="!p.skinUrl || skinFailed[p.name]" class="skin-blank" :title="`没有可用皮肤：${p.name}`" />
              <canvas
                v-if="p.skinUrl && !skinFailed[p.name]"
                :key="canvasSlot(p.name)"
                :ref="canvasRefFor(p.name)"
                :class="{ 'skin-live-ready': liveSkinReady[p.name.toLowerCase()] }"
              />
            </div>

            <div class="player-name ellipsis" :title="p.name" style="max-width: 100%">{{ p.name }}</div>

            <div class="row gap-1 wrap center">
              <span v-if="p.op" class="badge badge-accent">管理员 ★</span>
              <span v-if="p.banned" class="badge badge-danger">已拉黑</span>
              <span
                class="badge"
                :class="skinBadge(p).cls"
                :title="skinBadge(p).title"
              >
                {{ skinBadge(p).label }}
              </span>
            </div>

            <div class="text-3 small">{{ skinLabel(p) }}</div>

            <div class="player-actions">
              <button
                class="btn btn-sm"
                :disabled="busyName === p.name"
                @click="act(p.name, p.op ? 'deop' : 'op')"
              >
                {{ p.op ? '取消管理员' : '设为管理员' }}
              </button>
              <button
                class="btn btn-sm"
                :disabled="busyName === p.name || !serverOnline || !p.online"
                :title="!serverOnline ? '踢出需要服务端在运行' : !p.online ? '玩家当前离线' : ''"
                @click="askKick(p)"
              >
                踢出服务器
              </button>
              <button
                class="btn btn-sm"
                :class="p.banned ? '' : 'btn-danger'"
                :disabled="busyName === p.name || !serverOnline"
                :title="serverOnline ? '' : '拉黑需要服务端在运行'"
                @click="p.banned ? act(p.name, 'unban') : askBan(p)"
              >
                {{ p.banned ? '解除拉黑' : '拉黑' }}
              </button>
              <button
                class="btn btn-sm"
                :disabled="busyName === p.name"
                @click="act(p.name, p.whitelisted ? 'whitelist-remove' : 'whitelist-add')"
              >
                {{ p.whitelisted ? '移出白名单' : '加白名单' }}
              </button>
              <button class="btn btn-sm btn-soft" :disabled="uploadingSkin === p.name || savingSkin" @click="openSkinEditor(p)">
                更换皮肤
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>公共皮肤池</h2>
        <span class="text-3 small">{{ skinPool.length }} 套 · 所有世界共用</span>
      </div>
      <div class="card-body col gap-3">
        <div class="skin-pool-toolbar">
          <p class="text-3 small skin-pool-note">所有世界共用；移除皮肤不会影响已经绑定的玩家。</p>
          <div class="skin-pool-actions">
            <button class="btn btn-primary" :disabled="skinPoolBusy" @click="pickPoolUpload">添加 PNG</button>
          </div>
        </div>
        <div v-if="!skinPool.length" class="empty skin-pool-empty">
          <div class="empty-icon">👕</div>
          <div>皮肤池还是空的</div>
          <div class="text-3 small">支持一次多选 64×64 或 64×32 PNG；上传后会自动识别手臂类型并生成缓存动图。</div>
        </div>
        <div v-else class="skin-pool-grid">
          <div v-for="item in skinPool" :key="item.id" class="skin-pool-card">
            <img v-if="item.previewReady" :src="item.previewUrl" :alt="`${item.name} 的正面预览`" loading="lazy" />
            <div v-else class="skin-preview-pending" aria-label="正在生成正面预览"><span class="spinner" /></div>
            <div class="skin-pool-meta">
              <strong class="ellipsis" :title="item.name">{{ item.name }}</strong>
              <span class="text-3 small">{{ item.model === 'slim' ? 'Alex · 纤细' : 'Steve · 经典' }}</span>
            </div>
            <button class="btn btn-sm btn-danger" :disabled="skinPoolBusy" @click="removePoolSkin(item)">删除</button>
          </div>
        </div>
      </div>
    </div>

    <p class="text-3 small">
      皮肤优先读取本世界服务端的 Skin Restorer / SkinsRestorer 记录，其次使用在线模式已验证的玩家 UUID。离线 Java 客户端不会把本地皮肤发送给服务端，因此不能直接读取客户端形象。
      踢出需要服务端运行；白名单 / 管理员在停服时写入名单文件，下次启动生效。
    </p>

    <Modal v-if="skinEditor" :title="`更换 ${skinEditor.name} 的皮肤`" size="md" @close="skinEditor = null">
      <div class="col gap-3">
        <div class="skin-help">
          <div class="row gap-2 wrap">
            <span class="badge" :class="skinBadge(skinEditor).cls">{{ skinBadge(skinEditor).label }}</span>
            <strong>{{ skinLabel(skinEditor) }}</strong>
          </div>
          <p class="small mt-2">
            {{ skinEditor.skinSource === 'none'
              ? '服务端没有提供可读的皮肤记录。离线 Java 玩家不会把本地皮肤发送给服务端，因此无法直接读取客户端皮肤。'
              : '当前来源：' + skinLabel(skinEditor) }}
            玩家皮肤绑定属于当前世界；公共皮肤池中的 PNG 可供所有世界重复选择。
          </p>
        </div>
        <div class="skin-picker">
          <div class="row-between wrap gap-2 skin-picker-head">
            <strong>从公共皮肤池选择</strong>
            <span class="text-3 small">{{ skinPool.length }} 套</span>
          </div>
          <div v-if="!skinPool.length" class="text-3 small skin-picker-empty">还没有皮肤，下面上传 PNG 后会自动加入并应用。</div>
          <div v-else class="skin-choice-grid">
            <button
              v-for="item in visibleSkinPool"
              :key="item.id"
              class="skin-choice"
              :disabled="savingSkin"
              @click="selectPoolSkin(item)"
            >
              <img v-if="item.previewReady" :src="item.previewUrl" :alt="`${item.name} 的正面预览`" loading="lazy" />
              <span v-else class="skin-choice-pending"><span class="spinner" /></span>
              <span class="skin-choice-name ellipsis" :title="item.name">{{ item.name }}</span>
              <span class="text-3 small">{{ item.model === 'slim' ? 'Alex' : 'Steve' }}</span>
            </button>
          </div>
          <div v-if="skinPool.length > poolPageSize" class="row-between skin-picker-pages">
            <span class="text-3 small">第 {{ skinPoolPage + 1 }} / {{ skinPoolPageCount }} 页</span>
            <div class="row gap-2">
              <button class="btn btn-sm" :disabled="savingSkin || skinPoolPage === 0" @click="skinPoolPage--">上一页</button>
              <button class="btn btn-sm" :disabled="savingSkin || skinPoolPage + 1 >= skinPoolPageCount" @click="skinPoolPage++">下一页</button>
            </div>
          </div>
        </div>
        <button class="btn" :disabled="savingSkin" @click="bindMojangSkin">绑定同名正版皮肤</button>
        <div class="field">
          <label class="field-label">皮肤图片 URL</label>
          <div class="row gap-2">
            <input v-model="skinUrl" class="input" type="url" placeholder="https://example.com/skin.png" />
            <button class="btn" :disabled="savingSkin || !skinUrl.trim()" @click="bindUrlSkin">绑定</button>
          </div>
          <span class="text-3 small">公开 HTTPS PNG。支持的服务端皮肤组件会保存并发给联机客户端。</span>
        </div>
        <div class="row gap-2 wrap">
          <select v-model="skinUrlModel" class="select" aria-label="皮肤 URL 模型">
            <option value="classic">Steve · 经典手臂</option>
            <option value="slim">Alex · 纤细手臂</option>
          </select>
          <button class="btn btn-soft" :disabled="savingSkin || uploadingSkin === skinEditor.name" @click="pickSkin(skinEditor.name)">
            {{ uploadingSkin === skinEditor.name ? '上传中' : '上传 PNG' }}
          </button>
          <button class="btn" :disabled="savingSkin" @click="restoreSkin">恢复自动来源</button>
        </div>
        <p class="text-3 small">
            上传会先加入所有世界共用的皮肤池，再自动选择给 {{ skinEditor.name }}。Forge、Fabric、NeoForge 会自动安装服务端 Skin Restorer；Paper 安装 SkinsRestorer。PNG 由服务端皮肤组件提交给 MineSkin 签名并保存，玩家重连后仍会显示。标准离线 Java 客户端无需安装模组；部分启动器会强制覆盖皮肤，遇到这种情况时客户端仍可能显示自己的覆盖皮肤。纯 Vanilla 无法加载 MOD 或插件。
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

.skin-pool-toolbar { display: flex; align-items: center; gap: 14px; min-width: 0; }
.skin-pool-note { flex: 1 1 auto; min-width: 0; max-width: none; margin: 0; line-height: 1.45; }
.skin-pool-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.skin-pool-actions .btn { justify-self: end; white-space: nowrap; }
.skin-pool-empty { min-height: 150px; }
.skin-pool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 10px;
}
.skin-pool-card {
  min-width: 0;
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
}
.skin-pool-card > img, .skin-preview-pending {
  width: 54px;
  height: 54px;
  object-fit: contain;
  border-radius: var(--r-xs);
  background: var(--surface);
}
.skin-preview-pending { display: grid; place-items: center; }
.skin-pool-meta { min-width: 0; display: grid; gap: 3px; }
.skin-picker {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  overflow: hidden;
}
.skin-picker-head { padding: 11px 12px; border-bottom: 1px solid var(--border); }
.skin-picker-empty { padding: 14px 12px; }
.skin-choice-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  padding: 10px;
}
.skin-choice {
  min-width: 0;
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 8px 5px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  cursor: pointer;
}
.skin-choice:hover:not(:disabled) { border-color: var(--accent); background: var(--surface-2); }
.skin-choice:disabled { opacity: .55; cursor: wait; }
.skin-choice img, .skin-choice-pending { width: 56px; height: 64px; object-fit: contain; border-radius: var(--r-xs); background: var(--surface-2); }
.skin-choice-pending { display: grid; place-items: center; }
.skin-choice-name { max-width: 100%; font-weight: 600; font-size: 12px; }
.skin-picker-pages { padding: 8px 10px; border-top: 1px solid var(--border); }

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

@media (max-width: 640px) {
  .skin-choice-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .skin-pool-toolbar { align-items: stretch; flex-direction: column; }
  .skin-pool-actions { width: 100%; margin-left: 0; }
  .skin-pool-card { grid-template-columns: 46px minmax(0, 1fr) auto; }
  .skin-pool-card > img, .skin-preview-pending { width: 46px; height: 54px; }
}
</style>
