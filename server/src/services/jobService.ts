import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { JOBS_DIR } from '../core/paths.ts';
import { atomicWriteJsonSync, readJsonSync } from '../core/fsx.ts';
import { conflict, notFound } from '../core/errors.ts';
import type { Job } from '../types.ts';
import { evBackup, evStartupFailed } from './eventLog.ts';
import { dispatchNotification, type NotificationTopic } from './notificationService.ts';
import * as I from './instanceService.ts';

const bus = new EventEmitter();
bus.setMaxListeners(100);

let pendingSetups = 0;
const abortControllers = new Map<string, AbortController>();
const queue: string[] = [];
const active = new Set<string>();
export const MAX_CONCURRENT_JOBS = 5;
const runners = new Map<string, () => Promise<void>>();

/** Count API requests that have begun creating a job but have not returned its job ID yet. */
export function beginJobSetup(): () => void {
  pendingSetups += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    pendingSetups = Math.max(0, pendingSetups - 1);
  };
}

export function pendingJobSetups(): number {
  return pendingSetups;
}

export function jobQueueSummary(): { running: number; queued: number; limit: number } {
  return { running: active.size, queued: queue.length, limit: MAX_CONCURRENT_JOBS };
}

function file(jobId: string): string {
  return path.join(JOBS_DIR, `${jobId}.json`);
}

function readAllJobs(): Job[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const jobs = names
    .map((n) => readJsonSync<Job | null>(path.join(JOBS_DIR, n), null))
    .filter((j): j is Job => Boolean(j))
    .sort((a, b) => (b.createdAt ?? b.startedAt) - (a.createdAt ?? a.startedAt));
  return jobs;
}

export function listJobs(): Job[] {
  return readAllJobs().map(({ lines, ...rest }) => ({ ...rest, lines: [] }) as Job);
}

export function listRunningJobs(): Job[] {
  return readAllJobs()
    .filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'cancelling')
    .map(({ lines, ...rest }) => ({ ...rest, lines: [] }) as Job);
}

export function getJob(jobId: string): Job {
  const job = readJsonSync<Job | null>(file(jobId), null);
  if (!job) throw notFound(`任务不存在：${jobId}`);
  return job;
}

export async function createJob(input: Partial<Job> & { kind: Job['kind']; title: string }): Promise<Job> {
  const createdAt = input.createdAt ?? Date.now();
  const job: Job = {
    id: input.id ? input.id : `${input.kind}-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind: input.kind,
    title: input.title,
    instanceId: input.instanceId ?? null,
    status: input.status ?? 'queued',
    source: input.source ?? 'operation',
    scheduledTaskId: input.scheduledTaskId ?? null,
    createdAt,
    stages: input.stages ?? [],
    lines: input.lines ?? [],
    progress: input.progress ?? 0,
    error: input.error ?? null,
    startedAt: input.startedAt ?? Date.now(),
    endedAt: input.endedAt ?? null,
  };
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  if (job.status === 'running') abortControllers.set(job.id, new AbortController());
  persist(job);
  bus.emit(job.id, job);
  return job;
}

/** Execute all panel operations through one FIFO queue with a five-job limit. */
export function enqueueJob(jobId: string, runner: () => Promise<void>): void {
  const job = getJob(jobId);
  if (job.status !== 'queued') throw conflict('只有排队中的任务可以加入执行队列');
  runners.set(jobId, runner);
  queue.push(jobId);
  bus.emit(jobId, getJob(jobId));
  pumpQueue();
}

function pumpQueue(): void {
  while (active.size < MAX_CONCURRENT_JOBS && queue.length) {
    const jobId = queue.shift()!;
    const runner = runners.get(jobId);
    runners.delete(jobId);
    if (!runner) continue;
    let job: Job;
    try {
      job = getJob(jobId);
    } catch {
      continue;
    }
    if (job.status !== 'queued') continue;
    active.add(jobId);
    abortControllers.set(jobId, new AbortController());
    updateJob(jobId, { status: 'running', startedAt: Date.now(), error: null });
    void (async () => {
      try {
        await runner();
      } catch (err) {
        const message = String(err);
        try {
          logJob(jobId, `失败：${message}`);
          finishJob(jobId, message);
        } catch {
          /* A route may already have finalized the job. */
        }
      } finally {
        try {
          const latest = getJob(jobId);
          if (latest.status === 'running' || latest.status === 'cancelling') finishJob(jobId);
        } catch {
          /* The history file may have been removed during shutdown cleanup. */
        }
        active.delete(jobId);
        abortControllers.delete(jobId);
        pumpQueue();
      }
    })();
  }
}

function persist(job: Job): void {
  atomicWriteJsonSync(file(job.id), job);
}

export function updateJob(jobId: string, patch: Partial<Job>): Job {
  const job = getJob(jobId);
  const next = { ...job, ...patch };
  persist(next);
  bus.emit(jobId, next);
  return next;
}

export function logJob(jobId: string, line: string): Job {
  const job = getJob(jobId);
  // Pack imports may need to explain hundreds of missing files/dependencies.
  // Keep enough history for the complete manual-install list to remain visible.
  const lines = [...job.lines, line].slice(-1000);
  return updateJob(jobId, { lines });
}

export function setStage(jobId: string, key: string, status: Job['stages'][number]['status'], label?: string): Job {
  const job = getJob(jobId);
  const stages = job.stages.map((s) => (s.key === key ? { ...s, status, label: label ?? s.label } : s));
  const done = stages.filter((s) => s.status === 'done').length;
  const progress = stages.length ? Math.round((done / stages.length) * 100) : job.progress;
  return updateJob(jobId, { stages, progress });
}

export function finishJob(jobId: string, error?: string): Job {
  const controller = abortControllers.get(jobId);
  const current = getJob(jobId);
  const wasTerminal = ['cancelled', 'done', 'failed', 'skipped', 'interrupted'].includes(current.status);
  const cancelled = current.status === 'cancelling' || controller?.signal.aborted === true;
  const stages = cancelled
    ? current.stages.map((stage) => stage.status === 'pending' || stage.status === 'running'
      ? { ...stage, status: 'cancelled' as const }
      : stage)
    : error
      ? current.stages.map((stage) => stage.status === 'running'
        ? { ...stage, status: 'failed' as const }
        : stage.status === 'pending'
          ? { ...stage, status: 'cancelled' as const }
          : stage)
      : current.stages;
  const result = updateJob(jobId, {
    status: cancelled ? 'cancelled' : error ? 'failed' : 'done',
    error: cancelled ? null : error ?? null,
    stages,
    endedAt: Date.now(),
    progress: cancelled || error ? current.progress : 100,
  });
  abortControllers.delete(jobId);
  if (!wasTerminal && !cancelled) {
    const detail = error ?? current.lines.at(-1) ?? '任务已完成';
    const world = current.instanceId
      ? (() => {
          try { return { id: current.instanceId!, name: I.getConfig(current.instanceId!).name }; }
          catch { return null; }
        })()
      : null;
    if (error) {
      if (current.kind === 'start' || current.kind === 'restart') {
        if (world) evStartupFailed(world, error);
        else dispatchNotification({ topic: 'startup_failed', title: current.title, body: error });
      } else if (current.kind === 'backup') {
        if (world) evBackup(world, false, error);
        else dispatchNotification({ topic: 'backup_failed', title: current.title, body: error });
      } else {
        dispatchNotification({ topic: 'task_failed', title: current.title, body: error, worldName: world?.name });
      }
    } else {
      const topic: NotificationTopic | null = current.kind === 'start' || current.kind === 'restart'
        ? null // Ready notifications come from the server's Done log line.
        : current.kind === 'stop' ? 'world_stop_success'
          : current.kind === 'backup' && !/清理/.test(current.title) ? 'backup_success'
            : current.kind === 'save' ? 'save_success'
              : current.kind === 'command' ? 'command_success'
                : current.kind === 'broadcast' ? 'broadcast_success'
                  : 'task_success';
      if (current.kind === 'backup' && world && !/清理/.test(current.title)) evBackup(world, true, detail);
      else if (topic) dispatchNotification({ topic, title: current.title, body: detail, worldName: world?.name });
    }
  }
  return result;
}

export function skipJob(jobId: string, reason: string): Job {
  const current = getJob(jobId);
  const stages = current.stages.map((stage) => stage.status === 'pending' || stage.status === 'running'
    ? { ...stage, status: 'cancelled' as const, label: `${stage.label}（已跳过）` }
    : stage);
  logJob(jobId, `已跳过：${reason}`);
  return updateJob(jobId, { status: 'skipped', error: reason, stages, endedAt: Date.now() });
}

export function jobSignal(jobId: string): AbortSignal | undefined {
  return abortControllers.get(jobId)?.signal;
}

export function requestJobCancellation(jobId: string): Job {
  const job = getJob(jobId);
  if (job.status === 'queued') {
    const index = queue.indexOf(jobId);
    if (index >= 0) queue.splice(index, 1);
    runners.delete(jobId);
    const cancelled = updateJob(jobId, { status: 'cancelled', error: null, endedAt: Date.now() });
    pumpQueue();
    return cancelled;
  }
  if (job.kind !== 'create' && job.kind !== 'import' && job.kind !== 'pack-import') throw conflict('当前类型的任务不能取消');
  if (job.status === 'cancelling') return job;
  if (job.status !== 'running') throw conflict('任务已经结束，不能取消');
  const controller = abortControllers.get(jobId);
  if (!controller) throw conflict('任务进度已失效，请刷新后重试');
  controller.abort(new Error(job.kind === 'create' ? '用户取消了新建世界' : '用户取消了整合包导入'));
  return updateJob(jobId, { status: 'cancelling', error: null });
}

/** 面板重启后把「运行中」的任务标成 interrupted —— 不假装还能续跑 */
export function markInterrupted(): void {
  try {
    for (const n of fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'))) {
      const job = readJsonSync<Job | null>(path.join(JOBS_DIR, n), null);
      if (job && (job.status === 'queued' || job.status === 'running' || job.status === 'cancelling')) {
        atomicWriteJsonSync(path.join(JOBS_DIR, n), { ...job, status: 'interrupted', endedAt: Date.now() });
      }
    }
  } catch {
    /* ignore */
  }
}

export function subscribe(jobId: string, listener: (job: Job) => void): () => void {
  bus.on(jobId, listener);
  return () => bus.off(jobId, listener);
}

export function waitForJob(jobId: string): Promise<Job> {
  const terminal = (job: Job) => ['cancelled', 'done', 'failed', 'skipped', 'interrupted'].includes(job.status);
  const current = getJob(jobId);
  if (terminal(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const listener = (job: Job) => {
      if (!terminal(job)) return;
      bus.off(jobId, listener);
      resolve(job);
    };
    bus.on(jobId, listener);
  });
}
