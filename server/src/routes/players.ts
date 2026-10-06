import type { Express } from 'express';
import { bad } from '../core/errors.ts';
import { audit } from '../core/logger.ts';
import * as I from '../services/instanceService.ts';
import * as P from '../services/playerService.ts';

export function registerPlayerRoutes(app: Express): void {
  app.get('/api/instances/:id/players/online', async (req, res) => {
    const list = await P.listPlayers(req.params.id);
    res.json({ online: list.onlineNames.length, names: list.onlineNames, serverOnline: list.serverOnline });
  });

  app.get('/api/instances/:id/players', async (req, res) => {
    res.json(await P.listPlayers(req.params.id));
  });

  app.post('/api/instances/:id/players/:name/:action', async (req, res) => {
    const { id, name, action } = req.params;
    const allowed = ['op', 'deop', 'kick', 'ban', 'unban', 'whitelist-add', 'whitelist-remove'];
    if (!allowed.includes(action)) throw bad(`不支持的操作：${action}`);
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw bad('玩家名不合法');
    const result = await P.playerAction(id, name, action);
    audit({ ip: req.ip, action: `player.${action}`, target: `${id}/${name}` });
    res.json(result);
  });

  /** 皮肤图片代理：避免浏览器跨域，并在本地缓存 */
  app.get('/api/players/:name/skin', async (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
      res.status(400).json({ error: { code: 'BAD_INPUT', message: '玩家名不合法' } });
      return;
    }
    // 取任意一个世界来判断正版模式（默认 false）
    let onlineMode = false;
    const ids = I.listInstanceIds();
    if (ids.length) {
      try {
        onlineMode = I.getConfig(ids[0]).onlineMode;
      } catch {
        /* ignore */
      }
    }
    const bytes = await P.skinBytes(name, onlineMode);
    if (!bytes) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: '这个玩家没有可用皮肤' } });
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(bytes);
  });

  /** 手动上传皮肤覆盖（离线模式下最可靠的办法） */
  app.post('/api/players/:name/skin', (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw bad('玩家名不合法');
    const body = req.body as { data?: string };
    if (!body.data || !body.data.startsWith('data:image/png;base64,')) throw bad('请上传 PNG 图片');
    const buf = Buffer.from(body.data.split(',')[1], 'base64');
    if (buf.length > 1024 * 1024) throw bad('皮肤文件太大（最大 1MB）');
    P.saveManualSkin(name, buf);
    res.json({ ok: true });
  });

  app.delete('/api/players/:name/skin', (req, res) => {
    P.invalidatePlayer(req.params.name);
    res.json({ ok: true });
  });
}
