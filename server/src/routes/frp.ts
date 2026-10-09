import type { Express } from 'express';
import { bad } from '../core/errors.ts';
import { loadConfig, publicConfig, saveConfig } from '../config.ts';
import * as frp from '../services/frpService.ts';

export function registerFrpRoutes(app: Express): void {
  app.get('/api/frp/status', async (_req, res) => {
    res.json(await frp.status());
  });

  app.get('/api/frp/stream', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    const send = async () => {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(await frp.status())}\n\n`);
      } catch {
        /* ignore */
      }
    };
    await send();
    const timer = setInterval(send, 5000);
    req.on('close', () => clearInterval(timer));
  });

  app.get('/api/frp/config', (_req, res) => {
    res.json(publicConfig(loadConfig()).frp);
  });

  app.put('/api/frp/config', async (req, res) => {
    const cfg = loadConfig();
    const body = req.body as Record<string, unknown>;
    if (body.panelRemotePort !== undefined) {
      const remotePort = Number(body.panelRemotePort);
      if (!Number.isInteger(remotePort) || remotePort < 26006 || remotePort > 65535) throw bad('面板远端端口必须在 26006–65535 之间');
    }
    const patch = { ...cfg.frp } as Record<string, unknown>;
    for (const key of [
      'enabled', 'serverAddr', 'serverPort', 'tls', 'dashboardUrl', 'dashboardUser', 'dashboardPassword',
      'exposePanel', 'panelRemotePort', 'adminPortPanel', 'adminPortWorlds', 'configRollback', 'selfCheckOnReload',
      'foreignProxies',
    ]) {
      if (body[key] !== undefined && body[key] !== '••••••') patch[key] = body[key];
    }
    // 密钥字段：传空字符串表示「不改」，传新值才覆盖
    for (const key of ['token', 'adminPassword']) {
      if (typeof body[key] === 'string' && body[key] && body[key] !== '••••••') patch[key] = body[key];
    }
    saveConfig({ frp: patch as never });
    const switched = req.query.apply === '1';
    if (switched) {
      const panel = loadConfig();
      await frp.startChannel('panel', { force: true });
      await frp.syncWorlds();
    }
    res.json({ ok: true, config: publicConfig(loadConfig()).frp });
  });

  app.post('/api/frp/reload', async (req, res) => {
    const channel = (req.body as { channel?: string })?.channel === 'panel' ? 'panel' : ('worlds' as const);
    const result = await frp.reloadChannel(channel as 'panel' | 'worlds');
    res.json(result);
  });

  app.post('/api/frp/restart', async (req, res) => {
    const channel = ((req.body as { channel?: string })?.channel ?? 'worlds') as 'panel' | 'worlds';
    frp.stopChannel(channel);
    await frp.startChannel(channel, { force: true });
    res.json(await frp.status());
  });

  app.post('/api/frp/install', async (_req, res) => {
    try {
      const p = await frp.downloadBinary();
      res.json({ ok: true, path: p });
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL', message: String(err) } });
    }
  });

  app.post('/api/frp/self-check', async (_req, res) => {
    res.json(await frp.selfCheck());
  });
}
