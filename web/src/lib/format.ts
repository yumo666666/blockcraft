export function fmtBytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtRelative(ts: number | null | undefined): string {
  if (!ts) return '从未';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

export const STATUS_TEXT: Record<string, string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '关闭中',
  stopped: '已停止',
  stuck: '卡住',
  crashed: '异常退出',
};

export function statusClass(status: string): string {
  switch (status) {
    case 'running':
      return 'dot-ok';
    case 'starting':
    case 'stopping':
      return 'dot-warn dot-pulse';
    case 'stuck':
    case 'crashed':
      return 'dot-danger';
    default:
      return 'dot-idle';
  }
}

export function noteColors(): string[] {
  return ['#f6e7cf', '#e3efdd', '#dde9f4', '#f3e2ec', '#fbf1cf', '#e6e5f5', '#f6e3dc', '#dfeeec'];
}

export function stripMcColors(s: string): string {
  return s.replace(/§./g, '');
}
