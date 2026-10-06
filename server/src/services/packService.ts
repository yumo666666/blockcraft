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

  if (has(/(^|\/)manifest\.json$/) && has(/(^|\/)overrides\//)) {
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
        out.note = 'CurseForge 格式：包内不含 MOD 本体，需要联网按清单下载（需要 CurseForge API Key，否则会列出人工清单）';
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
        out.loader = idx.dependencies?.fabricLoader ? 'fabric' : idx.dependencies?.forge ? 'forge' : idx.dependencies?.neoforge ? 'neoforge' : null;
        out.loaderVersion =
          idx.dependencies?.fabricLoader ?? idx.dependencies?.forge ?? idx.dependencies?.neoforge ?? null;
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
  opts: { prefixes: RegExp; stripPrefix?: string; onLog: (s: string) => void },
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
      const stripped = name.replace(/^\.?\/?(\.minecraft|minecraft)\//i, '');
      const rel = opts.stripPrefix && stripped.startsWith(opts.stripPrefix) ? stripped.slice(opts.stripPrefix.length) : stripped;
      if (!rel || rel.includes('..')) {
        zip.readEntry();
        return;
      }
      const dest = path.join(targetRoot, rel);
      if (!dest.startsWith(targetRoot)) {
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
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'BlockCraft/2.0' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.part`;
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
      if (fs.statSync(tmp).size === 0) throw new Error('0 字节');
      fs.renameSync(tmp, dest);
      return true;
    } catch (err) {
      onLog(`  下载失败（${url}）：${String(err).slice(0, 120)}`);
    }
  }
  return false;
}

/** 按 CurseForge 清单批量下载（一次 100 个 fileId） */
async function installCurseForge(
  file: string,
  instanceId: string,
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
  const modsDir = path.join(serverDir, 'mods');
  const panel = loadConfig();
  const key = panel.mirrors.curseforgeApiKey;
  const manual: string[] = [];
  let downloaded = 0;
  if (!key) {
    onLog(`没有配置 CurseForge API Key：${manifest.files.length} 个 MOD 无法自动下载，已列成人工清单`);
    for (const f of manifest.files) manual.push(`https://www.curseforge.com/minecraft/mc-mods/search?projectId=${f.projectID}`);
    return { downloaded, manual };
  }
  const ids = manifest.files.map((f) => f.fileID);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    onLog(`查询文件信息 ${i + 1}~${i + chunk.length} / ${ids.length}`);
    const res = await fetch(`${panel.mirrors.curseforgeApi.replace(/\/$/, '')}/mods/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ fileIds: chunk }),
    });
    if (!res.ok) {
      onLog(`接口返回 ${res.status}，这批改为人工清单`);
      for (const id of chunk) manual.push(`https://www.curseforge.com/minecraft/mc-mods/search?fileId=${id}`);
      continue;
    }
    const json = (await res.json()) as { data?: { fileName?: string; downloadUrl?: string | null; id?: number }[] };
    for (const f of json.data ?? []) {
      const fileName = f.fileName ?? `cf-${f.id}.jar`;
      const urls: string[] = [];
      if (f.downloadUrl) urls.push(f.downloadUrl);
      if (f.id) {
        const s = String(f.id);
        urls.push(`https://edge.forgecdn.net/files/${s.slice(0, s.length - 3)}/${s.slice(-3)}/${encodeURIComponent(fileName)}`);
      }
      const ok = await downloadWithFallback(urls, path.join(modsDir, fileName), onLog);
      if (ok) {
        downloaded++;
        onLog(`  ✔ ${fileName}`);
      } else {
        manual.push(fileName);
      }
    }
  }
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
      extracted += await extractTree(file, names, serverDir, { prefixes: /(^|\/)overrides\//i, stripPrefix, onLog });
      const r = await installCurseForge(file, instanceId, onLog);
      manual = r.manual;
      onLog(`MOD 下载完成 ${r.downloaded} 个${manual.length ? `，${manual.length} 个需要手动处理` : ''}`);
      break;
    }
    case 'modrinth': {
      onLog('解压 overrides/ …');
      extracted += await extractTree(file, names, serverDir, { prefixes: /(^|\/)overrides\//i, stripPrefix, onLog });
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
