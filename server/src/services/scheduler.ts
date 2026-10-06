import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../core/logger.ts';
import { instanceConfigFile } from '../core/paths.ts';
import * as I from './instanceService.ts';
import * as sup from './supervisor.ts';
import { createBackup } from './backupService.ts';
import { loadConfig } from '../config.ts';
import type { InstanceConfig } from '../types.ts';

const logger = createLogger('scheduler');
const TICK_MS = 60_000;

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 1=周一 … 7=周日 */
function isoDay(d: Date): number {
  const day = d.getDay();
  return day === 0 ? 7 : day;
}

export function normalizeTimes(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : String(input ?? '').split(/[,，、\s]+/);
  const out = new Set<string>();
  for (const raw of arr) {
    const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) continue;
    out.add(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
  }
  return [...out].sort();
}

export function normalizeDays(input: unknown): number[] {
  const arr = Array.isArray(input) ? input : String(input ?? '').split(/[,，、\s]+/);
  const out = new Set<number>();
  for (const raw of arr) {
    const n = Number(String(raw).trim());
    if (n >= 1 && n <= 7) out.add(n);
  }
  return [...out].sort();
}

function matches(rule: { enabled: boolean; times: string[]; days: number[] }, now: Date): boolean {
  if (!rule.enabled || !rule.times.length) return false;
  if (!rule.times.includes(hhmm(now))) return false;
  if (rule.days.length && !rule.days.includes(isoDay(now))) return false;
  return true;
}

/** 下一次命中时间（用于「延迟关闭」的上界与界面倒计时） */
export function nextRun(rule: { enabled: boolean; times: string[]; days: number[] }, from = new Date()): number | null {
  if (!rule.enabled || !rule.times.length) return null;
  const probe = new Date(from.getTime());
  probe.setSeconds(0, 0);
  probe.setMinutes(probe.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 8; i++) {
    if (rule.times.includes(hhmm(probe)) && (!rule.days.length || rule.days.includes(isoDay(probe)))) {
      return probe.getTime();
    }
    probe.setMinutes(probe.getMinutes() + 1);
  }
  return null;
}

export function describe(cfg: InstanceConfig): string {
  const fmt = (r: { enabled: boolean; times: string[]; days: number[] }) => {
    if (!r.enabled || !r.times.length) return '未启用';
    const days = r.days.length ? '周' + r.days.join('/') : '每天';
    return `${days} ${r.times.join('、')}`;
  };
  return `开服：${fmt(cfg.schedule.start)}；停服：${fmt(cfg.schedule.stop)}`;
}

interface WarnState {
  /** `${action}:${YYYY-MM-DD HH:MM}` → 已发出的阶段，避免重复公告 */
  warned: Map<string, Set<number>>;
}
const warns: WarnState = { warned: new Map() };

async function tick(): Promise<void> {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${hhmm(now)}`;
  for (const id of I.listInstanceIds()) {
    let cfg: InstanceConfig;
    try {
      cfg = I.getConfig(id);
    } catch {
      continue;
    }
    const state = I.getState(id);
    const running = sup.isRunning(id);

    // ---- 停服前 N 分钟公告
    const stopAt = nextRun(cfg.schedule.stop, now);
    if (cfg.schedule.stop.enabled && stopAt && cfg.schedule.warnMinutes > 0 && running) {
      const minutesLeft = Math.round((stopAt - now.getTime()) / 60000);
      if (minutesLeft > 0 && minutesLeft <= cfg.schedule.warnMinutes) {
        const key = `stop:${new Date(stopAt).getFullYear()}-${new Date(stopAt).getMonth() + 1}-${new Date(stopAt).getDate()} ${hhmm(new Date(stopAt))}`;
        const sent = warns.warned.get(key) ?? new Set<number>();
        if (!sent.has(minutesLeft)) {
          sent.add(minutesLeft);
          warns.warned.set(key, sent);
          const text = (cfg.schedule.warnText || '服务器将在 {n} 分钟后关闭，请及时下线').replace('{n}', String(minutesLeft));
          try {
            const cmd = cfg.schedule.warnCommand
              ? cfg.schedule.warnCommand.replace('{n}', String(minutesLeft)).replace('{text}', text)
              : `say ${text}`;
            await sup.rcon(id, cmd);
            logger.info(`[${id}] 停服公告 ${minutesLeft} 分钟`, { text });
          } catch (err) {
            logger.debug(`[${id}] 公告下发失败（RCON 可能没开）`, String(err));
          }
        }
      }
    }

    // ---- 到点执行
    const startHit = matches({ ...cfg.schedule.start, times: normalizeTimes(cfg.schedule.start.times) }, now);
    const stopHit = matches({ ...cfg.schedule.stop, times: normalizeTimes(cfg.schedule.stop.times) }, now);
    let fired: Record<string, string> = { ...state.fired };

    if (stopHit) {
      const key = `stop:${stamp}`;
      if (!fired[key]) {
        if (!running) {
          fired[key] = 'skip(already-stopped)';
        } else {
          const info = await sup.listPlayers(id).catch(() => ({ online: 0, max: 0, names: [] as string[] }));
          if (cfg.schedule.skipIfPlayers && info.online > 0) {
            const deadline = nextRun(cfg.schedule.start, now) ?? now.getTime() + 24 * 3600 * 1000;
            const capped =
              cfg.schedule.graceMinutes > 0 ? Math.min(deadline, now.getTime() + cfg.schedule.graceMinutes * 60000) : deadline;
            I.saveState(id, { pendingStop: { since: now.getTime(), deadline: capped, at: hhmm(now) } });
            fired[key] = `deferred(${info.online}-players-online)`;
            logger.info(`[${id}] 到点停服但因有玩家在线而挂起`, { online: info.online });
          } else {
            logger.info(`[${id}] 定时停服`);
            await sup.stop(id, { message: '定时停服时间到，服务器正在关闭' });
            fired[key] = 'stopped';
          }
        }
      }
    }

    if (startHit) {
      const key = `start:${stamp}`;
      if (!fired[key]) {
        if (running) {
          fired[key] = 'skip(already-running)';
        } else {
          logger.info(`[${id}] 定时开服`);
          const res = await sup.start(id, { wait: true });
          fired[key] = res.ok ? 'started' : `failed(${res.error ?? ''})`;
        }
      }
    }

    // ---- 挂起的延迟关闭
    const pending = I.getState(id).pendingStop;
    if (pending) {
      if (!running) {
        I.saveState(id, { pendingStop: null });
      } else if (Date.now() > pending.deadline) {
        logger.info(`[${id}] 延迟关闭已过期，取消`);
        I.saveState(id, { pendingStop: null });
      } else {
        const info = await sup.listPlayers(id).catch(() => ({ online: 0, max: 0, names: [] as string[] }));
        if (info.online === 0) {
          logger.info(`[${id}] 最后一名玩家已下线，执行挂起的关闭`);
          I.saveState(id, { pendingStop: null });
          await sup.stop(id, { message: '服务器关闭中' });
        }
      }
    }

    // ---- 自动保存 / 自动备份
    const policy = cfg.backup;
    const nowSec = Date.now() / 1000;
    if (running && policy.autoEnabled && policy.intervalMin > 0 && nowSec - state.schedule.lastBackup > policy.intervalMin * 60) {
      const worldReady = checkWorldReady(id, cfg.levelName);
      if (!worldReady) {
        logger.info(`[${id}] 世界还没生成完，跳过这次自动备份（不推进计时）`);
      } else {
        try {
          await createBackup(
            {
              instanceId: id,
              name: cfg.name,
              mc: cfg.mc,
              loader: cfg.loader,
              levelName: cfg.levelName,
              policy,
              isRunning: () => sup.isRunning(id),
            },
            'auto',
          );
          logger.info(`[${id}] 自动备份完成`);
        } catch (err) {
          logger.warn(`[${id}] 自动备份失败`, String(err));
        }
        I.saveState(id, { schedule: { ...state.schedule, lastBackup: nowSec } });
      }
    }

    if (Object.keys(fired).length > 200) {
      const keys = Object.keys(fired).slice(-200);
      fired = Object.fromEntries(keys.map((k) => [k, fired[k]]));
    }
    if (JSON.stringify(fired) !== JSON.stringify(state.fired)) I.saveState(id, { fired });
  }

  // ---- 全局限额：超过同时运行数时给手机推一条通知
  const panel = loadConfig();
  const runningIds = I.listInstanceIds().filter((id) => sup.isRunning(id));
  if (runningIds.length > panel.limits.maxRunningInstances) {
    logger.warn(`同时在运行的世界数（${runningIds.length}）超过限额（${panel.limits.maxRunningInstances}）`);
  }
}

function checkWorldReady(id: string, levelName: string): boolean {
  const dir = path.join(path.dirname(instanceConfigFile(id)), 'server', levelName || 'world');
  try {
    const levelDat = fs.statSync(path.join(dir, 'level.dat'));
    if (levelDat.size < 200) return false;
  } catch {
    return false;
  }
  // 至少要有一个区域文件（.mca/.mcr）
  const stack = [dir];
  let scanned = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++scanned > 20000) return false;
      const full = path.join(cur, e.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (/\.(mca|mcr)$/.test(e.name)) return true;
    }
  }
  return false;
}

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => logger.error('调度轮询失败', String(err)));
  }, TICK_MS);
  timer.unref();
  logger.info('定时调度器已启动（60 秒轮询）');
  // 启动时也跑一次，便于立刻接上挂起的任务
  setTimeout(() => tick().catch((err) => logger.error('调度首轮失败', String(err))), 5000);
}

export async function tickNow(): Promise<void> {
  await tick();
}
