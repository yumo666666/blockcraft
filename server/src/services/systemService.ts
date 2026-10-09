import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

interface WindowsProcessData {
  pid: number;
  userTicks: number;
  kernelTicks: number;
  rss: number;
  threads: number;
  commandLine: string;
  startedAt: number;
}

const windowsProcessCache = new Map<number, { at: number; value: WindowsProcessData | null }>();

/** Read Windows process counters from Get-Process; CIM is used only for its command line. */
function windowsProcess(pid: number): WindowsProcessData | null {
  const cached = windowsProcessCache.get(pid);
  if (cached && Date.now() - cached.at < 500) return cached.value;
  try {
    const safePid = Math.trunc(pid);
    const script = `$p=Get-Process -Id ${safePid} -ErrorAction Stop; $started=''; try {$started=$p.StartTime.ToUniversalTime().ToString('o')} catch {}; [PSCustomObject]@{pid=[int]$p.Id;userTicks=[double]$p.TotalProcessorTime.Ticks;kernelTicks=0.0;rss=[double]$p.WorkingSet64;threads=[int]$p.Threads.Count;commandLine='';startedAt=$started} | ConvertTo-Json -Compress`;
    const raw = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const value = JSON.parse(raw) as Omit<WindowsProcessData, 'startedAt'> & { startedAt: string };
    const result: WindowsProcessData = { ...value, startedAt: Date.parse(value.startedAt) };
    windowsProcessCache.set(pid, { at: Date.now(), value: result });
    return result;
  } catch {
    windowsProcessCache.set(pid, { at: Date.now(), value: null });
    return null;
  }
}

function readProcStat(pid: number): ProcessStat | null {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // comm may contain spaces and parentheses, so fields begin after the final ')'.
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const rest = raw.slice(close + 2).trim().split(/\s+/);
  const state = rest[0] ?? '?';
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const threads = Number(rest[17]);
  const startTicks = Number(rest[19]);
  let rss = 0;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    rss = Number(status.match(/VmRSS:\s+(\d+) kB/)?.[1] ?? 0) * 1024;
  } catch {
    /* The process can exit between the two reads. */
  }
  const ticks = utime + stime;
  const now = Date.now();
  const p = prev.get(pid);
  const cpu = p && now > p.at ? ((ticks - p.ticks) / HZ / ((now - p.at) / 1000)) * 100 : 0;
  prev.set(pid, { ticks, at: now });
  const startedAt = (Date.now() / 1000 - os.uptime()) + startTicks / HZ;
  return { pid, cpu: +Math.max(0, cpu).toFixed(1), rss, threads, state, uptime: Math.max(0, Date.now() / 1000 - startedAt) };
}

export function processStat(pid: number): ProcessStat | null {
  if (process.platform !== 'win32') return readProcStat(pid);
  const p = windowsProcess(pid);
  if (!p) return null;
  const ticks = p.userTicks + p.kernelTicks;
  const now = Date.now();
  const previous = prev.get(pid);
  // Win32_Process reports CPU time in 100 ns units, matching the Linux per-core percentage scale.
  const cpu = previous && now > previous.at ? ((ticks - previous.ticks) / 10_000_000 / ((now - previous.at) / 1000)) * 100 : 0;
  prev.set(pid, { ticks, at: now });
  return {
    pid,
    cpu: +Math.max(0, cpu).toFixed(1),
    rss: p.rss,
    threads: p.threads,
    state: 'R',
    uptime: Number.isFinite(p.startedAt) ? Math.max(0, (now - p.startedAt) / 1000) : 0,
  };
}

export function processCommandLine(pid: number): string | null {
  if (process.platform === 'win32') {
    try {
      const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Math.trunc(pid)}' -ErrorAction Stop; if ($null -ne $p) {[string]$p.CommandLine}`;
      const text = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return text || null;
    } catch {
      return null;
    }
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
  } catch {
    return null;
  }
}

export interface MemoryInfo {
  totalMb: number;
  usedMb: number;
  availableMb: number;
  freeMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
  swapAvailable: boolean;
  loadAvgAvailable: boolean;
  loadAvg: number | null;
}

/** Prefer portable Node system APIs, with Linux cgroup and procfs data when it is available. */
export function cpuCount(): number {
  try {
    const n = os.availableParallelism();
    if (n > 0) return n;
  } catch {
    /* Older runtimes may not implement availableParallelism. */
  }
  return Math.max(1, os.cpus().length);
}

let previousCpu: { total: number; idle: number } | null = null;
function systemCpuPercent(): number | null {
  const cpus = os.cpus();
  if (!cpus.length) return null;
  const current = cpus.reduce(
    (sum, cpu) => {
      for (const value of Object.values(cpu.times)) sum.total += value;
      sum.idle += cpu.times.idle;
      return sum;
    },
    { total: 0, idle: 0 },
  );
  const before = previousCpu;
  previousCpu = current;
  if (!before || current.total <= before.total) return null;
  return +Math.max(0, Math.min(100, ((current.total - before.total - (current.idle - before.idle)) / (current.total - before.total)) * 100)).toFixed(1);
}

export function memoryInfo(): MemoryInfo {
  let totalBytes = os.totalmem();
  let availableBytes = os.freemem();
  let freeBytes = availableBytes;
  let swapTotalMb = 0;
  let swapUsedMb = 0;
  let swapAvailable = false;

  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const getKb = (key: string) => Number(raw.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1] ?? 0) * 1024;
    totalBytes = getKb('MemTotal') || totalBytes;
    freeBytes = getKb('MemFree') || freeBytes;
    availableBytes = getKb('MemAvailable') || freeBytes;
    const swapTotalBytes = getKb('SwapTotal');
    const swapFreeBytes = getKb('SwapFree');
    swapTotalMb = Math.round(swapTotalBytes / 1024 ** 2);
    swapUsedMb = Math.max(0, Math.round((swapTotalBytes - swapFreeBytes) / 1024 ** 2));
    swapAvailable = true;
  } catch {
    /* Windows and restricted containers use the portable Node values above. */
  }

  // Docker and other Linux cgroup v2 containers should report their own memory limit.
  try {
    const limitText = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    const usedText = fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim();
    if (limitText !== 'max') {
      const limit = Number(limitText);
      const used = Number(usedText);
      if (Number.isFinite(limit) && limit > 0 && limit < totalBytes && Number.isFinite(used)) {
        totalBytes = limit;
        availableBytes = Math.max(0, limit - used);
        freeBytes = availableBytes;
      }
    }
  } catch {
    /* cgroups are optional. */
  }

  const totalMb = Math.round(totalBytes / 1024 ** 2);
  const availableMb = Math.round(availableBytes / 1024 ** 2);
  let loadAvg: number | null = null;
  let loadAvgAvailable = false;
  try {
    if (process.platform !== 'win32') {
      loadAvg = os.loadavg()[0];
      loadAvgAvailable = Number.isFinite(loadAvg);
    }
  } catch {
    /* Windows does not provide load averages. */
  }

  return {
    totalMb,
    usedMb: Math.max(0, totalMb - availableMb),
    availableMb,
    freeMb: Math.round(freeBytes / 1024 ** 2),
    swapTotalMb,
    swapUsedMb,
    swapAvailable,
    loadAvgAvailable,
    loadAvg: loadAvgAvailable ? loadAvg : null,
  };
}

export interface DiskInfo {
  totalGb: number;
  freeGb: number;
  usedGb: number;
}

const diskCache = new Map<string, { at: number; value: DiskInfo }>();
export function diskInfo(dir: string): DiskInfo {
  const key = path.resolve(dir);
  const hit = diskCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.value;
  try {
    const st = fs.statfsSync(dir);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    const value = { totalGb: +(total / 1024 ** 3).toFixed(1), freeGb: +(free / 1024 ** 3).toFixed(1), usedGb: +((total - free) / 1024 ** 3).toFixed(1) };
    diskCache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    if (process.platform === 'win32') {
      try {
        const drive = path.parse(key).root.replaceAll('\\', '').replaceAll("'", "''");
        const script = `Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='${drive}'\" | Select-Object Size,FreeSpace | ConvertTo-Json -Compress`;
        const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const item = JSON.parse(raw) as { Size?: number; FreeSpace?: number };
        const total = Number(item.Size ?? 0);
        const free = Number(item.FreeSpace ?? 0);
        if (total > 0) {
          const value = { totalGb: +(total / 1024 ** 3).toFixed(1), freeGb: +(free / 1024 ** 3).toFixed(1), usedGb: +((total - free) / 1024 ** 3).toFixed(1) };
          diskCache.set(key, { at: Date.now(), value });
          return value;
        }
      } catch {
        /* Return unavailable values below. */
      }
    }
    const value = { totalGb: 0, freeGb: 0, usedGb: 0 };
    diskCache.set(key, { at: Date.now(), value });
    return value;
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
    for (const a of addrs ?? []) out.push({ name, address: a.address, family: a.family as 'IPv4' | 'IPv6', internal: a.internal });
  }
  return out;
}

/** LAN/VPN connection addresses. Windows adapter names are not standardized, so unknown adapters keep their OS name. */
export function connectionAddresses(panelPort: number): { label: string; value: string; kind: string }[] {
  const out: { label: string; value: string; kind: string }[] = [];
  for (const i of networkInterfaces()) {
    if (i.family !== 'IPv4' || i.internal) continue;
    const isTun = /^tun|^wg|^ppp/i.test(i.name);
    const isWlan = /^wlan|^wlp|^eth|^en|^wi-fi|^ethernet/i.test(i.name);
    out.push({ label: isWlan ? `${i.name}（局域网）` : isTun ? `${i.name}（VPN）` : i.name, value: `http://${i.address}:${panelPort}`, kind: isWlan ? 'lan' : isTun ? 'vpn' : 'other' });
  }
  out.sort((a, b) => (a.kind === 'lan' ? -1 : b.kind === 'lan' ? 1 : 0));
  return out;
}

export interface SystemSnapshot {
  memory: MemoryInfo;
  disk: DiskInfo;
  panel: { pid: number; rss: number; cpu: number; uptime: number };
  cpuCount: number;
  cpuPercent: number | null;
  platform: string;
  arch: string;
  hostname: string;
}

let lastPanelCpu = 0;
export async function systemSnapshot(_panelPort: number, dir: string): Promise<SystemSnapshot> {
  const self = processStat(process.pid);
  if (self) lastPanelCpu = self.cpu;
  return {
    memory: memoryInfo(),
    disk: diskInfo(dir),
    panel: { pid: process.pid, rss: self?.rss ?? process.memoryUsage().rss, cpu: lastPanelCpu, uptime: self?.uptime ?? os.uptime() },
    cpuCount: cpuCount(),
    cpuPercent: systemCpuPercent(),
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
  };
}
