import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from '../core/paths.ts';
import { createLogger } from '../core/logger.ts';

const logger = createLogger('events');

/**
 * 事件总日志：把「哪个世界什么时候开始启动、什么时候就绪、什么时候关闭、什么时候崩溃」
 * 记成一条条带类型的事件，给面板的「日志」页用。
 *
 * 存 JSONL（一行一条），读的时候取尾部 N 条 —— 不需要数据库，也不会越读越慢。
 * 文件超过阈值自动裁掉前半段，避免无限增长。
 */
export type EventKind = 'start' | 'ready' | 'stop' | 'crash' | 'system';

export interface PanelEvent {
  seq: number;
  ts: number;
  kind: EventKind;
  /** 相关世界（系统事件为空） */
  worldId: string | null;
  worldName: string | null;
  text: string;
}

const FILE = path.join(LOG_DIR, 'events.jsonl');
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_KEEP_LINES = 5000;

let seq = 0;
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (last) seq = (JSON.parse(last) as PanelEvent).seq ?? 0;
  } catch {
    /* 文件还不存在，正常 */
  }
}

function trimIfNeeded(): void {
  try {
    const st = fs.statSync(FILE);
    if (st.size <= MAX_BYTES) return;
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    const kept = lines.slice(-MAX_KEEP_LINES);
    fs.writeFileSync(FILE, kept.join('\n') + '\n');
    logger.debug(`事件日志已裁剪到 ${kept.length} 条`);
  } catch {
    /* ignore */
  }
}

export function appendEvent(
  kind: EventKind,
  text: string,
  world?: { id: string; name: string } | null,
): PanelEvent {
  ensureLoaded();
  const ev: PanelEvent = {
    seq: ++seq,
    ts: Date.now(),
    kind,
    worldId: world?.id ?? null,
    worldName: world?.name ?? null,
    text,
  };
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(FILE, `${JSON.stringify(ev)}\n`);
    trimIfNeeded();
  } catch (err) {
    logger.warn('写事件日志失败', String(err));
  }
  return ev;
}

/** 取最近 limit 条（按时间从旧到新，方便像控制台一样追加显示） */
export function listEvents(limit = 200): PanelEvent[] {
  const out: PanelEvent[] = [];
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        out.push(JSON.parse(line) as PanelEvent);
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    /* 文件不存在 = 还没有事件 */
  }
  return out;
}

// ------------------------------------------------------------------ 便捷包装
export function evStart(world: { id: string; name: string }, detail: string): void {
  appendEvent('start', `开始启动（${detail}）`, world);
}

export function evReady(world: { id: string; name: string }, detail = ''): void {
  appendEvent('ready', `启动完成，已就绪${detail ? `（${detail}）` : ''}`, world);
}

export function evStop(world: { id: string; name: string }, detail: string): void {
  appendEvent('stop', `已关闭（${detail}）`, world);
}

export function evCrash(world: { id: string; name: string }, reason: string): void {
  appendEvent('crash', `崩溃：${reason}`, world);
}

export function evSystem(text: string): void {
  appendEvent('system', text, null);
}
