import type { Express } from 'express';
import { bad } from '../core/errors.ts';
import { audit } from '../core/logger.ts';
import * as I from '../services/instanceService.ts';
import * as sup from '../services/supervisor.ts';
import { invalidateModCount } from '../services/overview.ts';
import * as M from '../services/modService.ts';

const isRunning = (id: string) => sup.isRunning(id);

export function registerModRoutes(app: Express): void {
  app.get('/api/instances/:id/mods', async (req, res) => {
    const id = req.params.id;
    const result = await M.listMods(id, {
      q: req.query.q as string | undefined,
      source: req.query.source as string | undefined,
      status: (req.query.status as 'enabled' | 'disabled' | 'all') ?? 'all',
      page: Number(req.query.page ?? 1),
      size: Number(req.query.size ?? 24),
    });
    res.json(result);
  });

  app.get('/api/instances/:id/mods/:file/detail', async (req, res) => {
    res.json(await M.modDetail(req.params.id, req.params.file));
  });

  app.put('/api/instances/:id/mods/:file', async (req, res) => {
    const id = req.params.id;
    const file = req.params.file;
    const enabled = Boolean((req.body as { enabled?: boolean })?.enabled);
    await M.setEnabled(id, file, enabled, { isRunning });
    invalidateModCount(id);
    audit({ ip: req.ip, action: 'mod.toggle', target: `${id}/${file}`, detail: { enabled } });
    res.json({ ok: true });
  });

  app.delete('/api/instances/:id/mods/:file', async (req, res) => {
    const id = req.params.id;
    if (req.query.confirm !== '1') throw bad('删除 MOD 需要二次确认');
    const file = req.params.file;
    await M.deleteMod(id, file, { isRunning });
    invalidateModCount(id);
    audit({ ip: req.ip, action: 'mod.delete', target: `${id}/${file}` });
    res.json({ ok: true });
  });

  app.post('/api/instances/:id/mods/upload', async (req, res) => {
    const id = req.params.id;
    const files = (req.body as { files?: { name: string; data: string }[] })?.files ?? [];
    if (!files.length) throw bad('没有收到文件');
    // 注意签名是 (id, files, loader, opts)：loader 必传，否则 opts 会被顶到 loader 位置上，
    // assertStopped 就完全失效了（子代理实测发现的真 bug）
    const cfg = I.getConfig(id);
    const result = await M.importMods(id, files, cfg.loader, { isRunning });
    invalidateModCount(id);
    audit({ ip: req.ip, action: 'mod.import', target: id, detail: { count: result.added.length } });
    res.json(result);
  });

  app.post('/api/instances/:id/mods/from-url', async (req, res) => {
    const id = req.params.id;
    const url = String((req.body as { url?: string })?.url ?? '').trim();
    if (!/^https?:\/\//.test(url)) throw bad('请填写 http(s) 开头的链接');
    const cfg = I.getConfig(id);
    const result = await M.downloadFromUrl(id, url, cfg.loader, { isRunning });
    invalidateModCount(id);
    audit({ ip: req.ip, action: 'mod.download', target: id, detail: { url } });
    res.json(result);
  });

  app.post('/api/instances/:id/mods/check-updates', async (req, res) => {
    res.json({ updates: await M.checkUpdates(req.params.id) });
  });

  app.get('/api/instances/:id/mods/missing-deps', async (req, res) => {
    res.json({ missing: await M.missingDependencies(req.params.id) });
  });
}
