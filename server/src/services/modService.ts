/**
 * BlockCraft v2 · MOD 服务
 *
 * 职责：列表 / 详情 / 删除 / 启停 / 批量导入 / 链接下载 / 更新检查 / 缺失依赖建议。
 *
 * 设计约束（都是在这台机器上实测踩过的坑）：
 * 1. 只按需读 zip 条目，绝不整包解压：手工解析中央目录后只 inflate 需要的几个条目（快路径），
 *    zip64 / 异常包退回 yauzl（慢路径）——yauzl 逐个 readEntry() 走完 344 个 jar 要 45 秒，列表接口等不起；
 * 2. 扫目录一律用 listFilesSync —— 本机 f2fs 会把 nlink>1 的普通文件报成 DT_LNK，
 *    `readdirSync(dir,{withFileTypes:true}).filter(d => d.isFile())` 会把 344 个 MOD 全看成符号链接；
 * 3. 任何网络失败都只降级成 local/unknown，绝不让列表接口挂掉；
 * 4. 运行中的世界禁止一切写操作（删除 / 停用 / 导入 / 下载），由调用方注入 isRunning 判断；
 * 5. 所有 JSON 写盘走 atomicWriteJsonWithBackupSync。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
// yauzl 只有 CJS 且项目没装 @types，按 CJS 默认导入用（下一行 @ts-ignore 是给 tsc 看的）
// @ts-ignore -- 无类型声明
import yauzl from 'yauzl';

import {
  MODS_CACHE_FILE,
  STORE_DIR,
  INSTANCE_ID_RE,
  instanceServerDir,
  instanceConfigFile,
} from '../core/paths.ts';
import { atomicWriteJsonWithBackupSync, readJsonSync, listFilesSync } from '../core/fsx.ts';
import { bad, notFound, conflict, busy, notReady } from '../core/errors.ts';
import { createLogger } from '../core/logger.ts';
import { loadConfig } from '../config.ts';
import type { ModInfo, Loader } from '../types.ts';

const logger = createLogger('mods');

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 分页默认与上限 */
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 200;

/** 文本类元数据条目体积上限（超过就认为不是我们要的东西） */
const TEXT_ENTRY_MAX = 1024 * 1024;
/** jar-in-jar 内嵌 jar 体积上限，超过则不解析（只影响「依赖是否已满足」的判断精度） */
const NESTED_JAR_MAX = 16 * 1024 * 1024;
/** jar-in-jar 递归深度上限 */
const MAX_JARJAR_DEPTH = 2;

/** 网络请求超时 */
const NET_TIMEOUT_MS = 8000;
/** 文件下载整体超时（比元数据宽松，否则稍大的包必失败） */
const DOWNLOAD_TIMEOUT_MS = 120000;

/** 网络失败降级条目在缓存里的存活时间：过了就允许重新联网试 */
const DEGRADED_TTL_MS = 10 * 60 * 1000;
/** 来源缓存最大条目数，超出按 checkedAt 淘汰 */
const MAX_CACHE_ENTRIES = 4000;

/** 数量接口的 TTL */
const COUNT_TTL_MS = 30 * 1000;

/** 并发度：解析 jar 头 / 算 sha1 都用它，避免一次性打开几百个 fd */
const IO_CONCURRENCY = 8;

const UA = 'BlockCraft/2.0 (self-hosted Minecraft panel)';

/** 只认这两种扩展名（.disabled 是同名 jar 被停用后的形态） */
const MOD_FILE_RE = /\.jar(\.disabled)?$/i;

/** 平台模块白名单：这些 id 永远不算「缺失依赖」 */
const PLATFORM_IDS = new Set([
  'minecraft',
  'java',
  'forge',
  'neoforge',
  'fml',
  'fabricloader',
  'fabric-api',
  // 实测 bclib / betterend / betternether 用裸 'fabric' 声明对 Fabric API 的依赖
  'fabric',
  'quilt_loader',
  'quilted-fabric-api',
  'connector',
]);

/* ------------------------------------------------------------------ *
 * 对外类型
 * ------------------------------------------------------------------ */

export interface ModListQuery {
  q?: string;
  source?: string;
  status?: 'enabled' | 'disabled' | 'all';
  page?: number;
  size?: number;
}

export interface ModListResult {
  total: number;
  page: number;
  size: number;
  pages: number;
  items: ModInfo[];
  dir: string;
}

export interface ModDependency {
  modId: string;
  mandatory: boolean;
  versionRange: string | null;
}

export interface MissingDependency {
  modId: string;
  requestedBy: string[];
  versionRange: string;
}

/** 写操作的运行态检查钩子：返回 true 表示世界正在跑，直接拒绝改写 */
export interface ModOpOptions {
  isRunning?: (id: string) => boolean;
}

/** 兼容早期占位实现里的名字 */
export type ModWriteOptions = ModOpOptions;

/** 内存里上传的文件（有些路由用 multer memoryStorage，传的是 base64 而不是临时路径） */
export interface ModUploadPayload {
  name: string;
  /** base64（JSON 传二进制的通用做法）；不是合法 base64 时按 latin1 原样写盘 */
  data: string;
}

type ModSource = 'modrinth' | 'curseforge' | 'local' | 'unknown';

/* ------------------------------------------------------------------ *
 * 模块内类型
 * ------------------------------------------------------------------ */

/** jar 自身声明的依赖（比对外类型多一个 side，用来剔掉纯客户端的依赖） */
interface JarDependency {
  modId: string;
  mandatory: boolean;
  versionRange: string | null;
  side: string | null;
}

interface JarMeta {
  kind: 'fabric' | 'forge' | 'neoforge' | 'manifest' | 'none';
  modId: string | null;
  /** 一个 jar 里可能声明多个 mod（Forge 的 [[mods]] 可以重复），全部记下来用于「依赖已满足」判断 */
  allModIds: string[];
  name: string;
  description: string;
  version: string | null;
  authors: string[];
  dependencies: JarDependency[];
  /** jar-in-jar 里内嵌 jar 的 modId */
  jarjarIds: string[];
  /** kind === 'none' 时的原因，便于导入时给出人话 */
  error: string | null;
}

/** mods-cache.json 里的一条：键是 jar 的 sha1 */
interface SourceRecord {
  sha1: string;
  source: ModSource;
  sourceUrl: string | null;
  iconUrl: string | null;
  projectTitle: string | null;
  projectId: string | null;
  /** Modrinth 的版本 id，更新检查时用来判断「有没有更新」 */
  versionId: string | null;
  version: string | null;
  latestVersion: string | null;
  hasUpdate: boolean;
  cfProjectId: number | null;
  cfFileId: number | null;
  checkedAt: number;
  /** 网络失败降级写入的条目，过了 TTL 允许重试 */
  degraded?: boolean;
}

type SourceCache = Record<string, SourceRecord>;

interface ScannedMod {
  file: string;
  full: string;
  enabled: boolean;
  bytes: number;
  mtime: number;
  meta: JarMeta;
}

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

function emptyMeta(kind: JarMeta['kind'], error: string | null = null): JarMeta {
  return {
    kind,
    modId: null,
    allModIds: [],
    name: '',
    description: '',
    version: null,
    authors: [],
    dependencies: [],
    jarjarIds: [],
    error,
  };
}

/** 文本归一化：合并空白、裁长度，避免把 TOML 里的缩进原样塞进列表 */
function cleanText(value: unknown, max = 600): string {
  if (typeof value !== 'string') return '';
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item.trim());
    else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      out.push(String((item as { name: string }).name ?? '').trim());
    }
  }
  return out.filter(Boolean);
}

/** 版本串里含 ${ 说明是没被构建替换掉的模板，整块忽略（v1 实测不做这条会凭空多出依赖） */
function isTemplateString(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.includes('${');
}

function isPlatformId(id: string): boolean {
  const k = id.trim().toLowerCase();
  if (!k) return true;
  return PLATFORM_IDS.has(k) || k.startsWith('fabric-');
}

/** 有限并发 map，保持输入顺序 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(size).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 容量受限的内存缓存 */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.set(key, value);
  if (map.size <= max) return;
  const drop = map.size - max;
  let i = 0;
  for (const k of map.keys()) {
    map.delete(k);
    if (++i >= drop) break;
  }
}

/* ------------------------------------------------------------------ *
 * 路径与文件名安全
 * ------------------------------------------------------------------ */

function assertInstanceId(instanceId: string): string {
  const id = String(instanceId ?? '').trim();
  if (!INSTANCE_ID_RE.test(id)) throw bad(`实例 id 不合法：${instanceId}`);
  return id;
}

/** mods 目录：<实例目录>/server/mods */
function modsDirOf(instanceId: string): string {
  return path.join(instanceServerDir(assertInstanceId(instanceId)), 'mods');
}

/**
 * 双元数据 jar 按哪套读：实例加载器是 Fabric 就读 fabric.mod.json，其余读 mods.toml。
 * 实例配置缺失（老数据 / 刚导入）时按 Forge 优先——本面板管理的大多是 Forge/NeoForge 服务端，
 * 实测 344 个 MOD 里 335 个带 mods.toml，且同一个 jar 两边的 modId 可能不同（mes / moogs_end_structures）。
 */
function metaPrefOf(instanceId: string): MetaPref {
  const cfg = readJsonSync<{ loader?: Loader } | null>(instanceConfigFile(instanceId), null);
  return cfg?.loader === 'fabric' ? 'fabric' : 'forge';
}

/** 只接受「一个普通文件名」，禁止任何路径成分 */
function safeModFileName(file: string): string {
  const name = String(file ?? '').trim();
  if (!name) throw bad('文件名不能为空');
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) throw bad(`文件名不合法：${file}`);
  if (name === '.' || name === '..' || name.includes('..')) throw bad(`文件名不合法：${file}`);
  if (path.basename(name) !== name) throw bad(`文件名不合法：${file}`);
  if (!MOD_FILE_RE.test(name)) throw bad(`不是 MOD 文件（需要 .jar / .jar.disabled）：${file}`);
  return name;
}

/** 拼绝对路径并二次确认没逃出 mods 目录 */
function resolveModFile(dir: string, file: string): string {
  const name = safeModFileName(file);
  const root = path.resolve(dir);
  const full = path.resolve(root, name);
  if (full !== path.join(root, name) || !full.startsWith(root + path.sep)) {
    throw bad(`路径越界：${file}`);
  }
  return full;
}

/** 下载/导入落盘时的文件名清洗（保留可读性，去掉危险字符） */
function sanitizeDownloadName(raw: string): string {
  let name = String(raw || '').trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    /* 保持原样 */
  }
  name = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.replace(/^\.+/, '');
  if (name.includes('..')) name = name.replace(/\.\./g, '.');
  if (!name || name === '.' || name === '..') name = 'mod.jar';
  if (name.length > 200) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, 200 - ext.length) + ext;
  }
  if (!/\.(jar|zip)$/i.test(name)) name += '.jar';
  return name;
}

/** 目标目录里已存在同名文件时，退让成 name-1.jar / name-2.jar */
function uniqueNameIn(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = /\.jar$/i.test(name) ? '.jar' : path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  throw conflict(`目录里同名文件太多，无法为 ${name} 找到可用名字`);
}

/* ------------------------------------------------------------------ *
 * 运行态守卫
 * ------------------------------------------------------------------ */

/** 写操作前置检查：世界在跑就直接拒绝（调用方把 isRunning 注进来） */
export function assertStopped(instanceId: string, opts: ModOpOptions = {}): void {
  const id = assertInstanceId(instanceId);
  if (typeof opts.isRunning === 'function' && opts.isRunning(id)) {
    throw busy('世界正在运行，请先停服再改 MOD');
  }
}

/* ------------------------------------------------------------------ *
 * mods.toml 小解析器
 *
 * 只支持 [table] / [[array]] / key = value（字符串 / 布尔 / 数字）与多行字符串，
 * 够读 mods.toml 与 neoforge.mods.toml，不再引新依赖。
 * ------------------------------------------------------------------ */

interface TomlSection {
  header: string;
  props: Record<string, string>;
}

function stripQuotes(key: string): string {
  return key.trim().replace(/^["']|["']$/g, '');
}

/** 找到字符串值的收尾引号（跳过转义），后面的 `# 注释` 一律丢掉 */
function findClosingQuote(s: string, quote: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === quote) return i;
  }
  return -1;
}

function parseScalar(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (t.startsWith('"""') || t.startsWith("'''")) {
    const q = t.slice(0, 3);
    const end = t.indexOf(q, 3);
    return (end >= 0 ? t.slice(3, end) : t.slice(3)).trim();
  }
  if (t.startsWith('"')) {
    const end = findClosingQuote(t, '"');
    const literal = end >= 0 ? t.slice(0, end + 1) : t;
    try {
      return String(JSON.parse(literal));
    } catch {
      return literal.slice(1, end >= 0 ? end : literal.length);
    }
  }
  if (t.startsWith("'")) {
    const end = findClosingQuote(t, "'");
    return t.slice(1, end >= 0 ? end : t.length);
  }
  // 裸值：去掉行尾注释
  const hash = t.indexOf('#');
  return (hash >= 0 ? t.slice(0, hash) : t).trim();
}

/** 方括号是否配平（跳过引号里的内容） */
function bracketsBalanced(s: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
  }
  return depth <= 0;
}

/** 解析一个内联表 `{ a = 1, b = "x" }` */
function parseInlineTable(raw: string): Record<string, string> {
  const body = raw.trim().replace(/^\{/, '').replace(/\}$/, '');
  const out: Record<string, string> = {};
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') {
        cur += body[i + 1] ?? '';
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = stripQuotes(part.slice(0, eq));
    if (key) out[key] = parseScalar(part.slice(eq + 1));
  }
  return out;
}

/** 从 `[ { ... }, { ... } ]` 里抠出所有内联表 */
function parseInlineTableArray(raw: string | undefined): Record<string, string>[] {
  if (!raw) return [];
  const out: Record<string, string>[] = [];
  let depth = 0;
  let start = -1;
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(parseInlineTable(raw.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return out;
}

function parseTomlSections(text: string): TomlSection[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const sections: TomlSection[] = [];
  let cur: TomlSection = { header: '', props: {} };
  sections.push(cur);

  let i = 0;
  while (i < lines.length) {
    const line = (lines[i] ?? '').trim();
    i++;
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[[')) {
      const m = line.match(/^\[\[\s*([^\]]+?)\s*\]\]/);
      cur = { header: m ? stripQuotes(m[1]) : '', props: {} };
      sections.push(cur);
      continue;
    }
    if (line.startsWith('[')) {
      const m = line.match(/^\[\s*([^\]]+?)\s*\]/);
      cur = { header: m ? stripQuotes(m[1]) : '', props: {} };
      sections.push(cur);
      continue;
    }

    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = stripQuotes(line.slice(0, eq));
    let rawValue = line.slice(eq + 1).trim();

    // 多行字符串：本行没闭合就把后续行吞进来
    for (const quote of ['"""', "'''"]) {
      if (rawValue.startsWith(quote) && !rawValue.slice(quote.length).includes(quote)) {
        const parts = [rawValue.slice(quote.length)];
        while (i < lines.length) {
          const next = lines[i] ?? '';
          i++;
          const idx = next.indexOf(quote);
          if (idx >= 0) {
            parts.push(next.slice(0, idx));
            break;
          }
          parts.push(next);
        }
        rawValue = `${quote}${parts.join('\n')}${quote}`;
        break;
      }
    }

    // 多行数组：`mods = [ \n { ... }, \n ]` 这种内联写法（lowcodefml 生成，Moog's / Dungeons and Taverns 系）
    if (rawValue.startsWith('[') && !bracketsBalanced(rawValue)) {
      while (i < lines.length) {
        const next = lines[i] ?? '';
        i++;
        rawValue += `\n${next}`;
        if (bracketsBalanced(rawValue)) break;
      }
    }

    if (!key) continue;
    cur.props[key] = parseScalar(rawValue);
  }
  return sections;
}

/**
 * 从 mods.toml 文本里取「所有 mod 声明 + 所有依赖声明」。
 * 两种写法都支持：标准的 `[[mods]]` / `[[dependencies.x]]`，以及 lowcodefml 生成的
 * 内联写法 `mods = [ { modId = 'x', ... } ]`（实测 9 个 jar 是后者）。
 */
function parseModsTomlDoc(text: string): { mods: Record<string, string>[]; deps: Record<string, string>[] } {
  const sections = parseTomlSections(text);
  const mods: Record<string, string>[] = [];
  const deps: Record<string, string>[] = [];
  for (const s of sections) {
    const header = s.header.toLowerCase();
    if (header === 'mods') mods.push(s.props);
    else if (header.startsWith('dependencies')) deps.push(s.props);
  }
  const root = sections.find((s) => s.header === '');
  if (root) {
    if (!mods.length) mods.push(...parseInlineTableArray(root.props.mods));
    deps.push(...parseInlineTableArray(root.props.dependencies));
  }
  return { mods, deps };
}

/* ------------------------------------------------------------------ *
 * MANIFEST.MF
 * ------------------------------------------------------------------ */

function parseManifest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith(' ') && last) {
      out[last] = `${out[last]}${line.slice(1)}`.trim();
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    out[key] = line.slice(idx + 1).trim();
    last = key;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * zip 读取（yauzl）
 * ------------------------------------------------------------------ */

/** 解开任意 yauzl zip：只读 pick() 放行的条目，其余直接跳过 */
function collectEntries(zip: any, pick: (name: string, size: number) => boolean): Promise<Map<string, Buffer>> {
  return new Promise((resolve) => {
    const out = new Map<string, Buffer>();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(out);
    };
    const step = () => {
      try {
        zip.readEntry();
      } catch {
        finish();
      }
    };
    zip.on('error', finish);
    zip.on('end', finish);
    zip.on('entry', (entry: any) => {
      const name = String(entry?.fileName ?? '');
      const size = Number(entry?.uncompressedSize ?? 0);
      if (!name || !pick(name, size)) {
        step();
        return;
      }
      zip.openReadStream(entry, (err: Error | null, stream: any) => {
        if (err || !stream) {
          step();
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('error', step);
        stream.on('end', () => {
          out.set(name, Buffer.concat(chunks));
          step();
        });
      });
    });
    step();
  });
}

function openZipFile(file: string): Promise<any> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err: Error | null, zip: any) => {
      if (err || !zip) reject(err ?? new Error('无法打开 zip'));
      else resolve(zip);
    });
  });
}

function openZipBuffer(buf: Buffer): Promise<any> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, autoClose: true }, (err: Error | null, zip: any) => {
      if (err || !zip) reject(err ?? new Error('无法打开 zip'));
      else resolve(zip);
    });
  });
}

const TOML_ENTRY = 'meta-inf/mods.toml';
const NEO_TOML_ENTRY = 'meta-inf/neoforge.mods.toml';
const FABRIC_ENTRY = 'fabric.mod.json';
const MANIFEST_ENTRY = 'meta-inf/manifest.mf';
const TEXT_ENTRIES = new Set([TOML_ENTRY, NEO_TOML_ENTRY, FABRIC_ENTRY, MANIFEST_ENTRY]);

/** 这个条目要不要读（快慢两条路径共用） */
function wantedEntry(name: string, size: number, depth: number): boolean {
  const lower = name.toLowerCase();
  if (TEXT_ENTRIES.has(lower)) return size <= TEXT_ENTRY_MAX;
  if (depth < MAX_JARJAR_DEPTH && lower.startsWith('meta-inf/jarjar/') && lower.endsWith('.jar')) {
    return size > 0 && size <= NESTED_JAR_MAX;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 快路径：手工解析 zip 中央目录
 *
 * 实测（本机 f2fs，bmc4 的 344 个 jar / 26 万个条目）：
 *   用 yauzl 逐个 readEntry() 走完中央目录要 ~45 秒（每个条目一次小 read），列表接口等不起；
 *   手工读一次中央目录、只 inflate 需要的几个条目只要 1.2 秒。
 * 因此快路径做主力，yauzl 保留为 zip64 / 异常包的兜底（只读需要的条目这一点不变）。
 * ------------------------------------------------------------------ */

interface ByteSource {
  size: number;
  read(offset: number, length: number): Buffer | null;
}

function fdSource(fd: number, size: number): ByteSource {
  return {
    size,
    read(offset, length) {
      if (offset < 0 || length <= 0 || offset + length > size) return null;
      const buf = Buffer.allocUnsafe(length);
      const n = fs.readSync(fd, buf, 0, length, offset);
      return n === length ? buf : null;
    },
  };
}

function bufferSource(buffer: Buffer): ByteSource {
  return {
    size: buffer.length,
    read(offset, length) {
      if (offset < 0 || length <= 0 || offset + length > buffer.length) return null;
      return buffer.subarray(offset, offset + length);
    },
  };
}

/** 双元数据 jar 按哪套读：Forge 族读 mods.toml，Fabric 族读 fabric.mod.json */
type MetaPref = 'fabric' | 'forge';

interface ZipEntryInfo {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** 读中央目录，返回「小写条目名 → 条目信息」；zip64 / 异常包返回 null 交给 yauzl */
function readZipIndex(src: ByteSource): Map<string, ZipEntryInfo> | null {
  const tailLen = Math.min(src.size, 66 * 1024);
  if (tailLen < 22) return null;
  const tail = src.read(src.size - tailLen, tailLen);
  if (!tail) return null;
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const total = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null;
  if (!cdSize || cdOffset + cdSize > src.size) return null;
  const cd = src.read(cdOffset, cdSize);
  if (!cd) return null;

  const entries = new Map<string, ZipEntryInfo>();
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CD_SIG) {
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const cmtLen = cd.readUInt16LE(p + 32);
    const localHeaderOffset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen > cd.length) return null;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) return null;
    const lower = cd.toString('utf8', p + 46, p + 46 + nameLen).toLowerCase();
    if (lower && !entries.has(lower)) {
      entries.set(lower, { method, compressedSize, uncompressedSize, localHeaderOffset });
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries.size ? entries : null;
}

/** 读出单个条目的内容（只 inflate 调用方点名要的那几个） */
function readZipEntryData(src: ByteSource, info: ZipEntryInfo, maxBytes: number): Buffer | null {
  if (info.compressedSize <= 0 || info.uncompressedSize <= 0 || info.uncompressedSize > maxBytes) return null;
  const head = src.read(info.localHeaderOffset, 30);
  if (!head || head.readUInt32LE(0) !== LOCAL_SIG) return null;
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  const raw = src.read(info.localHeaderOffset + 30 + nameLen + extraLen, info.compressedSize);
  if (!raw) return null;
  if (info.method === 0) return raw.length <= maxBytes ? raw : null;
  if (info.method !== 8) return null;
  try {
    // maxOutputLength 顺手挡住 zip 炸弹
    const data = zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
    return data.length <= maxBytes ? data : null;
  } catch {
    return null;
  }
}

/**
 * 按中央目录只取需要的条目。
 * 认识的元数据条目读不出来（不认识的压缩方法 / 数据坏了）时返回 null，
 * 让调用方退回 yauzl 再试一次——不能把「读失败」当成「这个 jar 没有元数据」。
 */
function entriesFromIndex(
  src: ByteSource,
  index: Map<string, ZipEntryInfo>,
  depth: number,
): Map<string, Buffer> | null {
  const out = new Map<string, Buffer>();
  for (const [lower, info] of index) {
    if (TEXT_ENTRIES.has(lower)) {
      const data = readZipEntryData(src, info, TEXT_ENTRY_MAX);
      if (!data) return null;
      out.set(lower, data);
    } else if (depth < MAX_JARJAR_DEPTH && lower.startsWith('meta-inf/jarjar/') && lower.endsWith('.jar')) {
      // 内嵌 jar 读不出来可以忍，它只影响「依赖是否已满足」的判断精度
      const data = readZipEntryData(src, info, NESTED_JAR_MAX);
      if (data) out.set(lower, data);
    }
  }
  return out;
}

/** 内嵌 jar（内存里的 Buffer）：快路径优先，不行退回 yauzl */
async function readMetaFromBuffer(buf: Buffer, depth: number, prefer: MetaPref): Promise<JarMeta> {
  try {
    const src = bufferSource(buf);
    const index = readZipIndex(src);
    if (index) {
      const entries = entriesFromIndex(src, index, depth);
      if (entries) return await buildMetaFromEntries(entries, depth, prefer);
    }
  } catch {
    /* 落到 yauzl */
  }
  const nestedZip = await openZipBuffer(buf);
  return readMetaFromZip(nestedZip, depth, prefer);
}

/** yauzl 慢路径：zip64 或中央目录解析失败时的兜底 */
async function readMetaFromZip(zip: any, depth: number, prefer: MetaPref): Promise<JarMeta> {
  const entries = await collectEntries(zip, (name, size) => wantedEntry(name, size, depth));
  return buildMetaFromEntries(entries, depth, prefer);
}

/**
 * 宽松 JSON：实测有些 fabric.mod.json 的字符串里带裸换行/制表符（严格 JSON 不允许），
 * Gson 能读但 JSON.parse 会抛，这里先把字符串内部的裸控制字符转义掉。
 */
function looseJson(text: string): string {
  const src = text.replace(/^\uFEFF/, '');
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** fabric.mod.json → 元数据；解析失败返回 null 由调用方换另一套 */
function parseFabricMeta(buf: Buffer, manifest: Record<string, string>): JarMeta | null {
  try {
    const json = JSON.parse(looseJson(buf.toString('utf8'))) as Record<string, unknown>;
    const deps: JarDependency[] = [];
    const depends = (json.depends ?? {}) as Record<string, unknown>;
    for (const [modId, range] of Object.entries(depends)) {
      deps.push({ modId, mandatory: true, versionRange: typeof range === 'string' ? range : null, side: null });
    }
    const id = cleanText(json.id, 120);
    return {
      kind: 'fabric',
      modId: id || null,
      allModIds: id ? [id] : [],
      name: cleanText(json.name, 160) || id,
      description: cleanText(json.description),
      version: cleanText(json.version, 64) || cleanText(manifest['implementation-version'], 64) || null,
      authors: asStringArray(json.authors),
      dependencies: deps,
      jarjarIds: [],
      error: null,
    };
  } catch {
    return null;
  }
}

/** mods.toml / neoforge.mods.toml → 元数据；解析不出东西返回 null */
function parseTomlMeta(buf: Buffer, isNeo: boolean, manifest: Record<string, string>): JarMeta | null {
  const text = buf.toString('utf8');
  const doc = parseModsTomlDoc(text);
  const props = doc.mods[0] ?? {};
  const deps = doc.deps;
  const rawVersion = cleanText(props.version, 64);
  // ${file.jarVersion} 这种模板先从 MANIFEST 里找真版本，找不到就当没有版本
  const version = isTemplateString(rawVersion)
    ? cleanText(manifest['implementation-version'], 64) || null
    : rawVersion || cleanText(manifest['implementation-version'], 64) || null;
  const parsedDeps: JarDependency[] = [];
  for (const d of deps) {
    const modId = cleanText(d.modId ?? d.modid, 120);
    if (!modId) continue;
    const range = cleanText(d.versionRange ?? d.versionrange, 200);
    parsedDeps.push({
      modId,
      mandatory: String(d.mandatory ?? 'true').toLowerCase() !== 'false',
      versionRange: range || null,
      side: cleanText(d.side, 16).toUpperCase() || null,
    });
  }
  // [[mods]] / 内联 mods 可能写多条，全部 modId 都要收进来（依赖是否满足要看它们）
  const allIds = doc.mods.map((m) => cleanText(m.modId ?? m.modid, 120)).filter(Boolean);
  const id = cleanText(props.modId ?? props.modid, 120) || allIds[0] || null;
  // 只有 loaderVersion / license 这类公共字段的 toml 不算元数据，交给另一套或 MANIFEST
  if (!id && !props.displayName && !props.description) return null;
  return {
    kind: isNeo ? 'neoforge' : 'forge',
    modId: id,
    allModIds: allIds.length ? allIds : id ? [id] : [],
    name: cleanText(props.displayName, 160) || id || '',
    description: cleanText(props.description),
    version,
    authors: asStringArray(props.authors),
    dependencies: parsedDeps,
    jarjarIds: [],
    error: null,
  };
}

/** 从「条目名 → 内容」解析元数据；快慢两条路径共用这一份解析逻辑 */
async function buildMetaFromEntries(entries: Map<string, Buffer>, depth: number, prefer: MetaPref): Promise<JarMeta> {
  const pick = (target: string): Buffer | null => {
    for (const [name, buf] of entries) {
      if (name.toLowerCase() === target) return buf;
    }
    return null;
  };

  const manifestBuf = pick(MANIFEST_ENTRY);
  const manifest = manifestBuf ? parseManifest(manifestBuf.toString('utf8')) : {};

  // 内嵌 jar：先递归读出它们的 modId（算「依赖已满足」用），顺带留一份元数据兜底
  const jarjarIds: string[] = [];
  let nestedFallback: JarMeta | null = null;
  if (depth < MAX_JARJAR_DEPTH) {
    for (const [name, buf] of entries) {
      const lower = name.toLowerCase();
      if (!lower.startsWith('meta-inf/jarjar/') || !lower.endsWith('.jar')) continue;
      try {
        const nested = await readMetaFromBuffer(buf, depth + 1, prefer);
        for (const id of nested.allModIds) jarjarIds.push(id);
        for (const id of nested.jarjarIds) jarjarIds.push(id);
        if (!nestedFallback && nested.kind !== 'none') nestedFallback = nested;
      } catch {
        /* 单个内嵌 jar 坏了不影响外层 */
      }
    }
  }

  const fabricBuf = pick(FABRIC_ENTRY);
  const neoBuf = pick(NEO_TOML_ENTRY);
  const tomlBuf = neoBuf ?? pick(TOML_ENTRY);

  const fromFabric = fabricBuf ? parseFabricMeta(fabricBuf, manifest) : null;
  const fromToml = tomlBuf ? parseTomlMeta(tomlBuf, neoBuf !== null, manifest) : null;
  // 同时带两套元数据的 jar（实测 32 个）按实例加载器选：Forge 端读 mods.toml，Fabric 端读 fabric.mod.json
  let meta: JarMeta | null = prefer === 'fabric' ? fromFabric ?? fromToml : fromToml ?? fromFabric;
  // 两套元数据声明的 modId 都算「已被提供」：同一个 jar 在两边可能叫不同 id（mes / moogs_end_structures）
  const mergedIds = new Set<string>();
  for (const source of [meta, fromFabric, fromToml]) {
    if (source) for (const id of source.allModIds) mergedIds.add(id);
  }
  if (meta) meta.allModIds = [...mergedIds];

  if (!meta) {
    // 没有 mods.toml / fabric.mod.json —— 只有 MANIFEST 的胖 jar（Connector、kotlinforforge 这类）
    const name =
      cleanText(manifest['specification-title'], 160) ||
      cleanText(manifest['implementation-title'], 160) ||
      (nestedFallback ? nestedFallback.name : '');
    const version =
      cleanText(manifest['specification-version'], 64) || cleanText(manifest['implementation-version'], 64) || null;
    const authors = asStringArray(
      cleanText(manifest['specification-vendor'], 200) || cleanText(manifest['implementation-vendor'], 200),
    );
    // Automatic-Module-Name 的末段通常就是 modId（org.sinytra.connector → connector）
    const autoModule = cleanText(manifest['automatic-module-name'], 200);
    const moduleId = autoModule ? autoModule.split('.').pop() ?? null : null;
    const modId = (nestedFallback ? nestedFallback.modId : null) ?? moduleId ?? null;
    const allIds = new Set<string>();
    if (modId) allIds.add(modId);
    if (nestedFallback) for (const id of nestedFallback.allModIds) allIds.add(id);

    if (name || version || modId || jarjarIds.length) {
      meta = {
        kind: 'manifest',
        modId,
        allModIds: [...allIds],
        name: name || (nestedFallback ? nestedFallback.name : ''),
        description: nestedFallback ? nestedFallback.description : '',
        version: version ?? (nestedFallback ? nestedFallback.version : null),
        authors: authors.length ? authors : nestedFallback ? nestedFallback.authors : [],
        dependencies: nestedFallback ? nestedFallback.dependencies : [],
        jarjarIds: [],
        error: null,
      };
    }
  }

  if (!meta) {
    const m = emptyMeta('none', 'jar 里没有 mods.toml / fabric.mod.json / 可用 MANIFEST 信息');
    m.jarjarIds = [...new Set(jarjarIds.map((s) => s.trim()).filter(Boolean))];
    return m;
  }

  meta.jarjarIds = [...new Set(jarjarIds.map((s) => s.trim()).filter(Boolean))];
  meta.allModIds = [...new Set(meta.allModIds.map((s) => s.trim()).filter(Boolean))];
  return meta;
}

/** 解析结果的内存缓存（键带 size+mtime，文件一改就自动失效） */
const jarMetaCache = new Map<string, JarMeta>();

async function readJarMeta(file: string, prefer: MetaPref): Promise<JarMeta> {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return emptyMeta('none', '文件不存在');
  }
  if (!st.isFile()) return emptyMeta('none', '不是普通文件');
  const key = `${file}|${st.size}|${st.mtimeMs}|${prefer}`;
  const hit = jarMetaCache.get(key);
  if (hit) return hit;

  let meta: JarMeta | null = null;
  // 快路径：手工读中央目录，只 inflate 需要的条目
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const src = fdSource(fd, st.size);
      const index = readZipIndex(src);
      if (index) {
        const entries = entriesFromIndex(src, index, 0);
        if (entries) meta = await buildMetaFromEntries(entries, 0, prefer);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    meta = null;
  }
  // 兜底：zip64 / 异常包交给 yauzl
  if (!meta) {
    try {
      const zip = await openZipFile(file);
      meta = await readMetaFromZip(zip, 0, prefer);
    } catch (err) {
      meta = emptyMeta('none', `不是有效的 jar/zip：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  remember(jarMetaCache, key, meta, MAX_CACHE_ENTRIES);
  return meta;
}

/* ------------------------------------------------------------------ *
 * 目录扫描
 * ------------------------------------------------------------------ */

/** 扫 mods 目录：只认 .jar / .jar.disabled，文件类型判断全部交给 listFilesSync */
async function scanMods(dir: string, prefer: MetaPref): Promise<ScannedMod[]> {
  const files = listFilesSync(dir, (name) => MOD_FILE_RE.test(name));
  const out = await mapLimit(files, IO_CONCURRENCY, async (full): Promise<ScannedMod | null> => {
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      return null;
    }
    const file = path.basename(full);
    const meta = await readJarMeta(full, prefer);
    return {
      file,
      full,
      enabled: !file.toLowerCase().endsWith('.disabled'),
      bytes: st.size,
      mtime: Math.floor(st.mtimeMs),
      meta,
    };
  });
  const list = out.filter((x): x is ScannedMod => x !== null);
  list.sort((a, b) => a.file.localeCompare(b.file));
  return list;
}

/** 「依赖已满足」集合：只算启用中的 MOD（停用的 jar 不会加载），含 jar-in-jar 里的 modId */
function collectSatisfied(mods: ScannedMod[]): Set<string> {
  const set = new Set<string>();
  for (const m of mods) {
    if (!m.enabled) continue;
    for (const id of m.meta.allModIds) set.add(id.toLowerCase());
    for (const id of m.meta.jarjarIds) set.add(id.toLowerCase());
  }
  return set;
}

function ignoredDependency(d: JarDependency): boolean {
  if (isPlatformId(d.modId)) return true;
  if (isTemplateString(d.modId)) return true;
  if (isTemplateString(d.versionRange)) return true;
  // 声明成可选的依赖（mandatory=false）缺失不算问题：BMC4 里 Delightful 一个 jar 就声明了 90 多条
  if (d.mandatory === false) return true;
  // side=CLIENT 的依赖只在客户端需要，服务端缺了不算问题
  if ((d.side ?? '').toUpperCase() === 'CLIENT') return true;
  return false;
}

function missingDepsOf(meta: JarMeta, satisfied: Set<string>): string[] {
  // 没有元数据的 jar（unknown）不猜依赖
  if (meta.kind === 'none') return [];
  const out = new Set<string>();
  for (const d of meta.dependencies) {
    if (ignoredDependency(d)) continue;
    if (satisfied.has(d.modId.toLowerCase())) continue;
    out.add(d.modId);
  }
  return [...out];
}

/* ------------------------------------------------------------------ *
 * 来源识别：sha1 / murmur2 / 缓存
 * ------------------------------------------------------------------ */

let sourceCache: SourceCache | null = null;

function loadSourceCache(): SourceCache {
  if (!sourceCache) {
    const raw = readJsonSync<SourceCache>(MODS_CACHE_FILE, {});
    sourceCache = raw && typeof raw === 'object' ? raw : {};
  }
  return sourceCache;
}

function saveSourceCache(): void {
  const cache = loadSourceCache();
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE_ENTRIES) {
    keys.sort((a, b) => (cache[a]?.checkedAt ?? 0) - (cache[b]?.checkedAt ?? 0));
    for (const k of keys.slice(0, keys.length - MAX_CACHE_ENTRIES)) delete cache[k];
  }
  atomicWriteJsonWithBackupSync(MODS_CACHE_FILE, cache);
}

const sha1Cache = new Map<string, string>();

function sha1OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

async function sha1Cached(file: string): Promise<string> {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  const hit = sha1Cache.get(key);
  if (hit) return hit;
  const sha1 = await sha1OfFile(file);
  remember(sha1Cache, key, sha1, MAX_CACHE_ENTRIES);
  return sha1;
}

/** CurseForge 的 murmur2 指纹（seed = 1，输出按 int32 有符号给接口） */
function murmur2(buffer: Buffer): number {
  const m = 0x5bd1e995;
  const len = buffer.length;
  let h = (1 ^ len) >>> 0;
  const n = len - (len % 4);
  let i = 0;
  for (; i < n; i += 4) {
    let k =
      ((buffer[i] & 0xff) |
        ((buffer[i + 1] & 0xff) << 8) |
        ((buffer[i + 2] & 0xff) << 16) |
        ((buffer[i + 3] & 0xff) << 24)) >>>
      0;
    k = Math.imul(k, m) >>> 0;
    k = (k ^ (k >>> 24)) >>> 0;
    k = Math.imul(k, m) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h = (h ^ k) >>> 0;
  }
  const rest = len & 3;
  if (rest === 3) h = (h ^ ((buffer[i + 2] & 0xff) << 16)) >>> 0;
  if (rest >= 2) h = (h ^ ((buffer[i + 1] & 0xff) << 8)) >>> 0;
  if (rest >= 1) {
    h = (h ^ (buffer[i] & 0xff)) >>> 0;
    h = Math.imul(h, m) >>> 0;
  }
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, m) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h | 0;
}

async function readFileFully(file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    rs.on('data', (c) => chunks.push(c as Buffer));
    rs.on('error', reject);
    rs.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const fingerprintCache = new Map<string, number>();

async function fingerprintOf(file: string): Promise<number> {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  const hit = fingerprintCache.get(key);
  if (hit !== undefined) return hit;
  const fp = murmur2(await readFileFully(file));
  remember(fingerprintCache, key, fp, MAX_CACHE_ENTRIES);
  return fp;
}

/** 8 秒超时的 JSON 请求；失败一律抛异常由调用方降级 */
async function requestJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<any> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers ?? {}) },
    body: init.body,
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as any;
}

interface ModrinthHit {
  projectId: string;
  versionId: string;
  versionNumber: string;
  slug: string | null;
  title: string | null;
  description: string | null;
  iconUrl: string | null;
  sourceUrl: string;
}

/** Modrinth：sha1 → 版本；再批量取项目信息 */
async function modrinthLookup(hashes: string[]): Promise<Map<string, ModrinthHit>> {
  const out = new Map<string, ModrinthHit>();
  const uniq = [...new Set(hashes.filter(Boolean))];
  if (!uniq.length) return out;

  const versionBySha = new Map<string, any>();
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    try {
      const data = await requestJson('https://api.modrinth.com/v2/version_files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: chunk, algorithm: 'sha1' }),
      });
      if (data && typeof data === 'object') {
        for (const sha of chunk) {
          const v = (data as Record<string, any>)[sha];
          if (v && typeof v === 'object') versionBySha.set(sha, v);
        }
      }
    } catch (err) {
      logger.warn(`Modrinth 反查失败（降级为 local/unknown）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!versionBySha.size) return out;

  // 项目信息（标题/图标/描述）批量拿，拿不到就用版本自带的信息兜底
  const projectIds = [...new Set([...versionBySha.values()].map((v) => String(v.project_id ?? '')).filter(Boolean))];
  const projects = new Map<string, any>();
  for (let i = 0; i < projectIds.length; i += 50) {
    const chunk = projectIds.slice(i, i + 50);
    try {
      const list = await requestJson(
        `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(chunk))}`,
      );
      if (Array.isArray(list)) {
        for (const p of list) if (p && p.id) projects.set(String(p.id), p);
      }
    } catch (err) {
      logger.warn(`Modrinth 项目信息拉取失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const [sha, v] of versionBySha) {
    const projectId = String(v.project_id ?? '');
    if (!projectId) continue;
    const p = projects.get(projectId);
    const slug = p?.slug ? String(p.slug) : null;
    out.set(sha, {
      projectId,
      versionId: String(v.id ?? ''),
      versionNumber: cleanText(v.version_number, 64),
      slug,
      title: p?.title ? cleanText(p.title, 160) : null,
      description: p?.description ? cleanText(p.description) : null,
      iconUrl: p?.icon_url ? String(p.icon_url) : null,
      sourceUrl: `https://modrinth.com/project/${slug ?? projectId}`,
    });
  }
  return out;
}

interface CurseforgeHit {
  cfProjectId: number;
  cfFileId: number;
  fileName: string | null;
  title: string | null;
  iconUrl: string | null;
  sourceUrl: string;
}

/** CurseForge：murmur2 指纹 → 文件；没配 key 时整段跳过（不报错） */
async function curseforgeLookup(files: string[]): Promise<Map<string, CurseforgeHit>> {
  const out = new Map<string, CurseforgeHit>();
  if (!files.length) return out;
  const cfg = loadConfig();
  const apiKey = String(cfg.mirrors?.curseforgeApiKey ?? '').trim();
  const apiBase = String(cfg.mirrors?.curseforgeApi ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!apiKey || !apiBase) {
    logger.debug('未配置 CurseForge API Key，跳过指纹识别');
    return out;
  }

  const fpToFile = new Map<number, string>();
  const pairs: { file: string; fp: number }[] = [];
  for (const file of files) {
    try {
      const fp = await fingerprintOf(file);
      if (fpToFile.has(fp)) continue;
      fpToFile.set(fp, file);
      pairs.push({ file, fp });
    } catch {
      /* 读不了就跳过 */
    }
  }
  if (!pairs.length) return out;

  const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/json' };
  const hits: { fp: number; fileInfo: any }[] = [];
  for (let i = 0; i < pairs.length; i += 100) {
    const chunk = pairs.slice(i, i + 100);
    try {
      const data = await requestJson(`${apiBase}/fingerprints`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ fingerprints: chunk.map((c) => c.fp) }),
      });
      const matches = data?.data?.exactMatches;
      if (Array.isArray(matches)) {
        for (let j = 0; j < matches.length; j++) {
          const mt = matches[j];
          const info = mt?.file ?? mt;
          // 接口不回传 murmur2，只能：显式带回指纹 → 单指纹批次 → 全命中按顺序，三种兜底
          let fp = Number(mt?.fingerprint ?? 0);
          if (!fpToFile.has(fp)) fp = 0;
          if (!fp && chunk.length === 1) fp = chunk[0].fp;
          if (!fp && matches.length === chunk.length) fp = chunk[j].fp;
          if (!fp) continue;
          hits.push({ fp, fileInfo: info });
        }
      }
    } catch (err) {
      logger.warn(`CurseForge 指纹反查失败（降级）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!hits.length) return out;

  const projectIds = [...new Set(hits.map((h) => Number(h.fileInfo?.modId ?? 0)).filter((n) => n > 0))];
  const projects = new Map<number, any>();
  if (projectIds.length) {
    try {
      const data = await requestJson(`${apiBase}/mods`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ modIds: projectIds }),
      });
      if (Array.isArray(data?.data)) for (const p of data.data) projects.set(Number(p.id), p);
    } catch (err) {
      logger.warn(`CurseForge 项目信息拉取失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const h of hits) {
    const cfFileId = Number(h.fileInfo?.id ?? 0);
    const cfProjectId = Number(h.fileInfo?.modId ?? 0);
    const file = fpToFile.get(h.fp);
    if (!cfFileId || !file) continue;
    const p = projects.get(cfProjectId);
    const slug = p?.slug ? String(p.slug) : null;
    out.set(file, {
      cfProjectId,
      cfFileId,
      fileName: h.fileInfo?.fileName ? String(h.fileInfo.fileName) : null,
      title: p?.name ? cleanText(p.name, 160) : null,
      iconUrl: p?.logo?.thumbnailUrl ? String(p.logo.thumbnailUrl) : p?.logo?.url ? String(p.logo.url) : null,
      sourceUrl: cfProjectId
        ? slug
          ? `https://www.curseforge.com/minecraft/mc-mods/${slug}/files/${cfFileId}`
          : `https://www.curseforge.com/projects/${cfProjectId}`
        : '',
    });
  }
  return out;
}

/**
 * 批量解析来源：先查 MODS_CACHE_FILE（键 = sha1），未命中才联网。
 * 任何网络失败都只写一条 degraded 记录并降级成 local/unknown，绝不抛出。
 */
async function resolveSources(files: string[], metas: Map<string, JarMeta>): Promise<Map<string, SourceRecord>> {
  const out = new Map<string, SourceRecord>();
  if (!files.length) return out;
  const cache = loadSourceCache();

  const hashed = await mapLimit(files, IO_CONCURRENCY, async (file) => {
    try {
      return { file, sha1: await sha1Cached(file) };
    } catch {
      return { file, sha1: '' };
    }
  });

  const need: { file: string; sha1: string }[] = [];
  for (const { file, sha1 } of hashed) {
    if (!sha1) continue;
    const hit = cache[sha1];
    if (hit && (!hit.degraded || Date.now() - (hit.checkedAt ?? 0) < DEGRADED_TTL_MS)) {
      out.set(file, hit);
      continue;
    }
    need.push({ file, sha1 });
  }
  if (!need.length) return out;

  const now = Date.now();
  const [mr, cf] = await Promise.all([
    modrinthLookup(need.map((n) => n.sha1)),
    curseforgeLookup(need.map((n) => n.file)).catch(() => new Map<string, CurseforgeHit>()),
  ]);

  for (const { file, sha1 } of need) {
    let rec: SourceRecord | null = null;
    const m = mr.get(sha1);
    if (m) {
      rec = {
        sha1,
        source: 'modrinth',
        sourceUrl: m.sourceUrl,
        iconUrl: m.iconUrl,
        projectTitle: m.title,
        projectId: m.projectId,
        versionId: m.versionId,
        version: m.versionNumber || null,
        latestVersion: m.versionNumber || null,
        hasUpdate: false,
        cfProjectId: null,
        cfFileId: null,
        checkedAt: now,
      };
    } else {
      const c = cf.get(file);
      if (c) {
        rec = {
          sha1,
          source: 'curseforge',
          sourceUrl: c.sourceUrl || null,
          iconUrl: c.iconUrl,
          projectTitle: c.title,
          projectId: null,
          versionId: null,
          version: null,
          latestVersion: null,
          hasUpdate: false,
          cfProjectId: c.cfProjectId || null,
          cfFileId: c.cfFileId || null,
          checkedAt: now,
        };
      }
    }
    if (!rec) {
      const meta = metas.get(file);
      const hasMeta = !!meta && meta.kind !== 'none';
      rec = {
        sha1,
        source: hasMeta ? 'local' : 'unknown',
        sourceUrl: null,
        iconUrl: null,
        projectTitle: null,
        projectId: null,
        versionId: null,
        version: null,
        latestVersion: null,
        hasUpdate: false,
        cfProjectId: null,
        cfFileId: null,
        checkedAt: now,
        degraded: true,
      };
    }
    cache[sha1] = rec;
    out.set(file, rec);
  }

  try {
    saveSourceCache();
  } catch (err) {
    logger.warn(`mods 缓存写盘失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ModInfo 组装
 * ------------------------------------------------------------------ */

function fallbackName(file: string): string {
  return file.replace(/\.jar(\.disabled)?$/i, '');
}

function toModInfo(m: ScannedMod, rec: SourceRecord | undefined, satisfied: Set<string>): ModInfo {
  const hasMeta = m.meta.kind !== 'none';
  return {
    file: m.file,
    name: m.meta.name || fallbackName(m.file),
    modId: m.meta.modId,
    version: m.meta.version,
    description: m.meta.description,
    authors: m.meta.authors,
    enabled: m.enabled,
    bytes: m.bytes,
    mtime: m.mtime,
    source: rec?.source ?? (hasMeta ? 'local' : 'unknown'),
    sourceUrl: rec?.sourceUrl ?? null,
    iconUrl: rec?.iconUrl ?? null,
    projectTitle: rec?.projectTitle ?? null,
    missingDeps: missingDepsOf(m.meta, satisfied),
    hasUpdate: rec?.hasUpdate ?? false,
    latestVersion: rec?.latestVersion ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * 列表 / 数量 / 详情
 * ------------------------------------------------------------------ */

function normalizeSize(size?: number): number {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(n)));
}

function matchesQuery(m: ScannedMod, tokens: string[]): boolean {
  const hay = `${m.file}\n${m.meta.name}\n${m.meta.modId ?? ''}\n${m.meta.description}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/** 列出某个世界的 MOD（目录 = <实例目录>/server/mods） */
export async function listMods(instanceId: string, query: ModListQuery = {}): Promise<ModListResult> {
  const id = assertInstanceId(instanceId);
  const dir = modsDirOf(id);
  const all = await scanMods(dir, metaPrefOf(id));
  const satisfied = collectSatisfied(all);
  const metaByFile = new Map<string, JarMeta>(all.map((m) => [m.full, m.meta]));

  let items = all;
  const status = query.status ?? 'all';
  if (status === 'enabled') items = items.filter((m) => m.enabled);
  else if (status === 'disabled') items = items.filter((m) => !m.enabled);

  const tokens = String(query.q ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length) items = items.filter((m) => matchesQuery(m, tokens));

  // 来源过滤要先知道全部候选的来源，这里只能整批解析；其余情况只解析当前页
  const sourceFilter = String(query.source ?? '')
    .trim()
    .toLowerCase();
  if (sourceFilter && sourceFilter !== 'all') {
    const recs = await resolveSources(
      items.map((m) => m.full),
      metaByFile,
    );
    items = items.filter((m) => {
      const rec = recs.get(m.full);
      const s = rec?.source ?? (m.meta.kind !== 'none' ? 'local' : 'unknown');
      return s === sourceFilter;
    });
  }

  const total = items.length;
  const size = normalizeSize(query.size);
  const pages = Math.max(1, Math.ceil(total / size));
  const rawPage = Number(query.page);
  const page = Math.min(pages, Math.max(1, Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1));
  const slice = items.slice((page - 1) * size, page * size);

  const recs = await resolveSources(
    slice.map((m) => m.full),
    metaByFile,
  );
  const list = slice.map((m) => toModInfo(m, recs.get(m.full), satisfied));

  return { total, page, size, pages, items: list, dir };
}

/** 数量缓存：总览卡片每次刷新都要调用，30 秒 TTL 内不再扫目录 */
const countCache = new Map<string, { n: number; at: number }>();

export function countMods(instanceId: string): number {
  const id = assertInstanceId(instanceId);
  const hit = countCache.get(id);
  if (hit && Date.now() - hit.at < COUNT_TTL_MS) return hit.n;
  const dir = modsDirOf(id);
  const n = listFilesSync(dir, (name) => MOD_FILE_RE.test(name)).length;
  countCache.set(id, { n, at: Date.now() });
  return n;
}

/** 目录内容变了（增删/启停/导入）时清掉计数缓存 */
function invalidateCount(instanceId: string): void {
  countCache.delete(instanceId);
}

/** 单个 MOD 详情：ModInfo + 依赖清单 */
export async function modDetail(
  instanceId: string,
  file: string,
): Promise<ModInfo & { dependencies: ModDependency[] }> {
  const id = assertInstanceId(instanceId);
  const dir = modsDirOf(id);
  const full = resolveModFile(dir, file);
  if (!fs.existsSync(full)) throw notFound(`MOD 不存在：${file}`);

  const all = await scanMods(dir, metaPrefOf(id));
  const satisfied = collectSatisfied(all);
  const target = all.find((m) => m.file === path.basename(full));
  if (!target) throw notFound(`MOD 不存在：${file}`);

  const recs = await resolveSources([target.full], new Map([[target.full, target.meta]]));
  const info = toModInfo(target, recs.get(target.full), satisfied);
  const dependencies: ModDependency[] = target.meta.dependencies
    .filter((d) => d.modId)
    .map((d) => ({ modId: d.modId, mandatory: d.mandatory, versionRange: d.versionRange }));
  return { ...info, dependencies };
}

/* ------------------------------------------------------------------ *
 * 删除 / 启用 / 停用
 * ------------------------------------------------------------------ */

/** 删除 MOD（运行中拒绝） */
export async function deleteMod(instanceId: string, file: string, opts: ModOpOptions = {}): Promise<void> {
  const id = assertInstanceId(instanceId);
  assertStopped(id, opts);
  const dir = modsDirOf(id);
  const full = resolveModFile(dir, file);
  if (!fs.existsSync(full)) throw notFound(`MOD 不存在：${file}`);
  const st = fs.statSync(full);
  if (!st.isFile()) throw bad(`不是文件：${file}`);
  fs.unlinkSync(full);
  invalidateCount(id);
  logger.info(`删除 MOD ${file}`, { instance: id, bytes: st.size });
}

/** 启用 / 停用（停用 = 改名成 xxx.jar.disabled），幂等 */
export async function setEnabled(
  instanceId: string,
  file: string,
  enabled: boolean,
  opts: ModOpOptions = {},
): Promise<void> {
  const id = assertInstanceId(instanceId);
  assertStopped(id, opts);
  const dir = modsDirOf(id);
  const full = resolveModFile(dir, file);
  if (!fs.existsSync(full)) throw notFound(`MOD 不存在：${file}`);

  const name = path.basename(full);
  const disabled = name.toLowerCase().endsWith('.disabled');

  if (enabled) {
    if (!disabled) return;
    const target = name.slice(0, name.length - '.disabled'.length);
    if (!/\.jar$/i.test(target)) throw bad(`无法识别的 MOD 文件名：${file}`);
    const dest = resolveModFile(dir, target);
    if (fs.existsSync(dest)) throw conflict(`同名文件已存在，无法启用：${target}`);
    fs.renameSync(full, dest);
    logger.info(`启用 MOD ${target}`, { instance: id });
  } else {
    if (disabled) return;
    if (!/\.jar$/i.test(name)) throw bad(`无法识别的 MOD 文件名：${file}`);
    const dest = resolveModFile(dir, `${name}.disabled`);
    if (fs.existsSync(dest)) throw conflict(`停用目标已存在：${name}.disabled`);
    fs.renameSync(full, dest);
    logger.info(`停用 MOD ${name}`, { instance: id });
  }
  invalidateCount(id);
}

/* ------------------------------------------------------------------ *
 * 批量导入
 * ------------------------------------------------------------------ */

function loaderKindOf(loader: Loader | undefined): 'fabric' | 'forge' | null {
  if (loader === 'fabric') return 'fabric';
  if (loader === 'forge' || loader === 'neoforge') return 'forge';
  return null;
}

/** 判断一段字符串是不是 base64（用来区分 multer 的内存上传与 latin1 原文） */
function looksLikeBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/**
 * 批量导入本地文件。
 * - 字符串入参 = 已上传到临时目录的绝对路径；
 * - `{name, data}` 入参 = 内存里的上传内容（data 按 base64 解，不是合法 base64 时按 latin1 写），
 *   会先落到 data/store/mods-upload/<实例>/ 再走同一条流程，用完即删。
 * 返回已加入的文件名与跳过原因；单个文件出问题不影响其他文件。
 */
export async function importMods(
  instanceId: string,
  paths: Array<string | ModUploadPayload>,
  loader: Loader,
  opts: ModOpOptions = {},
): Promise<{ added: string[]; skipped: { file: string; reason: string }[] }> {
  const id = assertInstanceId(instanceId);
  assertStopped(id, opts);
  if (!Array.isArray(paths) || !paths.length) throw bad('没有需要导入的文件');
  if (loader === 'vanilla' || loader === 'paper') {
    throw bad('原版 / Paper 世界不使用 mods 目录，请把文件放进 plugins 或另建 Forge/Fabric 世界');
  }

  const dir = modsDirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  const added: string[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const staged: string[] = [];

  // 内存上传的先落盘到 store 临时区
  let uploadDir = '';
  for (const item of paths) {
    if (typeof item === 'string') continue;
    const label = path.basename(String(item?.name ?? 'upload.jar')) || 'upload.jar';
    if (!uploadDir) uploadDir = path.join(STORE_DIR, 'mods-upload', id);
    try {
      fs.mkdirSync(uploadDir, { recursive: true });
      const safe = sanitizeDownloadName(label);
      const dest = path.join(uploadDir, `${Date.now().toString(36)}-${safe}`);
      const raw = String(item?.data ?? '');
      const buf = looksLikeBase64(raw) ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'latin1');
      fs.writeFileSync(dest, buf);
      staged.push(dest);
    } catch (err) {
      skipped.push({ file: label, reason: `临时落盘失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const allPaths = [...paths.filter((p): p is string => typeof p === 'string'), ...staged];

  const kind = loaderKindOf(loader);
  const prefer: MetaPref = kind === 'fabric' ? 'fabric' : 'forge';
  const existing = await scanMods(dir, prefer);
  const existingNames = new Set(existing.map((m) => m.file.toLowerCase()));
  const existingIds = new Set<string>();
  for (const m of existing) {
    for (const mid of m.meta.allModIds) existingIds.add(mid.toLowerCase());
  }

  try {
    for (const raw of allPaths) {
      const src = path.resolve(String(raw ?? ''));
      const label = path.basename(src) || String(raw);
      try {
        if (!fs.existsSync(src)) {
          skipped.push({ file: label, reason: '文件不存在' });
          continue;
        }
        const st = fs.statSync(src);
        if (!st.isFile()) {
          skipped.push({ file: label, reason: '不是普通文件' });
          continue;
        }
        if (st.size <= 0) {
          skipped.push({ file: label, reason: '文件大小为 0' });
          continue;
        }
        if (!MOD_FILE_RE.test(label)) {
          skipped.push({ file: label, reason: '只接受 .jar 文件' });
          continue;
        }
        const name = safeModFileName(label);

        const meta = await readJarMeta(src, kind === 'fabric' ? 'fabric' : 'forge');
        if (meta.kind === 'none') {
          skipped.push({ file: name, reason: meta.error ?? '无法识别 MOD 元数据' });
          continue;
        }
        if (kind === 'fabric' && (meta.kind === 'forge' || meta.kind === 'neoforge')) {
          skipped.push({ file: name, reason: '这是 Forge/NeoForge 的 MOD，Fabric 世界无法加载' });
          continue;
        }
        // 反过来（Fabric 的 MOD 进 Forge/NeoForge）不拦：Sinytra Connector 就是干这个的

        const lower = name.toLowerCase();
        if (existingNames.has(lower)) {
          skipped.push({ file: name, reason: '同名文件已存在' });
          continue;
        }
        const dupId = meta.allModIds.find((mid) => existingIds.has(mid.toLowerCase()));
        if (dupId) {
          skipped.push({ file: name, reason: `该 MOD 已存在（modId: ${dupId}）` });
          continue;
        }

        // 复制到 .part 再 rename，避免半成品文件被服务端读到
        const dest = path.join(dir, name);
        const tmp = path.join(dir, `.${name}.${process.pid}.${Date.now().toString(36)}.part`);
        try {
          fs.copyFileSync(src, tmp);
          if (fs.statSync(tmp).size <= 0) throw new Error('复制结果为空');
          fs.renameSync(tmp, dest);
        } catch (err) {
          try {
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          throw err;
        }

        added.push(name);
        existingNames.add(lower);
        for (const mid of meta.allModIds) existingIds.add(mid.toLowerCase());
        logger.info(`导入 MOD ${name}`, { instance: id, bytes: st.size, from: src });
      } catch (err) {
        skipped.push({ file: label, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    // 清掉我们自己落的临时文件（调用方的上传文件不碰）
    for (const f of staged) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }

  if (added.length) invalidateCount(id);
  return { added, skipped };
}

/* ------------------------------------------------------------------ *
 * 链接下载
 * ------------------------------------------------------------------ */

interface DownloadCandidate {
  url: string;
  source: string;
  /** 已知文件名（来自接口时用得上） */
  fileName: string | null;
}

function mirrorPrefix(): string {
  try {
    const cfg = loadConfig();
    const m = String(cfg.mirrors?.githubMirror ?? '').trim();
    return m && m.startsWith('http') ? m : '';
  } catch {
    return '';
  }
}

function isModrinthPage(url: URL): boolean {
  return /(^|\.)modrinth\.com$/i.test(url.hostname);
}

function isCurseforgePage(url: URL): boolean {
  return /(^|\.)curseforge\.com$/i.test(url.hostname);
}

function modrinthLoaderNames(loader?: Loader): string[] {
  if (loader === 'fabric') return ['fabric', 'quilt'];
  if (loader === 'forge') return ['forge'];
  if (loader === 'neoforge') return ['neoforge'];
  if (loader === 'paper') return ['paper', 'bukkit', 'spigot', 'purpur'];
  return [];
}

/** 把 Modrinth 页面链接解析成可直接下载的文件地址 */
async function resolveModrinthPage(url: URL, loader?: Loader): Promise<DownloadCandidate | null> {
  const parts = url.pathname.split('/').filter(Boolean);
  // /mod/<slug>、/project/<slug>、/mod/<slug>/version/<id>
  const projectSlug = parts[0] === 'mod' || parts[0] === 'project' ? parts[1] : null;
  const versionIdx = parts.indexOf('version');
  const versionId = versionIdx >= 0 ? parts[versionIdx + 1] : null;
  if (!projectSlug && !versionId) return null;

  let version: any = null;
  if (versionId) {
    version = await requestJson(`https://api.modrinth.com/v2/version/${encodeURIComponent(versionId)}`);
  } else {
    const loaders = modrinthLoaderNames(loader);
    const qs = loaders.length ? `?loaders=${encodeURIComponent(JSON.stringify(loaders))}` : '';
    const list = await requestJson(
      `https://api.modrinth.com/v2/project/${encodeURIComponent(projectSlug as string)}/version${qs}`,
    );
    if (Array.isArray(list) && list.length) version = list[0];
  }
  const file = Array.isArray(version?.files)
    ? (version.files.find((f: any) => f?.primary) ?? version.files[0])
    : null;
  if (!file?.url) return null;
  return { url: String(file.url), source: 'modrinth', fileName: file.filename ? String(file.filename) : null };
}

/**
 * 把 CurseForge 页面链接解析成下载地址。
 * 没配 key 时拿不到 modId / 文件名，只能返回空，由上层给「手动下载」提示。
 */
async function resolveCurseforgePage(url: URL): Promise<DownloadCandidate[]> {
  const parts = url.pathname.split('/').filter(Boolean);
  const slug = parts[0] === 'minecraft' && parts[1] === 'mc-mods' ? parts[2] : null;
  const fileIdx = parts.indexOf('files');
  const fileId = fileIdx >= 0 ? Number(parts[fileIdx + 1]) : NaN;
  if (!slug || !Number.isFinite(fileId)) return [];

  const cfg = loadConfig();
  const apiKey = String(cfg.mirrors?.curseforgeApiKey ?? '').trim();
  const apiBase = String(cfg.mirrors?.curseforgeApi ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!apiKey || !apiBase) {
    logger.info('未配置 CurseForge API Key，无法解析 CurseForge 页面链接');
    return [];
  }

  let modId = 0;
  let fileName: string | null = null;
  try {
    const search = await requestJson(
      `${apiBase}/mods/search?gameId=432&slug=${encodeURIComponent(slug)}&pageSize=1`,
      { headers: { 'x-api-key': apiKey } },
    );
    modId = Number(search?.data?.[0]?.id ?? 0);
  } catch (err) {
    logger.warn(`CurseForge 查询项目失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!modId) return [];

  const out: DownloadCandidate[] = [];
  try {
    const data = await requestJson(`${apiBase}/mods/${modId}/files/${fileId}`, {
      headers: { 'x-api-key': apiKey },
    });
    const file = data?.data;
    if (file?.fileName) fileName = String(file.fileName);
    if (file?.downloadUrl) out.push({ url: String(file.downloadUrl), source: 'curseforge', fileName });
  } catch (err) {
    logger.warn(`CurseForge 查询文件失败：${err instanceof Error ? err.message : String(err)}`);
  }

  // 兜底：这个跳转接口不需要 key，只要有 modId + fileId 就能拿到 CDN 直链
  out.push({
    url: `https://www.curseforge.com/api/v1/mods/${modId}/files/${fileId}/download`,
    source: 'curseforge',
    fileName,
  });
  if (fileName) out.unshift({ url: edgeForgeCdnUrl(fileId, fileName), source: 'curseforge', fileName });
  return out;
}

/** CurseForge CDN 路径规则：/files/<fileId 去掉后三位>/<后三位>/<文件名> */
function edgeForgeCdnUrl(fileId: number, fileName: string): string {
  const s = String(fileId);
  const tail = s.length <= 3 ? s.padStart(3, '0') : s.slice(-3);
  const head = s.length <= 3 ? '0' : s.slice(0, s.length - 3);
  return `https://edge.forgecdn.net/files/${head}/${tail}/${encodeURIComponent(fileName)}`;
}

interface StreamResult {
  bytes: number;
  contentType: string | null;
  disposition: string | null;
}

/** 流式下载到 .part（与目标同盘，rename 才能原子落位） */
async function streamToFile(url: string, part: string): Promise<StreamResult> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) throw new Error('响应没有内容');
  const ws = fs.createWriteStream(part);
  await pipeline(Readable.fromWeb(res.body as never), ws);
  const size = fs.statSync(part).size;
  return {
    bytes: size,
    contentType: res.headers.get('content-type'),
    disposition: res.headers.get('content-disposition'),
  };
}

function fileNameFromHeaders(disposition: string | null, candidate: string | null, url: string): string {
  if (disposition) {
    const star = disposition.match(/filename\*\s*=\s*([^;]+)/i);
    if (star) {
      const raw = star[1].trim().replace(/^UTF-8''/i, '').replace(/^"|"$/g, '');
      if (raw) return sanitizeDownloadName(raw);
    }
    const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (plain) return sanitizeDownloadName(plain[1]);
  }
  if (candidate) return sanitizeDownloadName(candidate);
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    if (base) return sanitizeDownloadName(base);
  } catch {
    /* ignore */
  }
  return 'mod.jar';
}

/** 落盘结果是不是一个 zip（jar 的魔数就是 PK），用来识破 CDN 返回的 HTML 错误页 */
function looksLikeZip(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(2);
      const n = fs.readSync(fd, buf, 0, 2, 0);
      return n === 2 && buf[0] === 0x50 && buf[1] === 0x4b;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * 从链接下载 MOD。
 * 支持 Modrinth 页面链接 / CurseForge 页面链接 / 任意直链。
 * 兜底链：原始地址 → edge.forgecdn.net（有 CurseForge fileId 时）→ githubMirror 前缀代理，
 * 全失败抛 NOT_READY 并给出「该文件需要手动下载」的原站链接。
 */
export async function downloadFromUrl(
  instanceId: string,
  url: string,
  loader?: Loader,
  opts: ModOpOptions = {},
): Promise<{ file: string; source: string }> {
  const id = assertInstanceId(instanceId);
  assertStopped(id, opts);
  const raw = String(url ?? '').trim();
  if (!raw) throw bad('下载链接不能为空');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw bad(`链接格式不正确：${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw bad('只支持 http/https 链接');

  // 1) 解析出候选地址
  let candidates: DownloadCandidate[] = [];
  if (isModrinthPage(parsed)) {
    try {
      const hit = await resolveModrinthPage(parsed, loader);
      if (hit) candidates.push(hit);
    } catch (err) {
      logger.warn(`Modrinth 页面解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (isCurseforgePage(parsed)) {
    try {
      candidates = await resolveCurseforgePage(parsed);
    } catch (err) {
      logger.warn(`CurseForge 页面解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    candidates.push({ url: raw, source: 'direct', fileName: null });
  }

  if (!candidates.length) throw notReady(`该文件需要手动下载：${raw}`);

  // 2) 追加镜像候选：githubMirror 是「前缀 + 原始地址」的代理写法
  const mirror = mirrorPrefix();
  if (mirror) {
    for (const c of [...candidates]) {
      if (candidates.length === 1 || /github\.com|githubusercontent\.com|cdn\.modrinth\.com/i.test(c.url)) {
        candidates.push({ url: mirror + c.url, source: c.source, fileName: c.fileName });
      }
    }
  }

  const dir = modsDirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  const errors: string[] = [];

  for (const cand of candidates) {
    const stamp = `${process.pid}.${Date.now().toString(36)}`;
    const part = path.join(dir, `.download-${stamp}.part`);
    try {
      const res = await streamToFile(cand.url, part);
      if (res.bytes <= 0) throw new Error('下载结果为空');
      if (!looksLikeZip(part)) throw new Error('下载内容不是 jar/zip');
      const base = fileNameFromHeaders(res.disposition, cand.fileName, cand.url);
      const finalName = uniqueNameIn(dir, safeModFileName(base));
      const finalPath = path.join(dir, finalName);
      fs.renameSync(part, finalPath);
      invalidateCount(id);
      logger.info(`下载 MOD ${finalName}`, { instance: id, from: cand.url, bytes: res.bytes });

      // 顺手做一次来源识别，让界面立刻能显示徽标（失败不影响下载结果）
      let source = cand.source;
      try {
        const meta = await readJarMeta(finalPath, metaPrefOf(id));
        const recs = await resolveSources([finalPath], new Map([[finalPath, meta]]));
        const rec = recs.get(finalPath);
        if (rec && !rec.degraded) source = rec.source;
      } catch {
        /* 忽略 */
      }
      return { file: finalName, source };
    } catch (err) {
      errors.push(`${cand.url} → ${err instanceof Error ? err.message : String(err)}`);
      try {
        if (fs.existsSync(part)) fs.unlinkSync(part);
      } catch {
        /* ignore */
      }
    }
  }

  logger.warn(`MOD 下载全部失败：${raw}`, errors.slice(0, 6));
  throw notReady(`该文件需要手动下载：${raw}`);
}

/* ------------------------------------------------------------------ *
 * 更新检查
 * ------------------------------------------------------------------ */

interface VersionFilter {
  mc: string | null;
  loader: Loader | null;
}

/** 从实例 config.json 取 MC 版本与加载器（实例不存在时返回空，不报错） */
function versionFilterOf(instanceId: string): VersionFilter {
  const cfg = readJsonSync<{ mc?: string; loader?: Loader } | null>(instanceConfigFile(instanceId), null);
  return { mc: cfg?.mc ? String(cfg.mc) : null, loader: (cfg?.loader as Loader) ?? null };
}

function pickLatestVersion(versions: any[], currentId: string | null, filter: VersionFilter): any | null {
  const loaders = modrinthLoaderNames(filter.loader ?? undefined);
  for (const v of versions) {
    if (!v || typeof v !== 'object') continue;
    if (currentId && String(v.id) === currentId) continue;
    if (filter.mc && Array.isArray(v.game_versions) && !v.game_versions.includes(filter.mc)) continue;
    if (loaders.length && Array.isArray(v.loaders) && !v.loaders.some((l: string) => loaders.includes(String(l)))) {
      continue;
    }
    if (!Array.isArray(v.files) || !v.files.length) continue;
    return v;
  }
  return null;
}

/** 同一世界同一时间只允许一次更新检查在跑 */
const updateInFlight = new Map<string, Promise<ModInfo[]>>();

/**
 * 检查更新：Modrinth 侧用 sha1 反查当前版本，再比对项目最新版本。
 * 只返回「有更新」的 MOD。
 */
export async function checkUpdates(instanceId: string): Promise<ModInfo[]> {
  const id = assertInstanceId(instanceId);
  const running = updateInFlight.get(id);
  if (running) return running;

  const task = (async (): Promise<ModInfo[]> => {
    const dir = modsDirOf(id);
    const all = await scanMods(dir, metaPrefOf(id));
    if (!all.length) return [];
    const metaByFile = new Map<string, JarMeta>(all.map((m) => [m.full, m.meta]));
    const recs = await resolveSources(
      all.map((m) => m.full),
      metaByFile,
    );
    const satisfied = collectSatisfied(all);
    const filter = versionFilterOf(id);

    // 按 projectId 归并，一个项目只请求一次
    const byProject = new Map<string, { record: SourceRecord; mods: ScannedMod[] }>();
    for (const m of all) {
      const rec = recs.get(m.full);
      if (!rec || rec.source !== 'modrinth' || !rec.projectId) continue;
      const bucket = byProject.get(rec.projectId);
      if (bucket) bucket.mods.push(m);
      else byProject.set(rec.projectId, { record: rec, mods: [m] });
    }

    await mapLimit([...byProject.entries()], 4, async ([projectId, bucket]) => {
      try {
        const versions = await requestJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`);
        if (!Array.isArray(versions)) return;
        const latest = pickLatestVersion(versions, bucket.record.versionId, filter);
        bucket.record.checkedAt = Date.now();
        bucket.record.degraded = false;
        if (latest) {
          bucket.record.hasUpdate = true;
          bucket.record.latestVersion = cleanText(latest.version_number, 64) || bucket.record.latestVersion;
        } else {
          bucket.record.hasUpdate = false;
          bucket.record.latestVersion = bucket.record.version ?? bucket.record.latestVersion;
        }
      } catch (err) {
        logger.warn(`检查 ${projectId} 更新失败：${err instanceof Error ? err.message : String(err)}`);
      }
    });

    try {
      saveSourceCache();
    } catch (err) {
      logger.warn(`mods 缓存写盘失败：${err instanceof Error ? err.message : String(err)}`);
    }

    const out: ModInfo[] = [];
    for (const m of all) {
      const rec = recs.get(m.full);
      if (rec?.hasUpdate) out.push(toModInfo(m, rec, satisfied));
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    logger.info(`更新检查完成：${all.length} 个 MOD，${out.length} 个有更新`, { instance: id });
    return out;
  })();

  updateInFlight.set(id, task);
  try {
    return await task;
  } finally {
    updateInFlight.delete(id);
  }
}

/* ------------------------------------------------------------------ *
 * 缺失依赖建议
 * ------------------------------------------------------------------ */

/**
 * 统计缺失依赖（只给建议，不自动下载）。
 * 判定规则：jar 自身声明的依赖 − 已启用 MOD 的 modId（含 jar-in-jar）− 平台白名单；
 * versionRange / modId 里含 ${ 的整块忽略；side=CLIENT 的忽略。
 */
export async function missingDependencies(instanceId: string): Promise<MissingDependency[]> {
  const id = assertInstanceId(instanceId);
  const dir = modsDirOf(id);
  const all = await scanMods(dir, metaPrefOf(id));
  const satisfied = collectSatisfied(all);

  const acc = new Map<string, { requestedBy: Set<string>; ranges: Set<string> }>();
  for (const m of all) {
    if (!m.enabled) continue;
    const owner = m.meta.modId || m.meta.name || m.file;
    for (const d of m.meta.dependencies) {
      if (ignoredDependency(d)) continue;
      if (satisfied.has(d.modId.toLowerCase())) continue;
      let slot = acc.get(d.modId);
      if (!slot) {
        slot = { requestedBy: new Set(), ranges: new Set() };
        acc.set(d.modId, slot);
      }
      slot.requestedBy.add(owner);
      if (d.versionRange) slot.ranges.add(d.versionRange);
    }
  }

  return [...acc.entries()]
    .map(([modId, v]) => ({
      modId,
      requestedBy: [...v.requestedBy].sort(),
      versionRange: [...v.ranges].join(' || ') || '*',
    }))
    .sort((a, b) => a.modId.localeCompare(b.modId));
}

/* ------------------------------------------------------------------ *
 * 其它对外小接口
 * ------------------------------------------------------------------ */

/** 清掉内存里的扫描 / 来源缓存（面板切世界或手动刷新时可用） */
export function clearCaches(instanceId?: string): void {
  if (!instanceId) {
    jarMetaCache.clear();
    sha1Cache.clear();
    fingerprintCache.clear();
    countCache.clear();
    return;
  }
  const id = assertInstanceId(instanceId);
  const dir = modsDirOf(id);
  const prefix = `${dir}${path.sep}`;
  for (const key of [...jarMetaCache.keys()]) if (key.startsWith(prefix)) jarMetaCache.delete(key);
  for (const key of [...sha1Cache.keys()]) if (key.startsWith(prefix)) sha1Cache.delete(key);
  for (const key of [...fingerprintCache.keys()]) if (key.startsWith(prefix)) fingerprintCache.delete(key);
  countCache.delete(id);
}
