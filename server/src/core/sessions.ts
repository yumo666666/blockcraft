import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.ts';
import { atomicWriteJsonSync, readJsonSync } from './fsx.ts';
import { createLogger } from './logger.ts';

const logger = createLogger('session');

/**
 * 登录会话。
 *
 * 之前会话只放在内存里，面板进程一重启（升级、看门狗拉起、我改完代码重启）所有人的
 * 登录态就全没了，得重新输 token —— 对一个「自己用」的面板来说这个体验很烦。
 * 所以改成落盘：重启后会话仍然有效，除非过期、主动退出或重置令牌。
 */
const FILE = path.join(DATA_DIR, 'sessions.json');

interface SessionRecord {
  createdAt: number;
  lastSeen: number;
  ip: string;
}

let sessions: Record<string, SessionRecord> | null = null;

function load(): Record<string, SessionRecord> {
  if (sessions) return sessions;
  sessions = readJsonSync<Record<string, SessionRecord>>(FILE, {});
  return sessions;
}

function persist(): void {
  const data = load();
  try {
    atomicWriteJsonSync(FILE, data);
    fs.chmodSync(FILE, 0o600);
  } catch (err) {
    logger.warn('会话写盘失败（不影响使用，只是重启后需要重新登录）', String(err));
  }
}

export function ttlMs(hours: number): number {
  return Math.max(1, hours) * 3600 * 1000;
}

export function createSession(ip: string, hours: number): string {
  const id = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  load()[id] = { createdAt: now, lastSeen: now, ip };
  prune(hours);
  persist();
  return id;
}

/** 校验会话；有效时滑动续期（用着就不会过期） */
export function isValidSession(id: string | undefined, hours: number): boolean {
  if (!id) return false;
  const all = load();
  const rec = all[id];
  if (!rec) return false;
  const now = Date.now();
  const ttl = ttlMs(hours);
  // 两种情况失效：绝对有效期到了，或者太久没用
  if (now - rec.createdAt > ttl * 2 || now - rec.lastSeen > ttl) {
    delete all[id];
    persist();
    return false;
  }
  if (now - rec.lastSeen > 60_000) {
    rec.lastSeen = now;
    persist();
  }
  return true;
}

export function destroySession(id: string | undefined): void {
  if (!id) return;
  const all = load();
  if (all[id]) {
    delete all[id];
    persist();
  }
}

/** 清掉所有会话（重置令牌、改密码之类的场景用） */
export function destroyAllSessions(): number {
  const all = load();
  const n = Object.keys(all).length;
  sessions = {};
  persist();
  return n;
}

export function prune(hours: number): number {
  const all = load();
  const now = Date.now();
  const ttl = ttlMs(hours);
  let removed = 0;
  for (const [id, rec] of Object.entries(all)) {
    if (now - rec.createdAt > ttl * 2 || now - rec.lastSeen > ttl) {
      delete all[id];
      removed++;
    }
  }
  if (removed) persist();
  return removed;
}

export function sessionCount(): number {
  return Object.keys(load()).length;
}
