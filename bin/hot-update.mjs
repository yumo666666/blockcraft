// Stop only the local BlockCraft panel before replacing source files.
// Minecraft server processes are independent and are intentionally left alone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.BC_DATA_DIR || path.join(root, 'data');
const configFile = path.join(dataDir, 'panel.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, options = {}, timeoutMs = 2500) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function panelResponds(base) {
  try {
    const response = await request(`${base}/api/ping`);
    return response.ok;
  } catch {
    return false;
  }
}

if (!fs.existsSync(configFile)) {
  console.log('[BlockCraft] 找不到 data/panel.json；将更新文件并在完成后启动面板。');
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const port = Number(process.env.BC_PORT || config.panel?.port || 8081);
const token = String(process.env.BC_TOKEN || config.panel?.token || '');
const base = `http://127.0.0.1:${port}`;

if (!(await panelResponds(base))) {
  console.log('[BlockCraft] 面板当前未运行；更新完成后会启动它。');
  process.exit(0);
}
if (!token) throw new Error('panel.json 里没有面板登录令牌。');

const login = await request(`${base}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-blockcraft': '1' },
  body: JSON.stringify({ token }),
});
if (!login.ok) throw new Error(`面板本地登录失败（HTTP ${login.status}）。`);
const cookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
if (!cookie) throw new Error('面板登录成功，但没有返回会话 cookie。');
const headers = { cookie, 'x-blockcraft': '1' };

const panelInfoResponse = await request(`${base}/api/panel`, { headers });
if (!panelInfoResponse.ok) throw new Error(`读取本机面板目录失败（HTTP ${panelInfoResponse.status}）。`);
const panelInfo = await panelInfoResponse.json();
if (path.resolve(String(panelInfo.projectRoot ?? '')) !== path.resolve(root) ||
    path.resolve(String(panelInfo.dataDir ?? '')) !== path.resolve(dataDir)) {
  throw new Error('该端口响应的是另一份 BlockCraft 安装；为避免关闭错误面板，更新已取消。');
}

const statusResponse = await request(`${base}/api/panel/shutdown-status`, { headers });
if (!statusResponse.ok) throw new Error(`读取面板任务状态失败（HTTP ${statusResponse.status}）。`);
const status = await statusResponse.json();
if ((status.jobs?.length ?? 0) > 0 || Number(status.pendingSetups ?? 0) > 0) {
  const jobs = (status.jobs ?? []).map((job) => `${job.title} ${job.progress ?? 0}%`).join('、');
  throw new Error(`有创建、导入或安装任务正在进行，暂不更新${jobs ? `：${jobs}` : ''}。`);
}
const worlds = (status.worlds ?? []).map((world) => world.name).filter(Boolean);
console.log(worlds.length
  ? `[BlockCraft] 面板将短暂重启；这些世界会继续运行：${worlds.join('、')}`
  : '[BlockCraft] 面板将短暂重启；当前没有运行中的世界。');

const shutdown = await request(`${base}/api/panel/shutdown`, { method: 'POST', headers });
if (!shutdown.ok) throw new Error(`面板停止请求失败（HTTP ${shutdown.status}）。`);
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  if (!(await panelResponds(base))) {
    console.log('[BlockCraft] 面板已退出，运行中的 Minecraft 世界保持原样。');
    process.exit(0);
  }
  await sleep(500);
}
throw new Error('等待面板退出超时；未继续更改文件。');
