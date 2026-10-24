import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, INSTANCE_ID_RE, instanceServerDir } from '../core/paths.ts';
import { createLogger } from '../core/logger.ts';
import { summarizeAll } from './overview.ts';
import { rcon } from './supervisor.ts';
import { readRuntimePerformance, setRuntimePerformanceFallback } from './performanceAgent.ts';
import { readHostNetworkRates } from './hostNetwork.ts';
import type { InstanceSummary } from '../types.ts';

export const PERFORMANCE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const PERFORMANCE_SAMPLE_INTERVAL_MS = 5_000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_RESPONSE_POINTS = 2_200;
const HISTORY_DIR = path.join(DATA_DIR, 'performance');
const logger = createLogger('performance-history');
const SPARK_PING_REFRESH_MS = 30_000;
const sparkPingRefresh = new Map<string, { pid: number; at: number }>();

export type PerformanceMetric =
  | 'cpu' | 'memory' | 'players' | 'latency' | 'threads' | 'storage'
  | 'tps' | 'msptMean' | 'msptP95' | 'msptPeak'
  | 'heapUsed' | 'gcCount' | 'gcPause'
  | 'pingMedian' | 'pingP95' | 'networkRx' | 'networkTx' | 'chunks' | 'entities';

export const PERFORMANCE_METRICS: Record<PerformanceMetric, {
  title: string;
  unit: string;
  description: string;
  source: string;
  field: keyof StoredPerformanceSample;
  limitField?: keyof StoredPerformanceSample;
}> = {
  cpu: {
    title: 'CPU 使用率',
    unit: '%',
    description: 'BlockCraft 读取服务端 Java 进程的 CPU 时间差，并按单核 100% 计算。多核进程可能超过 100%。它表示进程消耗的 CPU，不是整台主机的总使用率。',
    source: '操作系统进程计数器',
    field: 'cpu',
  },
  memory: {
    title: '进程内存',
    unit: 'MB',
    description: '服务端 Java 进程当前驻留在物理内存中的大小（RSS / Working Set）。它包含 Java 堆和 JVM 原生内存，不等于 Xmx 堆上限。',
    source: '操作系统进程计数器',
    field: 'memory',
  },
  players: {
    title: '在线玩家',
    unit: '人',
    description: 'Minecraft 状态协议报告的当前在线玩家数。服务器关闭状态查询或暂时无法响应时，该时段会显示为缺失数据，不会记成 0 人。',
    source: 'Minecraft Java 状态协议',
    field: 'players',
  },
  latency: {
    title: '状态探测耗时',
    unit: 'ms',
    description: '面板所在主机连接游戏端口并收到状态响应所花的时间。它不代表每位玩家的公网 Ping；状态协议不可用时不会产生数据。',
    source: 'Minecraft Java 状态协议',
    field: 'latency',
  },
  threads: {
    title: '进程线程数',
    unit: '个',
    description: '服务端 Java 进程当前线程总数，包括游戏、区块工作线程、网络和 JVM 垃圾回收线程。它用于观察线程规模变化，不直接等同于 CPU 使用率。',
    source: '操作系统进程计数器',
    field: 'threads',
  },
  storage: {
    title: '实例目录占用',
    unit: 'MB',
    description: 'BlockCraft 实例目录的磁盘占用，包含服务端文件、配置和备份等。它主要用于观察容量变化，不是磁盘读写速度。目录大小约每分钟刷新一次。',
    source: '实例目录扫描缓存',
    field: 'storage',
  },
  tps: {
    title: 'TPS', unit: 'TPS',
    description: '服务端最近 5 秒的每秒游戏刻数。Minecraft 常规目标是 20 TPS；持续低于 20 通常表示服务器处理速度跟不上。',
    source: 'Spark 服务端统计 API；Paper 内置命令回退', field: 'tps',
  },
  msptMean: {
    title: '平均 MSPT', unit: 'ms',
    description: '最近约 5–10 秒内每个游戏刻的平均处理时间。20 TPS 对应每刻约 50 ms 的预算；持续超过 50 ms 时，服务器无法稳定处理每秒 20 刻。',
    source: 'Spark 服务端统计 API；Paper 内置命令回退', field: 'msptMean',
  },
  msptP95: {
    title: 'MSPT P95', unit: 'ms',
    description: '最近约 5–10 秒内 95% 的游戏刻处理时间不高于该值。它能显示多数刻是否稳定，避免平均值掩盖较慢的刻。Paper 命令未提供百分位时保留为暂无数据。',
    source: 'Spark 服务端统计 API（10 秒窗口）', field: 'msptP95',
  },
  msptPeak: {
    title: 'MSPT 峰值', unit: 'ms',
    description: '最近约 5–10 秒观测到的最长单刻处理时间。单次尖峰不一定代表持续卡顿，应结合平均值和 P95 一起看。',
    source: 'Spark 服务端统计 API；Paper 内置命令回退', field: 'msptPeak',
  },
  heapUsed: {
    title: 'Java 堆内存', unit: 'MB',
    description: 'JVM 当前 Java 堆已用内存，图中的虚线和“已用 / 上限”数字表示该进程的最大堆容量。高占用本身不等于故障，需结合 GC 停顿和内存是否持续逼近上限判断。',
    source: 'Java ManagementFactory（JMX）', field: 'heapUsed', limitField: 'heapMax',
  },
  gcCount: {
    title: 'GC 次数', unit: '次/分',
    description: '过去 60 秒 JVM 垃圾回收器完成的回收次数。数值突然升高可结合 GC 停顿和堆内存曲线判断是否频繁回收。',
    source: 'Java GarbageCollectorMXBean（滚动 60 秒）', field: 'gcCount',
  },
  gcPause: {
    title: 'GC 停顿时间', unit: 'ms/分',
    description: '过去 60 秒各垃圾回收器报告的累计回收耗时。它是 GC 总耗时，不等于单次最长暂停；JVM 以毫秒为精度报告。',
    source: 'Java GarbageCollectorMXBean（滚动 60 秒）', field: 'gcPause',
  },
  pingMedian: {
    title: '玩家 Ping 中位数', unit: 'ms',
    description: 'Spark 统计的在线玩家往返延迟中位数，约一半样本不高于此值。只有服务器已采到玩家 Ping 时才有数据。',
    source: 'Spark 玩家 Ping 统计（15 分钟窗口）', field: 'pingMedian',
  },
  pingP95: {
    title: '玩家 Ping P95', unit: 'ms',
    description: 'Spark 玩家 Ping 样本的第 95 百分位，反映较高延迟玩家的体验。它只统计已连接玩家，并非面板主机到游戏端口的探测时间。',
    source: 'Spark 玩家 Ping 统计（15 分钟窗口）', field: 'pingP95',
  },
  networkRx: {
    title: '主机网络接收', unit: 'MB/s',
    description: '主机可见网卡的接收速率，优先使用 Spark 的网卡采样；Spark 未提供时回退操作系统累计字节计数。汇总接口可能包含同一主机上的其他程序流量，不代表单个 Minecraft 进程的精确流量。',
    source: 'Spark / 操作系统网卡计数（多接口合计）', field: 'networkRx',
  },
  networkTx: {
    title: '主机网络发送', unit: 'MB/s',
    description: '主机可见网卡的发送速率，优先使用 Spark 的网卡采样；Spark 未提供时回退操作系统累计字节计数。汇总接口可能包含同一主机上的其他程序流量，不代表单个 Minecraft 进程的精确流量。',
    source: 'Spark / 操作系统网卡计数（多接口合计）', field: 'networkTx',
  },
  chunks: {
    title: '已加载区块', unit: '个',
    description: 'Spark 从当前已加载世界的区块信息汇总出的区块数。它会按世界采集，采样频率低于 JVM 指标；模组或服务端未提供世界统计时显示暂无数据。',
    source: 'Spark 世界统计 API', field: 'chunks',
  },
  entities: {
    title: '已加载实体', unit: '个',
    description: 'Spark 当前已加载世界里的实体总数，包括生物、物品等实体类别。它不等于在线玩家数；服务端未提供世界统计时显示暂无数据。',
    source: 'Spark 世界统计 API', field: 'entities',
  },
};

export interface StoredPerformanceSample {
  t: number;
  cpu: number | null;
  memory: number | null;
  players: number | null;
  latency: number | null;
  threads: number | null;
  storage: number | null;
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

export interface PerformancePoint {
  t: number;
  value: number | null;
  min: number | null;
  max: number | null;
  from: number;
  to: number;
  limit: number | null;
}

const writeQueues = new Map<string, Promise<void>>();
let sampleTimer: NodeJS.Timeout | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let collecting = false;
let pruning = false;
let knownRunningWorld = false;

function worldHistoryDir(id: string): string {
  if (!INSTANCE_ID_RE.test(id)) throw new Error('世界 id 不合法');
  return path.join(HISTORY_DIR, id);
}

function hourStart(timestamp: number): number {
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}

function hourFilename(timestamp: number): string {
  return `${new Date(hourStart(timestamp)).toISOString().slice(0, 13).replace('T', '_')}.jsonl`;
}

function parseHourFilename(name: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})\.jsonl$/.exec(name);
  if (!match) return null;
  const value = Date.parse(`${match[1]}T${match[2]}:00:00.000Z`);
  return Number.isFinite(value) ? value : null;
}

function asFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sampleFromSummary(
  world: InstanceSummary,
  t: number,
  hostNetwork: { received: number | null; sent: number | null } | null,
): StoredPerformanceSample {
  const activeProcess = world.pid !== null && ['running', 'starting', 'stopping', 'stuck'].includes(world.status);
  const processObserved = activeProcess && world.rss > 0;
  const runtime = world.performance?.pid === world.pid ? world.performance : null;
  return {
    t,
    cpu: processObserved ? asFinite(world.cpu) : null,
    memory: processObserved ? asFinite(world.rss / 1024 / 1024) : null,
    players: world.playersKnown ? asFinite(world.players) : null,
    latency: asFinite(world.queryLatencyMs),
    threads: processObserved ? asFinite(world.threads) : null,
    storage: asFinite(world.diskUsage / 1024 / 1024),
    tps: asFinite(runtime?.tps),
    msptMean: asFinite(runtime?.msptMean),
    msptP95: asFinite(runtime?.msptP95),
    msptPeak: asFinite(runtime?.msptPeak),
    heapUsed: runtime?.heapUsed == null ? null : asFinite(runtime.heapUsed / 1024 / 1024),
    heapMax: runtime?.heapMax == null ? null : asFinite(runtime.heapMax / 1024 / 1024),
    gcCount: asFinite(runtime?.gcCount),
    gcPause: asFinite(runtime?.gcPause),
    pingMedian: asFinite(runtime?.pingMedian),
    pingP95: asFinite(runtime?.pingP95),
    networkRx: runtime?.networkRx != null
      ? asFinite(runtime.networkRx / 1024 / 1024)
      : hostNetwork?.received == null ? null : asFinite(hostNetwork.received / 1024 / 1024),
    networkTx: runtime?.networkTx != null
      ? asFinite(runtime.networkTx / 1024 / 1024)
      : hostNetwork?.sent == null ? null : asFinite(hostNetwork.sent / 1024 / 1024),
    chunks: asFinite(runtime?.chunks),
    entities: asFinite(runtime?.entities),
  };
}

async function appendSample(id: string, sample: StoredPerformanceSample): Promise<void> {
  const dir = worldHistoryDir(id);
  const file = path.join(dir, hourFilename(sample.t));
  await fsp.mkdir(dir, { recursive: true });
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => fsp.appendFile(file, `${JSON.stringify(sample)}\n`, 'utf8'));
  writeQueues.set(file, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(file) === next) writeQueues.delete(file);
  }
}

/** Read portable operating-system and status-protocol metrics without loader-specific mods. */
async function collectOnce(): Promise<void> {
  if (collecting) return;
  collecting = true;
  const t = Date.now();
  try {
    // Read the OS counters alongside the world summary so a slow Minecraft
    // status probe cannot add its full timeout to every 5-second sample cycle.
    const wasRunning = knownRunningWorld;
    const [worlds, networkReading] = await Promise.all([
      summarizeAll(),
      knownRunningWorld ? readHostNetworkRates() : Promise.resolve(null),
    ]);
    const hasRunningWorld = worlds.some((world) => world.pid && ['running', 'starting', 'stopping', 'stuck'].includes(world.status));
    knownRunningWorld = hasRunningWorld;
    if (hasRunningWorld && !wasRunning && !networkReading) void readHostNetworkRates();
    const hostNetwork = hasRunningWorld ? networkReading : null;
    const samples = await Promise.all(worlds.map(async (world) => {
      const active = Boolean(world.pid && world.status === 'running');
      if (active && world.pid && hostNetwork) {
        setRuntimePerformanceFallback(world.id, world.pid, {
          ...(hostNetwork.received === null ? {} : { networkRx: hostNetwork.received }),
          ...(hostNetwork.sent === null ? {} : { networkTx: hostNetwork.sent }),
        }, t);
      }

      if (active && world.pid && world.loader !== 'vanilla' &&
        (world.performance?.pingMedian == null || world.performance?.pingP95 == null)) {
        // RCON is opportunistic and must not hold up the 5-second history loop.
        void readSparkPingMetrics(world, t);
      }

      if (world.loader === 'paper' && active && world.pid) void readPaperCommandMetrics(world);
      const performance = world.pid ? readRuntimePerformance(world.id, world.pid, Date.now()) : world.performance;
      return { ...world, performance };
    }));
    await Promise.allSettled(samples.map((world) => appendSample(world.id, sampleFromSummary(world, t, hostNetwork))));
  } catch (err) {
    logger.warn('性能采样失败', String(err));
  } finally {
    collecting = false;
  }
}

function hasSparkJar(worldId: string): boolean {
  const serverDir = instanceServerDir(worldId);
  for (const folder of ['mods', 'plugins']) {
    try {
      if (fs.readdirSync(path.join(serverDir, folder)).some((name) => /^spark(?:[-_].*)?\.jar$/i.test(name))) return true;
    } catch {
      // Mods and plugins are optional for some server families.
    }
  }
  return false;
}

function parseSparkPing(text: string): { pingMedian: number; pingP95: number } | null {
  const clean = stripFormatting(text);
  const groups = [...clean.matchAll(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/g)];
  const latest = groups.at(-1);
  if (!latest) return null;
  const pingMedian = asFinite(Number(latest[2]));
  const pingP95 = asFinite(Number(latest[3]));
  return pingMedian === null || pingP95 === null ? null : { pingMedian, pingP95 };
}

/** Spark's command works across server loaders and avoids loader-specific API classloading. */
async function readSparkPingMetrics(world: InstanceSummary, now: number): Promise<void> {
  if (!world.pid || (world.loader !== 'paper' && !hasSparkJar(world.id))) return;
  const previous = sparkPingRefresh.get(world.id);
  if (previous?.pid === world.pid && now - previous.at < SPARK_PING_REFRESH_MS) return;
  sparkPingRefresh.set(world.id, { pid: world.pid, at: now });
  try {
    const values = parseSparkPing(await rcon(world.id, 'spark ping'));
    if (values) setRuntimePerformanceFallback(world.id, world.pid, values, Date.now());
  } catch (err) {
    logger.debug('Spark 玩家 Ping 命令采集失败', { id: world.id, error: String(err) });
  }
}

function stripFormatting(text: string): string {
  return text.replace(/§[0-9A-FK-OR]/gi, '').replace(/\u001b\[[0-9;]*m/g, '');
}

function parsePaperTps(text: string): number | null {
  const clean = stripFormatting(text);
  const match = /TPS\s+from\s+last[^:]*:\s*(-?\d+(?:\.\d+)?)/i.exec(clean);
  return match ? asFinite(Number(match[1])) : null;
}

function parsePaperMspt(text: string): { mean: number | null; peak: number | null } {
  const clean = stripFormatting(text);
  const groups = [...clean.matchAll(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/g)];
  if (!groups.length) return { mean: null, peak: null };
  // Paper reports avg/min/max for 5s, 10s and 1m. Use the newest 5s bucket.
  return { mean: asFinite(Number(groups[0][1])), peak: asFinite(Number(groups[0][3])) };
}

async function readPaperCommandMetrics(world: InstanceSummary): Promise<InstanceSummary['performance']> {
  if (!world.pid) return world.performance;
  try {
    const [tpsOutput, msptOutput] = await Promise.all([
      rcon(world.id, 'tps'),
      rcon(world.id, 'mspt'),
    ]);
    const tps = parsePaperTps(tpsOutput);
    const mspt = parsePaperMspt(msptOutput);
    const values = {
      ...(tps === null ? {} : { tps }),
      ...(mspt.mean === null ? {} : { msptMean: mspt.mean }),
      ...(mspt.peak === null ? {} : { msptPeak: mspt.peak }),
    };
    if (Object.keys(values).length) {
      setRuntimePerformanceFallback(world.id, world.pid, values);
      const performance = world.performance ? { ...world.performance } : null;
      if (!performance) return null;
      return {
        ...performance,
        ...values,
        t: Date.now(),
      };
    }
  } catch (err) {
    logger.debug('Paper 内置性能命令采集失败', { id: world.id, error: String(err) });
  }
  return world.performance;
}

/** Keep on-disk history within the rolling 72-hour window, including the oldest partial hour. */
export async function prunePerformanceHistory(now = Date.now()): Promise<void> {
  if (pruning) return;
  pruning = true;
  const cutoff = now - PERFORMANCE_RETENTION_MS;
  try {
    const worlds = await fsp.readdir(HISTORY_DIR, { withFileTypes: true }).catch(() => []);
    for (const worldDir of worlds) {
      if (!worldDir.isDirectory() || !INSTANCE_ID_RE.test(worldDir.name)) continue;
      const dir = path.join(HISTORY_DIR, worldDir.name);
      const files = await fsp.readdir(dir).catch(() => []);
      for (const name of files) {
        const start = parseHourFilename(name);
        if (start === null) continue;
        const file = path.join(dir, name);
        if (start + HOUR_MS <= cutoff) {
          await fsp.unlink(file).catch(() => undefined);
        } else if (start < cutoff) {
          const raw = await fsp.readFile(file, 'utf8').catch(() => '');
          const retained: string[] = [];
          for (const line of raw.split(/\r?\n/)) {
            if (!line) continue;
            try {
              const row = JSON.parse(line) as { t?: unknown };
              if (typeof row.t === 'number' && Number.isFinite(row.t) && row.t >= cutoff && row.t <= now) retained.push(line);
            } catch {
              // Ignore an incomplete/corrupt final line and retain valid samples only.
            }
          }
          if (retained.length) {
            const temp = `${file}.${process.pid}.tmp`;
            await fsp.writeFile(temp, `${retained.join('\n')}\n`, 'utf8');
            await fsp.rename(temp, file);
          } else {
            await fsp.unlink(file).catch(() => undefined);
          }
        }
      }
      const remaining = await fsp.readdir(dir).catch(() => []);
      if (!remaining.length) await fsp.rmdir(dir).catch(() => undefined);
    }
  } catch (err) {
    logger.warn('性能历史清理失败', String(err));
  } finally {
    pruning = false;
  }
}

function compressPoints(points: PerformancePoint[]): PerformancePoint[] {
  if (points.length <= MAX_RESPONSE_POINTS) return points;
  const bucketSize = Math.ceil(points.length / MAX_RESPONSE_POINTS);
  const output: PerformancePoint[] = [];
  for (let offset = 0; offset < points.length; offset += bucketSize) {
    const bucket = points.slice(offset, offset + bucketSize);
    const values = bucket.map((point) => point.value).filter((value): value is number => value !== null);
    const from = bucket[0].from;
    const to = bucket[bucket.length - 1].to;
    if (!values.length) {
      output.push({ t: (from + to) / 2, value: null, min: null, max: null, from, to, limit: null });
    } else {
      const limits = bucket.map((point) => point.limit).filter((value): value is number => value !== null);
      output.push({
        t: (from + to) / 2,
        value: values.reduce((sum, value) => sum + value, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        from,
        to,
        limit: limits.length ? limits.reduce((sum, value) => sum + value, 0) / limits.length : null,
      });
    }
  }
  return output;
}

export async function readPerformanceHistory(
  id: string,
  metric: PerformanceMetric,
  requestedFrom: number,
  requestedTo: number,
  now = Date.now(),
): Promise<{ from: number; to: number; points: PerformancePoint[] }> {
  const from = Math.max(Math.trunc(requestedFrom), now - PERFORMANCE_RETENTION_MS);
  const to = Math.min(Math.trunc(requestedTo), now);
  if (to <= from) return { from, to, points: [] };

  const dir = worldHistoryDir(id);
  const field = PERFORMANCE_METRICS[metric].field;
  const limitField = PERFORMANCE_METRICS[metric].limitField;
  const raw: PerformancePoint[] = [];
  const files: string[] = [];
  for (let hour = hourStart(from); hour <= to; hour += HOUR_MS) {
    files.push(path.join(dir, hourFilename(hour)));
  }
  const hourlyFiles = await Promise.all(files.map((file) => fsp.readFile(file, 'utf8').catch(() => '')));
  for (const text of hourlyFiles) {
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as StoredPerformanceSample;
        if (!Number.isFinite(row.t) || row.t < from || row.t > to) continue;
        const candidate = row[field];
        const value = asFinite(typeof candidate === 'number' ? candidate : null);
        const limit = limitField ? asFinite(row[limitField]) : null;
        raw.push({ t: row.t, value, min: value, max: value, from: row.t, to: row.t, limit });
      } catch {
        // Ignore an incomplete/corrupt line.
      }
    }
  }
  raw.sort((a, b) => a.t - b.t);
  return { from, to, points: compressPoints(raw) };
}

export function startPerformanceHistory(): void {
  if (sampleTimer) return;
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  void prunePerformanceHistory();
  void collectOnce();
  sampleTimer = setInterval(() => void collectOnce(), PERFORMANCE_SAMPLE_INTERVAL_MS);
  pruneTimer = setInterval(() => void prunePerformanceHistory(), 60_000);
  sampleTimer.unref();
  pruneTimer.unref();
  logger.info('性能历史采集已启动（5 秒采样，滚动保留 3 天）');
}
