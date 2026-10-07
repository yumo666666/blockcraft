import fs from 'node:fs';
import path from 'node:path';

/**
 * 读服务端的崩溃报告，翻译成一句人能看懂的话。
 *
 * 为什么需要它：世界炸掉之后，面板原来只会说「已停止」，用户得自己去翻
 * crash-reports 目录才知道发生了什么（实测最常见的是服务端自带看门狗判定卡死：
 * 'ServerHangWatchdog detected that a single server tick took 60.00 seconds'）。
 */

export interface CrashInfo {
  file: string;
  /** 报告里的时间（原样字符串） */
  time: string;
  /** 报告里的 Description 行 */
  description: string;
  /** 翻译后的中文说明 */
  reason: string;
  /** 文件修改时间（毫秒） */
  mtime: number;
}

/** 把常见的崩溃特征翻译成人话 */
function explain(text: string): string {
  if (/ServerHangWatchdog detected that a single server tick took/i.test(text)) {
    const sec = text.match(/took ([\d.]+) seconds/i)?.[1];
    return `单个 tick 卡了 ${sec ?? '60'} 秒，被服务端自带看门狗判定为卡死并强制关闭（通常是内存不足/换页导致的卡顿，可提高 max-tick-time 或降低视距）`;
  }
  if (/OutOfMemoryError/i.test(text)) return '内存不足（Java 堆溢出），需要提高该世界的 Xmx 或减少模组/视距';
  if (/java\.lang\.UnsupportedClassVersionError/i.test(text)) return 'Java 版本过低，请提高该世界的 Java 版本';
  if (/Exception in thread "main"/i.test(text)) return '主线程异常退出，详见崩溃报告';
  if (/Ticking (block entity|entity)/i.test(text)) {
    const what = text.match(/Ticking (block entity|entity) '([^']+)'/i);
    return `某个方块实体/实体导致崩溃：${what?.[2] ?? '未知'}（多为模组 bug，可尝试移除对应模组或回退存档）`;
  }
  return '服务端异常退出，详见崩溃报告';
}

/**
 * 找最新的崩溃报告。
 * @param sinceMs 只要比这个时间新的（一般传世界的启动时间），避免把很久以前的崩溃当成本次的
 */
export function latestCrashReport(serverDir: string, sinceMs = 0): CrashInfo | null {
  const dir = path.join(serverDir, 'crash-reports');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.startsWith('crash-') && f.endsWith('.txt'));
  } catch {
    return null;
  }
  let newest: { file: string; mtime: number } | null = null;
  for (const n of names) {
    try {
      const st = fs.statSync(path.join(dir, n));
      if (!newest || st.mtimeMs > newest.mtime) newest = { file: path.join(dir, n), mtime: st.mtimeMs };
    } catch {
      /* ignore */
    }
  }
  if (!newest || newest.mtime < sinceMs) return null;

  let head = '';
  try {
    // 崩溃报告开头几百行就够判断了，别整个读进来（有的报告几 MB）
    const fd = fs.openSync(newest.file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  }
  const time = head.match(/^Time:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const description = head.match(/^Description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  return {
    file: path.basename(newest.file),
    time,
    description,
    reason: explain(head),
    mtime: newest.mtime,
  };
}
