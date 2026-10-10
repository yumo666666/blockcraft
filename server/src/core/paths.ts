import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** 项目根：由 BC_ROOT 覆盖，默认取仓库根目录（server/src/core → ../../..） */
export const PROJECT_ROOT = process.env.BC_ROOT
  ? path.resolve(process.env.BC_ROOT)
  : path.resolve(here, '..', '..', '..');

export const DATA_DIR = process.env.BC_DATA_DIR
  ? path.resolve(process.env.BC_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');

export const INSTANCES_DIR = process.env.BC_INSTANCE_DIR
  ? path.resolve(process.env.BC_INSTANCE_DIR)
  : path.join(PROJECT_ROOT, 'instances');

export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const STORE_DIR = path.join(DATA_DIR, 'store');
// Store world folders beside live worlds. Windows can otherwise reject a
// directory move when data/ and instances/ have different ACLs or volumes.
export const TRASH_DIR = path.join(INSTANCES_DIR, '.trash');
export const JDK_DIR = path.join(DATA_DIR, 'jdk');
export const WEB_DIST = path.join(PROJECT_ROOT, 'web', 'dist');
export const BIN_DIR = path.join(PROJECT_ROOT, 'bin');

export const PANEL_CONFIG_FILE = path.join(DATA_DIR, 'panel.json');
export const PORTS_FILE = path.join(DATA_DIR, 'ports.json');
export const MODS_CACHE_FILE = path.join(DATA_DIR, 'mods-cache.json');
export const PLAYERS_CACHE_FILE = path.join(DATA_DIR, 'players-cache.json');
export const SKIN_BINDINGS_FILE = path.join(DATA_DIR, 'skin-bindings.json');
export const JOBS_DIR = path.join(DATA_DIR, 'jobs');
export const AUDIT_FILE = path.join(LOG_DIR, 'audit.jsonl');

export function instanceDir(id: string): string {
  return path.join(INSTANCES_DIR, id);
}
export function instanceConfigFile(id: string): string {
  return path.join(instanceDir(id), 'config.json');
}
export function instanceStateFile(id: string): string {
  return path.join(instanceDir(id), 'state.json');
}
export function instanceServerDir(id: string): string {
  return path.join(instanceDir(id), 'server');
}
export function instanceBackupDir(id: string): string {
  return path.join(instanceDir(id), 'backups');
}

/** 允许的实例 id：字母数字下划线连字符，1~40 位，不含点 */
export const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function ensureDirs(): void {
  for (const d of [DATA_DIR, INSTANCES_DIR, TRASH_DIR, LOG_DIR, STORE_DIR, JOBS_DIR, BIN_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
