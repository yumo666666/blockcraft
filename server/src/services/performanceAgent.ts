import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, INSTANCE_ID_RE, instanceServerDir } from '../core/paths.ts';
import { compareVersion } from '../launcher/index.ts';
import type { InstanceConfig } from '../types.ts';
import * as I from './instanceService.ts';
import { createLogger } from '../core/logger.ts';

const logger = createLogger('performance-agent');
const SPARK_PROJECT_ID = 'l6YH9Als';
const FABRIC_API_PROJECT_ID = 'P7dR8mSH';
const MAX_SPARK_JAR_BYTES = 64 * 1024 * 1024;
const AGENT_SOURCE = new URL('../java/BlockCraftPerformanceAgent.java', import.meta.url);

export interface RuntimePerformanceMetrics {
  t: number;
  pid: number;
  tps: number | null;
  msptMean: number | null;
  msptP95: number | null;
  msptPeak: number | null;
  heapUsed: number | null;
  heapMax: number | null;
  gcCount: number | null;
  gcPause: number | null;
  pingMedian: number | null;
  pingP95: number | null;
  networkRx: number | null;
  networkTx: number | null;
  chunks: number | null;
  entities: number | null;
}

interface ModrinthFile {
  filename?: string;
  url?: string;
  primary?: boolean;
  size?: number;
  hashes?: { sha512?: string };
}

interface ModrinthVersion {
  version_number: string;
  version_type?: string;
  game_versions: string[];
  loaders: string[];
  files: ModrinthFile[];
}

const dynamicMetricKeys: (keyof Omit<RuntimePerformanceMetrics, 't' | 'pid'>)[] = [
  'tps', 'msptMean', 'msptP95', 'msptPeak', 'heapUsed', 'heapMax', 'gcCount', 'gcPause',
  'pingMedian', 'pingP95', 'networkRx', 'networkTx', 'chunks', 'entities',
];
type RuntimeMetricKey = keyof Omit<RuntimePerformanceMetrics, 't' | 'pid'>;
type SupplementalValues = Partial<Pick<RuntimePerformanceMetrics, RuntimeMetricKey>>;

const supplementalMetrics = new Map<string, {
  pid: number;
  values: SupplementalValues;
  updatedAt: Partial<Record<RuntimeMetricKey, number>>;
}>();

export function runtimePerformanceSnapshotFile(id: string): string {
  if (!INSTANCE_ID_RE.test(id)) throw new Error('世界 id 不合法');
  return path.join(DATA_DIR, 'performance', id, 'agent.json');
}

function validNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read only a fresh snapshot written by this world's current Java process. */
export function readRuntimePerformance(id: string, pid: number | null, now = Date.now()): RuntimePerformanceMetrics | null {
  if (!pid || pid <= 0) return null;
  const metrics = Object.fromEntries(dynamicMetricKeys.map((key) => [key, null])) as Omit<RuntimePerformanceMetrics, 't' | 'pid'>;
  let snapshotAt = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(runtimePerformanceSnapshotFile(id), 'utf8')) as {
      t?: unknown;
      pid?: unknown;
      values?: Record<string, unknown>;
    };
    if (typeof raw.t === 'number' && now - raw.t <= 15_000 && raw.t <= now + 5_000 && raw.pid === pid && raw.values) {
      snapshotAt = raw.t;
      for (const key of dynamicMetricKeys) metrics[key] = validNumber(raw.values[key]);
    }
  } catch {
    // Spark's JVM snapshot is optional; portable and RCON fallbacks may still be fresh.
  }

  let supplementalAt = 0;
  const supplemental = supplementalMetrics.get(id);
  if (supplemental?.pid === pid) {
    for (const key of dynamicMetricKeys) {
      const updatedAt = supplemental.updatedAt[key];
      if (updatedAt === undefined) continue;
      const ttl = key === 'pingMedian' || key === 'pingP95' ? 45_000 : 15_000;
      if (now - updatedAt > ttl || updatedAt > now + 5_000) continue;
      metrics[key] = supplemental.values[key] ?? null;
      supplementalAt = Math.max(supplementalAt, updatedAt);
    }
  }
  if (!snapshotAt && !supplementalAt) return null;
  return { t: Math.max(snapshotAt, supplementalAt), pid, ...metrics };
}

/** Merge a server-family command fallback into this process's fresh JVM snapshot. */
export function setRuntimePerformanceFallback(
  id: string,
  pid: number,
  values: SupplementalValues,
  at = Date.now(),
): void {
  if (!INSTANCE_ID_RE.test(id) || pid <= 0) return;
  const previous = supplementalMetrics.get(id);
  const entry = previous?.pid === pid
    ? previous
    : { pid, values: {} as SupplementalValues, updatedAt: {} as Partial<Record<RuntimeMetricKey, number>> };
  for (const [rawKey, value] of Object.entries(values)) {
    const key = rawKey as RuntimeMetricKey;
    if (value === undefined) continue;
    entry.values[key] = value;
    entry.updatedAt[key] = at;
  }
  supplementalMetrics.set(id, entry);
}

/** Compile the dependency-free Java agent once with the selected JDK. */
export function preparePerformanceAgent(javaHome: string): string | null {
  const source = fileURLToPath(AGENT_SOURCE);
  const toolsDir = path.join(javaHome, 'bin');
  const javac = path.join(toolsDir, process.platform === 'win32' ? 'javac.exe' : 'javac');
  const jarTool = path.join(toolsDir, process.platform === 'win32' ? 'jar.exe' : 'jar');
  if (!fs.existsSync(source) || !fs.existsSync(javac) || !fs.existsSync(jarTool)) return null;

  const outputDir = path.join(DATA_DIR, 'runtime', 'performance-agent');
  const jarFile = path.join(outputDir, 'blockcraft-performance-agent.jar');
  const sourceMtime = fs.statSync(source).mtimeMs;
  if (fs.existsSync(jarFile) && fs.statSync(jarFile).mtimeMs >= sourceMtime) return jarFile;

  const classesDir = path.join(outputDir, 'classes');
  const manifestFile = path.join(outputDir, 'MANIFEST.MF');
  fs.mkdirSync(classesDir, { recursive: true });
  const compiled = spawnSync(javac, ['-source', '8', '-target', '8', '-d', classesDir, source], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  if (compiled.error || compiled.status !== 0) {
    logger.warn('性能采集 Java agent 编译失败', compiled.stderr || String(compiled.error ?? compiled.status));
    return null;
  }
  fs.writeFileSync(manifestFile, 'Manifest-Version: 1.0\r\nPremain-Class: BlockCraftPerformanceAgent\r\n\r\n', 'ascii');
  const packed = spawnSync(jarTool, ['cfm', jarFile, manifestFile, '-C', classesDir, '.'], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  if (packed.error || packed.status !== 0 || !fs.existsSync(jarFile)) {
    logger.warn('性能采集 Java agent 打包失败', packed.stderr || String(packed.error ?? packed.status));
    return null;
  }
  return jarFile;
}

export function performanceAgentArgument(jarFile: string, snapshotFile: string): string {
  const encodedPath = Buffer.from(snapshotFile, 'utf8').toString('base64url');
  return `-javaagent:${jarFile}=${encodedPath}`;
}

function sparkTargets(cfg: InstanceConfig): { loader: string; directory: string } | null {
  const serverDir = instanceServerDir(cfg.id);
  if (cfg.loader === 'paper') {
    // Paper bundles spark on modern versions; older Paper releases do not have
    // a Modrinth server artifact that matches its API's legacy plugin matrix.
    if (compareVersion(cfg.mc, '1.21') >= 0) return null;
    return { loader: 'paper', directory: path.join(serverDir, 'plugins') };
  }
  if (cfg.loader === 'fabric' || cfg.loader === 'forge' || cfg.loader === 'neoforge') {
    return { loader: cfg.loader, directory: path.join(serverDir, 'mods') };
  }
  return null;
}

function hasSpark(serverDir: string): boolean {
  for (const folder of ['mods', 'plugins']) {
    try {
      if (fs.readdirSync(path.join(serverDir, folder)).some((name) => /^spark(?:[-_].*)?\.jar$/i.test(name))) return true;
    } catch { /* Folder is optional. */ }
  }
  return false;
}

async function compatibleModrinthVersion(projectId: string, mc: string, loader: string, signal?: AbortSignal): Promise<ModrinthVersion> {
  const query = new URLSearchParams({
    game_versions: JSON.stringify([mc]),
    loaders: JSON.stringify([loader]),
  });
  const response = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version?${query}`, {
    headers: { 'user-agent': 'BlockCraft/3.0 (server performance metrics)' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Modrinth API 返回 HTTP ${response.status}`);
  const versions = await response.json() as ModrinthVersion[];
  const version = versions.find((item) =>
    item.game_versions.includes(mc) && item.loaders.includes(loader) && (item.version_type ?? 'release') === 'release' &&
    item.files.some((file) => file.primary || item.files.length === 1),
  );
  if (!version) throw new Error(`没有找到 Minecraft ${mc} / ${loader} 匹配的 Spark 正式版`);
  return version;
}

async function installCompatibleModrinthArtifact(
  projectId: string,
  mc: string,
  loader: string,
  directory: string,
  label: string,
  onLog: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const version = await compatibleModrinthVersion(projectId, mc, loader, signal);
  const file = version.files.find((item) => item.primary) ?? version.files[0];
  if (!file?.url || !file.filename || path.basename(file.filename) !== file.filename) throw new Error(`${label} 没有返回有效的文件`);
  if (file.size && file.size > MAX_SPARK_JAR_BYTES) throw new Error(`${label} 文件超过 64 MB，已跳过自动安装`);
  signal?.throwIfAborted();
  const response = await fetch(file.url, {
    headers: { 'user-agent': 'BlockCraft/3.0 (server performance metrics)' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`下载 ${label} 失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_SPARK_JAR_BYTES) throw new Error(`${label} 文件为空或超过 64 MB`);
  if (file.hashes?.sha512) {
    const digest = crypto.createHash('sha512').update(bytes).digest('hex');
    if (digest.toLowerCase() !== file.hashes.sha512.toLowerCase()) throw new Error(`${label} SHA-512 校验失败`);
  }
  signal?.throwIfAborted();
  await fsp.mkdir(directory, { recursive: true });
  const destination = path.join(directory, file.filename);
  const temporary = `${destination}.download-${crypto.randomBytes(5).toString('hex')}`;
  await fsp.writeFile(temporary, bytes, { flag: 'wx' });
  try {
    signal?.throwIfAborted();
    await fsp.rename(temporary, destination);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  onLog(`已安装 ${label} ${version.version_number}，SHA-512 校验通过`);
}

/** Fabric's Spark and SkinRestorer runtime needs Fabric API on a clean server. */
export async function ensureFabricApiSupport(
  id: string,
  onLog: (line: string) => void = () => undefined,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  opts.signal?.throwIfAborted();
  const cfg = I.getConfig(id);
  if (cfg.loader !== 'fabric') return;
  const modsDir = path.join(instanceServerDir(id), 'mods');
  try {
    if (fs.readdirSync(modsDir).some((name) => /^fabric-api-.*\.jar$/i.test(name))) {
      onLog('已检测到 Fabric API');
      return;
    }
  } catch { /* The folder may not exist yet. */ }
  try {
    await installCompatibleModrinthArtifact(FABRIC_API_PROJECT_ID, cfg.mc, 'fabric', modsDir, 'Fabric API', onLog, opts.signal);
  } catch (error) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? error;
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('Fabric API 自动安装失败', { id, mc: cfg.mc, error: reason });
    throw new Error(`Fabric API 未能安装：${reason}`);
  }
}

/** Install official Spark where supported so the same in-process API works on each loader. */
export async function ensureSparkSupport(
  id: string,
  onLog: (line: string) => void = () => undefined,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  opts.signal?.throwIfAborted();
  const cfg = I.getConfig(id);
  const serverDir = instanceServerDir(id);
  if (hasSpark(serverDir)) {
    onLog('已检测到 Spark，游戏性能指标将通过服务端 API 采集');
    return;
  }
  const target = sparkTargets(cfg);
  if (!target) {
    onLog(cfg.loader === 'paper'
      ? `Paper ${cfg.mc} 随服内置 Spark；由统一 JVM 采集器读取其服务端 API`
      : `${cfg.loader} 不支持服务端 Spark；仅采集 JVM 通用指标，游戏指标显示为暂无数据`);
    return;
  }

  try {
    await installCompatibleModrinthArtifact(SPARK_PROJECT_ID, cfg.mc, target.loader, target.directory, 'Spark', onLog, opts.signal);
    onLog('游戏性能指标将通过服务端 API 采集');
  } catch (error) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? error;
    const reason = error instanceof Error ? error.message : String(error);
    onLog(`Spark 未能安装：${reason}。世界仍可启动，无法采集的游戏指标会显示暂无数据。`);
    logger.warn('自动安装 Spark 失败', { id, mc: cfg.mc, loader: cfg.loader, error: reason });
  }
}
