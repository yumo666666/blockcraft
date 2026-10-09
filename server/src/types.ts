/**
 * BlockCraft v2 · 共享类型定义
 * 约定：config.json 只放「意图」，state.json 只放「运行态」，两者永不混写。
 */

export type Loader = 'vanilla' | 'forge' | 'neoforge' | 'fabric' | 'paper';

export type InstanceStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stuck'
  | 'crashed';

export interface Gamerules {
  [key: string]: boolean;
}

export interface ScheduleRule {
  enabled: boolean;
  /** `HH:MM` 形式，多个时间点 */
  times: string[];
  /** 1=周一 … 7=周日；空数组 = 每天 */
  days: number[];
}

export interface ScheduleConfig {
  start: ScheduleRule;
  stop: ScheduleRule;
  /** 停服前多少分钟公告 */
  warnMinutes: number;
  /** 公告文案，支持 {n} 占位 */
  warnText: string;
  /** 自定义公告命令（留空则用 say） */
  warnCommand: string;
  /** 到点有玩家在线就等最后一人下线 */
  skipIfPlayers: boolean;
  /** 最多等多久（分钟），0 = 一直等 */
  graceMinutes: number;
}

export interface BackupPolicy {
  autoEnabled: boolean;
  intervalMin: number;
  keepN: number;
  maxAgeDays: number;
  maxTotalMb: number;
  protectManual: boolean;
}

export interface FrpBinding {
  enabled: boolean;
  /** 分配所得的远端端口，null = 未分配 */
  remotePort: number | null;
  mode: 'auto' | 'pinned';
}

export interface InstanceConfig {
  schemaVersion: number;
  id: string;
  name: string;
  note: string;
  color: string;
  mc: string;
  loader: Loader;
  loaderVersion: string;
  javaMajor: number | null;
  javaPath: string;
  port: number;
  rconPort: number;
  rconPassword: string;
  memoryMb: number;
  minMemoryMb: number;
  jvmExtra: string;
  autostart: boolean;
  motd: string;
  maxPlayers: number;
  levelSeed: string;
  levelName: string;
  gamemode: string;
  difficulty: string;
  pvp: boolean;
  hardcore: boolean;
  onlineMode: boolean;
  whiteList: boolean;
  viewDistance: number;
  simulationDistance: number;
  /** 存盘时是否强制刷盘（true 更安全但会阻塞主线程导致卡顿） */
  syncChunkWrites: boolean;
  /** 单 tick 超过多少毫秒就判定卡死（服务端自带看门狗；0 = 关闭） */
  maxTickTime: number;
  allowNether: boolean;
  spawnMonsters: boolean;
  spawnAnimals: boolean;
  spawnNpcs: boolean;
  generateStructures: boolean;
  enableCommandBlock: boolean;
  gamerules: Gamerules;
  frp: FrpBinding;
  backup: BackupPolicy;
  schedule: ScheduleConfig;
  created: number;
  createdAt: number;
  createdFrom: { type: 'new' | 'copy' | 'import' | 'adopt'; source?: string } | null;
  importedFrom: { file: string; format: string } | null;
  tags: string[];
}

export interface InstanceState {
  status: InstanceStatus;
  pid: number | null;
  startedAt: number | null;
  cmdlineHash: string | null;
  listening: boolean;
  players: number;
  maxPlayers: number;
  phase: string;
  progress: string | null;
  lastError: string | null;
  lastExitCode: number | null;
  restarts: number;
  intentionalStop: boolean;
  schedule: { lastSave: number; lastBackup: number };
  fired: Record<string, string>;
  pendingStop: { since: number; deadline: number; at: string } | null;
}

export interface InstanceSummary {
  id: string;
  name: string;
  note: string;
  color: string;
  mc: string;
  loader: Loader;
  loaderVersion: string;
  port: number;
  frpPort: number | null;
  frpEnabled: boolean;
  memoryMb: number;
  minMemoryMb: number;
  autostart: boolean;
  status: InstanceStatus;
  phase: string;
  progress: string | null;
  pid: number | null;
  uptime: number;
  cpu: number;
  rss: number;
  players: number;
  maxPlayers: number;
  modCount: number;
  diskUsage: number;
  lastBackup: number | null;
  intentionalStop: boolean;
  createdAt: number;
  javaMajor: number | null;
  /** 上次崩溃/异常退出的原因（面板自动读崩溃报告生成） */
  lastError: string | null;
}

export interface PortRegistry {
  game: Record<string, number>;
  rcon: Record<string, number>;
  frp: Record<string, number>;
}

export interface PanelConfig {
  schemaVersion: number;
  panel: {
    host: string;
    port: number;
    token: string;
    sessionHours: number;
  };
  portRanges: {
    game: [number, number];
    rcon: [number, number];
    frpRemote: [number, number];
  };
  frp: {
    enabled: boolean;
    binary: string;
    serverAddr: string;
    serverPort: number;
    token: string;
    tls: boolean;
    adminPortPanel: number;
    adminPortWorlds: number;
    adminUser: string;
    adminPassword: string;
    dashboardUrl: string;
    dashboardUser: string;
    dashboardPassword: string;
    exposePanel: boolean;
    panelRemotePort: number;
    /** 别人的代理名，只读不碰 */
    foreignProxies: string[];
    configRollback: boolean;
    selfCheckOnReload: boolean;
  };
  limits: {
    maxRunningInstances: number;
    memoryBudgetMb: number | 'auto';
  };
  mirrors: {
    curseforgeApi: string;
    curseforgeApiKey: string;
    curseforgeMirrorEnabled: boolean;
    forgeMaven: string[];
    githubMirror: string;
  };
  skins: {
    /** MineSkin API key. Optional for the public service, but improves limits/latency. */
    mineskinApiKey: string;
  };
  ui: {
    accent: string;
    trashRetentionDays: number;
  };
}

export interface Job {
  id: string;
  kind: 'create' | 'import' | 'copy' | 'backup' | 'rollback' | 'install';
  title: string;
  instanceId: string | null;
  status: 'running' | 'done' | 'failed' | 'interrupted';
  stages: { key: string; label: string; status: 'pending' | 'running' | 'done' | 'failed' }[];
  lines: string[];
  progress: number;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface BackupEntry {
  file: string;
  created: number;
  type: 'manual' | 'auto' | 'pre-rollback' | 'startup';
  worldName: string;
  bytes: number;
  sha256: string;
  regions: number;
  status: 'ok' | 'partial' | 'rejected';
  note: string;
  mc: string;
  loader: Loader;
}

export interface ModInfo {
  file: string;
  name: string;
  modId: string | null;
  version: string | null;
  description: string;
  authors: string[];
  enabled: boolean;
  bytes: number;
  mtime: number;
  source: 'modrinth' | 'curseforge' | 'local' | 'unknown';
  sourceUrl: string | null;
  iconUrl: string | null;
  projectTitle: string | null;
  missingDeps: string[];
  hasUpdate: boolean;
  latestVersion: string | null;
}

export interface PlayerInfo {
  name: string;
  uuid: string | null;
  online: boolean;
  op: boolean;
  whitelisted: boolean;
  banned: boolean;
  lastSeen: number | null;
  skinUrl: string | null;
  skinSource: 'server' | 'bound' | 'mojang' | 'none';
  /** Whether the current binding was accepted by an installed server skin integration. */
  skinAppliedToServer: boolean;
  playtimeSeconds: number | null;
}
