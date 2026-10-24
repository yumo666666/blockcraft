import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { INSTANCES_DIR, PROJECT_ROOT } from '../core/paths.ts';
import { bad, conflict } from '../core/errors.ts';
import { audit } from '../core/logger.ts';
import * as I from '../services/instanceService.ts';
import * as sup from '../services/supervisor.ts';
import * as F from '../services/fileManagerService.ts';
import * as PF from '../services/projectFileService.ts';
import * as JAR from '../services/jarFileService.ts';

function requestPath(req: Request): unknown {
  return req.query.path ?? '';
}

function isReadOnly(id: string): boolean {
  const state = I.getState(id);
  return sup.isRunning(id) || ['starting', 'stopping', 'stuck'].includes(state.status);
}

function assertStopped(id: string): void {
  if (isReadOnly(id)) {
    throw conflict('请先停止当前世界，再上传、编辑、创建或删除文件');
  }
}

function contentDisposition(name: string, disposition: 'attachment' | 'inline'): string {
  const fallback = name.replace(/[\r\n"\\]/g, '_').replace(/[^\x20-\x7e]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function streamFile(filePath: string, res: Response, next: NextFunction): void {
  const stream = fs.createReadStream(filePath);
  stream.on('error', (error) => {
    if (!res.headersSent) next(error);
    else res.destroy(error);
  });
  stream.pipe(res);
}

function streamReadableFile(stream: NodeJS.ReadableStream, res: Response, next: NextFunction): void {
  stream.on('error', (error) => {
    if (!res.headersSent) next(error);
    else res.destroy(error);
  });
  stream.pipe(res);
}

function projectPath(req: Request): unknown {
  return req.query.path ?? '';
}

const instanceRootRelative = path.relative(path.resolve(PROJECT_ROOT), path.resolve(INSTANCES_DIR));
const instanceRootParts = instanceRootRelative && instanceRootRelative !== '..' && !instanceRootRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(instanceRootRelative)
  ? instanceRootRelative.split(path.sep)
  : [];

function samePathSegment(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInstanceRoot(parts: string[]): boolean {
  return instanceRootParts.length > 0 && parts.length >= instanceRootParts.length && instanceRootParts.every((part, index) => samePathSegment(parts[index], part));
}

function projectPathParts(rawPath: unknown): string[] {
  return typeof rawPath === 'string' ? rawPath.split('/').filter(Boolean) : [];
}

function canonicalInstanceId(id: string): string | undefined {
  return I.listInstanceIds().find((existing) => samePathSegment(existing, id));
}

function instanceIdInProjectPath(rawPath: unknown): string | undefined {
  if (typeof rawPath !== 'string') return undefined;
  const parts = rawPath ? rawPath.split('/') : [];
  if (!isInstanceRoot(parts) || parts.length <= instanceRootParts.length) return undefined;
  return parts[instanceRootParts.length];
}

function projectWorldId(rawPath: unknown): string | null {
  const candidate = instanceIdInProjectPath(rawPath);
  if (!candidate) return null;
  return canonicalInstanceId(candidate) ?? null;
}

function isWorldRootPath(rawPath: unknown, worldId: string | null): boolean {
  if (!worldId) return false;
  const parts = projectPathParts(rawPath);
  return parts.length === instanceRootParts.length + 1
    && isInstanceRoot(parts)
    && samePathSegment(parts[instanceRootParts.length], worldId);
}

function runningInstance(id: string): boolean {
  const canonical = canonicalInstanceId(id);
  if (!canonical) return false;
  return instanceIsRunning(canonical);
}

function instanceIsRunning(canonical: string): boolean {
  const state = I.getState(canonical);
  return sup.isRunning(canonical) || ['starting', 'stopping', 'stuck'].includes(state.status);
}

function assertProjectWritable(paths: unknown, includeInstancesRoot = false): void {
  const list = Array.isArray(paths) ? paths : [paths];
  for (const value of list) {
    if (typeof value !== 'string') continue;
    const parts = value.split('/').filter(Boolean);
    if (!isInstanceRoot(parts)) continue;
    if (parts.length > instanceRootParts.length) {
      const id = canonicalInstanceId(parts[instanceRootParts.length]);
      if (id && runningInstance(id)) assertStopped(id);
    }
    if (includeInstancesRoot && parts.length === instanceRootParts.length) {
      const active = I.listInstanceIds().find((id) => runningInstance(id));
      if (active) throw conflict('请先停止所有世界，再删除包含世界的 instances 目录');
    }
  }
}

export function registerFileRoutes(app: Express): void {
  app.get('/api/project-files/access', (req, res) => {
    const pathValue = projectPath(req);
    const worldId = projectWorldId(pathValue);
    res.json({ readOnly: typeof pathValue !== 'string' || (worldId ? instanceIsRunning(worldId) : false), worldId });
  });

  app.get('/api/project-files', async (req, res) => {
    const result = await PF.listProjectDirectory(projectPath(req));
    const worldIds = new Map<string, string | null>();
    const getWorldId = (rawPath: unknown): string | null => {
      const candidate = instanceIdInProjectPath(rawPath);
      if (!candidate) return null;
      const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (!worldIds.has(key)) worldIds.set(key, canonicalInstanceId(candidate) ?? null);
      return worldIds.get(key) ?? null;
    };
    const currentWorldId = getWorldId(result.path);
    const currentIsWorldRoot = isWorldRootPath(result.path, currentWorldId);
    const worldAccess = new Map<string, boolean>();
    const worldIsReadOnly = (worldId: string): boolean => {
      if (!worldAccess.has(worldId)) worldAccess.set(worldId, instanceIsRunning(worldId));
      return worldAccess.get(worldId)!;
    };

    // Runtime state is checked only when entering a world root. Child directory
    // listings inherit the cached status in the browser; parent folders do not
    // trigger a status check for every world they contain.
    const currentReadOnly = currentWorldId
      ? currentIsWorldRoot ? worldIsReadOnly(currentWorldId) : null
      : false;
    const entryReadOnly = (entryPath: string): boolean | null => {
      const entryWorldId = getWorldId(entryPath);
      if (!entryWorldId) return false;
      if (currentIsWorldRoot && entryWorldId === currentWorldId) return currentReadOnly;
      return null;
    };
    res.json({
      ...result,
      entries: result.entries.map((entry) => ({ ...entry, readOnly: entryReadOnly(entry.path), worldId: getWorldId(entry.path) })),
      readOnly: currentReadOnly,
      worldId: currentWorldId,
      maxUploadBytes: PF.MAX_UPLOAD_BYTES,
    });
  });

  app.get('/api/project-files/text', async (req, res) => {
    res.json(await PF.getProjectTextFile(projectPath(req)));
  });

  app.get('/api/project-files/preview-info', async (req, res) => {
    res.json(await PF.getProjectFilePreviewInfo(projectPath(req)));
  });

  app.put('/api/project-files/text', express.json({ limit: '16mb' }), async (req, res) => {
    assertProjectWritable(projectPath(req));
    const body = req.body as { content?: unknown; revision?: unknown };
    const result = await PF.saveProjectTextFile(projectPath(req), body?.content, body?.revision);
    audit({ ip: req.ip, action: 'project-file.edit', target: String(projectPath(req) ?? '') });
    res.json({ ok: true, ...result });
  });

  const sendProjectDownload = (req: Request, res: Response, next: NextFunction): void => {
    void PF.resolveProjectDownload(projectPath(req)).then((file) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', file.stat.size);
      res.setHeader('Content-Disposition', contentDisposition(file.name, 'attachment'));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      audit({ ip: req.ip, action: 'project-file.download', target: file.virtualPath, detail: { bytes: file.stat.size } });
      if (req.method === 'HEAD') res.end();
      else streamFile(file.fullPath, res, next);
    }).catch(next);
  };
  app.get('/api/project-files/download', sendProjectDownload);
  app.head('/api/project-files/download', sendProjectDownload);

  app.get('/api/project-files/preview', (req, res, next) => {
    void PF.resolveProjectPreview(projectPath(req)).then((file) => {
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Length', file.stat.size);
      res.setHeader('Content-Disposition', contentDisposition(file.name, 'inline'));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; media-src 'self' data: blob:; font-src data:");
      streamFile(file.fullPath, res, next);
    }).catch(next);
  });

  app.post('/api/project-files/folder', async (req, res) => {
    const body = req.body as { path?: unknown; name?: unknown };
    assertProjectWritable(body?.path ?? '');
    const entry = await PF.createProjectDirectory(body?.path ?? '', body?.name);
    audit({ ip: req.ip, action: 'project-file.mkdir', target: entry.path });
    res.json({ ok: true, entry });
  });

  app.post('/api/project-files/upload', async (req, res) => {
    try {
      assertProjectWritable(projectPath(req));
      if (!req.is('application/octet-stream')) throw bad('文件上传格式无效');
      let filename = '';
      try { filename = decodeURIComponent(String(req.headers['x-blockcraft-filename'] ?? '')); }
      catch { throw bad('文件名编码无效'); }
      const overwrite = req.query.overwrite === '1';
      const entry = await PF.uploadProjectFile(projectPath(req), filename, req, Number(req.headers['content-length'] ?? 0), overwrite);
      audit({ ip: req.ip, action: 'project-file.upload', target: entry.path, detail: { bytes: entry.size, overwrite } });
      res.json({ ok: true, entry });
    } catch (error) {
      if (!req.readableEnded && !req.destroyed) req.resume();
      throw error;
    }
  });

  app.delete('/api/project-files', async (req, res) => {
    const target = projectPath(req);
    assertProjectWritable(target, true);
    const result = await PF.deleteProjectEntries([target]);
    for (const entry of result) audit({ ip: req.ip, action: 'project-file.delete', target: entry.path, detail: { type: entry.type } });
    res.json({ ok: true, ...result[0] });
  });

  app.post('/api/project-files/batch-delete', async (req, res) => {
    const body = req.body as { paths?: unknown };
    assertProjectWritable(body?.paths, true);
    const result = await PF.deleteProjectEntries(body?.paths);
    for (const entry of result) audit({ ip: req.ip, action: 'project-file.delete', target: entry.path, detail: { type: entry.type } });
    res.json({ ok: true, entries: result });
  });

  app.post('/api/project-files/archive', express.json({ limit: '1mb' }), async (req, res, next) => {
    const body = req.body as { paths?: unknown };
    const paths = Array.isArray(body?.paths) ? body.paths : [];
    if (!paths.length) throw bad('请选择要打包下载的文件或文件夹');
    const first = String(paths[0]);
    const archiveName = (first.split('/').filter(Boolean).pop() || 'project-files').replace(/[\r\n"\\]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(`${archiveName}.zip`, 'attachment'));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const result = await PF.writeProjectArchive(paths, res);
      audit({ ip: req.ip, action: 'project-file.archive', target: paths.join(', '), detail: { entries: result.count } });
    } catch (error) {
      if (!res.headersSent) next(error);
      else res.destroy(error as Error);
    }
  });

  app.get('/api/project-files/jar', async (req, res) => {
    res.json(await JAR.listProjectJarDirectory(req.query.archive, req.query.path ?? ''));
  });

  app.get('/api/project-files/jar/text', async (req, res) => {
    res.json(await JAR.getProjectJarTextFile(req.query.archive, req.query.path));
  });

  app.put('/api/project-files/jar/text', express.json({ limit: '16mb' }), async (req, res) => {
    assertProjectWritable(req.query.archive);
    const body = req.body as { content?: unknown; revision?: unknown };
    const result = await JAR.saveProjectJarTextFile(req.query.archive, req.query.path, body?.content, body?.revision);
    audit({ ip: req.ip, action: 'project-jar.edit', target: `${String(req.query.archive ?? '')}!/${String(req.query.path ?? '')}` });
    res.json({ ok: true, ...result });
  });

  app.get('/api/project-files/jar/preview-info', async (req, res) => {
    res.json(await JAR.getProjectJarPreviewInfo(req.query.archive, req.query.path));
  });

  const sendJarDownload = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const file = await JAR.resolveProjectJarEntryMetadata(req.query.archive, req.query.path);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', file.size);
      res.setHeader('Content-Disposition', contentDisposition(file.name, 'attachment'));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      audit({ ip: req.ip, action: 'project-jar.download', target: `${file.archivePath}!/${file.entryPath}`, detail: { bytes: file.size } });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = await JAR.resolveProjectJarEntry(req.query.archive, req.query.path);
      streamReadableFile(stream.stream, res, next);
    } catch (error) { next(error); }
  };
  app.get('/api/project-files/jar/download', sendJarDownload);
  app.head('/api/project-files/jar/download', sendJarDownload);

  app.get('/api/project-files/jar/preview', async (req, res, next) => {
    try {
      const file = await JAR.resolveProjectJarEntry(req.query.archive, req.query.path);
      if (file.size > PF.MAX_PREVIEW_BYTES) {
        file.stream.destroy();
        throw bad('文件超过 64 MB，页面只显示文件信息，请下载后查看');
      }
      if (file.contentType === 'application/octet-stream') {
        file.stream.destroy();
        throw bad('此文件类型以文本或二进制摘要方式预览');
      }
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Length', file.size);
      res.setHeader('Content-Disposition', contentDisposition(file.name, 'inline'));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; media-src 'self' data: blob:; font-src data:");
      streamReadableFile(file.stream, res, next);
    } catch (error) { next(error); }
  });

  app.post('/api/project-files/jar/folder', async (req, res) => {
    const body = req.body as { archive?: unknown; path?: unknown; name?: unknown };
    assertProjectWritable(body?.archive);
    const result = await JAR.createProjectJarDirectory(body?.archive, body?.path ?? '', body?.name);
    audit({ ip: req.ip, action: 'project-jar.mkdir', target: `${String(body?.archive ?? '')}!/${result.entry.path}` });
    res.json({ ok: true, ...result });
  });

  app.post('/api/project-files/jar/upload', async (req, res) => {
    try {
      assertProjectWritable(req.query.archive);
      if (!req.is('application/octet-stream')) throw bad('文件上传格式无效');
      let filename = '';
      try { filename = decodeURIComponent(String(req.headers['x-blockcraft-filename'] ?? '')); }
      catch { throw bad('文件名编码无效'); }
      const overwrite = req.query.overwrite === '1';
      const result = await JAR.uploadProjectJarFile(req.query.archive, req.query.path ?? '', filename, req, Number(req.headers['content-length'] ?? 0), overwrite);
      audit({ ip: req.ip, action: 'project-jar.upload', target: `${String(req.query.archive ?? '')}!/${result.entry.path}`, detail: { bytes: result.entry.size, overwrite } });
      res.json({ ok: true, ...result });
    } catch (error) {
      if (!req.readableEnded && !req.destroyed) req.resume();
      throw error;
    }
  });

  app.delete('/api/project-files/jar', async (req, res) => {
    assertProjectWritable(req.query.archive);
    const result = await JAR.deleteProjectJarEntries(req.query.archive, [req.query.path]);
    audit({ ip: req.ip, action: 'project-jar.delete', target: `${String(req.query.archive ?? '')}!/${String(req.query.path ?? '')}` });
    res.json({ ok: true, ...result, entry: result.entries[0] });
  });

  app.post('/api/project-files/jar/batch-delete', async (req, res) => {
    const body = req.body as { archive?: unknown; paths?: unknown };
    assertProjectWritable(body?.archive);
    const result = await JAR.deleteProjectJarEntries(body?.archive, body?.paths);
    for (const entry of result.entries) audit({ ip: req.ip, action: 'project-jar.delete', target: `${String(body?.archive ?? '')}!/${entry.path}`, detail: { type: entry.type } });
    res.json({ ok: true, ...result });
  });

  app.post('/api/project-files/jar/archive', express.json({ limit: '1mb' }), async (req, res, next) => {
    const body = req.body as { archive?: unknown; paths?: unknown };
    const paths = Array.isArray(body?.paths) ? body.paths : [];
    if (!paths.length) throw bad('请选择要打包下载的 JAR 条目');
    const archivePath = req.query.archive ?? body?.archive;
    const archiveName = String(archivePath ?? 'jar').split('/').filter(Boolean).pop() || 'jar';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(`${archiveName}.zip`, 'attachment'));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const result = await JAR.writeProjectJarArchive(archivePath, paths, res);
      audit({ ip: req.ip, action: 'project-jar.archive', target: `${String(archivePath ?? '')}!/${paths.join(', ')}`, detail: { entries: result.count } });
    } catch (error) {
      if (!res.headersSent) next(error);
      else res.destroy(error as Error);
    }
  });

  app.get('/api/instances/:id/files/access', (req, res) => {
    const { id } = req.params;
    I.getConfig(id);
    res.json({ readOnly: isReadOnly(id) });
  });

  app.get('/api/instances/:id/files', async (req, res) => {
    const { id } = req.params;
    const result = await F.listDirectory(id, requestPath(req));
    res.json({ ...result, running: isReadOnly(id), maxUploadBytes: F.MAX_UPLOAD_BYTES });
  });

  app.get('/api/instances/:id/files/text', async (req, res) => {
    res.json(await F.getTextFile(req.params.id, requestPath(req)));
  });

  app.put('/api/instances/:id/files/text', express.json({ limit: '16mb' }), async (req, res) => {
    const { id } = req.params;
    assertStopped(id);
    const body = req.body as { content?: unknown; revision?: unknown };
    const result = await F.saveTextFile(id, requestPath(req), body?.content, body?.revision);
    audit({ ip: req.ip, action: 'file.edit', target: `${id}/${String(requestPath(req) ?? '')}` });
    res.json({ ok: true, ...result });
  });

  app.get('/api/instances/:id/files/download', (req, res, next) => {
    const { id } = req.params;
    void F.resolveDownload(id, requestPath(req)).then((file) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', file.stat.size);
      res.setHeader('Content-Disposition', contentDisposition(file.name, 'attachment'));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      audit({ ip: req.ip, action: 'file.download', target: `${id}/${file.virtualPath}`, detail: { bytes: file.stat.size } });
      if (req.method === 'HEAD') res.end();
      else streamFile(file.fullPath, res, next);
    }).catch(next);
  });
  app.head('/api/instances/:id/files/download', (req, res, next) => {
    // Express routes HEAD through GET when no explicit HEAD handler is registered.
    // This handler is kept explicit to make the download readiness check predictable.
    void F.resolveDownload(req.params.id, requestPath(req)).then((file) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', file.stat.size);
      res.setHeader('Content-Disposition', contentDisposition(file.name, 'attachment'));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end();
    }).catch(next);
  });

  app.get('/api/instances/:id/files/preview', (req, res, next) => {
    void F.resolvePreview(req.params.id, requestPath(req)).then((file) => {
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Length', file.stat.size);
      res.setHeader('Content-Disposition', contentDisposition(file.name, 'inline'));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // This endpoint is intended for a sandboxed iframe, so no active page content can run.
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; media-src 'self' data: blob:; font-src 'self' data:");
      streamFile(file.fullPath, res, next);
    }).catch(next);
  });

  app.post('/api/instances/:id/files/folder', async (req, res) => {
    const { id } = req.params;
    assertStopped(id);
    const body = req.body as { path?: unknown; name?: unknown };
    const entry = await F.createDirectory(id, body?.path ?? '', body?.name);
    audit({ ip: req.ip, action: 'file.mkdir', target: `${id}/${entry.path}` });
    res.json({ ok: true, entry });
  });

  app.post('/api/instances/:id/files/upload', async (req, res) => {
    const { id } = req.params;
    try {
      assertStopped(id);
      if (!req.is('application/octet-stream')) throw bad('文件上传格式无效');
      let filename = '';
      try {
        filename = decodeURIComponent(String(req.headers['x-blockcraft-filename'] ?? ''));
      } catch {
        throw bad('文件名编码无效');
      }
      const result = await F.uploadFile(
        id,
        requestPath(req),
        filename,
        req,
        Number(req.headers['content-length'] ?? 0),
      );
      audit({ ip: req.ip, action: 'file.upload', target: `${id}/${result.path}`, detail: { bytes: result.size } });
      res.json({ ok: true, entry: result });
    } catch (error) {
      if (!req.readableEnded && !req.destroyed) req.resume();
      throw error;
    }
  });

  app.delete('/api/instances/:id/files', async (req, res) => {
    const { id } = req.params;
    assertStopped(id);
    const result = await F.deleteEntry(id, requestPath(req));
    audit({ ip: req.ip, action: 'file.delete', target: `${id}/${String(requestPath(req) ?? '')}`, detail: { type: result.type } });
    res.json({ ok: true, ...result });
  });
}
