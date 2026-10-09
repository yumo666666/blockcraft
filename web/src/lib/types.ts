export interface InstanceSummary {
  id: string;
  name: string;
  note: string;
  color: string;
  mc: string;
  loader: string;
  loaderVersion: string;
  port: number;
  frpPort: number | null;
  frpEnabled: boolean;
  memoryMb: number;
  minMemoryMb: number;
  autostart: boolean;
  status: string;
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

export interface SystemSnapshot {
  memory: {
    totalMb: number;
    usedMb: number;
    availableMb: number;
    swapTotalMb: number;
    swapUsedMb: number;
    swapAvailable: boolean;
    loadAvgAvailable: boolean;
    loadAvg: number | null;
  };
  disk: { totalGb: number; freeGb: number; usedGb: number };
  panel: { pid: number; rss: number; cpu: number; uptime: number };
  cpuCount: number;
  cpuPercent: number | null;
  platform: string;
  arch: string;
  hostname: string;
}

export interface FrpStatus {
  enabled: boolean;
  configured: boolean;
  binaryReady: boolean;
  channels: { name: string; running: boolean; pid: number | null; error: string | null; proxyCount: number; lastReload: number | null }[];
  proxies: { name: string; status: string; localAddr: string; remoteAddr: string; err: string }[];
  panelProxy: { remotePort: number; localPort: number; online: boolean } | null;
  remoteRange: [number, number];
  server: { addr: string; port: number; tls: boolean; reachable: boolean; latencyMs: number | null };
  dashboard: { available: boolean; proxies: { name: string; remotePort: number | null; status: string; trafficIn: number; trafficOut: number }[] };
  foreignProxies: string[];
}

export interface InstanceDetail {
  instance: InstanceSummary;
  config: Record<string, unknown>;
  state: Record<string, unknown>;
  installed: boolean;
  missing: string[];
  launchHow: string;
  drift: string[];
  java: number | null;
}

export interface ConsoleLine {
  seq: number;
  ts: number;
  text: string;
}

export interface ScheduleInfo {
  schedule: {
    start: { enabled: boolean; times: string[]; days: number[] };
    stop: { enabled: boolean; times: string[]; days: number[] };
    warnMinutes: number;
    warnText: string;
    warnCommand: string;
    skipIfPlayers: boolean;
    graceMinutes: number;
  };
  describe: string;
  nextStart: number | null;
  nextStop: number | null;
  pendingStop: { since: number; deadline: number; at: string } | null;
}

export interface BackupEntry {
  file: string;
  created: number;
  type: string;
  worldName: string;
  bytes: number;
  sha256: string;
  regions: number;
  status: string;
  note: string;
  mc: string;
  loader: string;
}

export interface Job {
  id: string;
  kind: string;
  title: string;
  instanceId: string | null;
  status: string;
  stages: { key: string; label: string; status: string }[];
  lines: string[];
  progress: number;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
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
  source: string;
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
  skinPreviewUrl?: string | null;
  skinSource: 'server' | 'bound' | 'mojang' | 'none';
  skinAppliedToServer: boolean;
  playtimeSeconds: number | null;
}

export interface SkinPoolEntry {
  id: string;
  name: string;
  model: 'classic' | 'slim';
  bytes: number;
  createdAt: number;
  imageUrl: string;
  previewUrl: string;
  previewReady: boolean;
}
