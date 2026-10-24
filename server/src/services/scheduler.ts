import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../core/logger.ts';
import { instanceConfigFile } from '../core/paths.ts';
import * as I from './instanceService.ts';
import * as sup from './supervisor.ts';
import { loadConfig } from '../config.ts';
import { listScheduledTasks, markScheduledOccurrence } from './scheduledTasks.ts';
import { enqueueActionTask, resumeWaitingBackupJob } from './taskRunner.ts';
import { createJob, listWaitingJobs } from './jobService.ts';

const logger = createLogger('scheduler');
const TICK_MS = 5000;

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localDateTime(date: string, time: string): Date | null {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const result = new Date(year, month - 1, day, hour, minute, 0, 0);
  return dateKey(result) === date ? result : null;
}

function occurrenceFor(task: ReturnType<typeof listScheduledTasks>[number], now: Date): { key: string; at: Date } | null {
  const today = dateKey(now);
  const { mode, time, date, intervalDays } = task.recurrence;
  if (mode === 'once') {
    if (today !== date) return null;
    const at = localDateTime(date, time);
    return at ? { key: `${date}T${time}`, at } : null;
  }
  if (mode === 'interval') {
    if (!date) return null;
    const anchor = new Date(`${date}T00:00:00`);
    const current = new Date(`${today}T00:00:00`);
    const dayDiff = Math.floor((Date.UTC(current.getFullYear(), current.getMonth(), current.getDate()) - Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())) / 86400000);
    if (dayDiff < 0 || dayDiff % Math.max(1, intervalDays) !== 0) return null;
  }
  if (mode === 'weekdays') {
    const weekday = now.getDay() === 0 ? 7 : now.getDay();
    if (!task.recurrence.weekdays?.includes(weekday)) return null;
  }
  const at = localDateTime(today, time);
  return at ? { key: `${today}T${time}`, at } : null;
}

function isInsideDueMinute(at: Date, now: Date): boolean {
  const delta = now.getTime() - at.getTime();
  return delta >= 0 && delta < 60_000;
}

async function tickScheduledTasks(now: Date): Promise<void> {
  for (const task of listScheduledTasks()) {
    if (!task.enabled) continue;
    if (task.recurrence.mode === 'once' && task.recurrence.date < dateKey(now)) {
      const occurrence = `${task.recurrence.date}T${task.recurrence.time}`;
      markScheduledOccurrence(task.id, occurrence);
      const skippedAt = Date.now();
      await createJob({
        kind: task.action,
        title: `错过执行时间：${task.name}`,
        instanceId: task.instanceId,
        source: 'scheduled',
        scheduledTaskId: task.id,
        status: 'skipped',
        stages: [{ key: 'action', label: '定时操作', status: 'cancelled' }],
        lines: [`已跳过：面板在指定执行时间 ${task.recurrence.date} ${task.recurrence.time} 未运行。`],
        progress: 0,
        error: '错过指定执行时间',
        startedAt: skippedAt,
        endedAt: skippedAt,
      });
      continue;
    }
    if (!I.exists(task.instanceId)) continue;
    const occurrence = occurrenceFor(task, now);
    if (!occurrence) continue;

    if (task.announcement.enabled && task.announcement.minutes > 0 && task.lastAnnouncementOccurrence !== occurrence.key) {
      const announceAt = new Date(occurrence.at.getTime() - task.announcement.minutes * 60_000);
      if (isInsideDueMinute(announceAt, now)) {
        markScheduledOccurrence(task.id, occurrence.key, true);
        const message = (task.announcement.text || '服务器将在 {n} 分钟后执行预定操作').replaceAll('{n}', String(task.announcement.minutes));
        void enqueueActionTask({
          instanceId: task.instanceId,
          action: 'broadcast',
          message,
          source: 'scheduled',
          scheduledTaskId: task.id,
          title: `执行前公告「${task.name}」`,
        }).catch((err) => logger.warn(`定时公告任务创建失败：${task.name}`, String(err)));
      }
    }

    if (task.lastOccurrence !== occurrence.key && isInsideDueMinute(occurrence.at, now)) {
      markScheduledOccurrence(task.id, occurrence.key);
      void enqueueActionTask({
        instanceId: task.instanceId,
        action: task.action,
        message: task.message,
        command: task.command,
        source: 'scheduled',
        scheduledTaskId: task.id,
        title: `定时${task.name}`,
      }).catch((err) => logger.warn(`定时任务创建失败：${task.name}`, String(err)));
    }
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
    for (const entry of entries) {
      if (++scanned > 20_000) return false;
      const full = path.join(cur, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(full);
      else if (/\.(mca|mcr)$/.test(entry.name)) return true;
    }
  }
  return false;
}

async function tickAutomaticBackups(): Promise<void> {
  for (const id of I.listInstanceIds()) {
    let cfg: ReturnType<typeof I.getConfig>;
    try {
      cfg = I.getConfig(id);
    } catch {
      continue;
    }
    const state = I.getState(id);
    const policy = cfg.backup;
    const nowSec = Date.now() / 1000;
    if (!sup.isRunning(id) || !policy.autoEnabled || policy.intervalMin <= 0 || nowSec - state.schedule.lastBackup <= policy.intervalMin * 60) continue;
    if (!checkWorldReady(id, cfg.levelName)) {
      logger.info(`[${id}] 世界还没生成完，跳过本次自动备份（不推进计时）`);
      continue;
    }
    void enqueueActionTask({
      instanceId: id,
      action: 'backup',
      backupType: 'auto',
      source: 'system',
      title: `自动备份「${cfg.name}」`,
    }).then(() => {
      I.saveState(id, { schedule: { ...state.schedule, lastBackup: nowSec } });
    }).catch((err) => logger.warn(`[${id}] 自动备份任务创建失败`, String(err)));
  }
}

async function tickWaitingBackups(): Promise<void> {
  const waiting = listWaitingJobs().filter((job) => job.kind === 'backup' && job.source === 'scheduled');
  await Promise.all(waiting.map((job) => resumeWaitingBackupJob(job.id).catch((err) => {
    logger.warn(`延后备份任务恢复失败：${job.title}`, String(err));
  })));
}

async function tick(): Promise<void> {
  const now = new Date();
  await tickScheduledTasks(now);
  await tickWaitingBackups();
  await tickAutomaticBackups();
  const panel = loadConfig();
  const runningIds = I.listInstanceIds().filter((id) => sup.isRunning(id));
  if (runningIds.length > panel.limits.maxRunningInstances) {
    logger.warn(`同时在运行的世界数（${runningIds.length}）超过限额（${panel.limits.maxRunningInstances}）`);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => logger.error('任务调度轮询失败', String(err)));
  }, TICK_MS);
  timer.unref();
  logger.info('任务调度器已启动（5 秒轮询）');
  setTimeout(() => tick().catch((err) => logger.error('任务调度首轮失败', String(err))), 5000).unref();
}

export async function tickNow(): Promise<void> {
  await tick();
}
