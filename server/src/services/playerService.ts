import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PLAYERS_CACHE_FILE, instanceServerDir, DATA_DIR } from '../core/paths.ts';
import { atomicWriteJsonWithBackupSync, atomicWriteFileSync, readJsonSync } from '../core/fsx.ts';
import { createLogger } from '../core/logger.ts';
import * as I from './instanceService.ts';
import * as sup from './supervisor.ts';
import type { PlayerInfo } from '../types.ts';

const logger = createLogger('player');

const SKIN_CACHE_DIR = path.join(DATA_DIR, 'skins');
const TTL = 24 * 3600 * 1000;

interface CacheEntry {
  at: number;
  uuid: string | null;
  skinUrl: string | null;
  source: PlayerInfo['skinSource'];
}

type Cache = Record<string, CacheEntry>;

function loadCache(): Cache {
  return readJsonSync<Cache>(PLAYERS_CACHE_FILE, {});
}
function saveCache(cache: Cache): void {
  atomicWriteJsonWithBackupSync(PLAYERS_CACHE_FILE, cache);
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function offlineUuid(name: string): string {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function withDashes(uuid: string): string {
  if (uuid.includes('-')) return uuid;
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'BlockCraft/2.0' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 皮肤解析。诚实标注可信度：
 * - 正版模式 / 名字能查到正版账号 → mojang（权威）
 * - 离线模式查同名账号 → guess（可能是同名别人的，界面必须标「推测」）
 * - 手动上传 → manual
 */
export async function resolveSkin(name: string, onlineMode: boolean): Promise<CacheEntry> {
  const cache = loadCache();
  const key = name.toLowerCase();
  const hit = cache[key];
  if (hit && Date.now() - hit.at < TTL) return hit;

  let uuid: string | null = null;
  let skinUrl: string | null = null;
  let source: PlayerInfo['skinSource'] = 'none';

  const profile = await fetchJson<{ id: string }>(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  if (profile?.id) {
    uuid = withDashes(profile.id);
    const full = await fetchJson<{ properties?: { name: string; value: string }[] }>(
      `https://sessionserver.mojang.com/session/minecraft/profile/${profile.id}`,
    );
    const prop = full?.properties?.find((p) => p.name === 'textures');
    if (prop) {
      try {
        const decoded = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')) as {
          textures?: { SKIN?: { url?: string } };
        };
        skinUrl = decoded.textures?.SKIN?.url ?? null;
        if (skinUrl) source = onlineMode ? 'mojang' : 'guess';
      } catch {
        /* ignore */
      }
    }
  }
  if (!uuid) uuid = offlineUuid(name);
  const entry: CacheEntry = { at: Date.now(), uuid, skinUrl, source };
  cache[key] = entry;
  saveCache(cache);
  return entry;
}

/** 手动上传的皮肤优先 */
export function manualSkinPath(name: string): string {
  return path.join(SKIN_CACHE_DIR, `${name.toLowerCase()}.png`);
}

export function saveManualSkin(name: string, data: Buffer): void {
  fs.mkdirSync(SKIN_CACHE_DIR, { recursive: true });
  atomicWriteFileSync(manualSkinPath(name), data);
  const cache = loadCache();
  cache[name.toLowerCase()] = { at: Date.now(), uuid: offlineUuid(name), skinUrl: manualSkinPath(name), source: 'manual' };
  saveCache(cache);
}

export interface SkinResult {
  name: string;
  uuid: string | null;
  source: PlayerInfo['skinSource'];
  /** 面板内部代理地址，前端直接当图片用 */
  url: string | null;
  manual: boolean;
}

export async function skinOf(name: string, onlineMode: boolean): Promise<SkinResult> {
  const manual = manualSkinPath(name);
  if (fs.existsSync(manual)) return { name, uuid: offlineUuid(name), source: 'manual', url: `/api/players/${encodeURIComponent(name)}/skin`, manual: true };
  const entry = await resolveSkin(name, onlineMode);
  return {
    name,
    uuid: entry.uuid,
    source: entry.source,
    url: entry.skinUrl ? `/api/players/${encodeURIComponent(name)}/skin` : null,
    manual: false,
  };
}

/** 真正取皮肤字节（远端拉取后本地缓存，避免浏览器跨域） */
export async function skinBytes(name: string, onlineMode: boolean): Promise<Buffer | null> {
  const manual = manualSkinPath(name);
  if (fs.existsSync(manual)) return fs.readFileSync(manual);
  const entry = await resolveSkin(name, onlineMode);
  if (!entry.skinUrl || entry.skinUrl.startsWith('/')) return null;
  const cached = path.join(SKIN_CACHE_DIR, `${name.toLowerCase()}.remote.png`);
  if (fs.existsSync(cached) && Date.now() - fs.statSync(cached).mtimeMs < TTL) return fs.readFileSync(cached);
  try {
    const res = await fetch(entry.skinUrl, { headers: { 'user-agent': 'BlockCraft/2.0' } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(SKIN_CACHE_DIR, { recursive: true });
    atomicWriteFileSync(cached, buf);
    return buf;
  } catch {
    return null;
  }
}

export interface PlayerList {
  online: boolean;
  onlineNames: string[];
  players: PlayerInfo[];
  serverOnline: boolean;
}

export async function listPlayers(id: string): Promise<PlayerList> {
  const cfg = I.getConfig(id);
  const serverDir = instanceServerDir(id);
  const ops = readJsonFile<{ name: string; uuid?: string; level?: number }[]>(path.join(serverDir, 'ops.json'), []);
  const whitelist = readJsonFile<{ name: string; uuid?: string }[]>(path.join(serverDir, 'whitelist.json'), []);
  const banned = readJsonFile<{ name: string }[]>(path.join(serverDir, 'banned-players.json'), []);
  const usercache = readJsonFile<{ name: string; uuid: string; expiresOn?: string }[]>(path.join(serverDir, 'usercache.json'), []);

  const running = sup.isRunning(id);
  let onlineNames: string[] = [];
  if (running) {
    onlineNames = await sup.listPlayers(id).then((r) => r.names).catch(() => []);
  }

  const names = new Set<string>([...onlineNames, ...ops.map((o) => o.name), ...whitelist.map((w) => w.name)]);
  const players: PlayerInfo[] = [];
  for (const name of names) {
    const cached = usercache.find((u) => u.name.toLowerCase() === name.toLowerCase());
    const skin = await skinOf(name, cfg.onlineMode).catch(() => null);
    players.push({
      name,
      uuid: cached?.uuid ?? skin?.uuid ?? null,
      online: onlineNames.includes(name),
      op: ops.some((o) => o.name.toLowerCase() === name.toLowerCase()),
      whitelisted: whitelist.some((w) => w.name.toLowerCase() === name.toLowerCase()),
      banned: banned.some((b) => b.name.toLowerCase() === name.toLowerCase()),
      lastSeen: null,
      skinUrl: skin?.url ?? null,
      skinSource: skin?.source ?? 'none',
      playtimeSeconds: null,
    });
  }
  players.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return { online: onlineNames.length > 0, onlineNames, players, serverOnline: running };
}

/** 玩家管理操作：能走 RCON 就走 RCON（立即生效），否则改 json 文件 */
export async function playerAction(id: string, name: string, action: string): Promise<{ ok: boolean; how: 'rcon' | 'file' }> {
  const cfg = I.getConfig(id);
  const serverDir = instanceServerDir(id);
  const running = sup.isRunning(id);
  const rconCmd: Record<string, string> = {
    op: `op ${name}`,
    deop: `deop ${name}`,
    kick: `kick ${name} 你被管理员移出了服务器`,
    ban: `ban ${name}`,
    unban: `pardon ${name}`,
    'whitelist-add': `whitelist add ${name}`,
    'whitelist-remove': `whitelist remove ${name}`,
  };
  if (running && rconCmd[action]) {
    await sup.rcon(id, rconCmd[action]);
    return { ok: true, how: 'rcon' };
  }
  // 停服时改文件（下次启动生效）
  const opsFile = path.join(serverDir, 'ops.json');
  const wlFile = path.join(serverDir, 'whitelist.json');
  const ops = readJsonFile<{ name: string; uuid?: string; level?: number; bypassesPlayerLimit?: boolean }[]>(opsFile, []);
  const wl = readJsonFile<{ name: string; uuid?: string }[]>(wlFile, []);
  const uuid = offlineUuid(name);
  const now = new Date().toISOString();
  switch (action) {
    case 'op':
      if (!ops.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
        ops.push({ name, uuid, level: 4, bypassesPlayerLimit: false });
        atomicWriteJsonWithBackupSync(opsFile, ops);
      }
      break;
    case 'deop': {
      const next = ops.filter((o) => o.name.toLowerCase() !== name.toLowerCase());
      atomicWriteJsonWithBackupSync(opsFile, next);
      break;
    }
    case 'whitelist-add':
      if (!wl.some((w) => w.name.toLowerCase() === name.toLowerCase())) {
        wl.push({ name, uuid });
        atomicWriteJsonWithBackupSync(wlFile, wl);
      }
      break;
    case 'whitelist-remove':
      atomicWriteJsonWithBackupSync(
        wlFile,
        wl.filter((w) => w.name.toLowerCase() !== name.toLowerCase()),
      );
      break;
    case 'kick':
    case 'ban':
      if (!running) throw new Error('踢出/封禁需要服务端在运行');
      break;
    default:
      throw new Error(`不支持的操作：${action}`);
  }
  void cfg;
  void now;
  return { ok: true, how: 'file' };
}

export function invalidatePlayer(name: string): void {
  const cache = loadCache();
  delete cache[name.toLowerCase()];
  saveCache(cache);
  logger.debug(`已清除 ${name} 的皮肤缓存`);
}
