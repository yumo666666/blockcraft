import fs from 'node:fs';
import path from 'node:path';
import { INSTANCES_DIR, INSTANCE_ID_RE, instanceConfigFile, instanceDir, instanceServerDir, instanceStateFile } from '../core/paths.ts';
import { atomicWriteJsonWithBackupSync, atomicWriteFileSync, readJsonSync, dirSizeSync } from '../core/fsx.ts';
import { bad, conflict, notFound } from '../core/errors.ts';
import { createLogger } from '../core/logger.ts';
import { loadConfig } from '../config.ts';
import * as ports from './portService.ts';
import { autoJava } from './javaService.ts';
import type { BackupPolicy, Gamerules, InstanceConfig, InstanceState, Loader, ScheduleConfig } from '../types.ts';

const logger = createLogger('instance');

export const DEFAULT_GAMERULES: Gamerules = {
  keep_inventory: true,
  mob_griefing: true,
  advance_time: true,
  advance_weather: true,
  spawn_mobs: true,
  immediate_respawn: false,
  show_death_messages: true,
  natural_health_regeneration: true,
  show_advancement_messages: true,
  fall_damage: true,
  spawn_phantoms: true,
  universal_anger: false,
  tnt_explodes: true,
  block_drops: true,
  elytra_movement_check: true,
};

export function defaultSchedule(): ScheduleConfig {
  return {
    start: { enabled: false, times: [], days: [] },
    stop: { enabled: false, times: [], days: [] },
    warnMinutes: 10,
    warnText: '服务器将在 {n} 分钟后关闭，请及时下线',
    warnCommand: '',
    skipIfPlayers: true,
    graceMinutes: 30,
  };
}

export function defaultBackupPolicy(): BackupPolicy {
  return {
    autoEnabled: false,
    intervalMin: 60,
    keepN: 10,
    maxAgeDays: 14,
    maxTotalMb: 0,
    protectManual: true,
  };
}

export function defaultState(): InstanceState {
  return {
    status: 'stopped',
    pid: null,
    startedAt: null,
    cmdlineHash: null,
    listening: false,
    players: 0,
    maxPlayers: 0,
    phase: '',
    progress: null,
    lastError: null,
    lastExitCode: null,
    restarts: 0,
    intentionalStop: false,
    schedule: { lastSave: 0, lastBackup: 0 },
    fired: {},
    pendingStop: null,
  };
}

export function listInstanceIds(): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(INSTANCES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const e of entries) {
    // 用 stat 判断目录（本机 f2fs 的 dirent 对多链接文件会误报，目录也别全信 dirent）
    const full = path.join(INSTANCES_DIR, e.name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (fs.existsSync(instanceConfigFile(e.name))) ids.push(e.name);
  }
  return ids.sort();
}

export function exists(id: string): boolean {
  return INSTANCE_ID_RE.test(id) && fs.existsSync(instanceConfigFile(id));
}

export function getConfig(id: string): InstanceConfig {
  if (!INSTANCE_ID_RE.test(id)) throw bad(`非法的世界 id：${id}`);
  const file = instanceConfigFile(id);
  if (!fs.existsSync(file)) throw notFound(`世界不存在：${id}`);
  const cfg = readJsonSync<InstanceConfig | null>(file, null);
  if (!cfg) throw notFound(`世界的配置文件读不出来：${id}`);
  return normalizeConfig(cfg, id);
}

function normalizeConfig(cfg: InstanceConfig, id: string): InstanceConfig {
  return {
    ...cfg,
    id,
    schemaVersion: 2,
    note: cfg.note ?? '',
    color: cfg.color ?? '#e8d5b7',
    levelName: cfg.levelName || 'world',
    gamerules: { ...DEFAULT_GAMERULES, ...(cfg.gamerules ?? {}) },
    frp: cfg.frp ?? { enabled: true, remotePort: null, mode: 'auto' },
    backup: { ...defaultBackupPolicy(), ...(cfg.backup ?? {}) },
    schedule: { ...defaultSchedule(), ...(cfg.schedule ?? {}) },
    tags: cfg.tags ?? [],
  };
}

export function saveConfig(id: string, patch: Partial<InstanceConfig>): InstanceConfig {
  const cur = getConfig(id);
  const next: InstanceConfig = { ...cur, ...patch, id, schemaVersion: 2 };
  if (!INSTANCE_ID_RE.test(next.id)) throw bad('世界的 id 不合法');
  if (next.port < 1024 || next.port > 65535) throw bad('端口必须在 1024~65535 之间');
  if (next.rconPort < 1024 || next.rconPort > 65535) throw bad('RCON 端口必须在 1024~65535 之间');
  if (next.port === next.rconPort) throw bad('游戏端口与 RCON 端口不能相同');
  if (next.memoryMb < 256 || next.memoryMb > 65536) throw bad('内存必须在 256~65536 MB 之间');
  if (next.minMemoryMb > next.memoryMb) throw bad('初始内存不能大于最大内存');
  atomicWriteJsonWithBackupSync(instanceConfigFile(id), next);
  return next;
}

export function getState(id: string): InstanceState {
  const file = instanceStateFile(id);
  const st = readJsonSync<InstanceState | null>(file, null);
  return { ...defaultState(), ...(st ?? {}) };
}

export function saveState(id: string, patch: Partial<InstanceState>): InstanceState {
  const next = { ...getState(id), ...patch };
  atomicWriteJsonWithBackupSync(instanceStateFile(id), next);
  return next;
}

/** 需要重启才生效的字段 —— 配置页要给用户标出来 */
const RESTART_KEYS: (keyof InstanceConfig)[] = [
  'port', 'rconPort', 'memoryMb', 'minMemoryMb', 'jvmExtra', 'mc', 'loader', 'loaderVersion',
  'javaMajor', 'javaPath', 'onlineMode', 'whiteList', 'levelName', 'levelSeed', 'gamemode',
  'difficulty', 'pvp', 'hardcore', 'allowNether', 'spawnMonsters', 'spawnAnimals', 'spawnNpcs',
  'generateStructures', 'enableCommandBlock', 'maxPlayers', 'motd',
];

export function changedRestartKeys(before: InstanceConfig, after: InstanceConfig): string[] {
  return RESTART_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(String);
}

// ---------------------------------------------------------------- server.properties

/** 面板管得住的属性白名单（其余保持原样，不越权改写） */
const PROP_KEYS: [keyof InstanceConfig, string][] = [
  ['motd', 'motd'],
  ['maxPlayers', 'max-players'],
  ['port', 'server-port'],
  ['rconPort', 'rcon.port'],
  ['onlineMode', 'online-mode'],
  ['whiteList', 'white-list'],
  ['levelSeed', 'level-seed'],
  ['levelName', 'level-name'],
  ['gamemode', 'gamemode'],
  ['difficulty', 'difficulty'],
  ['pvp', 'pvp'],
  ['hardcore', 'hardcore'],
  ['allowNether', 'allow-nether'],
  ['spawnMonsters', 'spawn-monsters'],
  ['spawnAnimals', 'spawn-animals'],
  ['spawnNpcs', 'spawn-npcs'],
  ['generateStructures', 'generate-structures'],
  ['enableCommandBlock', 'enable-command-block'],
  ['viewDistance', 'view-distance'],
  ['simulationDistance', 'simulation-distance'],
];

export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function serializeProperties(props: Record<string, string>): string {
  const keys = Object.keys(props).sort();
  const lines = ['# Minecraft server properties', '# 由 BlockCraft 面板维护：面板管的项会被写回，其余项保持原样', ''];
  for (const k of keys) lines.push(`${k}=${props[k]}`);
  return lines.join('\n') + '\n';
}

export function readActualProperties(id: string): Record<string, string> {
  const file = path.join(instanceServerDir(id), 'server.properties');
  try {
    return parseProperties(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function writeProperties(id: string): void {
  const cfg = getConfig(id);
  const serverDir = instanceServerDir(id);
  fs.mkdirSync(serverDir, { recursive: true });
  const file = path.join(serverDir, 'server.properties');
  const props = readActualProperties(id);
  props['server-port'] = String(cfg.port);
  props['query.port'] = String(cfg.port);
  props['rcon.port'] = String(cfg.rconPort);
  props['rcon.password'] = cfg.rconPassword;
  props['enable-rcon'] = 'true';
  props['enable-query'] = props['enable-query'] ?? 'false';
  props['level-name'] = cfg.levelName || 'world';
  props['max-world-size'] = props['max-world-size'] ?? '29999984';
  props['sync-chunk-writes'] = props['sync-chunk-writes'] ?? 'true';
  for (const [key, prop] of PROP_KEYS) {
    const v = cfg[key];
    if (v === undefined || v === null) continue;
    props[prop] = typeof v === 'boolean' ? String(v) : String(v);
  }
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, file + '.bak');
    } catch {
      /* ignore */
    }
  }
  atomicWriteFileSync(file, serializeProperties(props));
  const eula = path.join(serverDir, 'eula.txt');
  if (!fs.existsSync(eula)) atomicWriteFileSync(eula, '# 由 BlockCraft 面板写入：启动服务端即表示同意 Minecraft EULA\neula=true\n');
}

/** 配置与实际文件的偏差（防止「面板记了新值但服务端还用旧值」） */
export function configDrift(id: string): string[] {
  const cfg = getConfig(id);
  const props = readActualProperties(id);
  const drift: string[] = [];
  const check = (prop: string, expect: unknown) => {
    if (!(prop in props)) return;
    const actual = props[prop];
    const exp = typeof expect === 'boolean' ? String(expect) : String(expect);
    if (actual !== exp) drift.push(`${prop}: 实际 ${actual} / 面板 ${exp}`);
  };
  check('server-port', cfg.port);
  check('rcon.port', cfg.rconPort);
  check('level-name', cfg.levelName || 'world');
  check('online-mode', cfg.onlineMode);
  check('white-list', cfg.whiteList);
  check('max-players', cfg.maxPlayers);
  const jvmFile = path.join(instanceServerDir(id), 'user_jvm_args.txt');
  if (fs.existsSync(jvmFile)) {
    const text = fs.readFileSync(jvmFile, 'utf8');
    if (cfg.javaMajor !== null && cfg.javaMajor >= 9 && !text.includes(`-Xmx${cfg.memoryMb}M`)) {
      drift.push(`user_jvm_args.txt 的 Xmx 与面板不一致（面板 ${cfg.memoryMb}M）`);
    }
  }
  return drift;
}

// ---------------------------------------------------------------- 创建 / 删除

export interface CreateParams {
  id?: string;
  name: string;
  note?: string;
  color?: string;
  mc: string;
  loader: Loader;
  loaderVersion?: string;
  memoryMb?: number;
  minMemoryMb?: number;
  levelSeed?: string;
  gamemode?: string;
  difficulty?: string;
  pvp?: boolean;
  hardcore?: boolean;
  allowNether?: boolean;
  generateStructures?: boolean;
  onlineMode?: boolean;
  whiteList?: boolean;
  maxPlayers?: number;
  motd?: string;
  viewDistance?: number;
  simulationDistance?: number;
  gamerules?: Gamerules;
  autostart?: boolean;
  createdFrom?: InstanceConfig['createdFrom'];
  importedFrom?: InstanceConfig['importedFrom'];
  tags?: string[];
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return base || 'world_' + Math.random().toString(36).slice(2, 7);
}

/** 只登记元数据与端口，不下载任何东西（安装由 installService 负责） */
export async function createInstance(params: CreateParams): Promise<InstanceConfig> {
  const panel = loadConfig();
  const id = (params.id ?? slugify(params.name)).trim();
  if (!INSTANCE_ID_RE.test(id)) throw bad('世界 id 只能包含字母、数字、下划线、连字符，长度 1~40');
  if (exists(id)) throw conflict(`世界 ${id} 已经存在`);
  const dir = instanceDir(id);
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backups', '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });

  const java = autoJava(params.mc, params.loader);
  const port = await ports.allocateLocal(id, panel.portRanges.game, panel.portRanges.rcon);
  const remote = await ports.allocateRemote(id, panel.portRanges.frpRemote, new Set());

  const now = Date.now() / 1000;
  const cfg: InstanceConfig = {
    schemaVersion: 2,
    id,
    name: params.name,
    note: params.note ?? '',
    color: params.color ?? '#e9e2d0',
    mc: params.mc,
    loader: params.loader,
    loaderVersion: params.loaderVersion ?? '',
    javaMajor: java.required,
    javaPath: java.runtime?.path ?? '',
    port: port.game,
    rconPort: port.rcon,
    rconPassword: Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10),
    memoryMb: params.memoryMb ?? 3072,
    minMemoryMb: params.minMemoryMb ?? 1024,
    jvmExtra: '',
    autostart: params.autostart ?? false,
    motd: params.motd ?? params.name,
    maxPlayers: params.maxPlayers ?? 20,
    levelSeed: params.levelSeed ?? '',
    levelName: 'world',
    gamemode: params.gamemode ?? 'survival',
    difficulty: params.difficulty ?? 'normal',
    pvp: params.pvp ?? true,
    hardcore: params.hardcore ?? false,
    onlineMode: params.onlineMode ?? false,
    whiteList: params.whiteList ?? false,
    viewDistance: params.viewDistance ?? 6,
    simulationDistance: params.simulationDistance ?? 5,
    allowNether: params.allowNether ?? true,
    spawnMonsters: true,
    spawnAnimals: true,
    spawnNpcs: true,
    generateStructures: params.generateStructures ?? true,
    enableCommandBlock: false,
    gamerules: { ...DEFAULT_GAMERULES, ...(params.gamerules ?? {}) },
    frp: { enabled: true, remotePort: remote, mode: 'auto' },
    backup: defaultBackupPolicy(),
    schedule: defaultSchedule(),
    created: now,
    createdAt: now,
    createdFrom: params.createdFrom ?? { type: 'new' },
    importedFrom: params.importedFrom ?? null,
    tags: params.tags ?? [],
  };
  atomicWriteJsonWithBackupSync(instanceConfigFile(id), cfg);
  saveState(id, defaultState());
  writeProperties(id);
  logger.info(`已创建世界 ${id}`, { port: cfg.port, rcon: cfg.rconPort, frp: remote });
  return cfg;
}

export function markDeleted(id: string): void {
  const dir = instanceDir(id);
  const trash = path.join(path.dirname(dir), '..', 'data', 'trash');
  fs.mkdirSync(trash, { recursive: true });
  const target = path.join(trash, `${id}-${Date.now()}`);
  fs.renameSync(dir, target);
  ports.release(id);
  logger.info(`世界 ${id} 已移入回收站`, { target });
}

export function deleteInstance(id: string, purge: boolean): void {
  const dir = instanceDir(id);
  if (!fs.existsSync(dir)) throw notFound(`世界不存在：${id}`);
  if (purge) {
    fs.rmSync(dir, { recursive: true, force: true });
    ports.release(id);
    logger.warn(`世界 ${id} 已彻底删除`);
  } else {
    markDeleted(id);
  }
}

export function instanceSize(id: string): { total: number; server: number; backups: number } {
  const dir = instanceDir(id);
  // 纳管进来的世界，server 是指向原目录的软链 —— 统计时要跟随，否则显示 0
  const serverPath = (() => {
    const p = instanceServerDir(id);
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  })();
  return {
    total: dirSizeSync(dir, { followSymlinks: true }),
    server: dirSizeSync(serverPath),
    backups: dirSizeSync(path.join(dir, 'backups')),
  };
}
