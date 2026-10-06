import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { STORE_DIR, instanceDir, instanceServerDir } from '../core/paths.ts';
import { atomicWriteFileSync, readJsonSync } from '../core/fsx.ts';
import { bad, conflict, notFound } from '../core/errors.ts';
import { createLogger } from '../core/logger.ts';
import { loadConfig } from '../config.ts';
import { autoJava } from './javaService.ts';
import * as I from './instanceService.ts';
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
export async function downloadTo(url: string, dest: string, onLog?: (s: string) => void, opts: { retries?: number } = {}): Promise<void> {
  const retries = opts.retries ?? 3;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      onLog?.(`下载 ${path.basename(dest)}（第 ${attempt} 次）← ${url}`);
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'BlockCraft/2.0' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const expect = Number(res.headers.get('content-length') ?? 0);
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
      const size = fs.statSync(tmp).size;
      if (size === 0) throw new Error('下载到 0 字节');
      if (expect && size !== expect) throw new Error(`下载不完整：${size}/${expect}`);
      fs.renameSync(tmp, dest);
      onLog?.(`完成 ${path.basename(dest)}（${(size / 1024 / 1024).toFixed(1)} MB）`);
      return;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
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

async function vanillaServerUrl(mc: string): Promise<{ url: string; javaMajor: number }> {
  const m = await versionManifest();
  const v = m.versions.find((x) => x.id === mc);
  if (!v) throw bad(`找不到 Minecraft 版本 ${mc}`);
  const detail = await fetchJson<{ downloads: { server?: { url: string } }; javaVersion?: { majorVersion: number } }>(v.url);
  if (!detail.downloads.server) throw bad(`Minecraft ${mc} 没有服务端下载`);
  return { url: detail.downloads.server.url, javaMajor: detail.javaVersion?.majorVersion ?? 17 };
}

// ------------------------------------------------------------------ 各加载器安装

async function installVanilla(cfg: InstanceConfig, onLog: (s: string) => void): Promise<void> {
  const serverDir = instanceServerDir(cfg.id);
  const { url } = await vanillaServerUrl(cfg.mc);
  const cache = path.join(STORE_DIR, 'vanilla', cfg.mc, 'minecraft_server.jar');
  if (!fs.existsSync(cache)) await downloadTo(url, cache, onLog);
  else onLog(`复用已下载的原版服务端（${cfg.mc}）`);
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
  // Fabric 自举启动器
  const launcherUrl =
    'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar';
  const launcherCache = path.join(STORE_DIR, 'fabric', 'fabric-server-launch.jar');
  if (!fs.existsSync(launcherCache)) {
    // server-launch.jar 可以直接从 maven 拿
    const direct = 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar';
    void direct;
    await downloadTo(
      `https://meta.fabricmc.net/v2/versions/loader/${cfg.mc}/0.16.9/server/jar`,
      launcherCache,
      onLog,
    ).catch(async () => {
      await downloadTo('https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar', launcherCache, onLog);
    });
  } else {
    onLog('复用已下载的 Fabric 启动器');
  }
  copyIntoTarget(launcherCache, path.join(serverDir, 'fabric-server-launch.jar'));
  // Fabric 需要一份原版服务端 jar
  const { url } = await vanillaServerUrl(cfg.mc);
  const cache = path.join(STORE_DIR, 'vanilla', cfg.mc, 'minecraft_server.jar');
  if (!fs.existsSync(cache)) await downloadTo(url, cache, onLog);
  copyIntoTarget(cache, path.join(serverDir, 'minecraft_server.jar'));
  void launcherUrl;
}

async function installForgeLike(cfg: InstanceConfig, onLog: (s: string) => void, neo: boolean): Promise<void> {
  const serverDir = instanceServerDir(cfg.id);
  const panel = loadConfig();
  const java = autoJava(cfg.mc, cfg.loader);
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
  onLog('运行安装程序（首次会下载依赖，可能几分钟）…');
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      java.runtime!.path,
      ['-jar', fileName, '--installServer'],
      { cwd: serverDir, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        for (const line of (stdout + stderr).split('\n').slice(-40)) if (line.trim()) onLog(line.trim());
        if (err) reject(new Error(`安装程序失败：${err.message}`));
        else resolve();
      },
    );
    child.on('error', reject);
  });
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
    fabric: () => exists('fabric-server-launch.jar'),
    forge: () =>
      exists(path.join('libraries', 'net', 'minecraftforge', 'forge', `${cfg.mc}-${cfg.loaderVersion}`, 'unix_args.txt')) ||
      exists(`forge-${cfg.mc}-${cfg.loaderVersion}.jar`),
    neoforge: () => exists(path.join('libraries', 'net', 'neoforged', 'neoforge', cfg.loaderVersion, 'unix_args.txt')),
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
}

/**
 * 复制为新世界：**逐文件真实复制**，不与源世界共享任何文件。
 * 不复制：存档、日志、备份、崩溃报告、端口（重新分配）、RCON 密码（重新生成）。
 */
export async function copyInstance(srcId: string, params: CopyParams, onLog: (s: string) => void): Promise<InstanceConfig> {
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
  const skip = new Set(['world', 'logs', 'crash-reports', 'backups', 'level.dat_old']);
  const skipFiles = new Set(['session.lock', 'usercache.json', 'ops.json', 'banned-ips.json', 'banned-players.json']);
  onLog('开始复制服务端目录（真实复制，零共享）…');
  const stats = copyTree(from, to, { skipDirs: skip, skipFiles, onLog });
  onLog(`复制完成：${stats.files} 个文件，${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);

  if (params.inheritOps !== false) copyIfExists(path.join(from, 'ops.json'), path.join(to, 'ops.json'));
  if (params.inheritWhitelist !== false) copyIfExists(path.join(from, 'whitelist.json'), path.join(to, 'whitelist.json'));

  // 覆盖级配置：与源世界不同的部分
  I.saveConfig(created.id, {
    levelSeed: params.levelSeed ?? '',
    gamerules: src.gamerules,
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
