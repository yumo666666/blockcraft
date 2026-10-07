/**
 * 命令补全逻辑的单元测试（纯函数，不需要面板在跑）。
 * 这块是「像游戏里一样有提示」的核心，回归成本低但容易写错，值得钉住。
 */
import { describe, expect, it } from 'vitest';
import { applySuggestion, suggest } from '../lib/commands.ts';

const PLAYERS = ['XiaoMing', 'Steve_007', 'Alex_CN'];

describe('命令名补全', () => {
  it('打一半能补出候选，并带中文说明', () => {
    const out = suggest('whitel', PLAYERS);
    expect(out.map((s) => s.label)).toContain('whitelist');
    const wl = out.find((s) => s.label === 'whitelist');
    expect(wl?.desc).toContain('白名单');
  });

  it('没输入时给出常用命令', () => {
    expect(suggest('', PLAYERS).length).toBeGreaterThan(5);
  });
});

describe('参数补全', () => {
  it('op 后面提示在线玩家', () => {
    const out = suggest('op Xi', PLAYERS);
    expect(out.map((s) => s.label)).toEqual(['XiaoMing']);
    expect(out[0].kind).toBe('player');
  });

  it('whitelist add 第二个参数位也提示玩家', () => {
    const out = suggest('whitelist add Al', PLAYERS);
    expect(out.map((s) => s.label)).toContain('Alex_CN');
  });

  it('gamerule 提示规则名与中文说明', () => {
    const out = suggest('gamerule keep', PLAYERS);
    expect(out[0].label).toBe('keepInventory');
    expect(out[0].desc).toContain('死亡');
  });

  it('gamerule 的值给 true / false', () => {
    const out = suggest('gamerule keepInventory ', PLAYERS);
    expect(out.map((s) => s.label)).toEqual(['true', 'false']);
  });

  it('time / weather / difficulty 给固定取值', () => {
    // time 后面先提示子命令，time set 之后才是 day/night
    expect(suggest('time ', PLAYERS).map((s) => s.label)).toEqual(['set', 'add', 'query']);
    expect(suggest('time set ', PLAYERS).map((s) => s.label)).toContain('night');
    expect(suggest('weather ', PLAYERS).map((s) => s.label)).toContain('thunder');
    expect(suggest('difficulty h', PLAYERS).map((s) => s.label)).toEqual(['hard']);
  });
});

describe('补全写回输入框', () => {
  it('命令名补全后带一个空格，可以直接接着打参数', () => {
    expect(applySuggestion('whitel', { value: 'whitelist ', label: 'whitelist', desc: '', kind: 'command' })).toBe('whitelist ');
  });
  it('替换的是当前正在输的那一段，不动前面的参数', () => {
    expect(applySuggestion('op Xi', { value: 'XiaoMing', label: 'XiaoMing', desc: '', kind: 'player' })).toBe('op XiaoMing');
  });
  it('末尾已有空格时直接追加（参数位补全）', () => {
    expect(applySuggestion('gamerule ', { value: 'keepInventory ', label: 'keepInventory', desc: '', kind: 'rule' })).toBe('gamerule keepInventory ');
  });
});
