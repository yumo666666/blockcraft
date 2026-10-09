import fs from 'node:fs';
import path from 'node:path';
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
function probeJava(bin: string): JavaRuntime | null {
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
    const rt = probeJava(bin);
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

/** 向上取最近的可用版本（1.17 声明 16 → 用 17；没有 17 就用 21） */
export function resolveJava(required: number): JavaRuntime | null {
  const all = listJava();
  if (!all.length) return null;
  const exactOrHigher = all.filter((j) => j.major >= required);
  if (exactOrHigher.length) return exactOrHigher[0];
  return all[all.length - 1];
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
    return { runtime: null, required, reason: `需要 Java ${required}，但本机没有检测到任何 Java。请安装 JDK，或在设置里手动指定 java 路径。` };
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

/** Adoptium 下载（可选能力：本机没装对应 JDK 时才需要） */
export async function downloadJava(major: number): Promise<JavaRuntime> {
  const archMap: Record<string, string> = { arm64: 'aarch64', x64: 'x64', arm: 'arm' };
  const osMap: Record<string, string> = { linux: 'linux', darwin: 'mac', win32: 'windows' };
  const arch = archMap[process.arch] ?? 'x64';
  const osName = osMap[process.platform] ?? 'linux';
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${osName}/${arch}/jdk/hotspot/normal/eclipse`;
  fs.mkdirSync(JDK_DIR, { recursive: true });
  const windows = process.platform === 'win32';
  const target = path.join(JDK_DIR, `temurin-${major}.${windows ? 'zip' : 'tar.gz'}`);
  logger.info(`下载 JDK ${major}`, { url });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`下载 JDK 失败：HTTP ${res.status}`);
  const fileStream = fs.createWriteStream(target);
  await new Promise<void>((resolve, reject) => {
    const reader = res.body!.getReader();
    const pump = (): void => {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            fileStream.end();
            resolve();
            return;
          }
          fileStream.write(Buffer.from(value), (err) => (err ? reject(err) : pump()));
        })
        .catch(reject);
    };
    pump();
  });
  if (windows) {
    const quote = (value: string) => value.replaceAll("'", "''");
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${quote(target)}' -DestinationPath '${quote(JDK_DIR)}' -Force`], { stdio: 'ignore' });
  } else {
    execFileSync('tar', ['xzf', target, '-C', JDK_DIR]);
  }
  fs.unlinkSync(target);
  const extracted = fs.readdirSync(JDK_DIR).find((d) => d.startsWith('jdk-'));
  if (!extracted) throw new Error('JDK 解压后没有找到目录');
  cache = null;
  const rt = probeJava(path.join(JDK_DIR, extracted, 'bin', javaFileName()));
  if (!rt) throw new Error('下载的 JDK 无法执行');
  logger.info(`JDK ${major} 已就绪`, { path: rt.path });
  return rt;
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
