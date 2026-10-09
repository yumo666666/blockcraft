import type { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from '../core/paths.ts';
import { bad, notFound } from '../core/errors.ts';
import { createJob, finishJob, logJob, setStage } from '../services/jobService.ts';
import { installServer } from '../services/installService.ts';
import * as I from '../services/instanceService.ts';
import * as sup from '../services/supervisor.ts';
import * as frp from '../services/frpService.ts';
import { ensureSkinSupport, skinSupportInstallStageLabel } from '../services/skinSupportService.ts';

const PACKS_DIR = path.join(STORE_DIR, 'packs');

interface PackInfo {
  id: string;
  file: string;
  bytes: number;
  uploadedAt: number;
  format: string | null;
  name: string | null;
  mc: string | null;
  loader: string | null;
  loaderVersion: string | null;
  modCount: number | null;
  note: string;
}

export function registerPackRoutes(app: Express): void {
  app.get('/api/packs', async (_req, res) => {
    fs.mkdirSync(PACKS_DIR, { recursive: true });
    const files = fs
      .readdirSync(PACKS_DIR)
      .filter((f) => /\.(zip|mrpack)$/i.test(f))
      .map((f) => {
        const stat = fs.statSync(path.join(PACKS_DIR, f));
        return { id: f, file: path.join(PACKS_DIR, f), bytes: stat.size, uploadedAt: stat.mtimeMs };
      });
    const { inspectPack: inspect } = await import('../services/packService.ts');
    const packs: PackInfo[] = await Promise.all(files.map(async (item) => {
      const info = await inspect(item.file).catch(() => null);
      return {
        ...item,
        format: info?.format ?? null,
        name: info?.packName ?? null,
        mc: info?.mc ?? null,
        loader: info?.loader ?? null,
        loaderVersion: info?.loaderVersion ?? null,
        modCount: info?.modsInZip ?? null,
        note: info?.note ?? '',
      };
    }));
    packs.sort((a, b) => b.uploadedAt - a.uploadedAt);
    res.json({ packs });
  });


  /** 上传整合包（前端用 base64 传，避免引入 multipart 依赖） */
  app.post('/api/packs/upload', (req, res) => {
    const body = req.body as { name?: string; data?: string };
    if (!body.name || !body.data) throw bad('缺少文件内容');
    const safe = path.basename(body.name).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
    if (!/\.(zip|mrpack)$/i.test(safe)) throw bad('只支持 .zip 或 .mrpack');
    const id = `imp-${Date.now()}-${safe}`;
    fs.mkdirSync(PACKS_DIR, { recursive: true });
    const buf = Buffer.from(body.data, 'base64');
    if (buf.length > 2 * 1024 * 1024 * 1024) throw bad('文件太大');
    fs.writeFileSync(path.join(PACKS_DIR, id), buf);
    res.json({ ok: true, id, bytes: buf.length });
  });

  app.delete('/api/packs/:id', (req, res) => {
    const file = path.join(PACKS_DIR, path.basename(req.params.id));
    if (!fs.existsSync(file)) throw notFound('整合包不存在');
    fs.rmSync(file, { force: true });
    res.json({ ok: true });
  });

  /** 导入整合包：解析 → 建实例 → 装加载器 → 解压 overrides → 启动 */
  app.post('/api/packs/:id/import', async (req, res) => {
    const body = req.body as { name?: string; mc?: string; loader?: never; loaderVersion?: string; memoryMb?: number; start?: boolean };
    if (!body.name) throw bad('请填写新世界的名称');
    if (!body.mc) throw bad('请指定 Minecraft 版本');
    const packFile = path.join(PACKS_DIR, path.basename(req.params.id));
    if (!fs.existsSync(packFile)) throw notFound('整合包不存在');
    const cfg = await I.createInstance({
      name: body.name,
      mc: body.mc,
      loader: body.loader as never,
      loaderVersion: body.loaderVersion,
      memoryMb: body.memoryMb,
      importedFrom: { file: path.basename(packFile), format: 'zip' },
      createdFrom: { type: 'import' },
    });
    const job = await createJob({
      kind: 'import',
      title: `导入整合包 →「${cfg.name}」`,
      instanceId: cfg.id,
      stages: [
        { key: 'install', label: '安装服务端与加载器', status: 'pending' },
        { key: 'extract', label: '解压整合包内容', status: 'pending' },
        { key: 'skin', label: skinSupportInstallStageLabel(), status: 'pending' },
        { key: 'frp', label: '映射远端端口', status: 'pending' },
        { key: 'start', label: '启动世界', status: 'pending' },
      ],
    });
    void (async () => {
      try {
        setStage(job.id, 'install', 'running');
        await installServer(cfg.id, (line) => logJob(job.id, line));
        setStage(job.id, 'install', 'done');
        setStage(job.id, 'extract', 'running');
        const { extractPack } = await import('../services/packService.ts');
        await extractPack(packFile, cfg.id, (line) => logJob(job.id, line));
        setStage(job.id, 'extract', 'done');
        setStage(job.id, 'skin', 'running');
        await ensureSkinSupport(cfg.id, (line) => logJob(job.id, line));
        setStage(job.id, 'skin', 'done');
        setStage(job.id, 'frp', 'running');
        const remote = await frp.ensureRemotePort(cfg.id);
        await frp.syncWorlds().catch(() => undefined);
        logJob(job.id, `远端端口 ${remote} 已映射`);
        setStage(job.id, 'frp', 'done');
        if (body.start !== false) {
          setStage(job.id, 'start', 'running');
          const r = await sup.start(cfg.id, { wait: true });
          logJob(job.id, r.ok ? '世界已启动' : `启动失败：${r.error}`);
          setStage(job.id, 'start', r.ok ? 'done' : 'failed');
        } else {
          setStage(job.id, 'start', 'done', '跳过启动');
        }
        finishJob(job.id);
      } catch (err) {
        logJob(job.id, `失败：${String(err)}`);
        finishJob(job.id, String(err));
      }
    })();
    res.json({ ok: true, instanceId: cfg.id, jobId: job.id });
  });
}
