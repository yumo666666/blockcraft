import type { Express } from 'express';
import { bad } from '../core/errors.ts';
import * as I from '../services/instanceService.ts';
import * as sup from '../services/supervisor.ts';
import { describe, nextRun, tickNow } from '../services/scheduler.ts';

/**
 * 快捷命令：中文标签 + 分组。带 needsArg 的点了不直接发，而是把前缀填进输入框、光标落到参数位，
 * 避免手快把 `ban ` 当命令发出去。danger 的按钮用危险色。
 */
interface Shortcut {
  label: string;
  cmd: string;
  group: string;
  needsArg?: boolean;
  danger?: boolean;
  hint?: string;
}

const SHORTCUTS_DEFAULT: Shortcut[] = [
  { group: '常用', label: '查看在线玩家', cmd: 'list', hint: '列出当前在线的玩家' },
  { group: '常用', label: '立即保存', cmd: 'save-all', hint: '把世界写盘（不等待完成）' },
  { group: '常用', label: '保存并等待', cmd: 'save-all flush', hint: '写盘并等它真正结束，回档前建议先执行' },
  { group: '常用', label: '重载数据包', cmd: 'reload', hint: '重新加载数据包与函数，不改动玩家' },

  { group: '时间天气', label: '设为白天', cmd: 'time set day' },
  { group: '时间天气', label: '设为正午', cmd: 'time set noon' },
  { group: '时间天气', label: '设为夜晚', cmd: 'time set night' },
  { group: '时间天气', label: '天气转晴', cmd: 'weather clear' },
  { group: '时间天气', label: '开始下雨', cmd: 'weather rain' },
  { group: '时间天气', label: '雷暴', cmd: 'weather thunder' },

  { group: '玩家管理', label: '给管理员', cmd: 'op ', needsArg: true, hint: '需要填玩家名' },
  { group: '玩家管理', label: '取消管理员', cmd: 'deop ', needsArg: true },
  { group: '玩家管理', label: '踢出世界', cmd: 'kick ', needsArg: true },
  { group: '玩家管理', label: '加白名单', cmd: 'whitelist add ', needsArg: true },
  { group: '玩家管理', label: '移出白名单', cmd: 'whitelist remove ', needsArg: true },
  { group: '玩家管理', label: '白名单列表', cmd: 'whitelist list' },
  { group: '玩家管理', label: '打开白名单', cmd: 'whitelist on' },
  { group: '玩家管理', label: '关闭白名单', cmd: 'whitelist off' },
  { group: '玩家管理', label: '禁言/封禁', cmd: 'ban ', needsArg: true, danger: true },
  { group: '玩家管理', label: '解除封禁', cmd: 'pardon ', needsArg: true },

  { group: '游戏规则', label: '死亡不掉落：开', cmd: 'gamerule keepInventory true' },
  { group: '游戏规则', label: '死亡不掉落：关', cmd: 'gamerule keepInventory false' },
  { group: '游戏规则', label: '刷怪：开', cmd: 'gamerule doMobSpawning true' },
  { group: '游戏规则', label: '刷怪：关', cmd: 'gamerule doMobSpawning false' },
  { group: '游戏规则', label: '生物破坏：关', cmd: 'gamerule mobGriefing false' },
  { group: '游戏规则', label: '生物破坏：开', cmd: 'gamerule mobGriefing true' },
  { group: '游戏规则', label: '时间流动：停', cmd: 'gamerule doDaylightCycle false' },
  { group: '游戏规则', label: '时间流动：恢复', cmd: 'gamerule doDaylightCycle true' },
  { group: '游戏规则', label: '天气变化：停', cmd: 'gamerule doWeatherCycle false' },
  { group: '游戏规则', label: '天气变化：恢复', cmd: 'gamerule doWeatherCycle true' },

  { group: '存档安全', label: '关闭自动保存', cmd: 'save-off', hint: '手动备份前先关掉，避免备份到写一半的区块' },
  { group: '存档安全', label: '开启自动保存', cmd: 'save-on', hint: '备份完成后记得开回来' },
  { group: '存档安全', label: '清空掉落物', cmd: 'kill @e[type=item]', danger: true, hint: '删掉地上所有掉落物，找回 TPS' },
];

const COMMAND_ROOT_TTL_MS = 30_000;
const commandRootCache = new Map<string, { at: number; commands: string[] }>();

function parseCommandRoots(output: string): string[] {
  const plain = output.replace(/§[0-9a-fk-or]/gi, '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const names = new Set<string>();
  for (const match of plain.matchAll(/(?:^|\s)\/([a-zA-Z0-9_:.+-]+)(?=[\s,;]|$)/gm)) {
    names.add(match[1].toLowerCase());
  }
  return [...names];
}

async function readCommandRoots(id: string): Promise<string[]> {
  const found = new Set<string>();
  // Vanilla and Bukkit help output paginate command roots. Walk until a page
  // adds nothing so plugin commands beyond page one are included as well.
  for (let page = 1; page <= 20; page++) {
    const output = await sup.rcon(id, page === 1 ? 'help' : `help ${page}`);
    const roots = parseCommandRoots(output);
    let added = 0;
    for (const root of roots) {
      if (found.has(root)) continue;
      found.add(root);
      added++;
    }
    if (page > 1 && added === 0) break;
  }
  return [...found];
}

export function registerConsoleRoutes(app: Express): void {
  app.get('/api/instances/:id/console', (req, res) => {
    const id = req.params.id;
    const since = Number(req.query.since ?? 0);
    const buf = sup.console_(id);
    const lines = since > 0 ? buf.since(since) : buf.tail(Number(req.query.lines ?? 300));
    res.json({ lines, seq: buf.seq });
  });

  app.get('/api/instances/:id/console/stream', (req, res) => {
    const id = req.params.id;
    if (!I.exists(id)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `世界不存在：${id}` } });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const since = Number(req.query.since ?? 0);
    const buf = sup.console_(id);
    let lastSeq = since;
    if (since > 0) {
      for (const l of buf.since(since)) {
        res.write(`data: ${JSON.stringify(l)}\n\n`);
        lastSeq = l.seq;
      }
    } else {
      for (const l of buf.tail(200)) res.write(`data: ${JSON.stringify(l)}\n\n`);
      lastSeq = buf.seq;
    }
    const onLine = (l: { seq: number }) => {
      res.write(`data: ${JSON.stringify(l)}\n\n`);
      lastSeq = l.seq;
    };
    buf.on('line', onLine);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      buf.off('line', onLine);
      clearInterval(ping);
    });
    void lastSeq;
  });

  app.post('/api/instances/:id/command', async (req, res) => {
    const id = req.params.id;
    const cmd = String((req.body as { cmd?: string })?.cmd ?? '').trim();
    if (!cmd) throw bad('命令不能为空');
    if (!sup.isRunning(id)) throw bad('这个世界没有在运行，无法执行命令');
    if (cmd.length > 1000) throw bad('命令太长');
    const buf = sup.console_(id);
    buf.push(`[面板] > ${cmd}`);
    const out = await sup.rcon(id, cmd).catch((err) => {
      buf.push(`[面板] 命令执行失败：${String(err)}`);
      return '';
    });
    if (out) buf.push(out);
    res.json({ ok: true, output: out });
  });

  app.get('/api/instances/:id/shortcuts', (req, res) => {
    res.json({ shortcuts: SHORTCUTS_DEFAULT });
  });

  // RCON does not implement Minecraft's Brigadier suggestion protocol. `/help`
  // is the server-side, version/loader-aware list of executable command roots;
  // the browser combines it with argument hints for common vanilla commands.
  app.get('/api/instances/:id/command-roots', async (req, res) => {
    const id = req.params.id;
    I.getConfig(id);
    if (!sup.isRunning(id)) {
      res.json({ commands: [] });
      return;
    }
    const cached = commandRootCache.get(id);
    if (cached && Date.now() - cached.at < COMMAND_ROOT_TTL_MS) {
      res.json({ commands: cached.commands });
      return;
    }
    try {
      const commands = await readCommandRoots(id);
      commandRootCache.set(id, { at: Date.now(), commands });
      res.json({ commands });
    } catch {
      res.json({ commands: cached?.commands ?? [] });
    }
  });

  app.get('/api/instances/:id/schedule', (req, res) => {
    const cfg = I.getConfig(req.params.id);
    const state = I.getState(req.params.id);
    res.json({
      schedule: cfg.schedule,
      describe: describe(cfg),
      nextStart: nextRun(cfg.schedule.start),
      nextStop: nextRun(cfg.schedule.stop),
      pendingStop: state.pendingStop,
      fired: state.fired,
    });
  });

  app.put('/api/instances/:id/schedule', (req, res) => {
    const id = req.params.id;
    const body = req.body as Record<string, unknown>;
    const cfg = I.getConfig(id);
    const next = {
      ...cfg.schedule,
      ...(body as unknown as typeof cfg.schedule),
    } as typeof cfg.schedule;
    I.saveConfig(id, { schedule: next });
    const saved = I.getConfig(id);
    res.json({ ok: true, schedule: saved.schedule, describe: describe(saved), nextStart: nextRun(saved.schedule.start), nextStop: nextRun(saved.schedule.stop) });
  });

  app.post('/api/instances/:id/schedule/test-warn', async (req, res) => {
    const id = req.params.id;
    const cfg = I.getConfig(id);
    const n = Number((req.body as { minutes?: number })?.minutes ?? cfg.schedule.warnMinutes);
    const text = (cfg.schedule.warnText || '服务器将在 {n} 分钟后关闭').replace('{n}', String(n));
    const cmd = cfg.schedule.warnCommand ? cfg.schedule.warnCommand.replace('{n}', String(n)).replace('{text}', text) : `say ${text}`;
    if (!sup.isRunning(id)) throw bad('世界没有在运行，无法测试公告');
    await sup.rcon(id, cmd);
    res.json({ ok: true, text });
  });

  app.get('/api/scheduler/upcoming', (_req, res) => {
    const out = I.listInstanceIds().map((id) => {
      const cfg = I.getConfig(id);
      return {
        id,
        name: cfg.name,
        describe: describe(cfg),
        nextStart: nextRun(cfg.schedule.start),
        nextStop: nextRun(cfg.schedule.stop),
        pendingStop: I.getState(id).pendingStop,
      };
    });
    res.json({ instances: out });
  });

  app.post('/api/scheduler/tick', async (_req, res) => {
    await tickNow();
    res.json({ ok: true });
  });
}
