/**
 * 发公告。
 *
 * 为什么用 tellraw 而不是 say：
 *   `/say 文本` 只能发纯文本，上不了颜色；`/tellraw @a {"text":"…","color":"…"}`
 *   才能指定颜色，而且是所有版本都稳的做法。
 *
 * 坑：tellraw 后面跟的是 JSON，内容里的 `"`、`\`、换行都必须按 JSON 规则转义，
 * 否则一条公告就能把命令拼坏（服务端会回 "Invalid JSON"）。这里统一用
 * JSON.stringify 生成，避免手拼字符串。
 */

export interface AnnounceColor {
  id: string;
  label: string;
  hex: string;
}

/** Minecraft 的聊天颜色名（原版认可的 16 色里挑常用的） */
export const ANNOUNCE_COLORS: AnnounceColor[] = [
  { id: 'white', label: '白', hex: '#ffffff' },
  { id: 'yellow', label: '黄', hex: '#ffff55' },
  { id: 'gold', label: '金', hex: '#ffaa00' },
  { id: 'red', label: '红', hex: '#ff5555' },
  { id: 'green', label: '绿', hex: '#55ff55' },
  { id: 'aqua', label: '青', hex: '#55ffff' },
  { id: 'blue', label: '蓝', hex: '#5555ff' },
  { id: 'light_purple', label: '紫', hex: '#ff55ff' },
  { id: 'gray', label: '灰', hex: '#aaaaaa' },
  { id: 'dark_red', label: '暗红', hex: '#aa0000' },
];

export const DEFAULT_ANNOUNCE_COLOR = 'gold';

/** 拼出可直接发送的 tellraw 命令 */
export function buildAnnounce(text: string, color: string): string {
  const body = JSON.stringify({ text: text.trim(), color });
  return `tellraw @a ${body}`;
}

/** 给界面做预览用（截断，别把整条长公告铺满一行） */
export function previewAnnounce(text: string, color: string, max = 60): string {
  const cmd = buildAnnounce(text, color);
  return cmd.length > max ? `${cmd.slice(0, max)}…` : cmd;
}
