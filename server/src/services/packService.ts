import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { instanceServerDir, STORE_DIR } from '../core/paths.ts';
import { atomicWriteFileSync } from '../core/fsx.ts';
import { bad } from '../core/errors.ts';
import { createLogger } from '../core/logger.ts';
import { loadConfig } from '../config.ts';
import * as I from './instanceService.ts';
import { curseForgeClientOnlyReason, fabricClientOnlyReason, forgeClientOnlyReason, parseFabricModJson } from './serverModPolicy.ts';

const logger = createLogger('pack');

type ZipEntry = yauzl.Entry;

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error('无法读取压缩包'));
      else resolve(zip);
    });
  });
}

/** 遍历中央目录，收集条目名（不读内容） */
export function listZipEntries(file: string): Promise<string[]> {
  return openZip(file).then(
    (zip) =>
      new Promise<string[]>((resolve, reject) => {
        const names: string[] = [];
        zip.on('entry', (entry: ZipEntry) => {
          names.push(entry.fileName);
          zip.readEntry();
        });
        zip.on('end', () => {
          zip.close();
          resolve(names);
        });
        zip.on('error', reject);
        zip.readEntry();
      }),
  );
}

function readEntry(zip: yauzl.ZipFile, entry: ZipEntry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('读取条目失败'));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

/** Read a few metadata files while traversing one archive central directory only once. */
async function readZipBufferEntries(zip: yauzl.ZipFile, selectedNames: Set<string>): Promise<{ names: Set<string>; contents: Map<string, Buffer> }> {
  const entries = new Map<string, ZipEntry>();
  const names = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const onEntry = (entry: ZipEntry) => {
      names.add(entry.fileName);
      if (selectedNames.has(entry.fileName)) entries.set(entry.fileName, entry);
      zip.readEntry();
    };
    const onEnd = () => {
      zip.removeListener('entry', onEntry);
      zip.removeListener('error', onError);
      resolve();
    };
    const onError = (err: Error) => {
      zip.removeListener('entry', onEntry);
      zip.removeListener('end', onEnd);
      reject(err);
    };
    zip.on('entry', onEntry);
    zip.on('end', onEnd);
    zip.on('error', onError);
    zip.readEntry();
  });
  const contents = new Map<string, Buffer>();
  for (const [name, entry] of entries) contents.set(name, await readEntry(zip, entry));
  return { names, contents };
}

async function readSelectedZipEntries(file: string, selectedNames: Set<string>): Promise<{ names: Set<string>; contents: Map<string, Buffer> }> {
  const zip = await openZip(file);
  try {
    return await readZipBufferEntries(zip, selectedNames);
  } finally {
    zip.close();
  }
}

async function readSelectedZipBufferEntries(bytes: Buffer, selectedNames: Set<string>): Promise<{ names: Set<string>; contents: Map<string, Buffer> }> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: false }, (err, value) => {
      if (err || !value) reject(err ?? new Error('Invalid nested JAR'));
      else resolve(value);
    });
  });
  try {
    return await readZipBufferEntries(zip, selectedNames);
  } finally {
    zip.close();
  }
}

function readQuiltModMetadata(text: string): { ids: string[]; dependencies: string[]; nestedPaths: string[] } {
  const root = JSON.parse(text) as {
    quilt_loader?: {
      id?: string;
      provides?: (string | { id?: string })[];
      depends?: (string | { id?: string; optional?: boolean })[];
      jars?: (string | { file?: string })[];
    };
  };
  const loader = root.quilt_loader ?? {};
  const ids = [loader.id, ...(loader.provides ?? []).map((entry) => typeof entry === 'string' ? entry : entry.id)]
    .filter((id): id is string => Boolean(id)).map((id) => id.toLowerCase());
  const dependencies = (loader.depends ?? []).filter((entry) => typeof entry === 'string' || !entry.optional)
    .map((entry) => typeof entry === 'string' ? entry : entry.id)
    .filter((id): id is string => Boolean(id)).map((id) => id.toLowerCase());
  const nestedPaths = (loader.jars ?? []).map((entry) => typeof entry === 'string' ? entry : entry.file)
    .filter((file): file is string => Boolean(file));
  return { ids, dependencies, nestedPaths };
}

async function readNestedJarModMetadata(bytes: Buffer, loader: string | null): Promise<{ ids: string[]; dependencies: string[] }> {
  const ids = new Set<string>();
  const dependencies = new Set<string>();
  const pending: { bytes: Buffer; depth: number }[] = [{ bytes, depth: 0 }];
  let scanned = 0;
  const loaderName = loader?.toLowerCase();
  const forgeNames = loaderName === 'neoforge'
    ? new Set(['META-INF/neoforge.mods.toml'])
    : loaderName === 'forge'
      ? new Set(['META-INF/mods.toml'])
      : new Set(['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']);

  // Fabric libraries often embed Polymer and similar modules several jars deep.
  // Follow only paths declared by Fabric or Jar-in-Jar metadata and cap traversal.
  while (pending.length && scanned < 256) {
    const current = pending.shift()!;
    if (current.depth > 8) continue;
    scanned++;
    const selected = new Set([...forgeNames, 'fabric.mod.json', 'quilt.mod.json', 'META-INF/jarjar/metadata.json']);
    const { names, contents } = await readSelectedZipBufferEntries(current.bytes, selected);
    const nestedPaths = new Set<string>();
    for (const name of forgeNames) {
      const text = contents.get(name)?.toString('utf8');
      if (text) {
        declaredForgeModIds(text).forEach((id) => ids.add(id));
        requiredForgeDependencies(text).forEach((id) => dependencies.add(id));
      }
    }
    if ((loaderName === 'fabric' || loaderName === 'quilt' || loaderName === 'forge' || loaderName === 'neoforge' || !loaderName) && contents.has('fabric.mod.json')) {
      try {
        const metadata = parseFabricModJson(contents.get('fabric.mod.json')!.toString('utf8')) as {
          id?: string;
          provides?: string[];
          depends?: Record<string, unknown>;
          jars?: { file?: string }[];
        };
        if (metadata.id) ids.add(metadata.id.toLowerCase());
        (metadata.provides ?? []).forEach((id) => ids.add(id.toLowerCase()));
        Object.keys(metadata.depends ?? {}).forEach((id) => dependencies.add(id.toLowerCase()));
        (metadata.jars ?? []).forEach((jar) => { if (jar.file) nestedPaths.add(jar.file); });
      } catch {
        /* skip malformed nested metadata */
      }
    }
    if (loaderName === 'quilt' && contents.has('quilt.mod.json')) {
      try {
        const metadata = readQuiltModMetadata(contents.get('quilt.mod.json')!.toString('utf8'));
        metadata.ids.forEach((id) => ids.add(id));
        metadata.dependencies.forEach((id) => dependencies.add(id));
        metadata.nestedPaths.forEach((file) => nestedPaths.add(file));
      } catch {
        /* skip malformed Quilt metadata */
      }
    }
    if (contents.has('META-INF/jarjar/metadata.json')) {
      try {
        const metadata = JSON.parse(contents.get('META-INF/jarjar/metadata.json')!.toString('utf8')) as {
          jars?: { identifier?: { group?: string; artifact?: string }; path?: string }[];
        };
        for (const jar of metadata.jars ?? []) {
          const group = jar.identifier?.group?.split('.').at(-1);
          const artifact = jar.identifier?.artifact;
          if (group) ids.add(normalizeModId(group));
          if (artifact) ids.add(normalizeModId(artifact));
          if (jar.path) nestedPaths.add(jar.path);
        }
      } catch {
        /* skip malformed Jar-in-Jar metadata */
      }
    }
    const existingNestedPaths = new Set([...nestedPaths].filter((name) => names.has(name)));
    if (existingNestedPaths.size) {
      const children = await readSelectedZipBufferEntries(current.bytes, existingNestedPaths);
      for (const [name, child] of children.contents) {
        if (name.toLowerCase().endsWith('.jar')) pending.push({ bytes: child, depth: current.depth + 1 });
      }
    }
  }
  return { ids: [...ids], dependencies: [...dependencies] };
}

type PackZipKind = 'resourcepack' | 'datapack' | 'combined' | 'shaderpack' | null;

/** CurseForge .zip files may be datapacks as well as resource packs. */
export async function classifyPackZip(file: string): Promise<PackZipKind> {
  const names = await listZipEntries(file);
  const normalized = names.map((name) => name.replaceAll('\\', '/').replace(/^\.\//, ''));
  for (const metadata of normalized.filter((name) => /(^|\/)pack\.mcmeta$/i.test(name))) {
    const root = path.posix.dirname(metadata);
    const prefix = root === '.' ? '' : `${root}/`;
    const hasData = normalized.some((name) => name.startsWith(`${prefix}data/`));
    const hasAssets = normalized.some((name) => name.startsWith(`${prefix}assets/`));
    if (hasData && hasAssets) return 'combined';
    if (hasData) return 'datapack';
    if (hasAssets) return 'resourcepack';
  }
  // CurseForge manifests frequently include shader packs as ZIP files. They
  // are client assets, so preserve them outside the server resource/data pack
  // folders instead of reporting the whole import as incomplete.
  if (normalized.some((name) => /(^|\/)shaders\//i.test(name))) return 'shaderpack';
  return null;
}

export async function installClassifiedPackZip(
  source: string,
  fileName: string,
  resourcePacksDir: string,
  dataPacksDir: string,
  shaderPacksDir = path.join(path.dirname(resourcePacksDir), 'client-files', 'shaderpacks'),
): Promise<PackZipKind> {
  const kind = await classifyPackZip(source);
  if (!kind) return null;
  const safeName = path.basename(fileName);
  const targets: string[] = [];
  if (kind === 'resourcepack' || kind === 'combined') targets.push(path.join(resourcePacksDir, safeName));
  if (kind === 'datapack' || kind === 'combined') targets.push(path.join(dataPacksDir, safeName));
  if (kind === 'shaderpack') targets.push(path.join(shaderPacksDir, safeName));
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (path.resolve(source) === path.resolve(target) || fs.existsSync(target)) continue;
    if (kind === 'combined') fs.copyFileSync(source, target);
    else fs.renameSync(source, target);
  }
  if (!targets.some((target) => path.resolve(source) === path.resolve(target))) fs.rmSync(source, { force: true });
  return kind;
}

export interface PackInspection {
  format: 'curseforge' | 'modrinth' | 'hmcl' | 'raw' | 'serverdir' | 'multimc' | 'unknown';
  mc: string | null;
  loader: string | null;
  loaderVersion: string | null;
  packName: string | null;
  recommendedRamMb: number | null;
  modsInZip: number;
  filesToDownload: number;
  optionalFiles: number;
  needManual: string[];
  note: string;
}

const MC_VERSION_RE = /^(1\.\d+(\.\d+)?|\d{2}\.\d+(\.\d+)?)$/;

/** 识别整合包格式（只读中央目录 + 少量小文件） */
export async function inspectPack(file: string): Promise<PackInspection> {
  const names = await listZipEntries(file);
  const has = (re: RegExp) => names.some((n) => re.test(n));
  const zip = await openZip(file);
  const readSmall = async (target: string): Promise<Buffer | null> =>
    new Promise((resolve) => {
      let found = false;
      const onEntry = (entry: ZipEntry) => {
        if (entry.fileName === target) {
          found = true;
          readEntry(zip, entry).then(
            (buf) => {
              resolve(buf);
            },
            () => resolve(null),
          );
          return;
        }
        if (!found) zip.readEntry();
      };
      zip.on('entry', onEntry);
      zip.on('end', () => {
        if (!found) resolve(null);
      });
      zip.readEntry();
    });

  const out: PackInspection = {
    format: 'unknown',
    mc: null,
    loader: null,
    loaderVersion: null,
    packName: null,
    recommendedRamMb: null,
    modsInZip: names.filter((n) => /\.jar$/i.test(n)).length,
    filesToDownload: 0,
    optionalFiles: 0,
    needManual: [],
    note: '',
  };

  if (has(/(^|\/)manifest\.json$/)) {
    out.format = 'curseforge';
    const buf = await readSmall(names.find((n) => /(^|\/)manifest\.json$/.test(n))!);
    if (buf) {
      try {
        const manifest = JSON.parse(buf.toString('utf8')) as {
          name?: string;
          minecraft?: { version?: string; recommendedRam?: number; modLoaders?: { id?: string; primary?: boolean }[] };
          files?: { projectID: number; fileID: number; required?: boolean }[];
        };
        out.packName = manifest.name ?? null;
        out.mc = manifest.minecraft?.version ?? null;
        const recommendedRam = manifest.minecraft?.recommendedRam;
        out.recommendedRamMb = Number.isInteger(recommendedRam) && recommendedRam! >= 1024 && recommendedRam! <= 65536
          ? recommendedRam!
          : null;
        const primary = manifest.minecraft?.modLoaders?.find((l) => l.primary) ?? manifest.minecraft?.modLoaders?.[0];
        if (primary?.id) {
          const [loader, ...rest] = primary.id.split('-');
          out.loader = loader === 'neoforge' ? 'neoforge' : loader;
          out.loaderVersion = rest.join('-');
        }
        out.filesToDownload = manifest.files?.filter((entry) => entry.required !== false).length ?? 0;
        out.optionalFiles = manifest.files?.filter((entry) => entry.required === false).length ?? 0;
        out.note = 'CurseForge 格式：需要配置 API Key 才能自动下载 MOD 与必需依赖。';
      } catch {
        out.note = 'manifest.json 解析失败';
      }
    }
  } else if (has(/(^|\/)modrinth\.index\.json$/)) {
    out.format = 'modrinth';
    const buf = await readSmall(names.find((n) => /modrinth\.index\.json$/.test(n))!);
    if (buf) {
      try {
        const idx = JSON.parse(buf.toString('utf8')) as {
          name?: string;
          dependencies?: Record<string, string>;
          files?: { path: string; downloads: string[]; hashes?: { sha1?: string } }[];
        };
        out.packName = idx.name ?? null;
        out.mc = idx.dependencies?.minecraft ?? null;
        const fabricVersion = idx.dependencies?.fabricLoader ?? idx.dependencies?.['fabric-loader'];
        const quiltVersion = idx.dependencies?.quiltLoader ?? idx.dependencies?.['quilt-loader'];
        out.loader = fabricVersion ? 'fabric' : quiltVersion ? 'quilt' : idx.dependencies?.forge ? 'forge' : idx.dependencies?.neoforge ? 'neoforge' : null;
        out.loaderVersion = fabricVersion ?? quiltVersion ?? idx.dependencies?.forge ?? idx.dependencies?.neoforge ?? null;
        out.filesToDownload = idx.files?.length ?? 0;
        out.note = 'Modrinth 格式：下载直链在 cdn.modrinth.com（部分网络不通），失败的文件会列成人工清单';
      } catch {
        out.note = 'modrinth.index.json 解析失败';
      }
    }
  } else if (has(/(^|\/)instance\.cfg$/)) {
    out.format = 'multimc';
    out.note = 'MultiMC 实例导出：只取 mods 与配置';
  } else if (has(/(^|\/)minecraftinstance\.json$/)) {
    out.format = 'curseforge';
    out.note = 'CurseForge 客户端实例导出';
  } else if (has(/(^|\/)modpack\.json$/)) {
    out.format = 'hmcl';
    out.note = 'HMCL 整合包：jar 通常在包里，直接安装';
  } else if (has(/(^|\/)mods\/.*\.jar$/i) || has(/(^|\/)config\//)) {
    out.format = has(/(^|\/)server\.properties$/) ? 'serverdir' : 'raw';
    out.note = '包内直接带文件：不需要联网，最可靠';
  } else {
    out.note = '无法识别这个压缩包的格式；如果是 .mrpack 请直接上传（它本身就是 zip）';
  }
  try {
    zip.close();
  } catch {
    /* ignore */
  }
  return out;
}

export interface PackRuntimeSelection {
  mc: string;
  loader: string;
  loaderVersion: string;
}

/** The archive manifest is authoritative when it declares a runtime. */
export function validatePackRuntimeSelection(info: PackInspection, requested: PackRuntimeSelection): PackRuntimeSelection {
  const mismatches: string[] = [];
  if (info.mc && requested.mc !== info.mc) mismatches.push(`Minecraft ${info.mc}`);
  if (info.loader && requested.loader.toLowerCase() !== info.loader.toLowerCase()) mismatches.push(info.loader);
  if (info.loaderVersion && requested.loaderVersion !== info.loaderVersion) mismatches.push(`${info.loader} ${info.loaderVersion}`);
  if (mismatches.length) {
    throw bad(`整合包清单要求 ${mismatches.join(' / ')}；请使用解析出的 Minecraft 与加载器版本重新导入。 / The pack manifest requires ${mismatches.join(' / ')}. Use the detected Minecraft and loader versions and import again.`);
  }
  const resolved = {
    mc: info.mc ?? requested.mc,
    loader: info.loader ?? requested.loader,
    loaderVersion: info.loaderVersion ?? requested.loaderVersion,
  };
  const needsLoaderVersion = resolved.loader !== 'vanilla';
  if (!resolved.mc || !resolved.loader || (needsLoaderVersion && !resolved.loaderVersion)) {
    throw bad('无法从整合包识别 Minecraft、加载器或加载器版本，请检查压缩包清单。 / Could not determine the Minecraft version, loader, or loader version from this pack. Check its manifest.');
  }
  return resolved;
}

/** Modrinth pack files explicitly declare whether they are supported on a server. */
export function isModrinthServerModFile(file: { path?: string; env?: { server?: string } }): boolean {
  return Boolean(file.path?.toLowerCase().startsWith('mods/')) && file.env?.server?.toLowerCase() !== 'unsupported';
}

/** 把 zip 里某个前缀下的内容解压到目标目录（剥掉一层根目录） */
async function extractTree(
  file: string,
  entries: string[],
  targetRoot: string,
  opts: { prefixes: RegExp; stripPrefix?: string; stripChildPrefix?: string; onLog: (s: string) => void; signal?: AbortSignal },
): Promise<number> {
  opts.signal?.throwIfAborted();
  const zip = await openZip(file);
  let count = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let activeStream: Readable | null = null;
    let activeOutput: fs.WriteStream | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      try { zip.close(); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      const reason = opts.signal?.reason;
      const error = reason instanceof Error ? reason : new Error('整合包导入已取消');
      activeStream?.destroy(error);
      activeOutput?.destroy(error);
      finish(error);
    };
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    zip.on('entry', (entry: ZipEntry) => {
      if (settled) return;
      const name = entry.fileName;
      if (name.endsWith('/') || !opts.prefixes.test(name)) {
        zip.readEntry();
        return;
      }
      const unixMode = ((entry as ZipEntry & { externalFileAttributes?: number }).externalFileAttributes ?? 0) >>> 16;
      if ((unixMode & 0xf000) === 0xa000) {
        zip.readEntry();
        return;
      }
      const stripped = name.replace(/^\.?\/?(\.minecraft|minecraft)\//i, '');
      let rel = opts.stripPrefix && stripped.startsWith(opts.stripPrefix) ? stripped.slice(opts.stripPrefix.length) : stripped;
      if (opts.stripChildPrefix && rel.startsWith(opts.stripChildPrefix)) rel = rel.slice(opts.stripChildPrefix.length);
      const portableRel = rel.replaceAll('\\', '/');
      if (!portableRel || portableRel.startsWith('/') || /^[A-Za-z]:/.test(portableRel) || portableRel.split('/').some((part) => !part || part === '.' || part === '..')) {
        zip.readEntry();
        return;
      }
      const dest = path.resolve(targetRoot, ...portableRel.split('/'));
      const relative = path.relative(path.resolve(targetRoot), dest);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (settled) {
          (stream as Readable | undefined)?.destroy();
          return;
        }
        if (err || !stream) {
          finish(err ?? new Error(`无法读取压缩包条目：${name}`));
          return;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const out = fs.createWriteStream(dest);
        const readable = stream as Readable;
        activeStream = readable;
        activeOutput = out;
        void pipeline(readable, out, { signal: opts.signal }).then(() => {
          activeStream = null;
          activeOutput = null;
          if (settled) return;
          count++;
          zip.readEntry();
        }).catch((pipelineError: unknown) => {
          if (!settled) finish(pipelineError instanceof Error ? pipelineError : new Error(String(pipelineError)));
        });
      });
    });
    zip.on('end', () => {
      finish();
    });
    zip.on('error', (error: Error) => finish(error));
    zip.readEntry();
  });
  return count;
}

export async function downloadWithFallback(
  urls: string[],
  dest: string,
  onLog: (s: string) => void,
  idleTimeoutMs = 45_000,
  signal?: AbortSignal,
): Promise<boolean> {
  for (const url of urls) {
    signal?.throwIfAborted();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal?.throwIfAborted();
      let retryable = true;
      const tmp = `${dest}.part`;
      const controller = new AbortController();
      const onCancel = () => controller.abort(signal?.reason ?? new Error('整合包导入已取消'));
      signal?.addEventListener('abort', onCancel, { once: true });
      if (signal?.aborted) onCancel();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const resetIdleTimeout = () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(new Error(`download idle for ${idleTimeoutMs}ms`)), idleTimeoutMs);
        timeout.unref?.();
      };
      try {
        resetIdleTimeout();
        const res = await fetch(url, {
          redirect: 'follow',
          headers: { 'user-agent': 'BlockCraft/2.0' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          retryable = res.status === 429 || res.status >= 500;
          throw new Error(`HTTP ${res.status}`);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const body = Readable.fromWeb(res.body as never);
        body.on('data', resetIdleTimeout);
        await pipeline(body, fs.createWriteStream(tmp), { signal: controller.signal });
        if (fs.statSync(tmp).size === 0) throw new Error('0 字节');
        fs.renameSync(tmp, dest);
        return true;
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        if (signal?.aborted) throw signal.reason ?? err;
        if (retryable && attempt < 2) {
          onLog(`  下载暂时失败，${attempt + 1}/2 次重试：${String(err).slice(0, 100)}`);
          await new Promise((resolve) => setTimeout(resolve, 700 * 2 ** attempt));
          continue;
        }
        onLog(`  下载失败（${url}）：${String(err).slice(0, 120)}`);
        break;
      } finally {
        signal?.removeEventListener('abort', onCancel);
        if (timeout) clearTimeout(timeout);
      }
    }
  }
  return false;
}

type CurseForgeDependency = { modId?: number; relationType?: number };
type CurseForgeFile = {
  id?: number;
  modId?: number;
  projectId?: number;
  fileName?: string;
  fileDate?: string;
  releaseType?: number;
  modLoaderType?: number;
  gameVersions?: string[];
  downloadUrl?: string | null;
  dependencies?: CurseForgeDependency[];
};
type CurseForgeFileIndex = {
  gameVersion?: string;
  fileId?: number;
  filename?: string;
  releaseType?: number;
  modLoader?: number;
  downloadUrl?: string | null;
};
type CurseForgeMod = {
  id?: number;
  name?: string;
  slug?: string;
  links?: { websiteUrl?: string };
  latestFilesIndexes?: CurseForgeFileIndex[];
};

type CurseForgeDependencyMatch = { index: CurseForgeFileIndex; projectId: number };
type CurseForgeDependencySource = { jarPath: string; fileName: string };

const CURSEFORGE_LOADER_TYPES: Record<string, number> = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
};

// Some CurseForge authors publish each loader as a separate project. Required
// relations may still point at the Fabric project even in a Forge modpack, so
// use only known same-mod ports when the original project has no matching file.
const CURSEFORGE_LOADER_ALIASES: Record<number, Partial<Record<string, number>>> = {
  328085: { fabric: 624165 }, // Create (Forge) -> Create Fabric
  306612: { forge: 889079, neoforge: 889079 }, // Fabric API -> Forgified Fabric API
  978786: { forge: 979761, neoforge: 979761 }, // Storage Delight (Fabric) -> Forge/NeoForge
  527023: { forge: 570544, neoforge: 570544 }, // Eating Animation [Fabric] -> Neo/Forge
  993166: { forge: 398521 }, // Farmer's Delight Refabricated -> Farmer's Delight (Forge)
};

// CurseForge relation metadata is not always loader-specific. These project IDs
// have well-known runtime mod IDs that can be checked against the actual jar.
const CURSEFORGE_DEPENDENCY_MOD_IDS: Record<number, string[]> = {
  306612: ['fabric_api', 'fabric-api'],
  547434: ['forgeconfigapiport'],
  351264: ['kotlinforforge'],
};

const CURSEFORGE_RUNTIME_MOD_PROJECTS: Record<string, number[]> = {
  kotlinforforge: [351264],
};

/** Find required projects referenced by files that CurseForge marks server-compatible. */
export function requiredCurseForgeDependencyProjects(files: CurseForgeFile[]): Set<number> {
  const required = new Set<number>();
  for (const file of files) {
    const fileName = file.fileName ?? '';
    if (!/\.jar$/i.test(fileName) || curseForgeClientOnlyReason(file)) continue;
    for (const dependency of file.dependencies ?? []) {
      if (dependency.relationType === 3 && Number.isInteger(dependency.modId)) required.add(dependency.modId!);
    }
  }
  return required;
}

/** A server-required library must not be dropped just because its CurseForge tags omit Server. */
export function curseForgeClientSkipReason(file: CurseForgeFile, serverRequiredProjects: Set<number>): string | null {
  const projectId = file.projectId ?? file.modId;
  if (Number.isInteger(projectId) && serverRequiredProjects.has(projectId!)) return null;
  return curseForgeClientOnlyReason(file);
}

function requiredForgeDependencies(toml: string): Set<string> {
  const required = new Set<string>();
  let block: string[] | null = null;
  const collect = () => {
    if (!block) return;
    const text = block.join('\n');
    const mandatory = /\bmandatory\s*=\s*true\b/i.test(text) || /\btype\s*=\s*["']required["']/i.test(text);
    const side = text.match(/\bside\s*=\s*["']([^"']+)["']/i)?.[1]?.toUpperCase();
    const id = text.match(/^\s*modId\s*=\s*["']([^"']+)["']/im)?.[1]?.toLowerCase();
    if (mandatory && side !== 'CLIENT' && id) required.add(id);
  };
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[\[dependencies\.[^\]]+\]\]\s*$/.test(line)) {
      collect();
      block = [];
    } else if (/^\s*\[/.test(line)) {
      collect();
      block = null;
    } else if (block) {
      block.push(line);
    }
  }
  collect();
  return required;
}

function declaredForgeModIds(toml: string): Set<string> {
  const ids = new Set<string>();
  let inModBlock = false;
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[\[/.test(line)) inModBlock = /^\s*\[\[mods\]\]/i.test(line);
    else if (/^\s*\[/.test(line)) inModBlock = false;
    if (!inModBlock) continue;
    const id = line.match(/^\s*modId\s*=\s*["']([^"']+)["']/i)?.[1];
    if (id) ids.add(id.toLowerCase());
  }
  return ids;
}

type TopLevelJarMetadata = { size: number; mtimeMs: number; ids: string[]; dependencies: string[]; clientReason: string | null };
const topLevelJarMetadataCache = new Map<string, TopLevelJarMetadata>();

async function readTopLevelJarDependencyInfo(jarPath: string, loader: string | null): Promise<{ ids: Set<string>; dependencies: Set<string>; clientReason: string | null }> {
  const stat = fs.statSync(jarPath);
  const loaderName = loader?.toLowerCase();
  const cacheKey = `${path.resolve(jarPath)}::${loaderName ?? ''}`;
  const cached = topLevelJarMetadataCache.get(cacheKey);
  if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return { ids: new Set(cached.ids), dependencies: new Set(cached.dependencies), clientReason: cached.clientReason };
  }
  const forgeNames = loaderName === 'neoforge'
    ? new Set(['META-INF/neoforge.mods.toml'])
    : loaderName === 'forge'
      ? new Set(['META-INF/mods.toml'])
      : new Set(['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']);
  const metadataFiles = new Set([...forgeNames, 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'fabric.mod.json', 'quilt.mod.json']);
  const selected = new Set([...metadataFiles]);
  const { contents } = await readSelectedZipEntries(jarPath, selected);
  const ids = new Set<string>();
  const dependencies = new Set<string>();
  const tomlNames = loaderName === 'fabric' || loaderName === 'quilt'
    ? []
    : [...forgeNames].filter((name) => contents.has(name));
  for (const name of tomlNames) {
    const metadata = contents.get(name)!.toString('utf8');
    declaredForgeModIds(metadata).forEach((id) => ids.add(id));
    requiredForgeDependencies(metadata).forEach((id) => dependencies.add(id));
  }
  const connectorPresent = fs.readdirSync(path.dirname(jarPath), { withFileTypes: true })
    .some((entry) => entry.isFile() && /^connector(?:[-_.+]|$)/i.test(entry.name) && /.jar$/i.test(entry.name));
  const fabricActive = loaderName === 'fabric' || loaderName === 'quilt' ||
    ((connectorPresent || !loaderName) && !tomlNames.length);
  const availableMetadataNames = [...metadataFiles].filter((name) => contents.has(name));
  const preferredMetadata = loaderName === 'fabric' || loaderName === 'quilt'
    ? 'fabric.mod.json'
    : loaderName === 'neoforge'
      ? 'META-INF/neoforge.mods.toml'
      : loaderName === 'forge'
        ? 'META-INF/mods.toml'
        : undefined;
  const clientMetadataNames = preferredMetadata && availableMetadataNames.includes(preferredMetadata)
    ? [preferredMetadata]
    : availableMetadataNames;
  let clientReason: string | null = null;
  for (const name of clientMetadataNames) {
    const text = contents.get(name)!.toString('utf8');
    const reason = name === 'fabric.mod.json' ? fabricClientOnlyReason(text) : forgeClientOnlyReason(text);
    if (reason) { clientReason = reason; break; }
  }
  if (fabricActive && contents.has('fabric.mod.json')) {
    try {
      const metadata = parseFabricModJson(contents.get('fabric.mod.json')!.toString('utf8')) as {
        id?: string;
        provides?: string[];
        depends?: Record<string, unknown>;
      };
      if (metadata.id) ids.add(metadata.id.toLowerCase());
      (metadata.provides ?? []).forEach((id) => ids.add(id.toLowerCase()));
      Object.keys(metadata.depends ?? {}).forEach((id) => dependencies.add(id.toLowerCase()));
    } catch {
      /* leave malformed metadata for the loader to diagnose */
    }
  }
  if (loaderName === 'quilt' && contents.has('quilt.mod.json')) {
    try {
      const metadata = readQuiltModMetadata(contents.get('quilt.mod.json')!.toString('utf8'));
      metadata.ids.forEach((id) => ids.add(id));
      metadata.dependencies.forEach((id) => dependencies.add(id));
    } catch {
      /* leave malformed Quilt metadata for Quilt Loader to diagnose */
    }
  }
  const result = { size: stat.size, mtimeMs: stat.mtimeMs, ids: [...ids], dependencies: [...dependencies], clientReason };
  topLevelJarMetadataCache.set(cacheKey, result);
  return { ids, dependencies, clientReason };
}

/** Check active server-side manifests in installed jars, including embedded Jar-in-Jar libraries. */
export async function missingRequiredModDependencies(modsDir: string, loader: string | null): Promise<string[]> {
  if (!fs.existsSync(modsDir)) return [];
  const jarFiles = fs.readdirSync(modsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.jar$/i.test(entry.name))
    .map((entry) => path.join(modsDir, entry.name));
  const loaderName = loader?.toLowerCase();
  const connectorPresent = jarFiles.some((file) => /(^|[-_.])connector(?:[-_.+]|$)/i.test(path.basename(file)));
  const installedIds = new Set<string>();
  const embeddedArtifacts: string[] = [];
  const requiredIds = new Set<string>();
  const coreIds = new Set(['minecraft', 'forge', 'neoforge', 'java', 'fabricloader', 'quiltloader']);

  const scanJar = async (file: string) => {
    const stat = fs.statSync(file);
    const fileKey = `${path.resolve(file)}::${loaderName ?? ''}`;
    const cached = jarDependencyMetadataCache.get(fileKey);
    if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      cached.installed.forEach((id) => installedIds.add(id));
      cached.required.forEach((id) => requiredIds.add(id));
      embeddedArtifacts.push(...cached.embedded);
      return;
    }
    const localInstalled = new Set<string>();
    const localRequired = new Set<string>();
    const localEmbedded: string[] = [];
    const forgeNames = loaderName === 'neoforge'
      ? new Set(['META-INF/neoforge.mods.toml'])
      : loaderName === 'forge'
        ? new Set(['META-INF/mods.toml'])
        : new Set(['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']);
    const selected = new Set([...forgeNames, 'fabric.mod.json', 'quilt.mod.json', 'META-INF/jarjar/metadata.json']);
    let contents: Map<string, Buffer>;
    let archiveNames: Set<string>;
    try {
      ({ contents, names: archiveNames } = await readSelectedZipEntries(file, selected));
    } catch {
      return;
    }
    const tomlNames = loaderName === 'fabric' || loaderName === 'quilt'
      ? []
      : [...forgeNames].filter((name) => contents.has(name));
    const fabricActive = loaderName === 'fabric' || loaderName === 'quilt' ||
      (connectorPresent && !tomlNames.length) || !loaderName;
    const nestedPaths = new Set([...archiveNames].filter((name) => /^META-INF\/jarjar\/.+\.jar$/i.test(name)));

    for (const name of tomlNames) {
      const metadata = contents.get(name)!.toString('utf8');
      for (const id of declaredForgeModIds(metadata)) localInstalled.add(id);
      for (const id of requiredForgeDependencies(metadata)) localRequired.add(id);
    }
    if (fabricActive && contents.has('fabric.mod.json')) {
      try {
        const metadata = parseFabricModJson(contents.get('fabric.mod.json')!.toString('utf8')) as {
          id?: string;
          depends?: Record<string, unknown>;
          provides?: string[];
          jars?: { file?: string }[];
        };
        if (metadata.id) localInstalled.add(metadata.id.toLowerCase());
        for (const id of metadata.provides ?? []) localInstalled.add(id.toLowerCase());
        for (const nested of metadata.jars ?? []) {
          const base = path.posix.basename(nested.file ?? '');
          const id = base.match(/^(.+?)-\d/)?.[1];
          if (id) localInstalled.add(id.toLowerCase());
          if (nested.file) nestedPaths.add(nested.file);
        }
        for (const id of Object.keys(metadata.depends ?? {})) localRequired.add(id.toLowerCase());
      } catch {
        /* skip malformed metadata */
      }
    }
    if (loaderName === 'quilt' && contents.has('quilt.mod.json')) {
      try {
        const metadata = readQuiltModMetadata(contents.get('quilt.mod.json')!.toString('utf8'));
        metadata.ids.forEach((id) => localInstalled.add(id));
        metadata.dependencies.forEach((id) => localRequired.add(id));
        metadata.nestedPaths.forEach((file) => nestedPaths.add(file));
      } catch {
        /* skip malformed Quilt metadata */
      }
    }
    if (contents.has('META-INF/jarjar/metadata.json')) {
      try {
        const metadata = JSON.parse(contents.get('META-INF/jarjar/metadata.json')!.toString('utf8')) as {
          jars?: { identifier?: { group?: string; artifact?: string }; path?: string }[];
        };
        for (const jar of metadata.jars ?? []) {
          const group = jar.identifier?.group?.split('.').at(-1);
          const artifact = jar.identifier?.artifact;
          if (group) localEmbedded.push(normalizeModId(group));
          if (artifact) localEmbedded.push(normalizeModId(artifact));
          if (jar.path) nestedPaths.add(jar.path);
        }
      } catch {
        /* skip malformed Jar-in-Jar metadata */
      }
    }
    if (nestedPaths.size) {
      try {
        const nestedJars = await readSelectedZipEntries(file, nestedPaths);
        for (const [name, bytes] of nestedJars.contents) {
          if (!name.toLowerCase().endsWith('.jar')) continue;
          const nested = await readNestedJarModMetadata(bytes, loader);
          nested.ids.forEach((id) => localInstalled.add(id));
          nested.dependencies.forEach((id) => localRequired.add(id));
        }
      } catch {
        /* skip malformed embedded jar metadata */
      }
    }
    const result = { size: stat.size, mtimeMs: stat.mtimeMs, installed: [...localInstalled], required: [...localRequired], embedded: localEmbedded };
    jarDependencyMetadataCache.set(fileKey, result);
    result.installed.forEach((id) => installedIds.add(id));
    result.required.forEach((id) => requiredIds.add(id));
    embeddedArtifacts.push(...result.embedded);
  };
  // Bound parallel archive reads to avoid opening hundreds of files at once.
  for (let i = 0; i < jarFiles.length; i += 8) {
    await Promise.all(jarFiles.slice(i, i + 8).map(scanJar));
  }

  return [...requiredIds]
    .filter((id) => !coreIds.has(normalizeModId(id)))
    .filter((id) => {
      const normalized = normalizeModId(id);
      return ![...installedIds].some((installed) => normalizeModId(installed) === normalized) &&
        !embeddedArtifacts.some((artifact) => artifact === normalized || artifact.startsWith(normalized));
    })
    .sort((a, b) => a.localeCompare(b));
}

function normalizeModId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const jarDependencyMetadataCache = new Map<string, { size: number; mtimeMs: number; installed: string[]; required: string[]; embedded: string[] }>();

/** Check CurseForge relations against the actual IDs declared by a mod jar. */
export async function jarDeclaresCurseForgeDependency(
  jarPath: string,
  projectId: number,
  project?: { slug?: string; name?: string },
  loader?: string | null,
): Promise<boolean | null> {
  const targetIds = CURSEFORGE_DEPENDENCY_MOD_IDS[projectId] ?? [];
  const targetIdsNormalized = new Set([
    ...targetIds,
    project?.slug ?? '',
    project?.name ?? '',
  ].filter(Boolean).map(normalizeModId));
  if (!targetIdsNormalized.size) return null;
  try {
    const metadataFiles = new Set(['META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'fabric.mod.json']);
    const { contents } = await readSelectedZipEntries(jarPath, metadataFiles);
    const availableMetadataNames = [...metadataFiles].filter((name) => contents.has(name));
    const loaderName = loader?.toLowerCase();
    const preferredMetadata = loaderName === 'fabric' || loaderName === 'quilt'
      ? 'fabric.mod.json'
      : loaderName === 'neoforge'
        ? 'META-INF/neoforge.mods.toml'
        : loaderName === 'forge'
          ? 'META-INF/mods.toml'
          : undefined;
    const metadataNames = preferredMetadata && availableMetadataNames.includes(preferredMetadata)
      ? [preferredMetadata]
      : availableMetadataNames;
    if (!metadataNames.length) return null;
    const dependencies = new Set<string>();
    for (const name of metadataNames) {
      const metadataText = contents.get(name)!.toString('utf8');
      if (name.endsWith('.toml')) {
        for (const id of requiredForgeDependencies(metadataText)) dependencies.add(id);
      } else {
        const metadata = parseFabricModJson(metadataText) as { depends?: Record<string, unknown> };
        for (const id of Object.keys(metadata.depends ?? {})) dependencies.add(id.toLowerCase());
      }
    }
    return [...dependencies].some((id) => targetIdsNormalized.has(normalizeModId(id)));
  } catch {
    return null;
  }
}

/** Detect client-only jars that CurseForge's file labels do not identify. */
async function clientOnlyJarReason(jarPath: string, loader?: string | null): Promise<string | null> {
  try {
    return (await readTopLevelJarDependencyInfo(jarPath, loader ?? null)).clientReason;
  } catch {
    // Unknown or malformed metadata is left for Forge to validate normally.
  }
  return null;
}

/** Filter client-only jars that were bundled under CurseForge overrides/mods. */
export async function filterClientOnlyMods(serverDir: string, onLog: (s: string) => void, loader?: string | null): Promise<number> {
  const modsDir = path.join(serverDir, 'mods');
  if (!fs.existsSync(modsDir)) return 0;
  const clientModsDir = path.join(serverDir, 'client-mods', 'overrides');
  let skipped = 0;
  const clientOnlyIds = new Set<string>();
  const collectJars = (directory: string): string[] => {
    if (!fs.existsSync(directory)) return [];
    const found: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) found.push(...collectJars(child));
      else if (entry.isFile() && /\.jar$/i.test(entry.name)) found.push(child);
    }
    return found;
  };
  const mapInBatches = async <T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> => {
    const results: R[] = [];
    for (let index = 0; index < items.length; index += 8) {
      results.push(...await Promise.all(items.slice(index, index + 8).map(work)));
    }
    return results;
  };
  // CurseForge client-tagged files are staged under client-mods/<fileId>/ and
  // never reach mods/. Seed their actual IDs so server jars that require them
  // are removed as an incompatible client dependency chain below.
  await mapInBatches(collectJars(path.join(serverDir, 'client-mods')), async (clientJar) => {
    try {
      const metadata = await readTopLevelJarDependencyInfo(clientJar, loader ?? null);
      metadata.ids.forEach((id) => clientOnlyIds.add(normalizeModId(id)));
    } catch {
      /* unknown client jars cannot be used to classify server dependencies */
    }
  });
  const initialJars = fs.readdirSync(modsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.jar$/i.test(entry.name))
    .map((entry) => path.join(modsDir, entry.name));
  const moveToClient = async (
    source: string,
    reason: string,
    knownMetadata?: { ids: Set<string>; dependencies: Set<string>; clientReason: string | null },
  ) => {
    const fileName = path.basename(source);
    fs.mkdirSync(clientModsDir, { recursive: true });
    let target = path.join(clientModsDir, fileName);
    if (fs.existsSync(target)) target = path.join(clientModsDir, `${Date.now()}-${fileName}`);
    fs.renameSync(source, target);
    skipped++;
    try {
      const metadata = knownMetadata ?? await readTopLevelJarDependencyInfo(target, loader ?? null);
      metadata.ids.forEach((id) => clientOnlyIds.add(normalizeModId(id)));
    } catch {
      /* client-only classification can still proceed without readable metadata */
    }
    onLog(`  ↷ ${fileName}：${reason}，从 overrides/mods/ 移出服务端 mods/`);
  };

  const initialMetadata = await mapInBatches(initialJars, async (source) => {
    try {
      return { source, metadata: await readTopLevelJarDependencyInfo(source, loader ?? null) };
    } catch {
      return { source, metadata: null };
    }
  });
  for (const { source, metadata } of initialMetadata) {
    if (metadata?.clientReason) await moveToClient(source, metadata.clientReason, metadata);
  }

  // A nominally common mod cannot load on a dedicated server when a required
  // dependency was moved out as client-only. Move the dependent jar as well,
  // then repeat so multi-step client dependency chains do not remain broken.
  let movedDependent = true;
  while (movedDependent) {
    movedDependent = false;
    const remaining = fs.readdirSync(modsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.jar$/i.test(entry.name))
      .map((entry) => path.join(modsDir, entry.name));
    const dependencyInfo = await mapInBatches(remaining, async (source) => {
      try {
        return { source, metadata: await readTopLevelJarDependencyInfo(source, loader ?? null) };
      } catch {
        return { source, metadata: null };
      }
    });
    for (const { source, metadata } of dependencyInfo) {
      if (!metadata) continue;
      const clientDependency = [...metadata.dependencies].find((id) => clientOnlyIds.has(normalizeModId(id)));
      if (!clientDependency) continue;
      const label = normalizeModId(clientDependency);
      await moveToClient(source, `必需依赖 ${label} 仅在客户端提供，服务端无法加载此模组`, metadata);
      movedDependent = true;
    }
  }
  return skipped;
}

/** Sinytra Connector allows eligible Fabric mods to load alongside Forge mods. */
export function hasFabricModBridge(modsDir: string): boolean {
  if (!fs.existsSync(modsDir)) return false;
  return fs.readdirSync(modsDir, { withFileTypes: true }).some((entry) =>
    entry.isFile() && /^connector(?:[-_.+]|$)/i.test(entry.name) && /\.jar$/i.test(entry.name),
  );
}

function compatibleCurseForgeIndex(mod: CurseForgeMod, mc: string, loaderType: number): CurseForgeFileIndex | null {
  return (mod.latestFilesIndexes ?? [])
    .filter((entry) => entry.fileId && entry.gameVersion === mc && (entry.modLoader === loaderType || entry.modLoader === 0))
    .sort((a, b) => {
      const loaderRank = (x: CurseForgeFileIndex) => x.modLoader === loaderType ? 0 : 1;
      const releaseRank = (x: CurseForgeFileIndex) => x.releaseType === 1 ? 0 : x.releaseType === 2 ? 1 : 2;
      return loaderRank(a) - loaderRank(b) || releaseRank(a) - releaseRank(b);
    })[0] ?? null;
}

async function queryCompatibleCurseForgeFile(
  projectId: number,
  api: string,
  key: string,
  mc: string,
  loaderType: number,
  signal?: AbortSignal,
): Promise<CurseForgeFileIndex | null> {
  const query = new URLSearchParams({ gameVersion: mc, modLoaderType: String(loaderType), pageSize: '50', index: '0' });
  const response = await curseForgeRequest<{ data?: CurseForgeFile[] }>(`${api}/mods/${projectId}/files?${query}`, key, { method: 'GET' }, signal);
  const files = (response.data ?? [])
    .filter((file) => file.id && file.fileName && (file.gameVersions ?? []).includes(mc) && (file.modLoaderType === loaderType || file.modLoaderType === 0))
    .sort((a, b) => {
      const releaseRank = (x: CurseForgeFile) => x.releaseType === 1 ? 0 : x.releaseType === 2 ? 1 : 2;
      return releaseRank(a) - releaseRank(b) || Date.parse(b.fileDate ?? '') - Date.parse(a.fileDate ?? '') || (b.id ?? 0) - (a.id ?? 0);
    });
  const file = files[0];
  if (!file?.id) return null;
  return {
    gameVersion: mc,
    fileId: file.id,
    filename: file.fileName,
    releaseType: file.releaseType,
    modLoader: file.modLoaderType,
    downloadUrl: file.downloadUrl,
  };
}

async function curseForgeRequest<T>(url: string, key: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  let lastError = '未知错误';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted();
    let retryable = true;
    const controller = new AbortController();
    const onCancel = () => controller.abort(signal?.reason ?? new Error('整合包导入已取消'));
    signal?.addEventListener('abort', onCancel, { once: true });
    if (signal?.aborted) onCancel();
    const timeout = setTimeout(() => controller.abort(new Error('CurseForge API 请求超时')), 30_000);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { ...(init.headers ?? {}), 'x-api-key': key, 'user-agent': 'BlockCraft/2.0' },
      });
      if (!res.ok) {
        retryable = res.status === 429 || res.status >= 500;
        lastError = `HTTP ${res.status}`;
        if (!retryable) break;
      } else {
        return await res.json() as T;
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      lastError = String(err);
    } finally {
      signal?.removeEventListener('abort', onCancel);
      clearTimeout(timeout);
    }
    if (retryable && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 700 * 2 ** attempt));
  }
  throw new Error(lastError);
}

/** Resolve one compatible CurseForge file for each required dependency project. */
async function curseForgeDependencyFiles(
  modIds: number[],
  api: string,
  key: string,
  mc: string | null,
  loader: string | null,
  sources: Map<number, CurseForgeDependencySource[]>,
  onLog: (s: string) => void,
  allowFabricBridge = false,
  signal?: AbortSignal,
): Promise<{ matches: Map<number, CurseForgeDependencyMatch>; ignored: Set<number> }> {
  const out = new Map<number, CurseForgeDependencyMatch>();
  const ignored = new Set<number>();
  if (!mc) {
    for (const id of modIds) onLog(`  无法自动选取 CurseForge 依赖 ${id}：整合包没有声明 Minecraft 版本`);
    return { matches: out, ignored };
  }
  const loaderType = loader ? CURSEFORGE_LOADER_TYPES[loader.toLowerCase()] : 0;
  if (loader && loaderType === undefined) {
    for (const id of modIds) onLog(`  无法自动选取 CurseForge 依赖 ${id}：不支持的加载器 ${loader}`);
    return { matches: out, ignored };
  }

  for (let i = 0; i < modIds.length; i += 50) {
    signal?.throwIfAborted();
    const chunk = modIds.slice(i, i + 50);
    try {
      const response = await curseForgeRequest<{ data?: CurseForgeMod[] }>(`${api}/mods`, key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modIds: chunk, filterPcOnly: true }),
      }, signal);
      const projects = new Map((response.data ?? []).filter((mod) => Number.isInteger(mod.id)).map((mod) => [mod.id!, mod]));
      const missingIndexes: { id: number; mod: CurseForgeMod }[] = [];
      for (const id of chunk) {
        const mod = projects.get(id);
        if (!mod) continue;
        const parents = sources.get(id) ?? [];
        if (parents.length) {
          const declarations = await Promise.all(parents.map((source) =>
            jarDeclaresCurseForgeDependency(source.jarPath, id, { slug: mod.slug, name: mod.name }, loader),
          ));
          if (declarations.length && declarations.every((value) => value === false)) {
            ignored.add(id);
            onLog(`  忽略「${parents.map((source) => source.fileName).join('、')}」对 CurseForge 项目 ${id}（${mod.name ?? mod.slug ?? '未知项目'}）的清单关联：JAR 元数据未声明该加载器依赖`);
            continue;
          }
        }
        const candidate = compatibleCurseForgeIndex(mod, mc, loaderType);
        if (candidate) out.set(id, { index: candidate, projectId: id });
        else missingIndexes.push({ id, mod });
      }

      // latestFilesIndexes is only a compact summary; ask the official filtered
      // files endpoint before declaring a compatible project unavailable.
      const aliasIds = [...new Set(missingIndexes.map(({ id }) => CURSEFORGE_LOADER_ALIASES[id]?.[loader?.toLowerCase() ?? '']).filter((id): id is number => Number.isInteger(id)))];
      const aliasProjects = new Map<number, CurseForgeMod>();
      if (aliasIds.length) {
        try {
          const aliasResponse = await curseForgeRequest<{ data?: CurseForgeMod[] }>(`${api}/mods`, key, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ modIds: aliasIds, filterPcOnly: true }),
          }, signal);
          for (const mod of aliasResponse.data ?? []) if (Number.isInteger(mod.id)) aliasProjects.set(mod.id!, mod);
        } catch (err) {
          if (signal?.aborted) throw signal.reason ?? err;
          onLog(`  查询加载器替代项目失败：${String(err).slice(0, 120)}`);
        }
      }

      for (const { id, mod } of missingIndexes) {
        try {
          const directFile = await queryCompatibleCurseForgeFile(id, api, key, mc, loaderType, signal);
          if (directFile) {
            out.set(id, { index: directFile, projectId: id });
            continue;
          }
        } catch (err) {
          if (signal?.aborted) throw signal.reason ?? err;
          onLog(`  查询「${mod.name ?? `项目 ${id}`}」的精确版本列表失败：${String(err).slice(0, 100)}`);
        }

        const aliasId = CURSEFORGE_LOADER_ALIASES[id]?.[loader?.toLowerCase() ?? ''];
        if (aliasId) {
          const aliasMod = aliasProjects.get(aliasId);
          let aliasFile = aliasMod ? compatibleCurseForgeIndex(aliasMod, mc, loaderType) : null;
          if (!aliasFile) {
            try {
              aliasFile = await queryCompatibleCurseForgeFile(aliasId, api, key, mc, loaderType, signal);
            } catch (err) {
              if (signal?.aborted) throw signal.reason ?? err;
              onLog(`  查询替代项目 ${aliasId} 的文件失败：${String(err).slice(0, 100)}`);
            }
          }
          if (aliasFile) {
            out.set(id, { index: aliasFile, projectId: aliasId });
            onLog(`  已将「${mod.name ?? `项目 ${id}`}」(${id}) 映射到 ${loader} 兼容项目「${aliasMod?.name ?? `项目 ${aliasId}`}」(${aliasId})`);
            continue;
          }
        }
        try {
          const alternateProjects = await findCurseForgeProjectsForModId(mod.slug ?? mod.name ?? '', api, key, signal);
          for (const alternateId of alternateProjects) {
            if (alternateId === id || alternateId === aliasId) continue;
            const alternateFile = await queryCompatibleCurseForgeFile(alternateId, api, key, mc, loaderType, signal);
            if (!alternateFile) continue;
            out.set(id, { index: alternateFile, projectId: alternateId });
            onLog(`  已将依赖项目 ${id} 映射到 ${loader} 兼容项目 ${alternateId} / Mapped dependency ${id} to loader-compatible project ${alternateId}`);
            break;
          }
          if (out.has(id)) continue;
        } catch (err) {
          if (signal?.aborted) throw signal.reason ?? err;
          onLog(`  查询 ${mod.name ?? `项目 ${id}`} 的同加载器替代项目失败：${String(err).slice(0, 100)}`);
        }
        if (allowFabricBridge && loaderType !== CURSEFORGE_LOADER_TYPES.fabric) {
          try {
            const bridgeFile = await queryCompatibleCurseForgeFile(id, api, key, mc, CURSEFORGE_LOADER_TYPES.fabric, signal);
            if (bridgeFile) {
              out.set(id, { index: bridgeFile, projectId: id });
              onLog(`  已检测到 Connector，依赖「${mod.name ?? `项目 ${id}`}」使用 Minecraft ${mc} 兼容的 Fabric 文件 / Connector is present; using the Minecraft ${mc} Fabric build for dependency ${mod.name ?? id}`);
              continue;
            }
          } catch (err) {
            if (signal?.aborted) throw signal.reason ?? err;
            onLog(`  查询 Connector 可用的 Fabric 依赖文件失败：${String(err).slice(0, 100)}`);
          }
        }
        const page = mod.links?.websiteUrl || (mod.slug ? `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}` : `CurseForge 项目 ${id}`);
        onLog(`  ${mod.name ? `「${mod.name}」` : `项目 ${id}`} 没有 ${mc} / ${loader} 兼容文件${allowFabricBridge ? '（也没有可由 Connector 加载的 Fabric 版本）' : ''}（${page}）。`);
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      onLog(`  查询 CurseForge 依赖文件失败：${String(err).slice(0, 120)}`);
    }
  }
  return { matches: out, ignored };
}

async function findCurseForgeProjectsForModId(modId: string, api: string, key: string, signal?: AbortSignal): Promise<number[]> {
  const knownProjects = CURSEFORGE_RUNTIME_MOD_PROJECTS[normalizeModId(modId)];
  if (knownProjects?.length) return knownProjects;
  const query = new URLSearchParams({ gameId: '432', classId: '6', searchFilter: modId, pageSize: '50' });
  try {
    const response = await curseForgeRequest<{ data?: CurseForgeMod[] }>(`${api}/mods/search?${query}`, key, { method: 'GET' }, signal);
    const normalized = normalizeModId(modId);
    const projects = response.data ?? [];
    const exact = projects.filter((mod) =>
      normalizeModId(mod.slug ?? '') === normalized || normalizeModId(mod.name ?? '') === normalized,
    );
    const loaderPorts = projects.filter((mod) => {
      const names = [mod.slug ?? '', mod.name ?? ''].map(normalizeModId);
      return names.some((name) => name.startsWith(normalized) &&
        /^(forge|neoforge|fabric|reforked|remastered|unofficial|backport|port)$/.test(name.slice(normalized.length)));
    });
    return [...new Set([...exact, ...loaderPorts].map((mod) => mod.id).filter((id): id is number => Number.isInteger(id)))];
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err;
    return [];
  }
}

async function installMissingJarDependencies(
  serverDir: string,
  api: string,
  key: string,
  mc: string | null,
  loader: string | null,
  onLog: (s: string) => void,
  signal?: AbortSignal,
): Promise<{ installed: number; unresolved: string[]; conflicts: string[] }> {
  const modsDir = path.join(serverDir, 'mods');
  let installed = 0;
  const conflicts: string[] = [];
  const attempted = new Set<string>();
  const limit = 32;
  for (let pass = 0; pass < limit; pass += 1) {
    signal?.throwIfAborted();
    const missing = await missingRequiredModDependencies(modsDir, loader);
    if (!missing.length) return { installed, unresolved: [], conflicts };
    let progress = false;
    for (const modId of missing) {
      signal?.throwIfAborted();
      const normalized = normalizeModId(modId);
      if (attempted.has(normalized)) continue;
      attempted.add(normalized);
      const projectIds = await findCurseForgeProjectsForModId(modId, api, key, signal);
      if (!projectIds.length || !mc || !loader) continue;
      onLog(`正在为缺少的服务端依赖 ${modId} 搜索 CurseForge 文件 / Searching CurseForge for required server dependency ${modId}`);
      const allowFabricBridge = hasFabricModBridge(modsDir);
      let match: CurseForgeDependencyMatch | undefined;
      for (const projectId of projectIds) {
        const { matches } = await curseForgeDependencyFiles([projectId], api, key, mc, loader, new Map(), onLog, allowFabricBridge, signal);
        match = matches.get(projectId);
        if (match) break;
      }
      let selectedIndex = match?.index;
      if (match && mc && loader) {
        const selectedLoader = selectedIndex?.modLoader ?? CURSEFORGE_LOADER_TYPES[loader.toLowerCase()];
        if (selectedLoader !== undefined) {
          try {
            selectedIndex = await queryCompatibleCurseForgeFile(match.projectId, api, key, mc, selectedLoader, signal) ?? selectedIndex;
          } catch (err) {
            if (signal?.aborted) throw signal.reason ?? err;
            /* keep the compatible file-index fallback if the detail request fails */
          }
        }
      }
      const fileId = selectedIndex?.fileId;
      const fileName = selectedIndex?.filename;
      if (!fileId || !fileName) continue;
      const safeName = path.basename(fileName);
      const dest = path.join(modsDir, safeName);
      if (!fs.existsSync(dest)) {
        const id = String(fileId);
      const urls = [selectedIndex?.downloadUrl ?? '', `https://edge.forgecdn.net/files/${id.slice(0, -3)}/${id.slice(-3)}/${encodeURIComponent(safeName)}`].filter(Boolean);
        if (!await downloadWithFallback(urls, dest, onLog, 45_000, signal)) continue;
      }
      const clientOnly = await clientOnlyJarReason(dest, loader);
      if (clientOnly) {
        conflicts.push(modId);
        onLog(`  依赖冲突：${safeName} 满足 ${modId}，但 JAR 元数据标记为客户端专用 / Dependency conflict: ${safeName} provides ${modId}, but its jar metadata marks it client-only`);
        continue;
      }
      installed += 1;
      progress = true;
      onLog(`  ✔ ${safeName}（自动补齐的 JAR 必需依赖 ${modId}）`);
    }
    if (!progress) break;
  }
  return { installed, unresolved: await missingRequiredModDependencies(modsDir, loader), conflicts };
}

/** 按 CurseForge 清单批量下载（一次 100 个 fileId） */
async function installCurseForge(
  file: string,
  instanceId: string,
  mc: string | null,
  loader: string | null,
  onLog: (s: string) => void,
  signal?: AbortSignal,
): Promise<{ downloaded: number; manual: string[] }> {
  signal?.throwIfAborted();
  const zip = await openZip(file);
  const names = await listZipEntries(file);
  const manifestName = names.find((n) => /(^|\/)manifest\.json$/.test(n));
  if (!manifestName) throw bad('压缩包缺少 manifest.json');
  const manifest = JSON.parse((await readEntry(zip, await findEntry(zip, manifestName))).toString('utf8')) as {
    files: { projectID: number; fileID: number; required?: boolean }[];
  };
  zip.close();
  const serverDir = instanceServerDir(instanceId);
  const levelName = path.basename(I.getConfig(instanceId).levelName || 'world');
  const resourcePacksDir = path.join(serverDir, 'resourcepacks');
  const dataPacksDir = path.join(serverDir, levelName, 'datapacks');
  const panel = loadConfig();
  const key = panel.mirrors.curseforgeApiKey;
  const api = panel.mirrors.curseforgeApi.replace(/\/$/, '');
  const manual: string[] = [];
  let downloaded = 0;
  let resourcePacksDownloaded = 0;
  let dataPacksDownloaded = 0;
  let shaderPacksDownloaded = 0;
  let clientOnlySkipped = 0;
  if (!key) {
    throw bad('导入 CurseForge 整合包需要先在设置中填写并保存 API Key / A CurseForge API Key must be saved in Settings before importing this pack.');
  }
  const requiredFiles = manifest.files.filter((entry) => entry.required !== false);
  const optionalCount = manifest.files.length - requiredFiles.length;
  if (optionalCount) onLog(`已跳过清单中 ${optionalCount} 个可选模组；默认只安装必需文件`);
  const projectIds = new Set(requiredFiles.map((f) => f.projectID));
  const projectByFile = new Map(requiredFiles.map((f) => [f.fileID, f.projectID]));
  const visitedFileIds = new Set<number>();
  const allRequiredProjectSources = new Map<number, CurseForgeDependencySource[]>();
  const pendingClientDependencyConflicts: { projectId: number; fileName: string; dest: string; clientModDest: string; reason: string }[] = [];
  let pendingFileIds = [...new Set(requiredFiles.map((f) => f.fileID))];
  let autoDependencyCount = 0;
  const maxAutoDependencies = 256;

  while (pendingFileIds.length) {
    signal?.throwIfAborted();
    const current = pendingFileIds.filter((id) => id > 0 && !visitedFileIds.has(id));
    if (!current.length) break;
    current.forEach((id) => visitedFileIds.add(id));
    const requiredProjectIds = new Set<number>();
    const requiredProjectSources = new Map<number, CurseForgeDependencySource[]>();

    const filesInfo: CurseForgeFile[] = [];
    for (let i = 0; i < current.length; i += 100) {
      const chunk = current.slice(i, i + 100);
      signal?.throwIfAborted();
      onLog(`查询 CurseForge 文件信息 ${visitedFileIds.size} 项`);
      let files: CurseForgeFile[] = [];
      try {
        const response = await curseForgeRequest<{ data?: CurseForgeFile[] }>(`${api}/mods/files`, key, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileIds: chunk }),
        }, signal);
        files = response.data ?? [];
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
        onLog(`接口查询失败，这批文件需手动处理：${String(err).slice(0, 120)}`);
        for (const id of chunk) manual.push(`CurseForge 文件 ID ${id}（文件信息查询失败）`);
        continue;
      }

      const received = new Set(files.map((entry) => entry.id).filter((id): id is number => Number.isInteger(id)));
      for (const id of chunk) {
        if (!received.has(id)) {
          manual.push(`CurseForge 文件 ID ${id}（API 未返回该文件）`);
          onLog(`  未找到清单文件 ID ${id} 的 CurseForge 文件信息`);
        }
      }
      filesInfo.push(...files);
    }

    // Collect dependencies before applying client-only tags. Some server-side
    // mods incorrectly omit the Server tag from a required library, and skipping
    // that file makes Forge refuse to start the whole world.
    const serverRequiredDependencyProjects = requiredCurseForgeDependencyProjects(filesInfo);

    for (const f of filesInfo) {
        signal?.throwIfAborted();
        if (!f.id) continue;
        const projectId = f.projectId ?? f.modId ?? projectByFile.get(f.id);
        if (projectId) projectIds.add(projectId);
        const fileName = path.basename(f.fileName || `cf-${f.id}.jar`);
        const isPackArchive = /\.zip$/i.test(fileName);
        const modsDest = path.join(serverDir, 'mods', fileName);
        const stagedArchiveDest = path.join(serverDir, '.pack-downloads', `${f.id}-${fileName}`);
        const existingArchiveDest = isPackArchive
          ? [path.join(resourcePacksDir, fileName), path.join(dataPacksDir, fileName)].find((candidate) => fs.existsSync(candidate))
          : undefined;
        const dest = isPackArchive ? existingArchiveDest ?? stagedArchiveDest : modsDest;
        const clientModDest = path.join(serverDir, 'client-mods', String(f.id), fileName);
        const clientOnlyReason = !isPackArchive && /\.jar$/i.test(fileName)
          ? curseForgeClientSkipReason(f, serverRequiredDependencyProjects)
          : null;
        if (clientOnlyReason) {
          if (fs.existsSync(dest)) {
            fs.mkdirSync(path.dirname(clientModDest), { recursive: true });
            fs.renameSync(dest, clientModDest);
          }
          clientOnlySkipped++;
          onLog(`  ↷ ${fileName}：${clientOnlyReason}，跳过服务端安装`);
          continue;
        }
        let ok = fs.existsSync(dest);
        if (!ok && !isPackArchive && fs.existsSync(clientModDest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(clientModDest, dest);
          ok = true;
        }
        if (!ok) {
          const urls: string[] = [];
          if (f.downloadUrl) urls.push(f.downloadUrl);
          const fileId = String(f.id);
          urls.push(`https://edge.forgecdn.net/files/${fileId.slice(0, fileId.length - 3)}/${fileId.slice(-3)}/${encodeURIComponent(fileName)}`);
          ok = await downloadWithFallback(urls, dest, onLog, 45_000, signal);
        }
        if (ok) {
          if (isPackArchive) {
            const archiveKind = await installClassifiedPackZip(dest, fileName, resourcePacksDir, dataPacksDir);
            if (!archiveKind) {
              fs.rmSync(dest, { force: true });
              manual.push(`${fileName}（ZIP 内容不是可识别的资源包或数据包）`);
              onLog(`  无法安装 ${fileName}：ZIP 中没有带 assets/ 或 data/ 的 pack.mcmeta，已列入人工处理`);
              continue;
            }
            if (archiveKind === 'resourcepack' || archiveKind === 'combined') resourcePacksDownloaded++;
            if (archiveKind === 'datapack' || archiveKind === 'combined') dataPacksDownloaded++;
            if (archiveKind === 'shaderpack') shaderPacksDownloaded++;
            const labels = archiveKind === 'combined' ? '资源包和数据包' : archiveKind === 'datapack' ? '数据包' : archiveKind === 'shaderpack' ? '客户端光影包' : '资源包';
            onLog(`  ✔ ${fileName}（已识别为${labels}）`);
          } else if (/\.jar$/i.test(fileName)) {
            const jarClientOnlyReason = await clientOnlyJarReason(dest, loader);
            if (jarClientOnlyReason) {
              const requiredDependency = Number.isInteger(projectId) && serverRequiredDependencyProjects.has(projectId!);
              if (requiredDependency) {
              pendingClientDependencyConflicts.push({ projectId: projectId!, fileName, dest, clientModDest, reason: jarClientOnlyReason });
                continue;
              }
              fs.mkdirSync(path.dirname(clientModDest), { recursive: true });
              fs.renameSync(dest, clientModDest);
              clientOnlySkipped++;
              onLog(`  ↷ ${fileName}：${jarClientOnlyReason}，跳过服务端安装`);
              continue;
            }
            downloaded++;
            onLog(`  ✔ ${fileName}${projectId && !requiredFiles.some((entry) => entry.projectID === projectId) ? '（自动补齐的必需依赖）' : ''}`);
          } else {
            onLog(`  ✔ ${fileName}`);
          }
        } else {
          manual.push(`${fileName}（下载失败）`);
        }
        // Resource/data pack ZIP relations are not server mod dependencies.
        if (isPackArchive || !/\.jar$/i.test(fileName)) continue;
        if (!ok) continue;
        for (const dependency of f.dependencies ?? []) {
          if (dependency.relationType !== 3 || !Number.isInteger(dependency.modId)) continue;
          const dependencyId = dependency.modId!;
          if (projectIds.has(dependencyId)) continue;
          requiredProjectIds.add(dependencyId);
          const sources = requiredProjectSources.get(dependencyId) ?? [];
          sources.push({ jarPath: dest, fileName });
          requiredProjectSources.set(dependencyId, sources);
          const allSources = allRequiredProjectSources.get(dependencyId) ?? [];
          allSources.push({ jarPath: dest, fileName });
          allRequiredProjectSources.set(dependencyId, allSources);
        }
    }

    // A required dependency may be published as a separate project per loader.
    // If this pack already includes that dependency's Forge/NeoForge project,
    // count it as satisfied instead of reporting a missing Fabric project or
    // downloading a duplicate jar under a different project ID.
    for (const id of requiredProjectIds) {
      if (projectIds.has(id)) continue;
      const aliasId = CURSEFORGE_LOADER_ALIASES[id]?.[loader?.toLowerCase() ?? ''];
      if (!aliasId || !projectIds.has(aliasId)) continue;
      projectIds.add(id);
      onLog(`  依赖项目 ${id} 已由整合包清单中的 ${loader} 项目 ${aliasId} 满足，跳过重复下载`);
    }

    const unresolvedProjects = [...requiredProjectIds].filter((id) => !projectIds.has(id));
    if (!unresolvedProjects.length) {
      pendingFileIds = [];
      continue;
    }
    const allowed = unresolvedProjects.slice(0, Math.max(0, maxAutoDependencies - autoDependencyCount));
    for (const id of unresolvedProjects.slice(allowed.length)) {
      manual.push(`CurseForge 项目 ${id}（超出自动补齐数量上限）`);
    }
    if (!allowed.length) break;

    onLog(`发现 ${allowed.length} 个清单外的必需依赖，正在按 ${mc ?? '未知版本'} / ${loader ?? '未知加载器'} 查找兼容文件`);
    const allowFabricBridge = hasFabricModBridge(path.join(serverDir, 'mods'));
    const { matches: resolved, ignored } = await curseForgeDependencyFiles(allowed, api, key, mc, loader, requiredProjectSources, onLog, allowFabricBridge, signal);
    pendingFileIds = [];
    for (const id of allowed) {
      if (ignored.has(id)) {
        projectIds.add(id);
        continue;
      }
      const match = resolved.get(id);
      const index = match?.index;
      if (!index?.fileId || match?.projectId === undefined) {
        manual.push(`CurseForge 项目 ${id}（未找到兼容的 ${mc ?? '未知版本'} / ${loader ?? '未知加载器'} 文件）`);
        projectIds.add(id);
        continue;
      }
      projectIds.add(id);
      projectIds.add(match.projectId);
      projectByFile.set(index.fileId, match.projectId);
      pendingFileIds.push(index.fileId);
      autoDependencyCount++;
    }
  }
  if (pendingClientDependencyConflicts.length) {
    const ids = [...new Set(pendingClientDependencyConflicts.map((conflict) => conflict.projectId))];
    let projectMetadata = new Map<number, CurseForgeMod>();
    let projectMetadataAvailable = false;
    try {
      const response = await curseForgeRequest<{ data?: CurseForgeMod[] }>(`${api}/mods`, key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modIds: ids, filterPcOnly: true }),
      }, signal);
      projectMetadata = new Map((response.data ?? []).filter((mod) => Number.isInteger(mod.id)).map((mod) => [mod.id!, mod]));
      projectMetadataAvailable = true;
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      onLog(`校验客户端依赖关系失败，保留冲突项并阻止启动 / Could not verify client-only dependencies; keeping them blocked: ${String(err).slice(0, 120)}`);
    }
    for (const conflict of pendingClientDependencyConflicts) {
      signal?.throwIfAborted();
      const sources = allRequiredProjectSources.get(conflict.projectId) ?? [];
      const project = projectMetadata.get(conflict.projectId);
      let requiredByServer = !projectMetadataAvailable || (sources.length > 0 && !project);
      if (project && sources.length) {
        const declarations = await Promise.all(sources.map((source) =>
          jarDeclaresCurseForgeDependency(source.jarPath, conflict.projectId, { slug: project.slug, name: project.name }, loader),
        ));
        requiredByServer = declarations.some((declaration) => declaration !== false);
      }
      if (requiredByServer) {
        manual.push(`${conflict.fileName}（服务器必需依赖同时声明为客户端专用）`);
        downloaded++;
        onLog(`  依赖冲突：${conflict.fileName} 被有效的服务端模组依赖，但 JAR 元数据标记为客户端专用；已保留文件并阻止启动 / Dependency conflict: an active server mod requires ${conflict.fileName}, but its JAR is client-only`);
      } else {
        if (fs.existsSync(conflict.dest)) {
          fs.mkdirSync(path.dirname(conflict.clientModDest), { recursive: true });
          fs.renameSync(conflict.dest, conflict.clientModDest);
        }
        clientOnlySkipped++;
        onLog(`  ↷ ${conflict.fileName}：虽有客户端模组声明依赖，但未被服务端模组需要，已移出服务端 / ${conflict.fileName} is only required by client-side mods and was moved out of the server mods folder`);
      }
    }
  }
  const jarDependencyResult = await installMissingJarDependencies(serverDir, api, key, mc, loader, onLog, signal);
  if (jarDependencyResult.installed) {
    downloaded += jarDependencyResult.installed;
    autoDependencyCount += jarDependencyResult.installed;
  }
  for (const modId of jarDependencyResult.conflicts) {
    manual.push(`服务器必需 Mod 依赖 ${modId}（候选文件仅客户端兼容）`);
  }
  if (autoDependencyCount) onLog(`已自动补齐 ${autoDependencyCount} 个 CurseForge 必需依赖`);
  if (resourcePacksDownloaded) onLog(`已保存 ${resourcePacksDownloaded} 个资源包到 resourcepacks/，不作为服务端模组加载`);
  if (dataPacksDownloaded) onLog(`已保存 ${dataPacksDownloaded} 个数据包到 ${levelName}/datapacks/，供世界启动时加载`);
  if (shaderPacksDownloaded) onLog(`已保存 ${shaderPacksDownloaded} 个客户端光影包到 client-files/shaderpacks/，不作为服务端资源加载`);
  if (clientOnlySkipped) onLog(`已跳过 ${clientOnlySkipped} 个客户端专用 MOD，不会放入服务端 mods/`);
  if (manual.length) onLog(`仍有 ${manual.length} 个 CurseForge 文件或依赖未能自动安装，稍后列出明细`);
  return { downloaded, manual };
}

function findEntry(zip: yauzl.ZipFile, name: string): Promise<ZipEntry> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: ZipEntry) => {
      if (entry.fileName === name) {
        zip.removeListener('entry', onEntry);
        zip.removeListener('end', onEnd);
        zip.removeListener('error', onError);
        resolve(entry);
      } else zip.readEntry();
    };
    const onEnd = () => {
      zip.removeListener('entry', onEntry);
      zip.removeListener('error', onError);
      reject(new Error(`压缩包中不存在条目 ${name}`));
    };
    const onError = (error: Error) => {
      zip.removeListener('entry', onEntry);
      zip.removeListener('end', onEnd);
      reject(error);
    };
    zip.on('entry', onEntry);
    zip.on('end', onEnd);
    zip.on('error', onError);
    zip.readEntry();
  });
}

/** 主入口：把整合包内容装进某个世界 */
export async function extractPack(file: string, instanceId: string, onLog: (s: string) => void, opts: { signal?: AbortSignal } = {}): Promise<{ manual: string[]; extracted: number }> {
  const { signal } = opts;
  signal?.throwIfAborted();
  const info = await inspectPack(file);
  onLog(`识别为：${info.format}${info.packName ? `（${info.packName}）` : ''} — ${info.note}`);
  const serverDir = instanceServerDir(instanceId);
  const names = await listZipEntries(file);
  const stripPrefix = (() => {
    // 有些包会把所有东西套一层目录
    const roots = new Set(names.filter((n) => n.includes('/')).map((n) => n.split('/')[0]));
    if (roots.size === 1 && names.some((n) => !n.startsWith([...roots][0] + '/'))) return undefined;
    if (roots.size === 1) return [...roots][0] + '/';
    return undefined;
  })();

  let manual: string[] = [];
  let extracted = 0;
  switch (info.format) {
    case 'raw':
    case 'serverdir':
    case 'multimc':
    case 'hmcl':
      onLog('直接解压包内文件（不走网络）');
      extracted += await extractTree(file, names, serverDir, { prefixes: /(^|\/)(mods|config|defaultconfigs|kubejs|scripts|resourcepacks|datapacks)\//i, stripPrefix, onLog, signal });
      break;
    case 'curseforge': {
      onLog('解压 overrides/ …');
      extracted += await extractTree(file, names, serverDir, { prefixes: /(^|\/)overrides\//i, stripPrefix, stripChildPrefix: 'overrides/', onLog, signal });
      const r = await installCurseForge(file, instanceId, info.mc, info.loader, onLog, signal);
      manual = r.manual;
      onLog(`MOD 下载完成 ${r.downloaded} 个${manual.length ? `，${manual.length} 个需要手动处理` : ''}`);
      break;
    }
    case 'modrinth': {
      onLog('解压 overrides/ …');
      extracted += await extractTree(file, names, serverDir, { prefixes: /(^|\/)overrides\//i, stripPrefix, stripChildPrefix: 'overrides/', onLog, signal });
      const zip = await openZip(file);
      const idxName = names.find((n) => /modrinth\.index\.json$/.test(n))!;
      const idx = JSON.parse((await readEntry(zip, await findEntry(zip, idxName))).toString('utf8')) as {
        files?: { path: string; downloads: string[]; env?: { client?: string; server?: string } }[];
      };
      zip.close();
      const panel = loadConfig();
      const modsDir = path.join(serverDir, 'mods');
      let okCount = 0;
      let clientOnlySkipped = 0;
      for (const f of idx.files ?? []) {
        signal?.throwIfAborted();
        if (!f.path.toLowerCase().startsWith('mods/')) continue;
        if (!isModrinthServerModFile(f)) {
          clientOnlySkipped++;
          onLog(`  ↷ ${path.basename(f.path)}：Modrinth 清单标记 server=unsupported，跳过服务端安装`);
          continue;
        }
        const dest = path.join(modsDir, path.basename(f.path));
        const urls = [...f.downloads.map((u) => `${panel.mirrors.githubMirror}${u}`), ...f.downloads];
        const ok = await downloadWithFallback(urls, dest, onLog, 45_000, signal);
        if (ok) okCount++;
        else manual.push(path.basename(f.path));
      }
      onLog(`MOD 下载完成 ${okCount} 个${manual.length ? `，${manual.length} 个需要手动处理` : ''}`);
      if (clientOnlySkipped) onLog(`已跳过 ${clientOnlySkipped} 个 Modrinth 清单标记为客户端专用的 MOD`);
      break;
    }
    default:
      onLog('未知格式：尝试直接解压 mods/ 与 config/');
      extracted += await extractTree(file, names, serverDir, { prefixes: /(^|\/)(mods|config)\//i, stripPrefix, onLog, signal });
  }
  signal?.throwIfAborted();
  const embeddedClientOnly = await filterClientOnlyMods(serverDir, onLog, info.loader);
  if (embeddedClientOnly) onLog(`已从服务端目录移出 ${embeddedClientOnly} 个随包提供的客户端专用 MOD`);
  const missingJarDependencies = await missingRequiredModDependencies(path.join(serverDir, 'mods'), info.loader);
  for (const modId of missingJarDependencies) {
    if (manual.some((entry) => entry.includes(`依赖 ${modId}`))) continue;
    manual.push(`服务器必需 Mod 依赖 ${modId}（缺少对应文件或内嵌库）`);
    onLog(`缺少服务端模组依赖 ${modId}：JAR 元数据声明为必需，但整合包未提供对应 MOD 或内嵌库。请补齐兼容版本后再启动 / Missing server mod dependency ${modId}: a mod JAR requires it, but the pack contains neither the mod nor an embedded library. Add a compatible file before starting.`);
  }
  I.writeProperties(instanceId);
  logger.info(`整合包已装入 ${instanceId}`, { format: info.format, extracted, manual: manual.length });
  return { manual, extracted };
}
