import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { atomicWriteFileSync } from '../core/fsx.ts';
import { instanceServerDir } from '../core/paths.ts';
import { loadConfig } from '../config.ts';
import type { InstanceConfig } from '../types.ts';
import * as I from './instanceService.ts';

const SKIN_RESTORER_MOD = 'ghrZDhGW';
const SKINS_RESTORER_PLUGIN = 'TsLS8Py5';

export type SkinSupportKind = 'skin-restorer-mod' | 'skins-restorer-plugin' | null;

export interface SkinSupportResult {
  kind: SkinSupportKind;
  installed: boolean;
  reason: string;
}

interface ModrinthFile {
  filename: string;
  url: string;
  primary?: boolean;
  size?: number;
  hashes?: { sha512?: string };
}

interface ModrinthVersion {
  version_number: string;
  version_type?: string;
  game_versions: string[];
  loaders: string[];
  files: ModrinthFile[];
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error('无法检查 MOD 文件'));
      else resolve(zip);
    });
  });
}

function readZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, limit = 128 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error('无法读取 MOD 元数据'));
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) {
          (stream as unknown as NodeJS.ReadableStream & { destroy(error?: Error): void }).destroy(new Error('MOD 元数据过大'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

async function jarDeclaresMod(file: string, modId: string, displayName: RegExp): Promise<boolean> {
  let zip: yauzl.ZipFile | null = null;
  try {
    zip = await openZip(file);
    const metadataNames = new Set(['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'plugin.yml', 'paper-plugin.yml']);
    return await new Promise<boolean>((resolve, reject) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        try { zip?.close(); } catch { /* ignore */ }
        resolve(value);
      };
      zip!.on('error', reject);
      zip!.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (!metadataNames.has(name)) {
          zip!.readEntry();
          return;
        }
        void readZipEntry(zip!, entry).then((buffer) => {
          const text = buffer.toString('utf8');
          try {
            const json = JSON.parse(text) as { id?: string; name?: string; quilt_loader?: { id?: string }; metadata?: { name?: string } };
            if (json.id?.toLowerCase() === modId || json.quilt_loader?.id?.toLowerCase() === modId) return finish(true);
            const title = json.name ?? json.metadata?.name ?? '';
            if (displayName.test(title)) return finish(true);
          } catch {
            const ids = [...text.matchAll(/modId\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]?.toLowerCase());
            if (ids.includes(modId)) return finish(true);
            if (displayName.test(text)) return finish(true);
          }
          zip!.readEntry();
        }).catch(reject);
      });
      zip!.on('end', () => finish(false));
      zip!.readEntry();
    });
  } catch {
    try { zip?.close(); } catch { /* ignore */ }
    return false;
  }
}

async function findJar(serverDir: string, parent: 'mods' | 'plugins', id: string, title: RegExp): Promise<string | null> {
  const dir = path.join(serverDir, parent);
  let files: string[];
  try { files = fs.readdirSync(dir).filter((file) => /\.jar$/i.test(file)); } catch { return null; }
  const named = files.find((file) => title.test(file));
  if (named) return path.join(dir, named);
  for (const file of files) {
    const full = path.join(dir, file);
    if (await jarDeclaresMod(full, id, title)) return full;
  }
  return null;
}

export async function detectSkinSupport(id: string): Promise<SkinSupportKind> {
  const serverDir = instanceServerDir(id);
  if (await findJar(serverDir, 'mods', 'skinrestorer', /skin[\s_-]*restorer/i)) return 'skin-restorer-mod';
  if (await findJar(serverDir, 'plugins', 'skinsrestorer', /skins[\s_-]*restorer/i)) return 'skins-restorer-plugin';
  return null;
}

async function compatibleVersion(project: string, mc: string, loader: string, signal?: AbortSignal): Promise<ModrinthVersion> {
  const query = new URLSearchParams({
    game_versions: JSON.stringify([mc]),
    loaders: JSON.stringify([loader]),
  });
  const controller = new AbortController();
  const onCancel = () => controller.abort(signal?.reason ?? new Error('导入任务已取消'));
  signal?.addEventListener('abort', onCancel, { once: true });
  if (signal?.aborted) onCancel();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`https://api.modrinth.com/v2/project/${project}/version?${query}`, {
      headers: { 'user-agent': 'BlockCraft/2.2 (Minecraft server skin integration)' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Modrinth API 返回 HTTP ${response.status}`);
    const versions = await response.json() as ModrinthVersion[];
    const version = versions.find((item) =>
      item.game_versions.includes(mc) && item.loaders.includes(loader) && (item.version_type ?? 'release') === 'release' &&
      item.files.some((file) => file.primary || item.files.length === 1),
    );
    if (!version) throw new Error(`没有找到 Minecraft ${mc} / ${loader} 的正式版皮肤组件`);
    return version;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof Error && error.name === 'AbortError') throw new Error('查询 Modrinth 版本超时');
    throw error;
  } finally {
    signal?.removeEventListener('abort', onCancel);
    clearTimeout(timer);
  }
}

async function installArtifact(project: string, cfg: InstanceConfig, loader: string, targetDir: string, onLog: (line: string) => void, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const version = await compatibleVersion(project, cfg.mc, loader, signal);
  const file = version.files.find((item) => item.primary) ?? version.files[0];
  if (!file?.url || !file.filename || path.basename(file.filename) !== file.filename) throw new Error('Modrinth 没有返回有效的 MOD 文件');
  if (file.size && file.size > 64 * 1024 * 1024) throw new Error('皮肤组件文件超过 64MB，已取消下载');
  fs.mkdirSync(targetDir, { recursive: true });
  const destination = path.join(targetDir, file.filename);
  const temporary = `${destination}.download-${crypto.randomBytes(5).toString('hex')}`;
  const controller = new AbortController();
  const onCancel = () => controller.abort(signal?.reason ?? new Error('导入任务已取消'));
  signal?.addEventListener('abort', onCancel, { once: true });
  if (signal?.aborted) onCancel();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    onLog(`下载 ${version.version_number}：${file.filename}`);
    const response = await fetch(file.url, { headers: { 'user-agent': 'BlockCraft/2.2' }, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`下载皮肤组件失败（HTTP ${response.status}）`);
    const data = Buffer.from(await response.arrayBuffer());
    signal?.throwIfAborted();
    if (data.length > 64 * 1024 * 1024) throw new Error('皮肤组件文件超过 64MB，已取消下载');
    if (file.hashes?.sha512) {
      const digest = crypto.createHash('sha512').update(data).digest('hex');
      if (digest.toLowerCase() !== file.hashes.sha512.toLowerCase()) throw new Error('皮肤组件校验失败（SHA-512 不匹配）');
    }
    await fsp.writeFile(temporary, data, { flag: 'wx' });
    signal?.throwIfAborted();
    await fsp.rename(temporary, destination);
    onLog(`已安装 ${file.filename}`);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof Error && error.name === 'AbortError') throw new Error('下载皮肤组件超时');
    throw error;
  } finally {
    signal?.removeEventListener('abort', onCancel);
    clearTimeout(timer);
  }
}

function configureSkinRestorerLocalUploads(serverDir: string): void {
  const configDir = path.join(serverDir, 'config', 'skinrestorer');
  const configFile = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>; } catch { /* First launch creates the rest of the defaults. */ }
  const providers = (config.providers && typeof config.providers === 'object' ? config.providers : {}) as Record<string, unknown>;
  const mineskin = (providers.mineskin && typeof providers.mineskin === 'object' ? providers.mineskin : {}) as Record<string, unknown>;
  mineskin.proxyUrlUpload = true;
  const panelApiKey = loadConfig().skins.mineskinApiKey;
  if (panelApiKey) mineskin.apiKey = panelApiKey;
  providers.mineskin = mineskin;
  config.providers = providers;
  atomicWriteFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
}

/** Install the right server-only skin engine when this exact Minecraft/loader has a published artifact. */
export async function ensureSkinSupport(id: string, onLog: (line: string) => void = () => undefined, opts: { signal?: AbortSignal } = {}): Promise<SkinSupportResult> {
  opts.signal?.throwIfAborted();
  const cfg = I.getConfig(id);
  const serverDir = instanceServerDir(id);
  const already = await detectSkinSupport(id);
  if (already) {
    if (already === 'skin-restorer-mod') configureSkinRestorerLocalUploads(serverDir);
    onLog(already === 'skin-restorer-mod' ? '已检测到 Skin Restorer 服务端模组' : '已检测到 SkinsRestorer 服务端插件');
    return { kind: already, installed: false, reason: '已存在' };
  }

  if (cfg.loader === 'paper') {
    try {
      await installArtifact(SKINS_RESTORER_PLUGIN, cfg, 'paper', path.join(serverDir, 'plugins'), onLog, opts.signal);
      return { kind: 'skins-restorer-plugin', installed: true, reason: '已自动安装 Paper 插件' };
    } catch (error) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? error;
      const reason = error instanceof Error ? error.message : String(error);
      onLog(`SkinsRestorer 插件没有安装：${reason}。世界仍可启动。`);
      return { kind: null, installed: false, reason };
    }
  }

  if (['forge', 'fabric', 'neoforge'].includes(cfg.loader)) {
    try {
      await installArtifact(SKIN_RESTORER_MOD, cfg, cfg.loader, path.join(serverDir, 'mods'), onLog, opts.signal);
      configureSkinRestorerLocalUploads(serverDir);
      return { kind: 'skin-restorer-mod', installed: true, reason: '已自动安装服务端模组' };
    } catch (error) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? error;
      const reason = error instanceof Error ? error.message : String(error);
      onLog(`Skin Restorer 模组没有安装：${reason}。世界仍可启动。`);
      return { kind: null, installed: false, reason };
    }
  }

  const reason = '纯 Vanilla 服务端不能加载 MOD 或插件；请使用 Paper 或 Fabric、Forge、NeoForge 世界。';
  onLog(`未安装皮肤组件：${reason}`);
  return { kind: null, installed: false, reason };
}

export function skinSupportInstallStageLabel(): string {
  return '自动安装离线皮肤组件（有兼容版本时）';
}

