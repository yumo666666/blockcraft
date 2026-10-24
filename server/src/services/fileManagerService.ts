import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { INSTANCES_DIR, instanceDir, instanceServerDir } from '../core/paths.ts';
import { bad, conflict, notFound, payloadTooLarge } from '../core/errors.ts';
import * as I from './instanceService.ts';

export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

export type FileEntryType = 'directory' | 'file' | 'link';

export interface FileEntry {
  name: string;
  path: string;
  type: FileEntryType;
  size: number | null;
  modifiedAt: string;
  editable: boolean;
  previewable: boolean;
  deletable: boolean;
  archive?: boolean;
}

export interface ResolvedFile {
  fullPath: string;
  virtualPath: string;
  stat: fs.Stats;
  name: string;
}

const EDITABLE_EXTENSIONS = new Set([
  '.bat', '.cfg', '.conf', '.csv', '.css', '.ftl', '.gradle', '.html', '.ini', '.json',
  '.js', '.json5', '.jsonc', '.list', '.log', '.md', '.mcfunction', '.mcmeta', '.mjs',
  '.properties', '.ps1', '.sh', '.sql', '.svg', '.toml', '.ts', '.txt', '.xml', '.yaml', '.yml',
]);
const PREVIEW_MIME: Record<string, string> = {
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav', '.webm': 'video/webm', '.webp': 'image/webp', '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
};

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

function isEditable(name: string, size: number | null): boolean {
  return size !== null && size <= MAX_EDIT_BYTES && EDITABLE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function joinVirtual(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

async function rootInfo(id: string): Promise<{ serverRoot: string | null }> {
  I.getConfig(id);
  const configuredRoot = instanceDir(id);
  const instanceLink = await fsp.lstat(configuredRoot);
  if (!instanceLink.isDirectory() || instanceLink.isSymbolicLink()) throw bad('世界目录不是安全的本地目录');
  const instanceRoot = await fsp.realpath(instanceDir(id));
  const instancesRoot = await fsp.realpath(INSTANCES_DIR);
  if (path.dirname(instanceRoot) !== instancesRoot) throw bad('世界目录超出了允许的管理范围');
  let serverRoot: string | null = null;
  try {
    const stat = await fsp.stat(instanceServerDir(id));
    if (stat.isDirectory()) serverRoot = await fsp.realpath(instanceServerDir(id));
  } catch {
    // A world may not have a server directory during setup; the virtual root remains browsable.
  }
  return { serverRoot };
}

/** Resolve paths under the world's server directory; only that configured root may be an external link. */
async function resolveVirtual(
  id: string,
  rawPath: unknown,
  options: { allowFinalLink?: boolean } = {},
): Promise<{ virtualPath: string; fullPath: string; lstat: fs.Stats }> {
  const virtualPath = normalizeVirtualPath(rawPath);
  const { serverRoot } = await rootInfo(id);
  const parts = virtualPath ? virtualPath.split('/') : [];

  if (!parts.length) {
    if (!serverRoot) throw notFound('当前世界的服务端目录尚未创建');
    const lstat = await fsp.lstat(serverRoot);
    return { virtualPath, fullPath: serverRoot, lstat };
  }

  if (!serverRoot) throw notFound('当前世界的服务端目录尚未创建');
  let current = serverRoot;
  const traversal = parts;

  for (let index = 0; index < traversal.length; index += 1) {
    const segment = traversal[index];
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound('文件或目录不存在');
      throw error;
    }
    const final = index === traversal.length - 1;
    if (stat.isSymbolicLink()) {
      if (final && options.allowFinalLink) return { virtualPath, fullPath: current, lstat: stat };
      throw bad('为保护世界目录，不能穿过 server 挂载以外的符号链接');
    }
    if (!final && !stat.isDirectory()) throw notFound('路径中的目录不存在');
  }
  return { virtualPath, fullPath: current, lstat: await fsp.lstat(current) };
}

async function entryAtPath(fullPath: string, virtualPath: string, name: string): Promise<FileEntry> {
  const stat = await fsp.lstat(fullPath);
  if (stat.isSymbolicLink()) {
    return {
      name, path: virtualPath, type: 'link', size: null, modifiedAt: stat.mtime.toISOString(),
      editable: false, previewable: false, deletable: true,
    };
  }
  const directory = stat.isDirectory();
  const size = directory ? null : stat.size;
  return {
    name,
    path: virtualPath,
    type: directory ? 'directory' : 'file',
    size,
    modifiedAt: stat.mtime.toISOString(),
    editable: !directory && isEditable(name, size),
    previewable: !directory,
    deletable: true,
  };
}

async function entryFor(id: string, parent: string, name: string): Promise<FileEntry> {
  const virtualPath = joinVirtual(parent, name);
  const resolvedParent = await resolveVirtual(id, parent);
  return entryAtPath(path.join(resolvedParent.fullPath, name), virtualPath, name);
}

export async function listDirectory(id: string, rawPath: unknown): Promise<{ path: string; entries: FileEntry[] }> {
  const target = await resolveVirtual(id, rawPath);
  if (!target.lstat.isDirectory()) throw bad('所选路径不是文件夹');
  const names = (await fsp.readdir(target.fullPath)).filter((name) =>
    !name.startsWith('.blockcraft-upload-') && !name.startsWith('.blockcraft-edit-'),
  );
  const entries = await Promise.all(names.map((name) => entryAtPath(
    path.join(target.fullPath, name), joinVirtual(target.virtualPath, name), name,
  )));
  entries.sort((a, b) => {
    const kind = (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1);
    return kind || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
  return { path: target.virtualPath, entries };
}

function assertRegularFile(target: { lstat: fs.Stats }): void {
  if (target.lstat.isSymbolicLink()) throw bad('符号链接不能读取或下载');
  if (!target.lstat.isFile()) throw bad('所选路径不是文件');
}

export async function getTextFile(id: string, rawPath: unknown): Promise<{ path: string; name: string; content: string; revision: string }> {
  const target = await resolveVirtual(id, rawPath);
  assertRegularFile(target);
  const name = path.posix.basename(target.virtualPath);
  if (!EDITABLE_EXTENSIONS.has(path.extname(name).toLowerCase())) throw bad('此文件类型不支持在线编辑');
  if (target.lstat.size > MAX_EDIT_BYTES) throw payloadTooLarge('文本文件超过 2 MB，不能在线编辑', 'Text files larger than 2 MB cannot be edited in the panel.');
  const bytes = await fsp.readFile(target.fullPath);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw bad('文件不是有效的 UTF-8 文本，无法在线编辑');
  }
  return { path: target.virtualPath, name, content, revision: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export async function saveTextFile(id: string, rawPath: unknown, content: unknown, revision: unknown): Promise<{ revision: string }> {
  if (typeof content !== 'string' || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw bad('编辑内容或版本标记无效');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > MAX_EDIT_BYTES) throw payloadTooLarge('文本文件不能超过 2 MB', 'Text files are limited to 2 MB.');
  const target = await resolveVirtual(id, rawPath);
  assertRegularFile(target);
  const name = path.posix.basename(target.virtualPath);
  if (!EDITABLE_EXTENSIONS.has(path.extname(name).toLowerCase())) throw bad('此文件类型不支持在线编辑');
  if (target.lstat.size > MAX_EDIT_BYTES) throw payloadTooLarge('文本文件超过 2 MB，不能在线编辑', 'Text files larger than 2 MB cannot be edited in the panel.');
  const current = await fsp.readFile(target.fullPath);
  const currentRevision = crypto.createHash('sha256').update(current).digest('hex');
  if (currentRevision !== revision) throw conflict('文件内容已被其他进程修改，请重新打开后再保存');
  const temp = path.join(path.dirname(target.fullPath), `.blockcraft-edit-${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temp, bytes, { flag: 'wx', mode: target.lstat.mode });
    const latest = await fsp.lstat(target.fullPath);
    if (latest.isSymbolicLink() || !latest.isFile()) throw conflict('目标文件已变化，请刷新后重试');
    const latestBytes = await fsp.readFile(target.fullPath);
    if (crypto.createHash('sha256').update(latestBytes).digest('hex') !== revision) throw conflict('文件内容已被其他进程修改，请重新打开后再保存');
    await fsp.rename(temp, target.fullPath);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
  return { revision: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export async function resolveDownload(id: string, rawPath: unknown): Promise<ResolvedFile> {
  const target = await resolveVirtual(id, rawPath);
  assertRegularFile(target);
  return { fullPath: target.fullPath, virtualPath: target.virtualPath, stat: target.lstat, name: path.posix.basename(target.virtualPath) };
}

export async function resolvePreview(id: string, rawPath: unknown): Promise<ResolvedFile & { contentType: string }> {
  const target = await resolveDownload(id, rawPath);
  const ext = path.extname(target.name).toLowerCase();
  const contentType = PREVIEW_MIME[ext];
  if (!contentType) throw bad('浏览器不能预览此文件，请下载后打开');
  if (target.stat.size > MAX_PREVIEW_BYTES) throw payloadTooLarge('文件超过 64 MB，不能在页面预览', 'Files larger than 64 MB cannot be previewed in the panel.');
  return { ...target, contentType };
}

function validateNewName(rawName: unknown): string {
  if (typeof rawName !== 'string' || !rawName || rawName.length > 255 || rawName === '.' || rawName === '..' || rawName.startsWith('.blockcraft-upload-') || rawName.startsWith('.blockcraft-edit-') || /[<>:"/\\|?*\x00-\x1f]/.test(rawName) || /[. ]$/.test(rawName)) {
    throw bad('名称无效；不能包含路径分隔符或 Windows 不支持的字符');
  }
  return rawName;
}

export async function createDirectory(id: string, rawParent: unknown, rawName: unknown): Promise<FileEntry> {
  const parent = await resolveVirtual(id, rawParent);
  if (!parent.lstat.isDirectory()) throw bad('目标位置不是文件夹');
  const name = validateNewName(rawName);
  const targetPath = path.join(parent.fullPath, name);
  try {
    await fsp.mkdir(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict('同名文件或文件夹已经存在');
    throw error;
  }
  return entryFor(id, parent.virtualPath, name);
}

export async function uploadFile(id: string, rawParent: unknown, rawName: unknown, input: NodeJS.ReadableStream, contentLength: number): Promise<FileEntry> {
  const parent = await resolveVirtual(id, rawParent);
  if (!parent.lstat.isDirectory()) throw bad('目标位置不是文件夹');
  const name = validateNewName(rawName);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    throw payloadTooLarge('单个文件不能超过 10 GB', 'A single file is limited to 10 GB.');
  }
  const destination = path.join(parent.fullPath, name);
  try {
    await fsp.lstat(destination);
    throw conflict('同名文件已经存在，请先删除或重命名现有文件');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = path.join(parent.fullPath, `.blockcraft-upload-${crypto.randomUUID()}.tmp`);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_UPLOAD_BYTES) {
        // Drain the request so the server can return a structured 413 response instead of
        // destroying the connection. The temporary file is removed after the pipeline ends.
        callback(null);
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(input, limiter, fs.createWriteStream(temp, { flags: 'wx' }));
    if (bytes > MAX_UPLOAD_BYTES) throw payloadTooLarge('单个文件不能超过 10 GB', 'A single file is limited to 10 GB.');
    try {
      // Linking is atomic and refuses to overwrite a file created during upload.
      await fsp.link(temp, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict('同名文件已经存在，请先删除或重命名现有文件');
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // Some mounted filesystems do not implement hard links; exclusive copy keeps the
      // no-overwrite rule on those filesystems, even if it cannot be atomic to readers.
      await fsp.copyFile(temp, destination, fs.constants.COPYFILE_EXCL);
    }
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
  return entryFor(id, parent.virtualPath, name);
}

export async function deleteEntry(id: string, rawPath: unknown): Promise<{ type: FileEntryType; name: string }> {
  const target = await resolveVirtual(id, rawPath, { allowFinalLink: true });
  if (!target.virtualPath) throw bad('世界根目录不能在文件管理中删除');
  const name = path.posix.basename(target.virtualPath);
  const type: FileEntryType = target.lstat.isSymbolicLink() ? 'link' : target.lstat.isDirectory() ? 'directory' : 'file';
  await fsp.rm(target.fullPath, { recursive: type === 'directory', force: false });
  return { type, name };
}
