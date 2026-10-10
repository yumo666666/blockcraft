import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { JDK_DIR } from '../core/paths.ts';
import { createLogger } from '../core/logger.ts';
import { compareVersion, versionTuple } from '../launcher/index.ts';
import type { Loader } from '../types.ts';

const logger = createLogger('java');

export interface JavaRuntime {
  major: number;
  path: string;
  home: string;
  version: string;
  source: 'system' | 'managed';
}

const SEARCH_DIRS = [
  '/usr/lib/jvm',
  '/usr/java',
  '/opt/java',
  '/Library/Java/JavaVirtualMachines',
  JDK_DIR,
];

function javaFileName(): string {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function javaSearchDirs(): string[] {
  if (process.platform !== 'win32') return SEARCH_DIRS;
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  return [
    process.env.JAVA_HOME || '',
    path.join(programFiles, 'Java'),
    path.join(programFiles, 'Eclipse Adoptium'),
    path.join(programFiles, 'Microsoft'),
    JDK_DIR,
    ...String(process.env.PATH || '').split(path.delimiter),
  ].filter(Boolean);
}

function javaMajorFromVersionOutput(out: string): number | null {
  // java version "1.8.0_402" / openjdk version "17.0.10" / openjdk version "25.0.4.1"
  const m = out.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const first = parseInt(m[1], 10);
  if (first === 1 && m[2]) return parseInt(m[2], 10);
  return first;
}

/**
 * 探测一个 java 可执行文件。
 * 注意：`java -version` 把版本打到 **stderr**（stdout 是空的），而且退出码是 0，
 * 所以不能用 execFileSync 成功时的 stdout —— 必须两个流都收。这里用 spawnSync。
 */
export function inspectJava(bin: string): JavaRuntime | null {
  let stdout = '';
  let stderr = '';
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 10000 });
    stdout = r.stdout ?? '';
    stderr = r.stderr ?? '';
  } catch {
    return null;
  }
  const text = `${stdout}\n${stderr}`;
  const major = javaMajorFromVersionOutput(text);
  if (!major) return null;
  const version = text.split('\n').find((l) => l.trim())?.trim() ?? `Java ${major}`;
  const relativeToManaged = path.relative(JDK_DIR, bin);
  const managed = !path.isAbsolute(relativeToManaged) && relativeToManaged !== '..' && !relativeToManaged.startsWith(`..${path.sep}`);
  return {
    major,
    path: bin,
    home: path.dirname(path.dirname(bin)),
    version,
    source: managed ? 'managed' : 'system',
  };
}

let cache: JavaRuntime[] | null = null;
let cacheAt = 0;

export function listJava(force = false): JavaRuntime[] {
  if (cache && !force) return cache;
  if (cache && force && Date.now() - cacheAt < 30_000) return cache;
  const found = new Map<number, JavaRuntime>();
  const check = (bin: string) => {
    if (!fs.existsSync(bin)) return;
    const rt = inspectJava(bin);
    if (!rt) return;
    const cur = found.get(rt.major);
    // managed 优先，其次版本号更高的
    if (!cur || (rt.source === 'managed' && cur.source === 'system')) found.set(rt.major, rt);
  };
  const exe = javaFileName();
  for (const dir of javaSearchDirs()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      check(path.join(dir, e.name, 'bin', exe));
    }
    check(path.join(dir, 'bin', exe));
    check(path.join(dir, exe));
  }
  cache = [...found.values()].sort((a, b) => a.major - b.major);
  cacheAt = Date.now();
  return cache;
}

/** MC 版本 → 需要的 Java 大版本（v1 实测对照表） */
export function requiredJavaFor(mc: string, loader: Loader): number {
  const [year, minor] = versionTuple(mc);
  if (year >= 20) return 25; // 26.x 这类年份版本（当前实测需要 25）
  if (year === 1) {
    const v = minor;
    if (v >= 20 && compareVersion(mc, '1.20.5') >= 0) return 21; // 1.20.5+ 需要 21
    if (v >= 18) return 17; // 1.18 ~ 1.20.4
    if (v === 17) return 17; // 1.17.x 声明 16，apt 里没有，向上取 17
    if (v >= 13) return 8;
    return 8;
  }
  if (loader === 'paper') return 17;
  return 17;
}

/** 选兼容版本：优先用户配置的 Java，否则选已检测到的最低兼容版本。 */
export function selectCompatibleJava(
  configured: JavaRuntime | null,
  available: JavaRuntime[],
  required: number,
): JavaRuntime | null {
  if (configured && configured.major >= required) return configured;
  return available.filter((runtime) => runtime.major >= required).sort((a, b) => a.major - b.major)[0] ?? null;
}

/** 向上取最近的可用版本（1.17 声明 16 → 用 17；没有兼容版本就明确失败） */
export function resolveJava(required: number): JavaRuntime | null {
  return selectCompatibleJava(null, listJava(), required);
}

export interface JavaResolution {
  runtime: JavaRuntime | null;
  required: number;
  reason: string;
}

export function autoJava(mc: string, loader: Loader): JavaResolution {
  const required = requiredJavaFor(mc, loader);
  const runtime = resolveJava(required);
  if (!runtime) {
    const installed = listJava();
    const reason = installed.length
      ? `这个世界需要 Java ${required}，但检测到的最高版本只有 Java ${installed.at(-1)!.major}。请安装 Java ${required} 或更高版本，或指定兼容的 java 路径。`
      : `需要 Java ${required}，但本机没有检测到 Java。请安装 JDK，或指定 java 路径。`;
    return { runtime: null, required, reason };
  }
  const reason =
    runtime.major === required
      ? `使用 Java ${runtime.major}`
      : `${mc} 建议 Java ${required}，本机取最近的 Java ${runtime.major}`;
  return { runtime, required, reason };
}

export function javaByMajor(major: number): JavaRuntime | null {
  const all = listJava();
  return all.find((j) => j.major === major) ?? resolveJava(major);
}

/** Adoptium 下载（本机没有兼容版本时由安装/启动流程按需调用） */
export async function downloadJava(major: number, onProgress?: (message: string) => void, opts: { signal?: AbortSignal } = {}): Promise<JavaRuntime> {
  const archMap: Record<string, string> = { arm64: 'aarch64', x64: 'x64', arm: 'arm' };
  const osMap: Record<string, string> = { linux: 'linux', darwin: 'mac', win32: 'windows' };
  const arch = archMap[process.arch] ?? 'x64';
  const osName = osMap[process.platform] ?? 'linux';
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${osName}/${arch}/jdk/hotspot/normal/eclipse`;
  fs.mkdirSync(JDK_DIR, { recursive: true });
  const windows = process.platform === 'win32';
  const target = path.join(JDK_DIR, `temurin-${major}.${windows ? 'zip' : 'tar.gz'}`);
  const partial = `${target}.part`;
  const maxAttempts = 4;
  const retryDelaysMs = [1000, 2500, 5000];
  logger.info(`下载 JDK ${major}`, { url });
  try {
    let downloaded = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      opts.signal?.throwIfAborted();
      const resumeAt = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
      try {
        onProgress?.(`正在下载 Temurin Java ${major}（第 ${attempt}/${maxAttempts} 次）…`);
        const headers = resumeAt > 0 ? { range: `bytes=${resumeAt}-` } : undefined;
        const res = await fetch(url, { redirect: 'follow', headers, signal: opts.signal });
        if (!res.ok || !res.body) {
          await res.body?.cancel().catch(() => undefined);
          const error = new Error(`下载 JDK 失败：HTTP ${res.status}`) as Error & { retryable?: boolean };
          error.retryable = res.status >= 500 || res.status === 408 || res.status === 429;
          throw error;
        }

        let append = false;
        let expectedTotal = 0;
        if (res.status === 206) {
          const range = res.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
          const start = range ? Number(range[1]) : -1;
          if (!range || start !== resumeAt) {
            await res.body.cancel().catch(() => undefined);
            fs.rmSync(partial, { force: true });
            throw new Error(`Java ${major} 下载续传位置不匹配，已重置临时文件`);
          }
          append = resumeAt > 0;
          expectedTotal = range[3] === '*' ? 0 : Number(range[3]);
        }

        // If the mirror ignores Range and sends 200, start over using the full response.
        const baseBytes = append ? resumeAt : 0;
        if (!expectedTotal) {
          const contentLength = Number(res.headers.get('content-length') ?? 0);
          if (contentLength > 0) expectedTotal = baseBytes + contentLength;
        }
        let received = baseBytes;
        let lastPercent = Math.floor((received / (expectedTotal || Number.POSITIVE_INFINITY)) * 100);
        const progress = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (expectedTotal > 0) {
              const percent = Math.min(100, Math.floor((received / expectedTotal) * 100));
              if (percent >= lastPercent + 10 || percent === 100) {
                lastPercent = percent;
                onProgress?.(`正在下载 Temurin Java ${major}：${percent}%`);
              }
            }
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(res.body as never),
          progress,
          fs.createWriteStream(partial, { flags: append ? 'a' : 'w' }),
          { signal: opts.signal },
        );
        const actual = fs.statSync(partial).size;
        if (!actual || (expectedTotal > 0 && actual !== expectedTotal)) {
          throw new Error(`Java ${major} 下载不完整：${actual}/${expectedTotal || '未知'} 字节`);
        }
        downloaded = true;
        break;
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? err;
        const retryable = !(err instanceof Error && 'retryable' in err && err.retryable === false);
        if (!retryable || attempt === maxAttempts) throw err;

        const delay = retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1)!;
        const bytes = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
        const resumeMessage = bytes > 0 ? `，已保留 ${Math.floor(bytes / (1024 * 1024))} MB 并尝试续传` : '';
        logger.warn(`JDK ${major} 下载中断，准备重试`, { attempt, maxAttempts, bytes, error: String(err) });
        onProgress?.(`下载中断${resumeMessage}；${delay / 1000} 秒后重试（${attempt}/${maxAttempts}）…`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    if (!downloaded) throw new Error(`Java ${major} 下载失败，已重试 ${maxAttempts} 次`);
    opts.signal?.throwIfAborted();
    fs.renameSync(partial, target);

    onProgress?.(`Java ${major} 下载完成，正在解压…`);
    if (windows) {
      const quote = (value: string) => value.replaceAll("'", "''");
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${quote(target)}' -DestinationPath '${quote(JDK_DIR)}' -Force`],
        { stdio: 'ignore' },
      );
    } else {
      execFileSync('tar', ['xzf', target, '-C', JDK_DIR]);
    }

    const extracted = fs
      .readdirSync(JDK_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('jdk-'))
      .map((entry) => inspectJava(path.join(JDK_DIR, entry.name, 'bin', javaFileName())))
      .find((runtime) => runtime?.major === major);
    if (!extracted) throw new Error(`Java ${major} 解压后未找到可运行的对应版本`);
    fs.unlinkSync(target);
    cache = null;
    summaryCache = null;
    logger.info(`JDK ${major} 已就绪`, { path: extracted.path });
    onProgress?.(`Java ${major} 已安装`);
    return extracted;
  } catch (err) {
    try {
      fs.rmSync(partial, { force: true });
      fs.rmSync(target, { force: true });
    } catch {
      /* ignore cleanup errors */
    }
    throw err;
  }
}

interface SharedJavaDownload {
  promise: Promise<JavaRuntime>;
  controller: AbortController;
  users: number;
}

const javaDownloads = new Map<number, SharedJavaDownload>();

function waitForJavaDownload(promise: Promise<JavaRuntime>, signal?: AbortSignal): Promise<JavaRuntime> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('任务已取消'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('任务已取消'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** 缺少兼容 Java 时自动下载 Temurin，并返回可启动的运行时。 */
export async function ensureJava(
  mc: string,
  loader: Loader,
  onProgress?: (message: string) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<JavaResolution> {
  opts.signal?.throwIfAborted();
  const required = requiredJavaFor(mc, loader);
  const installed = resolveJava(required);
  if (installed) {
    const reason = installed.major === required ? `使用 Java ${installed.major}` : `${mc} 建议 Java ${required}，本机取最近的 Java ${installed.major}`;
    return { runtime: installed, required, reason };
  }

  let pending = javaDownloads.get(required);
  if (!pending) {
    const controller = new AbortController();
    const promise = downloadJava(required, onProgress, { signal: controller.signal });
    pending = { promise, controller, users: 0 };
    javaDownloads.set(required, pending);
  } else {
    onProgress?.(`正在等待 Java ${required} 下载完成…`);
  }
  pending.users += 1;

  try {
    const runtime = await waitForJavaDownload(pending.promise, opts.signal);
    return { runtime, required, reason: `已自动安装并使用 Java ${runtime.major}` };
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? err;
    const installedVersions = listJava(true);
    const local = installedVersions.length
      ? `本机已有 Java ${installedVersions.map((j) => j.major).join('、')}，但都不兼容。`
      : '本机没有可用的 Java。';
    return {
      runtime: null,
      required,
      reason: `${local}自动下载 Java ${required} 失败：${String(err)}。请检查网络连接后重试。`,
    };
  } finally {
    pending.users = Math.max(0, pending.users - 1);
    if (javaDownloads.get(required) === pending) {
      if (pending.users === 0) javaDownloads.delete(required);
    }
    if (opts.signal?.aborted && pending.users === 0) pending.controller.abort(opts.signal.reason);
  }
}

/** 环境自检用：本机 Java 概览 */
let summaryCache: { at: number; value: { installed: { major: number; path: string }[]; managed: boolean } } | null = null;

/**
 * 环境自检用的 Java 概览。
 * 注意：探测要 spawn `java -version`（同步、每个约 300ms），**不能每个请求都刷**，
 * 否则 /api/panel 会把事件循环卡住一秒以上，连看门狗都会以为面板挂了。
 */
export function javaSummary(force = false): { installed: { major: number; path: string }[]; managed: boolean } {
  if (!force && summaryCache && Date.now() - summaryCache.at < 60_000) return summaryCache.value;
  const all = listJava(force);
  const value = { installed: all.map((j) => ({ major: j.major, path: j.path })), managed: all.some((j) => j.source === 'managed') };
  summaryCache = { at: Date.now(), value };
  return value;
}
