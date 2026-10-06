import fs from 'node:fs';
import { createLogger } from './logger.ts';

const logger = createLogger('dsha');

const BRIDGE = process.env.BC_DSHA_URL || 'http://127.0.0.1:3090';
const TOKEN_FILE = process.env.BC_DSHA_TOKEN_FILE || '/root/.dsh/.bridge_token';

let cachedToken: string | null = null;
function token(): string | null {
  if (cachedToken) return cachedToken;
  if (process.env.BC_DSHA_TOKEN) {
    cachedToken = process.env.BC_DSHA_TOKEN;
    return cachedToken;
  }
  try {
    cachedToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
  return cachedToken;
}

export interface DeviceInfo {
  model: string;
  android: string;
  battery: number | null;
  charging: boolean | null;
  network: string;
  screen: string;
  storageFree: number | null;
  storageTotal: number | null;
  memoryFree: number | null;
  memoryTotal: number | null;
  raw: string;
}

function parseGb(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/([\d.]+)\s*(GB|MB|KB|TB)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const factor = unit === 'TB' ? 1024 : unit === 'MB' ? 1 / 1024 : unit === 'KB' ? 1 / 1024 / 1024 : 1;
  return +(v * factor).toFixed(2);
}

/**
 * 读手机侧真实数据（电量/网络/存储/内存）。桥不可用时返回 null —— 面板要能优雅降级，
 * 因为开源后很多人是在普通 Linux 服务器上跑，根本没有这个桥。
 */
export async function getDeviceInfo(timeoutMs = 4000): Promise<DeviceInfo | null> {
  const t = token();
  if (!t) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE}/app/device?token=${encodeURIComponent(t)}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string };
    const raw = json.result ?? '';
    if (!raw) return null;
    const get = (k: string) => raw.match(new RegExp(`${k}=([^\\n]+)`))?.[1];
    const batteryRaw = get('battery');
    const storageRaw = get('storage_free')?.match(/([\d.]+\s*\w+)/)?.[1];
    const storageTotalRaw = get('storage_free')?.match(/total=([\d.]+\s*\w+)/)?.[1];
    const memRaw = get('memory_free')?.match(/([\d.]+\s*\w+)/)?.[1];
    const memTotalRaw = get('memory_free')?.match(/total=([\d.]+\s*\w+)/)?.[1];
    return {
      model: get('model') ?? '',
      android: get('android') ?? '',
      battery: batteryRaw ? parseInt(batteryRaw, 10) : null,
      charging: get('charging') === 'true',
      network: get('network') ?? '',
      screen: get('screen') ?? '',
      storageFree: parseGb(storageRaw),
      storageTotal: parseGb(storageTotalRaw),
      memoryFree: parseGb(memRaw),
      memoryTotal: parseGb(memTotalRaw),
      raw,
    };
  } catch (err) {
    logger.debug('DSHA 桥不可用（这在普通 Linux 上是正常的）', String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 需要用户拍板时弹手机通知；桥不可用则静默跳过 */
export async function notify(title: string, text: string): Promise<void> {
  const t = token();
  if (!t) return;
  try {
    const url = `${BRIDGE}/app/notify?token=${encodeURIComponent(t)}&title=${encodeURIComponent(title)}&text=${encodeURIComponent(text)}`;
    await fetch(url);
  } catch {
    /* ignore */
  }
}
