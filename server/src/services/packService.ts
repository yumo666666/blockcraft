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

export interface PackInspection {
  format: 'curseforge' | 'modrinth' | 'hmcl' | 'raw' | 'serverdir' | 'multimc' | 'unknown';
  mc: string | null;
  loader: string | null;
  loaderVersion: string | null;
  packName: string | null;
  modsInZip: number;
  filesToDownload: number;
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
    modsInZip: names.filter((n) => /\.jar$/i.test(n)).length,
    filesToDownload: 0,
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
          minecraft?: { version?: string; modLoaders?: { id?: string; primary?: boolean }[] };
          files?: { projectID: number; fileID: number }[];
        };
        out.packName = manifest.name ?? null;
        out.mc = manifest.minecraft?.version ?? null;
        const primary = manifest.minecraft?.modLoaders?.find((l) => l.primary) ?? manifest.minecraft?.modLoaders?.[0];
        if (primary?.id) {
          const [loader, ...rest] = primary.id.split('-');
          out.loader = loader === 'neoforge' ? 'neoforge' : loader;
          out.loaderVersion = rest.join('-');
        }
        out.filesToDownload = manifest.files?.length ?? 0;
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
        out.loader = fabricVersion ? 'fabric' : idx.dependencies?.forge ? 'forge' : idx.dependencies?.neoforge ? 'neoforge' : null;
        out.loaderVersion = fabricVersion ?? idx.dependencies?.forge ?? idx.dependencies?.neoforge ?? null;
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

/** 把 zip 里某个前缀下的内容解压到目标目录（剥掉一层根目录） */
async function extractTree(
  file: string,
  entries: string[],
  targetRoot: string,
  opts: { prefixes: RegExp; stripPrefix?: string; stripChildPrefix?: string; onLog: (s: string) => void },
): Promise<number> {
  const zip = await openZip(file);
  let count = 0;
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: ZipEntry) => {
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
        if (err || !stream) {
          zip.readEntry();
          return;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const out = fs.createWriteStream(dest);
        stream.pipe(out);
        out.on('close', () => {
          count++;
          zip.readEntry();
        });
        out.on('error', () => zip.readEntry());
      });
    });
    zip.on('end', () => {
      try {
        zip.close();
      } catch {
        /* ignore */
      }
      resolve();
    });
    zip.on('error', reject);
    zip.readEntry();
  });
  return count;
}

async function downloadWithFallback(urls: string[], dest: string, onLog: (s: string) => void): Promise<boolean> {
  for (const url of urls) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let retryable = true;
      const tmp = `${dest}.part`;
      try {
        const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'BlockCraft/2.0' } });
        if (!res.ok || !res.body) {
          retryable = res.status === 429 || res.status >= 500;
          throw new Error(`HTTP ${res.status}`);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
        if (fs.statSync(tmp).size === 0) throw new Error('0 字节');
        fs.renameSync(tmp, dest);
        return true;
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        if (retryable && attempt < 2) {
          onLog(`  下载暂时失败，${attempt + 1}/2 次重试：${String(err).slice(0, 100)}`);
          await new Promise((resolve) => setTimeout(resolve, 700 * 2 ** attempt));
          continue;
        }
        onLog(`  下载失败（${url}）：${String(err).slice(0, 120)}`);
        break;
      }
    }
  }
  return false;
}

type CurseForgeDependency = { modId?: number; relationType?: number };
type CurseForgeFile = {
  id?: number;
  modId?: number;
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
};
type CurseForgeMod = {
  id?: number;
  name?: string;
  slug?: string;
  links?: { websiteUrl?: string };
  latestFilesIndexes?: CurseForgeFileIndex[];
};

type CurseForgeDependencyMatch = { index: CurseForgeFileIndex; projectId: number };

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
};

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

/** Check known CurseForge relations against the dependency IDs the loader sees. */
async function jarRequiresCurseForgeDependency(jarPath: string, projectId: number): Promise<boolean | null> {
  const targetIds = CURSEFORGE_DEPENDENCY_MOD_IDS[projectId];
  if (!targetIds) return null;
  try {
    const names = await listZipEntries(jarPath);
    const metadataNames = names.filter((name) =>
      name === 'META-INF/mods.toml' || name === 'META-INF/neoforge.mods.toml' || name === 'fabric.mod.json',
    );
    if (!metadataNames.length) return null;
    const zip = await openZip(jarPath);
    const dependencies = new Set<string>();
    try {
      for (const [index, name] of metadataNames.entries()) {
        const contents = (await readEntry(zip, await findEntry(zip, name))).toString('utf8');
        if (index < metadataNames.length - 1) zip.readEntry();
        if (name.endsWith('.toml')) {
          for (const id of requiredForgeDependencies(contents)) dependencies.add(id);
        } else {
          const metadata = JSON.parse(contents) as { depends?: Record<string, unknown> };
          for (const id of Object.keys(metadata.depends ?? {})) dependencies.add(id.toLowerCase());
        }
      }
    } finally {
      zip.close();
    }
    return targetIds.some((id) => dependencies.has(id));
  } catch {
    return null;
  }
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
): Promise<CurseForgeFileIndex | null> {
  const query = new URLSearchParams({ gameVersion: mc, modLoaderType: String(loaderType), pageSize: '50', index: '0' });
  const response = await curseForgeRequest<{ data?: CurseForgeFile[] }>(`${api}/mods/${projectId}/files?${query}`, key, { method: 'GET' });
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
  };
}

async function curseForgeRequest<T>(url: string, key: string, init: RequestInit): Promise<T> {
  let lastError = '未知错误';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let retryable = true;
    const controller = new AbortController();
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
      lastError = String(err);
    } finally {
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
  onLog: (s: string) => void,
): Promise<Map<number, CurseForgeDependencyMatch>> {
  const out = new Map<number, CurseForgeDependencyMatch>();
  if (!mc) {
    for (const id of modIds) onLog(`  无法自动选取 CurseForge 依赖 ${id}：整合包没有声明 Minecraft 版本`);
    return out;
  }
  const loaderType = loader ? CURSEFORGE_LOADER_TYPES[loader.toLowerCase()] : 0;
  if (loader && loaderType === undefined) {
    for (const id of modIds) onLog(`  无法自动选取 CurseForge 依赖 ${id}：不支持的加载器 ${loader}`);
    return out;
  }

  for (let i = 0; i < modIds.length; i += 50) {
    const chunk = modIds.slice(i, i + 50);
    try {
      const response = await curseForgeRequest<{ data?: CurseForgeMod[] }>(`${api}/mods`, key, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modIds: chunk, filterPcOnly: true }),
      });
      const projects = new Map((response.data ?? []).filter((mod) => Number.isInteger(mod.id)).map((mod) => [mod.id!, mod]));
      const missingIndexes: { id: number; mod: CurseForgeMod }[] = [];
      for (const id of chunk) {
        const mod = projects.get(id);
        if (!mod) continue;
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
          });
          for (const mod of aliasResponse.data ?? []) if (Number.isInteger(mod.id)) aliasProjects.set(mod.id!, mod);
        } catch (err) {
          onLog(`  查询加载器替代项目失败：${String(err).slice(0, 120)}`);
        }
      }

      for (const { id, mod } of missingIndexes) {
        try {
          const directFile = await queryCompatibleCurseForgeFile(id, api, key, mc, loaderType);
          if (directFile) {
            out.set(id, { index: directFile, projectId: id });
            continue;
          }
        } catch (err) {
          onLog(`  查询「${mod.name ?? `项目 ${id}`}」的精确版本列表失败：${String(err).slice(0, 100)}`);
        }

        const aliasId = CURSEFORGE_LOADER_ALIASES[id]?.[loader?.toLowerCase() ?? ''];
        if (aliasId) {
          const aliasMod = aliasProjects.get(aliasId);
          let aliasFile = aliasMod ? compatibleCurseForgeIndex(aliasMod, mc, loaderType) : null;
          if (!aliasFile) {
            try {
              aliasFile = await queryCompatibleCurseForgeFile(aliasId, api, key, mc, loaderType);
            } catch (err) {
              onLog(`  查询替代项目 ${aliasId} 的文件失败：${String(err).slice(0, 100)}`);
            }
          }
          if (aliasFile) {
            out.set(id, { index: aliasFile, projectId: aliasId });
            onLog(`  已将「${mod.name ?? `项目 ${id}`}」(${id}) 映射到 ${loader} 兼容项目「${aliasMod?.name ?? `项目 ${aliasId}`}」(${aliasId})`);
            continue;
          }
        }
        const page = mod.links?.websiteUrl || (mod.slug ? `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}` : `CurseForge 项目 ${id}`);
        onLog(`  ${mod.name ? `「${mod.name}」` : `项目 ${id}`} 没有 ${mc} / ${loader} 文件（${page}）。不能把 Fabric 文件装进 Forge 世界。`);
      }
    } catch (err) {
      onLog(`  查询 CurseForge 依赖文件失败：${String(err).slice(0, 120)}`);
    }
  }
  return out;
}

/** 按 CurseForge 清单批量下载（一次 100 个 fileId） */
async function installCurseForge(
  file: string,
  instanceId: string,
  mc: string | null,
  loader: string | null,
  onLog: (s: string) => void,
): Promise<{ downloaded: number; manual: string[] }> {
  const zip = await openZip(file);
  const names = await listZipEntries(file);
  const manifestName = names.find((n) => /(^|\/)manifest\.json$/.test(n));
  if (!manifestName) throw bad('压缩包缺少 manifest.json');
  const manifest = JSON.parse((await readEntry(zip, await findEntry(zip, manifestName))).toString('utf8')) as {
    files: { projectID: number; fileID: number }[];
  };
  zip.close();
  const serverDir = instanceServerDir(instanceId);
  const panel = loadConfig();
  const key = panel.mirrors.curseforgeApiKey;
  const api = panel.mirrors.curseforgeApi.replace(/\/$/, '');
  const manual: string[] = [];
  let downloaded = 0;
  let resourcePacksDownloaded = 0;
  if (!key) {
    throw bad('导入 CurseForge 整合包需要先在设置中填写并保存 API Key / A CurseForge API Key must be saved in Settings before importing this pack.');
  }
  const projectIds = new Set(manifest.files.map((f) => f.projectID));
  const projectByFile = new Map(manifest.files.map((f) => [f.fileID, f.projectID]));
  const visitedFileIds = new Set<number>();
  let pendingFileIds = [...new Set(manifest.files.map((f) => f.fileID))];
  let autoDependencyCount = 0;
  const maxAutoDependencies = 256;

  while (pendingFileIds.length) {
    const current = pendingFileIds.filter((id) => id > 0 && !visitedFileIds.has(id));
    if (!current.length) break;
    current.forEach((id) => visitedFileIds.add(id));
    const requiredProjectIds = new Set<number>();

    for (let i = 0; i < current.length; i += 100) {
      const chunk = current.slice(i, i + 100);
      onLog(`查询 CurseForge 文件信息 ${visitedFileIds.size} 项`);
      let files: CurseForgeFile[] = [];
      try {
        const response = await curseForgeRequest<{ data?: CurseForgeFile[] }>(`${api}/mods/files`, key, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileIds: chunk }),
        });
        files = response.data ?? [];
      } catch (err) {
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

      for (const f of files) {
        if (!f.id) continue;
        const projectId = f.modId ?? projectByFile.get(f.id);
        if (projectId) projectIds.add(projectId);
        const fileName = path.basename(f.fileName || `cf-${f.id}.jar`);
        const isResourcePack = /\.zip$/i.test(fileName);
        const dest = path.join(serverDir, isResourcePack ? 'resourcepacks' : 'mods', fileName);
        let ok = fs.existsSync(dest);
        if (!ok) {
          const urls: string[] = [];
          if (f.downloadUrl) urls.push(f.downloadUrl);
          const fileId = String(f.id);
          urls.push(`https://edge.forgecdn.net/files/${fileId.slice(0, fileId.length - 3)}/${fileId.slice(-3)}/${encodeURIComponent(fileName)}`);
          ok = await downloadWithFallback(urls, dest, onLog);
        }
        if (ok) {
          if (isResourcePack) resourcePacksDownloaded++;
          else downloaded++;
          onLog(`  ✔ ${fileName}${isResourcePack ? '（资源包）' : projectId && !manifest.files.some((entry) => entry.projectID === projectId) ? '（自动补齐的必需依赖）' : ''}`);
        } else {
          manual.push(`${fileName}（下载失败）`);
        }
        // Resource-pack ZIP relations describe client-side presentation helpers,
        // not dedicated-server mod requirements. Only inspect mod jars below.
        if (isResourcePack || !/\.jar$/i.test(fileName)) continue;
        for (const dependency of f.dependencies ?? []) {
          if (dependency.relationType !== 3 || !Number.isInteger(dependency.modId)) continue;
          const dependencyId = dependency.modId!;
          if (projectIds.has(dependencyId)) continue;
          if (ok && CURSEFORGE_DEPENDENCY_MOD_IDS[dependencyId]) {
            const loaderDependency = await jarRequiresCurseForgeDependency(dest, dependencyId);
            if (loaderDependency === false) {
              onLog(`  忽略「${fileName}」对项目 ${dependencyId} 的清单关联：JAR 未声明对应的必需加载器依赖`);
              continue;
            }
          }
          requiredProjectIds.add(dependencyId);
        }
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
    const resolved = await curseForgeDependencyFiles(allowed, api, key, mc, loader, onLog);
    pendingFileIds = [];
    for (const id of allowed) {
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
  if (autoDependencyCount) onLog(`已自动补齐 ${autoDependencyCount} 个 CurseForge 必需依赖`);
  if (resourcePacksDownloaded) onLog(`已保存 ${resourcePacksDownloaded} 个资源包到 resourcepacks/，不作为服务端模组加载`);
  if (manual.length) onLog(`仍有 ${manual.length} 个 CurseForge 文件或依赖未能自动安装，稍后列出明细`);
  return { downloaded, manual };
}

function findEntry(zip: yauzl.ZipFile, name: string): Promise<ZipEntry> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: ZipEntry) => {
      if (entry.fileName === name) {
        zip.removeListener('entry', onEntry);
        resolve(entry);
      } else zip.readEntry();
    };
    zip.on('entry', onEntry);
    zip.on('error', reject);
    zip.readEntry();
  });
}

/** 主入口：把整合包内容装进某个世界 */
export async function extractPack(file: string, instanceId: string, onLog: (s: string) => void): Promise<{ manual: string[]; extracted: number }> {
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
      extracted += await extractTree(file, names, serverDir, { prefixes: /(^|\/)(mods|config|defaultconfigs|kubejs|scripts|resourcepacks|datapacks)\//i, stripPrefix, onLog });
      break;
    case 'curseforge': {
      onLog('解压 overrides/ …');
      extracted += await extractTree(file, names, serverDir, { prefixes: /(^|\/)overrides\//i, stripPrefix, stripChildPrefix: 'overrides/', onLog });
      const r = await installCurseForge(file, instanceId, info.mc, info.loader, onLog);
      manual = r.manual;
      onLog(`MOD 下载完成 ${r.downloaded} 个${manual.length ? `，${manual.length} 个需要手动处理` : ''}`);
      break;
    }
    case 'modrinth': {
      onLog('解压 overrides/ …');
      extracted += await extractTree(file, names, serverDir, { prefixes: /(^|\/)overrides\//i, stripPrefix, stripChildPrefix: 'overrides/', onLog });
      const zip = await openZip(file);
      const idxName = names.find((n) => /modrinth\.index\.json$/.test(n))!;
      const idx = JSON.parse((await readEntry(zip, await findEntry(zip, idxName))).toString('utf8')) as {
        files?: { path: string; downloads: string[] }[];
      };
      zip.close();
      const panel = loadConfig();
      const modsDir = path.join(serverDir, 'mods');
      let okCount = 0;
      for (const f of idx.files ?? []) {
        if (!f.path.startsWith('mods/')) continue;
        const dest = path.join(modsDir, path.basename(f.path));
        const urls = [...f.downloads.map((u) => `${panel.mirrors.githubMirror}${u}`), ...f.downloads];
        const ok = await downloadWithFallback(urls, dest, onLog);
        if (ok) okCount++;
        else manual.push(path.basename(f.path));
      }
      onLog(`MOD 下载完成 ${okCount} 个${manual.length ? `，${manual.length} 个需要手动处理` : ''}`);
      break;
    }
    default:
      onLog('未知格式：尝试直接解压 mods/ 与 config/');
      extracted += await extractTree(file, names, serverDir, { prefixes: /(^|\/)(mods|config)\//i, stripPrefix, onLog });
  }
  I.writeProperties(instanceId);
  logger.info(`整合包已装入 ${instanceId}`, { format: info.format, extracted, manual: manual.length });
  return { manual, extracted };
}
