/**
 * 常用 Minecraft 参数提示。当前世界的根命令从服务端 `/help` 同步；RCON
 * 不包含游戏客户端的 Brigadier 建议包，所以这里的参数候选是版本通用提示。
 */

export interface Suggestion {
  /** 补全后填进输入框的完整前缀（含尾随空格） */
  value: string;
  /** 列表里显示的名称 */
  label: string;
  /** 中文说明 */
  desc: string;
  kind: 'command' | 'player' | 'value' | 'rule';
}

interface CommandDef {
  name: string;
  desc: string;
  /** 参数提示，仅用于展示 */
  usage?: string;
  /** 这个命令后面跟玩家名 */
  playerArg?: boolean;
  /** 固定取值（补全用） */
  values?: string[];
  aliases?: string[];
}

export const MC_COMMANDS: CommandDef[] = [
  { name: 'list', desc: '列出在线玩家' },
  { name: 'save-all', desc: '保存世界（加 flush 则等待完成）', values: ['flush'] },
  { name: 'save-on', desc: '开启自动保存' },
  { name: 'save-off', desc: '关闭自动保存（手动备份前用）' },
  { name: 'stop', desc: '关闭服务器（面板请用卡片上的停止按钮）' },
  { name: 'reload', desc: '重新加载数据包与函数' },
  { name: 'whitelist', desc: '白名单管理', values: ['add', 'remove', 'list', 'on', 'off', 'reload'], playerArg: true },
  { name: 'op', desc: '给玩家管理员权限', playerArg: true },
  { name: 'deop', desc: '取消玩家管理员权限', playerArg: true },
  { name: 'kick', desc: '把玩家踢出服务器', playerArg: true },
  { name: 'ban', desc: '封禁玩家', playerArg: true },
  { name: 'ban-ip', desc: '按 IP 封禁', playerArg: true },
  { name: 'pardon', desc: '解除封禁', playerArg: true },
  { name: 'pardon-ip', desc: '按 IP 解除封禁' },
  { name: 'banlist', desc: '查看封禁列表', values: ['players', 'ips'] },
  { name: 'time', desc: '设置或查询时间', values: ['set', 'add', 'query'] },
  { name: 'weather', desc: '设置天气', values: ['clear', 'rain', 'thunder'] },
  { name: 'difficulty', desc: '设置难度', values: ['peaceful', 'easy', 'normal', 'hard'] },
  { name: 'gamemode', desc: '设置游戏模式', values: ['survival', 'creative', 'adventure', 'spectator'], playerArg: true },
  { name: 'defaultgamemode', desc: '设置新玩家的默认模式', values: ['survival', 'creative', 'adventure', 'spectator'] },
  { name: 'gamerule', desc: '查看或修改游戏规则' },
  { name: 'give', desc: '给玩家物品', usage: 'give <玩家> <物品> [数量]' },
  { name: 'tp', desc: '传送玩家', usage: 'tp <玩家> <x y z | 目标玩家>' },
  { name: 'teleport', desc: '传送玩家', usage: 'teleport <玩家> <目标>' },
  { name: 'effect', desc: '给玩家添加/移除状态效果', values: ['give', 'clear'] },
  { name: 'enchant', desc: '给手持物品附魔' },
  { name: 'experience', desc: '增减玩家经验', values: ['add', 'set', 'query'], playerArg: true },
  { name: 'xp', desc: '增减玩家经验（同 experience）', playerArg: true },
  { name: 'clear', desc: '清空玩家背包', playerArg: true },
  { name: 'kill', desc: '杀死实体（@e 可杀全部）' },
  { name: 'spawnpoint', desc: '设置玩家出生点', playerArg: true },
  { name: 'setworldspawn', desc: '设置世界出生点' },
  { name: 'seed', desc: '查看世界种子' },
  { name: 'banlist', desc: '查看封禁列表' },
  { name: 'say', desc: '向全服广播一句话' },
  { name: 'me', desc: '广播一条动作消息' },
  { name: 'tell', desc: '给某个玩家发私聊', playerArg: true },
  { name: 'msg', desc: '给某个玩家发私聊', playerArg: true },
  { name: 'tellraw', desc: '发送 JSON 富文本消息' },
  { name: 'title', desc: '发送标题/副标题/动作栏', values: ['@a', 'title', 'subtitle', 'actionbar', 'times'] },
  { name: 'particle', desc: '生成粒子效果' },
  { name: 'playsound', desc: '播放音效' },
  { name: 'stopsound', desc: '停止音效', playerArg: true },
  { name: 'setblock', desc: '在指定坐标放置方块' },
  { name: 'fill', desc: '用方块填充一个区域' },
  { name: 'clone', desc: '复制一块区域' },
  { name: 'summon', desc: '生成一个实体' },
  { name: 'data', desc: '读写方块/实体数据', values: ['get', 'merge', 'modify'] },
  { name: 'execute', desc: '以特定条件执行命令' },
  { name: 'function', desc: '运行数据包里的函数' },
  { name: 'schedule', desc: '定时执行函数', values: ['function', 'clear'] },
  { name: 'scoreboard', desc: '计分板操作', values: ['objectives', 'players'] },
  { name: 'team', desc: '队伍管理', values: ['list', 'add', 'remove', 'join', 'leave'] },
  { name: 'tag', desc: '玩家/实体标签', values: ['add', 'remove', 'list'] },
  { name: 'advancement', desc: '授予或撤销进度', values: ['grant', 'revoke'], playerArg: true },
  { name: 'recipe', desc: '解锁或锁定配方', values: ['give', 'take'], playerArg: true },
  { name: 'worldborder', desc: '世界边界', values: ['center', 'set', 'add', 'damage', 'get'] },
  { name: 'spreadplayers', desc: '把玩家随机分散到某区域' },
  { name: 'locate', desc: '定位最近的结构/生物群系', values: ['structure', 'biome', 'poi'] },
  { name: 'forceload', desc: '强制加载区块', values: ['add', 'remove', 'query'] },
  { name: 'tps', desc: '查看服务器 TPS（Paper 系）' },
  { name: 'plugins', desc: '列出插件（Paper 系）' },
  { name: 'pardon', desc: '解除封禁', playerArg: true },
  { name: 'help', desc: '查看帮助' },
  { name: 'version', desc: '查看服务器版本' },
];

/** 常用游戏规则：名字 + 中文说明 */
const GAMERULES: { name: string; desc: string }[] = [
  { name: 'keepInventory', desc: '死亡后保留物品' },
  { name: 'doMobSpawning', desc: '是否刷怪' },
  { name: 'mobGriefing', desc: '生物是否破坏方块' },
  { name: 'doDaylightCycle', desc: '昼夜是否流动' },
  { name: 'doWeatherCycle', desc: '天气是否变化' },
  { name: 'doFireTick', desc: '火焰是否蔓延' },
  { name: 'randomTickSpeed', desc: '随机刻速度（默认 3）' },
  { name: 'spawnMonsters', desc: '是否生成怪物' },
  { name: 'pvp', desc: '玩家之间能否互相伤害' },
  { name: 'commandBlockOutput', desc: '命令方块是否播报' },
  { name: 'sendCommandFeedback', desc: '命令回显' },
  { name: 'naturalRegeneration', desc: '自然回血' },
  { name: 'fallDamage', desc: '摔落伤害' },
  { name: 'showDeathMessages', desc: '死亡消息' },
  { name: 'announceAdvancements', desc: '成就播报' },
  { name: 'playersSleepingPercentage', desc: '睡觉跳过夜晚所需玩家比例' },
];

const BOOLEANS: Suggestion[] = [
  { value: 'true', label: 'true', desc: '开启', kind: 'value' },
  { value: 'false', label: 'false', desc: '关闭', kind: 'value' },
];

/**
 * 根据当前输入算出候选。
 * @param input   输入框里的完整内容
 * @param players 在线玩家名（用于玩家名补全）
 */
export function suggest(input: string, players: string[] = [], serverCommands: string[] = []): Suggestion[] {
  const raw = input.replace(/^\//, '');
  // 末尾是空格 → 正在补下一个参数
  const trailingSpace = /\s$/.test(raw);
  const parts = raw.trim().length ? raw.trim().split(/\s+/) : [];
  const isFirstWord = parts.length === 0 || (parts.length === 1 && !trailingSpace);

  if (isFirstWord) {
    const prefix = (parts[0] ?? '').toLowerCase();
    const out: Suggestion[] = [];
    const serverRoots = new Set(serverCommands.map((name) => name.toLowerCase().replace(/^\//, '')));
    const knownRoots = new Set<string>();
    for (const c of MC_COMMANDS) {
      const names = [c.name, ...(c.aliases ?? [])];
      if (!names.some((n) => n.startsWith(prefix))) continue;
      if (serverRoots.size && !names.some((n) => serverRoots.has(n))) continue;
      knownRoots.add(c.name);
      out.push({ value: `${c.name} `, label: c.name, desc: c.desc, kind: 'command' });
    }
    if (serverRoots.size) {
      for (const name of serverRoots) {
        if (!name.startsWith(prefix) || knownRoots.has(name)) continue;
        out.push({ value: `${name} `, label: name, desc: '此世界当前注册的服务端命令', kind: 'command' });
      }
    }
    return out.slice(0, 30);
  }

  const head = parts[0].toLowerCase();
  const def = MC_COMMANDS.find((c) => c.name === head || (c.aliases ?? []).includes(head));
  const argIndex = trailingSpace ? parts.length : parts.length - 1;
  const current = trailingSpace ? '' : parts[parts.length - 1];
  const lower = current.toLowerCase();

  // 玩家名补全：命令本身要玩家名，或参数位置看起来像玩家名
  const sub = parts[1]?.toLowerCase();
  const playerArg =
    (['op', 'deop', 'kick', 'ban', 'pardon', 'ban-ip', 'clear', 'tell', 'msg', 'w', 'spawnpoint', 'stopsound'].includes(head) && argIndex === 1)
    || (['gamemode', 'defaultgamemode'].includes(head) && head === 'gamemode' && argIndex === 2)
    || (['xp', 'experience'].includes(head) && ['add', 'set', 'query'].includes(sub ?? '') && argIndex === 2)
    || (head === 'whitelist' && argIndex === 2 && ['add', 'remove'].includes(sub ?? ''))
    || (['advancement', 'recipe'].includes(head) && argIndex === 2)
    || (['tp', 'teleport'].includes(head) && argIndex === 2)
    || (head === 'give' && argIndex === 1)
    || (head === 'effect' && ((sub === 'give' && argIndex === 2) || (sub === 'clear' && argIndex === 2)))
    || (head === 'title' && argIndex === 1)
    || (head === 'kill' && argIndex === 1);
  if (playerArg) {
    const selectors = ['@a', '@p', '@r', '@s'];
    const selectorHits = selectors.filter((name) => name.startsWith(lower)).map<Suggestion>((name) => ({
      value: name,
      label: name,
      desc: '目标选择器',
      kind: 'value',
    }));
    const playerHits = players
      .filter((p) => p.toLowerCase().startsWith(lower))
      .map<Suggestion>((p) => ({ value: p, label: p, desc: '在线玩家', kind: 'player' }));
    const hits = [...playerHits, ...selectorHits];
    if (hits.length) return hits.slice(0, 14);
  }

  if (head === 'gamerule' && argIndex === 1) {
    return GAMERULES.filter((g) => g.name.toLowerCase().startsWith(lower)).map<Suggestion>((g) => ({
      value: `${g.name} `,
      label: g.name,
      desc: g.desc,
      kind: 'rule',
    }));
  }
  if (head === 'gamerule' && argIndex === 2) return BOOLEANS;

  // 固定取值（时间 / 天气 / 难度 / 游戏模式 …）
  if (def?.values?.length && argIndex <= (def.playerArg ? 1 : 1)) {
    const hit = def.values.filter((v) => v.toLowerCase().startsWith(lower));
    if (hit.length) return hit.map<Suggestion>((v) => ({ value: `${v} `, label: v, desc: '', kind: 'value' }));
  }

  if (head === 'time' && argIndex === 2) {
    return ['day', 'noon', 'night', 'midnight', 'sunrise', 'sunset']
      .filter((v) => v.startsWith(lower))
      .map<Suggestion>((v) => ({ value: `${v} `, label: v, desc: '', kind: 'value' }));
  }
  if (head === 'weather' && argIndex === 1) {
    return ['clear', 'rain', 'thunder']
      .filter((v) => v.startsWith(lower))
      .map<Suggestion>((v) => ({ value: `${v} `, label: v, desc: '', kind: 'value' }));
  }
  if ((head === 'difficulty' || head === 'defaultgamemode' || head === 'gamemode') && argIndex === 1) {
    const pool = head === 'difficulty' ? ['peaceful', 'easy', 'normal', 'hard'] : ['survival', 'creative', 'adventure', 'spectator'];
    return pool.filter((v) => v.startsWith(lower)).map<Suggestion>((v) => ({ value: `${v} `, label: v, desc: '', kind: 'value' }));
  }
  if (head === 'whitelist' && argIndex === 1) {
    return ['add', 'remove', 'list', 'on', 'off', 'reload']
      .filter((v) => v.startsWith(lower))
      .map<Suggestion>((v) => ({ value: `${v} `, label: v, desc: '', kind: 'value' }));
  }

  const fixedArgs: Record<string, string[]> = {
    effect: ['give', 'clear'],
    data: ['get', 'merge', 'modify', 'remove'],
    execute: ['align', 'anchored', 'as', 'at', 'facing', 'in', 'on', 'positioned', 'rotated', 'store', 'summon', 'if', 'unless', 'run'],
    scoreboard: ['objectives', 'players'],
    'scoreboard objectives': ['add', 'list', 'modify', 'remove', 'setdisplay'],
    'scoreboard players': ['add', 'enable', 'get', 'list', 'operation', 'reset', 'set'],
    team: ['add', 'empty', 'join', 'leave', 'list', 'modify', 'remove'],
    tag: ['add', 'list', 'remove'],
    locate: ['biome', 'poi', 'structure'],
    forceload: ['add', 'query', 'remove'],
    time: ['add', 'query', 'set'],
    worldborder: ['add', 'center', 'damage', 'get', 'set', 'warning'],
  };
  const context = head === 'scoreboard' && (sub === 'objectives' || sub === 'players') ? `${head} ${sub}` : head;
  if (fixedArgs[context] && argIndex === (context === head ? 1 : 2)) {
    return fixedArgs[context]
      .map((v) => v.trim())
      .filter((v) => v.toLowerCase().startsWith(lower))
      .map<Suggestion>((v) => ({ value: `${v} `, label: v, desc: '', kind: 'value' }));
  }

  // 兜底：命令名本身也允许补全（比如已经输了一半的命令名但前面判断没命中）
  return [];
}

/** 把候选应用回输入框 */
export function applySuggestion(input: string, s: Suggestion): string {
  const raw = input.replace(/^\//, '');
  const trailingSpace = /\s$/.test(raw);
  const parts = raw.trim().length ? raw.trim().split(/\s+/) : [];
  if (!parts.length) return s.value;
  if (s.kind === 'command') return s.value;
  if (trailingSpace) return `${raw}${s.value}`;
  parts[parts.length - 1] = s.value;
  return parts.join(' ');
}
