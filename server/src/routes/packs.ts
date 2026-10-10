import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { STORE_DIR } from '../core/paths.ts';
import { bad, conflict, notFound } from '../core/errors.ts';
import { createJob, finishJob, jobSignal, logJob, setStage } from '../services/jobService.ts';
import { installServer } from '../services/installService.ts';
import * as I from '../services/instanceService.ts';
import * as sup from '../services/supervisor.ts';
import * as frp from '../services/frpService.ts';
import { ensureSkinSupport, skinSupportInstallStageLabel } from '../services/skinSupportService.ts';
import { loadConfig } from '../config.ts';
import type { Loader } from '../types.ts';

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


  /**
   * 上传整合包。新前端以 octet-stream 直接流式传文件，避免 Base64 将文件膨胀
   * 约 1/3，也避免将整个压缩包常驻在 JSON 请求体和进程内存中。
   * 保留 JSON 分支，兼容旧版面板客户端。
   */
  app.post('/api/packs/upload', async (req, res) => {
    const maxBytes = 2 * 1024 * 1024 * 1024;
    let name = '';
    let legacyData = '';
    if (req.is('application/octet-stream')) {
      try {
        name = decodeURIComponent(String(req.headers['x-blockcraft-filename'] ?? ''));
      } catch {
        throw bad('文件名无效 / Invalid filename.');
      }
    } else {
      const body = req.body as { name?: string; data?: string };
      name = String(body?.name ?? '');
      legacyData = String(body?.data ?? '');
    }
    if (!name || (!req.is('application/octet-stream') && !legacyData)) throw bad('缺少文件内容 / No file content was received.');
    const safe = path.basename(name).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
    if (!/\.(zip|mrpack)$/i.test(safe)) throw bad('只支持 .zip 或 .mrpack / Only .zip and .mrpack files are supported.');
    fs.mkdirSync(PACKS_DIR, { recursive: true });

    if (!req.is('application/octet-stream')) {
      const buf = Buffer.from(legacyData, 'base64');
      if (buf.length > maxBytes) throw bad('整合包超过 2 GB 限制 / Pack exceeds the 2 GB upload limit.');
      const id = `imp-${Date.now()}-${safe}`;
      fs.writeFileSync(path.join(PACKS_DIR, id), buf);
      res.json({ ok: true, id, bytes: buf.length });
      return;
    }

    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (contentLength > maxBytes) {
      req.resume();
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '整合包超过 2 GB 限制', message_en: 'Pack exceeds the 2 GB upload limit.' } });
      return;
    }

    const id = `imp-${Date.now()}-${safe}`;
    const temp = path.join(PACKS_DIR, `.${id}.${randomUUID()}.part`);
    let handle: FileHandle | undefined;
    let bytes = 0;
    let tooLarge = false;
    try {
      handle = await fs.promises.open(temp, 'wx');
      for await (const value of req) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.length;
        if (bytes > maxBytes) {
          tooLarge = true;
          continue; // Drain the request so the client receives a structured 413 response.
        }
        await handle.writeFile(chunk);
      }
      await handle.close();
      handle = undefined;
      if (tooLarge) {
        await fs.promises.rm(temp, { force: true });
        res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '整合包超过 2 GB 限制', message_en: 'Pack exceeds the 2 GB upload limit.' } });
        return;
      }
      await fs.promises.rename(temp, path.join(PACKS_DIR, id));
      res.json({ ok: true, id, bytes });
    } catch (err) {
      await handle?.close().catch(() => undefined);
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!res.headersSent && !res.destroyed && ['ENOSPC', 'EACCES', 'EPERM', 'EROFS'].includes(String(code))) {
        res.status(500).json({
          error: {
            code: 'UPLOAD_STORAGE',
            message: '无法写入整合包，请检查磁盘空间和数据目录权限',
            message_en: 'Could not save the pack. Check available disk space and data-directory permissions.',
            detail: code,
          },
        });
        return;
      }
      throw err;
    }
  });

  app.delete('/api/packs/:id', (req, res) => {
    const file = path.join(PACKS_DIR, path.basename(req.params.id));
    if (!fs.existsSync(file)) throw notFound('整合包不存在');
    fs.rmSync(file, { force: true });
    res.json({ ok: true });
  });

  /** 导入整合包：解析 → 建实例 → 装加载器 → 解压 overrides → 启动 */
  app.post('/api/packs/:id/import', async (req, res) => {
    if (sup.isPanelShutdownRequested()) throw conflict('BlockCraft 正在关闭，暂时不能导入整合包');
    const body = req.body as { name?: string; mc?: string; loader?: Loader; loaderVersion?: string; memoryMb?: number; start?: boolean };
    if (!body.name) throw bad('请填写新世界的名称');
    if (!body.mc) throw bad('请指定 Minecraft 版本');
    const packFile = path.join(PACKS_DIR, path.basename(req.params.id));
    if (!fs.existsSync(packFile)) throw notFound('整合包不存在');
    const { inspectPack, validatePackRuntimeSelection } = await import('../services/packService.ts');
    const packInfo = await inspectPack(packFile);
    if (packInfo.format === 'curseforge' && !loadConfig().mirrors.curseforgeApiKey.trim()) {
      throw conflict('导入 CurseForge 整合包前需要先配置 API Key。请到「设置」填写并保存 API Key，然后返回「导入整合包」重新选择并导入。新建世界不受此限制。 / A CurseForge API Key is required to import this pack. Add and save it in Settings, then return to Import and select the pack again. This does not affect creating a new world.');
    }
    const runtime = validatePackRuntimeSelection(packInfo, {
      mc: String(body.mc ?? ''),
      loader: String(body.loader ?? ''),
      loaderVersion: String(body.loaderVersion ?? ''),
    });
    const cfg = await I.createInstance({
      name: body.name,
      mc: runtime.mc,
      loader: runtime.loader as Loader,
      loaderVersion: runtime.loaderVersion,
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
      const signal = jobSignal(job.id);
      try {
        setStage(job.id, 'install', 'running');
        await installServer(cfg.id, (line) => logJob(job.id, line), { signal });
        signal?.throwIfAborted();
        setStage(job.id, 'install', 'done');
        setStage(job.id, 'extract', 'running');
        const { extractPack } = await import('../services/packService.ts');
        const extracted = await extractPack(packFile, cfg.id, (line) => logJob(job.id, line), { signal });
        signal?.throwIfAborted();
        if (extracted.manual.length) {
          logJob(job.id, `以下 ${extracted.manual.length} 个模组或依赖未能自动安装：`);
          for (const item of extracted.manual) logJob(job.id, `  • ${item}`);
          logJob(job.id, '请按日志中的文件名、文件 ID 或项目 ID 手动补齐；完整错误原因见上方下载日志。');
          const incompleteMessage = `导入未完成：${extracted.manual.length} 个模组或必需依赖未能安装，已跳过启动。 / Import incomplete: ${extracted.manual.length} mods or required dependencies could not be installed; server startup was skipped.`;
          setStage(job.id, 'extract', 'failed', `需手动处理 ${extracted.manual.length} 项`);
          setStage(job.id, 'skin', 'failed', '依赖未完整安装，未执行');
          setStage(job.id, 'frp', 'failed', '依赖未完整安装，未执行');
          setStage(job.id, 'start', 'failed', '依赖未完整安装，已跳过启动');
          throw new Error(incompleteMessage);
        }
        setStage(job.id, 'extract', 'done');
        setStage(job.id, 'skin', 'running');
        await ensureSkinSupport(cfg.id, (line) => logJob(job.id, line), { signal });
        signal?.throwIfAborted();
        setStage(job.id, 'skin', 'done');
        setStage(job.id, 'frp', 'running');
        const remote = await frp.ensureRemotePort(cfg.id);
        signal?.throwIfAborted();
        await frp.syncWorlds().catch(() => undefined);
        logJob(job.id, `远端端口 ${remote} 已映射`);
        setStage(job.id, 'frp', 'done');
        if (body.start !== false) {
          setStage(job.id, 'start', 'running');
          const r = await sup.start(cfg.id, { wait: true, signal });
          signal?.throwIfAborted();
          logJob(job.id, r.ok ? '世界已启动' : `启动失败：${r.error}`);
          setStage(job.id, 'start', r.ok ? 'done' : 'failed');
        } else {
          setStage(job.id, 'start', 'done', '跳过启动');
        }
        finishJob(job.id);
      } catch (err) {
        if (signal?.aborted) {
          const reason = '导入任务已取消；已保留新建世界和已下载内容，可在总览中删除世界。 / Import cancelled. The new world and downloaded files were kept; you can remove the world from Overview.';
          logJob(job.id, reason);
          if (sup.isRunning(cfg.id)) {
            logJob(job.id, '正在安全停止刚启动的世界…');
            const stopped = await sup.stop(cfg.id, { message: '整合包导入已取消' }).catch((stopError) => ({ ok: false, error: String(stopError) }));
            if (!stopped.ok) logJob(job.id, `世界未能自动停止：${stopped.error ?? '未知错误'}`);
          }
          finishJob(job.id);
          return;
        }
        logJob(job.id, `失败：${String(err)}`);
        finishJob(job.id, String(err));
      }
    })();
    res.json({ ok: true, instanceId: cfg.id, jobId: job.id });
  });
}
