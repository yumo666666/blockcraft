import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createLogger } from '../core/logger.ts';

const logger = createLogger('host-network');

interface NetworkTotals {
  at: number;
  received: number;
  sent: number;
}

export interface HostNetworkRates {
  received: number | null;
  sent: number | null;
}

let previous: NetworkTotals | null = null;
let pendingRead: Promise<NetworkTotals | null> | null = null;

function validCounter(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function readWindowsTotals(): Promise<NetworkTotals | null> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$up=@(Get-NetAdapter -ErrorAction Stop | Where-Object Status -eq 'Up' | Select-Object -ExpandProperty Name)",
    "$rows=@(Get-NetAdapterStatistics -ErrorAction Stop | Where-Object { $up -contains $_.Name })",
    "$rx=($rows | Measure-Object -Property ReceivedBytes -Sum).Sum",
    "$tx=($rows | Measure-Object -Property SentBytes -Sum).Sum",
    "[Console]::Out.WriteLine((@{received=[double]$rx;sent=[double]$tx}|ConvertTo-Json -Compress))",
  ].join(';');

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    const finish = (value: NetworkTotals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 3_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.once('error', () => finish(null));
    child.once('close', (code) => {
      if (code !== 0) return finish(null);
      try {
        const parsed = JSON.parse(output.trim()) as { received?: unknown; sent?: unknown };
        const received = validCounter(parsed.received);
        const sent = validCounter(parsed.sent);
        if (received === null || sent === null) return finish(null);
        finish({ at: Date.now(), received, sent });
      } catch {
        finish(null);
      }
    });
  });
}

async function readLinuxTotals(): Promise<NetworkTotals | null> {
  try {
    const content = await fs.readFile('/proc/net/dev', 'utf8');
    let received = 0;
    let sent = 0;
    let interfaces = 0;
    for (const line of content.split(/\r?\n/).slice(2)) {
      const split = line.indexOf(':');
      if (split < 0) continue;
      const name = line.slice(0, split).trim();
      if (!name || name === 'lo') continue;
      const fields = line.slice(split + 1).trim().split(/\s+/).map(Number);
      if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
      received += fields[0];
      sent += fields[8];
      interfaces += 1;
    }
    return interfaces ? { at: Date.now(), received, sent } : null;
  } catch (error) {
    logger.debug('读取 Linux 网卡计数器失败', String(error));
    return null;
  }
}

async function readTotals(): Promise<NetworkTotals | null> {
  if (process.platform === 'win32') return readWindowsTotals();
  if (process.platform === 'linux') return readLinuxTotals();
  return null;
}

/** Return host-level receive/send rates from OS counters when Spark cannot supply them. */
export async function readHostNetworkRates(): Promise<HostNetworkRates> {
  if (!pendingRead) {
    pendingRead = readTotals().catch((error) => {
      logger.debug('读取主机网卡计数器失败', String(error));
      return null;
    }).finally(() => { pendingRead = null; });
  }
  const current = await pendingRead;
  if (!current) return { received: null, sent: null };

  const before = previous;
  previous = current;
  if (!before || current.at <= before.at) return { received: null, sent: null };
  const elapsedSeconds = (current.at - before.at) / 1_000;
  const rate = (next: number, prior: number): number | null => next >= prior ? (next - prior) / elapsedSeconds : null;
  return {
    received: rate(current.received, before.received),
    sent: rate(current.sent, before.sent),
  };
}
