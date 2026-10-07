import type { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { INSTANCE_ID_RE, instanceServerDir } from '../core/paths.ts';
import { bad, conflict, notFound } from '../core/errors.ts';
import { audit } from '../core/logger.ts';
import * as I from '../services/instanceService.ts';
import * as sup from '../services/supervisor.ts';
import * as frp from '../services/frpService.ts';
import * as ports from '../services/portService.ts';
import { summarize, summarizeAll, invalidateModCount } from '../services/overview.ts';
import { createJob, finishJob, logJob, setStage } from '../services/jobService.ts';
import { installServer, copyInstance } from '../services/installService.ts';
import { validateInstall } from '../launcher/index.ts';
import { loadConfig } from '../config.ts';

function requireId(id: string): string {
  if (!INSTANCE_ID_RE.test(id)) throw bad('世界 id 不合法');
  if (!I.exists(id)) throw notFound(`世界不存在：${id}`);
  return id;
}

const MEMORY_SAFETY = 0.6;

function memoryBudget(): number {
  const cfg = loadConfig();
  if (cfg.limits.memoryBudgetMb !== 'auto') return cfg.limits.memoryBudgetMb;
  const totalMb = fs.existsSync('/proc/meminfo')
    ? Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/MemTotal:\s+(\d+) kB/)?.[1] ?? 0) / 1024
    : 8192;
  return Math.round(totalMb * MEMORY_SAFETY);
}

export function registerInstanceRoutes(app: Express): void {
  app.get('/api/instances', async (_req, res) => {
    res.json({ instances: await summarizeAll(), limits: { maxRunning: loadConfig().limits.maxRunningInstances, memoryBudgetMb: memoryBudget() } });
  });

  app.post('/api/instances', async (req, res) => {
    const body = req.body as Record<string, unknown> & { name?: string; mc?: string; loader?: never; install?: boolean; start?: boolean };
    if (!body.name) throw bad('请填写世界名称');
    if (!body.mc) throw bad('请选择 Minecraft 版本');
    const cfg = await I.createInstance({
      ...(body as unknown as Record<string, never>),
      createdFrom: { type: 'new' },
    } as Parameters<typeof I.createInstance>[0]);
    // 分配远端 FRP 端口
    await frp.ensureRemotePort(cfg.id);
    audit({ ip: req.ip, action: 'instance.create', target: cfg.id, detail: { mc: cfg.mc, loader: cfg.loader } });

    const job = await createJob({
      kind: 'create',
      title: `创建世界「${cfg.name}」`,
      instanceId: cfg.id,
      stages: [
        { key: 'install', label: '安装服务端', status: 'pending' },
        { key: 'config', label: '生成配置', status: 'pending' },
        { key: 'frp', label: '分配并映射端口', status: 'pending' },
        { key: 'start', label: '启动世界', status: 'pending' },
      ],
    });

    const run = async () => {
      try {
        setStage(job.id, 'install', 'running');
        await installServer(cfg.id, (line) => logJob(job.id, line));
        setStage(job.id, 'install', 'done');

        setStage(job.id, 'config', 'running');
        I.writeProperties(cfg.id);
        logJob(job.id, '已生成 server.properties 与 eula.txt');
        setStage(job.id, 'config', 'done');

        setStage(job.id, 'frp', 'running');
        const remote = await frp.ensureRemotePort(cfg.id);
        await frp.syncWorlds();
        logJob(job.id, `远端端口 ${remote} 已映射到 frps`);
        setStage(job.id, 'frp', 'done');

        if (body.start !== false) {
          setStage(job.id, 'start', 'running');
          const started = await sup.start(cfg.id, { wait: true });
          logJob(job.id, started.ok ? '世界已启动' : `启动失败：${started.error}`);
          setStage(job.id, 'start', started.ok ? 'done' : 'failed');
        } else {
          setStage(job.id, 'start', 'done', '跳过启动');
        }
        finishJob(job.id);
      } catch (err) {
        logJob(job.id, `失败：${String(err)}`);
        finishJob(job.id, String(err));
      }
    };
    void run();
    res.json({ ok: true, instance: await summarize(cfg.id), jobId: job.id });
  });

  app.get('/api/instances/:id', async (req, res) => {
    const id = requireId(req.params.id);
    const cfg = I.getConfig(id);
    const summary = await summarize(id);
    const check = validateInstall(cfg, instanceServerDir(id));
    res.json({
      instance: summary,
      config: cfg,
      state: I.getState(id),
      installed: check.ok,
      missing: check.missing,
      launchHow: check.plan.how,
      drift: I.configDrift(id),
      java: cfg.javaMajor,
    });
  });

  app.put('/api/instances/:id', async (req, res) => {
    const id = requireId(req.params.id);
    const before = I.getConfig(id);
    const patch = req.body as Partial<typeof before>;
    // 这两组必须分开：
    //   PROP_KEYS   → 要落到 server.properties，否则只改了 config.json，服务端用的还是旧值（实测踩到）
    //   RESTART_KEYS→ 需要重启才生效的（含上面这组）
    const PROP_KEYS = [
      'motd', 'maxPlayers', 'port', 'rconPort', 'onlineMode', 'whiteList', 'levelSeed', 'levelName',
      'gamemode', 'difficulty', 'pvp', 'hardcore', 'allowNether', 'spawnMonsters', 'spawnAnimals',
      'spawnNpcs', 'generateStructures', 'enableCommandBlock', 'viewDistance', 'simulationDistance',
    ] as const;
    const RESTART_KEYS = [...PROP_KEYS, 'memoryMb', 'minMemoryMb', 'jvmExtra', 'mc', 'loader', 'loaderVersion', 'javaMajor', 'javaPath'] as const;
    const changed = (k: string) =>
      (patch as Record<string, unknown>)[k] !== undefined &&
      JSON.stringify((patch as Record<string, unknown>)[k]) !== JSON.stringify((before as unknown as Record<string, unknown>)[k]);
    const propsChanged = PROP_KEYS.some(changed);
    const needsRestart = RESTART_KEYS.some(changed);
    const next = I.saveConfig(id, patch);
    // 把「随面板自动启动」打开时，顺手清掉「主动停止」意图，
    // 否则看门狗会一直跳过这个世界，用户会以为开关没生效。
    if ((patch as { autostart?: boolean }).autostart === true) I.saveState(id, { intentionalStop: false });
    // 只要动了 properties 相关的项就重写（幂等、很便宜），不再只在「需重启」时才写
    if (propsChanged) I.writeProperties(id);
    if (sup.isRunning(id) && before.gamerules !== next.gamerules) await sup.applyGamerules(id).catch(() => undefined);
    if (sup.isRunning(id) && before.port !== next.port) throw conflict('世界正在运行，改端口请先停服');
    if (patch.frp) await frp.syncWorlds();
    audit({ ip: req.ip, action: 'instance.update', target: id, detail: Object.keys(patch) });
    res.json({ ok: true, config: next, needsRestart });
  });

  app.delete('/api/instances/:id', async (req, res) => {
    const id = requireId(req.params.id);
    const confirm = String(req.query.confirm ?? '');
    if (confirm !== id) throw bad('请输入完整的世界 id 以确认删除');
    if (sup.isRunning(id)) await sup.stop(id, { message: '这个世界即将被删除' }).catch(() => undefined);
    const purge = String(req.query.purge ?? '0') === '1';
    I.deleteInstance(id, purge);
    await frp.removeInstance(id).catch(() => undefined);
    invalidateModCount(id);
    audit({ ip: req.ip, action: 'instance.delete', target: id, detail: { purge } });
    res.json({ ok: true });
  });

  /**
   * 启停这类操作可能耗时几十秒到两分钟（等世界加载 / 保存 / 踢人 / 关服）。
   * 从前是同步等完才回响应，结果经过 VPN / 反向代理时会被判超时，前端收到 502，
   * 但服务端其实还在干。现在默认立刻返回 202，进度靠状态轮询看。
   */
  app.post('/api/instances/:id/start', async (req, res) => {
    const id = requireId(req.params.id);
    if (sup.isRunning(id)) throw conflict('这个世界已经在运行');
    const running = (await summarizeAll()).filter((i) => i.status === 'running' || i.status === 'starting');
    const cfg = I.getConfig(id);
    const limit = loadConfig().limits.maxRunningInstances;
    if (running.length >= limit) throw conflict(`同时在运行的世界已达上限（${limit} 个）。可以在设置里调整。`);
    const usedMb = running.reduce((a, i) => a + i.memoryMb, 0) + cfg.memoryMb;
    if (usedMb > memoryBudget()) {
      throw conflict(`启动后总内存需求 ${usedMb}MB 会超过预算 ${memoryBudget()}MB，可能把机器拖垮。请降低某个世界的 Xmx，或在设置里调大预算。`);
    }
    const wait = String(req.query.wait ?? '0') === '1';
    if (wait) {
      const result = await sup.start(id, { wait: true });
      if (!result.ok) {
        res.status(409).json({ error: { code: 'CONFLICT', message: result.error ?? '启动失败' } });
        return;
      }
      await frp.syncWorlds().catch(() => undefined);
      audit({ ip: req.ip, action: 'instance.start', target: id });
      res.json({ ok: true, jobId: null });
      return;
    }
    // 后台执行：立刻回 202，前端靠轮询看 phase / status
    void sup
      .start(id, { wait: true })
      .then(async (result) => {
        if (!result.ok) {
          I.saveState(id, { lastError: result.error ?? '启动失败', phase: result.error ?? '启动失败' });
          return;
        }
        await frp.syncWorlds().catch(() => undefined);
      })
      .catch((err) => I.saveState(id, { lastError: String(err), phase: `启动异常：${String(err)}` }));
    audit({ ip: req.ip, action: 'instance.start', target: id, detail: { async: true } });
    res.status(202).json({ ok: true, accepted: true });
  });

  app.post('/api/instances/:id/stop', async (req, res) => {
    const id = requireId(req.params.id);
    const body = (req.body ?? {}) as { message?: string; kick?: boolean; timeoutSec?: number };
    const wait = String(req.query.wait ?? '0') === '1';
    if (wait) {
      const result = await sup.stop(id, { message: body.message, kick: body.kick, timeoutSec: body.timeoutSec });
      audit({ ip: req.ip, action: 'instance.stop', target: id, detail: { graceful: result.graceful } });
      res.json(result);
      return;
    }
    // 同上：优雅停止要等保存+踢人+关服，同步等会被代理判超时
    void sup
      .stop(id, { message: body.message, kick: body.kick, timeoutSec: body.timeoutSec })
      .then((result) =>
        audit({ ip: req.ip, action: 'instance.stop', target: id, detail: { graceful: result.graceful, async: true } }),
      )
      .catch((err) => I.saveState(id, { lastError: String(err), phase: `停止异常：${String(err)}` }));
    res.status(202).json({ ok: true, accepted: true, message: '已开始关闭，稍等几秒看状态' });
  });

  app.post('/api/instances/:id/restart', async (req, res) => {
    const id = requireId(req.params.id);
    const result = await sup.restart(id);
    res.json(result);
  });

  app.get('/api/instances/:id/ports', async (req, res) => {
    const id = requireId(req.params.id);
    const cfg = I.getConfig(id);
    const panel = loadConfig();
    const publicHost = panel.frp.serverAddr || '（未配置 FRP）';
    res.json({
      local: cfg.port,
      rcon: cfg.rconPort,
      remote: cfg.frp.remotePort,
      frpEnabled: cfg.frp.enabled,
      connectLocal: `${cfg.port}`,
      connectPublic: cfg.frp.remotePort ? `${publicHost}:${cfg.frp.remotePort}` : null,
      range: panel.portRanges.frpRemote,
    });
  });

  app.post('/api/instances/:id/ports/reassign', async (req, res) => {
    const id = requireId(req.params.id);
    if (sup.isRunning(id)) throw conflict('请先停服再重新分配端口');
    const panel = loadConfig();
    const alloc = await ports.allocateLocal(id, panel.portRanges.game, panel.portRanges.rcon);
    I.saveConfig(id, { port: alloc.game, rconPort: alloc.rcon });
    I.writeProperties(id);
    const remote = await frp.ensureRemotePort(id);
    await frp.syncWorlds().catch(() => undefined);
    res.json({ ok: true, port: alloc.game, rconPort: alloc.rcon, remotePort: remote });
  });

  app.post('/api/instances/:id/reinstall', async (req, res) => {
    const id = requireId(req.params.id);
    if (sup.isRunning(id)) throw conflict('请先停服再重新安装服务端');
    const cfg = I.getConfig(id);
    const job = await createJob({
      kind: 'install',
      title: `重新安装「${cfg.name}」的服务端`,
      instanceId: id,
      stages: [{ key: 'install', label: '下载并安装服务端', status: 'pending' }],
    });
    void (async () => {
      try {
        setStage(job.id, 'install', 'running');
        await installServer(id, (line) => logJob(job.id, line), { force: true });
        setStage(job.id, 'install', 'done');
        finishJob(job.id);
      } catch (err) {
        logJob(job.id, `失败：${String(err)}`);
        finishJob(job.id, String(err));
      }
    })();
    res.json({ ok: true, jobId: job.id });
  });

  /** 世界的真实种子（配置 → 存档 → 问服务端 三级兜底） */
  app.get('/api/instances/:id/seed', async (req, res) => {
    const id = requireId(req.params.id);
    const r = await I.resolveSeed(id);
    res.json({ ok: true, ...r });
  });

  app.post('/api/instances/:id/copy', async (req, res) => {
    const id = requireId(req.params.id);
    const body = req.body as { name?: string } & Record<string, unknown>;
    if (!body.name) throw bad('请填写新世界的名称');
    if (sup.isRunning(id)) throw conflict('请先停服再复制（运行中的存档会不一致）');
    const job = await createJob({
      kind: 'copy',
      title: `复制「${I.getConfig(id).name}」为新世界`,
      instanceId: id,
      stages: [
        { key: 'meta', label: '创建新世界条目', status: 'pending' },
        { key: 'copy', label: '复制服务端与 MOD（真实复制）', status: 'pending' },
        { key: 'config', label: '写入新配置与端口', status: 'pending' },
        { key: 'frp', label: '映射远端端口', status: 'pending' },
      ],
    });
    void (async () => {
      try {
        setStage(job.id, 'meta', 'running');
        const created = await copyInstance(id, body as never, (line) => logJob(job.id, line));
        setStage(job.id, 'meta', 'done');
        setStage(job.id, 'copy', 'done');
        setStage(job.id, 'config', 'running');
        logJob(job.id, '配置已写入');
        setStage(job.id, 'config', 'done');
        setStage(job.id, 'frp', 'running');
        const remote = await frp.ensureRemotePort(created.id);
        await frp.syncWorlds().catch(() => undefined);
        logJob(job.id, `远端端口 ${remote} 已映射`);
        setStage(job.id, 'frp', 'done');
        finishJob(job.id);
      } catch (err) {
        logJob(job.id, `失败：${String(err)}`);
        finishJob(job.id, String(err));
      }
    })();
    res.json({ ok: true, jobId: job.id });
  });

  /** 纳管已有世界目录：只读识别 + 建软链登记，不移动、不改动原目录 */
  app.post('/api/instances/adopt', async (req, res) => {
    const body = req.body as { dir?: string; name?: string; mc?: string; loader?: never; loaderVersion?: string; memoryMb?: number; writeProperties?: boolean };
    if (!body.dir) throw bad('请提供要纳管的服务端目录');
    const adoptBody = { ...body, dir: body.dir };
    const { adopt } = await import('../services/adoptService.ts');
    const cfg = await adopt(adoptBody);
    await frp.ensureRemotePort(cfg.id);
    await frp.syncWorlds().catch(() => undefined);
    audit({ ip: req.ip, action: 'instance.adopt', target: cfg.id, detail: { dir: body.dir } });
    res.json({ ok: true, instance: await summarize(cfg.id) });
  });

  /** 扫描一个目录里可纳管的世界（只读） */
  app.get('/api/instances/adopt/scan', async (req, res) => {
    const root = String(req.query.dir ?? '');
    if (!root) throw bad('请提供要扫描的目录');
    const { scanCandidates } = await import('../services/adoptService.ts');
    res.json({ candidates: scanCandidates(root) });
  });
}
