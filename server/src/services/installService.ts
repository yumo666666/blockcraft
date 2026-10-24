import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { execFile, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { STORE_DIR, instanceDir, instanceServerDir } from '../core/paths.ts';
import { atomicWriteFileSync, readJsonSync } from '../core/fsx.ts';
import { bad, conflict, notFound } from '../core/errors.ts';
import { createLogger } from '../core/logger.ts';
import { loadConfig } from '../config.ts';
import { ensureJava } from './javaService.ts';
import * as I from './instanceService.ts';
import { hasLoaderEntry, loaderArgsPath } from '../launcher/index.ts';
import type { InstanceConfig, Loader } from '../types.ts';

const logger = createLogger('install');
const MANIFEST_TTL = 6 * 3600 * 1000;
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const BMCLAPI_BASE = 'https://bmclapi2.bangbang93.com';

type MinecraftSource = 'official' | 'bmclapi';

function minecraftSource(): MinecraftSource {
  return loadConfig().mirrors.minecraftSource === 'bmclapi' ? 'bmclapi' : 'official';
}

/** 版本清单地址；BMCLAPI 镜像国内访问更稳定。 */
export function minecraftManifestUrl(source: MinecraftSource = minecraftSource()): string {
  return source === 'bmclapi' ? `${BMCLAPI_BASE}/mc/game/version_manifest_v2.json` : MOJANG_MANIFEST;
}

/**
 * 原版服务端候选地址：BMCLAPI 优先，失败后回退到 JSON 里的官方地址。
 * 服务端 jar 的 SHA-1 在两种源下相同，因此缓存仍然通用。
 */
export function minecraftServerUrls(source: MinecraftSource, mc: string, officialUrl: string): string[] {
  if (source === 'bmclapi') {
    const mirror = `${BMCLAPI_BASE}/version/${encodeURIComponent(mc)}/server`;
    return officialUrl && officialUrl !== mirror ? [mirror, officialUrl] : [mirror];
  }
  return officialUrl ? [officialUrl] : [];
}

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const signal = init.signal ? AbortSignal.any([ctrl.signal, init.signal]) : ctrl.signal;
    const res = await fetch(url, { ...init, signal, headers: { 'user-agent': 'BlockCraft/2.0', ...(init.headers ?? {}) } });
    if (!res.ok) throw bad(`请求失败 ${res.status}：${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 带大小校验的流式下载（防半包）；本地缓存命中时不重复下载 */
async function sha1File(file: string): Promise<string> {
  const hash = createHash('sha1');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function downloadTo(
  url: string,
  dest: string,
  onLog?: (s: string) => void,
  opts: { retries?: number; timeoutMs?: number; sha1?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    opts.signal?.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`下载超过 ${Math.round(timeoutMs / 1000)} 秒`)), timeoutMs);
    const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
    try {
      onLog?.(`下载 ${path.basename(dest)}（第 ${attempt}/${retries} 次）← ${url}`);
      const res = await fetch(url, { redirect: 'follow', signal, headers: { 'user-agent': 'BlockCraft/2.0' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const expect = Number(res.headers.get('content-length') ?? 0);
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp), { signal });
      const size = fs.statSync(tmp).size;
      if (size === 0) throw new Error('下载到 0 字节');
      if (expect && size !== expect) throw new Error(`下载不完整：${size}/${expect}`);
      if (opts.sha1) {
        const actual = await sha1File(tmp);
        if (actual.toLowerCase() !== opts.sha1.toLowerCase()) throw new Error(`SHA-1 校验失败：实际 ${actual}，预期 ${opts.sha1}`);
      }
      fs.renameSync(tmp, dest);
      onLog?.(`完成 ${path.basename(dest)}（${(size / 1024 / 1024).toFixed(1)} MB）`);
      return;
    } catch (err) {
      if (opts.signal?.aborted) {
        fs.rmSync(tmp, { force: true });
        throw opts.signal.reason ?? err;
      }
      const failure = controller.signal.aborted ? new Error(`下载超时（${Math.round(timeoutMs / 1000)} 秒）`) : err;
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      if (attempt === retries) throw failure;
      onLog?.(`下载失败，将重试：${String(failure).slice(0, 160)}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ------------------------------------------------------------------ 版本清单

interface VersionManifest {
  latest: { release: string };
  versions: { id: string; type: string; url: string }[];
}

export async function versionManifest(force = false, signal?: AbortSignal): Promise<VersionManifest> {
  const source = minecraftSource();
  const file = path.join(STORE_DIR, 'versions', `manifest-${source}.json`);
  const cached = readJsonSync<(VersionManifest & { fetchedAt?: number }) | null>(file, null);
  if (!force && cached && cached.fetchedAt && Date.now() - cached.fetchedAt < MANIFEST_TTL) return cached;
  const urls = source === 'bmclapi' ? [minecraftManifestUrl('bmclapi'), MOJANG_MANIFEST] : [MOJANG_MANIFEST];
  let data: VersionManifest | null = null;
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      data = await fetchJson<VersionManifest>(url, { signal });
      break;
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      lastError = err;
      logger.warn('版本清单下载失败，尝试下一个源', { url, error: String(err) });
    }
  }
  if (!data) throw lastError instanceof Error ? lastError : new Error('无法获取 Minecraft 版本清单');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify({ ...data, fetchedAt: Date.now() }, null, 2));
  return data;
}

export async function listVersions(): Promise<{ id: string; type: string }[]> {
  const m = await versionManifest();
  return m.versions.map((v) => ({ id: v.id, type: v.type }));
}

interface VanillaServerSource {
  urls: string[];
  sha1?: string;
  javaMajor: number;
}

async function vanillaServerUrl(mc: string, signal?: AbortSignal): Promise<VanillaServerSource> {
  const source = minecraftSource();
  const m = await versionManifest(false, signal);
  const v = m.versions.find((x) => x.id === mc);
  if (!v) throw bad(`找不到 Minecraft 版本 ${mc}`);

  const detailUrl = source === 'bmclapi' ? `${BMCLAPI_BASE}/version/${encodeURIComponent(mc)}/json` : v.url;
  let detail: { downloads: { server?: { url: string; sha1?: string } }; javaVersion?: { majorVersion: number } };
  try {
    detail = await fetchJson(detailUrl, { signal });
  } catch (err) {
    if (source !== 'bmclapi') throw err;
    if (signal?.aborted) throw signal.reason ?? err;
    logger.warn('BMCLAPI 版本详情获取失败，回退 Mojang 版本详情', { mc, error: String(err) });
    detail = await fetchJson(v.url, { signal });
  }
  if (!detail.downloads.server) throw bad(`Minecraft ${mc} 没有服务端下载`);
  return {
    urls: minecraftServerUrls(source, mc, detail.downloads.server.url),
    sha1: detail.downloads.server.sha1,
    javaMajor: detail.javaVersion?.majorVersion ?? 17,
  };
}

async function ensureVanillaServerJar(mc: string, onLog: (s: string) => void, signal?: AbortSignal): Promise<string> {
  const { urls, sha1 } = await vanillaServerUrl(mc, signal);
  const cache = path.join(STORE_DIR, 'vanilla', mc, 'minecraft_server.jar');
  if (fs.existsSync(cache)) {
    let cacheValid = !sha1;
    if (sha1) {
      try {
        cacheValid = (await sha1File(cache)).toLowerCase() === sha1.toLowerCase();
      } catch {
        cacheValid = false;
      }
    }
    if (cacheValid) {
      onLog(`复用已校验的 Minecraft ${mc} 服务端（SHA-1 ${sha1 ? '匹配' : '不可用'}）`);
      return cache;
    }
    onLog(`缓存的 Minecraft ${mc} 服务端校验失败，删除后重新下载`);
    fs.rmSync(cache, { force: true });
  }
  let lastError: unknown = null;
  for (const [index, url] of urls.entries()) {
    signal?.throwIfAborted();
    try {
      await downloadTo(url, cache, onLog, { retries: index === 0 ? 4 : 2, timeoutMs: 180_000, sha1, signal });
      lastError = null;
      break;
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      lastError = err;
      onLog(`该下载源失败，换下一个：${url}`);
    }
  }
  if (lastError) throw lastError;
  return cache;
}

function readZipEntry(file: string, targetName: string): Buffer | null {
  try {
    const zip = fs.readFileSync(file);
    const endMin = Math.max(0, zip.length - 65_557);
    let end = -1;
    for (let i = zip.length - 22; i >= endMin; i -= 1) {
      if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) return null;
    const entries = zip.readUInt16LE(end + 10);
    let cursor = zip.readUInt32LE(end + 16);
    for (let i = 0; i < entries; i += 1) {
      if (zip.readUInt32LE(cursor) !== 0x02014b50) return null;
      const method = zip.readUInt16LE(cursor + 10);
      const compressedSize = zip.readUInt32LE(cursor + 20);
      const nameLength = zip.readUInt16LE(cursor + 28);
      const extraLength = zip.readUInt16LE(cursor + 30);
      const commentLength = zip.readUInt16LE(cursor + 32);
      const localOffset = zip.readUInt32LE(cursor + 42);
      const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      if (name === targetName) {
        if (zip.readUInt32LE(localOffset) !== 0x04034b50) return null;
        const localNameLength = zip.readUInt16LE(localOffset + 26);
        const localExtraLength = zip.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = zip.subarray(dataStart, dataStart + compressedSize);
        if (method === 0) return Buffer.from(compressed);
        if (method === 8) return inflateRawSync(compressed);
        return null;
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return null;
  } catch {
    return null;
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Paperclip downloads Mojang's base server jar itself on first boot, bypassing
 * BlockCraft's selected Minecraft mirror. Pre-fill its own cache from the same
 * SHA-1-verified jar used by Vanilla/Fabric/Forge, then verify Paperclip's SHA-256.
 */
export async function ensurePaperclipServerCache(
  cfg: InstanceConfig,
  onLog: (line: string) => void = () => undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (cfg.loader !== 'paper') return;
  const serverDir = instanceServerDir(cfg.id);
  const paperJar = path.join(serverDir, 'paper.jar');
  const context = fs.existsSync(paperJar) ? readZipEntry(paperJar, 'META-INF/download-context')?.toString('utf8') : null;
  if (!context) throw new Error('Paper 服务端包缺少 META-INF/download-context，无法校验启动依赖');
  const [expectedHash, _officialUrl, fileName] = context.trim().split(/\s+/);
  if (!/^[a-f\d]{64}$/i.test(expectedHash ?? '') || !fileName || path.basename(fileName) !== fileName) {
    throw new Error('Paperclip 下载清单格式无效，已停止启动以避免下载错误的服务端文件');
  }

  const cacheFile = path.join(serverDir, 'cache', fileName);
  if (fs.existsSync(cacheFile) && (await sha256File(cacheFile)).toLowerCase() === expectedHash.toLowerCase()) {
    onLog(`Paperclip 核心依赖已缓存并通过 SHA-256 校验：${fileName}`);
    return;
  }

  const vanillaJar = await ensureVanillaServerJar(cfg.mc, onLog, signal);
  const actualHash = await sha256File(vanillaJar);
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`Minecraft ${cfg.mc} 服务端包与 Paperclip 所需版本不一致（SHA-256 校验失败）`);
  }
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.rmSync(cacheFile, { force: true });
  copyIntoTarget(vanillaJar, cacheFile);
  onLog(`已通过设置的 Minecraft 下载源预热 Paperclip 核心依赖：${fileName}（SHA-256 已校验）`);
}

/** Pass the configured HTTP(S) proxy to Java installers that ignore Node's proxy settings. */
function javaProxyArgs(onLog: (s: string) => void): string[] {
  const value = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!value) return [];
  try {
    const proxy = new URL(value);
    if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname) return [];
    const port = proxy.port || (proxy.protocol === 'https:' ? '443' : '80');
    const args = [
      `-Dhttp.proxyHost=${proxy.hostname}`,
      `-Dhttp.proxyPort=${port}`,
      `-Dhttps.proxyHost=${proxy.hostname}`,
      `-Dhttps.proxyPort=${port}`,
    ];
    onLog('Java 安装器将通过系统 HTTP(S) 代理下载依赖');
    return args;
  } catch {
    onLog('系统代理地址无法解析，Java 安装器将直接连接下载依赖');
    return [];
  }
}

// ------------------------------------------------------------------ 各加载器安装

async function installVanilla(cfg: InstanceConfig, onLog: (s: string) => void, signal?: AbortSignal): Promise<void> {
  const serverDir = instanceServerDir(cfg.id);
  const cache = await ensureVanillaServerJar(cfg.mc, onLog, signal);
  copyIntoTarget(cache, path.join(serverDir, 'minecraft_server.jar'));
}

function copyIntoTarget(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.tmp-${Date.now()}`;
  fs.copyFileSync(from, tmp);
  fs.renameSync(tmp, to);
}

async function installPaper(cfg: InstanceConfig, onLog: (s: string) => void, signal?: AbortSignal): Promise<void> {
  const serverDir = instanceServerDir(cfg.id);
  onLog('查询 Paper 构建列表…');
  const { paperBuilds } = await import('./versionsService.ts');
  const builds = await paperBuilds(cfg.mc);
  signal?.throwIfAborted();
  if (!builds.length) throw bad(`Paper 没有 ${cfg.mc} 的可用构建（Paper 只支持部分原版版本）`);
  const latest = builds[0];
  onLog(`选用 Paper ${cfg.mc} build ${latest.id}（${latest.channel}）`);
  const cache = path.join(STORE_DIR, 'paper', cfg.mc, latest.name);
  if (!fs.existsSync(cache)) {
    await downloadTo(latest.url, cache, onLog, { signal });
  } else {
    onLog(`复用已下载的 ${latest.name}`);
  }
  copyIntoTarget(cache, path.join(serverDir, 'paper.jar'));
}

async function installFabric(cfg: InstanceConfig, onLog: (s: string) => void, signal?: AbortSignal): Promise<void> {
  const serverDir = instanceServerDir(cfg.id);
  const fabricVersion = cfg.loaderVersion || '0.16.9';
  const installerCache = path.join(STORE_DIR, 'fabric', 'fabric-installer-1.0.1.jar');
  const installerUrl = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar';
  if (!fs.existsSync(installerCache)) await downloadTo(installerUrl, installerCache, onLog, { signal });
  else onLog('复用已下载的 Fabric 安装器');

  const { runtime: java, reason } = await ensureJava(cfg.mc, 'fabric', onLog, { signal });
  if (!java) throw conflict(reason || '未找到可用于 Fabric 安装的 Java');

  // Fabric 的 server/jar API 已不可用。运行官方安装器生成真正的
  // fabric-server-launch.jar 和 libraries；安装器 Java 网络请求跟随常见代理环境变量。
  const proxyArgs = javaProxyArgs(onLog);

  onLog(`运行 Fabric 安装器（Minecraft ${cfg.mc} / Loader ${fabricVersion}）…`);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      java.path,
      [...proxyArgs, '-jar', installerCache, 'server', '-dir', serverDir, '-mcversion', cfg.mc, '-loader', fabricVersion],
      { cwd: serverDir, maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal },
      (err, stdout, stderr) => {
        for (const line of (stdout + stderr).split('\n').slice(-60)) if (line.trim()) onLog(line.trim());
        if (err) reject(new Error(`Fabric 安装器失败：${err.message}`));
        else resolve();
      },
    );
    child.on('error', reject);
  });

  const launcher = path.join(serverDir, 'fabric-server-launch.jar');
  if (!fs.existsSync(launcher)) throw new Error('Fabric 安装器未生成 fabric-server-launch.jar');

  // Fabric 自举启动器从当前目录的 server.jar 加载 Mojang 服务端。
  const cache = await ensureVanillaServerJar(cfg.mc, onLog, signal);
  copyIntoTarget(cache, path.join(serverDir, 'server.jar'));
}

function isFabricLauncher(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    const zip = fs.readFileSync(file);
    const endMin = Math.max(0, zip.length - 65_557);
    let end = -1;
    for (let i = zip.length - 22; i >= endMin; i--) {
      if (zip.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) return false;
    const entries = zip.readUInt16LE(end + 10);
    const directoryOffset = zip.readUInt32LE(end + 16);
    let cursor = directoryOffset;
    for (let i = 0; i < entries; i++) {
      if (zip.readUInt32LE(cursor) !== 0x02014b50) return false;
      const method = zip.readUInt16LE(cursor + 10);
      const compressedSize = zip.readUInt32LE(cursor + 20);
      const nameLength = zip.readUInt16LE(cursor + 28);
      const extraLength = zip.readUInt16LE(cursor + 30);
      const commentLength = zip.readUInt16LE(cursor + 32);
      const localOffset = zip.readUInt32LE(cursor + 42);
      const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      if (name === 'META-INF/MANIFEST.MF') {
        const localNameLength = zip.readUInt16LE(localOffset + 26);
        const localExtraLength = zip.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = zip.subarray(dataStart, dataStart + compressedSize);
        const manifest = (method === 8 ? inflateRawSync(compressed) : compressed).toString('utf8');
        return /Main-Class:\s*net\.fabricmc\.loader\.impl\.launch\.server\.FabricServerLauncher/i.test(manifest);
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return false;
  } catch {
    return false;
  }
}

async function installForgeLike(cfg: InstanceConfig, onLog: (s: string) => void, neo: boolean, signal?: AbortSignal): Promise<void> {
  const serverDir = instanceServerDir(cfg.id);
  const panel = loadConfig();
  const java = await ensureJava(cfg.mc, cfg.loader, onLog, { signal });
  if (!java.runtime) throw conflict(java.reason);

  const version = cfg.loaderVersion;
  if (!version) throw bad(`请先指定 ${neo ? 'NeoForge' : 'Forge'} 版本`);
  const configuredForgeMirrors = (panel.mirrors.forgeMaven ?? []).filter((base) => typeof base === 'string' && base.trim());
  // When the panel uses BMCLAPI, prefer its Forge Maven mirror even for
  // existing configs whose persisted list still puts Forge's official host first.
  const forgeMirrors = panel.mirrors.minecraftSource === 'bmclapi'
    ? [
        ...configuredForgeMirrors.filter((base) => base.includes('bmclapi2.bangbang93.com')),
        ...configuredForgeMirrors.filter((base) => !base.includes('bmclapi2.bangbang93.com')),
      ]
    : configuredForgeMirrors;
  const forgeMirrorBase = (forgeMirrors[0] ?? 'https://maven.minecraftforge.net').replace(/\/$/, '');
  let installerUrl: string;
  const fileName = neo ? `neoforge-${version}-installer.jar` : `forge-${cfg.mc}-${version}-installer.jar`;
  if (neo) {
    installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
  } else {
    installerUrl = `${forgeMirrorBase}/net/minecraftforge/forge/${cfg.mc}-${version}/forge-${cfg.mc}-${version}-installer.jar`;
  }
  const cache = path.join(STORE_DIR, neo ? 'neoforge' : 'forge', fileName);
  if (!fs.existsSync(cache)) {
    // Forge 官方源在国内常常超时，多源依次重试
    const urls = neo
      ? [installerUrl, installerUrl.replace('maven.neoforged.net', 'bmclapi2.bangbang93.com/maven')]
      : forgeMirrors.map((b) => `${b.replace(/\/$/, '')}/net/minecraftforge/forge/${cfg.mc}-${version}/${fileName}`);
    let lastErr: unknown = null;
    for (const u of urls) {
      signal?.throwIfAborted();
      try {
        await downloadTo(u, cache, onLog, { signal });
        lastErr = null;
        break;
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
        lastErr = err;
        onLog(`该源失败，换下一个：${u}`);
      }
    }
    if (lastErr) throw new Error(`所有源都下载失败：${String(lastErr)}`);
  } else {
    onLog(`复用已下载的安装包 ${fileName}`);
  }

  const minecraftLibrariesMirror = panel.mirrors.minecraftSource === 'bmclapi'
    ? `${BMCLAPI_BASE}/libraries`
    : '';
  const installerCopy = path.join(serverDir, fileName);
  copyIntoTarget(cache, installerCopy);
  // Forge and NeoForge installers otherwise download the Mojang server jar
  // themselves with short timeouts. Their DownloadUtils cache key is
  // minecraft/<version>/server.jar inside the installer working directory.
  const vanillaCache = await ensureVanillaServerJar(cfg.mc, onLog, signal);
  const vanillaTarget = path.join(serverDir, 'minecraft', cfg.mc, 'server.jar');
  fs.rmSync(vanillaTarget, { force: true });
  copyIntoTarget(vanillaCache, vanillaTarget);
  onLog(`已预下载并校验 Minecraft ${cfg.mc} 服务端，将由 ${neo ? 'NeoForge' : 'Forge'} 安装器复用`);
  onLog('运行 Forge 官方服务端安装任务（下载依赖并校验文件，可能需要几分钟）…');
  // Forge's SimpleInstaller.main performs an unrelated global TLS probe against
  // files.minecraftforge.net before starting any install action. If that one
  // host fails a handshake, the CLI returns without installing even though all
  // actual server artifacts are reachable from its configured Maven mirrors.
  // Invoke the same bundled SERVER action directly. Artifact downloads and
  // checksums still use Forge's own DownloadUtils; only the over-broad preflight
  // is skipped.
  const forgeRunner = fileURLToPath(new URL('../java/ForgeServerInstall.java', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      java.runtime!.path,
      [...javaProxyArgs(onLog), '-cp', fileName, forgeRunner, fileName, forgeMirrorBase, minecraftLibrariesMirror],
      { cwd: serverDir, signal, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let extractedEntries = 0;
    let reportedEntries = 0;
    const forwardLine = (line: string): void => {
      const clean = line.trim();
      if (!clean) return;
      // Forge emits one "Copying ..." line for every embedded jar resource.
      // Keep the task log useful without synchronously rewriting it thousands
      // of times while the installer unpacks those entries.
      if (clean.startsWith('Copying ')) {
        extractedEntries += 1;
        if (extractedEntries === 1 || extractedEntries - reportedEntries >= 250) {
          onLog(`Forge 安装器正在解包资源（已处理 ${extractedEntries} 项）`);
          reportedEntries = extractedEntries;
        }
        return;
      }
      onLog(clean);
    };
    const forwardLines = (stream: Readable | null): void => {
      if (!stream) return;
      stream.setEncoding('utf8');
      let pending = '';
      stream.on('data', (chunk: string | Buffer) => {
        pending += chunk.toString();
        const lines = pending.split(/\r\n|\n|\r/);
        pending = lines.pop() ?? '';
        for (const line of lines) forwardLine(line);
      });
      stream.on('end', () => {
        if (pending.trim()) forwardLine(pending);
      });
    };
    forwardLines(child.stdout);
    forwardLines(child.stderr);
    child.once('error', reject);
    child.once('close', (code, exitSignal) => {
      if (extractedEntries > reportedEntries) {
        onLog(`Forge 安装器已解包 ${extractedEntries} 项资源`);
      }
      if (code === 0) resolve();
      else reject(new Error(`安装程序失败（退出码 ${code ?? 'null'}，信号 ${exitSignal ?? 'none'}）`));
    });
  });
  const argsFile = loaderArgsPath(cfg);
  if (!hasLoaderEntry(cfg, serverDir)) {
    const expectedFile = argsFile ? path.basename(argsFile) : '启动参数文件';
    throw new Error(`${neo ? 'NeoForge' : 'Forge'} 安装器退出后没有生成当前系统需要的 ${expectedFile}，请查看上方安装日志后重新安装`);
  }
  onLog('安装完成');
}

export interface InstallResult {
  ok: boolean;
  message: string;
}

/** 按加载器安装服务端（幂等：已装好就跳过） */
export async function installServer(id: string, onLog: (s: string) => void, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<InstallResult> {
  opts.signal?.throwIfAborted();
  const cfg = I.getConfig(id);
  const serverDir = instanceServerDir(id);
  fs.mkdirSync(serverDir, { recursive: true });
  const exists = (rel: string) => fs.existsSync(path.join(serverDir, rel));

  const done: Record<Loader, () => boolean> = {
    vanilla: () => exists('minecraft_server.jar'),
    paper: () => exists('paper.jar'),
    fabric: () =>
      isFabricLauncher(path.join(serverDir, 'fabric-server-launch.jar')) &&
      exists('server.jar') &&
      exists(path.join('libraries', 'net', 'fabricmc', 'fabric-loader', cfg.loaderVersion || '0.16.9', `fabric-loader-${cfg.loaderVersion || '0.16.9'}.jar`)),
    forge: () => hasLoaderEntry(cfg, serverDir),
    neoforge: () => hasLoaderEntry(cfg, serverDir),
  };
  if (!opts.force && done[cfg.loader]?.()) {
    onLog('服务端文件已存在，跳过安装');
  } else {
    onLog(`开始安装：${cfg.loader} ${cfg.loaderVersion}（Minecraft ${cfg.mc}）`);
    switch (cfg.loader) {
      case 'vanilla':
        await installVanilla(cfg, onLog, opts.signal);
        break;
      case 'paper':
        await installPaper(cfg, onLog, opts.signal);
        break;
      case 'fabric':
        await installFabric(cfg, onLog, opts.signal);
        break;
      case 'forge':
        await installForgeLike(cfg, onLog, false, opts.signal);
        break;
      case 'neoforge':
        await installForgeLike(cfg, onLog, true, opts.signal);
        break;
      default:
        throw bad(`不支持的加载器：${cfg.loader}`);
    }
  }
  opts.signal?.throwIfAborted();
  I.writeProperties(id);
  return { ok: true, message: '安装完成' };
}

// ------------------------------------------------------------------ 复制为新世界

export interface CopyParams {
  name: string;
  note?: string;
  color?: string;
  levelSeed?: string;
  memoryMb?: number;
  gamemode?: string;
  difficulty?: string;
  pvp?: boolean;
  allowNether?: boolean;
  allowFlight?: boolean;
  generateStructures?: boolean;
  motd?: string;
  autostart?: boolean;
  inheritOps?: boolean;
  inheritWhitelist?: boolean;
  /** 连存档一起复制。默认 false：按「同模组的新世界」语义，用下面的种子重新生成 */
  includeWorld?: boolean;
}

/**
 * 复制为新世界：**逐文件真实复制**，不与源世界共享任何文件。
 * 不复制：存档、日志、备份、崩溃报告、端口（重新分配）、RCON 密码（重新生成）。
 */
export async function copyInstance(srcId: string, params: CopyParams, onLog: (s: string) => void): Promise<InstanceConfig> {
  // params.includeWorld: 是否连存档一起复制（默认否 —— 同模组的全新世界）
  const src = I.getConfig(srcId);
  if (!I.exists(srcId)) throw notFound(`源世界不存在：${srcId}`);
  onLog(`从「${src.name}」复制为新世界「${params.name}」`);
  const created = await I.createInstance({
    name: params.name,
    note: params.note ?? src.note,
    color: params.color ?? src.color,
    mc: src.mc,
    loader: src.loader,
    loaderVersion: src.loaderVersion,
    memoryMb: params.memoryMb ?? src.memoryMb,
    minMemoryMb: src.minMemoryMb,
    levelSeed: params.levelSeed ?? '',
    gamemode: params.gamemode ?? src.gamemode,
    difficulty: params.difficulty ?? src.difficulty,
    pvp: params.pvp ?? src.pvp,
    hardcore: src.hardcore,
    allowNether: params.allowNether ?? src.allowNether,
    allowFlight: params.allowFlight ?? src.allowFlight,
    generateStructures: params.generateStructures ?? src.generateStructures,
    onlineMode: src.onlineMode,
    whiteList: src.whiteList,
    maxPlayers: src.maxPlayers,
    motd: params.motd ?? params.name,
    viewDistance: src.viewDistance,
    simulationDistance: src.simulationDistance,
    gamerules: src.gamerules,
    autostart: params.autostart ?? false,
    createdFrom: { type: 'copy', source: srcId },
    tags: src.tags,
  });

  const from = instanceServerDir(srcId);
  const to = instanceServerDir(created.id);
  // 默认不带走存档（新世界按 seed 重新生成）；勾了「连存档一起复制」就保留存档目录。
  // 存档目录名跟随源世界的 level-name（不一定是 world），所以按实际配置判断。
  const skip = new Set(['logs', 'crash-reports', 'backups', 'level.dat_old']);
  if (!params.includeWorld) {
    const lvl = String(src.levelName || 'world');
    for (const d of [lvl, `${lvl}_nether`, `${lvl}_the_end`, 'DIM1', 'DIM-1', 'world', 'world_nether', 'world_the_end']) {
      skip.add(d);
    }
  }
  const skipFiles = new Set(['session.lock', 'usercache.json', 'ops.json', 'whitelist.json', 'banned-ips.json', 'banned-players.json']);
  onLog('开始复制服务端目录（真实复制，零共享）…');
  const stats = copyTree(from, to, { skipDirs: skip, skipFiles, onLog });
  onLog(`复制完成：${stats.files} 个文件，${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);

  if (params.inheritOps !== false) copyIfExists(path.join(from, 'ops.json'), path.join(to, 'ops.json'));
  if (params.inheritWhitelist !== false) copyIfExists(path.join(from, 'whitelist.json'), path.join(to, 'whitelist.json'));
  if (params.includeWorld) {
    // Player management builds its "all known players" list from usercache.json
    // as well as the operator, whitelist, and ban lists. Keep the player cache
    // and player bans with a copied save so the new world shows the same roster.
    copyIfExists(path.join(from, 'usercache.json'), path.join(to, 'usercache.json'));
    copyIfExists(path.join(from, 'banned-players.json'), path.join(to, 'banned-players.json'));
    onLog('已复制全部已知玩家记录（usercache 与封禁名单）');
  }

  // 覆盖级配置：与源世界不同的部分
  I.saveConfig(created.id, {
    // 带存档复制时种子由存档里的 level.dat 说了算，不能再写一个不同的种子进去
    levelSeed: params.includeWorld ? '' : params.levelSeed ?? '',
    gamerules: src.gamerules,
    ...(params.includeWorld ? { levelName: String(src.levelName || 'world') } : {}),
  });
  I.writeProperties(created.id);
  onLog('新世界的配置已生成（端口与 RCON 密码都是新的）');
  return I.getConfig(created.id);
}

function copyIfExists(from: string, to: string): void {
  try {
    if (fs.existsSync(from)) copyIntoTarget(from, to);
  } catch {
    /* ignore */
  }
}

interface CopyOptions {
  skipDirs?: Set<string>;
  skipFiles?: Set<string>;
  onLog?: (s: string) => void;
}

export function copyTree(from: string, to: string, opts: CopyOptions = {}): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (src: string, dst: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(src, { withFileTypes: true });
    } catch {
      return;
    }
    fs.mkdirSync(dst, { recursive: true });
    for (const e of entries) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(s);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        // 符号链接：重建成同样指向的链接（服务端本体可能用软链）
        try {
          const target = fs.readlinkSync(s);
          fs.symlinkSync(target, d);
        } catch {
          /* ignore */
        }
        continue;
      }
      if (st.isDirectory()) {
        if (opts.skipDirs?.has(e.name)) {
          opts.onLog?.(`跳过目录 ${e.name}/`);
          continue;
        }
        walk(s, d);
      } else if (st.isFile()) {
        if (opts.skipFiles?.has(e.name)) continue;
        try {
          copyIntoTarget(s, d);
          files++;
          bytes += st.size;
        } catch (err) {
          opts.onLog?.(`复制失败 ${e.name}：${String(err)}`);
        }
      }
    }
  };
  walk(from, to);
  return { files, bytes };
}

export function ensureInstanceDir(id: string): void {
  fs.mkdirSync(instanceDir(id), { recursive: true });
  logger.debug(`实例目录已就绪 ${id}`);
}
