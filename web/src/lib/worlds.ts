import { ref } from 'vue';
import { api, subscribe } from './api.ts';
import type { InstanceSummary, SystemSnapshot } from './types.ts';

/**
 * 全世界共用的系统快照 + 世界列表。
 *
 * 侧边栏和总览页都需要同一份数据：如果各自开一条 SSE，会重复请求、还会出现
 * 侧边栏与页面状态不一致。这里用引用计数管理唯一的订阅：
 *   - App 在登录后 acquire，退出登录后 release；
 *   - Overview 在挂载时 acquire，卸载时 release；
 * 最后一个使用者离开时才关闭 EventSource。
 */
interface SystemStreamPayload {
  sampledAt: number;
  snap: SystemSnapshot;
  instances: InstanceSummary[];
}

export const snapshot = ref<SystemSnapshot | null>(null);
export const instances = ref<InstanceSummary[]>([]);
export const worldsReady = ref(false);

let consumers = 0;
let stopStream: (() => void) | null = null;
let revision = 0;
let refreshRequest = 0;
const pendingStatuses = new Map<string, { status: string; phase: string; at: number }>();

/** 合并服务端快照与刚点下的启停状态，避免按钮反馈被稍旧的快照覆盖。 */
function applyInstances(next: InstanceSummary[], sampledAt = Date.now()): void {
  revision += 1;
  instances.value = next.map((item) => {
    const pending = pendingStatuses.get(item.id);
    if (!pending) return item;
    if (sampledAt <= pending.at) return { ...item, status: pending.status, phase: pending.phase };
    pendingStatuses.delete(item.id);
    return item;
  });
}

function applyStream(data: SystemStreamPayload): void {
  snapshot.value = data.snap;
  applyInstances(data.instances, data.sampledAt);
  worldsReady.value = true;
}

async function fetchSystemFallback(): Promise<void> {
  try {
    // 注意：SSE 的载荷是 { snap, instances }，而 GET /api/system 把快照字段
    // 直接摊平在顶层（{ sampledAt, ...snap, instances }）。两种形状都要兼容。
    const data = await api.get<SystemSnapshot & { sampledAt: number; instances: InstanceSummary[] }>('/api/system');
    snapshot.value = data;
    applyInstances(data.instances, data.sampledAt);
    worldsReady.value = true;
  } catch {
    // Keep the last known state; the SSE stream reconnects on its own.
  }
}

function startStream(): void {
  if (stopStream) return;
  stopStream = subscribe<SystemStreamPayload>('/api/system/stream', applyStream, {
    onError: () => {
      void fetchSystemFallback();
    },
  });
}

function stopStreamIfIdle(): void {
  if (consumers > 0 || !stopStream) return;
  stopStream();
  stopStream = null;
}

export function acquireWorlds(): void {
  consumers += 1;
  if (consumers === 1) startStream();
}

export function releaseWorlds(): void {
  consumers = Math.max(0, consumers - 1);
  stopStreamIfIdle();
}

/** 退出登录时清空，避免下一次登录先看到上一个会话的世界。 */
export function resetWorlds(): void {
  revision += 1;
  refreshRequest += 1;
  pendingStatuses.clear();
  instances.value = [];
  snapshot.value = null;
  worldsReady.value = false;
}

/** 启停按钮的即时反馈：先本地生效，下一条服务端快照到达后再以服务端为准。 */
export function setWorldStatus(id: string, status: string, phase: string): void {
  pendingStatuses.set(id, { status, phase, at: Date.now() });
  revision += 1;
  instances.value = instances.value.map((item) => (item.id === id ? { ...item, status, phase } : item));
}

/**
 * 主动拉取世界列表（导入、删除、配置保存后调用）。
 * 如果请求期间 SSE 已经更新过数据，丢弃这份可能更旧的 GET 结果。
 */
export async function refreshWorlds(): Promise<void> {
  const requestId = ++refreshRequest;
  const revisionAtRequest = revision;
  try {
    const result = await api.get<{ instances: InstanceSummary[] }>('/api/instances');
    if (requestId !== refreshRequest || revisionAtRequest !== revision) return;
    applyInstances(result.instances);
    worldsReady.value = true;
  } catch {
    // Callers surface action-specific errors; a background refresh stays quiet.
  }
}

export function useWorlds() {
  return {
    snapshot,
    instances,
    worldsReady,
    acquireWorlds,
    releaseWorlds,
    resetWorlds,
    refreshWorlds,
    setWorldStatus,
  };
}
