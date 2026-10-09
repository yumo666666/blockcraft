import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { PLAYERS_CACHE_FILE, SKIN_BINDINGS_FILE, instanceServerDir, DATA_DIR } from '../core/paths.ts';
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
}

interface SkinBinding {
  uuid: string;
  name: string;
  kind: 'upload' | 'url' | 'mojang';
  url?: string;
  mojangUuid?: string;
  updatedAt: number;
}

type Cache = Record<string, CacheEntry>;
type SkinBindings = Record<string, SkinBinding>;

function loadCache(): Cache {
  return readJsonSync<Cache>(PLAYERS_CACHE_FILE, {});
}
function saveCache(cache: Cache): void {
  atomicWriteJsonWithBackupSync(PLAYERS_CACHE_FILE, cache);
}
function loadBindings(): SkinBindings {
  return readJsonSync<SkinBindings>(SKIN_BINDINGS_FILE, {});
}
function saveBindings(bindings: SkinBindings): void {
  atomicWriteJsonWithBackupSync(SKIN_BINDINGS_FILE, bindings);
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

function compactUuid(uuid: string): string {
  return uuid.replaceAll('-', '').toLowerCase();
}

function withDashes(uuid: string): string {
  const hex = compactUuid(uuid);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function textureUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64_000) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as {
      textures?: { SKIN?: { url?: string } };
    };
    const url = decoded.textures?.SKIN?.url;
    return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'BlockCraft/2.1' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function mojangProfile(uuidOrName: string, isUuid: boolean): Promise<{ uuid: string; skinUrl: string } | null> {
  let id = uuidOrName;
  if (!isUuid) {
    const profile = await fetchJson<{ id?: string }>(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(uuidOrName)}`);
    if (!profile?.id) return null;
    id = profile.id;
  }
  const full = await fetchJson<{ id?: string; properties?: { name: string; value: string }[] }>(
    `https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(compactUuid(id))}`,
  );
  const prop = full?.properties?.find((p) => p.name === 'textures');
  const skinUrl = prop ? textureUrl(prop.value) : null;
  return skinUrl ? { uuid: withDashes(full?.id ?? id), skinUrl } : null;
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const lower = address.toLowerCase();
  return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:') || lower.startsWith('::ffff:127.') || lower.startsWith('::ffff:10.') || lower.startsWith('::ffff:192.168.');
}

async function publicHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('皮肤 URL 格式不正确');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw new Error('皮肤 URL 必须使用公开 HTTPS 地址');
  const hostname = url.hostname.toLowerCase();
  if (!hostname.includes('.') || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) throw new Error('皮肤 URL 必须指向公开网站');
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('不能从本机或内网地址读取皮肤');
  } else {
    let addresses: { address: string }[];
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error('无法解析皮肤 URL 的主机名');
    }
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error('皮肤 URL 不能解析到本机或内网地址');
  }
  return url;
}

function validateSkinPng(data: Buffer): void {
  if (data.length > 1024 * 1024) throw new Error('皮肤文件太大（最大 1MB）');
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('文件不是有效的 PNG 图片');
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const validSize = (width === 64 && [32, 64].includes(height)) || (width === 128 && height === 128);
  if (!validSize) throw new Error('皮肤尺寸应为 64×64 或 64×32（也支持 128×128 高清皮肤）');
}

async function fetchSkinPng(rawUrl: string): Promise<Buffer> {
  let url = await publicHttpsUrl(rawUrl);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'manual', headers: { 'user-agent': 'BlockCraft/2.1' } });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location || redirects === 4) throw new Error('皮肤 URL 重定向次数过多');
        url = await publicHttpsUrl(new URL(location, url).href);
        continue;
      }
      if (!res.ok) throw new Error(`下载皮肤失败（HTTP ${res.status}）`);
      const size = Number(res.headers.get('content-length') ?? 0);
      if (size > 1024 * 1024) throw new Error('皮肤文件太大（最大 1MB）');
      const data = Buffer.from(await res.arrayBuffer());
      validateSkinPng(data);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('下载皮肤失败');
}

function boundSkinPath(uuid: string): string {
  return path.join(SKIN_CACHE_DIR, `bound-${compactUuid(uuid)}.png`);
}

function findChildCaseInsensitive(parent: string, name: string): string | null {
  try {
    const item = fs.readdirSync(parent).find((entry) => entry.toLowerCase() === name.toLowerCase());
    return item ? path.join(parent, item) : null;
  } catch {
    return null;
  }
}

function skinsRestorerRoots(serverDir: string): string[] {
  const roots: string[] = [];
  for (const parentName of ['plugins', 'config']) {
    const parent = path.join(serverDir, parentName);
    try {
      for (const entry of fs.readdirSync(parent)) {
        if (!/skinsrestorer/i.test(entry)) continue;
        const full = path.join(parent, entry);
        try {
          if (fs.statSync(full).isDirectory()) roots.push(full);
        } catch {
          /* Ignore a plugin jar with the same name. */
        }
      }
    } catch {
      /* Most modded worlds have no plugins directory. */
    }
  }
  return roots;
}

export function playerUuid(id: string, name: string): string {
  const rows = readJsonFile<{ name: string; uuid?: string }[]>(path.join(instanceServerDir(id), 'usercache.json'), []);
  const entry = rows.find((row) => row.name.toLowerCase() === name.toLowerCase());
  return entry?.uuid ? withDashes(entry.uuid) : offlineUuid(name);
}

function readSkinPropertyFile(file: string): string | null {
  const data = readJsonFile<{ value?: string; url?: string } | null>(file, null);
  return data ? textureUrl(data.value) ?? data.url ?? null : null;
}

/** Read SkinsRestorer's documented FILE storage records for the actual UUID used by this world. */
function skinsRestorerSkin(serverDir: string, name: string, uuid: string): string | null {
  for (const root of skinsRestorerRoots(serverDir)) {
    const playersDir = findChildCaseInsensitive(root, 'players');
    const skinsDir = findChildCaseInsensitive(root, 'skins');
    if (!playersDir || !skinsDir) continue;
    const uuids = [...new Set([withDashes(uuid), withDashes(offlineUuid(name))])];
    let assignment: { identifier?: string; skinType?: string; type?: string; skinVariant?: string } | null = null;
    for (const id of uuids) {
      const file = path.join(playersDir, `${id}.player`);
      assignment = readJsonFile(file, null);
      if (assignment) break;
    }
    if (!assignment) {
      // SkinsRestorer versions before UUID-backed records stored a skin name in Players/<name>.player.
      const oldFile = findChildCaseInsensitive(playersDir, `${name}.player`);
      if (oldFile) {
        const oldName = fs.readFileSync(oldFile, 'utf8').trim();
        if (/^[A-Za-z0-9_.-]{1,64}$/.test(oldName)) {
          const legacy = path.join(skinsDir, `${oldName}.skin`);
          try {
            const [value] = fs.readFileSync(legacy, 'utf8').split(/\r?\n/);
            const url = textureUrl(value.trim());
            if (url) return url;
          } catch {
            /* No saved legacy texture. */
          }
        }
      }
      continue;
    }

    const skin = (assignment as { skinIdentifier?: { identifier?: string; skinType?: string; type?: string; skinVariant?: string } }).skinIdentifier ?? assignment;
    const identifier = skin.identifier;
    const type = String(skin.skinType ?? skin.type ?? '').toUpperCase();
    if (!identifier || identifier.length > 256 || identifier.includes('..') || identifier.includes('/') || identifier.includes('\\')) continue;

    if (type === 'PLAYER' && /^[0-9a-f-]{32,36}$/i.test(identifier)) {
      const file = path.join(skinsDir, `${withDashes(identifier)}.playerskin`);
      const url = readSkinPropertyFile(file);
      if (url) return url;
    } else if (type === 'CUSTOM') {
      const url = readSkinPropertyFile(path.join(skinsDir, `${identifier}.customskin`));
      if (url) return url;
    } else if (type === 'URL') {
      const variant = String(skin.skinVariant ?? 'CLASSIC').toUpperCase();
      const hash = crypto.createHash('sha256').update(identifier).digest('hex');
      const url = readSkinPropertyFile(path.join(skinsDir, `${hash}_${variant}.urlskin`));
      if (url) return url;
      if (/^https:\/\//i.test(identifier)) return identifier;
    }
  }
  return null;
}

interface SkinResolution {
  uuid: string | null;
  skinUrl: string | null;
  source: PlayerInfo['skinSource'];
  localPath?: string;
}

async function resolveMojangSkin(name: string, onlineMode: boolean, identityUuid?: string): Promise<CacheEntry> {
  const cache = loadCache();
  const key = name.toLowerCase();
  const hit = cache[key];
  if (hit && Date.now() - hit.at < TTL && (!onlineMode || !identityUuid || compactUuid(hit.uuid ?? '') === compactUuid(identityUuid))) return hit;

  const profile = onlineMode && identityUuid && compactUuid(identityUuid) !== compactUuid(offlineUuid(name))
    ? await mojangProfile(identityUuid, true)
    : await mojangProfile(name, false);
  const entry: CacheEntry = {
    at: Date.now(),
    uuid: profile?.uuid ?? (identityUuid ? withDashes(identityUuid) : offlineUuid(name)),
    skinUrl: profile?.skinUrl ?? null,
  };
  cache[key] = entry;
  saveCache(cache);
  return entry;
}

async function resolvePlayerSkin(id: string, name: string, onlineMode: boolean, identityUuid?: string): Promise<SkinResolution> {
  identityUuid ??= playerUuid(id, name);
  const uuid = identityUuid ? withDashes(identityUuid) : offlineUuid(name);
  const actual = skinsRestorerSkin(instanceServerDir(id), name, uuid);
  if (actual) return { uuid, skinUrl: actual, source: 'server' };

  const binding = loadBindings()[compactUuid(offlineUuid(name))];
  if (binding) {
    if (binding.kind === 'upload' || binding.kind === 'url') {
      const localPath = boundSkinPath(binding.uuid);
      if (fs.existsSync(localPath)) return { uuid, skinUrl: binding.url ?? null, source: 'bound', localPath };
    } else if (binding.kind === 'mojang' && binding.mojangUuid) {
      const profile = await mojangProfile(binding.mojangUuid, true);
      if (profile) return { uuid, skinUrl: profile.skinUrl, source: 'bound' };
      const cached = await resolveMojangSkin(binding.name, false, binding.mojangUuid);
      if (cached.skinUrl) return { uuid, skinUrl: cached.skinUrl, source: 'bound' };
    }
  }

  const profile = await resolveMojangSkin(name, onlineMode, identityUuid);
  return { uuid: profile.uuid, skinUrl: profile.skinUrl, source: profile.skinUrl ? (onlineMode ? 'mojang' : 'guess') : 'none' };
}

export interface SkinResult {
  name: string;
  uuid: string | null;
  source: PlayerInfo['skinSource'];
  /** 面板内部代理地址，前端直接当图片用 */
  url: string | null;
  manual: boolean;
}

export async function skinOf(id: string, name: string, onlineMode: boolean, identityUuid?: string): Promise<SkinResult> {
  const result = await resolvePlayerSkin(id, name, onlineMode, identityUuid);
  return {
    name,
    uuid: result.uuid,
    source: result.source,
    url: result.skinUrl || result.localPath ? `/api/instances/${encodeURIComponent(id)}/players/${encodeURIComponent(name)}/skin` : null,
    manual: result.source === 'bound',
  };
}

export async function skinBytesForPlayer(id: string, name: string, onlineMode: boolean, identityUuid?: string): Promise<Buffer | null> {
  const result = await resolvePlayerSkin(id, name, onlineMode, identityUuid);
  if (result.localPath && fs.existsSync(result.localPath)) return fs.readFileSync(result.localPath);
  if (!result.skinUrl) return null;
  const remoteUrl = result.skinUrl.replace(/^http:\/\/textures\.minecraft\.net\//i, 'https://textures.minecraft.net/');
  const key = crypto.createHash('sha256').update(remoteUrl).digest('hex');
  const cached = path.join(SKIN_CACHE_DIR, `${key}.remote.png`);
  if (fs.existsSync(cached) && Date.now() - fs.statSync(cached).mtimeMs < TTL) return fs.readFileSync(cached);
  try {
    const data = await fetchSkinPng(remoteUrl);
    fs.mkdirSync(SKIN_CACHE_DIR, { recursive: true });
    atomicWriteFileSync(cached, data);
    return data;
  } catch (err) {
    logger.debug(`读取 ${name} 的皮肤图片失败`, String(err));
    return null;
  }
}

export async function bindSameNameMojangSkin(name: string): Promise<void> {
  const profile = await mojangProfile(name, false);
  if (!profile) throw new Error(`没有找到 ${name} 的正版皮肤`);
  const bindings = loadBindings();
  const uuid = offlineUuid(name);
  bindings[compactUuid(uuid)] = { uuid, name, kind: 'mojang', mojangUuid: profile.uuid, updatedAt: Date.now() };
  saveBindings(bindings);
  logger.info(`已把 ${name} 绑定到正版账号 ${profile.uuid}`);
}

export async function bindSkinUrl(name: string, url: string): Promise<void> {
  const data = await fetchSkinPng(url);
  const uuid = offlineUuid(name);
  fs.mkdirSync(SKIN_CACHE_DIR, { recursive: true });
  atomicWriteFileSync(boundSkinPath(uuid), data);
  const bindings = loadBindings();
  bindings[compactUuid(uuid)] = { uuid, name, kind: 'url', url, updatedAt: Date.now() };
  saveBindings(bindings);
}

export function saveManualSkin(name: string, data: Buffer): void {
  validateSkinPng(data);
  const uuid = offlineUuid(name);
  fs.mkdirSync(SKIN_CACHE_DIR, { recursive: true });
  atomicWriteFileSync(boundSkinPath(uuid), data);
  const bindings = loadBindings();
  bindings[compactUuid(uuid)] = { uuid, name, kind: 'upload', updatedAt: Date.now() };
  saveBindings(bindings);
}

export function invalidatePlayer(name: string): void {
  const key = compactUuid(offlineUuid(name));
  const cache = loadCache();
  delete cache[name.toLowerCase()];
  saveCache(cache);
  const bindings = loadBindings();
  delete bindings[key];
  saveBindings(bindings);
  for (const candidate of [boundSkinPath(offlineUuid(name)), path.join(SKIN_CACHE_DIR, `${name.toLowerCase()}.png`)]) {
    try {
      fs.unlinkSync(candidate);
    } catch {
      /* Ignore a missing image. */
    }
  }
  logger.debug(`已清除 ${name} 的皮肤绑定与缓存`);
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
  if (running) onlineNames = await sup.listPlayers(id).then((r) => r.names).catch(() => []);

  const names = new Map<string, string>();
  for (const name of [...onlineNames, ...usercache.map((u) => u.name), ...ops.map((o) => o.name), ...whitelist.map((w) => w.name), ...banned.map((b) => b.name)]) {
    if (name) names.set(name.toLowerCase(), name);
  }
  const players: PlayerInfo[] = [];
  for (const name of names.values()) {
    const cached = usercache.find((u) => u.name.toLowerCase() === name.toLowerCase());
    const skin = await skinOf(id, name, cfg.onlineMode, cached?.uuid).catch(() => null);
    players.push({
      name,
      uuid: cached?.uuid ?? skin?.uuid ?? null,
      online: onlineNames.some((n) => n.toLowerCase() === name.toLowerCase()),
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
    case 'deop':
      atomicWriteJsonWithBackupSync(opsFile, ops.filter((o) => o.name.toLowerCase() !== name.toLowerCase()));
      break;
    case 'whitelist-add':
      if (!wl.some((w) => w.name.toLowerCase() === name.toLowerCase())) {
        wl.push({ name, uuid });
        atomicWriteJsonWithBackupSync(wlFile, wl);
      }
      break;
    case 'whitelist-remove':
      atomicWriteJsonWithBackupSync(wlFile, wl.filter((w) => w.name.toLowerCase() !== name.toLowerCase()));
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
