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

export function dirSizeCached(id: string): number {
  const hit = sizeCache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = I.instanceSize(id).total;
  sizeCache.set(id, { at: Date.now(), value });
  return value;
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
    diskUsage: dirSizeCached(id),
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
