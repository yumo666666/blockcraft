import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { PLAYERS_CACHE_FILE, SKIN_BINDINGS_FILE, instanceDir, instanceServerDir, DATA_DIR } from '../core/paths.ts';
import { atomicWriteJsonWithBackupSync, atomicWriteFileSync, readJsonSync } from '../core/fsx.ts';
import { createLogger } from '../core/logger.ts';
import { loadConfig } from '../config.ts';
import * as I from './instanceService.ts';
import * as sup from './supervisor.ts';
import { detectSkinSupport, type SkinSupportKind } from './skinSupportService.ts';
import type { PlayerInfo } from '../types.ts';

const logger = createLogger('player');

const SKIN_CACHE_DIR = path.join(DATA_DIR, 'skins');
const SKIN_POOL_DIR = path.join(DATA_DIR, 'skin-pool');
const SKIN_POOL_FILE = path.join(DATA_DIR, 'skin-pool.json');
const SKIN_ASSIGNMENT_DIR = path.join(DATA_DIR, 'skin-assignments');
const TTL = 24 * 3600 * 1000;

interface CacheEntry {
  at: number;
  uuid: string | null;
  skinUrl: string | null;
}

interface SkinBinding {
  uuid: string;
  name: string;
  kind: 'upload' | 'url' | 'mojang' | 'pool';
  url?: string;
  mojangUuid?: string;
  poolId?: string;
  worldId?: string;
  token?: string;
  variant?: 'classic' | 'slim';
  serverApplied?: boolean;
  updatedAt: number;
}

export interface SkinPoolItem {
  id: string;
  name: string;
  model: 'classic' | 'slim';
  bytes: number;
  createdAt: number;
}

type SkinPool = Record<string, SkinPoolItem>;

interface MineSkinUploadResponse {
  error?: string;
  errorCode?: string;
  data?: { texture?: { url?: string; value?: string; signature?: string } };
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

function loadSkinPool(): SkinPool {
  return readJsonSync<SkinPool>(SKIN_POOL_FILE, {});
}

function saveSkinPool(pool: SkinPool): void {
  atomicWriteJsonWithBackupSync(SKIN_POOL_FILE, pool);
}

function validSkinPoolId(id: string): boolean {
  return /^[0-9a-f]{32}$/i.test(id);
}

function worldBindingKey(id: string, uuid: string): string {
  return `${id}:${compactUuid(uuid)}`;
}

function assignmentPath(id: string, uuid: string): string {
  return path.join(SKIN_ASSIGNMENT_DIR, id, `${compactUuid(uuid)}.png`);
}

function assignmentPreviewPath(id: string, uuid: string): string {
  return path.join(SKIN_ASSIGNMENT_DIR, id, `${compactUuid(uuid)}.preview.png`);
}

function writeAssignment(id: string, uuid: string, data: Buffer): string {
  const file = assignmentPath(id, uuid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, data);
  return file;
}

function localAssignmentUrl(id: string, uuid: string, token: string): string {
  const port = loadConfig().panel.port;
  return `http://127.0.0.1:${port}/internal/skin-assignments/${encodeURIComponent(id)}/${compactUuid(uuid)}/${token}.png`;
}

function ensureAssignmentToken(binding: SkinBinding): string {
  binding.token ??= crypto.randomBytes(24).toString('hex');
  return binding.token;
}

export function listSkinPool(): SkinPoolItem[] {
  return Object.values(loadSkinPool()).sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt);
}

function validatePreviewPng(data: Buffer): void {
  if (data.length > 512 * 1024) throw new Error('渲染预览图太大');
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('渲染预览不是有效的 PNG');
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 32 || width > 512 || height < 64 || height > 512) throw new Error('渲染预览尺寸不正确');
}

export function addSkinToPool(name: string, model: 'classic' | 'slim', data: Buffer, preview?: Buffer): SkinPoolItem {
  validateSkinPng(data);
  if (preview) validatePreviewPng(preview);
  const cleanName = path.basename(name.trim()).replace(/\.png$/i, '').trim().slice(0, 64);
  if (!cleanName) throw new Error('请填写皮肤名称');
  if (!['classic', 'slim'].includes(model)) throw new Error('皮肤模型只能是 Steve（经典）或 Alex（纤细）');
  fs.mkdirSync(SKIN_POOL_DIR, { recursive: true });
  const id = crypto.randomBytes(16).toString('hex');
  const item: SkinPoolItem = { id, name: cleanName, model, bytes: data.length, createdAt: Date.now() };
  atomicWriteFileSync(path.join(SKIN_POOL_DIR, `${id}.png`), data);
  if (preview) atomicWriteFileSync(path.join(SKIN_POOL_DIR, `${id}.preview.png`), preview);
  const pool = loadSkinPool();
  pool[id] = item;
  saveSkinPool(pool);
  return item;
}

export function skinPoolImage(id: string): Buffer | null {
  if (!validSkinPoolId(id)) return null;
  try { return fs.readFileSync(path.join(SKIN_POOL_DIR, `${id}.png`)); } catch { return null; }
}

export function skinPoolPreviewReady(id: string): boolean {
  return validSkinPoolId(id) && fs.existsSync(path.join(SKIN_POOL_DIR, `${id}.preview.png`));
}

export function skinPoolPreviewImage(id: string): Buffer | null {
  if (!validSkinPoolId(id)) return null;
  try { return fs.readFileSync(path.join(SKIN_POOL_DIR, `${id}.preview.png`)); } catch { return null; }
}

export function saveSkinPoolPreview(id: string, data: Buffer): boolean {
  if (!validSkinPoolId(id) || !loadSkinPool()[id]) return false;
  validatePreviewPng(data);
  fs.mkdirSync(SKIN_POOL_DIR, { recursive: true });
  atomicWriteFileSync(path.join(SKIN_POOL_DIR, `${id}.preview.png`), data);

  // Keep a copy beside existing player assignments so removing a pool item
  // cannot blank a player's already selected portrait.
  const bindings = loadBindings();
  let changed = false;
  for (const binding of Object.values(bindings)) {
    if (binding.kind !== 'pool' || binding.poolId !== id || !binding.worldId) continue;
    fs.mkdirSync(path.dirname(assignmentPreviewPath(binding.worldId, binding.uuid)), { recursive: true });
    atomicWriteFileSync(assignmentPreviewPath(binding.worldId, binding.uuid), data);
    changed = true;
  }
  if (changed) saveBindings(bindings);
  return true;
}

export function skinPreviewForPlayer(id: string, name: string): Buffer | null {
  const uuid = offlineUuid(name);
  const binding = loadBindings()[worldBindingKey(id, uuid)];
  if (!binding || !['pool', 'upload'].includes(binding.kind)) return null;
  try { return fs.readFileSync(assignmentPreviewPath(id, uuid)); } catch { /* Older assignment; try the pool copy below. */ }
  if (binding.kind === 'pool' && binding.poolId) return skinPoolPreviewImage(binding.poolId);
  return null;
}

export function skinPreviewVersionForPlayer(id: string, name: string): number | null {
  const binding = loadBindings()[worldBindingKey(id, offlineUuid(name))];
  return binding && ['pool', 'upload'].includes(binding.kind) && skinPreviewForPlayer(id, name) ? binding.updatedAt : null;
}

export function removeSkinFromPool(id: string): boolean {
  if (!validSkinPoolId(id)) return false;
  const pool = loadSkinPool();
  if (!pool[id]) return false;
  delete pool[id];
  saveSkinPool(pool);
  try { fs.unlinkSync(path.join(SKIN_POOL_DIR, `${id}.png`)); } catch { /* ignore */ }
  const preview = skinPoolPreviewImage(id);
  if (preview) {
    const bindings = loadBindings();
    let changed = false;
    for (const binding of Object.values(bindings)) {
      if (binding.kind !== 'pool' || binding.poolId !== id || !binding.worldId) continue;
      fs.mkdirSync(path.dirname(assignmentPreviewPath(binding.worldId, binding.uuid)), { recursive: true });
      atomicWriteFileSync(assignmentPreviewPath(binding.worldId, binding.uuid), preview);
      changed = true;
    }
    if (changed) saveBindings(bindings);
  }
  try { fs.unlinkSync(path.join(SKIN_POOL_DIR, `${id}.preview.png`)); } catch { /* ignore */ }
  // A selected copy is kept under the player binding, so removing a library entry
  // will not reset an already assigned skin in a world.
  return true;
}

export function skinAssignmentImage(id: string, uuid: string, token: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !/^[0-9a-f]{32}$/i.test(uuid) || !/^[0-9a-f]{48}$/i.test(token)) return null;
  const bindings = loadBindings();
  const binding = bindings[worldBindingKey(id, uuid)];
  if (!binding?.token || binding.token.length !== token.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(binding.token), Buffer.from(token))) return null;
  try { return fs.readFileSync(assignmentPath(id, uuid)); } catch { return null; }
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

function hasSkinsRestorer(serverDir: string): boolean {
  for (const parentName of ['plugins', 'mods', 'config']) {
    const parent = path.join(serverDir, parentName);
    try {
      if (fs.readdirSync(parent).some((entry) => /skins.?restorer/i.test(entry))) return true;
    } catch {
      /* Optional server integration directory. */
    }
  }
  return false;
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

/** Read Skin Restorer's per-player saved profile data from the world or global storage folder. */
function skinRestorerModSkin(id: string, name: string, uuid: string): string | null {
  const serverDir = instanceServerDir(id);
  const configFile = path.join(serverDir, 'config', 'skinrestorer', 'config.json');
  const config = readJsonFile<{ storage?: { location?: string } }>(configFile, {});
  const global = String(config.storage?.location ?? 'world').toLowerCase() === 'global';
  const levelName = I.getConfig(id).levelName || 'world';
  const worldDirs = global
    ? [path.join(serverDir, 'config', 'skinrestorer', 'saved_skins')]
    : [path.join(serverDir, levelName, 'skinrestorer'), path.join(serverDir, 'world', 'skinrestorer')];
  const uuids = [...new Set([withDashes(uuid), withDashes(offlineUuid(name))])];
  for (const dir of worldDirs) {
    for (const playerId of uuids) {
      const record = readJsonFile<{ value?: { value?: string }; skin?: { value?: string } } | null>(path.join(dir, `${playerId}.json`), null);
      const propertyValue = record?.value?.value ?? record?.skin?.value;
      const url = textureUrl(propertyValue);
      if (url) return url;
    }
  }
  return null;
}

interface SkinResolution {
  uuid: string | null;
  skinUrl: string | null;
  source: PlayerInfo['skinSource'];
  localPath?: string;
  appliedToServer?: boolean;
}

async function resolveMojangSkin(name: string, onlineMode: boolean, identityUuid?: string): Promise<CacheEntry> {
  // Only use a profile UUID supplied by online-mode authentication. Looking up
  // a same-name account is ambiguous, even when the server itself is online-mode.
  if (!onlineMode || !identityUuid || compactUuid(identityUuid) === compactUuid(offlineUuid(name))) {
    return { at: Date.now(), uuid: identityUuid ? withDashes(identityUuid) : offlineUuid(name), skinUrl: null };
  }
  const cache = loadCache();
  const key = name.toLowerCase();
  const hit = cache[key];
  if (hit && Date.now() - hit.at < TTL && (!onlineMode || !identityUuid || compactUuid(hit.uuid ?? '') === compactUuid(identityUuid))) return hit;

  const profile = await mojangProfile(identityUuid, true);
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
  if (actual) return { uuid, skinUrl: actual, source: 'server', appliedToServer: true };
  const modActual = skinRestorerModSkin(id, name, uuid);
  if (modActual) return { uuid, skinUrl: modActual, source: 'server', appliedToServer: true };

  const allBindings = loadBindings();
  const binding = allBindings[worldBindingKey(id, offlineUuid(name))] ?? allBindings[compactUuid(offlineUuid(name))];
  if (binding) {
    if (binding.kind === 'upload' || binding.kind === 'url' || binding.kind === 'pool') {
      const localPath = binding.worldId ? assignmentPath(binding.worldId, binding.uuid) : boundSkinPath(binding.uuid);
      if (fs.existsSync(localPath)) return { uuid, skinUrl: binding.url ?? null, source: 'bound', localPath, appliedToServer: Boolean(binding.serverApplied) };
    } else if (binding.kind === 'mojang' && binding.mojangUuid) {
      const profile = await mojangProfile(binding.mojangUuid, true);
      if (profile) return { uuid, skinUrl: profile.skinUrl, source: 'bound', appliedToServer: Boolean(binding.serverApplied) };
    }
  }

  const profile = await resolveMojangSkin(name, onlineMode, identityUuid);
  return { uuid: profile.uuid, skinUrl: profile.skinUrl, source: profile.skinUrl ? 'mojang' : 'none', appliedToServer: Boolean(profile.skinUrl && onlineMode) };
}

export interface SkinResult {
  name: string;
  uuid: string | null;
  source: PlayerInfo['skinSource'];
  /** 面板内部代理地址，前端直接当图片用 */
  url: string | null;
  manual: boolean;
  appliedToServer: boolean;
}

export async function skinOf(id: string, name: string, onlineMode: boolean, identityUuid?: string): Promise<SkinResult> {
  const result = await resolvePlayerSkin(id, name, onlineMode, identityUuid);
  return {
    name,
    uuid: result.uuid,
    source: result.source,
    url: result.skinUrl || result.localPath ? `/api/instances/${encodeURIComponent(id)}/players/${encodeURIComponent(name)}/skin` : null,
    manual: result.source === 'bound',
    appliedToServer: Boolean(result.appliedToServer),
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

export interface SkinChangeResult {
  appliedToServer: boolean;
  message: string;
}

async function signUploadedSkin(data: Buffer): Promise<string> {
  const body = new FormData();
  body.set('file', new Blob([new Uint8Array(data)], { type: 'image/png' }), 'skin.png');
  body.set('visibility', '1'); // private in MineSkin's API; never add user skins to the public gallery
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const apiKey = loadConfig().skins.mineskinApiKey;
    const response = await fetch('https://api.mineskin.org/generate/upload', {
      method: 'POST',
      headers: {
        'user-agent': 'BlockCraft/2.2',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body,
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null) as MineSkinUploadResponse | null;
    if (!response.ok) {
      const detail = result?.error ?? result?.errorCode ?? `HTTP ${response.status}`;
      throw new Error(`MineSkin 签名服务返回 ${detail}`);
    }
    const texture = result?.data?.texture;
    const url = texture?.url;
    if (!texture?.value || !texture.signature || !url || !/^https:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]{32,64}$/i.test(url)) {
      throw new Error('MineSkin 没有返回有效的已签名 Minecraft 皮肤纹理');
    }
    return url;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('MineSkin 签名请求超时，请稍后重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function commandRejected(output: string): boolean {
  return !output.trim() || /unknown or incomplete command|unknown command|not a valid|permission|denied|could not|failed|error|未知|不完整的命令|没有权限|无权限|失败|无效|无法|未找到/i.test(output);
}

function putWorldBinding(id: string, name: string, kind: SkinBinding['kind'], fields: Partial<SkinBinding> = {}): SkinBinding {
  const uuid = offlineUuid(name);
  const bindings = loadBindings();
  const key = worldBindingKey(id, uuid);
  const prior = bindings[key];
  const binding: SkinBinding = {
    uuid,
    name,
    kind,
    worldId: id,
    token: prior?.token ?? crypto.randomBytes(24).toString('hex'),
    serverApplied: false,
    updatedAt: Date.now(),
    ...fields,
  };
  bindings[key] = binding;
  saveBindings(bindings);
  return binding;
}

function saveWorldBinding(binding: SkinBinding): void {
  if (!binding.worldId) return;
  const bindings = loadBindings();
  bindings[worldBindingKey(binding.worldId, binding.uuid)] = binding;
  saveBindings(bindings);
}

function clearWorldBinding(id: string, name: string): void {
  const uuid = offlineUuid(name);
  const bindings = loadBindings();
  delete bindings[worldBindingKey(id, uuid)];
  // Remove the old global-format entry too, so legacy manual bindings do not mask restore.
  delete bindings[compactUuid(uuid)];
  saveBindings(bindings);
  try { fs.unlinkSync(assignmentPath(id, uuid)); } catch { /* Ignore an absent copy. */ }
  try { fs.unlinkSync(assignmentPreviewPath(id, uuid)); } catch { /* Ignore an absent preview. */ }
}

async function applyModSkin(id: string, name: string, binding: SkinBinding): Promise<SkinChangeResult> {
  if (!sup.isRunning(id)) return { appliedToServer: false, message: '世界没有运行；皮肤选择已保存到 BlockCraft，启动世界后需要重新应用。' };
  const token = ensureAssignmentToken(binding);
  saveWorldBinding(binding);
  const url = localAssignmentUrl(id, binding.uuid, token);
  try {
    // The server mod downloads this localhost URL itself, then sends the PNG bytes
    // to MineSkin for signing. No client installation or public image host is needed.
    await sup.rcon(id, 'skin config reload').catch(() => '');
    const command = binding.kind === 'mojang'
      ? `skin set mojang ${name} ${name}`
      : `skin set web ${binding.variant ?? 'classic'} ${url} ${name}`;
    const output = await sup.rcon(id, command);
    if (commandRejected(output)) return { appliedToServer: false, message: `Skin Restorer 没有接受皮肤设置：${output.slice(0, 240)}` };
    return { appliedToServer: true, message: 'Skin Restorer 已接受设置并将皮肤保存到服务端玩家档案；在线玩家会更新，退出后重连仍会保留。' };
  } catch (err) {
    return { appliedToServer: false, message: `未能连接 Skin Restorer：${err instanceof Error ? err.message : String(err)}` };
  }
}

async function applyPluginSkin(id: string, name: string, skinInput: string, isUrl = false, variant: 'classic' | 'slim' = 'classic'): Promise<SkinChangeResult> {
  if (!sup.isRunning(id)) return { appliedToServer: false, message: '世界没有运行；皮肤选择已保存到 BlockCraft，启动世界后需要重新应用。' };
  try {
    let selectedSkin = skinInput;
    if (isUrl) {
      const customName = `bc_${crypto.createHash('sha256').update(`${id}:${name.toLowerCase()}`).digest('hex').slice(0, 12)}`;
      const createOutput = await sup.rcon(id, `sr createcustom ${customName} ${JSON.stringify(skinInput)} ${variant}`);
      if (commandRejected(createOutput)) return { appliedToServer: false, message: `SkinsRestorer 没有创建自定义皮肤：${createOutput.slice(0, 240)}` };
      selectedSkin = customName;
    }
    const output = await sup.rcon(id, `skin set ${JSON.stringify(selectedSkin)} ${name}`);
    if (commandRejected(output)) return { appliedToServer: false, message: `服务端未能应用皮肤：${output.slice(0, 240)}` };
    return { appliedToServer: true, message: 'SkinsRestorer 已接受设置并保存玩家的皮肤选择；在线玩家会更新，退出后重连仍会保留。' };
  } catch (err) {
    return { appliedToServer: false, message: `未能连接 SkinsRestorer：${err instanceof Error ? err.message : String(err)}` };
  }
}

async function applyBoundSkin(id: string, name: string, binding: SkinBinding, pluginUrl?: string): Promise<SkinChangeResult> {
  if (!sup.isRunning(id)) return { appliedToServer: false, message: '世界没有运行；皮肤已保存在 BlockCraft，启动后可再次选择并应用。' };
  const support: SkinSupportKind = await detectSkinSupport(id);
  let result: SkinChangeResult;
  if (support === 'skin-restorer-mod') result = await applyModSkin(id, name, binding);
  else if (support === 'skins-restorer-plugin') {
    if (binding.kind === 'mojang') result = await applyPluginSkin(id, name, name);
    else {
      let source = pluginUrl ?? binding.url ?? '';
      if (binding.kind === 'pool' || binding.kind === 'upload') {
        const data = fs.readFileSync(assignmentPath(id, binding.uuid));
        source = await signUploadedSkin(data);
      }
      result = source
        ? await applyPluginSkin(id, name, source, true, binding.variant ?? 'classic')
        : { appliedToServer: false, message: '皮肤图片已保存，但没有可用于 SkinsRestorer 的图片来源。' };
    }
  } else {
    result = { appliedToServer: false, message: `皮肤已保存在 BlockCraft 供面板预览。${I.getConfig(id).loader === 'vanilla' ? '纯 Vanilla 不能加载服务端皮肤组件；可换 Paper 或 Fabric、Forge、NeoForge。' : '当前世界没有可用的服务端皮肤组件。'}` };
  }
  binding.serverApplied = result.appliedToServer;
  binding.updatedAt = Date.now();
  saveWorldBinding(binding);
  return result;
}

export async function bindSameNameMojangSkin(id: string, name: string): Promise<SkinChangeResult> {
  const profile = await mojangProfile(name, false);
  if (!profile) throw new Error(`没有找到 ${name} 的正版皮肤`);
  const binding = putWorldBinding(id, name, 'mojang', { mojangUuid: profile.uuid });
  const result = await applyBoundSkin(id, name, binding);
  logger.info(`已把 ${name} 绑定到正版账号 ${profile.uuid}`);
  return result;
}

export async function bindSkinUrl(id: string, name: string, url: string, variant: 'classic' | 'slim' = 'classic'): Promise<SkinChangeResult> {
  const data = await fetchSkinPng(url);
  const uuid = offlineUuid(name);
  writeAssignment(id, uuid, data);
  const binding = putWorldBinding(id, name, 'url', { url, variant });
  return applyBoundSkin(id, name, binding, url);
}

export function saveManualSkin(name: string, data: Buffer): void {
  validateSkinPng(data);
  const uuid = offlineUuid(name);
  fs.mkdirSync(SKIN_CACHE_DIR, { recursive: true });
  atomicWriteFileSync(boundSkinPath(uuid), data);
  const bindings = loadBindings();
  bindings[compactUuid(uuid)] = { uuid, name, kind: 'upload', serverApplied: false, updatedAt: Date.now() };
  saveBindings(bindings);
}

export async function bindUploadedSkin(id: string, name: string, data: Buffer, variant: 'classic' | 'slim' = 'classic'): Promise<SkinChangeResult> {
  validateSkinPng(data);
  writeAssignment(id, offlineUuid(name), data);
  const binding = putWorldBinding(id, name, 'upload', { variant });
  return applyBoundSkin(id, name, binding);
}

export async function selectPoolSkin(id: string, name: string, poolId: string): Promise<SkinChangeResult> {
  if (!validSkinPoolId(poolId)) throw new Error('皮肤池条目不存在');
  const poolItem = loadSkinPool()[poolId];
  const data = skinPoolImage(poolId);
  if (!poolItem || !data) throw new Error('皮肤池条目不存在或图片已损坏');
  writeAssignment(id, offlineUuid(name), data);
  const binding = putWorldBinding(id, name, 'pool', { poolId, variant: poolItem.model });
  return applyBoundSkin(id, name, binding);
}

export async function restorePlayerSkin(id: string, name: string): Promise<SkinChangeResult> {
  const support = await detectSkinSupport(id);
  if (!sup.isRunning(id)) {
    return { appliedToServer: false, message: '世界没有运行，无法通知服务端清除皮肤。重新启动世界后，请再次点“恢复自动来源”。' };
  }
  if (!support) {
    clearWorldBinding(id, name);
    invalidatePlayer(name, id);
    return { appliedToServer: false, message: '已清除 BlockCraft 预览绑定，但此世界没有可用的服务端皮肤组件。' };
  }
  try {
    const command = support === 'skin-restorer-mod' ? `skin reset ${name}` : `skin clear ${name}`;
    const output = await sup.rcon(id, command);
    if (commandRejected(output)) return { appliedToServer: false, message: `服务端没有恢复玩家皮肤：${output.slice(0, 240)}` };
    clearWorldBinding(id, name);
    invalidatePlayer(name, id);
    return { appliedToServer: true, message: '服务端已清除已保存的皮肤选择；玩家重连后会恢复自动来源。' };
  } catch (err) {
    return { appliedToServer: false, message: `未能通知服务端恢复皮肤：${err instanceof Error ? err.message : String(err)}` };
  }
}

export function invalidatePlayer(name: string, id?: string): void {
  const uuid = offlineUuid(name);
  const cache = loadCache();
  delete cache[name.toLowerCase()];
  saveCache(cache);
  if (id) {
    const bindings = loadBindings();
    delete bindings[worldBindingKey(id, uuid)];
    saveBindings(bindings);
    try { fs.unlinkSync(assignmentPath(id, uuid)); } catch { /* Ignore a missing image. */ }
  }
  logger.debug(`已清除 ${name} 的皮肤缓存${id ? `（${id}）` : ''}`);
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
    const skinPreview = skinPreviewVersionForPlayer(id, name);
    players.push({
      name,
      uuid: cached?.uuid ?? skin?.uuid ?? null,
      online: onlineNames.some((n) => n.toLowerCase() === name.toLowerCase()),
      op: ops.some((o) => o.name.toLowerCase() === name.toLowerCase()),
      whitelisted: whitelist.some((w) => w.name.toLowerCase() === name.toLowerCase()),
      banned: banned.some((b) => b.name.toLowerCase() === name.toLowerCase()),
      lastSeen: null,
      skinUrl: skin?.url ?? null,
      skinPreviewUrl: skinPreview ? `/api/instances/${encodeURIComponent(id)}/players/${encodeURIComponent(name)}/skin-preview?v=${skinPreview}` : null,
      skinSource: skin?.source ?? 'none',
      skinAppliedToServer: Boolean(skin?.appliedToServer),
      playtimeSeconds: null,
    });
  }
  players.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN-u-co-pinyin', { sensitivity: 'base', numeric: true }));
  return { online: onlineNames.length > 0, onlineNames, players, serverOnline: running };
}

export async function listOnlinePlayers(id: string): Promise<{ onlineNames: string[]; serverOnline: boolean }> {
  const serverOnline = sup.isRunning(id);
  const onlineNames = serverOnline ? await sup.listPlayers(id).then((r) => r.names).catch(() => []) : [];
  return { onlineNames, serverOnline };
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
