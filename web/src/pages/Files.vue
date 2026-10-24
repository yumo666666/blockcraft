<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';
import { readBrowserSnapshot, writeBrowserSnapshot } from '../lib/browserSnapshot.ts';
import { fmtBytes, fmtTime } from '../lib/format.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';

defineOptions({ name: 'Files' });

type FileEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'link';
  size: number | null;
  modifiedAt: string;
  editable: boolean;
  previewable: boolean;
  deletable: boolean;
  readOnly?: boolean | null;
  worldId?: string | null;
  archive?: boolean;
};
type FileListPayload = { path: string; entries: FileEntry[]; readOnly: boolean | null; worldId?: string | null; maxUploadBytes: number; rootName: string; projectRoot: string };
type TreeRow = { path: string; name: string; depth: number; root?: boolean };
type ArchiveContext = { archivePath: string; path: string; signed: boolean };
type UploadLocation = { path: string; archive: Pick<ArchiveContext, 'archivePath' | 'path'> | null };
type PendingOverwrite = { files: File[]; location: UploadLocation; names: string[] };
type Breadcrumb = { label: string; projectPath?: string; archive?: boolean; entryPath?: string };
type PreviewInfo = {
  kind: 'image' | 'audio' | 'video' | 'pdf' | 'html' | 'text' | 'binary' | 'large';
  contentType?: string;
  size: number;
  content?: string;
  hex?: string;
  truncated?: boolean;
  note?: string;
};
interface FilesSnapshot {
  directories: [string, FileEntry[]][];
  archiveDirectories?: [string, FileEntry[]][];
  archiveContext?: ArchiveContext | null;
  directoryWorlds?: [string, string][];
  worldAccess?: [string, boolean][];
  currentPath: string;
  worldId?: string | null;
  readOnly: boolean;
  maxUploadBytes: number;
  rootName: string;
  projectRoot: string;
}

const SNAPSHOT_KEY = 'project-files';
const cachedFiles = readBrowserSnapshot<FilesSnapshot>(SNAPSHOT_KEY);
const rootName = ref(cachedFiles?.rootName || '项目目录');
const projectRoot = ref(cachedFiles?.projectRoot ?? '');
// Fail closed until the server confirms write access for the current directory.
const readOnly = ref(true);
const accessChecking = ref(true);
const accessUnavailable = ref(false);
const loadingError = ref('');
const currentPath = ref(cachedFiles?.currentPath ?? '');
const currentWorldId = ref<string | null | undefined>(cachedFiles?.worldId);
const maxUploadBytes = ref(10 * 1024 * 1024 * 1024);
const treeChildren = reactive(new Map<string, FileEntry[]>(cachedFiles?.directories ?? []));
const archiveChildren = reactive(new Map<string, FileEntry[]>(cachedFiles?.archiveDirectories ?? []));
const directoryWorlds = reactive(new Map<string, string>(cachedFiles?.directoryWorlds ?? []));
const worldAccess = reactive(new Map<string, boolean>(cachedFiles?.worldAccess ?? []));
const archiveContext = ref<ArchiveContext | null>(cachedFiles?.archiveContext ?? null);
const currentEntries = ref<FileEntry[]>(archiveContext.value
  ? archiveChildren.get(`${archiveContext.value.archivePath}::${archiveContext.value.path}`) ?? []
  : treeChildren.get(currentPath.value) ?? []);
const hasCurrentSnapshot = computed(() => archiveContext.value
  ? archiveChildren.has(`${archiveContext.value.archivePath}::${archiveContext.value.path}`)
  : treeChildren.has(currentPath.value));
const loading = ref(!hasCurrentSnapshot.value);
const accessLabel = computed(() => {
  if (accessChecking.value) return '正在读取目录状态';
  if (accessUnavailable.value) return '目录状态暂不可用 · 只读';
  if (archiveContext.value) return readOnly.value ? 'JAR 内容 · 只读' : 'JAR 内容 · 可编辑';
  return readOnly.value ? '世界运行中 · 只读' : '项目文件可管理';
});
const expandedPaths = reactive(new Set<string>(['']));
const treeLoading = reactive(new Set<string>());
const uploadInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const uploadProgress = ref({ done: 0, total: 0, percent: 0, name: '' });
const pendingOverwrite = ref<PendingOverwrite | null>(null);
const folderModalOpen = ref(false);
const folderName = ref('');
const creatingFolder = ref(false);
const editModalOpen = ref(false);
const editTarget = ref<FileEntry | null>(null);
const editArchivePath = ref<string | null>(null);
const editContent = ref('');
const editRevision = ref('');
const editLoading = ref(false);
const editSaving = ref(false);
const previewTarget = ref<FileEntry | null>(null);
const previewArchivePath = ref<string | null>(null);
const previewInfo = ref<PreviewInfo | null>(null);
const previewLoading = ref(false);
const deleteTarget = ref<FileEntry | null>(null);
const deleting = ref(false);
const selectedPaths = ref<Set<string>>(new Set());
const selectedEntries = computed(() => currentEntries.value.filter((entry) => selectedPaths.value.has(entry.path)));
const selectableEntries = computed(() => currentEntries.value.filter((entry) => entry.type !== 'link'));
const allSelected = computed(() => selectableEntries.value.length > 0 && selectableEntries.value.every((entry) => selectedPaths.value.has(entry.path)));
const bulkDeleteOpen = ref(false);
const bulkDeleting = ref(false);
const bulkDownloading = ref(false);
let disposed = false;
let loadSequence = 0;
const worldAccessChecks = new Map<string, Promise<boolean>>();

function cachedWorldIdForPath(path: string): string | null | undefined {
  if (!path) return null;
  const directoryWorldId = directoryWorlds.get(path);
  if (directoryWorldId) return directoryWorldId;
  const separator = path.lastIndexOf('/');
  const parent = separator >= 0 ? path.slice(0, separator) : '';
  const entry = treeChildren.get(parent)?.find((item) => item.path === path);
  if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'worldId')) return undefined;
  return entry.worldId ?? null;
}

function applyWorldAccess(worldId: string, nextReadOnly: boolean): void {
  worldAccess.set(worldId, nextReadOnly);
  for (const [path, entries] of treeChildren) {
    let changed = false;
    const updated = entries.map((entry) => {
      if (entry.worldId !== worldId || entry.readOnly === nextReadOnly) return entry;
      changed = true;
      return { ...entry, readOnly: nextReadOnly };
    });
    if (changed) treeChildren.set(path, updated);
    if (path === currentPath.value && changed && !archiveContext.value) currentEntries.value = updated;
  }
  if (currentWorldId.value === worldId) readOnly.value = nextReadOnly;
}

function normalizeEntryAccess(entries: FileEntry[]): FileEntry[] {
  return entries.map((entry) => {
    if (!entry.worldId) return { ...entry, readOnly: false };
    if (typeof entry.readOnly === 'boolean') applyWorldAccess(entry.worldId, entry.readOnly);
    // Until the world root is opened and its status is known, keep its row
    // protected in parent listings.
    return { ...entry, readOnly: worldAccess.get(entry.worldId) ?? true };
  });
}

function persistFilesSnapshot(): void {
  const directoryEntries = [...treeChildren.entries()];
  const root = directoryEntries.find(([path]) => path === '');
  const current = directoryEntries.find(([path]) => path === currentPath.value);
  const recent = directoryEntries.slice(-10);
  const directories = [...new Map([...(root ? [root] : []), ...(current ? [current] : []), ...recent]).entries()];
  const archiveRecent = [...archiveChildren.entries()].slice(-10);
  let totalEntries = 0;
  const boundedDirectories: [string, FileEntry[]][] = [];
  for (const [path, entries] of directories) {
    if (totalEntries + entries.length > 6000) continue;
    boundedDirectories.push([path, entries]);
    totalEntries += entries.length;
  }
  writeBrowserSnapshot<FilesSnapshot>(SNAPSHOT_KEY, {
    directories: boundedDirectories,
    archiveDirectories: archiveRecent,
    archiveContext: archiveContext.value,
    directoryWorlds: [...directoryWorlds.entries()],
    worldAccess: [...worldAccess.entries()],
    currentPath: currentPath.value,
    worldId: currentWorldId.value,
    readOnly: readOnly.value,
    maxUploadBytes: maxUploadBytes.value,
    rootName: rootName.value,
    projectRoot: projectRoot.value,
  });
}

function restoreFilesSnapshot(): void {
  const cached = readBrowserSnapshot<FilesSnapshot>(SNAPSHOT_KEY);
  treeChildren.clear();
  for (const [path, entries] of cached?.directories ?? []) {
    if (typeof path === 'string' && Array.isArray(entries)) treeChildren.set(path, normalizeEntryAccess(entries));
  }
  archiveChildren.clear();
  for (const [path, entries] of cached?.archiveDirectories ?? []) {
    if (typeof path === 'string' && Array.isArray(entries)) archiveChildren.set(path, entries);
  }
  directoryWorlds.clear();
  for (const [path, worldId] of cached?.directoryWorlds ?? []) {
    if (typeof path === 'string' && typeof worldId === 'string') directoryWorlds.set(path, worldId);
  }
  worldAccess.clear();
  for (const [worldId, cachedReadOnly] of cached?.worldAccess ?? []) {
    if (typeof worldId === 'string' && typeof cachedReadOnly === 'boolean') worldAccess.set(worldId, cachedReadOnly);
  }
  currentPath.value = cached?.currentPath ?? '';
  currentWorldId.value = cached?.worldId;
  archiveContext.value = cached?.archiveContext ?? null;
  currentEntries.value = archiveContext.value
    ? archiveChildren.get(`${archiveContext.value.archivePath}::${archiveContext.value.path}`) ?? []
    : treeChildren.get(currentPath.value) ?? [];
  maxUploadBytes.value = 10 * 1024 * 1024 * 1024;
  rootName.value = cached?.rootName || '项目目录';
  projectRoot.value = cached?.projectRoot ?? '';
  const cachedWorldId = cachedWorldIdForPath(currentPath.value);
  if (cachedWorldId === null) {
    currentWorldId.value = null;
    readOnly.value = false;
    accessChecking.value = false;
  } else {
    if (cachedWorldId !== undefined) currentWorldId.value = cachedWorldId;
    if (currentWorldId.value && !worldAccess.has(currentWorldId.value) && cachedFiles?.worldId === currentWorldId.value) {
      worldAccess.set(currentWorldId.value, cachedFiles.readOnly);
    }
    const cachedAccess = currentWorldId.value ? worldAccess.get(currentWorldId.value) : undefined;
    readOnly.value = cachedAccess ?? true;
    accessChecking.value = cachedAccess === undefined;
  }
  accessUnavailable.value = false;
}

const pathParts = computed(() => currentPath.value ? currentPath.value.split('/') : []);
const pathCrumbs = computed<Breadcrumb[]>(() => {
  if (archiveContext.value) {
    const crumbs: Breadcrumb[] = [{ label: rootName.value, projectPath: '' }];
    let projectFolder = '';
    for (const part of pathParts.value) {
      projectFolder = projectFolder ? `${projectFolder}/${part}` : part;
      crumbs.push({ label: part, projectPath: projectFolder });
    }
    const archiveName = archiveContext.value.archivePath.split('/').at(-1) ?? archiveContext.value.archivePath;
    crumbs.push({ label: archiveName, archive: true, entryPath: '' });
    let innerPath = '';
    for (const part of (archiveContext.value.path ? archiveContext.value.path.split('/') : [])) {
      innerPath = innerPath ? `${innerPath}/${part}` : part;
      crumbs.push({ label: part, archive: true, entryPath: innerPath });
    }
    return crumbs;
  }
  const out: Breadcrumb[] = [{ label: rootName.value, projectPath: '' }];
  let fullPath = '';
  for (const part of pathParts.value) {
    fullPath = fullPath ? `${fullPath}/${part}` : part;
    out.push({ label: part, projectPath: fullPath });
  }
  return out;
});

const treeRows = computed<TreeRow[]>(() => {
  const rows: TreeRow[] = [{ path: '', name: rootName.value, depth: 0, root: true }];
  const visit = (parent: string, depth: number): void => {
    if (!expandedPaths.has(parent)) return;
    const entries = treeChildren.get(parent) ?? [];
    for (const entry of entries) {
      if (entry.type !== 'directory') continue;
      rows.push({ path: entry.path, name: entry.name, depth });
      visit(entry.path, depth + 1);
    }
  };
  visit('', 1);
  return rows;
});

function listUrl(path: string): string {
  const query = new URLSearchParams({ path });
  return `/api/project-files?${query.toString()}`;
}

function endpointUrl(endpoint: string, path: string): string {
  const query = new URLSearchParams({ path });
  return `/api/project-files/${endpoint}?${query.toString()}`;
}

function archiveCacheKey(archivePath: string, path: string): string {
  return `${archivePath}::${path}`;
}

function archiveListUrl(archivePath: string, path: string): string {
  return `/api/project-files/jar?${new URLSearchParams({ archive: archivePath, path }).toString()}`;
}

function archiveEndpointUrl(endpoint: string, archivePath: string, path: string): string {
  return `/api/project-files/jar/${endpoint}?${new URLSearchParams({ archive: archivePath, path }).toString()}`;
}

async function loadDirectory(path: string, showLoading = true): Promise<FileListPayload | null> {
  const seq = ++loadSequence;
  if (showLoading && path === currentPath.value) loading.value = true;
  loadingError.value = '';
  try {
    const result = await api.get<FileListPayload>(listUrl(path));
    if (disposed) return null;
    if (result.worldId) directoryWorlds.set(path, result.worldId);
    else directoryWorlds.delete(path);
    if (result.worldId && typeof result.readOnly === 'boolean') applyWorldAccess(result.worldId, result.readOnly);
    const entries = normalizeEntryAccess(result.entries);
    treeChildren.set(path, entries);
    if (path === currentPath.value) {
      currentWorldId.value = result.worldId ?? null;
      if (!currentWorldId.value) {
        readOnly.value = false;
        accessChecking.value = false;
      } else {
        if (typeof result.readOnly === 'boolean') applyWorldAccess(currentWorldId.value, result.readOnly);
        const knownAccess = worldAccess.get(currentWorldId.value);
        readOnly.value = knownAccess ?? true;
        accessChecking.value = knownAccess === undefined;
      }
      accessUnavailable.value = false;
      const visiblePaths = new Set(result.entries.map((entry) => entry.path));
      selectedPaths.value = new Set([...selectedPaths.value].filter((selected) => visiblePaths.has(selected)));
    }
    maxUploadBytes.value = result.maxUploadBytes || maxUploadBytes.value;
    rootName.value = result.rootName || rootName.value;
    projectRoot.value = result.projectRoot || projectRoot.value;
    if (path === currentPath.value && !archiveContext.value && seq === loadSequence) currentEntries.value = entries;
    persistFilesSnapshot();
    if (path === currentPath.value && result.worldId && typeof result.readOnly !== 'boolean' && !worldAccess.has(result.worldId)) {
      void refreshAccess(path, result.worldId, false);
    }
    return result;
  } catch (err) {
    if (!disposed) {
      if (path === currentPath.value) {
        loadingError.value = err instanceof Error ? err.message : String(err);
        readOnly.value = true;
        accessChecking.value = false;
        accessUnavailable.value = true;
      }
      toastError(err, '读取文件夹失败');
    }
    return null;
  } finally {
    if (path === currentPath.value && seq === loadSequence) loading.value = false;
  }
}

async function loadArchiveDirectory(path: string, showLoading = true): Promise<void> {
  const context = archiveContext.value;
  if (!context) return;
  const archivePath = context.archivePath;
  const seq = ++loadSequence;
  if (showLoading) loading.value = true;
  loadingError.value = '';
  try {
    const result = await api.get<{ path: string; entries: FileEntry[]; signed: boolean }>(archiveListUrl(archivePath, path));
    if (disposed || seq !== loadSequence || archiveContext.value?.archivePath !== archivePath) return;
    archiveContext.value = { archivePath, path, signed: result.signed };
    archiveChildren.set(archiveCacheKey(archivePath, path), result.entries);
    selectedPaths.value = new Set();
    if (seq === loadSequence) currentEntries.value = result.entries;
    persistFilesSnapshot();
  } catch (err) {
    if (!disposed && seq === loadSequence && archiveContext.value?.archivePath === archivePath) {
      loadingError.value = err instanceof Error ? err.message : String(err);
      toastError(err, '读取 JAR 内容失败');
    }
  } finally {
    if (seq === loadSequence) loading.value = false;
  }
}

async function refreshAccess(path = currentPath.value, expectedWorldId = currentWorldId.value, force = false): Promise<void> {
  if (path !== currentPath.value) return;
  if (!expectedWorldId) {
    readOnly.value = false;
    accessChecking.value = false;
    accessUnavailable.value = false;
    persistFilesSnapshot();
    return;
  }
  const knownAccess = worldAccess.get(expectedWorldId);
  if (!force && knownAccess !== undefined) {
    if (currentWorldId.value === expectedWorldId) {
      readOnly.value = knownAccess;
      accessChecking.value = false;
      accessUnavailable.value = false;
    }
    return;
  }
  const pending = worldAccessChecks.get(expectedWorldId);
  if (pending) {
    await pending;
    return;
  }
  if (knownAccess === undefined && currentWorldId.value === expectedWorldId) accessChecking.value = true;
  const request = api.get<{ readOnly: boolean; worldId: string | null }>(`/api/project-files/access?${new URLSearchParams({ path })}`)
    .then((result) => {
      const resolvedId = result.worldId ?? expectedWorldId;
      applyWorldAccess(resolvedId, result.readOnly);
      if (!disposed && currentWorldId.value === expectedWorldId) {
        readOnly.value = result.readOnly;
        accessChecking.value = false;
        accessUnavailable.value = false;
        persistFilesSnapshot();
      }
      return result.readOnly;
    })
    .catch(() => {
      // Fail closed when world state cannot be confirmed.
      applyWorldAccess(expectedWorldId, true);
      if (!disposed && currentWorldId.value === expectedWorldId) {
        readOnly.value = true;
        accessChecking.value = false;
        accessUnavailable.value = true;
      }
      return true;
    })
    .finally(() => worldAccessChecks.delete(expectedWorldId));
  worldAccessChecks.set(expectedWorldId, request);
  try {
    await request;
  } catch { /* request errors are handled above */ }
}

async function ensureTreeParents(path: string): Promise<void> {
  const parts = path ? path.split('/') : [];
  let parent = '';
  expandedPaths.add('');
  for (const part of parts.slice(0, -1)) {
    if (!treeChildren.has(parent)) {
      const result = await loadDirectory(parent, false);
      if (!result) return;
    }
    expandedPaths.add(parent);
    parent = parent ? `${parent}/${part}` : part;
  }
  if (parts.length > 0) {
    const lastParent = parts.length === 1 ? '' : parts.slice(0, -1).join('/');
    if (!treeChildren.has(lastParent)) await loadDirectory(lastParent, false);
    expandedPaths.add(lastParent);
  }
}

async function selectDirectory(path: string, expandAfterLoad = true): Promise<void> {
  archiveContext.value = null;
  currentPath.value = path;
  const cachedWorldId = cachedWorldIdForPath(path);
  currentWorldId.value = cachedWorldId;
  currentEntries.value = treeChildren.get(path) ?? [];
  selectedPaths.value = new Set();
  if (cachedWorldId === null) {
    readOnly.value = false;
    accessChecking.value = false;
  } else {
    const inheritedAccess = cachedWorldId ? worldAccess.get(cachedWorldId) : undefined;
    readOnly.value = inheritedAccess ?? true;
    accessChecking.value = Boolean(cachedWorldId) && inheritedAccess === undefined;
  }
  accessUnavailable.value = false;
  loading.value = true;
  persistFilesSnapshot();
  await ensureTreeParents(path);
  if (disposed) return;
  const resolvedWorldId = cachedWorldIdForPath(path);
  if (resolvedWorldId !== undefined) {
    currentWorldId.value = resolvedWorldId;
    if (resolvedWorldId === null) {
      readOnly.value = false;
      accessChecking.value = false;
    } else {
      const inheritedAccess = worldAccess.get(resolvedWorldId);
      readOnly.value = inheritedAccess ?? true;
      accessChecking.value = inheritedAccess === undefined;
    }
  }
  const result = await loadDirectory(path, true);
  if (disposed) return;
  if (result && expandAfterLoad) expandedPaths.add(path);
  else expandedPaths.delete(path);
}

async function activateTreeRow(row: TreeRow): Promise<void> {
  const expand = hasPotentialChildren(row.path) && !expandedPaths.has(row.path);
  if (expand) expandedPaths.add(row.path);
  else expandedPaths.delete(row.path);
  await selectDirectory(row.path, expand);
}

async function enterArchive(entry: FileEntry): Promise<void> {
  archiveContext.value = { archivePath: entry.path, path: '', signed: false };
  selectedPaths.value = new Set();
  currentEntries.value = archiveChildren.get(archiveCacheKey(entry.path, '')) ?? [];
  loading.value = !archiveChildren.has(archiveCacheKey(entry.path, ''));
  persistFilesSnapshot();
  await loadArchiveDirectory('');
  if (loadingError.value) {
    archiveContext.value = null;
    currentEntries.value = treeChildren.get(currentPath.value) ?? [];
    persistFilesSnapshot();
    await openPreview(entry);
  }
}

async function selectArchiveDirectory(path: string): Promise<void> {
  const context = archiveContext.value;
  if (!context) return;
  archiveContext.value = { ...context, path };
  currentEntries.value = archiveChildren.get(archiveCacheKey(context.archivePath, path)) ?? [];
  selectedPaths.value = new Set();
  loading.value = !archiveChildren.has(archiveCacheKey(context.archivePath, path));
  persistFilesSnapshot();
  await loadArchiveDirectory(path);
}

async function navigateCrumb(crumb: Breadcrumb): Promise<void> {
  if (crumb.archive) {
    if (crumb.entryPath !== undefined) await selectArchiveDirectory(crumb.entryPath);
    return;
  }
  await selectDirectory(crumb.projectPath ?? '');
}

async function toggleTree(row: TreeRow): Promise<void> {
  if (!hasPotentialChildren(row.path)) return;
  if (expandedPaths.has(row.path)) {
    expandedPaths.delete(row.path);
    return;
  }
  expandedPaths.add(row.path);
  if (!treeChildren.has(row.path)) {
    treeLoading.add(row.path);
    await loadDirectory(row.path, false);
    treeLoading.delete(row.path);
  }
}

function hasPotentialChildren(path: string): boolean {
  if (!treeChildren.has(path)) return true;
  return (treeChildren.get(path) ?? []).some((entry) => entry.type === 'directory');
}

async function refresh(forceWorldAccessCheck = false): Promise<void> {
  loading.value = true;
  if (archiveContext.value) {
    const context = archiveContext.value;
    await loadDirectory(currentPath.value, true);
    if (disposed) return;
    await loadArchiveDirectory(context.path);
    return;
  }
  await loadDirectory('', true);
  if (disposed) return;
  const path = currentPath.value;
  await ensureTreeParents(path);
  if (disposed) return;
  await loadDirectory(path, true);
  if (disposed) return;
  if (forceWorldAccessCheck && currentWorldId.value) await refreshAccess(path, currentWorldId.value, true);
}

async function reloadCurrentView(): Promise<void> {
  if (archiveContext.value) await loadArchiveDirectory(archiveContext.value.path);
  else await loadDirectory(currentPath.value);
}

const currentLocationLabel = computed(() => archiveContext.value
  ? `${archiveContext.value.archivePath}${archiveContext.value.path ? `!/${archiveContext.value.path}` : ''}`
  : currentPath.value || rootName.value);

async function openEntry(entry: FileEntry): Promise<void> {
  if (entry.type === 'directory') {
    if (archiveContext.value) await selectArchiveDirectory(entry.path);
    else await selectDirectory(entry.path);
    return;
  }
  if (entry.type === 'link') {
    toast('info', '无法打开符号链接', '为保护项目目录，符号链接不会被跟随');
    return;
  }
  if (!archiveContext.value && entry.archive) {
    await enterArchive(entry);
    return;
  }
  if (entry.editable) {
    editTarget.value = entry;
    editArchivePath.value = archiveContext.value?.archivePath ?? null;
    editModalOpen.value = true;
    editLoading.value = true;
    try {
      const textUrl = editArchivePath.value
        ? archiveEndpointUrl('text', editArchivePath.value, entry.path)
        : endpointUrl('text', entry.path);
      const text = await api.get<{ path: string; name: string; content: string; revision: string }>(textUrl);
      editContent.value = text.content;
      editRevision.value = text.revision;
    } catch {
      editModalOpen.value = false;
      editTarget.value = null;
      editArchivePath.value = null;
      await openPreview(entry);
    } finally {
      editLoading.value = false;
    }
    return;
  }
  await openPreview(entry);
}

async function openPreview(entry: FileEntry): Promise<void> {
  const archivePath = archiveContext.value?.archivePath ?? null;
  previewTarget.value = entry;
  previewArchivePath.value = archivePath;
  previewInfo.value = null;
  previewLoading.value = true;
  const url = archivePath
    ? archiveEndpointUrl('preview-info', archivePath, entry.path)
    : endpointUrl('preview-info', entry.path);
  try {
    previewInfo.value = await api.get<PreviewInfo>(url);
  } catch (err) {
    previewTarget.value = null;
    previewArchivePath.value = null;
    toastError(err, '打开文件预览失败');
  } finally {
    previewLoading.value = false;
  }
}

function closePreview(): void {
  previewTarget.value = null;
  previewArchivePath.value = null;
  previewInfo.value = null;
}

const previewSource = computed(() => {
  if (!previewTarget.value) return '';
  return previewArchivePath.value
    ? archiveEndpointUrl('preview', previewArchivePath.value, previewTarget.value.path)
    : endpointUrl('preview', previewTarget.value.path);
});

function notifySignatureChange(invalidated: boolean): void {
  if (invalidated) toast('info', 'JAR 签名已失效', '修改已保存；原数字签名文件已移除，避免保留无效签名。');
}

async function saveText(): Promise<void> {
  const target = editTarget.value;
  if (!target) return;
  editSaving.value = true;
  try {
    const url = editArchivePath.value
      ? archiveEndpointUrl('text', editArchivePath.value, target.path)
      : endpointUrl('text', target.path);
    const result = await api.put<{ ok: boolean; revision: string; signatureInvalidated?: boolean }>(url, {
      content: editContent.value,
      revision: editRevision.value,
    });
    editRevision.value = result.revision;
    toast('ok', '文件已保存', target.name);
    notifySignatureChange(Boolean(result.signatureInvalidated));
    editModalOpen.value = false;
    editTarget.value = null;
    editArchivePath.value = null;
    await refresh();
  } catch (err) {
    toastError(err, '保存文件失败');
  } finally {
    editSaving.value = false;
  }
}

async function download(entry: FileEntry): Promise<void> {
  try {
    const url = archiveContext.value
      ? archiveEndpointUrl('download', archiveContext.value.archivePath, entry.path)
      : endpointUrl('download', entry.path);
    await api.downloadFile(url, entry.name);
  } catch (err) {
    toastError(err, '下载文件失败');
  }
}

function chooseUpload(): void {
  if (!readOnly.value && !uploading.value) uploadInput.value?.click();
}

async function uploadSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) return;
  const tooLarge = files.find((file) => file.size > maxUploadBytes.value);
  if (tooLarge) {
    toast('error', '文件超过大小限制', `单个文件上限为 ${fmtBytes(maxUploadBytes.value)}：${tooLarge.name}`);
    return;
  }

  const location: UploadLocation = {
    path: currentPath.value,
    archive: archiveContext.value ? { archivePath: archiveContext.value.archivePath, path: archiveContext.value.path } : null,
  };
  const existingByName = new Map(currentEntries.value.map((entry) => [entry.name, entry]));
  const blocked = files.find((file) => {
    const entry = existingByName.get(file.name);
    return entry && entry.type !== 'file';
  });
  if (blocked) {
    toast('error', '无法覆盖此项目', `“${blocked.name}”同名路径不是普通文件。`);
    return;
  }

  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.name, (counts.get(file.name) ?? 0) + 1);
  const overwriteNames = [...new Set(files
    .filter((file) => existingByName.get(file.name)?.type === 'file' || (counts.get(file.name) ?? 0) > 1)
    .map((file) => file.name))];
  if (overwriteNames.length) {
    pendingOverwrite.value = { files, location, names: overwriteNames };
    return;
  }
  await uploadFiles(files, location, new Set());
}

function cancelOverwriteUpload(): void {
  pendingOverwrite.value = null;
}

async function confirmOverwriteUpload(): Promise<void> {
  const pending = pendingOverwrite.value;
  if (!pending) return;
  pendingOverwrite.value = null;
  await uploadFiles(pending.files, pending.location, new Set(pending.names));
}

async function uploadFiles(files: File[], location: UploadLocation, overwriteNames: ReadonlySet<string>): Promise<void> {
  uploading.value = true;
  uploadProgress.value = { done: 0, total: files.length, percent: 0, name: '' };
  try {
    for (const [index, file] of files.entries()) {
      uploadProgress.value = { done: index, total: files.length, percent: 0, name: file.name };
      const query: Record<string, string> = location.archive
        ? { archive: location.archive.archivePath, path: location.archive.path }
        : { path: location.path };
      if (overwriteNames.has(file.name)) query.overwrite = '1';
      if (location.archive) {
        const result = await api.uploadFile<{ ok: boolean; entry: FileEntry; signatureInvalidated: boolean }>(
          `/api/project-files/jar/upload?${new URLSearchParams(query)}`,
          file,
          (progress) => { uploadProgress.value.percent = progress.percent; },
        );
        notifySignatureChange(result.signatureInvalidated);
      } else {
        await api.uploadFile<{ ok: boolean; entry: FileEntry }>(
          `/api/project-files/upload?${new URLSearchParams(query)}`,
          file,
          (progress) => { uploadProgress.value.percent = progress.percent; },
        );
      }
    }
    toast('ok', '上传完成', `${files.length} 个文件已放入当前文件夹`);
    if (location.archive) {
      await refresh();
      return;
    }
    treeChildren.delete(location.path);
    await loadDirectory(location.path);
    await ensureTreeParents(location.path);
  } catch (err) {
    toastError(err, '上传文件失败');
    await refresh();
  } finally {
    uploading.value = false;
    uploadProgress.value = { done: 0, total: 0, percent: 0, name: '' };
  }
}

function askCreateFolder(): void {
  folderName.value = '';
  folderModalOpen.value = true;
}

async function createFolder(): Promise<void> {
  const name = folderName.value.trim();
  if (!name) return;
  creatingFolder.value = true;
  try {
    let signatureInvalidated = false;
    if (archiveContext.value) {
      const context = archiveContext.value;
      const result = await api.post<{ signatureInvalidated: boolean }>('/api/project-files/jar/folder', { archive: context.archivePath, path: context.path, name });
      signatureInvalidated = result.signatureInvalidated;
    } else await api.post('/api/project-files/folder', { path: currentPath.value, name });
    folderModalOpen.value = false;
    toast('ok', '文件夹已创建', name);
    notifySignatureChange(signatureInvalidated);
    if (archiveContext.value) {
      await refresh();
      return;
    }
    treeChildren.delete(currentPath.value);
    await loadDirectory(currentPath.value);
    await ensureTreeParents(currentPath.value);
  } catch (err) {
    toastError(err, '创建文件夹失败');
  } finally {
    creatingFolder.value = false;
  }
}

function askDelete(entry: FileEntry): void {
  deleteTarget.value = entry;
}

async function deleteEntry(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  deleting.value = true;
  try {
    let signatureInvalidated = false;
    if (archiveContext.value) {
      const context = archiveContext.value;
      const url = `/api/project-files/jar?${new URLSearchParams({ archive: context.archivePath, path: target.path })}`;
      const result = await api.del<{ signatureInvalidated: boolean }>(url);
      signatureInvalidated = result.signatureInvalidated;
    } else await api.del(`/api/project-files?${new URLSearchParams({ path: target.path })}`);
    toast('ok', target.type === 'directory' ? '文件夹已删除' : '文件已删除', target.name);
    notifySignatureChange(signatureInvalidated);
    deleteTarget.value = null;
    if (archiveContext.value) {
      await refresh();
      return;
    }
    treeChildren.delete(target.path);
    await loadDirectory(currentPath.value);
    await ensureTreeParents(currentPath.value);
  } catch (err) {
    toastError(err, '删除失败');
  } finally {
    deleting.value = false;
  }
}

function isSelected(path: string): boolean {
  return currentPath.value === path;
}

function toggleEntrySelection(entry: FileEntry): void {
  if (entry.type === 'link') return;
  const next = new Set(selectedPaths.value);
  if (next.has(entry.path)) next.delete(entry.path);
  else next.add(entry.path);
  selectedPaths.value = next;
}

function toggleSelectAll(): void {
  selectedPaths.value = allSelected.value
    ? new Set()
    : new Set(selectableEntries.value.map((entry) => entry.path));
}

async function downloadSelected(): Promise<void> {
  const paths = selectedEntries.value.filter((entry) => entry.type !== 'link').map((entry) => entry.path);
  if (!paths.length || bulkDownloading.value) return;
  bulkDownloading.value = true;
  try {
    const endpoint = archiveContext.value
      ? `/api/project-files/jar/archive?${new URLSearchParams({ archive: archiveContext.value.archivePath })}`
      : '/api/project-files/archive';
    await api.downloadArchive(endpoint, paths);
    toast('ok', '已开始打包下载', `${paths.length} 个项目已加入 ZIP`);
  } catch (err) {
    toastError(err, '打包下载失败');
  } finally {
    bulkDownloading.value = false;
  }
}

async function deleteSelected(): Promise<void> {
  const entries = selectedEntries.value;
  if (!entries.length || entries.some((entry) => entry.readOnly) || bulkDeleting.value) return;
  bulkDeleting.value = true;
  try {
    const context = archiveContext.value;
    const result = context
      ? await api.post<{ ok: boolean; entries: FileEntry[]; signatureInvalidated: boolean }>('/api/project-files/jar/batch-delete', {
        archive: context.archivePath,
        paths: entries.map((entry) => entry.path),
      })
      : await api.post<{ ok: boolean; entries: FileEntry[]; signatureInvalidated?: boolean }>('/api/project-files/batch-delete', {
        paths: entries.map((entry) => entry.path),
      });
    const removed = new Set((result.entries ?? []).map((entry) => entry.path));
    const visiblePaths = new Set(result.entries.map((entry) => entry.path));
    selectedPaths.value = new Set([...selectedPaths.value].filter((selected) => visiblePaths.has(selected)));
    for (const path of removed) treeChildren.delete(path);
    bulkDeleteOpen.value = false;
    toast('ok', '已删除所选项目', `${removed.size} 个文件或文件夹`);
    notifySignatureChange(Boolean(result.signatureInvalidated));
    if (archiveContext.value) {
      await refresh();
      return;
    }
    await loadDirectory(currentPath.value);
    await ensureTreeParents(currentPath.value);
  } catch (err) {
    toastError(err, '批量删除失败');
  } finally {
    bulkDeleting.value = false;
  }
}

function rowDescription(entry: FileEntry): string {
  if (entry.type === 'link') return '符号链接（不会跟随）';
  if (entry.type === 'directory') return '';
  if (entry.archive) return 'JAR 压缩包 · 可浏览与编辑';
  return entry.editable ? '文本 · 可在线编辑' : '可打开预览';
}

function onDrop(event: DragEvent): void {
  if (readOnly.value || uploading.value) return;
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  const transfer = new DataTransfer();
  for (const file of Array.from(files)) transfer.items.add(file);
  if (uploadInput.value) {
    uploadInput.value.files = transfer.files;
    void uploadSelected({ target: uploadInput.value } as unknown as Event);
  }
}

onMounted(() => {
  restoreFilesSnapshot();
  void refresh();
});
onUnmounted(() => {
  disposed = true;
});
</script>

<template>
  <div class="page files-page">
    <header class="files-heading row-between wrap gap-3">
      <div class="page-heading">
        <h1>文件管理</h1>
        <p>浏览和管理当前项目目录：<code class="mono">{{ projectRoot || '正在读取项目路径…' }}</code></p>
      </div>
      <div class="row wrap gap-2 files-heading-actions">
        <span class="files-upload-limit text-3 small">单文件上限 {{ fmtBytes(maxUploadBytes) }}</span>
        <span class="badge" :class="accessChecking ? 'badge-outline' : accessUnavailable || readOnly ? 'badge-warn' : 'badge-ok'" :title="accessUnavailable ? '无法确认当前目录权限。为保护文件，暂时禁用修改操作。' : readOnly && !accessChecking ? '当前目录属于正在运行的世界，只能浏览、预览和下载；停止该世界后可编辑、上传、创建和删除文件。' : undefined" role="status" aria-live="polite" aria-atomic="true">
          <span class="status-dot" :class="accessChecking ? '' : accessUnavailable || readOnly ? 'status-warn' : 'status-running'" />
          {{ accessLabel }}
        </span>
        <button class="btn" type="button" :disabled="loading || uploading" @click="refresh(true)">
          <span v-if="loading" class="spinner" />
          <Icon v-else name="undo" :size="16" />刷新
        </button>
        <button class="btn" type="button" :disabled="readOnly || uploading" @click="askCreateFolder">
          <Icon name="folder" :size="16" />新建文件夹
        </button>
        <button class="btn btn-primary" type="button" :disabled="readOnly || uploading" @click="chooseUpload">
          <Icon name="upload" :size="16" />上传文件
        </button>
        <input ref="uploadInput" class="visually-hidden" type="file" multiple @change="uploadSelected" />
      </div>
    </header>

    <div v-if="archiveContext" class="files-archive-note" role="status">
      <span>正在浏览 {{ archiveContext.archivePath }}{{ archiveContext.path ? `!/${archiveContext.path}` : '' }}。JAR 内的修改会重新打包整个文件。</span>
      <strong v-if="archiveContext.signed">此 JAR 含数字签名；修改后签名文件会被移除，签名校验将失效。</strong>
    </div>

    <section class="files-shell card" aria-label="项目文件管理器">
      <aside class="files-tree-pane">
        <div class="files-pane-head">
          <div><Icon name="folder" :size="16" /><strong>项目目录</strong></div>
          <span class="text-3 small">{{ treeRows.length }} 项</span>
        </div>
        <nav class="files-tree" aria-label="文件夹树">
          <button
            v-for="row in treeRows"
              :key="row.path || '__project_root__'"
            class="files-tree-row"
            :class="{ selected: isSelected(row.path), 'root-row': row.root }"
            :style="{ '--tree-depth': row.depth }"
            type="button"
            :aria-current="isSelected(row.path) ? 'location' : undefined"
            @click="activateTreeRow(row)"
            @keydown.right.prevent="toggleTree(row)"
            @keydown.left.prevent="expandedPaths.delete(row.path)"
          >
            <span class="files-tree-caret" @click.stop="toggleTree(row)">
              <span v-if="treeLoading.has(row.path)" class="spinner" />
              <Icon v-else-if="hasPotentialChildren(row.path)" :name="expandedPaths.has(row.path) ? 'chevron-down' : 'chevron-right'" :size="14" />
              <span v-else class="tree-caret-spacer" />
            </span>
            <Icon :name="row.root ? 'server' : 'folder'" :size="16" />
            <span class="files-tree-label">{{ row.name }}</span>
          </button>
          <div v-if="!treeRows.length" class="empty small">无法读取目录</div>
        </nav>
      </aside>

      <div class="files-content-pane" @dragover.prevent @drop.prevent="onDrop">
        <div class="files-content-head">
          <nav class="files-breadcrumbs" aria-label="当前位置">
            <template v-for="(crumb, index) in pathCrumbs" :key="`${index}:${crumb.label}`">
              <Icon v-if="index > 0" name="chevron-right" :size="14" />
              <button
                type="button"
                :disabled="crumb.archive ? archiveContext?.path === crumb.entryPath : !archiveContext && currentPath === crumb.projectPath"
                @click="navigateCrumb(crumb)"
              >{{ crumb.label }}</button>
            </template>
          </nav>
          <span class="text-3 small">{{ currentEntries.length }} 项</span>
        </div>

        <div class="files-selection-bar">
          <label class="files-select-all">
            <input type="checkbox" :checked="allSelected" :indeterminate="selectedPaths.size > 0 && !allSelected" :disabled="!selectableEntries.length" @change="toggleSelectAll" />
            <span>全选当前文件夹</span>
          </label>
          <span class="files-selection-count">已选 {{ selectedPaths.size }} 项</span>
          <div class="files-bulk-actions">
            <button class="btn btn-sm" type="button" :disabled="!selectedPaths.size || bulkDownloading" @click="downloadSelected">
              <span v-if="bulkDownloading" class="spinner" /><Icon v-else name="download" :size="14" />下载所选
            </button>
            <button class="btn btn-sm btn-danger" type="button" :disabled="readOnly || !selectedPaths.size || selectedEntries.some(entry => entry.readOnly) || bulkDeleting" @click="bulkDeleteOpen = true">
              <Icon name="trash" :size="14" />删除所选
            </button>
          </div>
        </div>

        <div v-if="uploading" class="files-upload-progress" role="status" aria-live="polite">
          <div class="row-between gap-2 small"><span>正在上传 {{ uploadProgress.name }}</span><span>{{ uploadProgress.done + 1 }}/{{ uploadProgress.total }} · {{ uploadProgress.percent }}%</span></div>
          <div class="progress-track"><div class="progress-fill" :style="{ width: `${uploadProgress.percent}%` }" /></div>
        </div>

        <div v-if="loading && !hasCurrentSnapshot" class="files-table" role="status" aria-label="正在读取文件列表" aria-busy="true">
          <div v-for="row in 7" :key="row" class="files-skeleton-row">
            <div class="skeleton" /> <div class="skeleton" /> <div class="skeleton" />
          </div>
        </div>
        <div v-else-if="loadingError && !currentEntries.length" class="empty files-empty">
          <Icon name="info" :size="28" /><strong>无法读取这个文件夹</strong><span>{{ loadingError }}</span>
          <button class="btn btn-sm" type="button" @click="loadDirectory(currentPath)">重试</button>
        </div>
        <div v-else-if="!currentEntries.length && (!loading || hasCurrentSnapshot)" class="empty files-empty" @dragover.prevent>
          <Icon name="folder" :size="28" /><strong>这个文件夹是空的</strong>
          <span>可以上传文件，或拖放到此处。</span>
          <button class="btn btn-sm" type="button" :disabled="readOnly" @click="chooseUpload">上传文件</button>
        </div>
        <div v-else class="files-table-wrap">
          <div class="files-table-header">
            <span class="files-check-cell" />
            <span>名称</span><span>类型</span><span>修改时间</span><span class="files-actions-heading">操作</span>
          </div>
          <div class="files-table">
            <div
              v-for="entry in currentEntries"
              :key="entry.path"
              class="files-row"
              :class="{ 'is-link': entry.type === 'link' }"
            >
              <span class="files-check-cell">
                <input type="checkbox" :checked="selectedPaths.has(entry.path)" :disabled="entry.type === 'link'" :aria-label="`选择 ${entry.name}`" @change="toggleEntrySelection(entry)" />
              </span>
              <button class="files-name-cell" type="button" :disabled="entry.type === 'link'" @click="openEntry(entry)">
                <Icon :name="entry.type === 'directory' || entry.archive ? 'folder' : entry.type === 'link' ? 'external' : 'events'" :size="17" />
                <span class="files-name-copy"><strong>{{ entry.name }}</strong><small>{{ rowDescription(entry) }}</small></span>
              </button>
              <span class="files-type-cell">{{ entry.type === 'directory' ? '文件夹' : entry.type === 'link' ? '链接' : entry.archive ? 'JAR 文件' : fmtBytes(entry.size) }}</span>
              <span class="files-time-cell">{{ fmtTime(Date.parse(entry.modifiedAt)) }}</span>
              <div class="files-row-actions">
                <button
                  v-if="entry.type === 'file'"
                  class="btn btn-sm"
                  type="button"
                  :title="entry.archive ? '浏览 JAR 内部文件' : entry.editable ? '打开并编辑文本文件' : '在页面中预览文件'"
                  @click="openEntry(entry)"
                >{{ entry.archive ? '进入' : entry.editable ? '打开' : '预览' }}</button>
                <button v-if="entry.type === 'file'" class="btn btn-sm files-download-btn" type="button" title="下载文件" @click="download(entry)">
                  <Icon name="download" :size="14" /><span>下载</span>
                </button>
                <button
                  v-if="!readOnly && !entry.readOnly && entry.deletable"
                  class="btn btn-sm btn-danger"
                  type="button"
                  :title="entry.type === 'directory' ? '删除整个文件夹' : '删除文件'"
                  @click="askDelete(entry)"
                ><Icon name="trash" :size="14" />删除</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <Modal v-if="pendingOverwrite" title="发现同名文件" size="sm" @close="cancelOverwriteUpload">
      <div class="col gap-3">
        <p>当前目录已存在同名文件。选择覆盖上传会替换原文件：</p>
        <div class="files-overwrite-list mono-block small">{{ pendingOverwrite.names.join('\n') }}</div>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="cancelOverwriteUpload">取消上传</button>
        <button class="btn btn-danger-solid" type="button" @click="confirmOverwriteUpload">覆盖上传</button>
      </template>
    </Modal>

    <Modal v-if="folderModalOpen" title="新建文件夹" size="sm" @close="folderModalOpen = false">
      <div class="field">
        <label class="field-label" for="new-folder-name">文件夹名称</label>
        <input id="new-folder-name" v-model="folderName" class="input" maxlength="255" autofocus @keydown.enter="createFolder" />
        <small class="text-3">将在「{{ currentLocationLabel }}」中创建。</small>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="folderModalOpen = false">取消</button>
        <button class="btn btn-primary" type="button" :disabled="!folderName.trim() || creatingFolder" @click="createFolder">
          <span v-if="creatingFolder" class="spinner spinner-on-accent" />创建
        </button>
      </template>
    </Modal>

    <Modal v-if="editModalOpen" :title="`编辑 ${editTarget?.name ?? '文本文件'}`" size="lg" @close="!editSaving && (editModalOpen = false)">
      <div v-if="editLoading" class="files-editor-loading" role="status"><span class="spinner" />正在读取文件…</div>
      <template v-else>
        <div class="row-between wrap gap-2 files-editor-meta">
          <span class="text-3 small">{{ editTarget?.path }}</span>
          <span class="badge badge-outline">UTF-8 · 最大 2 MB</span>
        </div>
        <textarea v-model="editContent" class="input files-editor" :readonly="readOnly" spellcheck="false" aria-label="文件内容" />
        <p class="text-3 small">{{ readOnly ? '当前世界运行期间只能查看文本内容。' : '保存前会检查文件是否被其他进程或程序改动；发现变化时需要重新打开再编辑。' }}</p>
      </template>
      <template #footer>
        <button class="btn" type="button" :disabled="editSaving" @click="editModalOpen = false">关闭</button>
        <button class="btn btn-primary" type="button" :disabled="editLoading || editSaving || readOnly" @click="saveText">
          <span v-if="editSaving" class="spinner spinner-on-accent" />保存更改
        </button>
      </template>
    </Modal>

    <Modal v-if="previewTarget" :title="`预览 ${previewTarget.name}`" size="lg" @close="closePreview">
      <div v-if="previewLoading" class="files-preview-loading" role="status"><span class="spinner" />正在准备预览…</div>
      <div v-else-if="previewInfo" class="files-preview-frame">
        <img v-if="previewInfo.kind === 'image'" class="files-preview-image" :src="previewSource" :alt="previewTarget.name" />
        <audio v-else-if="previewInfo.kind === 'audio'" class="files-preview-audio" :src="previewSource" controls preload="metadata">浏览器不支持此音频格式。</audio>
        <video v-else-if="previewInfo.kind === 'video'" class="files-preview-video" :src="previewSource" controls preload="metadata">浏览器不支持此视频格式。</video>
        <iframe v-else-if="previewInfo.kind === 'pdf' || previewInfo.kind === 'html'" :src="previewSource" :title="previewTarget.name" sandbox="" referrerpolicy="no-referrer" />
        <div v-else class="files-preview-text-wrap">
          <div class="files-preview-summary">
            <strong>{{ previewInfo.kind === 'text' ? '文本预览' : previewInfo.kind === 'large' ? '文件较大' : '二进制预览' }}</strong>
            <span>{{ fmtBytes(previewInfo.size) }}</span>
          </div>
          <p v-if="previewInfo.note" class="text-3 small">{{ previewInfo.note }}</p>
          <p v-if="previewInfo.truncated" class="files-preview-truncated">仅显示文件开头部分，完整内容请下载查看。</p>
          <pre v-if="previewInfo.kind === 'text'" class="files-preview-code">{{ previewInfo.content }}</pre>
          <pre v-else-if="previewInfo.kind === 'binary'" class="files-preview-code files-preview-hex">{{ previewInfo.hex }}</pre>
        </div>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="closePreview">关闭</button>
        <button class="btn btn-primary" type="button" @click="download(previewTarget)"><Icon name="download" :size="15" />下载原文件</button>
      </template>
    </Modal>

    <ConfirmDialog
      :open="bulkDeleteOpen"
      title="批量删除所选项目？"
      :message="`将删除当前文件夹中选中的 ${selectedPaths.size} 项。文件夹会连同内部内容一起删除，此操作不可撤销。`"
      detail="请输入“删除”确认批量删除。"
      danger
      confirm-text="删除所选"
      require-text="删除"
      require-label="输入“删除”以确认"
      :busy="bulkDeleting"
      @close="bulkDeleteOpen = false"
      @confirm="deleteSelected"
    />

    <ConfirmDialog
      :open="Boolean(deleteTarget)"
      :title="deleteTarget?.type === 'directory' ? '删除整个文件夹？' : '删除文件？'"
      :message="deleteTarget?.type === 'directory'
        ? `将递归删除「${deleteTarget?.path}」及其中所有文件。这个操作不可撤销。`
        : deleteTarget?.type === 'link'
          ? `将移除符号链接「${deleteTarget?.path}」。链接目标不会被删除。`
          : `将永久删除「${deleteTarget?.path}」。这个操作不可撤销。`"
      :detail="deleteTarget?.type === 'directory' ? '请输入完整目录路径以确认删除。' : undefined"
      danger
      confirm-text="永久删除"
      :require-text="deleteTarget?.type === 'directory' ? deleteTarget.path : undefined"
      require-label="输入上方目录路径以确认"
      :busy="deleting"
      @close="deleteTarget = null"
      @confirm="deleteEntry"
    />
  </div>
</template>

<style scoped>
.files-page { display: flex; flex-direction: column; gap: var(--sp-4); min-height: 100%; }
.files-heading { align-items: flex-end; }
.files-heading .page-heading { min-width: 230px; }
.files-heading .page-heading p { max-width: min(72vw, 920px); overflow-wrap: anywhere; }
.files-heading .page-heading code { color: var(--text-2); font-size: 11px; }
.files-heading-actions { align-items: center; }
.files-upload-limit { white-space: nowrap; }
.files-overwrite-list { max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.files-archive-note { display: flex; flex-direction: column; gap: 4px; padding: 10px 13px; border: 1px solid var(--accent-border); border-radius: var(--r-sm); background: var(--accent-soft); color: var(--text-2); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.files-archive-note strong { color: var(--warn-text); font-weight: 620; }
.files-shell { display: grid; grid-template-columns: minmax(210px, 250px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: min(700px, calc(100vh - 240px)); min-height: min(700px, calc(100vh - 240px)); overflow: hidden; }
.files-tree-pane { display: flex; min-height: 0; flex-direction: column; border-right: 1px solid var(--border); background: var(--surface-2); }
.files-pane-head { display: flex; min-height: 51px; align-items: center; justify-content: space-between; gap: 8px; padding: 0 14px; border-bottom: 1px solid var(--border); }
.files-pane-head > div { display: flex; align-items: center; gap: 8px; color: var(--accent-text); }
.files-tree { flex: 1; min-height: 220px; overflow: auto; padding: 8px; scrollbar-width: none; }
.files-tree::-webkit-scrollbar, .files-table-wrap::-webkit-scrollbar { display: none; }
.files-tree-row { display: flex; width: 100%; min-width: 0; height: 35px; align-items: center; gap: 7px; padding: 0 8px 0 calc(8px + var(--tree-depth) * 13px); border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text-2); text-align: left; cursor: pointer; }
.files-tree-row:hover { background: var(--surface-hover); color: var(--text); }
.files-tree-row.selected { border-color: var(--accent-border); background: var(--accent-soft); color: var(--text); }
.files-tree-row.root-row { padding-left: 5px; font-weight: 650; }
.files-tree-caret { display: inline-flex; width: 16px; height: 20px; flex: none; align-items: center; justify-content: center; color: var(--text-3); }
.files-tree-caret > .spinner { width: 12px; height: 12px; border-width: 1.5px; }
.tree-caret-spacer { width: 12px; }
.files-tree-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.files-content-pane { --files-check-col: 28px; --files-cell-gap: 10px; --files-row-padding: 13px; display: flex; min-width: 0; min-height: 0; flex-direction: column; }
.files-content-head { display: flex; min-height: 51px; align-items: center; justify-content: space-between; gap: 10px; padding: 0 16px; border-bottom: 1px solid var(--border); }
.files-selection-bar { display: flex; min-height: 43px; align-items: center; gap: 12px; padding: 6px var(--files-row-padding); border-bottom: 1px solid var(--border); color: var(--text-2); font-size: 11.5px; }
.files-select-all { display: inline-grid; grid-template-columns: var(--files-check-col) auto; align-items: center; column-gap: var(--files-cell-gap); white-space: nowrap; cursor: pointer; }
.files-select-all input { justify-self: center; }
.files-selection-count { color: var(--text-3); white-space: nowrap; }
.files-bulk-actions { display: flex; gap: 6px; margin-left: auto; }
.files-bulk-actions .btn { white-space: nowrap; }
.files-breadcrumbs { display: flex; min-width: 0; align-items: center; gap: 5px; overflow: auto; color: var(--text-3); scrollbar-width: none; }
.files-breadcrumbs::-webkit-scrollbar { display: none; }
.files-breadcrumbs button { max-width: 180px; overflow: hidden; border: 0; background: transparent; color: var(--text-2); text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.files-breadcrumbs button:disabled { color: var(--text); font-weight: 650; cursor: default; }
.files-table-wrap { min-width: 0; min-height: 0; flex: 1; overflow: auto; scrollbar-width: none; }
.files-table-header, .files-row { display: grid; grid-template-columns: var(--files-check-col) minmax(155px, 1fr) minmax(78px, 105px) minmax(115px, 145px) minmax(188px, 230px); align-items: center; gap: var(--files-cell-gap); padding: 0 var(--files-row-padding); }
.files-table-header { position: sticky; top: 0; z-index: 1; min-height: 38px; border-bottom: 1px solid var(--border); background: var(--surface-solid); color: var(--text-3); font-size: 11.5px; font-weight: 650; }
.files-check-cell { display: flex; align-items: center; justify-content: center; }
.files-check-cell input, .files-select-all input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent-strong); cursor: pointer; }
.files-check-cell input:disabled { cursor: not-allowed; }
.files-row { min-height: 61px; border-bottom: 1px solid var(--border); }
.files-row:last-child { border-bottom: 0; }
.files-row:hover { background: var(--surface-2); }
.files-name-cell { display: flex; min-width: 0; align-items: center; gap: 10px; padding: 7px 0; border: 0; background: transparent; color: var(--accent-text); text-align: left; cursor: pointer; }
.files-name-cell:disabled { color: var(--text-3); cursor: not-allowed; }
.files-name-cell > svg { flex: none; }
.files-name-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.files-name-copy strong { overflow: hidden; color: var(--text); font-size: 12.5px; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
.files-name-copy small { overflow: hidden; color: var(--text-3); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.files-type-cell, .files-time-cell { color: var(--text-2); font-size: 11.5px; }
.files-time-cell { white-space: nowrap; }
.files-row-actions { display: flex; justify-content: flex-end; gap: 5px; }
.files-row-actions .btn { min-width: 55px; }
.files-download-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
.btn-danger { border-color: var(--danger-border); color: var(--danger-text); }
.btn-danger:hover { border-color: var(--danger-border-hover); background: var(--danger-soft); }
.files-actions-heading { text-align: right; }
.files-empty { min-height: 310px; }
.files-empty > svg { color: var(--accent-text); }
.files-skeleton-row { display: grid; min-height: 61px; grid-template-columns: 28px minmax(155px, 1fr) minmax(78px, 105px) minmax(115px, 145px) minmax(188px, 230px); align-items: center; gap: 10px; padding: 0 13px; border-bottom: 1px solid var(--border); }
.files-skeleton-row .skeleton { height: 13px; }
.files-skeleton-row .skeleton:first-child { width: min(70%, 260px); }
.files-skeleton-row .skeleton:nth-child(2) { width: 56px; }
.files-skeleton-row .skeleton:nth-child(3) { width: 90px; }
.files-upload-progress { display: flex; flex-direction: column; gap: 7px; padding: 10px 15px; border-bottom: 1px solid var(--border); color: var(--text-2); }
.progress-track { height: 5px; overflow: hidden; border-radius: 9px; background: var(--surface-3); }
.progress-fill { height: 100%; border-radius: inherit; background: var(--accent-strong); transition: width 120ms linear; }
.files-editor-meta { margin-bottom: 10px; }
.files-editor { width: 100%; min-height: min(62vh, 600px); resize: vertical; padding: 12px; font-family: var(--mono); font-size: 12px; line-height: 1.6; tab-size: 2; white-space: pre; }
.files-editor-loading { display: flex; min-height: 240px; align-items: center; justify-content: center; gap: 10px; color: var(--text-2); }
.files-preview-frame { display: flex; min-height: min(56vh, 520px); max-height: min(72vh, 760px); align-items: center; justify-content: center; overflow: hidden; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); }
.files-preview-frame iframe { width: 100%; height: min(68vh, 720px); border: 0; background: #fff; }
.files-preview-image { display: block; max-width: 100%; max-height: min(68vh, 720px); object-fit: contain; }
.files-preview-audio { width: min(100%, 640px); }
.files-preview-video { display: block; max-width: 100%; max-height: min(68vh, 720px); }
.files-preview-loading { display: flex; min-height: 260px; align-items: center; justify-content: center; gap: 10px; color: var(--text-2); }
.files-preview-text-wrap { width: 100%; align-self: stretch; overflow: auto; padding: 14px; }
.files-preview-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--text-2); }
.files-preview-truncated { margin: 8px 0; color: var(--warn-text); font-size: 11.5px; }
.files-preview-code { max-height: min(58vh, 620px); overflow: auto; margin: 10px 0 0; padding: 12px; border-radius: var(--r-sm); background: var(--surface-solid); color: var(--text); font-family: var(--mono); font-size: 11.5px; line-height: 1.55; white-space: pre; }
.files-preview-hex { color: var(--text-2); }
.status-dot { display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; background: var(--idle-dot); vertical-align: middle; }
.status-running { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.status-warn { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }
.status-stopped { background: var(--idle-dot); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; clip-path: inset(50%); }

@media (max-width: 1050px) {
  .files-shell { grid-template-columns: 210px minmax(0, 1fr); }
  .files-content-pane { --files-check-col: 26px; --files-cell-gap: 7px; --files-row-padding: 10px; }
  .files-table-header, .files-row, .files-skeleton-row { grid-template-columns: var(--files-check-col) minmax(135px, 1fr) 72px 105px minmax(175px, 205px); gap: var(--files-cell-gap); padding-inline: var(--files-row-padding); }
  .files-row-actions { gap: 4px; }
  .files-row-actions .btn { padding-inline: 7px; }
}
@media (max-width: 760px) {
  .files-heading { align-items: stretch; }
  .files-heading > .row { justify-content: flex-start; }
  .files-heading-actions { align-items: center; }
  .files-heading .page-heading { min-width: 0; }
  .files-heading .page-heading p { max-width: 100%; }
  .files-shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto; height: auto; min-height: auto; }
  .files-tree-pane { max-height: 220px; border-right: 0; border-bottom: 1px solid var(--border); }
  .files-tree { min-height: 90px; max-height: 150px; }
  .files-content-pane { min-height: 400px; }
  .files-table-header { display: none; }
  .files-content-pane { --files-check-col: 25px; --files-cell-gap: 7px; --files-row-padding: 10px; }
  .files-row, .files-skeleton-row { grid-template-columns: var(--files-check-col) minmax(0, 1fr) minmax(148px, auto); gap: 4px var(--files-cell-gap); padding: 8px var(--files-row-padding); }
  .files-row .files-check-cell { grid-column: 1; grid-row: 1 / span 2; align-self: start; padding-top: 10px; }
  .files-name-cell { grid-column: 2; grid-row: 1; gap: 7px; }
  .files-name-copy small { max-width: 100%; }
  .files-type-cell { grid-column: 2; grid-row: 2; padding-left: 24px; font-size: 10.5px; }
  .files-time-cell { display: none; }
  .files-row-actions { grid-column: 3; grid-row: 1 / span 2; flex-wrap: wrap; align-content: center; }
  .files-row-actions .btn { min-width: 0; min-height: 34px; padding: 5px 7px; }
  .files-skeleton-row { grid-template-columns: 25px minmax(0, 1fr) minmax(148px, auto); }
  .files-skeleton-row .skeleton:nth-child(2), .files-skeleton-row .skeleton:nth-child(3) { display: none; }
  .files-skeleton-row .skeleton:first-child { width: 42vw; }
  .files-content-head { padding-inline: 11px; }
  .files-selection-bar { flex-wrap: wrap; gap: 8px 12px; }
  .files-bulk-actions { width: 100%; margin-left: 0; }
  .files-bulk-actions .btn { flex: 1; }
  .files-breadcrumbs button { max-width: 135px; }
}
@media (max-width: 420px) {
  .files-content-pane { --files-check-col: 22px; --files-cell-gap: 4px; --files-row-padding: 7px; }
  .files-row, .files-skeleton-row { grid-template-columns: var(--files-check-col) minmax(64px, 1fr) minmax(130px, auto); gap: var(--files-cell-gap); padding-inline: var(--files-row-padding); }
  .files-row-actions { gap: 3px; }
  .files-row-actions .btn { padding-inline: 5px; font-size: 10.5px; }
  .files-row-actions .files-download-btn { gap: 3px; }
  .files-type-cell { padding-left: 22px; }
}
</style>
