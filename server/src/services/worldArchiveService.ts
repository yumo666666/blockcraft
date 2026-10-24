import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
// yazl / yauzl are CommonJS packages.
// @ts-ignore -- package does not ship complete TypeScript declarations
import yazlModule from 'yazl';
// @ts-ignore -- package does not ship complete TypeScript declarations
import yauzlModule from 'yauzl';
import { INSTANCE_ID_RE, INSTANCES_DIR, STORE_DIR, instanceDir } from '../core/paths.ts';
import { bad, conflict, payloadTooLarge } from '../core/errors.ts';
import * as I from './instanceService.ts';
import type { InstanceConfig, Loader } from '../types.ts';

const yazl = yazlModule as unknown as {
  ZipFile: new () => {
    outputStream: NodeJS.ReadableStream & { on(event: string, listener: (...args: any[]) => void): unknown };
    addFile(file: string, metadataPath: string, options?: Record<string, unknown>): void;
    addEmptyDirectory(metadataPath: string, options?: Record<string, unknown>): void;
    end(): void;
  };
};
const yauzl = yauzlModule as unknown as {
  open(file: string, options: Record<string, unknown>, callback: (err: Error | null, zip?: any) => void): void;
};

export const MAX_WORLD_ARCHIVE_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_WORLD_ARCHIVE_UNPACKED_BYTES = 200 * 1024 * 1024 * 1024;
const MAX_WORLD_ARCHIVE_ENTRIES = 300_000;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

interface ArchiveConfig {
  id: string;
  name: string;
  mc: string;
  loader: Loader;
  [key: string]: unknown;
}

interface ArchiveEntryInfo {
  name: string;
  relative: string;
  directory: boolean;
  size: number;
}

function openZip(file: string): Promise<any> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error('无法打开 ZIP 文件'));
      else resolve(zip);
    });
  });
}

function archiveName(value: string): string {
  const name = path.basename(value).trim();
  if (!name || !name.toLowerCase().endsWith('.zip')) throw bad('请选择完整世界 ZIP 文件');
  return name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 120) || 'world.zip';
}

function normalizedEntryName(value: unknown): { name: string; directory: boolean } {
  const original = String(value ?? '');
  if (!original || original.includes('\0')) throw new Error('ZIP 内含空文件名或非法字符');
  const name = original.replace(/\\/g, '/');
  const directory = name.endsWith('/');
  const clean = directory ? name.slice(0, -1) : name;
  const parts = clean.split('/');
  if (
    !clean || name.startsWith('/') || /^[A-Za-z]:/.test(name) ||
    parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part))
  ) {
    throw new Error(`ZIP 内含非法路径：${original}`);
  }
  for (const part of parts) {
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error(`ZIP 内含 Windows 不支持的路径：${original}`);
    }
  }
  return { name: clean, directory };
}

function zipEntryType(entry: any): 'file' | 'directory' | 'unsupported' {
  const mode = (Number(entry?.externalFileAttributes ?? 0) >>> 16) & 0xf000;
  if (mode === 0x4000) return 'directory';
  if (mode === 0x8000 || mode === 0) return 'file';
  return 'unsupported';
}

function inspectArchive(file: string): Promise<{ entries: ArchiveEntryInfo[]; prefix: string; config: ArchiveConfig }> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (err: Error | null, zip: any) => {
      if (err || !zip) {
        reject(err ?? new Error('无法打开 ZIP 文件'));
        return;
      }
      const entries: ArchiveEntryInfo[] = [];
      const names = new Set<string>();
      let unpacked = 0;
      let configPath = '';
      let settled = false;
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* ignore */ }
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      };
      zip.on('error', fail);
      zip.on('entry', (entry: any) => {
        if (settled) return;
        try {
          const normalized = normalizedEntryName(entry?.fileName);
          const type = zipEntryType(entry);
          if (type === 'unsupported') throw new Error(`ZIP 内含符号链接或特殊文件：${String(entry?.fileName)}`);
          if (normalized.directory && type === 'file' && (((Number(entry?.externalFileAttributes ?? 0) >>> 16) & 0xf000) === 0x8000)) {
            throw new Error(`ZIP 目录条目类型无效：${String(entry?.fileName)}`);
          }
          const key = normalized.name.toLocaleLowerCase('en-US');
          if (names.has(key)) throw new Error(`ZIP 内含重复路径：${normalized.name}`);
          names.add(key);
          if (entries.length >= MAX_WORLD_ARCHIVE_ENTRIES) throw new Error(`ZIP 条目超过 ${MAX_WORLD_ARCHIVE_ENTRIES} 个`);
          const size = normalized.directory ? 0 : Number(entry?.uncompressedSize ?? 0);
          if (!Number.isSafeInteger(size) || size < 0) throw new Error(`ZIP 文件大小无效：${normalized.name}`);
          unpacked += size;
          if (unpacked > MAX_WORLD_ARCHIVE_UNPACKED_BYTES) throw new Error('ZIP 解压后超过 200 GB 限制');
          entries.push({ name: normalized.name, relative: '', directory: normalized.directory || type === 'directory', size });
          if (
            !normalized.directory && normalized.name.split('/').length <= 2 &&
            path.posix.basename(normalized.name).toLowerCase() === 'config.json'
          ) {
            if (configPath) throw new Error('ZIP 中发现多个 config.json，无法确定要导入的世界');
            configPath = normalized.name;
          }
          zip.readEntry();
        } catch (reason) {
          fail(reason);
        }
      });
      zip.on('end', async () => {
        if (settled) return;
        try {
          if (!configPath) throw new Error('ZIP 中没有 config.json；请上传 BlockCraft 导出的完整世界 ZIP');
          const prefix = configPath.includes('/') ? configPath.slice(0, configPath.lastIndexOf('/') + 1) : '';
          for (const entry of entries) {
            const isPrefixDirectory = prefix && entry.directory && `${entry.name}/` === prefix;
            if (prefix && !entry.name.startsWith(prefix) && !isPrefixDirectory) throw new Error('ZIP 必须只包含一个世界目录');
            if (isPrefixDirectory) {
              entry.relative = '';
              continue;
            }
            entry.relative = prefix ? entry.name.slice(prefix.length) : entry.name;
            if (!entry.relative && entry.directory) continue;
            if (!entry.relative) throw new Error('ZIP 内含空路径');
          }
          const relativeNames = new Set(entries.map((entry) => entry.relative.toLowerCase()));
          if (!relativeNames.has('server') && ![...relativeNames].some((name) => name.startsWith('server/'))) {
            throw new Error('ZIP 中没有 server 目录，不是完整的 BlockCraft 世界目录');
          }
          const configEntry = entries.find((entry) => entry.name === configPath);
          if (!configEntry || configEntry.size > MAX_CONFIG_BYTES) throw new Error('世界 config.json 缺失或超过 2 MB');
          const configZip = await openZip(file);
          const config = await readArchiveConfig(configZip, configPath);
          settled = true;
          resolve({ entries, prefix, config });
        } catch (reason) {
          fail(reason);
        }
      });
      zip.readEntry();
    });
  });
}

function readArchiveConfig(zip: any, wantedName: string): Promise<ArchiveConfig> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch { /* ignore */ }
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    zip.on('error', fail);
    zip.on('entry', (entry: any) => {
      if (String(entry?.fileName ?? '').replace(/\\/g, '/') !== wantedName) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
        if (err || !stream) {
          fail(err ?? new Error('读取 config.json 失败'));
          return;
        }
        const readable = stream as NodeJS.ReadableStream & { destroy(error?: Error): void };
        const chunks: Buffer[] = [];
        let bytes = 0;
        readable.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_CONFIG_BYTES) {
            readable.destroy(new Error('世界 config.json 超过 2 MB'));
            return;
          }
          chunks.push(chunk);
        });
        readable.on('error', fail);
        readable.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            const loaders: Loader[] = ['vanilla', 'forge', 'neoforge', 'fabric', 'paper'];
            if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 100) throw new Error('世界名称无效');
            if (typeof data.mc !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(data.mc)) throw new Error('Minecraft 版本无效');
            if (!loaders.includes(data.loader as Loader)) throw new Error('世界加载器无效');
            if (typeof data.id !== 'string') throw new Error('世界 ID 缺失');
            settled = true;
            try { zip.close(); } catch { /* ignore */ }
            resolve(data as unknown as ArchiveConfig);
          } catch (reason) {
            fail(reason);
          }
        });
      });
    });
    zip.on('end', () => {
      if (!settled) fail(new Error('ZIP 中找不到世界 config.json'));
    });
    zip.readEntry();
  });
}

function safeTarget(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split('/'));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`ZIP 内含越界路径：${relative}`);
  return target;
}

async function extractArchive(file: string, root: string, entries: ArchiveEntryInfo[]): Promise<void> {
  const expected = new Map(entries.map((entry) => [entry.name, entry]));
  const zip = await openZip(file);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let expanded = 0;
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch { /* ignore */ }
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    zip.on('error', fail);
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on('entry', (entry: any) => {
      if (settled) return;
      const name = String(entry?.fileName ?? '').replace(/\\/g, '/').replace(/\/$/, '');
      const info = expected.get(name);
      if (!info) {
        fail(new Error(`ZIP 内容在校验后发生变化：${name}`));
        return;
      }
      if (info.directory) {
        fs.promises.mkdir(safeTarget(root, info.relative), { recursive: true }).then(() => zip.readEntry(), fail);
        return;
      }
      const target = safeTarget(root, info.relative);
      fs.promises.mkdir(path.dirname(target), { recursive: true }).then(() => {
        zip.openReadStream(entry, (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
          if (err || !stream) {
            fail(err ?? new Error(`读取 ZIP 文件失败：${name}`));
            return;
          }
          const readable = stream as NodeJS.ReadableStream & { destroy(error?: Error): void };
          const out = fs.createWriteStream(target, { flags: 'wx' });
          let fileBytes = 0;
          stream.on('data', (chunk: Buffer) => {
            fileBytes += chunk.length;
            expanded += chunk.length;
            if (expanded > MAX_WORLD_ARCHIVE_UNPACKED_BYTES || fileBytes > info.size) {
              readable.destroy(new Error('ZIP 实际解压大小超过校验限制'));
            }
          });
          pipeline(readable, out).then(async () => {
            if (fileBytes !== info.size) {
              fail(new Error(`ZIP 文件大小与目录不符：${name}`));
              return;
            }
            const mode = (Number(entry?.externalFileAttributes ?? 0) >>> 16) & 0o777;
            if (mode & 0o111) await fs.promises.chmod(target, 0o644 | (mode & 0o111)).catch(() => undefined);
            zip.readEntry();
          }).catch(fail);
        });
      }).catch(fail);
    });
    zip.readEntry();
  });
}

function uniqueInstanceId(sourceId: string, name: string): string {
  const preferred = INSTANCE_ID_RE.test(sourceId) ? sourceId : I.slugify(name);
  if (preferred.length <= 40 && !I.exists(preferred) && !fs.existsSync(instanceDir(preferred))) return preferred;
  const base = preferred.slice(0, 36);
  if (!I.exists(base) && !fs.existsSync(instanceDir(base))) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!I.exists(candidate) && !fs.existsSync(instanceDir(candidate))) return candidate;
  }
  throw conflict('找不到可用的世界 ID，请先清理同名世界');
}

function importedConfigPatch(source: ArchiveConfig, created: InstanceConfig, originalName: string): Partial<InstanceConfig> {
  const patch = { ...source } as Partial<InstanceConfig>;
  delete (patch as Record<string, unknown>).id;
  delete (patch as Record<string, unknown>).schemaVersion;
  delete (patch as Record<string, unknown>).created;
  delete (patch as Record<string, unknown>).createdAt;
  delete (patch as Record<string, unknown>).javaMajor;
  delete (patch as Record<string, unknown>).javaPath;
  patch.name = source.name.trim();
  patch.autostart = false;
  patch.port = created.port;
  patch.rconPort = created.rconPort;
  patch.rconPassword = created.rconPassword;
  patch.frp = { ...created.frp, enabled: Boolean((source.frp as { enabled?: unknown } | undefined)?.enabled ?? true) };
  patch.createdFrom = { type: 'import', source: source.id };
  patch.importedFrom = { file: originalName, format: 'blockcraft-instance' };
  patch.javaMajor = created.javaMajor;
  patch.javaPath = created.javaPath;
  return patch;
}

/** Export the complete instance tree; dereference its conventional top-level `server` symlink. */
export async function writeWorldArchive(id: string, output: Writable): Promise<void> {
  const sourceRoot = instanceDir(id);
  const zip = new yazl.ZipFile();
  const entries: Array<{ full?: string; name: string; directory: boolean }> = [];
  const visited = new Set<string>();

  async function walk(full: string, name: string, followServerLink: boolean): Promise<void> {
    const stat = await fs.promises.lstat(full);
    if (stat.isSymbolicLink()) {
      if (followServerLink && name === `${id}/server`) {
        const actual = await fs.promises.realpath(full);
        return walk(actual, name, false);
      }
      return;
    }
    if (stat.isDirectory()) {
      const actual = await fs.promises.realpath(full);
      if (visited.has(actual)) return;
      visited.add(actual);
      entries.push({ name: `${name}/`, directory: true });
      const children = await fs.promises.readdir(full, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) await walk(path.join(full, child.name), `${name}/${child.name}`, false);
      return;
    }
    if (!stat.isFile()) throw new Error(`不支持打包特殊文件：${name}`);
    entries.push({ full, name, directory: false });
  }

  const rootEntries = await fs.promises.readdir(sourceRoot, { withFileTypes: true });
  entries.push({ name: `${id}/`, directory: true });
  rootEntries.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of rootEntries) await walk(path.join(sourceRoot, child.name), `${id}/${child.name}`, true);

  const completion = pipeline(zip.outputStream as NodeJS.ReadableStream, output);
  try {
    for (const entry of entries) {
      if (entry.directory) zip.addEmptyDirectory(entry.name);
      else zip.addFile(entry.full!, entry.name);
    }
    zip.end();
    await completion;
  } catch (err) {
    output.destroy(err instanceof Error ? err : new Error(String(err)));
    await completion.catch(() => undefined);
    throw err;
  }
}

/** Stream upload to a private staging area, validate/extract it and register a stopped instance. */
export async function importWorldArchive(originalName: string, input: AsyncIterable<Uint8Array>, onLog?: (line: string) => void): Promise<InstanceConfig> {
  const uploadedName = archiveName(originalName);
  const importRoot = path.join(INSTANCES_DIR, `.import-${crypto.randomUUID()}`);
  const uploadDir = path.join(STORE_DIR, 'world-imports');
  const uploadFile = path.join(uploadDir, `.upload-${crypto.randomUUID()}.part`);
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(importRoot, { recursive: false });
  let handle: fs.promises.FileHandle | undefined;
  let bytes = 0;
  let tooLarge = false;
  let created: InstanceConfig | null = null;
  try {
    onLog?.(`开始接收世界压缩包：${uploadedName}`);
    handle = await fs.promises.open(uploadFile, 'wx');
    let nextLogAt = 512 * 1024 * 1024;
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > MAX_WORLD_ARCHIVE_UPLOAD_BYTES) {
        tooLarge = true;
        continue;
      }
      await handle.writeFile(chunk);
      if (bytes >= nextLogAt) {
        onLog?.(`已接收 ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
        nextLogAt += 512 * 1024 * 1024;
      }
    }
    await handle.close();
    handle = undefined;
    if (tooLarge) throw payloadTooLarge('世界 ZIP 超过 20 GB 上传限制', 'World ZIP exceeds the 20 GB upload limit.');
    if (bytes < 22) throw bad('上传的文件不是有效 ZIP 文件');
    onLog?.(`上传完成：${(bytes / 1024 / 1024).toFixed(1)} MB，开始校验压缩包`);

    let inspected: { entries: ArchiveEntryInfo[]; prefix: string; config: ArchiveConfig };
    try {
      inspected = await inspectArchive(uploadFile);
    } catch (err) {
      throw bad(`世界 ZIP 校验失败：${err instanceof Error ? err.message : String(err)}`);
    }
    onLog?.(`校验通过：${inspected.entries.length} 个条目，开始解压世界文件`);
    await extractArchive(uploadFile, importRoot, inspected.entries);
    const id = uniqueInstanceId(inspected.config.id, inspected.config.name);
    const loader = inspected.config.loader;
    created = await I.createInstance({
      id,
      name: inspected.config.name.trim(),
      mc: inspected.config.mc,
      loader,
      loaderVersion: typeof inspected.config.loaderVersion === 'string' ? inspected.config.loaderVersion : '',
      memoryMb: Number(inspected.config.memoryMb) || 3072,
      minMemoryMb: Number(inspected.config.minMemoryMb) || 1024,
      createdFrom: { type: 'import', source: inspected.config.id },
      importedFrom: { file: uploadedName, format: 'blockcraft-instance' },
    });
    onLog?.(`世界文件已解压并登记：${created.name}（${created.id}）`);

    const newRoot = instanceDir(created.id);
    const rootItems = await fs.promises.readdir(importRoot, { withFileTypes: true });
    for (const item of rootItems) {
      if (['config.json', 'config.json.bak', 'state.json', 'state.json.bak'].includes(item.name.toLowerCase())) continue;
      const from = path.join(importRoot, item.name);
      const to = path.join(newRoot, item.name);
      await fs.promises.rm(to, { recursive: true, force: true });
      await fs.promises.cp(from, to, { recursive: true, force: true, errorOnExist: false });
    }

    I.saveConfig(created.id, importedConfigPatch(inspected.config, created, uploadedName));
    I.saveState(created.id, { status: 'stopped', pid: null, startedAt: null, intentionalStop: true, phase: '', progress: null, lastError: null });
    I.writeProperties(created.id);
    return I.getConfig(created.id);
  } catch (err) {
    if (created) {
      await I.deleteInstance(created.id, true).catch(() => undefined);
    }
    const code = (err as NodeJS.ErrnoException)?.code;
    if (['ENOSPC', 'EACCES', 'EPERM', 'EROFS'].includes(String(code))) {
      throw new Error(`无法导入世界，请检查磁盘空间和 instances 目录权限（${code}）`);
    }
    throw err;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(uploadFile, { force: true }).catch(() => undefined);
    await fs.promises.rm(importRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
