import { AppError, notFound } from '../core/errors.ts';
import * as I from './instanceService.ts';
import * as sup from './supervisor.ts';
import * as B from './backupService.ts';
import * as frp from './frpService.ts';
import { loadConfig } from '../config.ts';
import { memoryInfo } from './systemService.ts';
import { summarizeAll } from './overview.ts';
import { createJob, deferJob, enqueueJob, finishJob, getJob, logJob, setStage, skipJob, updateJob } from './jobService.ts';
import type { Job, ScheduledAction } from '../types.ts';
import type { StopOptions } from './supervisor.ts';

const ACTION_LABEL: Record<ScheduledAction, string> = {
  start: '启动世界',
  stop: '停止世界',
  save: '执行 save-all',
  broadcast: '发送公告',
  restart: '重启世界',
  backup: '创建备份',
  command: '执行命令',
};

class SkipTask extends Error {}
let startGate: Promise<void> = Promise.resolve();

async function withStartGate<T>(operation: () => Promise<T>): Promise<T> {
  const previous = startGate;
  let release!: () => void;
  startGate = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function enqueueActionTask(input: {
  instanceId: string;
  action: ScheduledAction;
  message?: string;
  command?: string;
  stopOptions?: StopOptions;
  backupType?: 'manual' | 'auto';
  title?: string;
  source?: Job['source'];
  scheduledTaskId?: string | null;
}): Promise<Job> {
  if (!I.exists(input.instanceId)) throw notFound(`世界不存在：${input.instanceId}`);
  const cfg = I.getConfig(input.instanceId);
  const action = input.action;
  const job = await createJob({
    kind: action,
    title: input.title ?? `${ACTION_LABEL[action]}「${cfg.name}」`,
    instanceId: input.instanceId,
    source: input.source ?? 'operation',
    scheduledTaskId: input.scheduledTaskId ?? null,
    stages: [{ key: 'action', label: ACTION_LABEL[action], status: 'pending' }],
  });

  enqueueJob(job.id, createActionRunner(job.id, input, cfg));
  return job;
}

function createActionRunner(
  jobId: string,
  input: {
    instanceId: string;
    action: ScheduledAction;
    message?: string;
    command?: string;
    stopOptions?: StopOptions;
    backupType?: 'manual' | 'auto';
    title?: string;
    source?: Job['source'];
    scheduledTaskId?: string | null;
  },
  cfg: ReturnType<typeof I.getConfig>,
): () => Promise<void> {
  const action = input.action;
  return async () => {
    if (action === 'backup' && input.source === 'scheduled' && sup.isRunning(input.instanceId)) {
      deferJob(jobId, '任务执行时目标世界正在运行，已延后等待目标世界停止；停止后自动执行备份。');
      return;
    }

    setStage(jobId, 'action', 'running');
    logJob(jobId, `目标世界：${cfg.name}（${input.instanceId}）`);
    try {
      switch (action) {
        case 'start': {
          await withStartGate(async () => {
            if (sup.isRunning(input.instanceId)) throw new SkipTask('任务执行时世界已在运行状态，已跳过启动操作');
            await sup.withStartupPreparation(input.instanceId, '正在检查启动条件', async () => {
              const panel = loadConfig();
              const current = await summarizeAll();
              // This world's preparing status is already exposed to the overview;
              // exclude it here because its memory is added explicitly below.
              const running = current.filter((item) => item.id !== input.instanceId && (item.status === 'running' || item.status === 'starting'));
              if (running.length >= panel.limits.maxRunningInstances) throw new Error(`同时运行的世界已达上限（${panel.limits.maxRunningInstances} 个）`);
              const totalMb = running.reduce((sum, item) => sum + item.memoryMb, 0) + cfg.memoryMb;
              const budgetMb = panel.limits.memoryBudgetMb === 'auto'
                ? Math.round((memoryInfo().totalMb || 8192) * 0.6)
                : panel.limits.memoryBudgetMb;
              if (totalMb > budgetMb) throw new Error(`启动后总内存需求 ${totalMb} MB 超过预算 ${budgetMb} MB`);
              const result = await sup.start(input.instanceId, { wait: true });
              if (!result.ok) throw new Error(result.error ?? '世界启动失败');
            });
          });
          await frp.syncWorlds().catch(() => undefined);
          logJob(jobId, '世界已启动并通过就绪检查');
          break;
        }
        case 'stop': {
          if (!sup.isRunning(input.instanceId) && !await sup.hasActiveProcessEvidence(input.instanceId)) throw new SkipTask('任务执行时世界未在运行状态，已跳过停止操作');
          const result = await sup.stop(input.instanceId, input.stopOptions ?? { message: '任务中心正在停止服务器' });
          if (!result.ok) throw new Error(result.error ?? '世界停止失败');
          logJob(jobId, result.graceful ? '世界已优雅停止' : '世界已停止');
          break;
        }
        case 'save':
          if (!sup.isRunning(input.instanceId)) throw new SkipTask('任务执行时世界未在运行状态，已跳过保存操作');
          await sup.rcon(input.instanceId, 'save-all');
          logJob(jobId, '已向服务器发送 save-all');
          break;
        case 'broadcast':
          if (!sup.isRunning(input.instanceId)) throw new SkipTask('任务执行时世界未在运行状态，已跳过公告发送');
          if (!input.message?.trim()) throw new Error('公告内容不能为空');
          await sup.rcon(input.instanceId, `say ${input.message.trim().replace(/[\r\n]+/g, ' ')}`);
          logJob(jobId, `已发送公告：${input.message.trim()}`);
          break;
        case 'restart': {
          if (!sup.isRunning(input.instanceId)) throw new SkipTask('任务执行时世界未在运行状态，已跳过重启操作');
          const result = await sup.restart(input.instanceId);
          if (!result.ok) throw new Error(result.error ?? '世界重启失败');
          await frp.syncWorlds().catch(() => undefined);
          logJob(jobId, '世界已重新启动');
          break;
        }
        case 'command':
          if (!sup.isRunning(input.instanceId)) throw new SkipTask('任务执行时世界未在运行状态，已跳过命令执行');
          if (!input.command?.trim()) throw new Error('命令不能为空');
          await sup.rcon(input.instanceId, input.command.trim());
          logJob(jobId, `已执行命令：${input.command.trim()}`);
          break;
        case 'backup': {
          const entry = await B.createBackup({
            instanceId: input.instanceId,
            name: cfg.name,
            mc: cfg.mc,
            loader: cfg.loader,
            levelName: cfg.levelName,
            policy: cfg.backup,
            isRunning: () => sup.isRunning(input.instanceId),
          }, input.backupType ?? 'manual');
          logJob(jobId, `备份完成：${entry.file}`);
          break;
        }
      }
      setStage(jobId, 'action', 'done');
      finishJob(jobId);
    } catch (err) {
      if (err instanceof SkipTask) {
        skipJob(jobId, err.message);
        return;
      }
      if (action === 'backup' && input.source === 'scheduled' && err instanceof AppError && err.code === 'BUSY' && sup.isRunning(input.instanceId)) {
        deferJob(jobId, '备份过程中目标世界重新启动，已延后等待目标世界停止；停止后自动重试备份。');
        return;
      }
      throw err;
    }
  };
}

/** Resume a persisted scheduled backup after its world is fully stopped. */
export async function resumeWaitingBackupJob(jobId: string): Promise<void> {
  let job: Job;
  try {
    job = getJob(jobId);
  } catch {
    return;
  }
  if (job.status !== 'waiting' || job.kind !== 'backup' || job.source !== 'scheduled' || !job.instanceId) return;
  try {
    if (sup.isRunning(job.instanceId) || await sup.hasActiveProcessEvidence(job.instanceId)) return;
  } catch (err) {
    const message = `无法确认目标世界状态：${String(err)}`;
    logJob(jobId, message);
    finishJob(jobId, message);
    return;
  }

  const latest = getJob(jobId);
  if (latest.status !== 'waiting') return;
  let cfg: ReturnType<typeof I.getConfig>;
  try {
    cfg = I.getConfig(job.instanceId);
  } catch (err) {
    logJob(jobId, `目标世界已不可用：${String(err)}`);
    finishJob(jobId, `目标世界已不可用：${String(err)}`);
    return;
  }

  logJob(jobId, '目标世界已停止，备份任务已加入执行队列');
  updateJob(jobId, { status: 'queued', error: null, endedAt: null });
  enqueueJob(jobId, createActionRunner(jobId, {
    instanceId: job.instanceId,
    action: 'backup',
    backupType: 'manual',
    source: 'scheduled',
    scheduledTaskId: job.scheduledTaskId,
    title: job.title,
  }, cfg));
}

export function actionLabel(action: ScheduledAction): string {
  return ACTION_LABEL[action];
}
