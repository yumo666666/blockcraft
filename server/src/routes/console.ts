import type { Express } from 'express';
import { bad } from '../core/errors.ts';
import * as I from '../services/instanceService.ts';
import * as sup from '../services/supervisor.ts';
import { describe, nextRun, tickNow } from '../services/scheduler.ts';

const SHORTCUTS_DEFAULT = ['list', 'save-all', 'time set day', 'weather clear', 'whitelist list'];

export function registerConsoleRoutes(app: Express): void {
  app.get('/api/instances/:id/console', (req, res) => {
    const id = req.params.id;
    const since = Number(req.query.since ?? 0);
    const buf = sup.console_(id);
    const lines = since > 0 ? buf.since(since) : buf.tail(Number(req.query.lines ?? 300));
    res.json({ lines, seq: buf.seq });
  });

  app.get('/api/instances/:id/console/stream', (req, res) => {
    const id = req.params.id;
    if (!I.exists(id)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `世界不存在：${id}` } });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const since = Number(req.query.since ?? 0);
    const buf = sup.console_(id);
    let lastSeq = since;
    if (since > 0) {
      for (const l of buf.since(since)) {
        res.write(`data: ${JSON.stringify(l)}\n\n`);
        lastSeq = l.seq;
      }
    } else {
      for (const l of buf.tail(200)) res.write(`data: ${JSON.stringify(l)}\n\n`);
      lastSeq = buf.seq;
    }
    const onLine = (l: { seq: number }) => {
      res.write(`data: ${JSON.stringify(l)}\n\n`);
      lastSeq = l.seq;
    };
    buf.on('line', onLine);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      buf.off('line', onLine);
      clearInterval(ping);
    });
    void lastSeq;
  });

  app.post('/api/instances/:id/command', async (req, res) => {
    const id = req.params.id;
    const cmd = String((req.body as { cmd?: string })?.cmd ?? '').trim();
    if (!cmd) throw bad('命令不能为空');
    if (!sup.isRunning(id)) throw bad('这个世界没有在运行，无法执行命令');
    if (cmd.length > 1000) throw bad('命令太长');
    const buf = sup.console_(id);
    buf.push(`[面板] > ${cmd}`);
    const out = await sup.rcon(id, cmd).catch((err) => {
      buf.push(`[面板] 命令执行失败：${String(err)}`);
      return '';
    });
    if (out) buf.push(out);
    res.json({ ok: true, output: out });
  });

  app.get('/api/instances/:id/shortcuts', (req, res) => {
    res.json({ shortcuts: SHORTCUTS_DEFAULT });
  });

  app.get('/api/instances/:id/schedule', (req, res) => {
    const cfg = I.getConfig(req.params.id);
    const state = I.getState(req.params.id);
    res.json({
      schedule: cfg.schedule,
      describe: describe(cfg),
      nextStart: nextRun(cfg.schedule.start),
      nextStop: nextRun(cfg.schedule.stop),
      pendingStop: state.pendingStop,
      fired: state.fired,
    });
  });

  app.put('/api/instances/:id/schedule', (req, res) => {
    const id = req.params.id;
    const body = req.body as Record<string, unknown>;
    const cfg = I.getConfig(id);
    const next = {
      ...cfg.schedule,
      ...(body as unknown as typeof cfg.schedule),
    } as typeof cfg.schedule;
    I.saveConfig(id, { schedule: next });
    const saved = I.getConfig(id);
    res.json({ ok: true, schedule: saved.schedule, describe: describe(saved), nextStart: nextRun(saved.schedule.start), nextStop: nextRun(saved.schedule.stop) });
  });

  app.post('/api/instances/:id/schedule/test-warn', async (req, res) => {
    const id = req.params.id;
    const cfg = I.getConfig(id);
    const n = Number((req.body as { minutes?: number })?.minutes ?? cfg.schedule.warnMinutes);
    const text = (cfg.schedule.warnText || '服务器将在 {n} 分钟后关闭').replace('{n}', String(n));
    const cmd = cfg.schedule.warnCommand ? cfg.schedule.warnCommand.replace('{n}', String(n)).replace('{text}', text) : `say ${text}`;
    if (!sup.isRunning(id)) throw bad('世界没有在运行，无法测试公告');
    await sup.rcon(id, cmd);
    res.json({ ok: true, text });
  });

  app.get('/api/scheduler/upcoming', (_req, res) => {
    const out = I.listInstanceIds().map((id) => {
      const cfg = I.getConfig(id);
      return {
        id,
        name: cfg.name,
        describe: describe(cfg),
        nextStart: nextRun(cfg.schedule.start),
        nextStop: nextRun(cfg.schedule.stop),
        pendingStop: I.getState(id).pendingStop,
      };
    });
    res.json({ instances: out });
  });

  app.post('/api/scheduler/tick', async (_req, res) => {
    await tickNow();
    res.json({ ok: true });
  });
}
