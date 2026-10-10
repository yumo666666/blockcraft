import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { JOBS_DIR } from '../core/paths.ts';
import { atomicWriteJsonSync, readJsonSync } from '../core/fsx.ts';
import { notFound } from '../core/errors.ts';
import type { Job } from '../types.ts';

const bus = new EventEmitter();
bus.setMaxListeners(100);

const KEEP = 60;
let pendingSetups = 0;

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
    .sort((a, b) => b.startedAt - a.startedAt);
  return jobs;
}

export function listJobs(): Job[] {
  return readAllJobs().slice(0, KEEP).map(({ lines, ...rest }) => ({ ...rest, lines: [] }) as Job);
}

export function listRunningJobs(): Job[] {
  return readAllJobs()
    .filter((job) => job.status === 'running')
    .map(({ lines, ...rest }) => ({ ...rest, lines: [] }) as Job);
}

export function getJob(jobId: string): Job {
  const job = readJsonSync<Job | null>(file(jobId), null);
  if (!job) throw notFound(`任务不存在：${jobId}`);
  return job;
}

export async function createJob(input: Partial<Job> & { kind: Job['kind']; title: string }): Promise<Job> {
  const job: Job = {
    id: input.id && input.id !== 'boot' ? input.id : `${input.kind}-${Date.now().toString(36)}`,
    kind: input.kind,
    title: input.title,
    instanceId: input.instanceId ?? null,
    status: input.status ?? 'running',
    stages: input.stages ?? [],
    lines: input.lines ?? [],
    progress: input.progress ?? 0,
    error: input.error ?? null,
    startedAt: input.startedAt ?? Date.now(),
    endedAt: input.endedAt ?? null,
  };
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  persist(job);
  bus.emit(job.id, job);
  return job;
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
  const lines = [...job.lines, line].slice(-200);
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
  return updateJob(jobId, {
    status: error ? 'failed' : 'done',
    error: error ?? null,
    endedAt: Date.now(),
    progress: error ? 100 : 100,
  });
}

/** 面板重启后把「运行中」的任务标成 interrupted —— 不假装还能续跑 */
export function markInterrupted(): void {
  try {
    for (const n of fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'))) {
      const job = readJsonSync<Job | null>(path.join(JOBS_DIR, n), null);
      if (job && job.status === 'running') {
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
