import crypto from 'node:crypto';
import { SCHEDULED_TASKS_FILE } from '../core/paths.ts';
import { atomicWriteJsonSync, readJsonSync } from '../core/fsx.ts';
import type { ScheduledTask } from '../types.ts';

export type ScheduledTaskInput = Omit<ScheduledTask, 'id' | 'createdAt' | 'lastOccurrence' | 'lastAnnouncementOccurrence'>;

export function listScheduledTasks(): ScheduledTask[] {
  const tasks = readJsonSync<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
  return Array.isArray(tasks) ? tasks : [];
}

export function getScheduledTask(id: string): ScheduledTask | undefined {
  return listScheduledTasks().find((task) => task.id === id);
}

export function createScheduledTask(input: ScheduledTaskInput): ScheduledTask {
  const tasks = listScheduledTasks();
  const task: ScheduledTask = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    lastOccurrence: null,
    lastAnnouncementOccurrence: null,
  };
  tasks.push(task);
  atomicWriteJsonSync(SCHEDULED_TASKS_FILE, tasks);
  return task;
}

export function updateScheduledTask(id: string, input: ScheduledTaskInput): ScheduledTask | null {
  const tasks = listScheduledTasks();
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return null;
  const next: ScheduledTask = {
    ...tasks[index],
    ...input,
    id,
    createdAt: tasks[index].createdAt,
    lastOccurrence: tasks[index].lastOccurrence,
    lastAnnouncementOccurrence: tasks[index].lastAnnouncementOccurrence,
  };
  tasks[index] = next;
  atomicWriteJsonSync(SCHEDULED_TASKS_FILE, tasks);
  return next;
}

export function setScheduledTaskEnabled(id: string, enabled: boolean): ScheduledTask | null {
  const tasks = listScheduledTasks();
  const task = tasks.find((item) => item.id === id);
  if (!task) return null;
  task.enabled = enabled;
  atomicWriteJsonSync(SCHEDULED_TASKS_FILE, tasks);
  return task;
}

export function deleteScheduledTask(id: string): boolean {
  const tasks = listScheduledTasks();
  const next = tasks.filter((task) => task.id !== id);
  if (next.length === tasks.length) return false;
  atomicWriteJsonSync(SCHEDULED_TASKS_FILE, next);
  return true;
}

export function markScheduledOccurrence(id: string, occurrence: string, announcement = false): ScheduledTask | null {
  const tasks = listScheduledTasks();
  const task = tasks.find((item) => item.id === id);
  if (!task) return null;
  if (announcement) task.lastAnnouncementOccurrence = occurrence;
  else task.lastOccurrence = occurrence;
  if (!announcement && task.recurrence.mode === 'once') task.enabled = false;
  atomicWriteJsonSync(SCHEDULED_TASKS_FILE, tasks);
  return task;
}
