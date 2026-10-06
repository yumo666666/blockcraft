/**
 * BlockCraft v2 · 备份与回退服务
 *
 * 设计要点（都是实战踩坑换来的）：
 *  1. MC 服务端「先绑端口、再生成世界」，世界刚建好时存档里可能只有 level.dat + datapacks/ + session.lock。
 *     这种半成品包一旦回退，服务端会报 `Overworld settings missing` 直接起不来 —— 半成品备份比没有备份更危险。
 *     因此这里有三道防护：打包前判世界生成完 → 打包后复验区域文件 → 回退前再验一次。
 *  2. 写盘顺序固定：.tmp 里生成 → 复验 → 算 sha256 → rename 进正式目录 → 最后才原子写 index.json。
 *     任何一步失败都不会留下「index 里有、磁盘上没有」的幽灵条目。
 *  3. 本模块只管存档目录的打包/解压，启停服由调用方通过 hooks 注入（本模块不负责停服）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// yazl / yauzl 是 CJS 且不带类型声明，按默认导入 + 断言使用
// @ts-ignore 该模块没有类型声明文件
import yazlModule from 'yazl';
// @ts-ignore 该模块没有类型声明文件
import yauzlModule from 'yauzl';
import { INSTANCE_ID_RE, instanceBackupDir, instanceServerDir } from '../core/paths.ts';
import { atomicWriteJsonWithBackupSync, dirSizeSync, listFilesSync, readJsonSync } from '../core/fsx.ts';
import { bad, busy, notFound, notReady } from '../core/errors.ts';
import { createLogger } from '../core/logger.ts';
import { withLock } from '../core/lock.ts';
import type { BackupEntry, BackupPolicy, Loader } from '../types.ts';

const logger = createLogger('backup');

/** 判「世界生成完」时最多扫这么多文件就放弃 */
const MAX_SCAN_FILES = 20000;
/** 打包列文件的上限（防御性，避免被异常目录拖死） */
const MAX_ARCHIVE_FILES = 200000;
/** level.dat 至少这么大才算世界已经生成（正常约 386B 起） */
const MIN_LEVEL_DAT_BYTES = 200;
/** 区域文件后缀：.mca（Anvil）/ .mcr（旧版 McRegion） */
const REGION_RE = /\.(mca|mcr)$/i;
/** 文件名里不允许出现的字符 */
const UNSAFE_RE = /[/\\:*?"<>|]/g;

const yazl = yazlModule as unknown as {
  ZipFile: new () => {
    addFile: (realPath: string, metadataPath: string) => void;
    end: () => void;
    outputStream: NodeJS.ReadableStream & { on: (ev: string, cb: (e: unknown) => void) => void; pipe: (w: unknown) => void };
  };
};
const yauzl = yauzlModule as unknown as {
  open: (file: string, opts: Record<string, unknown>, cb: (err: Error | null, zip: any) => void) => void;
};

export interface BackupContext {
  instanceId: string;
  name: string; // 世界显示名（用于文件名）
  mc: string;
  loader: Loader;
  levelName: string; // 存档目录名，默认 'world'
  policy: BackupPolicy;
  /** 调用方注入：生成备份前必须先优雅停服再调用（本模块不负责停服），但要检查这一项 */
  isRunning: () => boolean;
}

export interface RollbackHooks {
  stop: () => Promise<void>;
  start: () => Promise<void>;
  onStage: (stage: string, label: string, detail?: string) => void;
  levelName: string;
  /** 可选：调用方停服后回调核验（仍为 true 则按 busy 拒绝），不传则跳过该项检查 */
  isRunning?: () => boolean;
}

export interface WorldStatus {
  ready: boolean;
  regions: number;
  levelDatBytes: number;
  reason: string | null;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function assertInstanceId(instanceId: string): void {
  if (!INSTANCE_ID_RE.test(instanceId)) throw bad(`实例 id 非法：${instanceId}`);
}

function lockKey(instanceId: string): string {
  return `backup:${instanceId}`;
}

/** 存档目录名，空值回落到 world；并挡掉路径穿越 */
function levelOf(raw: string | undefined): string {
  const s = (raw ?? '').trim() || 'world';
  if (s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) {
    throw bad(`存档目录名非法：${raw}`);
  }
  return s;
}

/** 世界显示名 → 安全文件名片段 */
function safeName(raw: string): string {
  const s = (raw ?? '')
    .replace(UNSAFE_RE, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '_')
    .slice(0, 60)
    .trim();
  return s || 'world';
}

/** 本地时间 `YYYYMMDD-HHmmss`（按名字排序即按时间排序） */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 保底目录用的高精度时间戳：同一秒内连续两次回退也不会撞名（撞名的 rename 会失败并把老保底删掉） */
function stampMs(d = new Date()): string {
  return `${stamp(d)}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** BackupEntry.type → 文件名里的短标签 */
const TAG: Record<BackupEntry['type'], string> = {
  manual: 'manual',
  auto: 'auto',
  startup: 'startup',
  'pre-rollback': 'preroll',
};

function backupDirOf(instanceId: string): string {
  return instanceBackupDir(instanceId);
}
function indexFileOf(instanceId: string): string {
  return path.join(backupDirOf(instanceId), 'index.json');
}
function tmpDirOf(instanceId: string): string {
  return path.join(backupDirOf(instanceId), '.tmp');
}

/** 把任意路径拼到目标目录下；越界（zip slip）返回 null */
function safeJoin(root: string, rel: string): string | null {
  const target = path.resolve(root, rel);
  const base = path.resolve(root);
  if (target === base || target.startsWith(base + path.sep)) return target;
  return null;
}

function say(onLog: ((s: string) => void) | undefined, scope: string, msg: string): void {
  logger.info(`[${scope}] ${msg}`);
  try {
    onLog?.(msg);
  } catch {
    /* 回调抛错不影响主流程 */
  }
}

/* ------------------------------------------------------------------ */
/* 目录遍历（一律不用 dirent.isFile()：本机 f2fs 会把多链接文件报成 DT_LNK） */
/* ------------------------------------------------------------------ */

/** 收集每个子目录（含根）里的普通文件；rel 用 `/` 分隔，作为 zip 内路径 */
function collectTree(root: string): {
  files: { full: string; rel: string }[];
  regions: number;
  scanned: number;
  capped: boolean;
} {
  const files: { full: string; rel: string }[] = [];
  let regions = 0;
  let scanned = 0;
  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = rel ? path.join(root, rel) : root;
    for (const full of listFilesSync(abs)) {
      scanned++;
      if (scanned > MAX_ARCHIVE_FILES) return { files, regions, scanned, capped: true };
      const one = `${rel ? `${rel}/` : ''}${path.basename(full).replace(/\\/g, '/')}`;
      if (REGION_RE.test(one)) regions++;
      files.push({ full, rel: one });
    }
    for (const sub of subDirs(abs)) stack.push(rel ? `${rel}/${sub.replace(/\\/g, '/')}` : sub);
  }
  return { files, regions, scanned, capped: false };
}

/** 只列子目录（用 lstat，软链目录不跟随，避免环） */
function subDirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    try {
      if (fs.lstatSync(path.join(dir, e.name)).isDirectory()) out.push(e.name);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** 防护 1：整棵存档树里是否已经有区域文件（最多扫 MAX_SCAN_FILES 个文件） */
function probeRegions(root: string): { ready: boolean; scanned: number; capped: boolean } {
  let scanned = 0;
  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = rel ? path.join(root, rel) : root;
    for (const full of listFilesSync(abs)) {
      scanned++;
      if (REGION_RE.test(full)) return { ready: true, scanned, capped: false };
      if (scanned >= MAX_SCAN_FILES) return { ready: false, scanned, capped: true };
    }
    for (const sub of subDirs(abs)) stack.push(rel ? `${rel}/${sub}` : sub);
  }
  return { ready: false, scanned, capped: false };
}

/* ------------------------------------------------------------------ */
/* zip 读写                                                            */
/* ------------------------------------------------------------------ */

/** 打包。files[].rel 为 zip 内路径（相对存档根，正斜杠） */
function writeZip(files: { full: string; rel: string }[], outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const ws = fs.createWriteStream(outFile);
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) {
        try {
          ws.destroy();
        } catch {
          /* ignore */
        }
        reject(err);
      } else {
        resolve();
      }
    };
    zip.outputStream.on('error', (e: unknown) => done(e));
    ws.on('error', (e: unknown) => done(e));
    ws.on('close', () => done());
    try {
      for (const f of files) zip.addFile(f.full, f.rel);
    } catch (err) {
      done(err);
      return;
    }
    zip.outputStream.pipe(ws);
    zip.end();
  });
}

/** 只读中央目录统计区域文件数（防护 2 / 3 用） */
function countZipRegions(file: string): Promise<{ entries: number; regions: number }> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err: Error | null, zip: any) => {
      if (err || !zip) {
        reject(err ?? new Error('打开备份包失败'));
        return;
      }
      let entries = 0;
      let regions = 0;
      let settled = false;
      zip.on('error', (e: unknown) => {
        if (settled) return;
        settled = true;
        reject(e);
      });
      zip.on('entry', (entry: any) => {
        entries++;
        if (REGION_RE.test(String(entry?.fileName ?? ''))) regions++;
        zip.readEntry();
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ entries, regions });
      });
      zip.readEntry();
    });
  });
}

/** 解压到 destDir；stripPrefix（如 `world/`）会被剥掉，兼容两种打包布局 */
function extractZip(zipFile: string, destDir: string, stripPrefix: string): Promise<{ entries: number; regions: number }> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err: Error | null, zip: any) => {
      if (err || !zip) {
        reject(err ?? new Error('打开备份包失败'));
        return;
      }
      const stats = { entries: 0, regions: 0 };
      let failed = false;
      const fail = (e: unknown) => {
        if (failed) return;
        failed = true;
        try {
          zip.close();
        } catch {
          /* ignore */
        }
        reject(e);
      };
      zip.on('error', fail);
      zip.on('entry', (entry: any) => {
        if (failed) return;
        let name = String(entry?.fileName ?? '').replace(/\\/g, '/');
        if (stripPrefix && name.startsWith(stripPrefix)) name = name.slice(stripPrefix.length);
        if (!name) {
          zip.readEntry();
          return;
        }
        const target = safeJoin(destDir, name);
        if (!target) {
          logger.warn(`备份包内条目路径越界，已跳过：${String(entry?.fileName)}`);
          zip.readEntry();
          return;
        }
        if (name.endsWith('/')) {
          try {
            fs.mkdirSync(target, { recursive: true });
          } catch {
            /* ignore */
          }
          zip.readEntry();
          return;
        }
        stats.entries++;
        if (REGION_RE.test(name)) stats.regions++;
        zip.openReadStream(entry, (e2: Error | null, rs: any) => {
          if (e2 || !rs) {
            fail(e2 ?? new Error('读取备份包条目失败'));
            return;
          }
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
          } catch {
            /* ignore */
          }
          const ws = fs.createWriteStream(target);
          let written = false;
          rs.on('error', (e: unknown) => fail(e));
          ws.on('error', (e: unknown) => fail(e));
          ws.on('close', () => {
            if (failed || written) return;
            written = true;
            zip.readEntry();
          });
          rs.pipe(ws);
        });
      });
      zip.on('end', () => {
        if (!failed) resolve(stats);
      });
      zip.readEntry();
    });
  });
}

/** 流式 sha256 + 字节数（大存档不能一次性读进内存） */
function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const rs = fs.createReadStream(file);
    rs.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    rs.on('error', reject);
    rs.on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}

/* ------------------------------------------------------------------ */
/* index.json                                                          */
/* ------------------------------------------------------------------ */

function normalizeIndex(raw: unknown): BackupEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: BackupEntry[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const it = e as Partial<BackupEntry>;
    if (typeof it.file !== 'string' || !it.file) continue;
    if (seen.has(it.file)) continue;
    seen.add(it.file);
    out.push({
      file: it.file,
      created: Number(it.created ?? 0),
      type: (it.type ?? 'auto') as BackupEntry['type'],
      worldName: String(it.worldName ?? ''),
      bytes: Number(it.bytes ?? 0),
      sha256: String(it.sha256 ?? ''),
      regions: Number(it.regions ?? 0),
      status: (it.status ?? 'ok') as BackupEntry['status'],
      note: String(it.note ?? ''),
      mc: String(it.mc ?? ''),
      loader: (it.loader ?? 'vanilla') as Loader,
    });
  }
  return out;
}

function readIndex(instanceId: string): BackupEntry[] {
  const list = normalizeIndex(readJsonSync<unknown>(indexFileOf(instanceId), []));
  list.sort((a, b) => b.created - a.created);
  return list;
}

/** 原子写 index（先留 .bak）；始终按 created 倒序 */
function writeIndex(instanceId: string, entries: BackupEntry[]): void {
  const sorted = [...entries].sort((a, b) => b.created - a.created);
  atomicWriteJsonWithBackupSync(indexFileOf(instanceId), sorted);
}

export function listBackups(instanceId: string): BackupEntry[] {
  assertInstanceId(instanceId);
  return readIndex(instanceId);
}

export function backupUsage(instanceId: string): { bytes: number; count: number } {
  assertInstanceId(instanceId);
  const dir = backupDirOf(instanceId);
  const zips = listFilesSync(dir, (n) => n.toLowerCase().endsWith('.zip'));
  return { bytes: dirSizeSync(dir), count: zips.length };
}

/* ------------------------------------------------------------------ */
/* 防护 1 探针（也导出给 UI 做预检）                                     */
/* ------------------------------------------------------------------ */

export function worldStatus(instanceId: string, levelName: string): WorldStatus {
  assertInstanceId(instanceId);
  const level = levelOf(levelName);
  const root = path.join(instanceServerDir(instanceId), level);
  let bytes = 0;
  try {
    const st = fs.statSync(path.join(root, 'level.dat'));
    if (st.isFile()) bytes = st.size;
  } catch {
    bytes = 0;
  }
  if (!fs.existsSync(root)) {
    return { ready: false, regions: 0, levelDatBytes: bytes, reason: `存档目录不存在：${root}` };
  }
  if (bytes <= 0) return { ready: false, regions: 0, levelDatBytes: bytes, reason: '缺少 level.dat' };
  if (bytes < MIN_LEVEL_DAT_BYTES) {
    return { ready: false, regions: 0, levelDatBytes: bytes, reason: `level.dat 仅 ${bytes} 字节（不足 ${MIN_LEVEL_DAT_BYTES}）` };
  }
  const probe = probeRegions(root);
  if (!probe.ready) {
    return {
      ready: false,
      regions: 0,
      levelDatBytes: bytes,
      reason: probe.capped ? `扫描 ${probe.scanned} 个文件仍未找到区域文件` : '缺少区域文件（.mca/.mcr）',
    };
  }
  const tree = collectTree(root);
  return { ready: true, regions: tree.regions, levelDatBytes: bytes, reason: null };
}

/* ------------------------------------------------------------------ */
/* 备份                                                                */
/* ------------------------------------------------------------------ */

export async function createBackup(
  ctx: BackupContext,
  type: 'manual' | 'auto' | 'startup' | 'pre-rollback',
  onLog?: (s: string) => void,
): Promise<BackupEntry> {
  assertInstanceId(ctx.instanceId);
  if (!TAG[type]) throw bad(`未知的备份类型：${type}`);
  const level = levelOf(ctx.levelName);
  if (ctx.isRunning()) throw busy('实例正在运行，请先优雅停服再备份');

  return withLock(lockKey(ctx.instanceId), async () => {
    const dir = backupDirOf(ctx.instanceId);
    const tmpDir = tmpDirOf(ctx.instanceId);
    const serverDir = instanceServerDir(ctx.instanceId);
    const worldDir = path.join(serverDir, level);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    if (!fs.existsSync(worldDir)) throw notFound(`存档目录不存在：${worldDir}`);

    // ---- 防护 1：打包前判「世界生成完」 ----
    let levelBytes = 0;
    try {
      const st = fs.statSync(path.join(worldDir, 'level.dat'));
      if (st.isFile()) levelBytes = st.size;
    } catch {
      levelBytes = 0;
    }
    if (levelBytes <= 0) throw notReady('世界还没生成完（缺少 level.dat），这次不备份');
    if (levelBytes < MIN_LEVEL_DAT_BYTES) {
      throw notReady(`世界还没生成完（level.dat 仅 ${levelBytes} 字节），这次不备份`);
    }
    const probe = probeRegions(worldDir);
    if (!probe.ready) {
      logger.warn(
        `世界 ${ctx.instanceId}/${level} 未探测到区域文件，拒绝备份${probe.capped ? `（已扫描 ${probe.scanned} 个文件后放弃）` : ''}`,
      );
      throw notReady('世界还没生成完（缺少区域文件），这次不备份');
    }

    // 列文件：一次遍历同时拿到区域文件数
    const tree = collectTree(worldDir);
    if (tree.regions <= 0) throw notReady('世界还没生成完（缺少区域文件），这次不备份');
    say(onLog, level, `开始备份：${tree.files.length} 个文件，区域文件 ${tree.regions} 个`);

    // 目标文件名
    const baseName = `${safeName(ctx.name)}-${stamp()}-${TAG[type]}`;
    let file = `${baseName}.zip`;
    for (let n = 2; fs.existsSync(path.join(dir, file)); n++) file = `${baseName}-${n}.zip`;

    const tmpFile = path.join(tmpDir, `${file}.part`);
    const finalFile = path.join(dir, file);

    try {
      // 打包到 .tmp（同分区，后面 rename 才是原子的）
      await writeZip(tree.files, tmpFile);

      // ---- 防护 2：打包后复验中央目录里的区域文件数 ----
      const check = await countZipRegions(tmpFile);
      if (check.regions <= 0) {
        const rejected = `${finalFile}.rejected`;
        try {
          fs.renameSync(tmpFile, rejected);
        } catch {
          try {
            fs.rmSync(tmpFile, { force: true });
          } catch {
            /* ignore */
          }
        }
        logger.error(`备份包复验失败（条目 ${check.entries} 个、区域文件 0 个），已标记为 rejected：${rejected}`);
        throw notReady('备份包不完整，已标记为 rejected');
      }

      // sha256（流式）+ 字节数
      const { sha256, bytes } = await hashFile(tmpFile);
      if (bytes > 0 && ctx.isRunning()) throw busy('备份期间实例被启动了，已放弃本次备份');

      // 正式入库：rename 同分区原子落地
      fs.renameSync(tmpFile, finalFile);

      const entry: BackupEntry = {
        file,
        created: Date.now(),
        type,
        worldName: ctx.name,
        bytes,
        sha256,
        regions: check.regions,
        status: 'ok',
        note: `存档目录 ${level}，区域文件 ${check.regions} 个，条目 ${check.entries} 个`,
        mc: ctx.mc,
        loader: ctx.loader,
      };

      // 最后才写 index：不合格的包绝不进 index.json
      const index = readIndex(ctx.instanceId);
      index.push(entry);
      writeIndex(ctx.instanceId, index);
      say(onLog, level, `备份完成：${file}（${(bytes / 1024 / 1024).toFixed(2)} MB，sha256 ${sha256.slice(0, 12)}…）`);
      return entry;
    } catch (err) {
      // 失败：清掉临时文件，index 保持不变
      try {
        if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { force: true });
      } catch {
        /* ignore */
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`备份失败（${type}）：${msg}`);
      throw err;
    }
  });
}

/* ------------------------------------------------------------------ */
/* 删除                                                                */
/* ------------------------------------------------------------------ */

/** 只接受 backups 目录下的 zip 文件名，挡掉路径穿越 */
function safeBackupFile(file: string): string {
  const name = (file ?? '').trim();
  if (!name || name !== path.basename(name) || name.includes('..') || /[/\\]/.test(name)) {
    throw bad(`备份文件名非法：${file}`);
  }
  if (!name.toLowerCase().endsWith('.zip')) throw bad(`只允许操作 .zip 备份：${file}`);
  return name;
}

/** 调用方需自行持有实例备份锁 */
function removeBackup(instanceId: string, rawFile: string): void {
  const file = safeBackupFile(rawFile);
  const target = path.join(backupDirOf(instanceId), file);
  if (!fs.existsSync(target)) throw notFound(`备份不存在：${file}`);
  fs.rmSync(target, { force: true });
  const index = readIndex(instanceId).filter((e) => e.file !== file);
  writeIndex(instanceId, index);
  logger.info(`已删除备份：${instanceId}/${file}`);
}

export async function deleteBackup(instanceId: string, file: string): Promise<void> {
  assertInstanceId(instanceId);
  return withLock(lockKey(instanceId), async () => {
    removeBackup(instanceId, file);
  });
}

/* ------------------------------------------------------------------ */
/* 清理策略                                                            */
/* ------------------------------------------------------------------ */

export interface CleanupPlan {
  remove: BackupEntry[];
  freed: number;
  kept: BackupEntry[];
  totalAfter: number;
}

/**
 * 先算再删（不落盘）。顺序：保护手动 → keepN → maxAgeDays → 总量上限。
 * @param maxTotalMb 总量上限（MB），<=0 表示不限量（调用方通常传 policy.maxTotalMb）
 */
export function planCleanup(instanceId: string, policy: BackupPolicy, maxTotalMb: number): CleanupPlan {
  assertInstanceId(instanceId);
  const all = readIndex(instanceId); // created 倒序
  const remove = new Set<string>();

  // 1) 手动备份保护：protectManual 为 true 时 manual 永不自动删
  const guarded = new Set<string>(
    policy.protectManual ? all.filter((e) => e.type === 'manual').map((e) => e.file) : [],
  );

  // 2) keepN：手动 + 自动一起算，保留最近 N 份
  const keepN = Math.max(0, Math.floor(Number(policy.keepN ?? 0)));
  if (keepN > 0) {
    all.forEach((e, i) => {
      if (i >= keepN && !guarded.has(e.file)) remove.add(e.file);
    });
  } else {
    logger.warn(`keepN=${policy.keepN} 无效，本次跳过「保留最近 N 份」规则`);
  }

  // 3) maxAgeDays：过期就删
  const days = Number(policy.maxAgeDays ?? 0);
  if (days > 0) {
    const cutoff = Date.now() - days * 86400000;
    for (const e of all) {
      if (e.created < cutoff && !guarded.has(e.file)) remove.add(e.file);
    }
  }

  // 4) 总量上限：从最旧的开始删
  const limitMb = Number(maxTotalMb ?? 0);
  if (limitMb > 0) {
    const limitBytes = limitMb * 1024 * 1024;
    let total = all.filter((e) => !remove.has(e.file)).reduce((s, e) => s + e.bytes, 0);
    for (let i = all.length - 1; i >= 0 && total > limitBytes; i--) {
      const e = all[i];
      if (guarded.has(e.file) || remove.has(e.file)) continue;
      remove.add(e.file);
      total -= e.bytes;
    }
  }

  const removedList = all.filter((e) => remove.has(e.file)).sort((a, b) => a.created - b.created);
  const kept = all.filter((e) => !remove.has(e.file));
  return {
    remove: removedList,
    freed: removedList.reduce((s, e) => s + e.bytes, 0),
    kept,
    totalAfter: kept.reduce((s, e) => s + e.bytes, 0),
  };
}

export async function runCleanup(
  instanceId: string,
  policy: BackupPolicy,
  opts: { dryRun?: boolean } = {},
): Promise<{ removed: BackupEntry[]; freed: number }> {
  assertInstanceId(instanceId);
  return withLock(lockKey(instanceId), async () => {
    const plan = planCleanup(instanceId, policy, Number(policy.maxTotalMb ?? 0));
    if (opts.dryRun) {
      logger.info(`清理预演：将删除 ${plan.remove.length} 个备份，预计释放 ${plan.freed} 字节（未落盘）`);
      return { removed: [], freed: 0 };
    }
    const removed: BackupEntry[] = [];
    for (const e of plan.remove) {
      try {
        removeBackup(instanceId, e.file);
        removed.push(e);
      } catch (err) {
        logger.warn(`清理时删除备份失败：${e.file} —— ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const freed = removed.reduce((s, e) => s + e.bytes, 0);
    if (removed.length) logger.info(`清理完成：删除 ${removed.length} 个备份，释放 ${freed} 字节`);
    return { removed, freed };
  });
}

/* ------------------------------------------------------------------ */
/* 回退                                                                */
/* ------------------------------------------------------------------ */

function stage(hooks: RollbackHooks, key: string, label: string, detail?: string): void {
  logger.info(`[rollback] ${key} ${label}${detail ? ` —— ${detail}` : ''}`);
  try {
    hooks.onStage(key, label, detail);
  } catch {
    /* 回调抛错不影响主流程 */
  }
}

/** 只保留最近 1 份保底目录，更老的删掉（keep 为 null 表示这次没生成保底，什么都不删） */
function pruneSafetyDirs(serverDir: string, level: string, keep: string | null): void {
  if (!keep) return;
  const prefix = `${level}.pre-rollback-`;
  for (const name of subDirs(serverDir)) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(serverDir, name);
    if (full === keep) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      logger.info(`已清理更老的保底目录：${name}`);
    } catch (err) {
      logger.warn(`清理保底目录失败：${name} —— ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function rollback(
  instanceId: string,
  file: string,
  hooks: RollbackHooks,
): Promise<{ installed: string; safety: string | null; restarted: boolean }> {
  assertInstanceId(instanceId);
  const target = safeBackupFile(file);

  return withLock(lockKey(instanceId), async () => {
    const dir = backupDirOf(instanceId);
    const zipFile = path.join(dir, target);
    const level = levelOf(hooks.levelName);

    // ---- 防护 3：不完整的包禁止回退 ----
    const index = readIndex(instanceId);
    const entry = index.find((e) => e.file === target);
    if (!entry) throw notFound(`备份不在索引里：${target}`);
    if (entry.status !== 'ok' || entry.regions <= 0) {
      throw bad('该备份不完整，已拒绝回退');
    }
    if (!fs.existsSync(zipFile)) throw notFound(`备份文件不存在：${target}`);
    const check = await countZipRegions(zipFile);
    if (check.regions <= 0) {
      logger.error(`回退前复验失败：${target} 内区域文件为 0，拒绝回退`);
      throw bad('该备份不完整，已拒绝回退');
    }

    const serverDir = instanceServerDir(instanceId);
    const worldDir = path.join(serverDir, level);

    // 1) 停服（调用方做优雅保存，可能耗时几十秒）
    stage(hooks, 'stopping', '正在停止服务器并保存世界…');
    await hooks.stop();
    if (hooks.isRunning && hooks.isRunning()) throw busy('服务器仍在运行，已取消回退');

    // 2) 保底：把当前存档改名留档，失败只记日志不中断
    stage(hooks, 'safety', '正在保留当前存档作为保底…');
    let safety: string | null = null;
    let safetyDir = path.join(serverDir, `${level}.pre-rollback-${stampMs()}`);
    // 极端情况下同毫秒也会撞名，撞名的 renameSync 会失败，这里补一个序号
    for (let n = 2; fs.existsSync(safetyDir); n++) {
      safetyDir = path.join(serverDir, `${level}.pre-rollback-${stampMs()}-${n}`);
    }
    try {
      if (fs.existsSync(worldDir)) {
        fs.renameSync(worldDir, safetyDir);
        safety = safetyDir;
        logger.info(`保底目录：${safetyDir}`);
      } else {
        logger.warn(`存档目录不存在，跳过保底：${worldDir}`);
      }
    } catch (err) {
      logger.warn(`保留保底目录失败（继续回退）：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      pruneSafetyDirs(serverDir, level, safety);
    } catch (err) {
      logger.warn(`清理更老的保底目录失败：${err instanceof Error ? err.message : String(err)}`);
    }

    // 3) 解压覆盖存档目录
    stage(hooks, 'extracting', '正在解压备份到存档目录…', target);
    try {
      fs.rmSync(worldDir, { recursive: true, force: true });
      fs.mkdirSync(worldDir, { recursive: true });
      const stats = await extractZip(zipFile, worldDir, `${level}/`);
      stage(hooks, 'extracting', '解压完成', `${stats.entries} 个条目，区域文件 ${stats.regions} 个`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`解压备份失败：${msg}${safety ? `（保底目录：${safety}）` : ''}`);
      throw err;
    }

    // 4) 校验
    stage(hooks, 'verifying', '正在校验存档完整性…');
    const levelDat = path.join(worldDir, 'level.dat');
    if (!fs.existsSync(levelDat)) {
      throw bad(`回退后的存档缺少 level.dat（保底目录：${safety ?? '无'}）`);
    }
    const post = collectTree(worldDir);
    if (post.regions <= 0) {
      logger.warn('回退后的存档里没有区域文件，服务端可能无法正常加载');
    }

    // 5) 自动启动（start 抛错时直接抛出，不回滚保底目录，UI 会提示保底目录位置）
    stage(hooks, 'starting', '正在启动服务器…');
    try {
      await hooks.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`回退后启动失败：${msg}${safety ? `（保底目录：${safety}）` : ''}`);
      throw err;
    }
    logger.info(`回退完成：${target} → ${level}${safety ? `（保底：${safety}）` : ''}`);
    return { installed: target, safety, restarted: true };
  });
}
