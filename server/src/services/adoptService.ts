import fs from 'node:fs';
import path from 'node:path';
import { INSTANCES_DIR, instanceConfigFile, instanceDir, INSTANCE_ID_RE } from '../core/paths.ts';
import { atomicWriteJsonWithBackupSync, readJsonSync } from '../core/fsx.ts';
import { bad, conflict, notFound } from '../core/errors.ts';
import { createLogger } from '../core/logger.ts';
import * as I from './instanceService.ts';
import * as ports from './portService.ts';
import { loadConfig } from '../config.ts';
import { javaByMajor, requiredJavaFor } from './javaService.ts';
import type { InstanceConfig, Loader } from '../types.ts';

const logger = createLogger('adopt');

/** 从已有的服务端目录里识别 MC 版本与加载器 —— 只读，不改动任何文件 */
export interface Detection {
  dir: string;
  loader: Loader;
  mc: string | null;
  loaderVersion: string;
  javaMajor: number;
  port: number;
  rconPort: number | null;
  levelName: string;
  hasRcon: boolean;
  modsCount: number;
  evidence: string[];
  memory: { memoryMb: number | null; minMemoryMb: number | null };
}

function readProps(serverDir: string): Record<string, string> {
  try {
    const text = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8');
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function countJars(dir: string): number {
  return listDir(dir).filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled')).length;
}

/** forge 安装产物里带版本号目录：libraries/net/minecraftforge/forge/<mc>-<fv> */
function detectForge(serverDir: string): { mc: string; version: string } | null {
  const base = path.join(serverDir, 'libraries', 'net', 'minecraftforge', 'forge');
  const dirs = listDir(base);
  for (const d of dirs) {
    const m = d.match(/^(.+?)-([\d.]+)$/);
    if (m) return { mc: m[1], version: m[2] };
  }
  for (const f of listDir(serverDir)) {
    const m = f.match(/^forge-(.+?)-([\d.]+)(?:-installer)?\.jar$/);
    if (m && !f.includes('installer')) return { mc: m[1], version: m[2] };
  }
  return null;
}

function detectNeoForge(serverDir: string): { mc: string; version: string } | null {
  const base = path.join(serverDir, 'libraries', 'net', 'neoforged', 'neoforge');
  const dirs = listDir(base);
  if (dirs.length) {
    const version = dirs[0];
    // NeoForge 版本号 20.4.x 对应 MC 1.20.4
    const m = version.match(/^(\d+)\.(\d+)\./);
    const mc = m ? `1.${m[1]}.${m[2]}` : null;
    return { mc: mc ?? '', version };
  }
  return null;
}

function detectFabric(serverDir: string): { mc: string; version: string } | null {
  if (!listDir(serverDir).includes('fabric-server-launch.jar')) return null;
  // .fabric/remappedJars/minecraft-<mc>-<loaderver>/ 里带版本
  const remapped = path.join(serverDir, '.fabric', 'remappedJars');
  for (const d of listDir(remapped)) {
    const m = d.match(/^minecraft-(.+?)-([\d.]+)$/);
    if (m) return { mc: m[1], version: m[2] };
  }
  const versions = listDir(path.join(serverDir, 'versions'));
  if (versions.length) {
    const v = versions[0];
    const parts = fs.existsSync(path.join(serverDir, 'versions', v, `${v}.json`))
      ? JSON.parse(fs.readFileSync(path.join(serverDir, 'versions', v, `${v}.json`), 'utf8'))
      : null;
    const loader = (parts as { libraries?: { name?: string }[] } | null)?.libraries?.find((l) => l.name?.startsWith('net.fabricmc:fabric-loader:'))?.name?.split(':')[2];
    if (loader) return { mc: v, version: loader };
    return { mc: v, version: '' };
  }
  return { mc: '', version: '' };
}

function detectPaper(serverDir: string): { mc: string; version: string } | null {
  for (const f of listDir(serverDir)) {
    const m = f.match(/^paper-(.+?)-(\d+)\.jar$/);
    if (m) return { mc: m[1], version: m[2] };
    if (f === 'paper.jar') return { mc: '', version: '' };
  }
  return null;
}

/** 从已有的 user_jvm_args.txt 里读出内存设置 —— 纳管时不能凭空改成默认值 */
function detectMemory(serverDir: string): { memoryMb: number | null; minMemoryMb: number | null } {
  try {
    const text = fs.readFileSync(path.join(serverDir, 'user_jvm_args.txt'), 'utf8');
    const xmx = text.match(/-Xmx(\d+)([MmGg]?)/);
    const xms = text.match(/-Xms(\d+)([MmGg]?)/);
    const toMb = (m: RegExpMatchArray | null) => {
      if (!m) return null;
      const v = Number(m[1]);
      return /[Gg]/.test(m[2]) ? v * 1024 : v;
    };
    return { memoryMb: toMb(xmx), minMemoryMb: toMb(xms) };
  } catch {
    return { memoryMb: null, minMemoryMb: null };
  }
}

export function detect(dir: string): Detection {
  const serverDir = path.resolve(dir);
  if (!fs.existsSync(serverDir)) throw bad(`目录不存在：${serverDir}`);
  const props = readProps(serverDir);
  const evidence: string[] = [];
  let loader: Loader = 'vanilla';
  let mc: string | null = null;
  let loaderVersion = '';

  const forge = detectForge(serverDir);
  const neo = detectNeoForge(serverDir);
  const fabric = detectFabric(serverDir);
  const paper = detectPaper(serverDir);

  if (neo) {
    loader = 'neoforge';
    mc = neo.mc || null;
    loaderVersion = neo.version;
    evidence.push(`libraries/net/neoforged/neoforge/${neo.version}`);
  } else if (forge) {
    loader = 'forge';
    mc = forge.mc;
    loaderVersion = forge.version;
    evidence.push(`libraries/net/minecraftforge/forge/${forge.mc}-${forge.version}`);
  } else if (fabric) {
    loader = 'fabric';
    mc = fabric.mc || null;
    loaderVersion = fabric.version;
    evidence.push('fabric-server-launch.jar' + (fabric.mc ? ` + .fabric/remappedJars/minecraft-${fabric.mc}-${fabric.version}` : ''));
  } else if (paper) {
    loader = 'paper';
    mc = paper.mc || null;
    loaderVersion = paper.version;
    evidence.push('paper jar');
  } else if (listDir(serverDir).includes('minecraft_server.jar')) {
    evidence.push('minecraft_server.jar');
  }

  // 兜底：从 server.properties 里找不到版本时，用 level.dat 之外的线索无法判定，交给调用方指定
  const port = Number(props['server-port'] ?? 25565);
  const rconPort = props['rcon.port'] ? Number(props['rcon.port']) : null;
  const javaMajor = mc ? requiredJavaFor(mc, loader) : 17;
  return {
    dir: serverDir,
    loader,
    mc,
    loaderVersion,
    javaMajor,
    port: Number.isFinite(port) ? port : 25565,
    rconPort,
    levelName: props['level-name'] ?? 'world',
    hasRcon: props['enable-rcon'] === 'true' && Boolean(props['rcon.password']),
    modsCount: countJars(path.join(serverDir, 'mods')),
    evidence,
    memory: detectMemory(serverDir),
  };
}

export interface AdoptOptions {
  dir: string;
  id?: string;
  name?: string;
  mc?: string;
  loader?: Loader;
  loaderVersion?: string;
  memoryMb?: number;
  /** 是否把面板管的配置写回原目录的 server.properties（默认不写，保持原目录零改动） */
  writeProperties?: boolean;
}

/**
 * 纳管一个已经存在的世界目录：**不移动、不改动任何原有文件**。
 * 做法是在 instances/<id>/server 建一个符号链接指向原目录，
 * 端口沿用原 server.properties 里的值并登记进端口表（所以不会和别的世界撞）。
 */
export async function adopt(opts: AdoptOptions): Promise<InstanceConfig> {
  const det = detect(opts.dir);
  const mc = opts.mc ?? det.mc;
  if (!mc) throw bad('识别不出 Minecraft 版本，请在纳管时手动指定');
  const loader = opts.loader ?? det.loader;
  const id = (opts.id ?? I.slugify(opts.name ?? path.basename(det.dir))).trim();
  if (!INSTANCE_ID_RE.test(id)) throw bad('世界 id 只能包含字母、数字、下划线、连字符');
  if (I.exists(id)) throw conflict(`世界 ${id} 已经存在`);
  if (fs.existsSync(instanceDir(id))) throw conflict(`目标目录已存在：${instanceDir(id)}`);

  const panel = loadConfig();
  // 端口：沿用原来 server.properties 里的，占住登记表以免与其它世界冲突
  const reg = ports.snapshot();
  const gameTaken = Object.values(reg.game).includes(det.port);
  const gamePort = gameTaken ? det.port : det.port;
  fs.mkdirSync(instanceDir(id), { recursive: true });
  fs.symlinkSync(det.dir, path.join(instanceDir(id), 'server'));
  fs.mkdirSync(path.join(instanceDir(id), 'backups', '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(instanceDir(id), 'logs'), { recursive: true });

  const alloc = await ports.allocateLocal(id, panel.portRanges.game, panel.portRanges.rcon, {
    game: gamePort,
    rcon: det.rconPort ?? undefined,
  });
  const remote = await ports.allocateRemote(id, panel.portRanges.frpRemote, new Set());
  const now = Date.now() / 1000;
  const java = javaByMajor(det.javaMajor);

  const cfg: InstanceConfig = {
    schemaVersion: 2,
    id,
    name: opts.name ?? path.basename(det.dir),
    note: `纳管自 ${det.dir}`,
    color: '#dfeeec',
    mc,
    loader,
    loaderVersion: opts.loaderVersion ?? det.loaderVersion,
    javaMajor: det.javaMajor,
    javaPath: java?.path ?? '',
    port: alloc.game,
    rconPort: alloc.rcon,
    rconPassword: det.hasRcon ? readProps(det.dir)['rcon.password'] : Math.random().toString(36).slice(2, 12),
    // 内存见上面（沿用原设置）
    // 沿用原目录里 user_jvm_args.txt 的内存设置，没读到才用默认值
    memoryMb: opts.memoryMb ?? det.memory.memoryMb ?? 3072,
    minMemoryMb: det.memory.minMemoryMb ?? Math.min(1024, det.memory.memoryMb ?? 1024),
    jvmExtra: '',
    autostart: false,
    motd: readProps(det.dir)['motd'] ?? (opts.name ?? id),
    maxPlayers: Number(readProps(det.dir)['max-players'] ?? 20),
    levelSeed: readProps(det.dir)['level-seed'] ?? '',
    levelName: det.levelName,
    gamemode: readProps(det.dir)['gamemode'] ?? 'survival',
    difficulty: readProps(det.dir)['difficulty'] ?? 'normal',
    pvp: readProps(det.dir)['pvp'] !== 'false',
    hardcore: readProps(det.dir)['hardcore'] === 'true',
    onlineMode: readProps(det.dir)['online-mode'] === 'true',
    whiteList: readProps(det.dir)['white-list'] === 'true',
    viewDistance: Number(readProps(det.dir)['view-distance'] ?? 6),
    simulationDistance: Number(readProps(det.dir)['simulation-distance'] ?? 5),
    allowNether: readProps(det.dir)['allow-nether'] !== 'false',
    spawnMonsters: readProps(det.dir)['spawn-monsters'] !== 'false',
    spawnAnimals: readProps(det.dir)['spawn-animals'] !== 'false',
    spawnNpcs: readProps(det.dir)['spawn-npcs'] !== 'false',
    generateStructures: readProps(det.dir)['generate-structures'] !== 'false',
    enableCommandBlock: readProps(det.dir)['enable-command-block'] === 'true',
    gamerules: { ...I.DEFAULT_GAMERULES },
    frp: { enabled: true, remotePort: remote, mode: 'auto' },
    backup: I.defaultBackupPolicy(),
    schedule: I.defaultSchedule(),
    created: now,
    createdAt: now,
    createdFrom: { type: 'adopt', source: det.dir },
    importedFrom: null,
    tags: ['纳管'],
  };
  atomicWriteJsonWithBackupSync(instanceConfigFile(id), cfg);
  I.saveState(id, I.defaultState());
  if (opts.writeProperties) {
    // 只有在用户明确要求时才动原目录（会补上 rcon 等面板需要的东西）
    I.writeProperties(id);
  }
  logger.info(`已纳管世界 ${id}`, { dir: det.dir, loader, mc, port: alloc.game });
  return cfg;
}

/** 扫描一个父目录，找出里面所有看起来是服务端的世界（用于「批量纳管」提示） */
export function scanCandidates(root: string, depth = 2): (Detection & { name: string })[] {
  const out: (Detection & { name: string })[] = [];
  const walk = (dir: string, level: number) => {
    if (level > depth) return;
    for (const name of listDir(dir)) {
      const full = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const isServer = fs.existsSync(path.join(full, 'server.properties'));
      if (isServer) {
        try {
          out.push({ ...detect(full), name });
        } catch {
          /* ignore */
        }
      } else {
        walk(full, level + 1);
      }
    }
  };
  if (!fs.existsSync(root)) throw notFound(`目录不存在：${root}`);
  walk(root, 1);
  return out;
}

export { INSTANCES_DIR, readJsonSync };
