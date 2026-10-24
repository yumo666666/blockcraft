import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable, type Writable } from 'node:stream';
// @ts-ignore yauzl is CommonJS and its declarations are intentionally narrow.
import yauzlModule from 'yauzl';
// @ts-ignore yazl is CommonJS and does not ship declarations.
import yazlModule from 'yazl';
import { bad, conflict, notFound, payloadTooLarge } from '../core/errors.ts';
import type { FileEntry } from './fileManagerService.ts';
import { MAX_EDIT_BYTES, MAX_PREVIEW_BYTES, MAX_UPLOAD_BYTES, resolveProjectTarget, validateProjectFileName } from './projectFileService.ts';

const MAX_JAR_ENTRIES = 50_000;
const MAX_PREVIEW_SAMPLE_BYTES = 64 * 1024;
const EDITABLE_EXTENSIONS = new Set([
  '.bat', '.cfg', '.conf', '.csv', '.css', '.ftl', '.gradle', '.html', '.ini', '.js', '.json',
  '.json5', '.jsonc', '.list', '.log', '.md', '.mcfunction', '.mcmeta', '.mjs', '.properties',
  '.ps1', '.sh', '.sql', '.svg', '.toml', '.ts', '.txt', '.xml', '.yaml', '.yml',
]);
const PREVIEW_MIME: Record<string, string> = {
  '.aac': 'audio/aac', '.avif': 'image/avif', '.bmp': 'image/bmp', '.flac': 'audio/flac', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.ogg': 'audio/ogg', '.ogv': 'video/ogg', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.webm': 'video/webm', '.webp': 'image/webp', '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
};

type JarEntryRecord = {
  source: ZipEntry;
  path: string;
  directory: boolean;
  modifiedAt: string;
  size: number;
  mode: number;
  compressionMethod: number;
};
type ZipEntry = {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  externalFileAttributes?: number;
  getLastModDate?: () => Date;
};
type ZipFile = {
  readEntry: () => void;
  close: () => void;
  openReadStream: (entry: ZipEntry, cb: (error: Error | null, stream?: NodeJS.ReadableStream) => void) => void;
  on: (event: string, listener: (...args: any[]) => void) => ZipFile;
};
type JarIndex = {
  zip: ZipFile;
  records: JarEntryRecord[];
  target: { virtualPath: string; fullPath: string; lstat: fs.Stats };
  signed: boolean;
  unsafeNames: boolean;
  zipClosed: boolean;
};
type YazlFile = {
  addEmptyDirectory: (name: string, options?: Record<string, unknown>) => void;
  addBuffer: (buffer: Buffer, name: string, options?: Record<string, unknown>) => void;
  addReadStreamLazy: (name: string, options: Record<string, unknown>, getReadStream: (cb: (error: Error | null, stream?: NodeJS.ReadableStream) => void) => void) => void;
  end: () => void;
  outputStream: Readable & { destroy: (error?: Error) => void };
};
type Replacement = { buffer?: Buffer; filePath?: string };
type JarMutation = {
  replacements?: Map<string, Replacement>;
  deletePaths?: string[];
  directories?: string[];
};

const yauzl = yauzlModule as unknown as { open: (file: string, options: Record<string, unknown>, cb: (error: Error | null, zip?: ZipFile) => void) => void };
const yazl = yazlModule as unknown as { ZipFile: new () => YazlFile };
const mutationQueues = new Map<string, Promise<void>>();

function normalizeJarPath(rawPath: unknown): string {
  if (typeof rawPath !== 'string' || rawPath.length > 4096 || rawPath.startsWith('/') || rawPath.includes('\\') || rawPath.includes('\0') || /^[A-Za-z]:/.test(rawPath)) {
    throw bad('JAR 内部路径无效');
  }
  if (!rawPath) return '';
  const parts = rawPath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) {
    throw bad('JAR 内部路径包含不允许的名称');
  }
  return parts.join('/');
}

function safeEntryPath(rawName: string): string | null {
  const normalized = rawName.replace(/\\/g, '/').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) return null;
  return parts.join('/');
}

function entryMode(entry: ZipEntry): number {
  return ((entry.externalFileAttributes ?? 0) >>> 16) & 0xffff;
}

function isSymlink(entry: ZipEntry): boolean {
  return (entryMode(entry) & 0xf000) === 0xa000;
}

function isDirectory(entry: ZipEntry): boolean {
  return entry.fileName.endsWith('/') || (entryMode(entry) & 0xf000) === 0x4000;
}

function isSignedEntry(entryPath: string): boolean {
  return /^META-INF\/(?:[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]+)$/i.test(entryPath);
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('无法打开 JAR 文件'));
      else resolve(zip);
    });
  });
}

function closeJar(index: JarIndex): void {
  if (index.zipClosed) return;
  index.zipClosed = true;
  index.zip.close();
}

async function inspectJar(rawArchivePath: unknown): Promise<JarIndex> {
  const target = await resolveProjectTarget(rawArchivePath);
  if (target.lstat.isSymbolicLink() || !target.lstat.isFile()) throw bad('所选路径不是普通 JAR 文件');
  if (path.extname(target.virtualPath).toLowerCase() !== '.jar') throw bad('所选文件不是 JAR 文件');
  const zip = await openZip(target.fullPath);
  return new Promise((resolve, reject) => {
    const records: JarEntryRecord[] = [];
    const names = new Set<string>();
    let signed = false;
    let unsafeNames = false;
    let seenEntries = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on('entry', (entry: ZipEntry) => {
      if (settled) return;
      seenEntries += 1;
      if (seenEntries > MAX_JAR_ENTRIES) {
        fail(payloadTooLarge('JAR 内条目超过 50,000 个，无法在面板中浏览', 'JAR files with more than 50,000 entries cannot be browsed in the panel.'));
        return;
      }
      const directory = isDirectory(entry);
      const safePath = safeEntryPath(entry.fileName);
      if (!safePath || isSymlink(entry)) {
        unsafeNames = true;
        zip.readEntry();
        return;
      }
      const key = `${safePath}${directory ? '/' : ''}`;
      if (names.has(key)) {
        fail(bad(`JAR 内存在重复路径：${safePath}`));
        return;
      }
      names.add(key);
      signed ||= isSignedEntry(safePath);
      const date = entry.getLastModDate?.();
      records.push({
        source: entry,
        path: safePath,
        directory,
        modifiedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : target.lstat.mtime.toISOString(),
        size: directory ? 0 : entry.uncompressedSize,
        mode: entryMode(entry),
        compressionMethod: entry.compressionMethod,
      });
      zip.readEntry();
    });
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ zip, records, target, signed, unsafeNames, zipClosed: false });
    });
    zip.on('error', (error: Error) => fail(error));
    zip.readEntry();
  });
}

function archiveHasPath(index: JarIndex, requested: string): boolean {
  return index.records.some((record) => record.path === requested && record.directory)
    || index.records.some((record) => record.path.startsWith(`${requested}/`));
}

function assertJarDirectory(index: JarIndex, rawPath: unknown): string {
  const directory = normalizeJarPath(rawPath);
  if (directory && !archiveHasPath(index, directory)) throw notFound('JAR 内文件夹不存在');
  return directory;
}

function entryFromJar(record: JarEntryRecord, parentPath: string, archive = false, fallbackModifiedAt = new Date(0).toISOString()): FileEntry {
  const name = record.path.split('/').at(-1) ?? record.path;
  const virtualPath = parentPath ? `${parentPath}/${name}` : name;
  return {
    name,
    path: virtualPath,
    type: record.directory ? 'directory' : 'file',
    size: record.directory ? null : record.size,
    modifiedAt: record.modifiedAt || fallbackModifiedAt,
    editable: !record.directory && record.size <= MAX_EDIT_BYTES && EDITABLE_EXTENSIONS.has(path.posix.extname(name).toLowerCase()),
    previewable: !record.directory,
    deletable: true,
    archive: archive || undefined,
  };
}

export async function listProjectJarDirectory(rawArchivePath: unknown, rawPath: unknown): Promise<{ path: string; entries: FileEntry[]; signed: boolean }> {
  const index = await inspectJar(rawArchivePath);
  try {
    const currentPath = assertJarDirectory(index, rawPath);
    const prefix = currentPath ? `${currentPath}/` : '';
    const children = new Map<string, JarEntryRecord>();
    for (const record of index.records) {
      if (record.path === currentPath || !record.path.startsWith(prefix)) continue;
      const remainder = record.path.slice(prefix.length);
      if (!remainder) continue;
      const first = remainder.split('/')[0];
      const childPath = currentPath ? `${currentPath}/${first}` : first;
      const nested = remainder.includes('/');
      const isChildDirectory = nested || record.directory;
      const existing = children.get(first);
      if (isChildDirectory) {
        if (!existing || !existing.directory) {
          children.set(first, {
            source: record.source,
            path: childPath,
            directory: true,
            modifiedAt: record.modifiedAt,
            size: 0,
            mode: 0,
            compressionMethod: 0,
          });
        }
      } else if (!existing) children.set(first, record);
    }
    const entries = [...children.values()].map((record) => entryFromJar(record, currentPath, false, index.target.lstat.mtime.toISOString()));
    entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1)
      || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    return { path: currentPath, entries, signed: index.signed };
  } finally {
    closeJar(index);
  }
}

function findJarRecord(index: JarIndex, rawPath: unknown): JarEntryRecord {
  const entryPath = normalizeJarPath(rawPath);
  if (!entryPath) throw bad('请选择 JAR 内的文件');
  const record = index.records.find((item) => item.path === entryPath && !item.directory);
  if (!record) throw notFound('JAR 内文件不存在');
  return record;
}

function readJarEntryPrefix(index: JarIndex, record: JarEntryRecord, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    index.zip.openReadStream(record.source, (error, rawStream) => {
      if (error || !rawStream) {
        reject(error ?? new Error('读取 JAR 条目失败'));
        return;
      }
      const stream = rawStream as Readable;
      const chunks: Buffer[] = [];
      let bytes = 0;
      let done = false;
      const finish = (result?: Buffer, failure?: Error) => {
        if (done) return;
        done = true;
        if (failure) reject(failure);
        else resolve(result ?? Buffer.alloc(0));
      };
      stream.on('data', (chunk: Buffer) => {
        if (done) return;
        const remaining = maxBytes - bytes;
        if (remaining <= 0) {
          stream.destroy();
          finish(Buffer.concat(chunks));
          return;
        }
        const part = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(part);
        bytes += part.byteLength;
        if (bytes >= maxBytes && record.size > maxBytes) {
          stream.destroy();
          finish(Buffer.concat(chunks));
        }
      });
      stream.on('error', (streamError) => finish(undefined, streamError instanceof Error ? streamError : new Error(String(streamError))));
      stream.on('end', () => finish(Buffer.concat(chunks)));
    });
  });
}

function hexPreview(bytes: Buffer): string {
  const rows: string[] = [];
  for (let offset = 0; offset < Math.min(bytes.length, 256); offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = [...row].map((byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
    rows.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  return rows.join('\n');
}

export async function getProjectJarTextFile(rawArchivePath: unknown, rawPath: unknown): Promise<{ path: string; name: string; content: string; revision: string }> {
  const index = await inspectJar(rawArchivePath);
  try {
    const record = findJarRecord(index, rawPath);
    const name = path.posix.basename(record.path);
    if (!EDITABLE_EXTENSIONS.has(path.posix.extname(name).toLowerCase())) throw bad('此 JAR 条目类型不支持在线编辑');
    if (record.size > MAX_EDIT_BYTES) throw payloadTooLarge('文本文件超过 2 MB，不能在线编辑', 'Text files larger than 2 MB cannot be edited in the panel.');
    const bytes = await readJarEntryPrefix(index, record, MAX_EDIT_BYTES + 1);
    if (bytes.byteLength > MAX_EDIT_BYTES) throw payloadTooLarge('文本文件超过 2 MB，不能在线编辑', 'Text files larger than 2 MB cannot be edited in the panel.');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw bad('文件不是有效的 UTF-8 文本，无法在线编辑'); }
    return { path: record.path, name, content, revision: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally {
    closeJar(index);
  }
}

async function withJarMutation<T>(rawArchivePath: unknown, action: (index: JarIndex) => Promise<T>): Promise<T> {
  const initial = await resolveProjectTarget(rawArchivePath);
  const key = path.resolve(initial.fullPath);
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  mutationQueues.set(key, queued);
  await previous;
  try {
    const index = await inspectJar(rawArchivePath);
    try {
      if (index.unsafeNames) throw bad('JAR 包含不安全或符号链接路径；为避免改写时丢失内容，暂不能修改');
      return await action(index);
    } finally {
      closeJar(index);
    }
  } finally {
    release();
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  }
}

async function rewriteJar(index: JarIndex, mutation: JarMutation): Promise<boolean> {
  const targetPath = index.target.fullPath;
  const sourceStat = index.target.lstat;
  for (const record of index.records) {
    if (!record.directory && record.compressionMethod !== 0 && record.compressionMethod !== 8) {
      throw bad(`JAR 使用暂不支持修改的压缩方式：${record.path}`);
    }
  }
  const tempPath = path.join(path.dirname(targetPath), `.blockcraft-jar-edit-${crypto.randomUUID()}.tmp`);
  const outputZip = new yazl.ZipFile();
  const replacements = mutation.replacements ?? new Map<string, Replacement>();
  const deletePaths = mutation.deletePaths ?? [];
  const directories = [...new Set(mutation.directories ?? [])];
  const writtenNames = new Set<string>();
  const signaturesRemoved = index.signed && (replacements.size > 0 || deletePaths.length > 0 || directories.length > 0);
  const isDeleted = (entryPath: string) => deletePaths.some((parent) => entryPath === parent || entryPath.startsWith(`${parent}/`));
  const completion = pipeline(outputZip.outputStream, fs.createWriteStream(tempPath, { flags: 'wx' }));
  try {
    for (const record of index.records) {
      if (signaturesRemoved && isSignedEntry(record.path)) continue;
      if (isDeleted(record.path) || replacements.has(record.path)) continue;
      const zipName = `${record.path}${record.directory ? '/' : ''}`;
      if (writtenNames.has(zipName)) continue;
      writtenNames.add(zipName);
      if (record.directory) {
        outputZip.addEmptyDirectory(zipName, { mtime: new Date(record.modifiedAt), mode: record.mode || 0o40775 });
        continue;
      }
      outputZip.addReadStreamLazy(zipName, {
        mtime: new Date(record.modifiedAt),
        mode: record.mode || 0o100664,
        compress: record.compressionMethod === 8,
        size: record.size,
        forceZip64Format: true,
      }, (cb) => index.zip.openReadStream(record.source, (error, stream) => cb(error, stream)));
    }
    for (const [entryPath, replacement] of replacements) {
      if (isDeleted(entryPath) || (signaturesRemoved && isSignedEntry(entryPath))) continue;
      const zipName = entryPath;
      if (writtenNames.has(zipName)) continue;
      if (replacement.buffer) {
        outputZip.addBuffer(replacement.buffer, zipName, { mtime: new Date(), mode: 0o100664, forceZip64Format: true });
      } else if (replacement.filePath) {
        const stream = fs.createReadStream(replacement.filePath);
        outputZip.addReadStreamLazy(zipName, { mtime: new Date(), mode: 0o100664, forceZip64Format: true }, (cb) => cb(null, stream));
      }
      writtenNames.add(zipName);
    }
    for (const directory of directories) {
      const zipName = `${directory}/`;
      if (writtenNames.has(zipName)) continue;
      outputZip.addEmptyDirectory(zipName, { mtime: new Date(), mode: 0o40775 });
      writtenNames.add(zipName);
    }
    outputZip.end();
    await completion;
    const latest = await fsp.lstat(targetPath);
    if (latest.isSymbolicLink() || !latest.isFile() || latest.size !== sourceStat.size || latest.mtimeMs !== sourceStat.mtimeMs) {
      throw conflict('JAR 在修改期间发生变化，请刷新后重试');
    }
    closeJar(index);
    await fsp.chmod(tempPath, sourceStat.mode).catch(() => undefined);
    await fsp.rename(tempPath, targetPath);
    return signaturesRemoved;
  } catch (error) {
    outputZip.outputStream.destroy(error instanceof Error ? error : new Error(String(error)));
    await completion.catch(() => undefined);
    throw error;
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function saveProjectJarTextFile(rawArchivePath: unknown, rawPath: unknown, content: unknown, revision: unknown): Promise<{ revision: string; signatureInvalidated: boolean }> {
  if (typeof content !== 'string' || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw bad('编辑内容或版本标记无效');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > MAX_EDIT_BYTES) throw payloadTooLarge('文本文件不能超过 2 MB', 'Text files are limited to 2 MB.');
  return withJarMutation(rawArchivePath, async (index) => {
    const record = findJarRecord(index, rawPath);
    if (!EDITABLE_EXTENSIONS.has(path.posix.extname(record.path).toLowerCase())) throw bad('此 JAR 条目类型不支持在线编辑');
    if (record.size > MAX_EDIT_BYTES) throw payloadTooLarge('文本文件超过 2 MB，不能在线编辑', 'Text files larger than 2 MB cannot be edited in the panel.');
    const current = await readJarEntryPrefix(index, record, MAX_EDIT_BYTES + 1);
    if (crypto.createHash('sha256').update(current).digest('hex') !== revision) throw conflict('JAR 内文件内容已变化，请重新打开后再保存');
    const signatureInvalidated = await rewriteJar(index, { replacements: new Map([[record.path, { buffer: bytes }]]) });
    return { revision: crypto.createHash('sha256').update(bytes).digest('hex'), signatureInvalidated };
  });
}

export async function getProjectJarPreviewInfo(rawArchivePath: unknown, rawPath: unknown): Promise<{
  kind: 'image' | 'audio' | 'video' | 'pdf' | 'html' | 'text' | 'binary' | 'large';
  contentType?: string;
  size: number;
  content?: string;
  hex?: string;
  truncated?: boolean;
  note?: string;
}> {
  const index = await inspectJar(rawArchivePath);
  try {
    const record = findJarRecord(index, rawPath);
    const extension = path.posix.extname(record.path).toLowerCase();
    if (record.size > MAX_PREVIEW_BYTES) return { kind: 'large', size: record.size, note: '文件超过 64 MB，页面展示文件信息；可下载原文件查看完整内容。' };
    const contentType = PREVIEW_MIME[extension];
    if (contentType?.startsWith('image/')) return { kind: 'image', contentType, size: record.size };
    if (contentType?.startsWith('audio/')) return { kind: 'audio', contentType, size: record.size };
    if (contentType?.startsWith('video/')) return { kind: 'video', contentType, size: record.size };
    if (contentType === 'application/pdf') return { kind: 'pdf', contentType, size: record.size };
    if (extension === '.html' || extension === '.htm') return { kind: 'html', contentType: 'text/html; charset=utf-8', size: record.size };
    const sample = await readJarEntryPrefix(index, record, MAX_PREVIEW_SAMPLE_BYTES);
    const truncated = record.size > sample.byteLength;
    try {
      if (sample.includes(0)) throw new Error('binary');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(sample);
      return { kind: 'text', contentType: 'text/plain; charset=utf-8', size: record.size, content, truncated };
    } catch {
      return { kind: 'binary', size: record.size, hex: hexPreview(sample), truncated, note: '此文件不是可直接渲染的文本或媒体格式，下面显示文件开头的十六进制内容。' };
    }
  } finally {
      closeJar(index);
  }
}

export async function resolveProjectJarEntry(rawArchivePath: unknown, rawPath: unknown): Promise<{
  archivePath: string;
  entryPath: string;
  name: string;
  size: number;
  modifiedAt: string;
  contentType: string;
  stream: Readable;
  compressionMethod: number;
}> {
  const index = await inspectJar(rawArchivePath);
  try {
    const record = findJarRecord(index, rawPath);
    const extension = path.posix.extname(record.path).toLowerCase();
    const contentType = PREVIEW_MIME[extension] ?? 'application/octet-stream';
    const rawStream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      index.zip.openReadStream(record.source, (error, stream) => {
        if (error || !stream) reject(error ?? new Error('读取 JAR 条目失败'));
        else resolve(stream);
      });
    });
    const stream = rawStream as Readable;
    const closeZip = () => closeJar(index);
    stream.once('end', closeZip);
    stream.once('close', closeZip);
    stream.once('error', closeZip);
    return {
      archivePath: index.target.virtualPath,
      entryPath: record.path,
      name: path.posix.basename(record.path),
      size: record.size,
      modifiedAt: record.modifiedAt,
      contentType,
      stream,
      compressionMethod: record.compressionMethod,
    };
  } catch (error) {
    closeJar(index);
    throw error;
  }
}

export async function resolveProjectJarEntryMetadata(rawArchivePath: unknown, rawPath: unknown): Promise<{
  archivePath: string;
  entryPath: string;
  name: string;
  size: number;
  modifiedAt: string;
}> {
  const index = await inspectJar(rawArchivePath);
  try {
    const record = findJarRecord(index, rawPath);
    return { archivePath: index.target.virtualPath, entryPath: record.path, name: path.posix.basename(record.path), size: record.size, modifiedAt: record.modifiedAt };
  } finally {
    closeJar(index);
  }
}

export async function createProjectJarDirectory(rawArchivePath: unknown, rawParent: unknown, rawName: unknown): Promise<{ entry: FileEntry; signatureInvalidated: boolean }> {
  const name = validateProjectFileName(rawName);
  return withJarMutation(rawArchivePath, async (index) => {
    const parent = assertJarDirectory(index, rawParent);
    const entryPath = parent ? `${parent}/${name}` : name;
    if (index.records.some((record) => record.path === entryPath || record.path.startsWith(`${entryPath}/`))) throw conflict('JAR 内已有同名文件或文件夹');
    const signatureInvalidated = await rewriteJar(index, { directories: [entryPath] });
    const now = new Date().toISOString();
    return { entry: { name, path: entryPath, type: 'directory', size: null, modifiedAt: now, editable: false, previewable: false, deletable: true }, signatureInvalidated };
  });
}

export async function uploadProjectJarFile(rawArchivePath: unknown, rawParent: unknown, rawName: unknown, input: NodeJS.ReadableStream, contentLength: number): Promise<{ entry: FileEntry; signatureInvalidated: boolean }> {
  const name = validateProjectFileName(rawName);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) throw payloadTooLarge('单个文件不能超过 10 GB', 'A single file is limited to 10 GB.');
  const initial = await resolveProjectTarget(rawArchivePath);
  const tempPath = path.join(path.dirname(initial.fullPath), `.blockcraft-jar-upload-${crypto.randomUUID()}.tmp`);
  let bytes = 0;
  let exceeded = false;
  const limiter = new Transform({ transform(chunk: Buffer | string, _encoding, callback) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_UPLOAD_BYTES) { exceeded = true; callback(null); return; }
    callback(null, chunk);
  } });
  try {
    await pipeline(input, limiter, fs.createWriteStream(tempPath, { flags: 'wx' }));
    if (exceeded) throw payloadTooLarge('单个文件不能超过 10 GB', 'A single file is limited to 10 GB.');
    return await withJarMutation(rawArchivePath, async (index) => {
      const parent = assertJarDirectory(index, rawParent);
      const entryPath = parent ? `${parent}/${name}` : name;
      if (index.records.some((record) => record.path === entryPath || record.path.startsWith(`${entryPath}/`))) throw conflict('JAR 内已有同名文件或文件夹');
      const signatureInvalidated = await rewriteJar(index, { replacements: new Map([[entryPath, { filePath: tempPath }]]) });
      return {
        entry: { name, path: entryPath, type: 'file', size: bytes, modifiedAt: new Date().toISOString(), editable: bytes <= MAX_EDIT_BYTES && EDITABLE_EXTENSIONS.has(path.extname(name).toLowerCase()), previewable: true, deletable: true },
        signatureInvalidated,
      };
    });
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function deleteProjectJarEntries(rawArchivePath: unknown, rawPaths: unknown): Promise<{ entries: Array<{ path: string; type: 'directory' | 'file'; name: string }>; signatureInvalidated: boolean }> {
  if (!Array.isArray(rawPaths) || rawPaths.length < 1 || rawPaths.length > 1000) throw bad('请选择 1 到 1000 个 JAR 内文件或文件夹');
  const unique = [...new Set(rawPaths.map(normalizeJarPath))];
  if (unique.some((item) => !item)) throw bad('JAR 根目录不能删除');
  unique.sort((a, b) => a.length - b.length);
  const selected = unique.filter((item, index) => !unique.slice(0, index).some((parent) => item.startsWith(`${parent}/`)));
  return withJarMutation(rawArchivePath, async (index) => {
    const result: Array<{ path: string; type: 'directory' | 'file'; name: string }> = [];
    for (const entryPath of selected) {
      const record = index.records.find((item) => item.path === entryPath);
      const directory = Boolean(record?.directory) || archiveHasPath(index, entryPath);
      if (!record && !directory) throw notFound(`JAR 内文件不存在：${entryPath}`);
      result.push({ path: entryPath, type: directory ? 'directory' : 'file', name: path.posix.basename(entryPath) });
    }
    const signatureInvalidated = await rewriteJar(index, { deletePaths: selected });
    return { entries: result, signatureInvalidated };
  });
}

export async function writeProjectJarArchive(rawArchivePath: unknown, rawPaths: unknown, output: Writable): Promise<{ count: number }> {
  if (!Array.isArray(rawPaths) || rawPaths.length < 1 || rawPaths.length > 1000) throw bad('请选择 1 到 1000 个 JAR 内文件或文件夹');
  const unique = [...new Set(rawPaths.map(normalizeJarPath))];
  if (unique.some((item) => !item)) throw bad('请选择 JAR 根目录下的项目');
  unique.sort((a, b) => a.length - b.length);
  const selected = unique.filter((item, index) => !unique.slice(0, index).some((parent) => item.startsWith(`${parent}/`)));
  const index = await inspectJar(rawArchivePath);
  const zipOutput = new yazl.ZipFile();
  let completion: Promise<void> | undefined;
  try {
    const selectedRecords = index.records.filter((record) => selected.some((requested) => record.path === requested || record.path.startsWith(`${requested}/`)));
    if (!selectedRecords.length) throw notFound('所选项目在 JAR 中不存在');
    completion = pipeline(zipOutput.outputStream, output);
    for (const record of selectedRecords) {
      const zipName = `${record.path}${record.directory ? '/' : ''}`;
      if (record.directory) zipOutput.addEmptyDirectory(zipName, { mtime: new Date(record.modifiedAt) });
      else zipOutput.addReadStreamLazy(zipName, { mtime: new Date(record.modifiedAt), compress: record.compressionMethod === 8, size: record.size, forceZip64Format: true }, (cb) => index.zip.openReadStream(record.source, (error, stream) => cb(error, stream)));
    }
    zipOutput.end();
    await completion;
    return { count: selectedRecords.length };
  } catch (error) {
    zipOutput.outputStream.destroy(error instanceof Error ? error : new Error(String(error)));
    await completion?.catch(() => undefined);
    throw error;
  } finally {
    closeJar(index);
  }
}
