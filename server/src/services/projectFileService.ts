import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
// @ts-ignore yazl is CommonJS and does not ship declarations.
import yazlModule from 'yazl';
import { PROJECT_ROOT } from '../core/paths.ts';
import { bad, conflict, notFound, payloadTooLarge } from '../core/errors.ts';
import type { FileEntry, FileEntryType, ResolvedFile } from './fileManagerService.ts';

export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 50_000;
const PREVIEW_SAMPLE_BYTES = 64 * 1024;

const yazl = yazlModule as unknown as {
  ZipFile: new () => {
    addFile: (realPath: string, metadataPath: string) => void;
    addEmptyDirectory: (metadataPath: string) => void;
    end: () => void;
    outputStream: NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
  };
};

const EDITABLE_EXTENSIONS = new Set([
  '.bat', '.cfg', '.conf', '.csv', '.css', '.ftl', '.gradle', '.html', '.ini', '.json',
  '.js', '.json5', '.jsonc', '.list', '.log', '.md', '.mcfunction', '.mcmeta', '.mjs',
  '.properties', '.ps1', '.sh', '.sql', '.svg', '.toml', '.ts', '.txt', '.xml', '.yaml', '.yml',
]);
const PREVIEW_MIME: Record<string, string> = {
  '.aac': 'audio/aac', '.avif': 'image/avif', '.bmp': 'image/bmp', '.flac': 'audio/flac', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4', '.md': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.ogg': 'audio/ogg', '.ogv': 'video/ogg',
  '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav', '.webm': 'video/webm', '.webp': 'image/webp', '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
};
const INLINE_MEDIA_MIME: Record<string, string> = {
  '.aac': 'audio/aac', '.avif': 'image/avif', '.bmp': 'image/bmp', '.flac': 'audio/flac', '.gif': 'image/gif', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.ogg': 'audio/ogg', '.ogv': 'video/ogg', '.pdf': 'application/pdf',
  '.png': 'image/png', '.webm': 'video/webm', '.webp': 'image/webp', '.wav': 'audio/wav',
};
export interface FilePreviewInfo {
  kind: 'image' | 'audio' | 'video' | 'pdf' | 'html' | 'text' | 'binary' | 'large';
  contentType?: string;
  size: number;
  content?: string;
  hex?: string;
  truncated?: boolean;
  note?: string;
}

function normalizeVirtualPath(value: unknown): string {
  if (typeof value !== 'string') throw bad('文件路径无效');
  if (!value) return '';
  if (value.length > 4096 || value.startsWith('/') || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:/.test(value)) {
    throw bad('文件路径无效');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) {
    throw bad('文件路径包含不允许的目录名');
  }
  return parts.join('/');
}

function joinVirtual(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

async function projectRoot(): Promise<string> {
  const root = await fsp.realpath(PROJECT_ROOT);
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory()) throw bad('项目目录不可用');
  return root;
}

async function resolveProject(rawPath: unknown, allowFinalLink = false): Promise<{ virtualPath: string; fullPath: string; lstat: fs.Stats }> {
  const virtualPath = normalizeVirtualPath(rawPath);
  const root = await projectRoot();
  if (!virtualPath) return { virtualPath, fullPath: root, lstat: await fsp.lstat(root) };
  let current = root;
  const parts = virtualPath.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound('文件或目录不存在');
      throw error;
    }
    const final = index === parts.length - 1;
    if (stat.isSymbolicLink()) {
      if (final && allowFinalLink) return { virtualPath, fullPath: current, lstat: stat };
      throw bad('为保护项目目录，不能穿过符号链接');
    }
    if (!final && !stat.isDirectory()) throw notFound('路径中的目录不存在');
  }
  return { virtualPath, fullPath: current, lstat: await fsp.lstat(current) };
}

function isEditable(name: string, size: number | null): boolean {
  return size !== null && size <= MAX_EDIT_BYTES && EDITABLE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

async function entryAtPath(fullPath: string, virtualPath: string, name: string): Promise<FileEntry> {
  const stat = await fsp.lstat(fullPath);
  if (stat.isSymbolicLink()) {
    return { name, path: virtualPath, type: 'link', size: null, modifiedAt: stat.mtime.toISOString(), editable: false, previewable: false, deletable: true };
  }
  const directory = stat.isDirectory();
  const size = directory ? null : stat.size;
  return {
    name, path: virtualPath, type: directory ? 'directory' : 'file', size, modifiedAt: stat.mtime.toISOString(),
    editable: !directory && isEditable(name, size), previewable: !directory, deletable: true,
    archive: !directory && path.extname(name).toLowerCase() === '.jar',
  };
}

export async function resolveProjectTarget(rawPath: unknown, allowFinalLink = false): Promise<{ virtualPath: string; fullPath: string; lstat: fs.Stats }> {
  return resolveProject(rawPath, allowFinalLink);
}

export async function listProjectDirectory(rawPath: unknown): Promise<{ path: string; entries: FileEntry[]; rootName: string; projectRoot: string }> {
  const target = await resolveProject(rawPath);
  if (!target.lstat.isDirectory()) throw bad('所选路径不是文件夹');
  const names = (await fsp.readdir(target.fullPath)).filter((name) => !name.startsWith('.blockcraft-upload-') && !name.startsWith('.blockcraft-edit-') && !name.startsWith('.blockcraft-jar-'));
  const entries = await Promise.all(names.map((name) => entryAtPath(path.join(target.fullPath, name), joinVirtual(target.virtualPath, name), name)));
  entries.sort((a, b) => {
    const kind = (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1);
    return kind || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
  const root = await projectRoot();
  return { path: target.virtualPath, entries, rootName: path.basename(root), projectRoot: root };
}

function assertRegularFile(target: { lstat: fs.Stats }): void {
  if (target.lstat.isSymbolicLink()) throw bad('符号链接不能读取或下载');
  if (!target.lstat.isFile()) throw bad('所选路径不是文件');
}

export async function getProjectTextFile(rawPath: unknown): Promise<{ path: string; name: string; content: string; revision: string }> {
  const target = await resolveProject(rawPath);
  assertRegularFile(target);
  const name = path.posix.basename(target.virtualPath);
  if (!EDITABLE_EXTENSIONS.has(path.extname(name).toLowerCase())) throw bad('此文件类型不支持在线编辑');
  if (target.lstat.size > MAX_EDIT_BYTES) throw payloadTooLarge('文本文件超过 2 MB，不能在线编辑', 'Text files larger than 2 MB cannot be edited in the panel.');
  const bytes = await fsp.readFile(target.fullPath);
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw bad('文件不是有效的 UTF-8 文本，无法在线编辑'); }
  return { path: target.virtualPath, name, content, revision: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export async function saveProjectTextFile(rawPath: unknown, content: unknown, revision: unknown): Promise<{ revision: string }> {
  if (typeof content !== 'string' || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw bad('编辑内容或版本标记无效');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > MAX_EDIT_BYTES) throw payloadTooLarge('文本文件不能超过 2 MB', 'Text files are limited to 2 MB.');
  const target = await resolveProject(rawPath);
  assertRegularFile(target);
  const name = path.posix.basename(target.virtualPath);
  if (!EDITABLE_EXTENSIONS.has(path.extname(name).toLowerCase())) throw bad('此文件类型不支持在线编辑');
  if (target.lstat.size > MAX_EDIT_BYTES) throw payloadTooLarge('文本文件超过 2 MB，不能在线编辑', 'Text files larger than 2 MB cannot be edited in the panel.');
  const current = await fsp.readFile(target.fullPath);
  if (crypto.createHash('sha256').update(current).digest('hex') !== revision) throw conflict('文件内容已被其他进程修改，请重新打开后再保存');
  const temp = path.join(path.dirname(target.fullPath), `.blockcraft-edit-${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temp, bytes, { flag: 'wx', mode: target.lstat.mode });
    const latest = await fsp.lstat(target.fullPath);
    if (latest.isSymbolicLink() || !latest.isFile()) throw conflict('目标文件已变化，请刷新后重试');
    const latestBytes = await fsp.readFile(target.fullPath);
    if (crypto.createHash('sha256').update(latestBytes).digest('hex') !== revision) throw conflict('文件内容已被其他进程修改，请重新打开后再保存');
    await fsp.rename(temp, target.fullPath);
  } finally { await fsp.rm(temp, { force: true }).catch(() => undefined); }
  return { revision: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export async function resolveProjectDownload(rawPath: unknown): Promise<ResolvedFile> {
  const target = await resolveProject(rawPath);
  assertRegularFile(target);
  return { fullPath: target.fullPath, virtualPath: target.virtualPath, stat: target.lstat, name: path.posix.basename(target.virtualPath) };
}

export async function resolveProjectPreview(rawPath: unknown): Promise<ResolvedFile & { contentType: string }> {
  const target = await resolveProjectDownload(rawPath);
  const contentType = PREVIEW_MIME[path.extname(target.name).toLowerCase()];
  if (!contentType) throw bad('浏览器不能预览此文件，请下载后打开');
  if (target.stat.size > MAX_PREVIEW_BYTES) throw payloadTooLarge('文件超过 64 MB，不能在页面预览', 'Files larger than 64 MB cannot be previewed in the panel.');
  return { ...target, contentType };
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

export async function getProjectFilePreviewInfo(rawPath: unknown): Promise<FilePreviewInfo> {
  const file = await resolveProjectDownload(rawPath);
  const extension = path.extname(file.name).toLowerCase();
  const size = file.stat.size;
  if (size > MAX_PREVIEW_BYTES) {
    return { kind: 'large', size, note: '文件超过 64 MB，页面展示文件信息；可下载原文件查看完整内容。' };
  }
  const inlineType = INLINE_MEDIA_MIME[extension];
  if (inlineType) {
    const kind = inlineType.startsWith('image/') ? 'image' : inlineType.startsWith('audio/') ? 'audio' : inlineType.startsWith('video/') ? 'video' : 'pdf';
    return { kind, contentType: inlineType, size };
  }
  if (extension === '.html' || extension === '.htm') return { kind: 'html', contentType: 'text/html; charset=utf-8', size };

  const sample = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = fs.createReadStream(file.fullPath, { start: 0, end: PREVIEW_SAMPLE_BYTES - 1 });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  const truncated = size > sample.byteLength;
  try {
    if (sample.includes(0)) throw new Error('binary');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return { kind: 'text', contentType: 'text/plain; charset=utf-8', size, content, truncated };
  } catch {
    // Invalid UTF-8 and NUL bytes are shown as a bounded hexadecimal preview.
  }
  return { kind: 'binary', size, hex: hexPreview(sample), truncated, note: '此文件不是可直接渲染的文本或媒体格式，下面显示文件开头的十六进制内容。' };
}

function validateNewName(rawName: unknown): string {
  if (typeof rawName !== 'string' || !rawName || rawName.length > 255 || rawName === '.' || rawName === '..' || rawName.startsWith('.blockcraft-upload-') || rawName.startsWith('.blockcraft-edit-') || /[<>:"/\\|?*\x00-\x1f]/.test(rawName) || /[. ]$/.test(rawName)) {
    throw bad('名称无效；不能包含路径分隔符或 Windows 不支持的字符');
  }
  return rawName;
}

export function validateProjectFileName(rawName: unknown): string {
  return validateNewName(rawName);
}

export async function createProjectDirectory(rawParent: unknown, rawName: unknown): Promise<FileEntry> {
  const parent = await resolveProject(rawParent);
  if (!parent.lstat.isDirectory()) throw bad('目标位置不是文件夹');
  const name = validateNewName(rawName);
  try { await fsp.mkdir(path.join(parent.fullPath, name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict('同名文件或文件夹已经存在');
    throw error;
  }
  return entryAtPath(path.join(parent.fullPath, name), joinVirtual(parent.virtualPath, name), name);
}

export async function uploadProjectFile(rawParent: unknown, rawName: unknown, input: NodeJS.ReadableStream, contentLength: number, overwrite = false): Promise<FileEntry> {
  const parent = await resolveProject(rawParent);
  if (!parent.lstat.isDirectory()) throw bad('目标位置不是文件夹');
  const name = validateNewName(rawName);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) throw payloadTooLarge('单个文件不能超过 10 GB', 'A single file is limited to 10 GB.');
  const destination = path.join(parent.fullPath, name);
  let existing: fs.Stats | null = null;
  try { existing = await fsp.lstat(destination); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing) {
    if (!overwrite) throw conflict('同名文件已经存在');
    if (existing.isSymbolicLink() || !existing.isFile()) throw conflict('同名路径不是普通文件，无法覆盖上传');
  }
  const temp = path.join(parent.fullPath, `.blockcraft-upload-${crypto.randomUUID()}.tmp`);
  let bytes = 0;
  let limitExceeded = false;
  const limiter = new Transform({ transform(chunk: Buffer | string, _encoding, callback) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_UPLOAD_BYTES) {
      limitExceeded = true;
      callback(null);
      return;
    }
    callback(null, chunk);
  } });
  try {
    await pipeline(input, limiter, fs.createWriteStream(temp, { flags: 'wx' }));
    if (limitExceeded) throw payloadTooLarge('单个文件不能超过 10 GB', 'A single file is limited to 10 GB.');
    if (overwrite && existing) {
      let latest: fs.Stats;
      try { latest = await fsp.lstat(destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw conflict('目标文件已变化，请刷新后重试');
        throw error;
      }
      if (latest.isSymbolicLink() || !latest.isFile() || latest.dev !== existing.dev || latest.ino !== existing.ino || latest.size !== existing.size || latest.mtimeMs !== existing.mtimeMs) {
        throw conflict('目标文件已变化，请刷新后重试');
      }
      await fsp.rename(temp, destination);
    } else {
      try { await fsp.link(temp, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict('同名文件已经存在');
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await fsp.copyFile(temp, destination, fs.constants.COPYFILE_EXCL);
      }
    }
  } finally { await fsp.rm(temp, { force: true }).catch(() => undefined); }
  return entryAtPath(destination, joinVirtual(parent.virtualPath, name), name);
}

export async function deleteProjectEntries(rawPaths: unknown): Promise<Array<{ path: string; type: FileEntryType; name: string }>> {
  if (!Array.isArray(rawPaths) || rawPaths.length < 1 || rawPaths.length > 1000) throw bad('请选择 1 到 1000 个文件或文件夹');
  const unique = [...new Set(rawPaths.map(normalizeVirtualPath))];
  if (unique.some((item) => !item)) throw bad('项目根目录不能删除');
  unique.sort((a, b) => a.length - b.length);
  const selected = unique.filter((item, index) => !unique.slice(0, index).some((parent) => item.startsWith(`${parent}/`)));
  const targets = await Promise.all(selected.map(async (virtualPath) => ({ virtualPath, target: await resolveProject(virtualPath, true) })));
  const result: Array<{ path: string; type: FileEntryType; name: string }> = [];
  for (const { virtualPath, target } of targets) {
    const type: FileEntryType = target.lstat.isSymbolicLink() ? 'link' : target.lstat.isDirectory() ? 'directory' : 'file';
    await fsp.rm(target.fullPath, { recursive: type === 'directory', force: false });
    result.push({ path: virtualPath, type, name: path.posix.basename(virtualPath) });
  }
  return result;
}

export async function writeProjectArchive(rawPaths: unknown, output: NodeJS.WritableStream): Promise<{ count: number }> {
  if (!Array.isArray(rawPaths) || rawPaths.length < 1 || rawPaths.length > 1000) throw bad('请选择 1 到 1000 个文件或文件夹');
  const unique = [...new Set(rawPaths.map(normalizeVirtualPath))];
  if (unique.some((item) => !item)) throw bad('请至少选择一个项目目录下的项目');
  unique.sort((a, b) => a.length - b.length);
  const selected = unique.filter((item, index) => !unique.slice(0, index).some((parent) => item.startsWith(`${parent}/`)));
  const zip = new yazl.ZipFile();
  const files: Array<{ fullPath?: string; archivePath: string; directory: boolean }> = [];
  const visited = new Set<string>();
  async function walk(fullPath: string, archivePath: string): Promise<void> {
    const stat = await fsp.lstat(fullPath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      const real = await fsp.realpath(fullPath);
      if (visited.has(real)) return;
      visited.add(real);
      files.push({ archivePath: `${archivePath}/`, directory: true });
      const names = (await fsp.readdir(fullPath)).sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
      for (const name of names) await walk(path.join(fullPath, name), `${archivePath}/${name}`);
    } else if (stat.isFile()) files.push({ fullPath, archivePath, directory: false });
    if (files.length > MAX_ARCHIVE_FILES) throw payloadTooLarge('所选内容超过 ZIP 打包数量上限（50,000 项）', 'The selected items exceed the 50,000-entry archive limit.');
  }
  for (const virtualPath of selected) {
    const target = await resolveProject(virtualPath);
    await walk(target.fullPath, virtualPath);
  }
  const completion = pipeline(zip.outputStream, output);
  try {
    for (const file of files) {
      if (file.directory) zip.addEmptyDirectory(file.archivePath);
      else zip.addFile(file.fullPath!, file.archivePath);
    }
    zip.end();
    await completion;
  } catch (error) {
    zip.outputStream.destroy?.(error as Error);
    throw error;
  }
  return { count: files.length };
}
