import type { Express } from 'express';
import { bad } from '../core/errors.ts';
import { audit } from '../core/logger.ts';
import * as I from '../services/instanceService.ts';
import * as P from '../services/playerService.ts';

function requirePlayerName(name: string): void {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw bad('玩家名不合法');
}

function skinError(err: unknown): never {
  throw bad(err instanceof Error ? err.message : String(err));
}

export function registerPlayerRoutes(app: Express): void {
  app.get('/api/skin-pool', (_req, res) => {
    res.json({ skins: P.listSkinPool().map((skin) => ({
      ...skin,
      imageUrl: `/api/skin-pool/${skin.id}/image`,
      previewUrl: `/api/skin-pool/${skin.id}/preview`,
      previewReady: P.skinPoolPreviewReady(skin.id),
    })) });
  });

  app.post('/api/skin-pool', (req, res) => {
    const body = req.body as { name?: string; model?: string; data?: string; previewData?: string };
    if (!body.data?.startsWith('data:image/png;base64,')) throw bad('请上传 PNG 皮肤');
    if (body.previewData && !body.previewData.startsWith('data:image/png;base64,')) throw bad('渲染预览不是有效的 PNG');
    let skin: P.SkinPoolItem;
    try {
      skin = P.addSkinToPool(
        body.name ?? '',
        body.model === 'slim' ? 'slim' : 'classic',
        Buffer.from(body.data.split(',')[1], 'base64'),
        body.previewData ? Buffer.from(body.previewData.split(',')[1], 'base64') : undefined,
      );
    } catch (err) {
      skinError(err);
    }
    audit({ ip: req.ip, action: 'skin-pool.add', target: skin!.id, detail: { name: skin!.name } });
    res.json({ ok: true, skin: {
      ...skin!,
      imageUrl: `/api/skin-pool/${skin!.id}/image`,
      previewUrl: `/api/skin-pool/${skin!.id}/preview`,
      previewReady: P.skinPoolPreviewReady(skin!.id),
    } });
  });

  app.get('/api/skin-pool/:id/image', (req, res) => {
    const bytes = P.skinPoolImage(req.params.id);
    if (!bytes) throw bad('皮肤池图片不存在');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(bytes);
  });

  app.get('/api/skin-pool/:id/preview', (req, res) => {
    const bytes = P.skinPoolPreviewImage(req.params.id);
    if (!bytes) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(bytes);
  });

  app.post('/api/skin-pool/:id/preview', (req, res) => {
    const body = req.body as { data?: string };
    if (!body.data?.startsWith('data:image/png;base64,')) throw bad('请上传渲染后的 PNG 预览');
    let ok: boolean;
    try {
      ok = P.saveSkinPoolPreview(req.params.id, Buffer.from(body.data.split(',')[1], 'base64'));
    } catch (err) {
      skinError(err);
    }
    if (!ok!) throw bad('皮肤池条目不存在');
    res.json({ ok: true });
  });

  app.delete('/api/skin-pool/:id', (req, res) => {
    if (!P.removeSkinFromPool(req.params.id)) throw bad('皮肤池条目不存在');
    audit({ ip: req.ip, action: 'skin-pool.delete', target: req.params.id });
    res.json({ ok: true });
  });

  app.get('/api/instances/:id/players/online', async (req, res) => {
    const list = await P.listOnlinePlayers(req.params.id);
    res.json({ online: list.onlineNames.length, names: list.onlineNames, serverOnline: list.serverOnline });
  });

  app.get('/api/instances/:id/players', async (req, res) => {
    res.json(await P.listPlayers(req.params.id));
  });

  // Keep these more specific skin routes ahead of /players/:name/:action.
  app.get('/api/instances/:id/players/:name/skin', async (req, res) => {
    const { id, name } = req.params;
    requirePlayerName(name);
    const cfg = I.getConfig(id);
    const bytes = await P.skinBytesForPlayer(id, name, cfg.onlineMode);
    if (!bytes) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: '这个玩家没有可用皮肤' } });
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(bytes);
  });

  app.get('/api/instances/:id/players/:name/skin-preview', (req, res) => {
    requirePlayerName(req.params.name);
    const bytes = P.skinPreviewForPlayer(req.params.id, req.params.name);
    if (!bytes) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(bytes);
  });

  app.post('/api/instances/:id/players/:name/skin', async (req, res) => {
    const { id, name } = req.params;
    I.getConfig(id);
    requirePlayerName(name);
    const body = req.body as { data?: string; variant?: string; poolId?: string };
    let result: P.SkinChangeResult;
    try {
      if (body.poolId) result = await P.selectPoolSkin(id, name, body.poolId);
      else {
        if (!body.data || !body.data.startsWith('data:image/png;base64,')) throw bad('请上传 PNG 图片');
        result = await P.bindUploadedSkin(id, name, Buffer.from(body.data.split(',')[1], 'base64'), body.variant === 'slim' ? 'slim' : 'classic');
      }
    } catch (err) {
      skinError(err);
    }
    audit({ ip: req.ip, action: body.poolId ? 'player.skin.select-pool' : 'player.skin.bind-upload', target: `${id}/${name}`, detail: body.poolId ? { poolId: body.poolId } : undefined });
    res.json({ ok: true, ...result! });
  });

  app.put('/api/instances/:id/players/:name/skin', async (req, res) => {
    const { id, name } = req.params;
    I.getConfig(id);
    requirePlayerName(name);
    const body = req.body as { kind?: string; url?: string; variant?: string };
    try {
      let result: P.SkinChangeResult;
      if (body.kind === 'mojang') result = await P.bindSameNameMojangSkin(id, name);
      else if (body.kind === 'url' && body.url) result = await P.bindSkinUrl(id, name, body.url, body.variant === 'slim' ? 'slim' : 'classic');
      else throw bad('请选择同名正版皮肤或填写皮肤 URL');
      audit({ ip: req.ip, action: `player.skin.bind-${body.kind}`, target: `${id}/${name}` });
      res.json({ ok: true, ...result });
      return;
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err) throw err;
      skinError(err);
    }
  });

  app.delete('/api/instances/:id/players/:name/skin', async (req, res) => {
    const { id, name } = req.params;
    I.getConfig(id);
    requirePlayerName(name);
    const result = await P.restorePlayerSkin(id, name);
    audit({ ip: req.ip, action: 'player.skin.restore', target: `${id}/${name}` });
    res.json({ ok: true, ...result });
  });

  app.post('/api/instances/:id/players/:name/:action', async (req, res) => {
    const { id, name, action } = req.params;
    const allowed = ['op', 'deop', 'kick', 'ban', 'unban', 'whitelist-add', 'whitelist-remove'];
    if (!allowed.includes(action)) throw bad(`不支持的操作：${action}`);
    requirePlayerName(name);
    const result = await P.playerAction(id, name, action);
    audit({ ip: req.ip, action: `player.${action}`, target: `${id}/${name}` });
    res.json(result);
  });

  /** Backward-compatible skin proxy for older clients. New UI requests always include a world id. */
  app.get('/api/players/:name/skin', async (req, res) => {
    const { name } = req.params;
    requirePlayerName(name);
    const ids = I.listInstanceIds();
    for (const id of ids) {
      try {
        const cfg = I.getConfig(id);
        const bytes = await P.skinBytesForPlayer(id, name, cfg.onlineMode);
        if (!bytes) continue;
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(bytes);
        return;
      } catch {
        /* Try the next world's player cache. */
      }
    }
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '这个玩家没有可用皮肤' } });
  });

  app.post('/api/players/:name/skin', (req, res) => {
    const { name } = req.params;
    requirePlayerName(name);
    const body = req.body as { data?: string };
    if (!body.data || !body.data.startsWith('data:image/png;base64,')) throw bad('请上传 PNG 图片');
    try {
      P.saveManualSkin(name, Buffer.from(body.data.split(',')[1], 'base64'));
    } catch (err) {
      skinError(err);
    }
    res.json({ ok: true });
  });

  app.delete('/api/players/:name/skin', (req, res) => {
    requirePlayerName(req.params.name);
    P.invalidatePlayer(req.params.name);
    res.json({ ok: true });
  });
}
