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
import { detectFailure, detectPhase, planLaunch, stripAnsi, validateInstall, writeJvmArgsFile, writeLaunchScript } from '../launcher/index.ts';
import { processStat } from './systemService.ts';
import { autoJava } from './javaService.ts';
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

  tail(n = 300): ConsoleLine[] {
    return this.lines.slice(-n);
  }

  text(): string {
    return this.lines.map((l) => l.text).join('\n');
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

  private read(sock: net.Socket): Promise<{ id: number; type: number; body: string }> {
    return new Promise((resolve, reject) => {
      let sizeBuf: Buffer | null = null;
      const onData = (chunk: Buffer) => {
        if (!sizeBuf) {
          if (chunk.length < 4) return;
          sizeBuf = chunk.subarray(0, 4);
          chunk = chunk.subarray(4);
        }
        const size = sizeBuf.readInt32LE(0);
        if (chunk.length < size) {
          // 极少数情况下分片，继续等
          const need = size - chunk.length;
          const more = (c: Buffer) => {
            chunk = Buffer.concat([chunk, c]);
            if (chunk.length >= size) {
              cleanup();
              finish(chunk);
            }
          };
          const cleanup = () => sock.off('data', more);
          sock.on('data', more);
          void need;
          return;
        }
        cleanup();
        finish(chunk);
      };
      const finish = (buf: Buffer) => {
        const id = buf.readInt32LE(0);
        const type = buf.readInt32LE(4);
        const body = buf.subarray(8, buf.length - 2).toString('utf8');
        resolve({ id, type, body });
      };
      const cleanup = () => sock.off('data', onData);
      sock.on('data', onData);
      sock.once('error', (e) => {
        cleanup();
        reject(e);
      });
      sock.once('timeout', () => {
        cleanup();
        reject(new Error('RCON 超时'));
      });
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
  intentional: boolean;
}

const procs = new Map<string, RunningProc>();

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
    return true;
  } catch {
    return false;
  }
}

export function alivePid(id: string): number | null {
  const fromMap = procs.get(id)?.pid;
  const pid = fromMap ?? readPidFile(id);
  if (!pid) return null;
  if (!isAlive(pid)) return null;
  // 校验 cmdline 里确实是我们的服务端，避免 PID 复用误判
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!/java/.test(cmd) || !/(nogui|unix_args)/.test(cmd)) return null;
  } catch {
    return null;
  }
  return pid;
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

export async function statusOf(id: string): Promise<StatusSnapshot> {
  const cfg = I.getConfig(id);
  const st = I.getState(id);
  const pid = alivePid(id);
  const listening = pid ? await portOpen(cfg.port) : false;
  let phase = st.phase;
  let progress = st.progress;
  let status: InstanceStatus = pid ? 'starting' : 'stopped';

  if (pid) {
    const { status: logStatus, progress: p } = detectPhase(console_(id).text());
    progress = p;
    if (logStatus === 'running') {
      status = 'running';
      phase = '服务端已就绪';
    } else if (logStatus === 'stopping') {
      status = 'stopping';
      phase = '正在关闭';
    } else {
      status = 'starting';
      phase = p ? `正在生成世界 ${p.replace('Preparing spawn area:', '').trim()}` : '正在启动';
    }
    // 进程在、日志无进展、端口不通 —— 判定卡住
    const proc = processStat(pid);
    if (!listening && st.startedAt && Date.now() / 1000 - st.startedAt > 180 && logStatus === 'starting') {
      status = 'stuck';
      phase = '启动了 3 分钟仍未监听端口，可能卡住了';
    }
    const summary: StatusSnapshot = {
      status,
      pid,
      listening,
      phase,
      progress: progress ?? null,
      players: st.players,
      uptime: proc?.uptime ?? 0,
      cpu: proc?.cpu ?? 0,
      rss: proc?.rss ?? 0,
      detectedFrom: 'memory',
    };
    return summary;
  }

  if (st.status === 'stopping' || st.status === 'crashed') {
    status = st.status === 'stopping' ? 'stopped' : 'crashed';
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
    if (crash) {
      const reason = detectFailure(buf.text()) ?? `进程异常退出（code=${code}）`;
      I.saveState(id, { lastError: reason });
      logger.warn(`世界 ${id} 异常退出`, { code, signal, reason });
    } else {
      logger.info(`世界 ${id} 已停止`, { code });
    }
  });
}

export interface StartResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

export async function start(id: string, opts: { wait?: boolean } = {}): Promise<StartResult> {
  return withLock(`instance:${id}`, async () => {
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

    // 1) Java 解析
    const java = autoJava(cfg.mc, cfg.loader);
    if (!java.runtime) throw conflict(java.reason);
    if (cfg.javaPath && fs.existsSync(cfg.javaPath) && cfg.javaMajor && java.runtime.major >= (cfg.javaMajor ?? 0)) {
      // 用户手动指定且满足要求时优先用它
    } else if (cfg.javaMajor !== java.required || !cfg.javaPath) {
      I.saveConfig(id, { javaMajor: java.required, javaPath: java.runtime.path });
    }
    const javaPath = cfg.javaPath && fs.existsSync(cfg.javaPath) ? cfg.javaPath : java.runtime.path;

    // 2) 产物校验
    const check = validateInstall(cfg, serverDir);
    if (!check.ok) {
      return { ok: false, error: `缺少服务端文件：${check.missing.join('、')}。请先在「配置」里重新安装这个世界的服务端。` };
    }

    // 3) 生成 JVM 参数与启动脚本
    writeJvmArgsFile(serverDir, check.plan);
    const script = writeLaunchScript({ instanceDir: dir, serverDir, javaPath, plan: check.plan, useArgFile: check.plan.useArgFile });
    atomicWriteFileSync(path.join(dir, 'launch.sh'), script);
    fs.chmodSync(path.join(dir, 'launch.sh'), 0o755);
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

    const logStream = fs.createWriteStream(path.join(dir, 'logs', 'launch.log'), { flags: 'a' });
    const child = spawn('/bin/bash', [path.join(dir, 'launch.sh')], {
      cwd: serverDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.unref();
    if (!child.pid) return { ok: false, error: '进程启动失败' };
    const pid = child.pid;
    procs.set(id, { child, pid, startedAt: Date.now() / 1000, intentional: false });
    atomicWriteFileSync(pidFile(id), String(pid));
    attachOutput(child, id);
    const buf = console_(id);
    buf.on('line', (l: ConsoleLine) => {
      try {
        logStream.write(l.text + '\n');
      } catch {
        /* ignore */
      }
    });
    I.saveState(id, { status: 'starting', pid, startedAt: Date.now() / 1000, phase: '正在启动', lastError: null, intentionalStop: false, players: 0 });
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
}

export async function stop(id: string, opts: StopOptions = {}): Promise<{ ok: boolean; graceful: boolean; error?: string }> {
  return withLock(`instance:${id}`, async () => {
    const cfg = I.getConfig(id);
    const pid = alivePid(id);
    // 先写意图文件：看门狗看到它就不会再把这个世界拉起来
    atomicWriteFileSync(intentFile(id), new Date().toISOString() + '\n');
    I.saveState(id, { status: 'stopping', phase: '正在保存并关闭', intentionalStop: true });
    if (!pid) {
      I.saveState(id, { status: 'stopped', pid: null, listening: false, players: 0, phase: '已停止' });
      return { ok: true, graceful: true };
    }

    const timeoutMs = opts.timeoutMs ?? (opts.timeoutSec ?? 120) * 1000;
    const buf = console_(id);
    let graceful = false;

    // 走 RCON 做「保存 → 公告 → 踢人 → 停服」；RCON 不通就退化为 SIGTERM
    try {
      await rconFor(cfg).command('save-all flush');
      const saveDeadline = Date.now() + 20000;
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
      logger.warn(`RCON 停止失败，改用 SIGTERM`, { instance: id, error: String(err) });
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) {
        I.saveState(id, { status: 'stopped', pid: null, listening: false, players: 0, phase: '已停止' });
        return { ok: true, graceful };
      }
      await sleep(1000);
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
export function reconcile(): void {
  for (const id of I.listInstanceIds()) {
    const pid = readPidFile(id);
    if (pid && isAlive(pid)) {
      let cmdline = '';
      try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch {
        /* ignore */
      }
      if (/java/.test(cmdline) && /(nogui|unix_args)/.test(cmdline)) {
        logger.info(`接管已存在的世界进程 ${id}（PID ${pid}，面板外启动）`);
        I.saveState(id, { status: 'running', pid, phase: '运行中（面板重启前已在运行）' });
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
