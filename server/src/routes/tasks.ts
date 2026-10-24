import type { Express } from 'express';
import { bad, notFound } from '../core/errors.ts';
import * as I from '../services/instanceService.ts';
import { listJobs, getJob } from '../services/jobService.ts';
import { createScheduledTask, deleteScheduledTask, getScheduledTask, listScheduledTasks, setScheduledTaskEnabled, updateScheduledTask, type ScheduledTaskInput } from '../services/scheduledTasks.ts';
import { enqueueActionTask } from '../services/taskRunner.ts';
import type { ScheduledAction } from '../types.ts';

const ACTIONS = new Set<ScheduledAction>(['start', 'stop', 'save', 'broadcast', 'restart', 'backup', 'command']);
const ANNOUNCEMENT_ACTIONS = new Set<ScheduledAction>(['start', 'stop', 'restart', 'command']);

function validateInput(value: unknown): ScheduledTaskInput {
  const body = (value ?? {}) as Record<string, unknown>;
  const instanceId = String(body.instanceId ?? '').trim();
  if (!instanceId || !I.exists(instanceId)) throw bad('请选择一个有效的目标世界');
  const action = String(body.action ?? '') as ScheduledAction;
  if (!ACTIONS.has(action)) throw bad('请选择有效的任务内容');
  const recurrenceRaw = (body.recurrence ?? {}) as Record<string, unknown>;
  const mode = String(recurrenceRaw.mode ?? '') as 'daily' | 'weekdays' | 'once' | 'interval';
  if (!['daily', 'weekdays', 'once', 'interval'].includes(mode)) throw bad('请选择定时方式');
  const weekdaysRaw = Array.isArray(recurrenceRaw.weekdays) ? recurrenceRaw.weekdays : [];
  const weekdays = [...new Set(weekdaysRaw.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b);
  if (mode === 'weekdays' && weekdays.length === 0) throw bad('至少选择一个执行日');
  const time = String(recurrenceRaw.time ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad('执行时间格式应为 HH:mm');
  const date = String(recurrenceRaw.date ?? '');
  if ((mode === 'once' || mode === 'interval') && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('请选择有效日期');
  if (date) {
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() + 1 !== month || parsed.getDate() !== day) throw bad('日期无效');
    if (mode === 'once' && parsed < new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) throw bad('单次任务日期不能早于今天');
    if (mode === 'once' && parsed.getFullYear() === new Date().getFullYear() && parsed.getMonth() === new Date().getMonth() && parsed.getDate() === new Date().getDate()) {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (time <= currentTime) throw bad('单次任务执行时间需要晚于当前时间');
    }
  }
  const intervalDays = Number(recurrenceRaw.intervalDays ?? 1);
  if (mode === 'interval' && (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365)) throw bad('间隔天数需要在 1 到 365 天之间');
  const message = String(body.message ?? '').trim().slice(0, 500);
  const command = String(body.command ?? '').trim().slice(0, 1000);
  if (action === 'broadcast' && !message) throw bad('公告内容不能为空');
  if (action === 'command' && !command) throw bad('请输入要执行的服务器命令');
  const announceRaw = (body.announcement ?? {}) as Record<string, unknown>;
  const announcement = {
    enabled: ANNOUNCEMENT_ACTIONS.has(action) && Boolean(announceRaw.enabled),
    minutes: Math.max(1, Math.min(1440, Math.floor(Number(announceRaw.minutes) || 5))),
    text: String(announceRaw.text ?? '').trim().slice(0, 500) || '服务器将在 {n} 分钟后执行预定操作',
  };
  return {
    name: String(body.name ?? '').trim().slice(0, 80) || `${action} 定时任务`,
    instanceId,
    action,
    message,
    command,
    recurrence: {
      mode: mode === 'weekdays' && weekdays.length === 7 ? 'daily' : mode,
      time,
      date: mode === 'daily' || mode === 'weekdays' ? '' : date,
      intervalDays: mode === 'interval' ? intervalDays : 1,
      weekdays: mode === 'daily' || (mode === 'weekdays' && weekdays.length === 7) ? [1, 2, 3, 4, 5, 6, 7] : weekdays,
    },
    announcement,
    enabled: body.enabled !== false,
  };
}

export function registerTaskRoutes(app: Express): void {
  app.get('/api/tasks', (req, res) => {
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(req.query.pageSize) || 20)));
    const type = String(req.query.type ?? 'all');
    const target = String(req.query.target ?? 'all');
    const status = String(req.query.status ?? 'all');
    const filtered = listJobs().filter((job) => {
      if (type !== 'all' && job.kind !== type) return false;
      if (target === 'panel' && job.instanceId !== null) return false;
      if (target !== 'all' && target !== 'panel' && job.instanceId !== target) return false;
      if (status !== 'all' && job.status !== status) return false;
      return true;
    });
    res.json({ total: filtered.length, page, pageSize, tasks: filtered.slice((page - 1) * pageSize, page * pageSize) });
  });

  app.get('/api/tasks/scheduled', (_req, res) => {
    res.json({ tasks: listScheduledTasks(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  app.post('/api/tasks/scheduled', (req, res) => {
    const task = createScheduledTask(validateInput(req.body));
    res.status(201).json({ ok: true, task });
  });

  app.put('/api/tasks/scheduled/:id', (req, res) => {
    const task = updateScheduledTask(req.params.id, validateInput(req.body));
    if (!task) throw notFound('定时任务不存在');
    res.json({ ok: true, task });
  });

  app.patch('/api/tasks/scheduled/:id', (req, res) => {
    const enabled = Boolean((req.body as { enabled?: unknown })?.enabled);
    const task = setScheduledTaskEnabled(req.params.id, enabled);
    if (!task) throw notFound('定时任务不存在');
    res.json({ ok: true, task });
  });

  app.delete('/api/tasks/scheduled/:id', (req, res) => {
    if (!deleteScheduledTask(req.params.id)) throw notFound('定时任务不存在');
    res.json({ ok: true });
  });

  app.post('/api/tasks/scheduled/:id/run', async (req, res) => {
    const task = getScheduledTask(req.params.id);
    if (!task) throw notFound('定时任务不存在');
    const job = await enqueueActionTask({
      instanceId: task.instanceId,
      action: task.action,
      message: task.message,
      command: task.command,
      source: 'scheduled',
      scheduledTaskId: task.id,
      title: `手动执行：${task.name}`,
    });
    res.status(202).json({ ok: true, jobId: job.id, status: getJob(job.id).status });
  });

  app.get('/api/tasks/:id', (req, res) => {
    try {
      res.json(getJob(req.params.id));
    } catch {
      throw notFound('任务记录不存在');
    }
  });
}
