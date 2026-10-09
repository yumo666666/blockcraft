import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { instanceDir, instanceServerDir, LOG_DIR } from '../core/paths.ts';
import { atomicWriteFileSync } from '../core/fsx.ts';
import { busy, conflict, notFound } from '../core/errors.ts';
import { createLogger } from '../core/logger.ts';
import { withLock } from '../core/lock.ts';
import { detectFailure, detectPhase, planLaunch, stripAnsi, validateInstall, writeJvmArgsFile } from '../launcher/index.ts';
import { ensureSkinSupport } from './skinSupportService.ts';
import { processCommandLine, processStat } from './systemService.ts';
import { latestCrashReport } from '../core/crashReport.ts';
import { evCrash, evReady, evStart, evStop } from './eventLog.ts';
import { pingServer } from '../core/mcping.ts';
import * as systemService from './systemService.ts';
import { ensureJava, inspectJava, selectCompatibleJava } from './javaService.ts';
import * as frp from './frpService.ts';
import * as I from './instanceService.ts';
import type { InstanceConfig, InstanceState, InstanceStatus } from '../types.ts';

const logger = createLogger('supervisor');

// ------------------------------------------------------------------ 控制台环形缓冲

export interface ConsoleLine {
  seq: number;
  ts: number;
  text: string;
}

class ConsoleBuffer extends EventEmitter {
  lines: ConsoleLine[] = [];
  seq = 0;
  instanceId: string;
  private file: fs.WriteStream | null = null;

  constructor(instanceId: string) {
    super();
    this.instanceId = instanceId;
    this.setMaxListeners(50);
  }

  push(raw: string): void {
    const text = stripAnsi(raw).replace(/\s+$/, '');
    if (!text) return;
    const line: ConsoleLine = { seq: ++this.seq, ts: Date.now(), text };
    this.lines.push(line);
    if (this.lines.length > 5000) this.lines.splice(0, this.lines.length - 5000);
    this.emit('line', line);
    this.writeFile(text);
  }

  private writeFile(text: string): void {
    try {
      if (!this.file) {
        const dir = path.join(instanceDir(this.instanceId), 'logs');
        fs.mkdirSync(dir, { recursive: true });
        this.file = fs.createWriteStream(path.join(dir, 'console.log'), { flags: 'a' });
      }
      this.file.write(text + '\n');
    } catch {
      /* ignore */
    }
  }

  since(seq: number): ConsoleLine[] {
    return this.lines.filter((l) => l.seq > seq);
  }

  /**
   * 面板重启后把磁盘上的历史读回环形缓冲。
   * 不做这一步的话：世界其实早就 Done 了，但内存里没有任何日志，
   * detectPhase() 只能保守报「启动中」—— 实测就是这么来的（世界起了 11 分钟还显示启动中），
   * 而且「优雅停止」在等一条永远等不到的 "Saved the game"。
   */
  loadHistory(rawLines: string[]): void {
    for (const raw of rawLines) {
      const text = stripAnsi(raw).replace(/\s+$/, '');
      if (!text) continue;
      this.lines.push({ seq: ++this.seq, ts: Date.now(), text });
    }
    if (this.lines.length > 5000) this.lines.splice(0, this.lines.length - 5000);
  }

  tail(n = 300): ConsoleLine[] {
    return this.lines.slice(-n);
  }

  text(): string {
    return this.lines.map((l) => l.text).join('\n');
  }

  textSince(seq: number): string {
    return this.lines.filter((line) => line.seq > seq).map((line) => line.text).join('\n');
  }
}

const buffers = new Map<string, ConsoleBuffer>();
export function console_(id: string): ConsoleBuffer {
  let b = buffers.get(id);
  if (!b) {
    b = new ConsoleBuffer(id);
    buffers.set(id, b);
  }
  return b;
}

// ------------------------------------------------------------------ RCON

export class RconClient {
  private id = 0;
  private host: string;
  private port: number;
  private password: string;
  private timeoutMs: number;
  constructor(host: string, port: number, password: string, timeoutMs = 8000) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.timeoutMs = timeoutMs;
  }

  private packet(id: number, type: number, body: string): Buffer {
    const payload = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(payload.length + 14);
    buf.writeInt32LE(payload.length + 10, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    payload.copy(buf, 12);
    buf.writeInt16LE(0, payload.length + 12);
    return buf;
  }

  /**
   * 读一个完整的 RCON 包。
   * 原来的写法在「包被 TCP 分片」和「首片不足 4 字节」两种情况下会丢数据、把长度读歪，
   * 表现为偶发的 "RCON 超时"（实测：连续两条命令，第二条就挂了）。
   * 改成先累积、够一个完整包再解析。
   */
  private read(sock: net.Socket): Promise<{ id: number; type: number; body: string }> {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 4) return;
        const size = buf.readInt32LE(0);
        if (size < 10 || buf.length < 4 + size) return;
        const packet = buf.subarray(4, 4 + size);
        cleanup();
        resolve({
          id: packet.readInt32LE(0),
          type: packet.readInt32LE(4),
          body: packet.subarray(8, packet.length - 2).toString('utf8'),
        });
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onTimeout = () => {
        cleanup();
        reject(new Error('RCON 超时'));
      };
      const cleanup = () => {
        sock.off('data', onData);
        sock.off('error', onError);
        sock.off('timeout', onTimeout);
      };
      sock.on('data', onData);
      sock.once('error', onError);
      sock.once('timeout', onTimeout);
    });
  }

  private connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      sock.setTimeout(this.timeoutMs);
      sock.once('connect', () => resolve(sock));
      sock.once('error', reject);
      sock.once('timeout', () => {
        sock.destroy();
        reject(new Error('RCON 连接超时'));
      });
    });
  }

  async command(cmd: string): Promise<string> {
    const sock = await this.connect();
    try {
      const authId = ++this.id;
      sock.write(this.packet(authId, 3, this.password));
      const auth = await this.read(sock);
      if (auth.id === -1) throw new Error('RCON 密码错误');
      const cmdId = ++this.id;
      sock.write(this.packet(cmdId, 2, cmd));
      const res = await this.read(sock);
      return res.body;
    } finally {
      sock.destroy();
    }
  }
}

function rconFor(cfg: InstanceConfig): RconClient {
  return new RconClient('127.0.0.1', cfg.rconPort, cfg.rconPassword);
}

export async function rcon(id: string, cmd: string): Promise<string> {
  return rconFor(I.getConfig(id)).command(cmd);
}

// ------------------------------------------------------------------ 进程管理

interface RunningProc {
  child: ChildProcess;
  pid: number;
  startedAt: number;
  logSeqAtStart: number;
  intentional: boolean;
}

const procs = new Map<string, RunningProc>();
const javaPreparing = new Map<string, string>();
let panelShutdownRequested = false;

export function beginPanelShutdown(): boolean {
  if (panelShutdownRequested) return false;
  panelShutdownRequested = true;
  return true;
}

export function cancelPanelShutdown(): void {
  panelShutdownRequested = false;
}

export function isPanelShutdownRequested(): boolean {
  return panelShutdownRequested;
}

export function isTrackedChildAlive(tracked: Pick<RunningProc, 'child' | 'pid'> | undefined, pid: number): boolean {
  return Boolean(tracked && tracked.pid === pid && tracked.child.exitCode === null && tracked.child.signalCode === null);
}

function pidFile(id: string): string {
  return path.join(instanceDir(id), 'server.pid');
}
function intentFile(id: string): string {
  return path.join(instanceDir(id), '.stop-intent');
}

function readPidFile(id: string): number | null {
  try {
    const v = parseInt(fs.readFileSync(pidFile(id), 'utf8').trim(), 10);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // kill(pid, 0) also succeeds for a Linux zombie; it has exited and cannot be stopped again.
  if (process.platform === 'linux') {
    const stat = processStat(pid);
    return stat !== null && stat.state !== 'Z' && stat.state !== 'X';
  }
  return true;
}

export function alivePid(id: string): number | null {
  const tracked = procs.get(id);
  const fromMap = tracked?.pid;
  const pid = fromMap ?? readPidFile(id);
  if (!pid) return null;
  // 该进程由当前面板直接创建，PID 已确定；Windows 进程信息查询偶发失败时，
  // 不能因此把世界误判为停止并拒绝命令。面板重启后只剩 PID 文件时仍需检查命令行，避免 PID 复用。
  if (isTrackedChildAlive(tracked, pid)) return pid;
  if (!isAlive(pid)) return null;
  // 校验 cmdline 里确实是我们的服务端，避免 PID 复用误判
  try {
    const cmd = processCommandLine(pid) ?? '';
    if (!/java/.test(cmd) || !/(nogui|unix_args)/.test(cmd)) return null;
  } catch {
    return null;
  }
  return pid;
}

/**
 * Stop/exit decisions must account for worlds the panel cannot identify by
 * command line after a restart. A live PID file or an occupied Minecraft port
 * is enough evidence to keep the panel alive until that world is resolved.
 */
export async function hasActiveProcessEvidence(id: string): Promise<boolean> {
  const cfg = I.getConfig(id);
  if (alivePid(id)) return true;
  const pid = readPidFile(id);
  if (pid && isAlive(pid)) return true;
  return portOpen(cfg.port, '127.0.0.1', 500);
}

function portOpen(port: number, host = '127.0.0.1', timeout = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

export interface StatusSnapshot {
  status: InstanceStatus;
  pid: number | null;
  listening: boolean;
  phase: string;
  progress: string | null;
  players: number;
  uptime: number;
  cpu: number;
  rss: number;
  detectedFrom: 'memory' | 'disk';
}

/** 协议探测出来的在线人数缓存：概览每几秒就会问一次，不能每次都去连 */
const playerCountCache = new Map<string, { at: number; value: number }>();

async function livePlayerCount(id: string, host: string, port: number, fallback: number): Promise<number> {
  const hit = playerCountCache.get(id);
  if (hit && Date.now() - hit.at < 5000) return hit.value;
  const r = await pingServer(host, port, 2500);
  // 探不到就沿用上一次/状态里的值，别把界面刷成 0
  const value = r ? r.online : fallback;
  playerCountCache.set(id, { at: Date.now(), value });
  return value;
}

export async function statusOf(id: string): Promise<StatusSnapshot> {
  const cfg = I.getConfig(id);
  const st = I.getState(id);
  const pid = alivePid(id);
  const listening = pid ? await portOpen(cfg.port) : false;
  let phase = st.phase;
  let progress = st.progress;
  let status: InstanceStatus = pid ? 'starting' : 'stopped';

  if (pid) {
    const runningProc = procs.get(id);
    const logText = runningProc ? console_(id).textSince(runningProc.logSeqAtStart) : console_(id).text();
    const { status: logStatus, progress: p } = detectPhase(logText);
    progress = p;
    // An old "Done" line can remain in the current log window after stop was
    // requested. The persisted stop intent is authoritative until the process exits.
    if (st.status === 'stopping') {
      status = 'stopping';
      phase = '正在保存并关闭';
    } else if (logStatus === 'running') {
      status = 'running';
      phase = '服务端已就绪';
    } else if (logStatus === 'stopping') {
      status = 'stopping';
      phase = '正在关闭';
    } else if (st.status === 'running') {
      /*
       * 日志窗口（最后 64KB）里已经没有 "Done" 那行，但这个世界的状态早就是运行中。
       * 以前这里会直接降级成「启动中」—— 世界跑一两个小时后日志涨过 64KB，
       * 面板就一直显示「启动中」，与实际完全不符。进程还活着时，保留已判定的运行中。
       */
      status = 'running';
      phase = '服务端已就绪';
    } else {
      status = 'starting';
      phase = p ? `正在生成世界 ${p.replace('Preparing spawn area:', '').trim()}` : '正在启动';
    }
    // 进程在、日志无进展、端口不通 —— 判定卡住
    const proc = processStat(pid);
    if (status !== 'stopping' && !listening && st.startedAt && Date.now() / 1000 - st.startedAt > 180 && logStatus === 'starting') {
      status = 'stuck';
      phase = '启动了 3 分钟仍未监听端口，可能卡住了';
    }
    const summary: StatusSnapshot = {
      status,
      pid,
      listening,
      phase,
      progress: progress ?? null,
      // 在线人数用协议探测实时拿（state.players 只在启动/停止时写过 0，从来没被更新）
      players: status === 'running' ? await livePlayerCount(id, '127.0.0.1', cfg.port, st.players) : st.players,
      uptime: proc?.uptime || (st.startedAt ? Math.max(0, Date.now() / 1000 - st.startedAt) : 0),
      cpu: proc?.cpu ?? 0,
      rss: proc?.rss ?? 0,
      detectedFrom: 'memory',
    };
    return summary;
  }

  const pidFromFile = readPidFile(id);
  const unverifiedPidAlive = Boolean(pidFromFile && isAlive(pidFromFile));
  const listeningWithoutPid = await portOpen(cfg.port, '127.0.0.1', 500);
  if (unverifiedPidAlive || listeningWithoutPid) {
    status = st.status === 'stopping' ? 'stopping' : 'stuck';
    phase = listeningWithoutPid
      ? '游戏端口仍在监听，但面板暂时无法识别进程'
      : '发现世界进程，但面板暂时无法确认进程身份';
    return {
      status,
      pid: unverifiedPidAlive ? pidFromFile : null,
      listening: listeningWithoutPid,
      phase,
      progress: null,
      players: st.players,
      uptime: st.startedAt ? Math.max(0, Date.now() / 1000 - st.startedAt) : 0,
      cpu: 0,
      rss: 0,
      detectedFrom: 'memory',
    };
  }
  if (st.status === 'stopping' || st.status === 'crashed') {
    status = st.status === 'stopping' ? 'stopped' : 'crashed';
  }
  const javaPhase = javaPreparing.get(id);
  if (javaPhase) {
    return { status: 'starting', pid: null, listening: false, phase: javaPhase, progress: null, players: 0, uptime: 0, cpu: 0, rss: 0, detectedFrom: 'memory' };
  }
  return { status, pid: null, listening: false, phase: st.phase || '', progress: null, players: 0, uptime: 0, cpu: 0, rss: 0, detectedFrom: 'memory' };
}

/** 把控制台输出接到缓冲，并维护状态 */
function attachOutput(child: ChildProcess, id: string): void {
  const buf = console_(id);
  const onData = (data: Buffer) => {
    for (const line of data.toString('utf8').split(/\r?\n/)) buf.push(line);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('exit', (code, signal) => {
    procs.delete(id);
    stopTail(id);
    try {
      fs.unlinkSync(pidFile(id));
    } catch {
      /* ignore */
    }
    const crash = !fs.existsSync(intentFile(id)) && code !== 0 && code !== null;
    I.saveState(id, {
      status: crash ? 'crashed' : 'stopped',
      pid: null,
      listening: false,
      lastExitCode: code,
      phase: crash ? `进程异常退出（code=${code} signal=${signal}）` : '已停止',
      players: 0,
    });
    if (!crash) {
      // .stop-intent 存在 = 是我们主动优雅停止的
      evStop({ id, name: I.getConfig(id).name }, fs.existsSync(intentFile(id)) ? '优雅停止' : '进程正常退出');
    }
    if (crash) {
      // 优先用服务端自己的崩溃报告（信息最准），其次才靠日志特征猜
      const report = latestCrashReport(instanceServerDir(id), Date.now() - 6 * 3600_000);
      const reason = report?.reason ?? detectFailure(buf.text()) ?? `进程异常退出（code=${code}）`;
      I.saveState(id, {
        lastError: report ? `${report.reason}｜崩溃时间 ${report.time}` : reason,
        phase: `崩溃：${reason}`,
      });
      logger.warn(`世界 ${id} 异常退出`, { code, signal, reason });
      evCrash({ id, name: I.getConfig(id).name }, reason);
    } else {
      logger.info(`世界 ${id} 已停止`, { code });
    }
  });
}

// ------------------------------------------------------------------ 日志文件 tail
/**
 * 跟着 logs/server.out 读新增内容（面板不持有管道，所以只能读文件）。
 * 这样面板重启、崩溃、被看门狗拉起，控制台都不会断。
 */
const tailers = new Map<string, { offset: number; timer: NodeJS.Timeout }>();

export function startTail(id: string): void {
  stopTail(id);
  const file = path.join(instanceDir(id), 'logs', 'server.out');
  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch {
    offset = 0;
  }
  const timer = setInterval(() => {
    try {
      const st = fs.statSync(file);
      if (st.size < offset) offset = 0; // 文件被清空/轮转过
      if (st.size === offset) return;
      const fd = fs.openSync(file, 'r');
      const len = st.size - offset;
      const raw = Buffer.alloc(len);
      fs.readSync(fd, raw, 0, len, offset);
      fs.closeSync(fd);
      offset = st.size;
      const buf = console_(id);
      const chunk = `${raw.toString('utf8')}`;
      for (const line of chunk.split(/\r?\n/)) buf.push(line);
      // 服务端报「Done」时立刻把状态落成 running：
      // 启动等待是有超时的，重整合包加载动辄一两分钟（实测 123 秒），
      // 超时之后如果没有这一步，state.json 会一直停在「启动中」。
      if (/Done \([\d.]+s\)!/i.test(chunk)) {
        const st = I.getState(id);
        if (st.status === 'starting' || st.status === 'stopped') {
          const took = st.startedAt ? Math.round(Date.now() / 1000 - st.startedAt) : 0;
          I.saveState(id, { status: 'running', phase: '服务端已就绪', progress: null, startedAt: st.startedAt || Date.now() / 1000 });
          logger.info(`世界 ${id} 已就绪（从日志里看到 Done）`);
          evReady({ id, name: I.getConfig(id).name }, took > 0 ? `耗时 ${took} 秒` : '');
        }
      }
    } catch {
      /* 文件暂时读不到就下一轮再试 */
    }
  }, 1000);
  timer.unref();
  tailers.set(id, { offset, timer });
}

export function stopTail(id: string): void {
  const t = tailers.get(id);
  if (t) {
    clearInterval(t.timer);
    tailers.delete(id);
  }
}

export interface StartResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

export async function start(id: string, opts: { wait?: boolean } = {}): Promise<StartResult> {
  return withLock(`instance:${id}`, async () => {
    if (panelShutdownRequested) return { ok: false, error: 'BlockCraft 正在关闭，暂时不能启动世界' };
    const cfg = I.getConfig(id);
    const dir = instanceDir(id);
    const serverDir = instanceServerDir(id);
    if (alivePid(id)) {
      const st = await statusOf(id);
      if (st.status === 'stuck') {
        return { ok: false, error: `世界 ${id} 的进程还在但没有监听端口（卡住了）。请先停止，再启动。` };
      }
      return { ok: false, error: `世界 ${id} 已经在运行中` };
    }

    // 1) Java 解析；本机没有兼容版本时自动下载 Temurin 后继续启动。
    javaPreparing.set(id, '正在检查 Java 环境');
    let java: Awaited<ReturnType<typeof ensureJava>>;
    try {
      java = await ensureJava(cfg.mc, cfg.loader, (message) => javaPreparing.set(id, message));
    } finally {
      javaPreparing.delete(id);
    }
    const configuredJava = cfg.javaPath && fs.existsSync(cfg.javaPath) ? inspectJava(cfg.javaPath) : null;
    const selectedJava = selectCompatibleJava(configuredJava, java.runtime ? [java.runtime] : [], java.required);
    if (!selectedJava) {
      const configuredHint = cfg.javaPath && fs.existsSync(cfg.javaPath) && configuredJava
        ? `当前配置的 Java ${configuredJava.major} 低于要求的 Java ${java.required}。`
        : '';
      throw conflict(`${configuredHint}${java.reason}`);
    }
    // 配置里保存的 javaMajor 不能证明 javaPath 实际指向该版本；启动前直接探测路径，
    // 避免世界迁移或系统 Java 更新后继续误用旧 Java。
    const launchCfg: InstanceConfig = { ...cfg, javaMajor: selectedJava.major, javaPath: selectedJava.path };
    if (cfg.javaMajor !== selectedJava.major || cfg.javaPath !== selectedJava.path) {
      I.saveConfig(id, { javaMajor: selectedJava.major, javaPath: selectedJava.path });
    }
    const javaPath = selectedJava.path;

    // 2) 产物校验
    const check = validateInstall(launchCfg, serverDir);
    if (!check.ok) {
      return { ok: false, error: `缺少服务端文件：${check.missing.join('、')}。请先在「配置」里重新安装这个世界的服务端。` };
    }

    // Retrofit the server-only skin component for worlds created by older
    // BlockCraft versions. The selected loader decides whether this is a MOD,
    // Paper plugin, or unsupported pure Vanilla.
    await ensureSkinSupport(id, (line) => logger.info(`世界 ${id} 皮肤组件：${line}`));

    // 3) 生成 JVM 参数。Node 直接启动 Java，Windows 和 Linux 使用同一条路径。
    writeJvmArgsFile(serverDir, check.plan);
    const javaArgs = check.plan.useArgFile
      ? ['@user_jvm_args.txt', ...check.plan.serverArgs]
      : [...check.plan.jvmArgs, ...check.plan.serverArgs];
    try {
      fs.unlinkSync(intentFile(id));
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(pidFile(id));
    } catch {
      /* ignore */
    }

    // 4) 确认端口没被别的程序占着
    if (await portOpen(cfg.port)) {
      return { ok: false, error: `游戏端口 ${cfg.port} 已被占用，请到「显示端口」里重新分配。` };
    }

    const logFile = path.join(dir, 'logs', 'server.out');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const logFd = fs.openSync(logFile, 'a');
    startTail(id);
    const logSeqAtStart = console_(id).seq;
    const child = spawn(javaPath, javaArgs, {
      cwd: serverDir,
      detached: true,
      windowsHide: true,
      // 留着一个未关闭的输入管道，避免服务端控制台线程在 EOF 后空转；游戏命令走 RCON。
      // stdout/stderr 直写文件，面板重启后仍可从文件尾部续读。
      stdio: ['pipe', logFd, logFd],
    });
    fs.closeSync(logFd);
    child.unref();
    const stdin = child.stdin as (typeof child.stdin & { unref?: () => void }) | null;
    stdin?.unref?.();
    if (!child.pid) return { ok: false, error: '进程启动失败' };
    const pid = child.pid;
    const startedAt = Date.now() / 1000;
    procs.set(id, { child, pid, startedAt, logSeqAtStart, intentional: false });
    atomicWriteFileSync(pidFile(id), String(pid));
    attachOutput(child, id);
    I.saveState(id, { status: 'starting', pid, startedAt, phase: '正在启动', lastError: null, intentionalStop: false, players: 0 });
    evStart({ id, name: cfg.name }, `${cfg.loader} ${cfg.mc}，Xmx ${cfg.memoryMb}M`);
    logger.info(`世界 ${id} 启动中（PID ${pid}，${check.plan.how}）`);

    if (opts.wait === false) return { ok: true, pid };

    // 5) 等待真正就绪（for 40 秒内进程还在且端口监听；之后交给轮询）
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      await sleep(2000);
      if (!isAlive(pid)) {
        const reason = detectFailure(console_(id).text()) ?? '进程启动后很快退出';
        I.saveState(id, { status: 'crashed', pid: null, lastError: reason, phase: reason });
        return { ok: false, error: reason };
      }
      if (await portOpen(cfg.port)) {
        I.saveState(id, { status: 'starting', phase: '已监听端口，正在加载世界' });
        break;
      }
    }
    return { ok: true, pid };
  });
}

export interface StopOptions {
  message?: string;
  kick?: boolean;
  timeoutSec?: number;
  timeoutMs?: number;
  /** 定时停服时用它把公告提前发出去 */
  announce?: boolean;
  /** 托盘安全退出时只允许 RCON 正常停服；失败或超时就保留面板和世界进程。 */
  safeOnly?: boolean;
}

export async function stop(id: string, opts: StopOptions = {}): Promise<{ ok: boolean; graceful: boolean; error?: string }> {
  return withLock(`instance:${id}`, async () => {
    const cfg = I.getConfig(id);
    const pid = alivePid(id);
    // 先写意图文件：看门狗看到它就不会再把这个世界拉起来
    atomicWriteFileSync(intentFile(id), new Date().toISOString() + '\n');
    I.saveState(id, { status: 'stopping', phase: '正在保存并关闭', intentionalStop: true });
    if (!pid) {
      const pidFromFile = readPidFile(id);
      const pidFileAlive = Boolean(pidFromFile && isAlive(pidFromFile));
      const listening = await portOpen(cfg.port, '127.0.0.1', 500);
      if (!pidFileAlive && !listening) {
        try { fs.unlinkSync(pidFile(id)); } catch { /* no stale PID file */ }
        I.saveState(id, { status: 'stopped', pid: null, listening: false, players: 0, phase: '已停止' });
        return { ok: true, graceful: true };
      }
      if (!listening) {
        const error = '发现进程仍在运行，但游戏端口未监听且无法确认进程身份；为避免误杀其他程序，面板保持运行。';
        I.saveState(id, { status: 'stuck', pid: pidFromFile, listening: false, phase: error, lastError: error });
        return { ok: false, graceful: false, error };
      }
      // PID is unavailable/unverified, but a Minecraft server still owns the
      // configured game port. Use its RCON endpoint and never kill an unknown PID.
    }

    const timeoutMs = opts.timeoutMs ?? (opts.timeoutSec ?? 120) * 1000;
    const buf = console_(id);
    let graceful = false;

    // 走 RCON 做「保存 → 公告 → 踢人 → 停服」；RCON 不通就退化为 SIGTERM
    try {
      await rconFor(cfg).command('save-all flush');
      // 只在「本来就有日志」的前提下等保存完成；缓冲为空（比如刚重启过面板）就别干等 20 秒
      const hadLog = buf.tail(1).length > 0;
      const saveDeadline = Date.now() + (hadLog ? 20000 : 2000);
      while (Date.now() < saveDeadline) {
        if (/Saved the game|Saved the world/i.test(buf.tail(40).map((l) => l.text).join('\n'))) break;
        await sleep(500);
      }
      if (opts.kick !== false) {
        const msg = opts.message ?? '服务器即将关闭，感谢游玩';
        await rconFor(cfg).command(`say ${msg}`).catch(() => '');
        await sleep(800);
        await rconFor(cfg).command('kick @a 服务器正在关闭').catch(() => '');
        await sleep(1200);
      }
      await rconFor(cfg).command('stop');
      graceful = true;
    } catch (err) {
      logger.warn(opts.safeOnly ? 'RCON 停止失败，安全退出将保留世界进程' : 'RCON 停止失败，改用 SIGTERM', { instance: id, error: String(err) });
      if (opts.safeOnly) {
        const error = `RCON 停止失败，世界仍在运行；为保护存档，未强制结束进程：${String(err)}`;
        I.saveState(id, { status: 'stuck', pid, listening: true, phase: error, lastError: error });
        return { ok: false, graceful: false, error };
      }
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* ignore */
        }
      } else {
        const error = `RCON 停止失败，无法确认世界进程身份，未结束任何进程：${String(err)}`;
        I.saveState(id, { status: 'stuck', pid: null, listening: true, phase: error, lastError: error });
        return { ok: false, graceful: false, error };
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const stopped = pid ? !isAlive(pid) : !(await portOpen(cfg.port, '127.0.0.1', 500));
      if (stopped) {
        if (!pid) {
          try { fs.unlinkSync(pidFile(id)); } catch { /* ignore */ }
        }
        I.saveState(id, { status: 'stopped', pid: null, listening: false, players: 0, phase: '已停止' });
        return { ok: true, graceful };
      }
      await sleep(1000);
    }

    if (!pid) {
      const error = 'Minecraft 端口在等待后仍未关闭；为避免强制结束未知进程，BlockCraft 保持运行。';
      I.saveState(id, { status: 'stuck', pid: null, listening: true, phase: error, lastError: error });
      return { ok: false, graceful, error };
    }

    if (opts.safeOnly) {
      const error = '世界在等待后仍未停止；为保护存档，未强制结束进程，BlockCraft 保持运行。';
      I.saveState(id, { status: 'stuck', pid, listening: true, phase: error, lastError: error });
      return { ok: false, graceful, error };
    }

    // 超时：SIGTERM → 5 秒后 SIGKILL
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
    await sleep(5000);
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
      await sleep(1000);
    }
    const stillAlive = isAlive(pid);
    I.saveState(id, {
      status: stillAlive ? 'stuck' : 'stopped',
      pid: stillAlive ? pid : null,
      listening: false,
      players: 0,
      phase: stillAlive ? '未能停止，已强制结束进程' : '已停止（超时后强制结束，可能未完整保存）',
    });
    return { ok: !stillAlive, graceful, error: stillAlive ? '进程无法停止' : undefined };
  });
}

export async function restart(id: string): Promise<StartResult> {
  await stop(id, { message: '服务器正在重启' });
  return start(id);
}

/** 清掉卡住的进程（看门狗用）：先停再拉起 */
export async function killStuck(id: string): Promise<void> {
  const pid = alivePid(id);
  if (!pid) return;
  logger.warn(`强制结束卡住的世界 ${id}（PID ${pid}）`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
  atomicWriteFileSync(pidFile(id), '');
  I.saveState(id, { status: 'stopped', pid: null, listening: false, phase: '卡住的进程已被强制结束' });
}

export async function applyGamerules(id: string): Promise<void> {
  const cfg = I.getConfig(id);
  const entries = Object.entries(cfg.gamerules ?? {});
  if (!entries.length) return;
  const client = rconFor(cfg);
  for (const [rule, value] of entries) {
    try {
      await client.command(`gamerule ${rule} ${value ? 'true' : 'false'}`);
    } catch (err) {
      logger.debug(`下发 gamerule ${rule} 失败`, String(err));
    }
  }
}

export function listPlayers(id: string): Promise<{ online: number; max: number; names: string[] }> {
  const cfg = I.getConfig(id);
  return rconFor(cfg)
    .command('list')
    .then((body) => {
      const online = Number(body.match(/There are (\d+)/)?.[1] ?? 0);
      const max = Number(body.match(/of a max of (\d+)/)?.[1] ?? 0);
      const names = (body.split(':')[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return { online, max, names };
    });
}

export function onlinePids(): { id: string; pid: number }[] {
  const out: { id: string; pid: number }[] = [];
  for (const id of procs.keys()) {
    const pid = alivePid(id);
    if (pid) out.push({ id, pid });
  }
  return out;
}

export function isRunning(id: string): boolean {
  return alivePid(id) !== null;
}

export function hasIntent(id: string): boolean {
  return fs.existsSync(intentFile(id));
}

/** 面板重启后的对账：把还在跑的进程接管回来 */
/**
 * 面板启动后自己把 autostart 的世界拉起来。
 *
 * 为什么不全交给看门狗：看门狗为了避开「面板冷启动时还没认领已存在进程」的窗口，
 * 要求连续两次巡检（45 秒宽限 + 60 秒间隔）才动手 —— 实测从 DSH 启动到世界真的开始起
 * 隔了 109 秒，用户会觉得「自启没生效」。看门狗留着做兜底（崩溃、卡死、被系统杀掉）。
 *
 * 按内存错开启动：几个整合包的 Xmx 加起来会超过物理内存，绝不能一起拉。
 */
export async function startAutostartWorlds(): Promise<void> {
  const ids = I.listInstanceIds();
  for (const id of ids) {
    let cfg: ReturnType<typeof I.getConfig>;
    let st: ReturnType<typeof I.getState>;
    try {
      cfg = I.getConfig(id);
      st = I.getState(id);
    } catch {
      continue;
    }
    if (!cfg.autostart) continue;
    if (st.status === 'running' || st.status === 'starting' || st.status === 'stopping') continue;
    /*
     * 内存门槛。原来是一刀切要求 available >= Xmx×1.15，太保守：
     * 实测这台机器空闲时可用内存常年就在 4.1~4.6G，而 Xmx 4096 的世界稳态 RSS 只有 3.6G 左右，
     * 结果「自动启动」几乎永远起不来（世界一直停着，对用户来说比慢一点更糟）。
     * 现在分三档：够就起、偏紧就起但告警、实在不够才跳过。
     */
    const avail = systemService.memoryInfo().availableMb;
    if (avail < cfg.memoryMb * 0.9) {
      logger.warn(
        `autostart 跳过 ${id}：可用内存 ${avail}MB，明显装不下 ${cfg.memoryMb}MB 的堆（看门狗稍后会再试）`,
      );
      continue;
    }
    if (avail < cfg.memoryMb * 1.05) {
      logger.warn(`autostart 拉起 ${id}：可用内存 ${avail}MB 偏紧（堆 ${cfg.memoryMb}MB），可能走 swap 而变卡`);
    }
    logger.info(`autostart 拉起 ${id}（可用内存 ${avail}MB / 需要 ${cfg.memoryMb}MB）`);
    try {
      const r = await start(id, { wait: false });
      if (!r.ok) logger.warn(`autostart 拉起 ${id} 失败：${r.error ?? '未知'}`);
      await frp.syncWorlds().catch(() => undefined);
    } catch (err) {
      logger.warn(`autostart 拉起 ${id} 异常`, String(err));
    }
    // 错开：等上一个把内存吃住再起下一个
    await new Promise((r) => setTimeout(r, 15000));
  }
}

/**
 * 巡检「状态写着在跑、进程其实已经没了」的世界。
 *
 * 为什么需要：面板重启时接管过来的世界**没有子进程句柄**，`child.on('exit')` 永远不会触发，
 * 于是世界炸掉了面板也一直显示运行中（实测：18:25 世界被看门狗判定卡死而关闭，面板全程
 * 没留下任何原因）。这里顺便把崩溃报告读出来翻译成人话写进 lastError，卡片上直接能看到。
 */
export function sweepDeadWorlds(): void {
  for (const id of I.listInstanceIds()) {
    let st: ReturnType<typeof I.getState>;
    try {
      st = I.getState(id);
    } catch {
      continue;
    }
    if (st.status !== 'running' && st.status !== 'starting') continue;
    if (alivePid(id)) continue; // 进程还活着，正常
    const since = st.startedAt ? st.startedAt * 1000 - 60_000 : 0;
    const crash = latestCrashReport(instanceServerDir(id), since);
    I.saveState(id, {
      status: crash ? 'crashed' : 'stopped',
      pid: null,
      listening: false,
      players: 0,
      intentionalStop: false,
      phase: crash ? `崩溃：${crash.reason}` : '已停止（进程已不在）',
      lastError: crash ? `${crash.reason}｜崩溃时间 ${crash.time}` : st.lastError ?? null,
    });
    const w = (() => {
      try {
        const c = I.getConfig(id);
        return { id, name: c.name };
      } catch {
        return { id, name: id };
      }
    })();
    if (crash) {
      logger.warn(`世界 ${id} 进程已消失，且发现崩溃报告`, { file: crash.file, reason: crash.reason });
      evCrash(w, crash.reason);
    } else {
      logger.warn(`世界 ${id} 进程已消失（没有崩溃报告，可能被系统杀掉或正常退出）`);
      evStop(w, '进程消失（没有崩溃报告，可能被系统杀掉）');
    }
  }
}

export function reconcile(): void {
  /*
   * 面板每次启动都清掉「用户主动停止」这个意图。
   * 它的本意只是「这一轮别自动给我拉起来」（比如你刚在面板里点了停止，看门狗不该马上又开），
   * 但它被持久化在 state.json 里，结果变成「手动停过一次 → autostart 永久失效」，
   * 连重启 DSH 都恢复不了。新的一次启动 = 新的一轮，应当重新按 autostart 来。
   */
  try {
    for (const id of I.listInstanceIds()) {
      const st = I.getState(id);
      if (st.intentionalStop && st.status !== 'running' && st.status !== 'starting') {
        I.saveState(id, { intentionalStop: false });
        logger.info('世界 ' + id + ' 的「主动停止」意图已随面板重启失效（仍按 autostart 设置）');
      }
    }
  } catch (err) {
    logger.warn('清理主动停止意图失败', String(err));
  }

  for (const id of I.listInstanceIds()) {
    const pid = readPidFile(id);
    if (pid && isAlive(pid)) {
      let cmdline = '';
      try {
        cmdline = processCommandLine(pid) ?? '';
      } catch {
        /* ignore */
      }
      if (/java/.test(cmdline) && /(nogui|unix_args)/.test(cmdline)) {
        logger.info(`接管已存在的世界进程 ${id}（PID ${pid}，面板外启动）`);
        // 先把磁盘上的控制台历史读回来，再判定状态 —— 否则会一直显示「启动中」
        const logFile = path.join(instanceDir(id), 'logs', 'console.log');
        try {
          if (fs.existsSync(logFile)) {
            const stat = fs.statSync(logFile);
            const maxBytes = 512 * 1024;
            const start = Math.max(0, stat.size - maxBytes);
            const fd = fs.openSync(logFile, 'r');
            const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
            fs.readSync(fd, buf, 0, buf.length, start);
            fs.closeSync(fd);
            const text = buf.toString('utf8');
            const raw = (start > 0 ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
            console_(id).loadHistory(raw.slice(-3000));
            logger.info(`已恢复 ${id} 的控制台历史（${Math.min(raw.length, 3000)} 行）`);
          }
        } catch (err) {
          logger.warn(`恢复 ${id} 的控制台历史失败`, String(err));
        }
        startTail(id);
        const phaseNow = detectPhase(console_(id).text());
        I.saveState(id, {
          status: phaseNow.status === 'running' ? 'running' : 'starting',
          pid,
          phase: phaseNow.status === 'running' ? '服务端已就绪（面板重启前已在运行）' : '运行中（面板重启前已在运行，日志尚未就绪）',
        });
        const st = I.getState(id);
        if (!st.startedAt) I.saveState(id, { startedAt: Date.now() / 1000 });
      } else {
        logger.warn(`世界 ${id} 的 PID 文件指向的不是我们的服务端，忽略`);
        try {
          fs.unlinkSync(pidFile(id));
        } catch {
          /* ignore */
        }
      }
    } else if (pid) {
      try {
        fs.unlinkSync(pidFile(id));
      } catch {
        /* ignore */
      }
      const st = I.getState(id);
      if (st.status === 'running' || st.status === 'starting') {
        I.saveState(id, { status: 'stopped', pid: null, listening: false, phase: '面板重启时发现进程已不在' });
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { LOG_DIR, notFound, busy };
