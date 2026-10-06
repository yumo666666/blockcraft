import fs from 'node:fs';
import path from 'node:path';
import { instanceServerDir } from '../core/paths.ts';
import * as I from './instanceService.ts';
import * as sup from './supervisor.ts';
import type { InstanceSummary } from '../types.ts';

interface CacheEntry {
  at: number;
  value: number;
}
const modCountCache = new Map<string, CacheEntry>();
const sizeCache = new Map<string, CacheEntry>();
const TTL = 30_000;

/** MOD 数量：目录扫描带 30 秒缓存（344 个文件的世界不必每次轮询都数一遍） */
export function countMods(id: string): number {
  const hit = modCountCache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let count = 0;
  try {
    const dir = path.join(instanceServerDir(id), 'mods');
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.jar') || f.endsWith('.jar.disabled')) count++;
    }
  } catch {
    count = 0;
  }
  modCountCache.set(id, { at: Date.now(), value: count });
  return count;
}

export function invalidateModCount(id: string): void {
  modCountCache.delete(id);
}

/**
 * 世界占用：缓存 60 秒 + 单飞（同一实例同时只算一次）+ 异步扫描。
 * 请求路径上绝不阻塞事件循环 —— 否则大世界会把面板卡到看门狗以为它挂了。
 */
const sizeInFlight = new Map<string, Promise<number>>();

export async function dirSizeCachedAsync(id: string): Promise<number> {
  const hit = sizeCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const running = sizeInFlight.get(id);
  if (running) return hit?.value ?? 0;
  const job = (async () => {
    try {
      const sizes = await I.instanceSizeAsync(id);
      sizeCache.set(id, { at: Date.now(), value: sizes.total });
      return sizes.total;
    } catch {
      return hit?.value ?? 0;
    } finally {
      sizeInFlight.delete(id);
    }
  })();
  sizeInFlight.set(id, job);
  return hit?.value ?? job;
}

/** 同步版保留给「存储」页的汇总用，但它只读缓存，不主动做重活 */
export function dirSizeCached(id: string): number {
  const hit = sizeCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  if (!sizeInFlight.has(id)) void dirSizeCachedAsync(id);
  return hit?.value ?? 0;
}

export async function summarize(id: string): Promise<InstanceSummary> {
  const cfg = I.getConfig(id);
  const st = await sup.statusOf(id);
  const state = I.getState(id);
  let lastBackup: number | null = null;
  const backups = await import('./backupService.ts')
    .then((m) => m.listBackups(id))
    .catch(() => []);
  if (backups.length) lastBackup = backups[0].created;
  return {
    id,
    name: cfg.name,
    note: cfg.note,
    color: cfg.color,
    mc: cfg.mc,
    loader: cfg.loader,
    loaderVersion: cfg.loaderVersion,
    port: cfg.port,
    frpPort: cfg.frp.remotePort,
    frpEnabled: cfg.frp.enabled,
    memoryMb: cfg.memoryMb,
    minMemoryMb: cfg.minMemoryMb,
    autostart: cfg.autostart,
    status: st.status,
    phase: st.phase,
    progress: st.progress,
    pid: st.pid,
    uptime: st.uptime,
    cpu: st.cpu,
    rss: st.rss,
    players: state.players || st.players,
    maxPlayers: cfg.maxPlayers,
    modCount: countMods(id),
    diskUsage: await dirSizeCachedAsync(id),
    lastBackup,
    intentionalStop: state.intentionalStop,
    createdAt: cfg.createdAt ?? cfg.created,
    javaMajor: cfg.javaMajor,
  };
}

export async function summarizeAll(): Promise<InstanceSummary[]> {
  const ids = I.listInstanceIds();
  return Promise.all(ids.map((id) => summarize(id).catch(() => null))).then((list) => list.filter((x): x is InstanceSummary => Boolean(x)));
}
