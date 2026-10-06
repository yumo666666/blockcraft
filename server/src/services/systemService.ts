import fs from 'node:fs';
import os from 'node:os';
import { getDeviceInfo, type DeviceInfo } from '../core/dsha.ts';

export interface ProcessStat {
  pid: number;
  cpu: number;
  rss: number;
  threads: number;
  state: string;
  uptime: number;
}

const prev = new Map<number, { ticks: number; at: number }>();
const HZ = 100; // Linux USER_HZ

function readProcStat(pid: number): ProcessStat | null {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // comm 里可能有空格与括号，取最后一个 ')' 之后才是字段
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const rest = raw.slice(close + 2).split(' ');
  const state = rest[0];
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const threads = Number(rest[17]);
  const startTicks = Number(rest[19]);
  let rss = 0;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    rss = Number(status.match(/VmRSS:\s+(\d+) kB/)?.[1] ?? 0) * 1024;
  } catch {
    /* ignore */
  }
  const ticks = utime + stime;
  const now = Date.now();
  const p = prev.get(pid);
  let cpu = 0;
  if (p && now > p.at) {
    cpu = ((ticks - p.ticks) / HZ / ((now - p.at) / 1000)) * 100;
  }
  prev.set(pid, { ticks, at: now });
  const bootTime = Date.now() / 1000 - os.uptime();
  const startedAt = bootTime + startTicks / HZ;
  return { pid, cpu: +Math.max(0, cpu).toFixed(1), rss, threads, state, uptime: Math.max(0, Date.now() / 1000 - startedAt) };
}

export function processStat(pid: number): ProcessStat | null {
  return readProcStat(pid);
}

export interface MemoryInfo {
  totalMb: number;
  usedMb: number;
  availableMb: number;
  freeMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
  /** 这台机器的 /proc/stat 是否可读（Android 上常被 SELinux 拦） */
  loadAvgAvailable: boolean;
  loadAvg: number | null;
}

export function memoryInfo(): MemoryInfo {
  const out: MemoryInfo = {
    totalMb: 0,
    usedMb: 0,
    availableMb: 0,
    freeMb: 0,
    swapTotalMb: 0,
    swapUsedMb: 0,
    loadAvgAvailable: false,
    loadAvg: null,
  };
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k: string) => Number(raw.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'))?.[1] ?? 0) / 1024;
    out.totalMb = Math.round(get('MemTotal'));
    out.freeMb = Math.round(get('MemFree'));
    out.availableMb = Math.round(get('MemAvailable'));
    out.swapTotalMb = Math.round(get('SwapTotal'));
    out.swapUsedMb = Math.round(get('SwapTotal') - get('SwapFree'));
    out.usedMb = out.totalMb - out.availableMb;
  } catch {
    /* ignore */
  }
  try {
    out.loadAvg = os.loadavg()[0];
    out.loadAvgAvailable = true;
  } catch {
    out.loadAvgAvailable = false;
  }
  return out;
}

export interface DiskInfo {
  totalGb: number;
  freeGb: number;
  usedGb: number;
}

export function diskInfo(dir: string): DiskInfo {
  try {
    const st = fs.statfsSync(dir);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return {
      totalGb: +(total / 1024 ** 3).toFixed(1),
      freeGb: +(free / 1024 ** 3).toFixed(1),
      usedGb: +((total - free) / 1024 ** 3).toFixed(1),
    };
  } catch {
    return { totalGb: 0, freeGb: 0, usedGb: 0 };
  }
}

export interface NetInterface {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  internal: boolean;
}

export function networkInterfaces(): NetInterface[] {
  const out: NetInterface[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      out.push({ name, address: a.address, family: a.family as 'IPv4' | 'IPv6', internal: a.internal });
    }
  }
  return out;
}

/** 局域网/公网连接地址建议：优先 wlan/eth 的 IPv4，其次 tun（VPN） */
export function connectionAddresses(panelPort: number): { label: string; value: string; kind: string }[] {
  const out: { label: string; value: string; kind: string }[] = [];
  for (const i of networkInterfaces()) {
    if (i.family !== 'IPv4' || i.internal) continue;
    const isTun = /^tun|^wg|^ppp/.test(i.name);
    const isWlan = /^wlan|^wlp|^eth|^en/.test(i.name);
    out.push({
      label: isWlan ? `${i.name}（局域网）` : isTun ? `${i.name}（VPN）` : i.name,
      value: `http://${i.address}:${panelPort}`,
      kind: isWlan ? 'lan' : isTun ? 'vpn' : 'other',
    });
  }
  out.sort((a, b) => (a.kind === 'lan' ? -1 : b.kind === 'lan' ? 1 : 0));
  return out;
}

export interface SystemSnapshot {
  device: DeviceInfo | null;
  memory: MemoryInfo;
  disk: DiskInfo;
  panel: { pid: number; rss: number; cpu: number; uptime: number };
  cpuCount: number;
  platform: string;
  arch: string;
  hostname: string;
}

let lastPanelCpu = 0;
export async function systemSnapshot(panelPort: number, dir: string): Promise<SystemSnapshot> {
  const self = readProcStat(process.pid);
  if (self) lastPanelCpu = self.cpu;
  return {
    device: await getDeviceInfo(),
    memory: memoryInfo(),
    disk: diskInfo(dir),
    panel: { pid: process.pid, rss: self?.rss ?? 0, cpu: lastPanelCpu, uptime: self?.uptime ?? 0 },
    cpuCount: os.cpus().length,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
  };
}
