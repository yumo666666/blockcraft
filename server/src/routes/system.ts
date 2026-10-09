import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import { DATA_DIR, INSTANCES_DIR, PROJECT_ROOT } from '../core/paths.ts';
import { dirSizeSync } from '../core/fsx.ts';
import { loadConfig, publicConfig, saveConfig, randomToken } from '../config.ts';
import * as sup from '../services/supervisor.ts';
import * as frp from '../services/frpService.ts';
import { evSystem, listEvents as evList } from '../services/eventLog.ts';
import { bad } from '../core/errors.ts';
import { destroyAllSessions, sessionCount } from '../core/sessions.ts';
import { systemSnapshot, connectionAddresses } from '../services/systemService.ts';
import { summarizeAll, countMods } from '../services/overview.ts';
import { javaSummary, listJava, autoJava } from '../services/javaService.ts';
import * as I from '../services/instanceService.ts';
import { dirSizeCached } from '../services/overview.ts';

let shutdownAfterWorldsInProgress = false;

export function registerSystemRoutes(app: Express): void {
  app.get('/api/panel', (_req, res) => {
    const cfg = loadConfig();
    res.json({
      config: publicConfig(cfg),
      addresses: connectionAddresses(cfg.panel.port),
      instanceDir: INSTANCES_DIR,
      dataDir: DATA_DIR,
      projectRoot: PROJECT_ROOT,
      java: javaSummary(),
      sessions: sessionCount(),
    });
  });

  app.put('/api/panel', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const ranges = body.portRanges as { frpRemote?: unknown } | undefined;
    if (Array.isArray(ranges?.frpRemote)) {
      const [start, end] = ranges.frpRemote.map(Number);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 26006 || end < start || end > 65535) {
        throw bad('远端 FRP 端口段必须从 26006 起，且结束端口不能小于起始端口');
      }
    }
    const patch: Record<string, unknown> = {};
    if (body.panel) patch.panel = body.panel;
    if (body.limits) patch.limits = body.limits;
    if (body.ui) patch.ui = body.ui;
    if (body.mirrors) patch.mirrors = body.mirrors;
    if (body.skins) patch.skins = body.skins;
    if (body.portRanges) patch.portRanges = body.portRanges;
    const next = saveConfig(patch);
    res.json({ ok: true, config: publicConfig(next) });
  });

  app.get('/api/system/java', (_req, res) => {
    res.json(javaSummary());
  });

  /** 事件总日志（世界启动/就绪/关闭/崩溃） */
  app.get('/api/events', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 1), 1000);
    res.json({ events: evList(limit) });
  });

  /** 巡检「进程已不在」的世界并把崩溃原因记下来（看门狗每分钟调一次） */
  app.post('/api/maintenance/sweep-dead', (_req, res) => {
    sup.sweepDeadWorlds();
    res.json({ ok: true });
  });

  app.post('/api/panel/token/reset', (_req, res) => {
    const cfg = loadConfig();
    const token = randomToken();
    saveConfig({ panel: { ...cfg.panel, token } });
    // 令牌换了，之前发出去的登录会话也要一起作废（否则旧 cookie 还能继续用）
    const killed = destroyAllSessions();
    res.json({ ok: true, token, killedSessions: killed });
  });

  app.get('/api/system', async (_req, res) => {
    const sampledAt = Date.now();
    const cfg = loadConfig();
    const [snap, instances] = await Promise.all([systemSnapshot(cfg.panel.port, DATA_DIR), summarizeAll()]);
    res.json({
      sampledAt,
      ...snap,
      instances,
      addresses: connectionAddresses(cfg.panel.port),
      totals: {
        running: instances.filter((i) => i.status === 'running' || i.status === 'starting').length,
        instances: instances.length,
        players: instances.reduce((a, i) => a + i.players, 0),
        mods: instances.reduce((a, i) => a + i.modCount, 0),
        instanceBytes: instances.reduce((a, i) => a + i.diskUsage, 0),
        allocatedMemoryMb: instances.filter((i) => i.status !== 'stopped').reduce((a, i) => a + i.memoryMb, 0),
      },
    });
  });

  app.get('/api/system/stream', async (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const cfg = loadConfig();
    let closed = false;
    let sending = false;
    req.on('close', () => {
      closed = true;
    });
    const send = async () => {
      // Status summaries can take longer than three seconds while pinging many
      // running worlds. Never let an older, slower summary be written after a
      // newer one and roll the overview back to a stale status.
      if (closed || sending) return;
      sending = true;
      const sampledAt = Date.now();
      try {
        const snap = await systemSnapshot(cfg.panel.port, DATA_DIR);
        const instances = await summarizeAll();
        if (!closed) res.write(`data: ${JSON.stringify({ type: 'system', sampledAt, snap, instances })}\n\n`);
      } catch {
        /* ignore */
      } finally {
        sending = false;
      }
    };
    await send();
    const timer = setInterval(() => void send(), 3000);
    req.on('close', () => clearInterval(timer));
  });

  app.get('/api/system/storage', async (_req, res) => {
    const ids = I.listInstanceIds();
    const instances = ids.map((id) => ({
      id,
      name: (() => {
        try {
          return I.getConfig(id).name;
        } catch {
          return id;
        }
      })(),
      bytes: dirSizeCached(id),
      mods: countMods(id),
    }));
    let storeBytes = 0;
    try {
      storeBytes = dirSizeSync(DATA_DIR + '/store');
    } catch {
      storeBytes = 0;
    }
    let trashBytes = 0;
    try {
      trashBytes = dirSizeSync(DATA_DIR + '/trash');
    } catch {
      trashBytes = 0;
    }
    let logsBytes = 0;
    try {
      logsBytes = dirSizeSync(DATA_DIR + '/logs');
    } catch {
      logsBytes = 0;
    }
    res.json({
      instances,
      jdk: (() => {
        try {
          return dirSizeSync(DATA_DIR + '/jdk');
        } catch {
          return 0;
        }
      })(),
      store: storeBytes,
      trash: trashBytes,
      logs: logsBytes,
      total: instances.reduce((a, i) => a + i.bytes, 0) + storeBytes + trashBytes,
    });
  });

  app.post('/api/system/storage/clean', (req, res) => {
    const body = req.body as { target?: string };
    const map: Record<string, string> = { trash: DATA_DIR + '/trash', logs: DATA_DIR + '/logs' };
    const dir = map[body.target ?? ''];
    if (!dir) {
      res.status(400).json({ error: { code: 'BAD_INPUT', message: '只能清理回收站或日志目录' } });
      return;
    }
    let freed = 0;
    try {
      freed = dirSizeSync(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      res.status(500).json({ error: { code: 'INTERNAL', message: String(err) } });
      return;
    }
    res.json({ ok: true, freed });
  });



  /** 让面板自己退出（给启动脚本与升级操作用；不会结束正在运行的世界） */
  app.post('/api/panel/shutdown', (_req, res) => {
    res.json({ ok: true, message: '面板即将退出（不会结束正在运行的世界）' });
    setTimeout(() => process.exit(0), 300);
  });

  /** Windows 托盘退出：先并行安全停止所有活动世界，全部成功后再退出面板。 */
  app.post('/api/panel/shutdown-after-worlds', async (_req, res) => {
    if (shutdownAfterWorldsInProgress || !sup.beginPanelShutdown()) {
      res.status(409).json({ error: { code: 'BUSY', message: '正在停止世界，请稍候' } });
      return;
    }
    shutdownAfterWorldsInProgress = true;
    try {
      const worlds = await summarizeAll();
      const active = (await Promise.all(worlds.map(async (world) => {
        const statusActive = ['running', 'starting', 'stopping', 'stuck'].includes(world.status);
        return statusActive || await sup.hasActiveProcessEvidence(world.id) ? world : null;
      }))).filter((world): world is (typeof worlds)[number] => Boolean(world));
      const results = await Promise.all(
        active.map(async (world) => ({
          world,
          result: await sup.stop(world.id, { message: 'BlockCraft 正在关闭，服务器即将停止', timeoutSec: 120, safeOnly: true }).catch((error) => ({
            ok: false,
            graceful: false,
            error: String(error),
          })),
        })),
      );
      const failed = results.filter(({ result }) => !result.ok);
      if (failed.length) {
        shutdownAfterWorldsInProgress = false;
        sup.cancelPanelShutdown();
        const details = failed.map(({ world, result }) => `${world.name}：${result.error || '未能确认停止'}`).join('；');
        res.status(409).json({
          error: {
            code: 'CONFLICT',
            message: `以下世界未能安全停止，面板仍保持运行：${details}`,
          },
        });
        return;
      }

      // Re-check every world immediately before exiting. A stale state snapshot
      // or an unverified PID must never make the tray quit while Java is alive.
      const latestWorlds = await summarizeAll();
      const stillActive = (await Promise.all(latestWorlds.map(async (world) => {
        const statusActive = ['running', 'starting', 'stopping', 'stuck'].includes(world.status);
        return statusActive || await sup.hasActiveProcessEvidence(world.id) ? world : null;
      }))).filter((world): world is (typeof latestWorlds)[number] => Boolean(world));
      if (stillActive.length) {
        shutdownAfterWorldsInProgress = false;
        sup.cancelPanelShutdown();
        res.status(409).json({
          error: {
            code: 'CONFLICT',
            message: `以下世界仍有进程或端口活动，面板保持运行：${stillActive.map((world) => world.name).join('、')}`,
          },
        });
        return;
      }
      const frpStop = await frp.stopChannelsForShutdown();
      if (!frpStop.ok) {
        shutdownAfterWorldsInProgress = false;
        sup.cancelPanelShutdown();
        res.status(409).json({
          error: {
            code: 'CONFLICT',
            message: `世界已安全停止，但 FRP 通道没有全部退出，面板保持运行：${frpStop.error ?? '未知错误'}`,
          },
        });
        return;
      }
      res.json({ ok: true, stopped: active.length });
      setTimeout(() => process.exit(0), 350);
    } catch (error) {
      shutdownAfterWorldsInProgress = false;
      sup.cancelPanelShutdown();
      frp.cancelShutdown();
      res.status(500).json({ error: { code: 'INTERNAL', message: String(error) } });
    }
  });

  app.get('/api/versions', async (_req, res) => {
    const { minecraftVersions } = await import('../services/versionsService.ts');
    const list = await minecraftVersions();
    res.json({ versions: list.filter((v) => v.type === 'release'), all: list.length });
  });

  app.get('/api/loaders', async (req, res) => {
    const mc = String(req.query.mc ?? '1.20.1');
    const { loadersFor } = await import('../services/versionsService.ts');
    res.json({ mc, loaders: await loadersFor(mc) });
  });

  app.get('/api/packs/inspect/:id', async (req, res) => {
    const path = await import('node:path');
    const fs = await import('node:fs');
    const { STORE_DIR } = await import('../core/paths.ts');
    const file = path.join(STORE_DIR, 'packs', path.basename(req.params.id));
    if (!fs.existsSync(file)) throw bad('整合包不存在');
    const { inspectPack } = await import('../services/packService.ts');
    res.json(await inspectPack(file));
  });

  app.get('/api/java', (_req, res) => {
    res.json({ installed: listJava(true) });
  });

  app.get('/api/java/resolve', (req, res) => {
    const mc = String(req.query.mc ?? '1.20.1');
    const loader = String(req.query.loader ?? 'forge') as never;
    res.json(autoJava(mc, loader));
  });
}
