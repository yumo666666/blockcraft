import express, { type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WEB_DIST, ensureDirs, INSTANCES_DIR } from './core/paths.ts';
import { loadConfig } from './config.ts';
import { audit, createLogger } from './core/logger.ts';
import { AppError, toHttpBody } from './core/errors.ts';
import * as I from './services/instanceService.ts';
import * as ports from './services/portService.ts';
import * as sup from './services/supervisor.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerInstanceRoutes } from './routes/instances.ts';
import { registerConsoleRoutes } from './routes/console.ts';
import { registerFrpRoutes } from './routes/frp.ts';
import { registerBackupRoutes } from './routes/backups.ts';
import { registerModRoutes } from './routes/mods.ts';
import { registerPlayerRoutes } from './routes/players.ts';
import { registerPackRoutes } from './routes/packs.ts';
import { startScheduler } from './services/scheduler.ts';
import { startFrpService } from './services/frpService.ts';
import { createJob } from './services/jobService.ts';
import { evSystem } from './services/eventLog.ts';
import { createSession as createSessionRec, destroySession, isValidSession as isValidSessionRec, prune } from './core/sessions.ts';

const logger = createLogger('http');

export interface AuthedRequest extends Request {
  sessionId?: string;
}

/**
 * 登录会话落盘（见 core/sessions.ts）。
 * 之前只在内存里，面板一重启登录态就全丢 —— 每次升级/重启都要重新输 token，很烦。
 */
export function createSession(ip: string, hours: number): string {
  return createSessionRec(ip, hours);
}

export function isValidSession(id: string | undefined): boolean {
  return isValidSessionRec(id, loadConfig().panel.sessionHours);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const loginAttempts = new Map<string, { count: number; until: number }>();

function rateLimited(ip: string): boolean {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (rec.until > Date.now()) return true;
  if (rec.count > 5 && Date.now() - rec.until > -600000) {
    loginAttempts.set(ip, { count: 0, until: 0 });
  }
  return false;
}

export function boot(): void {
  ensureDirs();
  const cfg = loadConfig();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // ---- 登录（不需要鉴权）
  app.post('/api/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (rateLimited(ip)) {
      res.status(429).json({ error: { code: 'BUSY', message: '尝试过于频繁，请 10 分钟后再试' } });
      return;
    }
    const token = String((req.body as { token?: string })?.token ?? '');
    const expected = loadConfig().panel.token;
    if (token && token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      const sid = createSession(ip, loadConfig().panel.sessionHours);
      res.setHeader(
        'Set-Cookie',
        `bc_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${loadConfig().panel.sessionHours * 3600}`,
      );
      loginAttempts.delete(ip);
      audit({ ip, action: 'login', result: 'ok' });
      res.json({ ok: true });
      return;
    }
    const rec = loginAttempts.get(ip) ?? { count: 0, until: 0 };
    rec.count += 1;
    if (rec.count >= 5) rec.until = Date.now() + 600000;
    loginAttempts.set(ip, rec);
    audit({ ip, action: 'login', result: 'fail' });
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '令牌不正确' } });
  });

  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true, name: 'BlockCraft', version: '2.2.2' });
  });

  // ---- 鉴权中间件
  app.use('/api', (req: AuthedRequest, res, next) => {
    if (req.path === '/login' || req.path === '/ping') return next();
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies['bc_session'] ?? (req.query.token as string | undefined);
    if (!isValidSession(sid)) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
      return;
    }
    req.sessionId = sid;
    // 写操作要求 CSRF 头（简单而有效）
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const marker = req.headers['x-blockcraft'] as string | undefined;
      if (marker !== '1') {
        res.status(403).json({ error: { code: 'UNAUTHORIZED', message: '缺少请求标记，请刷新页面' } });
        return;
      }
    }
    next();
  });

  app.post('/api/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies['bc_session']) destroySession(cookies['bc_session']);
    res.setHeader('Set-Cookie', 'bc_session=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
  });

  // Express 4 不会自动接住 async handler 里抛出的错误 —— 不处理的话请求会一直挂着，
  // 前端看到的是「转圈到超时」而不是错误提示。这里统一包一层 Promise.resolve().catch(next)。
  // （错误中间件是 4 个参数，靠 arity 判断跳过包装。）
  const raw = app as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['get', 'post', 'put', 'delete', 'patch', 'use'] as const) {
    const original = raw[method].bind(app) as (...args: unknown[]) => unknown;
    raw[method] = (...args: unknown[]) =>
      original(
        ...args.map((h) =>
          typeof h === 'function' && (h as (...a: unknown[]) => unknown).length < 4
            ? (req: unknown, res: unknown, next: (e?: unknown) => void) =>
                Promise.resolve((h as (a: unknown, b: unknown, c: unknown) => unknown)(req, res, next)).catch(next)
            : h,
        ),
      );
  }

  registerSystemRoutes(app);
  registerInstanceRoutes(app);
  registerConsoleRoutes(app);
  registerFrpRoutes(app);
  registerBackupRoutes(app);
  registerModRoutes(app);
  registerPlayerRoutes(app);
  registerPackRoutes(app);

  // ---- 带 token 的链接自动登录（登录后立刻从地址栏清掉 token，避免留在浏览器历史里）
  app.get('/', (req, res, next) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    logger.debug('命中根路由', { hasToken: Boolean(token), path: req.path, query: JSON.stringify(req.query) });
    if (!token) return next();
    const expected = loadConfig().panel.token;
    if (token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      const sid = createSession(req.ip ?? 'unknown', loadConfig().panel.sessionHours);
      res.setHeader(
        'Set-Cookie',
        `bc_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${loadConfig().panel.sessionHours * 3600}`,
      );
      audit({ ip: req.ip, action: 'login', result: 'ok(url-token)' });
      res.redirect('/');
      return;
    }
    next();
  });

  // ---- 前端静态资源
  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send('前端还没构建。开发时请访问 Vite 的 5173 端口，或先执行 pnpm build。');
    });
  }

  // ---- 统一错误处理（结构化错误码：前端才能区分「改输入」与「要刷新」）
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, body } = toHttpBody(err);
    if (status >= 500) logger.error('请求处理失败', err instanceof Error ? err.stack : String(err));
    res.status(status).json(body);
  });

  // ---- 启动对账：把面板外还在跑的世界接管回来，并清理幽灵端口登记
  evSystem('面板已启动');
  sup.reconcile();
  sup.sweepDeadWorlds();
  // 面板一起来就按 autostart 拉起世界：比等看门狗（45 秒宽限 + 连续两次巡检）快得多
  setTimeout(() => {
    void sup.startAutostartWorlds().catch((err) => logger.warn('autostart 执行异常', String(err)));
  }, 3000);
  ports.reconcile(new Set(I.listInstanceIds()));
  createJob({ id: 'boot', kind: 'install', title: '面板启动', instanceId: null, status: 'done', stages: [], lines: [`面板启动于 ${new Date().toLocaleString('zh-CN')}`], progress: 100, error: null, startedAt: Date.now(), endedAt: Date.now() }).catch(() => undefined);

  // 启动时清一遍过期会话，之后每小时一次
  const pruned = prune(cfg.panel.sessionHours);
  if (pruned) logger.info(`清理了 ${pruned} 个过期登录会话`);
  setInterval(() => {
    try {
      prune(loadConfig().panel.sessionHours);
    } catch {
      /* ignore */
    }
  }, 3600_000).unref();

  app.listen(cfg.panel.port, cfg.panel.host, () => {
    logger.info(`BlockCraft 面板已启动：http://${cfg.panel.host}:${cfg.panel.port}`);
    logger.info(`世界目录：${INSTANCES_DIR}`);
  });

  startFrpService().catch((err) => logger.warn('FRP 服务启动失败', String(err)));
  startScheduler();
}

if (process.argv[1] && /index\.ts$/.test(process.argv[1])) {
  process.on('unhandledRejection', (err) => logger.error('未处理的 Promise 拒绝', String(err)));
  process.on('SIGTERM', () => {
    logger.info('收到 SIGTERM，面板退出（不结束正在运行的世界）');
    process.exit(0);
  });
  process.on('SIGINT', () => {
    logger.info('收到 SIGINT，面板退出');
    process.exit(0);
  });
  boot();
}

export { AppError };
