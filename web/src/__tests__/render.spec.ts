/**
 * 页面渲染测试：用**真实面板的数据**挂载每个页面，断言关键内容出现在 DOM 里。
 * 覆盖：总览（资源监控 + FRP + 世界卡片）、控制台、备份、MOD、玩家、新建向导、设置。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * 这组测试需要一个**真实运行中的面板**（要 BC_TOKEN）。
 * CI 里没有面板时会整体跳过，只跑纯逻辑测试（commands.spec.ts）。
 */
const RUN = Boolean(process.env.BC_TOKEN);
const describeIfPanel = RUN ? describe : describe.skip;
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createMemoryHistory, type RouteRecordRaw } from 'vue-router';
import { TEST_BASE } from './setup.ts';

// skinview3d 需要 WebGL，测试环境里替换成空实现（页面本身对加载失败有回落）
vi.mock('skinview3d', () => ({
  SkinViewer: class {
    animation: unknown = null;
    autoRotate = false;
    constructor(_opts: unknown) {}
    dispose(): void {}
  },
  IdleAnimation: class {},
}));

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'overview', component: () => import('../pages/Overview.vue') },
  { path: '/new', name: 'wizard', component: () => import('../pages/Wizard.vue') },
  { path: '/settings', name: 'settings', component: () => import('../pages/Settings.vue') },
  { path: '/w/:id/console', name: 'console', component: () => import('../pages/Console.vue'), props: true },
  { path: '/w/:id/backups', name: 'backups', component: () => import('../pages/Backups.vue'), props: true },
  { path: '/w/:id/mods', name: 'mods', component: () => import('../pages/Mods.vue'), props: true },
  { path: '/w/:id/players', name: 'players', component: () => import('../pages/Players.vue'), props: true },
];

/** 轮询等待条件成立（页面是异步取数的，固定 sleep 不可靠） */
async function waitFor(wrapper: { text: () => string }, predicate: (text: string) => boolean, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await flushPromises();
    const text = wrapper.text();
    if (predicate(text)) return text;
    await new Promise((r) => setTimeout(r, 150));
  }
  return wrapper.text();
}

async function mountAt(path: string, extra: Record<string, unknown> = {}) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(
    { template: '<router-view />' },
    { global: { plugins: [router], stubs: { teleport: true } }, ...extra },
  );
  await flushPromises();
  await new Promise((r) => setTimeout(r, 900));
  await flushPromises();
  return wrapper;
}

let instanceId = '';
let instanceName = '';
let firstModName = '';
let firstBackupFile = '';
let javaMajor = 0;
let localPort = 0;
let frpPort = 0;

const setup = async () => {
  const token = process.env.BC_TOKEN || '';
  const res = await fetch(`/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Blockcraft': '1' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`测试登录失败（需要 BC_TOKEN 环境变量）：HTTP ${res.status}`);
  const list = (await (await fetch(`/api/instances`)).json()) as { instances: { id: string; name: string }[] };
  instanceId = list.instances[0]?.id ?? '';
  instanceName = list.instances[0]?.name ?? '';
  // 记住几个真实值，后面拿它们断言 DOM 里确实渲染出了真实数据
  const detail = (await (await fetch(`/api/instances/${instanceId}`)).json()) as {
    instance: { port: number; frpPort: number | null };
    config: { javaMajor: number };
  };
  localPort = detail.instance.port;
  frpPort = detail.instance.frpPort ?? 0;
  javaMajor = detail.config.javaMajor;
  const mods = (await (await fetch(`/api/instances/${instanceId}/mods?page=1&size=1`)).json()) as { total: number; items: { name: string }[] };
  firstModName = mods.items[0]?.name ?? '';
  if (!firstModName) {
    // 这个测试就是要验证「真实 MOD 渲染出来」，没有 MOD 就没有验证意义 —— 直接报清楚
    throw new Error(`实例 ${instanceId} 没有可用的 MOD 数据（total=${mods.total}），无法验证 MOD 页渲染`);
  }
  const backups = (await (await fetch(`/api/instances/${instanceId}/backups`)).json()) as { backups: { file: string }[] };
  firstBackupFile = backups.backups[0]?.file ?? '';
};

if (RUN) beforeAll(setup, 60000);

describeIfPanel('总览页', () => {
  it('渲染资源监控、FRP 双通道与世界便签卡片', async () => {
    const w = await mountAt('/');
    const text = w.text();
    expect(text).toContain('资源监控');
    expect(text).toContain('FRP 穿透');
    // 两条通道必须分开显示
    expect(text).toContain('面板通道');
    expect(text).toContain('世界通道');
    // 真实世界里存在的名字与按钮
    if (instanceName) expect(text).toContain(instanceName);
    // 真实端口必须出现在卡片上
    if (localPort) expect(text).toContain(String(localPort));
    if (frpPort) expect(text).toContain(String(frpPort));
    for (const label of ['显示端口', '配置', '控制台', '备份与回退', 'MOD 管理', '玩家管理', '复制为新世界', '删除这个世界']) {
      expect(text, `缺少按钮：${label}`).toContain(label);
    }
    // 手机侧数据来自 DSHA 桥
    expect(text).toMatch(/电量|不可用/);
    w.unmount();
  });
});

describeIfPanel('控制台页', () => {
  it('渲染日志区、快捷命令与定时设置', async () => {
    const w = await mountAt(`/w/${instanceId}/console`);
    const text = await waitFor(w, (t) => t.includes(instanceName));
    expect(text).toContain(instanceName);
    expect(text.toLowerCase()).toContain('返回');
    expect(text).toMatch(/日志|控制台/);
    expect(text).toMatch(/定时|开服/);
    expect(text).toMatch(/停服/);
    w.unmount();
  });
});

describeIfPanel('备份页', () => {
  it('渲染备份列表与策略设置', async () => {
    const w = await mountAt(`/w/${instanceId}/backups`);
    const text = await waitFor(w, (t) => /备份/.test(t) && !t.includes('读取中'));
    expect(text).toMatch(/备份/);
    expect(text).toMatch(/立即备份|备份现在/);
    expect(text).toMatch(/自动备份|保留/);
    // 真实备份文件名必须渲染出来（这个实例恰好有备份）
    if (firstBackupFile) expect(text).toContain(firstBackupFile);
    w.unmount();
  });
});

describeIfPanel('MOD 页', () => {
  it('渲染 MOD 卡片（含名称与来源徽标）', async () => {
    const w = await mountAt(`/w/${instanceId}/mods`);
    // 注意：等待条件必须用「真实 MOD 名」，不能用来源字样 ——
    // 筛选下拉里本来就写着 Modrinth/CurseForge，用它当条件会在数据到达前就判定完成（踩过）。
    const text = await waitFor(w, (t) => t.includes(firstModName));
    expect(text).toMatch(/MOD 管理|MOD/);
    // 真实数据里应该有来源徽标
    expect(text).toMatch(/Modrinth|CurseForge|本地|未知/);
    // 真实 MOD 名称必须渲染出来（这条实例有 361 个 MOD）
    if (firstModName) expect(text).toContain(firstModName);
    w.unmount();
  });
});

describeIfPanel('玩家页', () => {
  it('渲染玩家区与离线说明', async () => {
    const w = await mountAt(`/w/${instanceId}/players`);
    const text = await waitFor(w, (t) => /在线|离线/.test(t));
    expect(text).toMatch(/玩家/);
    expect(text).toMatch(/在线|离线/);
    w.unmount();
  });
});

describeIfPanel('新建向导', () => {
  it('渲染三种起始方式与版本/加载器选择', async () => {
    const w = await mountAt('/new');
    const text = w.text();
    expect(text).toContain('新建世界');
    expect(text).toContain('导入整合包');
    expect(text).toContain('从现有世界复制');
    w.unmount();
  });
});

describeIfPanel('设置页', () => {
  it('渲染限额、Java、FRP、端口段与存储', async () => {
    const w = await mountAt('/settings');
    const text = await waitFor(w, (t) => !t.includes('读取中…'));
    for (const label of ['资源限额', 'Java', 'FRP', '端口段', '存储']) {
      expect(text, `缺少分区：${label}`).toContain(label);
    }
    expect(text).toContain(`Java ${javaMajor}`);
    w.unmount();
  });
});

describeIfPanel('控制台命令提示', () => {
  it('输入一半会弹出候选，且候选带中文说明', async () => {
    const w = await mountAt(`/w/${instanceId}/console`);
    await waitFor(w, (t) => t.includes(instanceName));
    // 页面上还有一个「日志过滤」输入框，必须按稳定钩子选命令框，不然测的是过滤框
    const input = w.find('[data-test="cmd"]');
    expect(input.exists()).toBe(true);

    await input.setValue('whitel');
    await flushPromises();
    const items = w.findAll('.suggest-item');
    expect(items.length, '输入 whitel 应该弹出候选').toBeGreaterThan(0);
    expect(w.find('.suggest-name').text()).toContain('whitelist');
    expect(w.text()).toContain('白名单'); // 中文说明

    // 参数位提示在线玩家（没有在线玩家时不该崩，且不该出现空下拉）
    await input.setValue('gamerule keep');
    await flushPromises();
    expect(w.text()).toContain('keepInventory');
    expect(w.text()).toContain('死亡');

    // 布局要求：命令输入必须在「控制台」卡片里（也就是日志下方），而不是在右侧快捷命令卡片里
    const consoleCard = w.find('.console-card');
    expect(consoleCard.exists()).toBe(true);
    expect(consoleCard.find('[data-test="cmd"]').exists(), '命令输入应该在控制台卡片内').toBe(true);
    const sideCard = w.find('.console-side .card');
    expect(sideCard.find('[data-test="cmd"]').exists(), '快捷命令卡片里不该再有命令输入').toBe(false);
    w.unmount();
  });

  it('快捷命令按中文分组展示', async () => {
    const w = await mountAt(`/w/${instanceId}/console`);
    await waitFor(w, (t) => t.includes(instanceName));
    const text = w.text();
    for (const label of ['查看在线玩家', '设为白天', '给管理员', '死亡不掉落：开', '关闭自动保存']) {
      expect(text, `缺少快捷命令：${label}`).toContain(label);
    }
    // 带参数的按钮不应直接把半截命令发出去，而是填进输入框
    const argChip = w.findAll('button.chip').find((b) => b.text().includes('给管理员'));
    expect(argChip).toBeTruthy();
    await argChip!.trigger('click');
    await flushPromises();
    expect((w.find('[data-test="cmd"]').element as HTMLInputElement).value).toBe('op ');
    w.unmount();
  });
});

describe('世界配置弹窗', () => {
  it('「随面板自动启动」在弹窗顶部一眼可见（不能藏在滚动区里）', async () => {
    const w = await mountAt('/');
    await waitFor(w, (t) => t.includes('显示端口'));
    // 点世界卡片上的「配置」
    const cfgBtn = w.findAll('button').find((b) => b.text().trim() === '配置');
    expect(cfgBtn, '世界卡片上应该有配置按钮').toBeTruthy();
    await cfgBtn!.trigger('click');
    await waitFor(w, (t) => t.includes('常用开关') || t.includes('随面板自动启动'));

    const quick = w.find('.quick-switches');
    expect(quick.exists(), '配置弹窗顶部应该有常用开关区').toBe(true);
    const quickText = quick.text();
    expect(quickText).toContain('随面板自动启动');
    expect(quickText).toContain('正版验证');
    expect(quickText).toContain('白名单');

    // 顺序要求：常用开关必须排在「基本」分组之前（也就是第一屏就能看到）
    const body = w.find('.modal-body').text();
    expect(body.indexOf('随面板自动启动')).toBeLessThan(body.indexOf('基本'));
    expect(body.indexOf('随面板自动启动')).toBeLessThan(body.indexOf('MOTD'));
    w.unmount();
  });

  it('世界卡片：autostart 为真时显示「自启」徽标，为假时不显示', async () => {
    // 纯组件测试：不去改真实面板的状态（改后端数据会让测试之间互相干扰，实测会时好时坏）
    const { default: WorldNote } = await import('../components/WorldNote.vue');
    const base = {
      id: 'unit-test',
      name: '单元测试世界',
      note: '',
      color: '#e9e2d0',
      mc: '1.20.1',
      loader: 'fabric',
      loaderVersion: '0.19.5',
      port: 25565,
      frpPort: 26000,
      frpEnabled: true,
      memoryMb: 2048,
      minMemoryMb: 1024,
      autostart: true,
      status: 'stopped',
      phase: '',
      progress: null,
      pid: null,
      uptime: 0,
      cpu: 0,
      rss: 0,
      players: 0,
      maxPlayers: 20,
      modCount: 0,
      diskUsage: 0,
      lastBackup: null,
      intentionalStop: false,
      createdAt: 0,
      javaMajor: 17,
      lastError: null,
    };
    const on = mount(WorldNote, { props: { item: { ...base, autostart: true } } });
    expect(on.find('.badge-accent').exists(), '开启自启时应有强调色徽标').toBe(true);
    expect(on.text()).toContain('自启');
    on.unmount();

    const off = mount(WorldNote, { props: { item: { ...base, autostart: false } } });
    expect(off.find('.badge-accent').exists(), '未开启时不该有自启徽标').toBe(false);
    off.unmount();
  });
});

describeIfPanel('世界卡片的崩溃提示', () => {
  it('有 lastError 时显示「上次崩溃」与原因，没有时不显示', async () => {
    const { default: WorldNote } = await import('../components/WorldNote.vue');
    const base = {
      id: 'unit-crash', name: '测试世界', note: '', color: '#e9e2d0', mc: '1.20.1',
      loader: 'forge', loaderVersion: '47.4.20', port: 25565, frpPort: 26000, frpEnabled: true,
      memoryMb: 4096, minMemoryMb: 1024, autostart: false, status: 'crashed', phase: '崩溃',
      progress: null, pid: null, uptime: 0, cpu: 0, rss: 0, players: 0, maxPlayers: 20,
      modCount: 244, diskUsage: 0, lastBackup: null, intentionalStop: false, createdAt: 0,
      javaMajor: 17,
      lastError: '单个 tick 卡了 60.00 秒，被服务端自带看门狗判定为卡死并强制关闭',
    };
    const w = mount(WorldNote, { props: { item: base } });
    expect(w.find('.note-crash').exists(), '有崩溃原因时应该显示提示').toBe(true);
    expect(w.text()).toContain('上次崩溃');
    expect(w.text()).toContain('看门狗判定为卡死');
    w.unmount();

    const clean = mount(WorldNote, { props: { item: { ...base, lastError: null } } });
    expect(clean.find('.note-crash').exists(), '正常世界不该显示崩溃提示').toBe(false);
    clean.unmount();
  });
});

describeIfPanel('控制台与事件日志的行数上限', () => {
  it('控制台最多渲染 200 行', async () => {
    const w = await mountAt(`/w/${instanceId}/console`);
    await waitFor(w, (t) => t.includes('快捷命令'));
    const n = w.findAll('.console-line').length;
    expect(n, `控制台渲染了 ${n} 行，应该不超过 200`).toBeLessThanOrEqual(200);
    w.unmount();
  });

  it('事件日志页最多渲染 200 行，且事件带类型样式', async () => {
    const w = await mountAt('/events');
    await waitFor(w, (t) => t.includes('事件日志'));
    const n = w.findAll('.console-line').length;
    expect(n, `事件日志渲染了 ${n} 行，应该不超过 200`).toBeLessThanOrEqual(200);
    // 页面结构：时间 + 类型标签 + 说明
    if (n > 0) {
      const first = w.find('.console-line');
      expect(first.find('.ev-time').exists()).toBe(true);
      expect(first.find('.ev-kind').exists()).toBe(true);
    }
    w.unmount();
  });
});
