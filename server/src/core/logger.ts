import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR, AUDIT_FILE } from './paths.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

const COLORS: Record<Level, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';
const LEVELS: Level[] = ['debug', 'info', 'warn', 'error'];
const minLevel: Level = (process.env.BC_LOG_LEVEL as Level) || 'info';

let stream: fs.WriteStream | null = null;
function fileStream(): fs.WriteStream {
  if (!stream) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(path.join(LOG_DIR, 'panel.log'), { flags: 'a' });
  }
  return stream;
}

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(minLevel)) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const tail = extra === undefined ? '' : ' ' + safeJson(extra);
  const line = `${ts} [${level.toUpperCase()}] [${scope}] ${msg}${tail}`;
  const console_ = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  console_(`${COLORS[level]}${line}${RESET}`);
  try {
    fileStream().write(line + '\n');
  } catch {
    /* ignore */
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write('debug', scope, m, e),
    info: (m: string, e?: unknown) => write('info', scope, m, e),
    warn: (m: string, e?: unknown) => write('warn', scope, m, e),
    error: (m: string, e?: unknown) => write('error', scope, m, e),
  };
}

export const log = createLogger('panel');

/** 审计：谁在什么时间对哪个目标做了什么 */
export function audit(entry: {
  ip?: string;
  action: string;
  target?: string;
  result?: string;
  ms?: number;
  detail?: unknown;
}): void {
  const line = JSON.stringify({ ts: Date.now(), ...entry });
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, line + '\n');
  } catch {
    /* ignore */
  }
}
