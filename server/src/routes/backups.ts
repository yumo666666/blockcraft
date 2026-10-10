import type { Express } from 'express';
import { bad, badBilingual, notFound } from '../core/errors.ts';
import { audit } from '../core/logger.ts';
import * as I from '../services/instanceService.ts';
import * as sup from '../services/supervisor.ts';
import * as B from '../services/backupService.ts';

export function registerBackupRoutes(app: Express): void {
  app.get('/api/instances/:id/backups', (req, res) => {
    const id = req.params.id;
    const cfg = I.getConfig(id);
    const backups = B.listBackups(id);
    res.json({
      backups,
      usage: B.backupUsage(id),
      policy: cfg.backup,
      running: sup.isRunning(id),
    });
  });

  app.get('/api/instances/:id/backups/:file/download', (req, res, next) => {
    const { id, file } = req.params;
    I.getConfig(id);
    const target = B.backupPath(id, file);
    audit({ ip: req.ip, action: 'backup.download', target: `${id}/${file}` });
    res.download(target, file, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  app.post('/api/instances/:id/backups/upload', async (req, res) => {
    const id = req.params.id;
    const cfg = I.getConfig(id);
    if (!req.is('application/octet-stream')) {
      req.resume();
      throw badBilingual('请上传 BlockCraft 备份 ZIP 文件', 'Upload a BlockCraft backup ZIP file.');
    }
    let originalName = '';
    try {
      originalName = decodeURIComponent(String(req.headers['x-blockcraft-filename'] ?? ''));
    } catch {
      req.resume();
      throw badBilingual('备份文件名无效', 'The backup file name is invalid.');
    }
    if (!originalName.toLowerCase().endsWith('.zip')) {
      req.resume();
      throw badBilingual('只支持 .zip 格式的 BlockCraft 备份', 'Only BlockCraft .zip backups are supported.');
    }
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (contentLength > B.MAX_BACKUP_UPLOAD_BYTES) {
      req.resume();
      res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: '备份 ZIP 超过 20 GB 上传限制',
          message_en: 'Backup ZIP exceeds the 20 GB upload limit.',
        },
      });
      return;
    }
    const entry = await B.importBackup(id, originalName, req, {
      name: cfg.name,
      mc: cfg.mc,
      loader: cfg.loader,
    });
    audit({ ip: req.ip, action: 'backup.upload', target: `${id}/${entry.file}`, detail: { bytes: entry.bytes, regions: entry.regions } });
    res.json({ ok: true, entry });
  });

  app.post('/api/instances/:id/backups', async (req, res) => {
    const id = req.params.id;
    const cfg = I.getConfig(id);
    try {
      const entry = await B.createBackup({
        instanceId: id,
        name: cfg.name,
        mc: cfg.mc,
        loader: cfg.loader,
        levelName: cfg.levelName,
        policy: cfg.backup,
        isRunning: () => sup.isRunning(id),
      }, 'manual');
      audit({ ip: req.ip, action: 'backup.create', target: id, detail: { file: entry.file } });
      res.json({ ok: true, entry });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(425).json({ error: { code: 'NOT_READY', message: msg } });
    }
  });

  app.delete('/api/instances/:id/backups/:file', (req, res) => {
    const { id, file } = req.params;
    if (req.query.confirm !== '1') throw bad('删除备份需要二次确认');
    B.deleteBackup(id, file);
    audit({ ip: req.ip, action: 'backup.delete', target: `${id}/${file}` });
    res.json({ ok: true });
  });

  app.post('/api/instances/:id/backups/:file/rollback', async (req, res) => {
    const { id, file } = req.params;
    const confirm = String((req.body as { confirm?: string })?.confirm ?? '');
    if (confirm !== file) throw bad('请输入完整的备份文件名以确认回退');
    const cfg = I.getConfig(id);
    const entry = B.listBackups(id).find((b) => b.file === file);
    if (!entry) throw notFound('备份不存在');
    const stages: string[] = [];
    const result = await B.rollback(id, file, {
      levelName: cfg.levelName,
      stop: async () => {
        await sup.stop(id, { message: '服务器正在回档，即将关闭' });
      },
      start: async () => {
        const r = await sup.start(id, { wait: true });
        if (!r.ok) throw new Error(r.error ?? '回退后启动失败');
      },
      onStage: (stage) => stages.push(stage),
    });
    audit({ ip: req.ip, action: 'backup.rollback', target: `${id}/${file}`, detail: result });
    res.json({ ok: true, ...result, stages });
  });

  app.post('/api/instances/:id/backups/cleanup', (req, res) => {
    const id = req.params.id;
    const cfg = I.getConfig(id);
    const dryRun = Boolean((req.body as { dryRun?: boolean })?.dryRun);
    if (dryRun) {
      const plan = B.planCleanup(id, cfg.backup, cfg.backup.maxTotalMb);
      res.json({ ok: true, plan });
      return;
    }
    void B.runCleanup(id, cfg.backup)
      .then((r) => res.json({ ok: true, result: r }))
      .catch((err) => res.status(500).json({ error: { code: 'INTERNAL', message: String(err) } }));
  });

  app.get('/api/jobs', (_req, res) => {
    import('../services/jobService.ts').then((m) => res.json({
      jobs: m.listJobs(),
      runningJobs: m.listRunningJobs(),
      pendingSetups: m.pendingJobSetups(),
    }));
  });

  app.get('/api/jobs/:jobId', (req, res) => {
    import('../services/jobService.ts').then((m) => {
      try {
        res.json(m.getJob(req.params.jobId));
      } catch {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: '任务不存在' } });
      }
    });
  });

  app.get('/api/jobs/:jobId/stream', (req, res) => {
    const jobId = req.params.jobId;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    import('../services/jobService.ts').then((m) => {
      const push = (job: unknown) => res.write(`data: ${JSON.stringify(job)}\n\n`);
      try {
        push(m.getJob(jobId));
      } catch {
        push({ error: '任务不存在' });
      }
      const off = m.subscribe(jobId, push);
      req.on('close', off);
    });
  });
}
