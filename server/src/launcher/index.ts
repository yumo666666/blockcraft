import fs from 'node:fs';
import path from 'node:path';
import type { InstanceConfig, Loader } from '../types.ts';

/**
 * 五种加载器的启动方式适配。全部来自 v1 在真机上跑通并记录的行为，
 * 新增加载器只需要在这里加一个分支。
 */

export interface LaunchPlan {
  /** 传给 java 的「服务端部分」参数（不含 JVM 内存参数） */
  serverArgs: string[];
  /** 平铺的 JVM 额外参数（Java 8 不能使用 @argfile，只能内联） */
  jvmArgs: string[];
  /** 是否使用 @user_jvm_args.txt（Java 9+ 才支持） */
  useArgFile: boolean;
  /** 关键产物路径，用于启动前校验 */
  required: string[];
  /** 用于页面上展示的启动方式说明 */
  how: string;
}

/** 工整的版本比较：26.3 这种年份版本与 1.20.1 不能按字符串比 */
export function versionTuple(v: string): number[] {
  return v
    .split(/[.\-+]/)
    .map((x) => parseInt(x, 10))
    .map((x) => (Number.isFinite(x) ? x : 0));
}

export function compareVersion(a: string, b: string): number {
  const ta = versionTuple(a);
  const tb = versionTuple(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const d = (ta[i] ?? 0) - (tb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function findForgeLegacyJar(serverDir: string, mc: string, loaderVersion: string): string | null {
  const exact = `forge-${mc}-${loaderVersion}.jar`;
  if (fs.existsSync(path.join(serverDir, exact))) return exact;
  try {
    const list = fs.readdirSync(serverDir).filter((f) => /^forge-.*\.jar$/.test(f) && !/installer/.test(f));
    if (list.length) return list.sort().reverse()[0];
  } catch {
    /* ignore */
  }
  return null;
}

export function planLaunch(cfg: InstanceConfig, serverDir: string, javaMajor: number): LaunchPlan {
  const jvmArgs: string[] = [`-Xms${cfg.minMemoryMb}M`, `-Xmx${cfg.memoryMb}M`];
  for (const line of (cfg.jvmExtra || '').split('\n')) {
    const t = line.trim();
    if (t) jvmArgs.push(t);
  }
  const useArgFile = javaMajor >= 9;
  const mk = (serverArgs: string[], required: string[], how: string): LaunchPlan => ({
    serverArgs: [...serverArgs, 'nogui'],
    jvmArgs,
    useArgFile,
    required,
    how,
  });

  switch (cfg.loader) {
    case 'vanilla':
      return mk(['-jar', 'minecraft_server.jar'], ['minecraft_server.jar'], '原版服务端 jar');
    case 'paper':
      return mk(['-jar', 'paper.jar'], ['paper.jar'], 'Paper 胖 jar');
    case 'fabric':
      return mk(['-jar', 'fabric-server-launch.jar'], ['fabric-server-launch.jar'], 'Fabric 自举启动器');
    case 'neoforge': {
      const unixArgs = path.join('libraries', 'net', 'neoforged', 'neoforge', cfg.loaderVersion, 'unix_args.txt');
      return mk([`@${unixArgs}`], [unixArgs], 'NeoForge unix_args 参数文件');
    }
    case 'forge': {
      const unixArgs = path.join('libraries', 'net', 'minecraftforge', 'forge', `${cfg.mc}-${cfg.loaderVersion}`, 'unix_args.txt');
      if (fs.existsSync(path.join(serverDir, unixArgs))) {
        return mk([`@${unixArgs}`], [unixArgs], 'Forge unix_args 参数文件（1.17+）');
      }
      const legacy = findForgeLegacyJar(serverDir, cfg.mc, cfg.loaderVersion);
      if (legacy) {
        return mk(['-jar', legacy], [legacy], 'Forge 单体 jar（1.16.5 及更早）');
      }
      return mk([`@${unixArgs}`], [unixArgs], 'Forge unix_args 参数文件（缺失，需要先安装）');
    }
    default:
      return mk(['-jar', 'minecraft_server.jar'], ['minecraft_server.jar'], '未知加载器，按原版处理');
  }
}

/** 启动前校验关键产物，缺什么就明确说出来，不要让它静默失败 */
export function validateInstall(cfg: InstanceConfig, serverDir: string): { ok: boolean; missing: string[]; plan: LaunchPlan } {
  const javaMajor = cfg.javaMajor ?? 17;
  const plan = planLaunch(cfg, serverDir, javaMajor);
  const missing = plan.required.filter((rel) => !fs.existsSync(path.join(serverDir, rel)));
  if (cfg.loader === 'forge' && missing.length) {
    // Forge 1.16.5 及更早可能只有单体 jar，换个说法
    plan.how = 'Forge（未找到安装产物，请先安装 / 或重新安装）';
  }
  return { ok: missing.length === 0, missing, plan };
}

/** 生成启动脚本。stdin 必须接一个永不 EOF 的管道，否则控制台线程空转刷 "> " 烧 CPU */
export function writeLaunchScript(opts: {
  instanceDir: string;
  serverDir: string;
  javaPath: string;
  plan: LaunchPlan;
  useArgFile: boolean;
}): string {
  const { instanceDir, serverDir, javaPath, plan, useArgFile } = opts;
  const jvm = useArgFile ? ['@user_jvm_args.txt', ...plan.serverArgs] : [...plan.jvmArgs, ...plan.serverArgs];
  const lines = [
    '#!/bin/bash',
    '# 本文件由 BlockCraft 面板生成，请勿手改（改世界配置后会自动重新生成）',
    'set -u',
    `cd ${JSON.stringify(serverDir)} || exit 1`,
    `export JAVA_HOME=${JSON.stringify(path.dirname(path.dirname(javaPath)))}`,
    'export PATH="$JAVA_HOME/bin:$PATH"',
    'export LC_ALL=C',
    'export LANG=C',
    `rm -f ${JSON.stringify(path.join(instanceDir, '.stop-intent'))}`,
    `echo $$ > ${JSON.stringify(path.join(instanceDir, 'server.pid'))}`,
    `exec ${JSON.stringify(javaPath)} ${jvm.join(' ')} < <(sleep infinity)`,
    '',
  ];
  return lines.join('\n');
}

export function writeJvmArgsFile(serverDir: string, plan: LaunchPlan): void {
  const content = plan.jvmArgs.join('\n') + '\n';
  fs.writeFileSync(path.join(serverDir, 'user_jvm_args.txt'), content);
}

/** 从日志里识别「真的起来了」——端口通不等于能联机（Forge 先绑端口后加载世界） */
export function detectPhase(logText: string): { status: 'starting' | 'running' | 'stopping'; progress: string | null; doneLine: string | null } {
  const tail = logText.slice(-64 * 1024);
  const doneMatch = [...tail.matchAll(/Done \(([\d.,]+)s\)! For help, type "help"/g)].pop();
  const stopping = /Stopping server|Stopping the server/.test(tail.slice(-4000));
  const progress = tail.match(/Preparing spawn area:\s*(\d+)%/g)?.pop() ?? null;
  if (doneMatch && !stopping) return { status: 'running', progress: null, doneLine: doneMatch[0] };
  if (stopping) return { status: 'stopping', progress: null, doneLine: null };
  return { status: 'starting', progress, doneLine: null };
}

/** 常见的启动失败特征（用于自愈与提示） */
export function detectFailure(logText: string): string | null {
  const tail = logText.slice(-64 * 1024);
  const rules: [RegExp, string][] = [
    [/java\.lang\.UnsupportedClassVersionError/i, 'Java 版本过低，请提高该世界的 Java 版本'],
    [/Could not find or load main class/i, '找不到主类，服务端安装可能不完整（Java 8 不支持 @argfile）'],
    [/Missing or unsupported mandatory dependencies/i, '缺少模组依赖，启动被 Forge 拒绝'],
    [/has failed to load correctly/i, '有模组加载失败，请看日志详情'],
    [/Address already in use/i, '端口被占用，请重新分配端口'],
    [/OutOfMemoryError/i, '内存不足，请提高该世界的 Xmx'],
    [/You need to agree to the EULA/i, '需要先同意 EULA'],
    [/Fatal error in the mod loading/i, '模组加载致命错误'],
  ];
  for (const [re, msg] of rules) if (re.test(tail)) return msg;
  return null;
}

/** 给日志去 ANSI 颜色 */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export interface LoaderOption {
  loader: Loader;
  label: string;
  /** 是否支持该 MC 版本（面板会给出提示，不强行阻止） */
  note: string;
}

export const LOADER_LABELS: Record<Loader, string> = {
  vanilla: '原版 Vanilla',
  paper: 'Paper（插件服）',
  forge: 'Forge',
  neoforge: 'NeoForge',
  fabric: 'Fabric',
};
