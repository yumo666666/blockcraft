import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

/**
 * 读存档里的世界种子。
 *
 * 为什么需要它：`server.properties` 里的 `level-seed` 在「世界第一次生成时没写种子」的情况下是空的，
 * 真正的种子只存在 `world/level.dat`（gzip 过的 NBT）里。
 * 面板要显示种子、要在「复制为新世界」时预填同一个种子，就必须自己解这个文件。
 *
 * 只做读取，遇到任何不认识的结构直接放弃（返回 null），绝不写回 level.dat。
 */

interface NbtCursor {
  buf: Buffer;
  off: number;
}

function readTag(c: NbtCursor, type: number, depth: number): unknown {
  const b = c.buf;
  switch (type) {
    case 1:
      return b.readInt8(c.off++);
    case 2: {
      const v = b.readInt16BE(c.off);
      c.off += 2;
      return v;
    }
    case 3: {
      const v = b.readInt32BE(c.off);
      c.off += 4;
      return v;
    }
    case 4: {
      const v = b.readBigInt64BE(c.off);
      c.off += 8;
      return v;
    }
    case 5: {
      const v = b.readFloatBE(c.off);
      c.off += 4;
      return v;
    }
    case 6: {
      const v = b.readDoubleBE(c.off);
      c.off += 8;
      return v;
    }
    case 7: {
      const len = b.readInt32BE(c.off);
      c.off += 4 + len;
      return null;
    }
    case 8: {
      const len = b.readUInt16BE(c.off);
      c.off += 2;
      const s = b.toString('utf8', c.off, c.off + len);
      c.off += len;
      return s;
    }
    case 9: {
      const el = b.readUInt8(c.off++);
      const len = b.readInt32BE(c.off);
      c.off += 4;
      const arr: unknown[] = [];
      for (let i = 0; i < len; i++) arr.push(readTag(c, el, depth + 1));
      return arr;
    }
    case 10: {
      if (depth > 32) throw new Error('NBT 嵌套过深');
      const obj: Record<string, unknown> = {};
      for (;;) {
        const t = b.readUInt8(c.off++);
        if (t === 0) break;
        const nameLen = b.readUInt16BE(c.off);
        c.off += 2;
        const name = b.toString('utf8', c.off, c.off + nameLen);
        c.off += nameLen;
        obj[name] = readTag(c, t, depth + 1);
      }
      return obj;
    }
    case 11: {
      const len = b.readInt32BE(c.off);
      c.off += 4 + len * 4;
      return null;
    }
    case 12: {
      const len = b.readInt32BE(c.off);
      c.off += 4 + len * 8;
      return null;
    }
    default:
      throw new Error(`未知 NBT 类型 ${type}`);
  }
}

/** 从 level.dat 里取种子；取不到返回 null */
export function readWorldSeed(levelDat: string): string | null {
  try {
    if (!fs.existsSync(levelDat)) return null;
    const raw = fs.readFileSync(levelDat);
    // level.dat 是 gzip 压缩的，但也见过未压缩的（某些工具产物）
    const buf = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
    const c: NbtCursor = { buf, off: 0 };
    const rootType = buf.readUInt8(c.off++);
    if (rootType !== 10) return null;
    const nameLen = buf.readUInt16BE(c.off);
    c.off += 2 + nameLen;
    const root = readTag(c, 10, 0) as Record<string, unknown>;
    const data = (root?.Data ?? root) as Record<string, unknown>;
    if (!data) return null;
    // 1.16+ 在 WorldGenSettings.seed；1.13~1.15 在 RandomSeed
    const wgs = data.WorldGenSettings as { seed?: unknown } | undefined;
    const seed = wgs?.seed ?? data.RandomSeed;
    if (seed === undefined || seed === null) return null;
    return String(seed);
  } catch {
    return null;
  }
}

/** 该世界存档的 level.dat 路径（存档名可能被 level-name 改过） */
export function levelDatPath(serverDir: string, levelName: string | undefined): string {
  return path.join(serverDir, levelName && levelName.trim() ? levelName.trim() : 'world', 'level.dat');
}
