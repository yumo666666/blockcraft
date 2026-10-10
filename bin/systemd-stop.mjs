#!/usr/bin/env node
// systemd ExecStop hook: use the same guarded shutdown flow as the Windows tray.
// This waits instead of letting systemd kill the panel if a world cannot stop safely.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.BC_DATA_DIR || path.join(root, 'data');
const configFile = path.join(dataDir, 'panel.json');
const retryMs = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readPanelConfig() {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  return {
    port: Number(process.env.BC_PORT || config.panel?.port || 8081),
    token: String(process.env.BC_TOKEN || config.panel?.token || ''),
  };
}

async function request(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntilPanelStops(base) {
  while (true) {
    try {
      const response = await request(`${base}/api/ping`, {}, 2000);
      if (!response.ok) return;
    } catch {
      return;
    }
    await sleep(500);
  }
}

function statusSummary(status) {
  const parts = [];
  if (status.jobs?.length) parts.push(`任务：${status.jobs.map((job) => `${job.title} ${job.progress ?? 0}%`).join('、')}`);
  if (status.pendingSetups) parts.push(`创建/导入准备中：${status.pendingSetups}`);
  if (status.worlds?.length) parts.push(`世界：${status.worlds.map((world) => `${world.name}（${world.status}）`).join('、')}`);
  return parts.join('；') || '正在安全停止世界与 FRP 通道';
}

let lastStatus = '';
console.log('[BlockCraft] 正在安全关闭：等待任务结束，停止世界、FRP 通道和面板。');

while (true) {
  let config;
  try {
    // Re-read on each attempt so a corrected panel token can unblock a pending stop.
    config = readPanelConfig();
  } catch (error) {
    console.error(`[BlockCraft] 无法读取面板配置，保持服务运行并重试：${String(error)}`);
    await sleep(retryMs);
    continue;
  }

  const base = `http://127.0.0.1:${config.port}`;
  let cookie = '';
  try {
    const login = await request(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: config.token }),
    });
    cookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
    if (!login.ok || !cookie) {
      console.error(`[BlockCraft] 本地面板登录失败（HTTP ${login.status}），保持服务运行并重试。`);
      await sleep(retryMs);
      continue;
    }
  } catch (error) {
    console.error(`[BlockCraft] 正在等待面板响应：${String(error)}`);
    await sleep(retryMs);
    continue;
  }

  const headers = { Cookie: cookie, 'X-BlockCraft': '1' };
  const stopRequest = request(`${base}/api/panel/shutdown-after-worlds`, {
    method: 'POST',
    headers,
  }, 24 * 60 * 60 * 1000).then(async (response) => ({
    response,
    text: await response.text().catch(() => ''),
  })).catch((error) => ({ error }));

  let result;
  while (!result) {
    result = await Promise.race([stopRequest, sleep(5000).then(() => null)]);
    if (result) break;
    try {
      const response = await request(`${base}/api/panel/shutdown-status`, { headers });
      if (response.ok) {
        const summary = statusSummary(await response.json());
        if (summary !== lastStatus) {
          console.log(`[BlockCraft] ${summary}`);
          lastStatus = summary;
        }
      }
    } catch {
      // The shutdown request may already have exited the panel; verify below.
    }
  }

  if (result.response?.ok) {
    console.log('[BlockCraft] 世界和 FRP 已安全停止，等待面板退出。');
    await waitUntilPanelStops(base);
    console.log('[BlockCraft] 面板已退出，安全关闭完成。');
    process.exit(0);
  }

  if (result.error) console.error(`[BlockCraft] 安全关闭请求失败：${String(result.error)}`);
  else console.error(`[BlockCraft] 安全关闭尚未完成（HTTP ${result.response?.status}）：${result.text || '面板保持运行，稍后重试。'}`);
  await sleep(retryMs);
}
