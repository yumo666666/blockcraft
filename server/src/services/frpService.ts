import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR, BIN_DIR } from '../core/paths.ts';
import { atomicWriteFileSync, readJsonSync } from '../core/fsx.ts';
import { createLogger } from '../core/logger.ts';
import { bad } from '../core/errors.ts';
import { loadConfig, saveConfig } from '../config.ts';
import type { PanelConfig } from '../types.ts';
import * as I from './instanceService.ts';
import { sleep } from './supervisor.ts';

const logger = createLogger('frp');

type ChannelName = 'panel' | 'worlds';

interface ChannelRuntime {
  name: ChannelName;
  pid: number | null;
  lastError: string | null;
  startedAt: number | null;
  lastReload: number | null;
}

const runtime: Record<ChannelName, ChannelRuntime> = {
  panel: { name: 'panel', pid: null, lastError: null, startedAt: null, lastReload: null },
  worlds: { name: 'worlds', pid: null, lastError: null, startedAt: null, lastReload: null },
};
let shuttingDown = false;

function cfgFile(name: ChannelName): string {
  return path.join(DATA_DIR, `frpc-${name}.toml`);
}
function pidFile(name: ChannelName): string {
  return path.join(DATA_DIR, `frpc-${name}.pid`);
}
function logFile(name: ChannelName): string {
  return path.join(DATA_DIR, 'logs', `frpc-${name}.log`);
}
function adminPort(name: ChannelName): number {
  const c = loadConfig().frp;
  return name === 'panel' ? c.adminPortPanel : c.adminPortWorlds;
}

// ------------------------------------------------------------------ 配置生成

function tomlString(v: string): string {
  return JSON.stringify(v);
}

function channelHeader(panel: PanelConfig, name: ChannelName): string[] {
  const f = panel.frp;
  return [
    '# 本文件由 BlockCraft 面板生成，请勿手改',
    `serverAddr = ${tomlString(f.serverAddr)}`,
    `serverPort = ${f.serverPort}`,
    'auth.method = "token"',
    `auth.token = ${tomlString(f.token)}`,
    `transport.tls.enable = ${f.tls}`,
    '',
    'webServer.addr = "127.0.0.1"',
    `webServer.port = ${adminPort(name)}`,
    `webServer.user = ${tomlString(f.adminUser)}`,
    `webServer.password = ${tomlString(f.adminPassword)}`,
    '',
  ];
}

function proxyBlock(name: string, localPort: number, remotePort: number): string[] {
  return [
    '[[proxies]]',
    `name = ${tomlString(name)}`,
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${localPort}`,
    `remotePort = ${remotePort}`,
    '',
  ];
}

/** 面板通道：只有一个代理，只有用户显式改「面板隧道」时才重写 */
export function renderPanelConfig(panel: PanelConfig, proxyName = 'panel'): string {
  const lines = channelHeader(panel, 'panel');
  if (panel.frp.exposePanel && panel.frp.enabled) {
    lines.push(...proxyBlock(proxyName, panel.panel.port, panel.frp.panelRemotePort));
  }
  return lines.join('\n');
}

/** 世界通道：所有世界代理。文件名里带上世界的「显示名」，方便在 frps 上认人 */
export function renderWorldsConfig(panel: PanelConfig, proxyNames: Record<string, string> = {}): string {
  const lines = channelHeader(panel, 'worlds');
  for (const id of I.listInstanceIds()) {
    let cfg;
    try {
      cfg = I.getConfig(id);
    } catch {
      continue;
    }
    if (!cfg.frp.enabled) continue;
    const remote = cfg.frp.remotePort;
    if (!remote) continue;
    lines.push(...proxyBlock(proxyNames[id] ?? `mc-${id}`, cfg.port, remote));
  }
  return lines.join('\n');
}

function frpClientSuffix(): string {
  const file = path.join(DATA_DIR, 'frp-client-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{8}$/.test(existing)) return existing;
  } catch {
    /* first FRP use */
  }
  const suffix = crypto.randomBytes(4).toString('hex');
  atomicWriteFileSync(file, `${suffix}\n`);
  return suffix;
}

function suffixedProxyName(base: string, suffix: string, attempt = 1): string {
  const extra = attempt === 1 ? '' : `-${attempt}`;
  const tail = `-${suffix}${extra}`;
  return `${base.slice(0, Math.max(1, 120 - tail.length))}${tail}`;
}

function isCurrentProxyName(name: string, base: string, suffix: string): boolean {
  if (name === base) return true;
  const match = name.match(/-([a-f0-9]{8})(?:-(\d+))?$/);
  if (!match || match[1] !== suffix) return false;
  const attempt = match[2] ? Number(match[2]) : 1;
  return Number.isSafeInteger(attempt) && attempt >= 1 && suffixedProxyName(base, suffix, attempt) === name;
}

/**
 * FRPS proxy names are server-wide. Keep a free legacy name when the Dashboard
 * confirms it is available; otherwise namespace it by this portable install.
 * If the Dashboard is unavailable, use the namespace by default because the
 * client has no other way to enumerate names owned by other FRPC processes.
 */
async function proxyNamesForChannel(channel: ChannelName, panel: PanelConfig): Promise<{ panelName: string; worldNames: Record<string, string> }> {
  const bases = channel === 'panel'
    ? (panel.frp.enabled && panel.frp.exposePanel ? ['panel'] : [])
    : I.listInstanceIds().flatMap((id) => {
      try {
        const cfg = I.getConfig(id);
        return cfg.frp.enabled && cfg.frp.remotePort ? [`mc-${id}`] : [];
      } catch {
        return [];
      }
    });
  if (bases.length === 0) return { panelName: 'panel', worldNames: {} };

  const [dashboard, localStatus] = await Promise.all([
    dashboardProxies(),
    apiCall(channel, '/api/status'),
  ]);
  const local = ((localStatus.data as { tcp?: { name?: string; status?: string }[] } | null)?.tcp ?? [])
    .filter((proxy) => proxy.status === 'running' && proxy.name)
    .map((proxy) => proxy.name!);
  const occupied = new Set(dashboard.available ? dashboard.proxies.map((proxy) => proxy.name) : []);
  // A proxy that is already running in this channel belongs to this BlockCraft
  // instance, even though the FRPS Dashboard also lists it.
  for (const name of local) occupied.delete(name);

  const suffix = frpClientSuffix();
  const assigned = new Map<string, string>();
  for (const base of bases) {
    const current = local.find((name) => isCurrentProxyName(name, base, suffix));
    if (current) {
      assigned.set(base, current);
      continue;
    }
    if (dashboard.available && !occupied.has(base)) {
      assigned.set(base, base);
      occupied.add(base);
      continue;
    }
    let attempt = 1;
    let candidate = suffixedProxyName(base, suffix, attempt);
    while (occupied.has(candidate)) {
      attempt += 1;
      candidate = suffixedProxyName(base, suffix, attempt);
    }
    assigned.set(base, candidate);
    occupied.add(candidate);
  }

  return {
    panelName: assigned.get('panel') ?? 'panel',
    worldNames: Object.fromEntries([...assigned.entries()].filter(([base]) => base.startsWith('mc-')).map(([base, name]) => [base.slice(3), name])),
  };
}

async function renderChannelConfig(channel: ChannelName, panel = loadConfig()): Promise<string> {
  const names = await proxyNamesForChannel(channel, panel);
  return channel === 'panel'
    ? renderPanelConfig(panel, names.panelName)
    : renderWorldsConfig(panel, names.worldNames);
}

function writeWithBackup(file: string, content: string): void {
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (cur === content) return;
    try {
      fs.copyFileSync(file, `${file}.bak.${Date.now()}`);
      // 只保留最近 5 份
      const dir = path.dirname(file);
      const base = path.basename(file);
      const baks = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(base + '.bak.'))
        .sort();
      for (const old of baks.slice(0, -5)) fs.unlinkSync(path.join(dir, old));
    } catch {
      /* ignore */
    }
  }
  atomicWriteFileSync(file, content);
}

// ------------------------------------------------------------------ 进程管理

function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAdminPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function readPid(name: ChannelName): number | null {
  const v = readJsonSync<number | null>(pidFile(name), null);
  if (typeof v === 'number' && isAlive(v)) return v;
  try {
    const raw = parseInt(fs.readFileSync(pidFile(name), 'utf8').trim(), 10);
    if (Number.isFinite(raw) && isAlive(raw)) return raw;
  } catch {
    /* ignore */
  }
  return null;
}

export function binaryPath(): string {
  const configured = loadConfig().frp.binary;
  if (configured) {
    if (process.platform === 'win32' && !fs.existsSync(configured) && fs.existsSync(`${configured}.exe`)) return `${configured}.exe`;
    return configured;
  }
  return path.join(BIN_DIR, process.platform === 'win32' ? 'frpc.exe' : 'frpc');
}

export async function downloadBinary(): Promise<string> {
  const panel = loadConfig();
  const archMap: Record<string, string> = { arm64: 'arm64', x64: 'amd64', arm: 'arm' };
  const arch = archMap[process.arch] ?? 'amd64';
  const osName = process.platform === 'win32' ? 'windows' : 'linux';
  const binaryName = process.platform === 'win32' ? 'frpc.exe' : 'frpc';
  const version = process.env.BC_FRP_VERSION || '0.68.1';
  const asset = `frp_${version}_${osName}_${arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const url = `${panel.mirrors.githubMirror}https://github.com/fatedier/frp/releases/download/v${version}/${asset}`;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const archive = path.join(BIN_DIR, asset);
  logger.info(`下载 frpc`, { url });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw bad(`下载 frpc 失败：HTTP ${res.status}`);
  const buf = Buffer.from(new Uint8Array(await res.arrayBuffer()));
  atomicWriteFileSync(archive, buf);
  const { execFileSync } = await import('node:child_process');
  if (process.platform === 'win32') {
    const quote = (value: string) => value.replaceAll("'", "''");
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${quote(archive)}' -DestinationPath '${quote(BIN_DIR)}' -Force`], { stdio: 'ignore' });
  } else {
    execFileSync('tar', ['xzf', archive, '-C', BIN_DIR]);
  }
  const dir = fs.readdirSync(BIN_DIR).find((d) => d.startsWith(`frp_${version}_${osName}`));
  if (!dir) throw bad('解压 frpc 后没有找到目录');
  const target = path.join(BIN_DIR, binaryName);
  fs.copyFileSync(path.join(BIN_DIR, dir, binaryName), target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
  fs.rmSync(path.join(BIN_DIR, dir), { recursive: true, force: true });
  fs.unlinkSync(archive);
  saveConfig({ frp: { ...panel.frp, binary: target } });
  logger.info('frpc 已就绪', { path: target });
  return target;
}

export async function startChannel(name: ChannelName, opts: { force?: boolean } = {}): Promise<void> {
  if (shuttingDown) return;
  const panel = loadConfig();
  if (!panel.frp.enabled) return;
  if (!panel.frp.serverAddr) {
    runtime[name].lastError = '还没配置 FRP 服务器地址';
    return;
  }
  // 幂等：面板重启后 frpc 可能还在跑（它是独立进程），此时不要重复拉起
  const existing = readPid(name);
  if (existing && !opts.force) {
    runtime[name].pid = existing;
    const desired = await renderChannelConfig(name, panel);
    const current = fs.existsSync(cfgFile(name)) ? fs.readFileSync(cfgFile(name), 'utf8') : '';
    if (current !== desired) {
      const reloaded = await reloadChannel(name);
      if (!reloaded.ok) logger.warn(`frpc(${name}) 检测到代理名称变化，但热重载失败`, { error: reloaded.error });
    }
    return;
  }
  if (existing && opts.force) {
    stopChannel(name);
    for (let attempt = 0; attempt < 30 && isAlive(existing); attempt += 1) await sleep(100);
    if (isAlive(existing)) throw bad(`旧 frpc(${name}) 仍在退出，暂时不能启动新通道`);
  }
  const bin = binaryPath();
  if (!fs.existsSync(bin)) {
    try {
      await downloadBinary();
    } catch (err) {
      runtime[name].lastError = `frpc 不存在且下载失败：${String(err)}`;
      logger.warn(runtime[name].lastError);
      return;
    }
  }
  const config = await renderChannelConfig(name, panel);
  // The config render above is async (Dashboard lookup); do not race a tray
  // shutdown and spawn a fresh channel after the shutdown sweep has begun.
  if (shuttingDown) return;
  writeWithBackup(cfgFile(name), config);
  fs.mkdirSync(path.dirname(logFile(name)), { recursive: true });
  const out = fs.openSync(logFile(name), 'a');
  const child = spawn(bin, ['-c', cfgFile(name)], { detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  child.unref();
  runtime[name].pid = child.pid ?? null;
  runtime[name].startedAt = Date.now();
  runtime[name].lastError = null;
  if (child.pid) atomicWriteFileSync(pidFile(name), String(child.pid));
  child.on('exit', (code) => {
    runtime[name].pid = null;
    runtime[name].lastError = `frpc(${name}) 退出，code=${code}`;
    logger.warn(runtime[name].lastError!);
  });
  await sleep(1200);
}

export function stopChannel(name: ChannelName): void {
  const pid = readPid(name) ?? runtime[name].pid;
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
  runtime[name].pid = null;
  try {
    fs.unlinkSync(pidFile(name));
  } catch {
    /* ignore */
  }
}

/** Stop both detached frpc children before the panel process exits. */
export async function stopChannelsForShutdown(): Promise<{ ok: boolean; error?: string }> {
  shuttingDown = true;
  const stopAndWait = async (name: ChannelName): Promise<string | null> => {
    const pid = readPid(name) ?? runtime[name].pid;
    logger.info(`托盘关机：请求停止 frpc(${name})`, { pid, adminPort: adminPort(name) });
    stopChannel(name);
    if (pid) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && isAlive(pid)) await sleep(100);
      if (isAlive(pid)) {
        // Keep the PID available so a later tray-close retry can signal this
        // channel again instead of losing track of a child that ignored SIGTERM.
        runtime[name].pid = pid;
        atomicWriteFileSync(pidFile(name), String(pid));
        return `frpc(${name}) PID ${pid} 在 8 秒后仍在运行`;
      }
      logger.info(`托盘关机：frpc(${name}) 进程已退出`, { pid });
    } else {
      logger.info(`托盘关机：frpc(${name}) 没有已记录的 PID，仍检查管理端口`);
    }
    const port = adminPort(name);
    if (port > 0 && await isAdminPortListening(port)) {
      return `frpc(${name}) 已${pid ? `记录的 PID ${pid} 已退出` : '没有已记录 PID'}，但本地管理端口 ${port} 仍在监听；可能还有旧版或其他 frpc 进程`;
    }
    return null;
  };

  // Close the world tunnel first; keep the panel tunnel available until the
  // world channel is confirmed stopped, then stop the panel tunnel as well.
  const worldError = await stopAndWait('worlds');
  if (worldError) {
    logger.warn(`托盘关机：世界 FRP 通道未关闭`, { error: worldError });
    shuttingDown = false;
    return { ok: false, error: worldError };
  }
  const panelError = await stopAndWait('panel');
  if (panelError) {
    logger.warn(`托盘关机：面板 FRP 通道未关闭`, { error: panelError });
    shuttingDown = false;
    const restoreError = await startChannel('worlds').then(() => null, (err) => String(err));
    return {
      ok: false,
      error: restoreError
        ? `${panelError}；恢复世界通道失败：${restoreError}`
        : `${panelError}；世界通道已尝试恢复`,
    };
  }
  logger.info('托盘关机：世界和面板 FRP 通道均已关闭');
  return { ok: true };
}

export function cancelShutdown(): void {
  shuttingDown = false;
}

/** 热重载（增量，不会拆掉已有连接）。失败时按配置决定是否回滚上一版 */
export async function reloadChannel(name: ChannelName, opts: { rollback?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  const panel = loadConfig();
  const config = await renderChannelConfig(name, panel);
  const file = cfgFile(name);
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  writeWithBackup(file, config);
  const res = await apiCall(name, '/api/reload');
  if (res.ok) {
    runtime[name].lastReload = Date.now();
    return { ok: true };
  }
  // 回滚保护：自检/重载失败就回到上一版，绝不让面板把配置改成连不回来的样子
  if (opts.rollback !== false && panel.frp.configRollback && prev !== null && prev !== config) {
    logger.warn(`frpc(${name}) reload 失败，回滚上一版配置`, { error: res.error });
    atomicWriteFileSync(file, prev);
    await apiCall(name, '/api/reload');
    return { ok: false, error: `重载失败（已回滚上一版配置）：${res.error}` };
  }
  return { ok: false, error: res.error };
}

async function apiCall(name: ChannelName, apiPath: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  const panel = loadConfig();
  const port = adminPort(name);
  const auth = Buffer.from(`${panel.frp.adminUser}:${panel.frp.adminPassword}`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Basic ${auth}` },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* 保留文本 */
    }
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ 状态

export interface ProxyStatus {
  name: string;
  status: string;
  localAddr: string;
  remoteAddr: string;
  err: string;
}

export interface FrpStatus {
  enabled: boolean;
  configured: boolean;
  /** Saved preference, independent of whether the frpc proxy is currently online. */
  exposePanel: boolean;
  panelRemotePort: number;
  binaryReady: boolean;
  channels: {
    name: ChannelName;
    running: boolean;
    pid: number | null;
    error: string | null;
    proxyCount: number;
    lastReload: number | null;
  }[];
  proxies: ProxyStatus[];
  panelProxy: { remotePort: number; localPort: number; online: boolean } | null;
  remoteRange: [number, number];
  server: { addr: string; port: number; tls: boolean; reachable: boolean; latencyMs: number | null };
  /** 服务端侧看到的（来自 frps Dashboard，可能为空） */
  dashboard: { available: boolean; proxies: { name: string; remotePort: number | null; status: string; trafficIn: number; trafficOut: number }[] };
  foreignProxies: string[];
}

let lastLatency: number | null = null;
let selfCheckInProgress = false;

async function tcpRtt(host: string, port: number, timeoutMs = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.createConnection({ host, port });
    const done = (v: number | null) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(Date.now() - t0));
    sock.once('error', () => done(null));
    sock.once('timeout', () => done(null));
  });
}

export async function dashboardProxies(): Promise<{ available: boolean; proxies: { name: string; remotePort: number | null; status: string; trafficIn: number; trafficOut: number }[] }> {
  const panel = loadConfig();
  if (!panel.frp.dashboardUrl || !panel.frp.dashboardUser) return { available: false, proxies: [] };
  try {
    const auth = Buffer.from(`${panel.frp.dashboardUser}:${panel.frp.dashboardPassword}`).toString('base64');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${panel.frp.dashboardUrl.replace(/\/$/, '')}/api/proxy/tcp`, {
      headers: { authorization: `Basic ${auth}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { available: false, proxies: [] };
    const json = (await res.json()) as { proxies?: { name: string; conf?: { remotePort?: number }; status?: string; todayTrafficIn?: number; todayTrafficOut?: number }[] };
    const proxies = (json.proxies ?? []).map((p) => ({
      name: p.name,
      remotePort: p.conf?.remotePort ?? null,
      status: p.status ?? 'unknown',
      trafficIn: p.todayTrafficIn ?? 0,
      trafficOut: p.todayTrafficOut ?? 0,
    }));
    return { available: true, proxies };
  } catch {
    return { available: false, proxies: [] };
  }
}

/** 服务端上已被占用的远端端口（含别人的）——分配端口前必须排除 */
export async function takenRemotePorts(): Promise<Set<number>> {
  const taken = new Set<number>();
  const dash = await dashboardProxies();
  for (const p of dash.proxies) {
    if (p.remotePort && p.status === 'online') taken.add(p.remotePort);
  }
  for (const id of I.listInstanceIds()) {
    try {
      const cfg = I.getConfig(id);
      if (cfg.frp.remotePort) taken.add(cfg.frp.remotePort);
    } catch {
      /* ignore */
    }
  }
  const panel = loadConfig();
  if (panel.frp.exposePanel) taken.add(panel.frp.panelRemotePort);
  return taken;
}

export async function status(): Promise<FrpStatus> {
  const panel = loadConfig();
  const channels: FrpStatus['channels'] = [];
  const proxies: ProxyStatus[] = [];
  for (const name of ['panel', 'worlds'] as ChannelName[]) {
    const st = await apiCall(name, '/api/status');
    // frpc 的 /api/status 返回的是 snake_case（local_addr / remote_addr），这里归一化，
    // 不然前端拿到的地址永远是空的。
    const raw = ((st.data as { tcp?: Record<string, unknown>[] })?.tcp ?? []) as Record<string, unknown>[];
    const list: ProxyStatus[] = raw.map((p) => ({
      name: String(p.name ?? ''),
      status: String(p.status ?? ''),
      localAddr: String(p.local_addr ?? p.localAddr ?? ''),
      remoteAddr: String(p.remote_addr ?? p.remoteAddr ?? ''),
      err: String(p.err ?? ''),
    }));
    const pid = readPid(name) ?? runtime[name].pid;
    if (st.ok) proxies.push(...list);
    channels.push({
      name,
      running: isAlive(pid),
      pid,
      error: runtime[name].lastError ?? (st.ok ? null : 'frpc 未运行或未启用'),
      proxyCount: list.length,
      lastReload: runtime[name].lastReload,
    });
  }
  const reachable = panel.frp.serverAddr ? await tcpRtt(panel.frp.serverAddr, panel.frp.serverPort) : null;
  if (reachable !== null) lastLatency = reachable;
  const panelProxy = proxies.find((p) => p.name === 'panel' || p.name.startsWith('panel-'));
  return {
    enabled: panel.frp.enabled,
    configured: Boolean(panel.frp.serverAddr),
    exposePanel: panel.frp.exposePanel,
    panelRemotePort: panel.frp.panelRemotePort,
    binaryReady: fs.existsSync(binaryPath()),
    channels,
    proxies,
    panelProxy: panelProxy
      ? { remotePort: panel.frp.panelRemotePort, localPort: panel.panel.port, online: panelProxy.status === 'running' }
      : panel.frp.exposePanel
        ? { remotePort: panel.frp.panelRemotePort, localPort: panel.panel.port, online: false }
        : null,
    remoteRange: panel.portRanges.frpRemote,
    server: {
      addr: panel.frp.serverAddr,
      port: panel.frp.serverPort,
      tls: panel.frp.tls,
      reachable: reachable !== null,
      latencyMs: reachable ?? lastLatency,
    },
    dashboard: await dashboardProxies(),
    foreignProxies: panel.frp.foreignProxies,
  };
}

// ------------------------------------------------------------------ 世界代理

/** 世界启动/停止/增删时调用：更新世界通道并热重载 */
export async function syncWorlds(): Promise<{ ok: boolean; error?: string }> {
  const panel = loadConfig();
  if (!panel.frp.enabled) return { ok: true };
  let pid = readPid('worlds') ?? runtime.worlds.pid;
  if (!isAlive(pid)) {
    await startChannel('worlds');
    pid = readPid('worlds') ?? runtime.worlds.pid;
    if (!isAlive(pid)) return { ok: false, error: '世界通道的 frpc 没有起来（检查 frpc 是否已安装、参数是否正确）' };
    return { ok: true };
  }
  return reloadChannel('worlds');
}

/** 为世界分配/刷新远端端口 */
export async function ensureRemotePort(id: string): Promise<number> {
  const panel = loadConfig();
  const cfg = I.getConfig(id);
  const taken = await takenRemotePorts();
  const { allocateRemote } = await import('./portService.ts');
  const remote = await allocateRemote(id, panel.portRanges.frpRemote, taken);
  if (cfg.frp.remotePort !== remote) I.saveConfig(id, { frp: { ...cfg.frp, remotePort: remote } });
  return remote;
}

export async function removeInstance(id: string): Promise<void> {
  const panel = loadConfig();
  if (panel.frp.enabled) await reloadChannel('worlds');
  else writeWithBackup(cfgFile('worlds'), await renderChannelConfig('worlds', panel));
}

// ------------------------------------------------------------------ 自检（数据回环）

export interface SelfCheckResult {
  ok: boolean;
  steps: { step: string; ok: boolean; detail: string }[];
  latencyMs: number | null;
  error?: string;
}

/**
 * 只测「端口能不能 connect」是无效的：服务端可能把整段端口都发布了，
 * 没有后端也能连上。必须做一次真实的数据回环。
 */
export async function selfCheck(): Promise<SelfCheckResult> {
  const panel = loadConfig();
  const steps: { step: string; ok: boolean; detail: string }[] = [];
  if (!panel.frp.serverAddr) {
    return { ok: false, steps: [{ step: '配置', ok: false, detail: '还没填 FRP 服务器地址' }], latencyMs: null, error: '未配置' };
  }
  if (selfCheckInProgress) {
    return { ok: false, steps: [{ step: '自检', ok: false, detail: '已有一次 FRP 回环检查正在运行' }], latencyMs: null, error: '自检进行中' };
  }
  selfCheckInProgress = true;
  // 1) 候选端口：取段内最后一个，尽量不占用常用端口
  const candidate = panel.portRanges.frpRemote[1];
  steps.push({ step: '选择候选端口', ok: true, detail: `使用远端端口 ${candidate}` });

  // 2) 本地 echo 服务
  const nonce = crypto.randomBytes(8).toString('hex');
  const echoSockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    echoSockets.add(sock);
    // The test client intentionally closes its socket during cleanup. FRP can
    // propagate that close as ECONNRESET; every accepted socket must consume it.
    sock.on('error', () => {});
    sock.once('close', () => echoSockets.delete(sock));
    sock.on('data', (d: Buffer) => {
      if (sock.destroyed) return;
      sock.write(Buffer.concat([Buffer.from('ECHO:'), d]), (error) => {
        if (error) sock.destroy();
      });
    });
  });
  let child: ReturnType<typeof spawn> | null = null;
  let childSpawnError: Error | null = null;
  let serverListening = false;
  const tmpCfg = path.join(DATA_DIR, `frpc-selftest-${nonce}.toml`);
  try {
    const localPort = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.on('error', (error) => logger.warn('FRP 回环 echo 服务错误', { error: String(error) }));
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        serverListening = true;
        resolve((server.address() as net.AddressInfo).port);
      });
    });
    const adminTmp = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address() as net.AddressInfo;
        probe.close((error) => error ? reject(error) : resolve(address.port));
      });
    });

    // 3) 临时 frpc 通道；name 和 admin port 都独立，避免与已有连接/并行检查冲突。
    const tmpName = `bc-selftest-${nonce}`;
    const lines = [
      `serverAddr = ${tomlString(panel.frp.serverAddr)}`,
      `serverPort = ${panel.frp.serverPort}`,
      'auth.method = "token"',
      `auth.token = ${tomlString(panel.frp.token)}`,
      `transport.tls.enable = ${panel.frp.tls}`,
      'webServer.addr = "127.0.0.1"',
      `webServer.port = ${adminTmp}`,
      ...proxyBlock(tmpName, localPort, candidate),
    ];
    atomicWriteFileSync(tmpCfg, lines.join('\n'));
    const bin = binaryPath();
    if (!fs.existsSync(bin)) throw bad('本机还没有 frpc，请先在 FRP 设置里下载');
    child = spawn(bin, ['-c', tmpCfg], { detached: true, stdio: 'ignore' });
    child.once('error', (error) => { childSpawnError = error; });
    child.unref();
    steps.push({ step: '启动临时通道', ok: true, detail: `候选端口 ${candidate} → 本地 ${localPort}` });

    // 4) 等它 online
    let online = false;
    const auth = Buffer.from(`${panel.frp.adminUser}:${panel.frp.adminPassword}`).toString('base64');
    for (let i = 0; i < 12; i++) {
      await sleep(700);
      if (childSpawnError) throw childSpawnError;
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${adminTmp}/api/status`, { headers: { authorization: `Basic ${auth}` } });
        if (!res.ok) continue;
        const json = (await res.json()) as { tcp?: { status?: string }[] };
        if (json.tcp?.[0]?.status === 'running') {
          online = true;
          break;
        }
      } catch {
        /* 继续等 */
      }
    }
    steps.push({
      step: '登录 frps 并建立代理',
      ok: online,
      detail: online ? '代理已 running' : '超时：检查 token / TLS / 远端端口是否在允许范围内',
    });
    if (!online) return { ok: false, steps, latencyMs: null, error: '临时通道没能上线' };

    // 5) 数据回环
    const rtt = await new Promise<number | null>((resolve) => {
      const t0 = Date.now();
      const sock = net.createConnection({ host: panel.frp.serverAddr, port: candidate });
      let settled = false;
      let received = '';
      const finish = (value: number | null) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(value);
      };
      sock.setTimeout(6000);
      sock.once('connect', () => sock.write(Buffer.from(`PING-${nonce}`), (error) => {
        if (error) finish(null);
      }));
      sock.on('data', (d) => {
        received += d.toString();
        if (received.includes(`ECHO:PING-${nonce}`)) finish(Date.now() - t0);
      });
      sock.once('error', () => finish(null));
      sock.once('timeout', () => finish(null));
      sock.once('close', () => finish(null));
    });
    steps.push({
      step: '公网数据回环',
      ok: rtt !== null,
      detail: rtt !== null ? `收到原样返回，RTT ${rtt}ms` : `连接 ${panel.frp.serverAddr}:${candidate} 后没有收到数据（可能服务端没发布这个端口）`,
    });
    return { ok: rtt !== null, steps, latencyMs: rtt, error: rtt === null ? '回环失败' : undefined };
  } catch (err) {
    steps.push({ step: '自检异常', ok: false, detail: String(err) });
    return { ok: false, steps, latencyMs: null, error: String(err) };
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      await Promise.race([exited, sleep(1500)]);
    }
    for (const sock of echoSockets) sock.destroy();
    if (serverListening) await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.unlinkSync(tmpCfg);
    } catch {
      /* ignore */
    }
    selfCheckInProgress = false;
  }
}

export async function startFrpService(): Promise<void> {
  const panel = loadConfig();
  if (!panel.frp.enabled || !panel.frp.serverAddr) {
    logger.info('FRP 未启用或未配置，跳过启动');
    return;
  }
  // 面板通道先起（面板自己可能正从公网连进来）
  await startChannel('panel');
  await startChannel('worlds');
  // 世界配置可能过了很久，热重载一次保证与登记表一致
  if (isAlive(readPid('worlds'))) {
    const diff = fs.existsSync(cfgFile('worlds')) && fs.readFileSync(cfgFile('worlds'), 'utf8') !== await renderChannelConfig('worlds', panel);
    if (diff) await reloadChannel('worlds');
  }
}
