/**
 * 看门狗：在没有 systemd / init 的环境里负责「面板活着 + 世界按需拉起 + 卡住自愈」。
 * 它只通过面板的 HTTP API 干活，不直接碰进程，避免和面板抢控制权。
 *
 *   node server/src/watchdog.ts
 *
 * 每 60 秒一轮：
 *   1. 面板不通 → 直接把面板拉起来
 *   2. frpc 通道掉了 → 让面板重启该通道
 *   3. autostart=true 且没在跑、也没有「主动停止」意图的世界 → 拉起
 *   4. 卡住（在跑但不监听端口）超过阈值 → 先停再拉起
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { DATA_DIR, PROJECT_ROOT } from './core/paths.ts';

const INTERVAL = Number(process.env.BC_WATCHDOG_INTERVAL || 60) * 1000;
const GRACE_FIRST = Number(process.env.BC_WATCHDOG_GRACE || 45) * 1000;
const LOG = path.join(DATA_DIR, 'logs', 'watchdog.log');

function log(msg: string): void {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n');
  } catch {
    /* ignore */
  }
}

function panelConfig(): { port: number; token: string } {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'panel.json'), 'utf8'));
    return { port: cfg.panel.port, token: cfg.panel.token };
  } catch {
    return { port: Number(process.env.BC_PORT || 8081), token: '' };
  }
}

let cookie = '';

async function api<T>(method: string, apiPath: string, body?: unknown): Promise<T | null> {
  const { port } = panelConfig();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
      method,
      headers: {
        'X-Blockcraft': '1',
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401) {
      await login();
      return null;
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function login(): Promise<boolean> {
  const { port, token } = panelConfig();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Blockcraft': '1' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(5000),
    });
    const setCookie = res.headers.get('set-cookie');
    if (res.ok && setCookie) {
      cookie = setCookie.split(';')[0];
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function startPanel(): void {
  log('面板不响应，正在拉起');
  const out = fs.openSync(path.join(DATA_DIR, 'logs', 'panel.out'), 'a');
  const child = spawn('node', [path.join(PROJECT_ROOT, 'server', 'src', 'index.ts')], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
}

interface Summary {
  id: string;
  name: string;
  status: string;
  autostart: boolean;
  intentionalStop: boolean;
  port: number;
  frpPort: number | null;
}

const stuckSince = new Map<string, number>();

let consecutivePingFailures = 0;

/** 端口上到底有没有人在监听（面板可能在忙，但没死） */
function portAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

async function tick(): Promise<void> {
  // 1) 面板：必须连续两次 ping 失败 **且** 端口真的没人监听，才认为它挂了。
  //    只凭一次超时就拉起，会在面板短暂繁忙时糊出一个重复进程（实测踩到）。
  const ping = await api<{ ok: boolean }>('GET', '/api/ping');
  if (!ping?.ok) {
    consecutivePingFailures += 1;
    const { port } = panelConfig();
    const alive = await portAlive(port);
    if (consecutivePingFailures < 2 || alive) {
      log(`面板这一次没响应（第 ${consecutivePingFailures} 次，端口${alive ? '仍有人监听' : '已空'}），再观察一轮`);
      return;
    }
    startPanel();
    consecutivePingFailures = 0;
    await new Promise((r) => setTimeout(r, 15000));
    return;
  }
  consecutivePingFailures = 0;
  if (!cookie) await login();

  // 2) FRP 通道
  const frp = await api<{ channels: { name: string; running: boolean }[]; configured: boolean }>('GET', '/api/frp/status');
  if (frp?.configured) {
    for (const ch of frp.channels ?? []) {
      if (!ch.running) {
        log(`FRP 通道 ${ch.name} 不在运行，让面板重启它`);
        await api('POST', '/api/frp/restart', { channel: ch.name });
      }
    }
  }

  // 3) 世界
  const list = await api<{ instances: Summary[] }>('GET', '/api/instances');
  for (const inst of list?.instances ?? []) {
    if (inst.status === 'stuck') {
      const since = stuckSince.get(inst.id) ?? Date.now();
      stuckSince.set(inst.id, since);
      if (Date.now() - since > 120_000) {
        log(`世界 ${inst.id} 卡住超过 2 分钟，先停再拉起`);
        await api('POST', `/api/instances/${inst.id}/stop`, { timeoutSec: 30 });
        await new Promise((r) => setTimeout(r, 5000));
        await api('POST', `/api/instances/${inst.id}/start`, {});
        stuckSince.delete(inst.id);
      }
      continue;
    }
    stuckSince.delete(inst.id);

    if (!inst.autostart) continue;
    if (inst.intentionalStop) continue; // 用户主动停的，不要自动拉起来
    if (inst.status !== 'stopped' && inst.status !== 'crashed') continue;
    // 连续两次看到它没跑才动手，避开冷启动窗口
    const key = `miss:${inst.id}`;
    const seen = Number(process.env[key] ?? 0);
    if (!seen) {
      process.env[key] = '1';
      continue;
    }
    delete process.env[key];
    log(`自动拉起世界 ${inst.name}（autostart=true）`);
    const r = await api<{ ok?: boolean; error?: string }>('POST', `/api/instances/${inst.id}/start`, {});
    if (r && r.ok === false) log(`  拉起失败：${r.error ?? '未知原因'}`);
  }
}

async function main(): Promise<void> {
  log(`看门狗启动（间隔 ${INTERVAL / 1000} 秒）`);
  await new Promise((r) => setTimeout(r, GRACE_FIRST));
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log(`轮询异常：${String(err)}`);
    }
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'logs', 'watchdog.heartbeat'), String(Date.now()));
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

if (process.argv[1] && /watchdog\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    log(`看门狗退出：${String(err)}`);
    process.exit(1);
  });
}
