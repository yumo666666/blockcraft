import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PANEL_CONFIG_FILE, PROJECT_ROOT, ensureDirs } from './core/paths.ts';
import { atomicWriteJsonWithBackupSync, readJsonSync } from './core/fsx.ts';
import type { PanelConfig } from './types.ts';
import { createLogger } from './core/logger.ts';

const logger = createLogger('config');

export function randomToken(bytes = 18): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 若项目里有 .secrets/frp.env（本地私密文件，不进仓库），把 FRP 参数预填进来 */
function readSecrets(): Record<string, string> {
  const file = process.env.BC_SECRETS_FILE || path.join(PROJECT_ROOT, '.secrets', 'frp.env');
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* 没有这个文件是完全正常的（开源用户不会有） */
  }
  return out;
}

export function defaultConfig(): PanelConfig {
  const secrets = readSecrets();
  const range = (secrets.FRP_REMOTE_PORT_RANGE || '26000-27000').split('-').map((v) => parseInt(v, 10));
  return {
    schemaVersion: 2,
    panel: {
      host: process.env.BC_HOST || '0.0.0.0',
      port: Number(process.env.BC_PORT || 8081),
      token: process.env.BC_TOKEN || randomToken(),
      sessionHours: Number(process.env.BC_SESSION_HOURS || 720),
    },
    portRanges: {
      game: [25565, 25609],
      rcon: [25610, 25654],
      frpRemote: [range[0] || 26000, range[1] || 27000] as [number, number],
    },
    frp: {
      enabled: Boolean(secrets.FRPS_HOST),
      binary: path.join(PROJECT_ROOT, 'bin', process.platform === 'win32' ? 'frpc.exe' : 'frpc'),
      serverAddr: secrets.FRPS_HOST || '',
      serverPort: Number(secrets.FRPS_BIND_PORT || 7000),
      token: secrets.FRPS_TOKEN || '',
      tls: true,
      adminPortPanel: 7400,
      adminPortWorlds: 7401,
      adminUser: 'panel',
      adminPassword: randomToken(9),
      dashboardUrl: secrets.FRPS_DASHBOARD_URL || '',
      dashboardUser: secrets.FRPS_DASHBOARD_USER || '',
      dashboardPassword: secrets.FRPS_DASHBOARD_PASS || '',
      exposePanel: Boolean(secrets.FRPS_HOST),
      panelRemotePort: Number(secrets.PANEL_REMOTE_PORT || 26000),
      foreignProxies: [],
      configRollback: true,
      selfCheckOnReload: true,
    },
    limits: {
      maxRunningInstances: Number(process.env.BC_MAX_RUNNING || 3),
      memoryBudgetMb: 'auto',
    },
    mirrors: {
      curseforgeApi: 'https://api.curseforge.com/v1',
      curseforgeApiKey: process.env.CURSEFORGE_API_KEY || '',
      curseforgeMirrorEnabled: false,
      forgeMaven: ['https://maven.minecraftforge.net', 'https://bmclapi2.bangbang93.com/maven'],
      githubMirror: 'https://gh-proxy.com/',
    },
    skins: {
      mineskinApiKey: process.env.BC_MINESKIN_API_KEY || '',
    },
    ui: {
      accent: '#3b7f5f',
      trashRetentionDays: 7,
    },
  };
}

/** 合并默认值：老配置缺字段时补上，不做破坏性重置 */
function merge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b !== undefined && typeof b === 'object' && b !== null && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out as T;
}

let cached: PanelConfig | null = null;

export function loadConfig(): PanelConfig {
  if (cached) return cached;
  ensureDirs();
  const defaults = defaultConfig();
  const existing = readJsonSync<PanelConfig | null>(PANEL_CONFIG_FILE, null);
  if (!existing) {
    cached = defaults;
    atomicWriteJsonWithBackupSync(PANEL_CONFIG_FILE, cached);
    logger.info('已生成默认配置', { file: PANEL_CONFIG_FILE });
    return cached;
  }
  cached = merge(defaults, existing);
  // 环境变量永远优先于配置文件（便于运维临时换端口、跑多实例测试）
  if (process.env.BC_PORT) cached.panel.port = Number(process.env.BC_PORT);
  if (process.env.BC_HOST) cached.panel.host = process.env.BC_HOST;
  if (process.env.BC_TOKEN) cached.panel.token = process.env.BC_TOKEN;
  // 首次从 .secrets 读到 FRP 信息时补齐（不覆盖用户已填的）
  if (!cached.frp.serverAddr && defaults.frp.serverAddr) {
    cached.frp.serverAddr = defaults.frp.serverAddr;
    cached.frp.token = cached.frp.token || defaults.frp.token;
    cached.frp.dashboardUrl = cached.frp.dashboardUrl || defaults.frp.dashboardUrl;
    cached.frp.dashboardUser = cached.frp.dashboardUser || defaults.frp.dashboardUser;
    cached.frp.dashboardPassword = cached.frp.dashboardPassword || defaults.frp.dashboardPassword;
    cached.frp.enabled = true;
    saveConfig();
  }
  return cached;
}

export function saveConfig(patch?: Partial<PanelConfig>): PanelConfig {
  const base = cached ?? loadConfig();
  const next = patch ? (merge(base, patch) as PanelConfig) : base;
  cached = next;
  atomicWriteJsonWithBackupSync(PANEL_CONFIG_FILE, next);
  return next;
}

/** 对外输出时抹掉所有密钥 */
export function publicConfig(cfg: PanelConfig) {
  return {
    ...cfg,
    panel: { ...cfg.panel, token: cfg.panel.token ? '••••••' : '' },
    frp: {
      ...cfg.frp,
      token: cfg.frp.token ? '••••••' : '',
      adminPassword: cfg.frp.adminPassword ? '••••••' : '',
      dashboardPassword: cfg.frp.dashboardPassword ? '••••••' : '',
    },
    mirrors: {
      ...cfg.mirrors,
      curseforgeApiKey: cfg.mirrors.curseforgeApiKey ? '••••••' : '',
    },
    skins: {
      ...cfg.skins,
      mineskinApiKey: cfg.skins.mineskinApiKey ? '••••••' : '',
    },
  };
}
