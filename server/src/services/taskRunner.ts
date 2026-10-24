import { notFound } from '../core/errors.ts';
import * as I from './instanceService.ts';
import * as sup from './supervisor.ts';
import * as B from './backupService.ts';
import * as frp from './frpService.ts';
import { loadConfig } from '../config.ts';
import { memoryInfo } from './systemService.ts';
import { summarizeAll } from './overview.ts';
import { createJob, enqueueJob, finishJob, logJob, setStage, skipJob } from './jobService.ts';
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

  enqueueJob(job.id, async () => {
    setStage(job.id, 'action', 'running');
    logJob(job.id, `目标世界：${cfg.name}（${input.instanceId}）`);
    try {
      switch (action) {
        case 'start': {
          await withStartGate(async () => {
            if (sup.isRunning(input.instanceId)) throw new SkipTask('世界已经在运行');
            const panel = loadConfig();
            const current = await summarizeAll();
            const running = current.filter((item) => item.status === 'running' || item.status === 'starting');
            if (running.length >= panel.limits.maxRunningInstances) throw new Error(`同时运行的世界已达上限（${panel.limits.maxRunningInstances} 个）`);
            const totalMb = running.reduce((sum, item) => sum + item.memoryMb, 0) + cfg.memoryMb;
            const budgetMb = panel.limits.memoryBudgetMb === 'auto'
              ? Math.round((memoryInfo().totalMb || 8192) * 0.6)
              : panel.limits.memoryBudgetMb;
            if (totalMb > budgetMb) throw new Error(`启动后总内存需求 ${totalMb} MB 超过预算 ${budgetMb} MB`);
            const result = await sup.start(input.instanceId, { wait: true });
            if (!result.ok) throw new Error(result.error ?? '世界启动失败');
          });
          await frp.syncWorlds().catch(() => undefined);
          logJob(job.id, '世界已启动并通过就绪检查');
          break;
        }
        case 'stop': {
          if (!sup.isRunning(input.instanceId) && !await sup.hasActiveProcessEvidence(input.instanceId)) throw new SkipTask('世界当前未运行');
          const result = await sup.stop(input.instanceId, input.stopOptions ?? { message: '任务中心正在停止服务器' });
          if (!result.ok) throw new Error(result.error ?? '世界停止失败');
          logJob(job.id, result.graceful ? '世界已优雅停止' : '世界已停止');
          break;
        }
        case 'save':
          if (!sup.isRunning(input.instanceId)) throw new SkipTask('世界未运行，无法执行 save-all');
          await sup.rcon(input.instanceId, 'save-all');
          logJob(job.id, '已向服务器发送 save-all');
          break;
        case 'broadcast':
          if (!sup.isRunning(input.instanceId)) throw new SkipTask('世界未运行，公告未发送');
          if (!input.message?.trim()) throw new Error('公告内容不能为空');
          await sup.rcon(input.instanceId, `say ${input.message.trim().replace(/[\r\n]+/g, ' ')}`);
          logJob(job.id, `已发送公告：${input.message.trim()}`);
          break;
        case 'restart': {
          if (!sup.isRunning(input.instanceId)) throw new SkipTask('世界未运行，无法重启');
          const result = await sup.restart(input.instanceId);
          if (!result.ok) throw new Error(result.error ?? '世界重启失败');
          await frp.syncWorlds().catch(() => undefined);
          logJob(job.id, '世界已重新启动');
          break;
        }
        case 'command':
          if (!sup.isRunning(input.instanceId)) throw new SkipTask('世界未运行，命令未执行');
          if (!input.command?.trim()) throw new Error('命令不能为空');
          await sup.rcon(input.instanceId, input.command.trim());
          logJob(job.id, `已执行命令：${input.command.trim()}`);
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
          logJob(job.id, `备份完成：${entry.file}`);
          break;
        }
      }
      setStage(job.id, 'action', 'done');
      finishJob(job.id);
    } catch (err) {
      if (err instanceof SkipTask) {
        skipJob(job.id, err.message);
        return;
      }
      throw err;
    }
  });
  return job;
}

export function actionLabel(action: ScheduledAction): string {
  return ACTION_LABEL[action];
}
