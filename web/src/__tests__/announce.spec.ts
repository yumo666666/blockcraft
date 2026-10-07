/**
 * 发公告的命令拼装。
 * 这里最要紧的是**转义**：tellraw 后面是 JSON，内容里的引号/反斜杠/换行没转义好，
 * 服务端会直接回 "Invalid JSON"，公告就发不出去。
 */
import { describe, expect, it } from 'vitest';
import { ANNOUNCE_COLORS, buildAnnounce, previewAnnounce } from '../lib/announce.ts';

describe('发公告命令', () => {
  it('基本格式：tellraw @a + JSON，颜色写进 JSON', () => {
    expect(buildAnnounce('大家好啊', 'gold')).toBe('tellraw @a {"text":"大家好啊","color":"gold"}');
  });

  it('内容里的双引号会被转义，不会把命令拼坏', () => {
    const cmd = buildAnnounce('他说"你好"', 'red');
    expect(cmd).toBe('tellraw @a {"text":"他说\\"你好\\"","color":"red"}');
    // 关键：整体必须是合法 JSON
    const json = cmd.replace('tellraw @a ', '');
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json)).toEqual({ text: '他说"你好"', color: 'red' });
  });

  it('反斜杠、换行、制表符也能安全处理', () => {
    const text = 'C:\\Users\\abc\n第二行\t制表';
    const json = buildAnnounce(text, 'aqua').replace('tellraw @a ', '');
    expect(() => JSON.parse(json)).not.toThrow();
    expect((JSON.parse(json) as { text: string }).text).toBe(text);
  });

  it('前后空格会被去掉（避免发出去一条带空白的公告）', () => {
    expect(buildAnnounce('  公告  ', 'yellow')).toContain('"text":"公告"');
  });

  it('颜色表里的 id 都是原版认可的颜色名', () => {
    const allowed = new Set([
      'white', 'yellow', 'gold', 'red', 'green', 'aqua', 'blue', 'light_purple',
      'gray', 'dark_red', 'dark_green', 'dark_aqua', 'dark_blue', 'dark_purple',
      'dark_gray', 'black',
    ]);
    for (const c of ANNOUNCE_COLORS) expect(allowed.has(c.id), `非法颜色名 ${c.id}`).toBe(true);
  });

  it('预览会截断，不会把长公告铺满一行', () => {
    const long = '啊'.repeat(200);
    const p = previewAnnounce(long, 'gold', 60);
    expect(p.length).toBeLessThanOrEqual(61);
    expect(p.endsWith('…')).toBe(true);
  });
});
