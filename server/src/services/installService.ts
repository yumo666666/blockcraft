import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
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

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { 'user-agent': 'BlockCraft/2.0', ...(init.headers ?? {}) } });
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
  opts: { retries?: number; timeoutMs?: number; sha1?: string } = {},
): Promise<void> {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`下载超过 ${Math.round(timeoutMs / 1000)} 秒`)), timeoutMs);
    try {
      onLog?.(`下载 ${path.basename(dest)}（第 ${attempt}/${retries} 次）← ${url}`);
      const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'BlockCraft/2.0' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const expect = Number(res.headers.get('content-length') ?? 0);
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
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

export async function versionManifest(force = false): Promise<VersionManifest> {
  const file = path.join(STORE_DIR, 'versions', 'manifest.json');
  const cached = readJsonSync<(VersionManifest & { fetchedAt?: number }) | null>(file, null);
  if (!force && cached && cached.fetchedAt && Date.now() - cached.fetchedAt < MANIFEST_TTL) return cached;
  const data = await fetchJson<VersionManifest>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify({ ...data, fetchedAt: Date.now() }, null, 2));
  return data;
}

export async function listVersions(): Promise<{ id: string; type: string }[]> {
  const m = await versionManifest();
  return m.versions.map((v) => ({ id: v.id, type: v.type }));
}

async function vanillaServerUrl(mc: string): Promise<{ url: string; sha1?: string; javaMajor: number }> {
  const m = await versionManifest();
  const v = m.versions.find((x) => x.id === mc);
  if (!v) throw bad(`找不到 Minecraft 版本 ${mc}`);
  const detail = await fetchJson<{ downloads: { server?: { url: string; sha1?: string } }; javaVersion?: { majorVersion: number } }>(v.url);
  if (!detail.downloads.server) throw bad(`Minecraft ${mc} 没有服务端下载`);
  return { url: detail.downloads.server.url, sha1: detail.downloads.server.sha1, javaMajor: detail.javaVersion?.majorVersion ?? 17 };
}

async function ensureVanillaServerJar(mc: string, onLog: (s: string) => void): Promise<string> {
  const { url, sha1 } = await vanillaServerUrl(mc);
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
  await downloadTo(url, cache, onLog, { retries: 4, timeoutMs: 180_000, sha1 });
  return cache;
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

async function installVanilla(cfg: InstanceConfig, onLog: (s: string) => void): Promise<void> {
  const serverDir = instanceServerDir(cfg.id);
  const cache = await ensureVanillaServerJar(cfg.mc, onLog);
  copyIntoTarget(cache, path.join(serverDir, 'minecraft_server.jar'));
}

function copyIntoTarget(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.tmp-${Date.now()}`;
  fs.copyFileSync(from, tmp);
  fs.renameSync(tmp, to);
}

async function installPaper(cfg: InstanceConfig, onLog: (s: string) => void): Promise<void> {
  const serverDir = instanceServerDir(cfg.id);
  onLog('查询 Paper 构建列表…');
  const { paperBuilds } = await import('./versionsService.ts');
  const builds = await paperBuilds(cfg.mc);
  if (!builds.length) throw bad(`Paper 没有 ${cfg.mc} 的可用构建（Paper 只支持部分原版版本）`);
  const latest = builds[0];
  onLog(`选用 Paper ${cfg.mc} build ${latest.id}（${latest.channel}）`);
  const cache = path.join(STORE_DIR, 'paper', cfg.mc, latest.name);
  if (!fs.existsSync(cache)) {
    await downloadTo(latest.url, cache, onLog);
  } else {
    onLog(`复用已下载的 ${latest.name}`);
  }
  copyIntoTarget(cache, path.join(serverDir, 'paper.jar'));
}

async function installFabric(cfg: InstanceConfig, onLog: (s: string) => void): Promise<void> {
  const serverDir = instanceServerDir(cfg.id);
  const fabricVersion = cfg.loaderVersion || '0.16.9';
  const installerCache = path.join(STORE_DIR, 'fabric', 'fabric-installer-1.0.1.jar');
  const installerUrl = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar';
  if (!fs.existsSync(installerCache)) await downloadTo(installerUrl, installerCache, onLog);
  else onLog('复用已下载的 Fabric 安装器');

  const { runtime: java, reason } = await ensureJava(cfg.mc, 'fabric', onLog);
  if (!java) throw conflict(reason || '未找到可用于 Fabric 安装的 Java');

  // Fabric 的 server/jar API 已不可用。运行官方安装器生成真正的
  // fabric-server-launch.jar 和 libraries；安装器 Java 网络请求跟随常见代理环境变量。
  const proxyArgs = javaProxyArgs(onLog);

  onLog(`运行 Fabric 安装器（Minecraft ${cfg.mc} / Loader ${fabricVersion}）…`);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      java.path,
      [...proxyArgs, '-jar', installerCache, 'server', '-dir', serverDir, '-mcversion', cfg.mc, '-loader', fabricVersion],
      { cwd: serverDir, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
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
  const cache = await ensureVanillaServerJar(cfg.mc, onLog);
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

async function installForgeLike(cfg: InstanceConfig, onLog: (s: string) => void, neo: boolean): Promise<void> {
  const serverDir = instanceServerDir(cfg.id);
  const panel = loadConfig();
  const java = await ensureJava(cfg.mc, cfg.loader, onLog);
  if (!java.runtime) throw conflict(java.reason);

  const version = cfg.loaderVersion;
  if (!version) throw bad(`请先指定 ${neo ? 'NeoForge' : 'Forge'} 版本`);
  let installerUrl: string;
  const fileName = neo ? `neoforge-${version}-installer.jar` : `forge-${cfg.mc}-${version}-installer.jar`;
  if (neo) {
    installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
  } else {
    const mavenBase = panel.mirrors.forgeMaven[0] ?? 'https://maven.minecraftforge.net';
    installerUrl = `${mavenBase.replace(/\/$/, '')}/net/minecraftforge/forge/${cfg.mc}-${version}/forge-${cfg.mc}-${version}-installer.jar`;
  }
  const cache = path.join(STORE_DIR, neo ? 'neoforge' : 'forge', fileName);
  if (!fs.existsSync(cache)) {
    // Forge 官方源在国内常常超时，多源依次重试
    const urls = neo
      ? [installerUrl, installerUrl.replace('maven.neoforged.net', 'bmclapi2.bangbang93.com/maven')]
      : panel.mirrors.forgeMaven.map((b) => `${b.replace(/\/$/, '')}/net/minecraftforge/forge/${cfg.mc}-${version}/${fileName}`);
    let lastErr: unknown = null;
    for (const u of urls) {
      try {
        await downloadTo(u, cache, onLog);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        onLog(`该源失败，换下一个：${u}`);
      }
    }
    if (lastErr) throw new Error(`所有源都下载失败：${String(lastErr)}`);
  } else {
    onLog(`复用已下载的安装包 ${fileName}`);
  }

  const installerCopy = path.join(serverDir, fileName);
  copyIntoTarget(cache, installerCopy);
  // Forge's Java installer downloads the Mojang server jar itself with a short
  // read timeout. Fetch and checksum it through BlockCraft's retrying downloader,
  // then let Forge reuse the expected minecraft_server.<version>.jar file.
  const vanillaCache = await ensureVanillaServerJar(cfg.mc, onLog);
  const vanillaTarget = path.join(serverDir, `minecraft_server.${cfg.mc}.jar`);
  fs.rmSync(vanillaTarget, { force: true });
  copyIntoTarget(vanillaCache, vanillaTarget);
  onLog(`已预下载并校验 Minecraft ${cfg.mc} 服务端，将由 ${neo ? 'NeoForge' : 'Forge'} 安装器复用`);
  onLog('运行安装程序（首次会下载依赖，可能几分钟）…');
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      java.runtime!.path,
      [...javaProxyArgs(onLog), '-jar', fileName, '--installServer'],
      { cwd: serverDir, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        for (const line of (stdout + stderr).split('\n').slice(-40)) if (line.trim()) onLog(line.trim());
        if (err) reject(new Error(`安装程序失败：${err.message}`));
        else resolve();
      },
    );
    child.on('error', reject);
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
export async function installServer(id: string, onLog: (s: string) => void, opts: { force?: boolean } = {}): Promise<InstallResult> {
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
        await installVanilla(cfg, onLog);
        break;
      case 'paper':
        await installPaper(cfg, onLog);
        break;
      case 'fabric':
        await installFabric(cfg, onLog);
        break;
      case 'forge':
        await installForgeLike(cfg, onLog, false);
        break;
      case 'neoforge':
        await installForgeLike(cfg, onLog, true);
        break;
      default:
        throw bad(`不支持的加载器：${cfg.loader}`);
    }
  }
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
  const skipFiles = new Set(['session.lock', 'usercache.json', 'ops.json', 'banned-ips.json', 'banned-players.json']);
  onLog('开始复制服务端目录（真实复制，零共享）…');
  const stats = copyTree(from, to, { skipDirs: skip, skipFiles, onLog });
  onLog(`复制完成：${stats.files} 个文件，${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);

  if (params.inheritOps !== false) copyIfExists(path.join(from, 'ops.json'), path.join(to, 'ops.json'));
  if (params.inheritWhitelist !== false) copyIfExists(path.join(from, 'whitelist.json'), path.join(to, 'whitelist.json'));

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
