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
  app.get('/api/instances/:id/players/online', async (req, res) => {
    const list = await P.listPlayers(req.params.id);
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

  app.post('/api/instances/:id/players/:name/skin', async (req, res) => {
    const { id, name } = req.params;
    I.getConfig(id);
    requirePlayerName(name);
    const body = req.body as { data?: string };
    if (!body.data || !body.data.startsWith('data:image/png;base64,')) throw bad('请上传 PNG 图片');
    const buf = Buffer.from(body.data.split(',')[1], 'base64');
    try {
      P.saveManualSkin(name, buf);
    } catch (err) {
      skinError(err);
    }
    audit({ ip: req.ip, action: 'player.skin.bind-upload', target: `${id}/${name}` });
    res.json({ ok: true });
  });

  app.put('/api/instances/:id/players/:name/skin', async (req, res) => {
    const { id, name } = req.params;
    I.getConfig(id);
    requirePlayerName(name);
    const body = req.body as { kind?: string; url?: string };
    try {
      if (body.kind === 'mojang') await P.bindSameNameMojangSkin(name);
      else if (body.kind === 'url' && body.url) await P.bindSkinUrl(name, body.url);
      else throw bad('请选择同名正版皮肤或填写皮肤 URL');
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err) throw err;
      skinError(err);
    }
    audit({ ip: req.ip, action: `player.skin.bind-${body.kind}`, target: `${id}/${name}` });
    res.json({ ok: true });
  });

  app.delete('/api/instances/:id/players/:name/skin', (req, res) => {
    const { id, name } = req.params;
    I.getConfig(id);
    requirePlayerName(name);
    P.invalidatePlayer(name);
    audit({ ip: req.ip, action: 'player.skin.restore', target: `${id}/${name}` });
    res.json({ ok: true });
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
