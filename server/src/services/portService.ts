import net from 'node:net';
import { PORTS_FILE } from '../core/paths.ts';
import { atomicWriteJsonWithBackupSync, readJsonSync } from '../core/fsx.ts';
import { conflict } from '../core/errors.ts';
import { createLogger } from '../core/logger.ts';
import type { PortRegistry } from '../types.ts';

const logger = createLogger('port');

const empty: PortRegistry = { game: {}, rcon: {}, frp: {} };

let registry: PortRegistry | null = null;

export function loadRegistry(): PortRegistry {
  if (!registry) {
    const raw = readJsonSync<Partial<PortRegistry>>(PORTS_FILE, {});
    registry = { game: raw.game ?? {}, rcon: raw.rcon ?? {}, frp: raw.frp ?? {} };
  }
  return registry;
}

function save(): void {
  atomicWriteJsonWithBackupSync(PORTS_FILE, loadRegistry());
}

/** 本地端口探测：真的去 bind 一次（/proc/net/tcp 在受限环境里读不到，这是唯一可靠的办法） */
export function isFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try {
      srv.listen({ port, host, exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

async function pickFreeLocal(range: [number, number], used: Set<number>): Promise<number> {
  for (let p = range[0]; p <= range[1]; p++) {
    if (used.has(p)) continue;
    if (await isFree(p)) return p;
  }
  throw conflict(`本地端口段 ${range[0]}-${range[1]} 已用满`);
}

export interface Allocation {
  game: number;
  rcon: number;
}

/** 为实例分配本地端口；已分配且未被别人占用时保持幂等（不随意变更） */
export async function allocateLocal(
  id: string,
  gameRange: [number, number],
  rconRange: [number, number],
  prefer?: { game?: number; rcon?: number },
): Promise<Allocation> {
  const reg = loadRegistry();
  const usedGame = new Set(Object.entries(reg.game).filter(([k]) => k !== id).map(([, v]) => v));
  const usedRcon = new Set(Object.entries(reg.rcon).filter(([k]) => k !== id).map(([, v]) => v));

  let game = reg.game[id] ?? prefer?.game;
  if (!game || usedGame.has(game) || !(await isFree(game))) {
    game = await pickFreeLocal(gameRange, usedGame);
  }
  let rcon = reg.rcon[id] ?? prefer?.rcon;
  if (!rcon || usedRcon.has(rcon) || rcon === game || !(await isFree(rcon))) {
    rcon = await pickFreeLocal(rconRange, new Set([...usedRcon, game]));
  }
  reg.game[id] = game;
  reg.rcon[id] = rcon;
  save();
  return { game, rcon };
}

/** 分配远端 FRP 端口：登记表排重 + 可选的服务端在线列表排重 */
export async function allocateRemote(
  id: string,
  range: [number, number],
  taken: Set<number>,
): Promise<number> {
  const reg = loadRegistry();
  const used = new Set(
    Object.entries(reg.frp)
      .filter(([k]) => k !== id)
      .map(([, v]) => v),
  );
  const cur = reg.frp[id];
  if (cur && !used.has(cur) && !taken.has(cur) && cur >= range[0] && cur <= range[1]) return cur;
  for (let p = range[0]; p <= range[1]; p++) {
    if (used.has(p) || taken.has(p)) continue;
    reg.frp[id] = p;
    save();
    logger.info(`为 ${id} 分配远端端口 ${p}`);
    return p;
  }
  throw conflict(`远端端口段 ${range[0]}-${range[1]} 已用满`);
}

export function setRemote(id: string, port: number): void {
  const reg = loadRegistry();
  reg.frp[id] = port;
  save();
}

export function release(id: string): void {
  const reg = loadRegistry();
  delete reg.game[id];
  delete reg.rcon[id];
  delete reg.frp[id];
  save();
}

export function snapshot(): PortRegistry {
  return JSON.parse(JSON.stringify(loadRegistry())) as PortRegistry;
}

/** 启动对账：登记表里删掉已不存在的实例（防止端口被幽灵条目占着） */
export function reconcile(existingIds: Set<string>): void {
  const reg = loadRegistry();
  let changed = false;
  for (const bucket of ['game', 'rcon', 'frp'] as const) {
    for (const id of Object.keys(reg[bucket])) {
      if (!existingIds.has(id)) {
        delete reg[bucket][id];
        changed = true;
      }
    }
  }
  if (changed) save();
}
