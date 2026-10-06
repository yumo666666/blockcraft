import fs from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from '../core/paths.ts';
import { atomicWriteFileSync, readJsonSync } from '../core/fsx.ts';
import { createLogger } from '../core/logger.ts';
import { requiredJavaFor } from './javaService.ts';
import { versionManifest } from './installService.ts';
import type { Loader } from '../types.ts';

const logger = createLogger('versions');

const CACHE_DIR = path.join(STORE_DIR, 'catalog');
const TTL = 6 * 3600 * 1000;

function cached<T>(name: string, fetcher: () => Promise<T>): Promise<T> {
  const file = path.join(CACHE_DIR, `${name}.json`);
  const hit = readJsonSync<{ at: number; data: T } | null>(file, null);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.data);
  return fetcher().then((data) => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    atomicWriteFileSync(file, JSON.stringify({ at: Date.now(), data }, null, 2));
    return data;
  });
}

async function getText(url: string, timeoutMs = 15000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'BlockCraft/2.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export interface McVersion {
  id: string;
  type: string;
}

export async function minecraftVersions(): Promise<McVersion[]> {
  const m = await cached('mc_manifest', async () => {
    const manifest = await versionManifest();
    return manifest.versions.map((v) => ({ id: v.id, type: v.type }));
  });
  return m;
}

/** Forge：官方 promotions 是最省事且可靠的来源 */
export async function forgeVersions(mc: string): Promise<string[]> {
  const promos = await cached('forge_promos', async () => {
    const text = await getText('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    const json = JSON.parse(text) as { promos: Record<string, string> };
    return json.promos;
  });
  const out: string[] = [];
  for (const kind of ['recommended', 'latest']) {
    const v = promos[`${mc}-${kind}`];
    if (v) out.push(v);
  }
  // 再补充该 MC 的其它版本（从 maven 元数据里筛）
  try {
    const all = await cached(`forge_all`, async () => {
      const text = await getText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml').catch(() => '');
      return [...text.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
    });
    for (const raw of all) {
      const m = raw.match(new RegExp(`^${mc.replace(/\./g, '\\.')}-(.+)$`));
      if (m && !out.includes(m[1])) out.push(m[1]);
    }
  } catch {
    /* 元数据拿不到就只用 promotions */
  }
  return out.slice(0, 40);
}

export async function neoforgeVersions(mc: string): Promise<string[]> {
  const all = await cached('neoforge_all', async () => {
    const text = await getText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml').catch(() => '');
    return [...text.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  }).catch(() => [] as string[]);
  // NeoForge 版本形如 20.4.237 对应 MC 1.20.4；1.20.2 之前没有 NeoForge
  const [major, minor] = mc.replace(/^1\./, '').split('.').map((v) => parseInt(v, 10));
  if (!Number.isFinite(major)) return [];
  const prefix = `${major}.${Number.isFinite(minor) ? minor : 0}.`;
  return all.filter((v) => v.startsWith(prefix)).reverse().slice(0, 30);
}

export async function fabricLoaderVersions(): Promise<string[]> {
  return cached('fabric_loaders', async () => {
    const text = await getText('https://meta.fabricmc.net/v2/versions/loader');
    const json = JSON.parse(text) as { version: string; stable: boolean }[];
    return json.filter((v) => v.stable).map((v) => v.version).slice(0, 30);
  }).catch(() => [] as string[]);
}

export interface PaperBuild {
  id: number;
  channel: string;
  url: string;
  name: string;
  size: number;
  sha256: string | null;
}

/**
 * Paper 官方在 2025 年下线了 api.papermc.io/v2（返回 {"ok":false,"error":"sunset"}），
 * 新地址是 fill.papermc.io/v3。这里直接走新接口。
 */
export async function paperBuilds(mc: string): Promise<PaperBuild[]> {
  return cached(`paper_${mc}`, async () => {
    const text = await getText(`https://fill.papermc.io/v3/projects/paper/versions/${mc}/builds`).catch(() => '');
    if (!text) return [] as PaperBuild[];
    const items = JSON.parse(text) as {
      id: number;
      channel?: string;
      downloads?: Record<string, { url?: string; name?: string; size?: number; checksums?: { sha256?: string } }>;
    }[];
    const arr = Array.isArray(items) ? items : [];
    const out: PaperBuild[] = [];
    for (const b of arr) {
      // 新接口里这把 key 有时是 server:default，有时是 server:mojang（实测 1.20.1 是后者），
      // 所以按优先级兜底，别写死一个。
      const dls = b.downloads ?? {};
      const dl = dls['server:default'] ?? dls['server:mojang'] ?? Object.entries(dls).find(([k]) => k.startsWith('server:'))?.[1];
      if (!dl?.url) continue;
      out.push({
        id: b.id,
        channel: b.channel ?? 'STABLE',
        url: dl.url,
        name: dl.name ?? `paper-${mc}-${b.id}.jar`,
        size: dl.size ?? 0,
        sha256: dl.checksums?.sha256 ?? null,
      });
    }
    return out.sort((a, b) => b.id - a.id); // 构建号大的更新（实测接口返回顺序不保证）
  }).catch(() => [] as PaperBuild[]);
}

/** Paper 官方给出的该版本 Java 最低要求（权威来源，不靠猜） */
export async function paperJavaRequirement(mc: string): Promise<number | null> {
  return cached(`paper_info_${mc}`, async () => {
    const text = await getText(`https://fill.papermc.io/v3/projects/paper/versions/${mc}`).catch(() => '');
    if (!text) return null;
    const json = JSON.parse(text) as { java?: { version?: { minimum?: number } } };
    return json.java?.version?.minimum ?? null;
  }).catch(() => null);
}

export interface LoaderAvailability {
  loader: Loader;
  label: string;
  available: boolean;
  versions: string[];
  /** 建议/默认选中的版本 */
  suggested: string | null;
  note: string;
  javaMajor: number;
}

export async function loadersFor(mc: string): Promise<LoaderAvailability[]> {
  const java = requiredJavaFor(mc, 'vanilla');
  const [forge, neo, fabric] = await Promise.all([
    forgeVersions(mc).catch(() => [] as string[]),
    neoforgeVersions(mc).catch(() => [] as string[]),
    fabricLoaderVersions().catch(() => [] as string[]),
  ]);
  const [paper, paperJava] = await Promise.all([
    paperBuilds(mc).catch(() => [] as PaperBuild[]),
    paperJavaRequirement(mc).catch(() => null),
  ]);
  return [
    {
      loader: 'vanilla',
      label: '原版 Vanilla',
      available: true,
      versions: [],
      suggested: null,
      note: '没有任何加载器，只装数据包',
      javaMajor: java,
    },
    {
      loader: 'paper',
      label: 'Paper（插件服）',
      available: paper.length > 0,
      versions: paper.slice(0, 8).map((b) => String(b.id)),
      suggested: paper.length ? String(paper[0].id) : null,
      note: paper.length
        ? `${paper.length} 个构建；插件放 plugins/，面板不解析插件兼容性`
        : '这个版本没有 Paper 构建',
      javaMajor: Math.max(requiredJavaFor(mc, 'paper'), paperJava ?? 0),
    },
    {
      loader: 'forge',
      label: 'Forge',
      available: forge.length > 0,
      versions: forge,
      suggested: forge[0] ?? null,
      note: forge.length ? '1.20.x 及以前的整合包主流' : '这个版本查不到 Forge 构建',
      javaMajor: requiredJavaFor(mc, 'forge'),
    },
    {
      loader: 'neoforge',
      label: 'NeoForge',
      available: neo.length > 0,
      versions: neo,
      suggested: neo[0] ?? null,
      note: neo.length ? '1.20.2 之后的新分支' : '这个版本没有 NeoForge（它只支持 1.20.2+）',
      javaMajor: requiredJavaFor(mc, 'neoforge'),
    },
    {
      loader: 'fabric',
      label: 'Fabric',
      available: fabric.length > 0,
      versions: fabric,
      suggested: fabric[0] ?? null,
      note: fabric.length ? '轻量，模组更新最快' : '拿不到 Fabric 加载器列表（网络问题）',
      javaMajor: requiredJavaFor(mc, 'fabric'),
    },
  ];
}
