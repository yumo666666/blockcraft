import type { PerformanceMetric } from './types.ts';

export const PERFORMANCE_METRICS: Record<PerformanceMetric, {
  title: string;
  unit: string;
  description: string;
  source: string;
}> = {
  cpu: {
    title: 'CPU 使用率',
    unit: '%',
    description: '服务端 Java 进程消耗的 CPU 时间，按单核 100% 计算；多核进程可能超过 100%。这不是整台主机的总 CPU 使用率。',
    source: '操作系统进程计数器',
  },
  memory: {
    title: '进程内存',
    unit: 'MB',
    description: '服务端 Java 进程驻留在物理内存中的大小（RSS / Working Set），包含 Java 堆和 JVM 原生内存，不等于 Xmx 堆上限。',
    source: '操作系统进程计数器',
  },
  players: {
    title: '在线玩家',
    unit: '人',
    description: 'Minecraft 状态协议报告的当前在线玩家数。状态查询关闭或暂时无法响应时，该时段会显示为缺失数据，不会记成 0 人。',
    source: 'Minecraft Java 状态协议',
  },
  latency: {
    title: '状态探测耗时',
    unit: 'ms',
    description: '面板所在主机连接游戏端口并收到状态响应所花的时间。它不代表每位玩家的公网 Ping；状态协议不可用时不会产生数据。',
    source: 'Minecraft Java 状态协议',
  },
  threads: {
    title: '进程线程数',
    unit: '个',
    description: '服务端 Java 进程当前线程总数，包括游戏、区块工作线程、网络和 JVM 垃圾回收线程。它用于观察线程规模变化，不直接等同于 CPU 使用率。',
    source: '操作系统进程计数器',
  },
  storage: {
    title: '实例目录占用',
    unit: 'MB',
    description: 'BlockCraft 实例目录的磁盘占用，包含服务端文件、配置和备份等。它主要用于观察容量变化，不是磁盘读写速度。目录大小约每分钟刷新一次。',
    source: '实例目录扫描缓存',
  },
  tps: {
    title: 'TPS', unit: 'TPS',
    description: '服务端最近 5 秒的每秒游戏刻数。Minecraft 常规目标是 20 TPS；持续低于 20 通常表示服务器处理速度跟不上。',
    source: 'Spark 服务端统计 API（5 秒窗口）',
  },
  msptMean: {
    title: '平均 MSPT', unit: 'ms',
    description: '最近 10 秒内每个游戏刻的平均处理时间。20 TPS 对应每刻约 50 ms 的预算；持续超过 50 ms 时，服务器无法稳定处理每秒 20 刻。',
    source: 'Spark 服务端统计 API（10 秒窗口）',
  },
  msptP95: {
    title: 'MSPT P95', unit: 'ms',
    description: '最近 10 秒内 95% 的游戏刻处理时间不高于该值。它能显示多数刻是否稳定，避免平均值掩盖较慢的刻。',
    source: 'Spark 服务端统计 API（10 秒窗口）',
  },
  msptPeak: {
    title: 'MSPT 峰值', unit: 'ms',
    description: '最近 10 秒观测到的最长单刻处理时间。单次尖峰不一定代表持续卡顿，应结合平均值和 P95 一起看。',
    source: 'Spark 服务端统计 API（10 秒窗口）',
  },
  heapUsed: {
    title: 'Java 堆内存', unit: 'MB',
    description: 'JVM 当前 Java 堆已用内存，图中的虚线和“已用 / 上限”数字表示该进程的最大堆容量。高占用本身不等于故障，需结合 GC 停顿和内存是否持续逼近上限判断。',
    source: 'Java ManagementFactory（JMX）',
  },
  gcCount: {
    title: 'GC 次数', unit: '次/分',
    description: '过去 60 秒 JVM 垃圾回收器完成的回收次数。数值突然升高可结合 GC 停顿和堆内存曲线判断是否频繁回收。',
    source: 'Java GarbageCollectorMXBean（滚动 60 秒）',
  },
  gcPause: {
    title: 'GC 停顿时间', unit: 'ms/分',
    description: '过去 60 秒各垃圾回收器报告的累计回收耗时。它是 GC 总耗时，不等于单次最长暂停；JVM 以毫秒为精度报告。',
    source: 'Java GarbageCollectorMXBean（滚动 60 秒）',
  },
  pingMedian: {
    title: '玩家 Ping 中位数', unit: 'ms',
    description: 'Spark 统计的在线玩家往返延迟中位数，约一半样本不高于此值。只有服务器已采到玩家 Ping 时才有数据。',
    source: 'Spark 玩家 Ping 统计（15 分钟窗口）',
  },
  pingP95: {
    title: '玩家 Ping P95', unit: 'ms',
    description: 'Spark 玩家 Ping 样本的第 95 百分位，反映较高延迟玩家的体验。它只统计已连接玩家，并非面板主机到游戏端口的探测时间。',
    source: 'Spark 玩家 Ping 统计（15 分钟窗口）',
  },
  networkRx: {
    title: '主机网络接收', unit: 'MB/s',
    description: 'Spark 统计的主机网卡接收速率，汇总可用网络接口，包含同一主机上的其他程序流量，不代表单个 Minecraft 进程的精确流量。',
    source: 'Spark 主机网卡统计（多接口合计）',
  },
  networkTx: {
    title: '主机网络发送', unit: 'MB/s',
    description: 'Spark 统计的主机网卡发送速率，汇总可用网络接口，包含同一主机上的其他程序流量，不代表单个 Minecraft 进程的精确流量。',
    source: 'Spark 主机网卡统计（多接口合计）',
  },
  chunks: {
    title: '已加载区块', unit: '个',
    description: 'Spark 从当前已加载世界的区块信息汇总出的区块数。它会按世界采集，采样频率低于 JVM 指标；模组或服务端未提供世界统计时显示暂无数据。',
    source: 'Spark 世界统计 API',
  },
  entities: {
    title: '已加载实体', unit: '个',
    description: 'Spark 当前已加载世界里的实体总数，包括生物、物品等实体类别。它不等于在线玩家数；服务端未提供世界统计时显示暂无数据。',
    source: 'Spark 世界统计 API',
  },
};

export type PerformanceRange = '1h' | '3h' | 'today' | '3d';

export interface PerformanceHistoryResponse {
  world: { id: string; name: string; maxPlayers: number };
  metric: { key: PerformanceMetric; title: string; unit: string; description: string; source: string };
  from: number;
  to: number;
  sampleIntervalMs: number;
  retentionMs: number;
  maxPoints: number;
  points: { t: number; value: number | null; min: number | null; max: number | null; from: number; to: number; limit: number | null }[];
}

export function performanceRangeBounds(range: PerformanceRange, now = Date.now()): { from: number; to: number } {
  if (range === '1h') return { from: now - 60 * 60 * 1000, to: now };
  if (range === '3h') return { from: now - 3 * 60 * 60 * 1000, to: now };
  if (range === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { from: start.getTime(), to: now };
  }
  return { from: now - 3 * 24 * 60 * 60 * 1000, to: now };
}

export function formatMetricValue(value: number | null | undefined, metric: PerformanceMetric, unit?: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '暂无数据';
  if (metric === 'storage') return `${value.toFixed(value < 10 ? 2 : 1)} ${unit || 'MB'}`;
  if (metric === 'cpu') return `${value.toFixed(value < 10 ? 1 : 0)} ${unit || '%'}`;
  if (metric === 'players' || metric === 'threads' || metric === 'gcCount' || metric === 'chunks' || metric === 'entities') return `${Math.round(value)} ${unit || ''}`.trim();
  if (metric === 'tps') return `${value.toFixed(1)} ${unit || 'TPS'}`.trim();
  if (metric === 'networkRx' || metric === 'networkTx') return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ${unit || 'MB/s'}`.trim();
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit || ''}`.trim();
}
