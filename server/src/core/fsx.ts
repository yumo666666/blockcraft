import fs from 'node:fs';
import path from 'node:path';

/**
 * 原子写：先写同目录临时文件 → fsync → rename 覆盖。
 * 任何时刻磁盘上的正式文件要么是旧的、要么是完整的新内容，不存在「写了一半」。
 * 这是任务书 §11 的硬性写盘规范。
 */
export function atomicWriteFileSync(file: string, data: string | Buffer): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function atomicWriteJsonSync(file: string, value: unknown): void {
  atomicWriteFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/** 读取 JSON；损坏时尝试 .bak，再失败返回 fallback（并保留坏文件供排查） */
export function readJsonSync<T>(file: string, fallback: T): T {
  for (const candidate of [file, `${file}.bak`]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      if (!raw.trim()) continue;
      return JSON.parse(raw) as T;
    } catch {
      if (candidate === file) {
        try {
          fs.copyFileSync(file, `${file}.corrupt.${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return fallback;
}

/** 写之前自动留一份 .bak（只保留一份），用于损坏恢复 */
export function atomicWriteJsonWithBackupSync(file: string, value: unknown): void {
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* ignore */
    }
  }
  atomicWriteJsonSync(file, value);
}

export function readTextSafe(file: string, maxBytes = 512 * 1024): string {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return '';
    if (stat.size <= maxBytes) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** 目录占用（真实占盘，按块算）。硬链接/软链一律只算一次，避免重复计数 */
export function dirSizeSync(dir: string, opts: { maxFiles?: number; followSymlinks?: boolean } = {}): number {
  const maxFiles = opts.maxFiles ?? 200000;
  const follow = opts.followSymlinks ?? false;
  const seen = new Set<string>();
  const visitedDirs = new Set<string>();
  let total = 0;
  let count = 0;
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    if (follow) {
      let real = cur;
      try {
        real = fs.realpathSync(cur);
      } catch {
        /* ignore */
      }
      if (visitedDirs.has(real)) continue; // 防软链成环
      visitedDirs.add(real);
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++count > maxFiles) return total;
      const full = path.join(cur, e.name);
      let st: fs.Stats;
      try {
        st = follow ? fs.statSync(full) : fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!follow && st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        const key = `${st.dev}:${st.ino}`;
        if (st.nlink > 1) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        total += st.blocks * 512;
      }
    }
  }
  return total;
}

/**
 * 列目录里的「普通文件」（跟随软链，不依赖 dirent 的 d_type）。
 * 本机 f2fs 会把 nlink>1 的普通文件报成 DT_LNK，Node 的 dirent.isFile() 会漏掉它们，
 * 所以这里统一用 statSync 判断——这条规则在 NFS/FUSE 等文件系统上同样成立。
 */
export function listFilesSync(dir: string, filter?: (name: string) => boolean): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (filter && !filter(e.name)) continue;
    const full = path.join(dir, e.name);
    try {
      if (fs.statSync(full).isFile()) out.push(full);
    } catch {
      /* ignore */
    }
  }
  return out;
}
