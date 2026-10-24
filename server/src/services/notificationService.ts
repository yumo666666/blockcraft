import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { DATA_DIR, INSTANCES_DIR } from '../core/paths.ts';
import { atomicWriteJsonSync, readJsonSync } from '../core/fsx.ts';
import { createLogger } from '../core/logger.ts';
import { diskInfo } from './systemService.ts';

const logger = createLogger('notifications');
const FILE = path.join(DATA_DIR, 'notifications.json');
const MAX_CHANNELS = 20;
const DISK_LOW_PERCENT = 10;
const DISK_RECOVERY_PERCENT = 12;

export const NOTIFICATION_TOPICS = [
  { key: 'server_crash', label: '服务器崩溃', group: '服务状态' },
  { key: 'startup_failed', label: '世界启动失败', group: '服务状态' },
  { key: 'world_start_success', label: '世界启动就绪', group: '服务状态' },
  { key: 'world_stop_success', label: '世界关闭完成', group: '服务状态' },
  { key: 'world_restart_success', label: '世界重启完成', group: '服务状态' },
  { key: 'backup_success', label: '备份成功', group: '任务中心' },
  { key: 'backup_failed', label: '备份失败', group: '任务中心' },
  { key: 'save_success', label: '存档保存完成', group: '任务中心' },
  { key: 'command_success', label: '服务器命令完成', group: '任务中心' },
  { key: 'broadcast_success', label: '公告发送完成', group: '任务中心' },
  { key: 'task_success', label: '创建、导入或回退任务完成', group: '任务中心' },
  { key: 'task_failed', label: '其他任务失败', group: '任务中心' },
  { key: 'disk_low', label: '磁盘空间不足', group: '主机与玩家' },
  { key: 'player_join', label: '玩家加入', group: '主机与玩家' },
  { key: 'player_leave', label: '玩家退出', group: '主机与玩家' },
] as const;

export type NotificationTopic = (typeof NOTIFICATION_TOPICS)[number]['key'];
export type EmailProvider = 'qq' | 'netease';
export type NotificationProvider = 'email' | 'feishu';

interface StoredChannelBase {
  id: string;
  name: string;
  provider: NotificationProvider;
  enabled: boolean;
  topics: NotificationTopic[];
  createdAt: number;
  updatedAt: number;
}

interface StoredEmailChannel extends StoredChannelBase {
  provider: 'email';
  emailProvider: EmailProvider;
  account: string;
  recipient: string;
  password: string;
}

interface StoredFeishuChannel extends StoredChannelBase {
  provider: 'feishu';
  webhookUrl: string;
  keyword: string;
  signingSecret: string;
}

type StoredChannel = StoredEmailChannel | StoredFeishuChannel;
interface ChannelStore { channels: StoredChannel[] }

export interface PublicChannel {
  id: string;
  name: string;
  provider: NotificationProvider;
  enabled: boolean;
  topics: NotificationTopic[];
  emailProvider?: EmailProvider;
  account?: string;
  recipient?: string;
  passwordConfigured?: boolean;
  webhookConfigured?: boolean;
  keywordConfigured?: boolean;
  signingSecretConfigured?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NotificationChannelInput {
  id?: string;
  name?: unknown;
  provider?: unknown;
  enabled?: unknown;
  topics?: unknown;
  emailProvider?: unknown;
  account?: unknown;
  recipient?: unknown;
  password?: unknown;
  clearPassword?: unknown;
  webhookUrl?: unknown;
  clearWebhookUrl?: unknown;
  keyword?: unknown;
  clearKeyword?: unknown;
  signingSecret?: unknown;
  clearSigningSecret?: unknown;
}

export interface NotificationMessage {
  topic: NotificationTopic;
  title: string;
  body: string;
  worldName?: string | null;
}

function loadStore(): ChannelStore {
  const value = readJsonSync<ChannelStore | null>(FILE, null);
  return value && Array.isArray(value.channels) ? value : { channels: [] };
}

function saveStore(store: ChannelStore): void {
  atomicWriteJsonSync(FILE, store);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(FILE, 0o600); } catch { /* File permissions may be controlled by the host. */ }
  }
}

function publicChannel(channel: StoredChannel): PublicChannel {
  const common = {
    id: channel.id,
    name: channel.name,
    provider: channel.provider,
    enabled: channel.enabled,
    topics: channel.topics,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
  if (channel.provider === 'email') {
    return {
      ...common,
      emailProvider: channel.emailProvider,
      account: channel.account,
      recipient: channel.recipient,
      passwordConfigured: Boolean(channel.password),
    };
  }
  return {
    ...common,
    webhookConfigured: Boolean(channel.webhookUrl),
    keywordConfigured: Boolean(channel.keyword),
    signingSecretConfigured: Boolean(channel.signingSecret),
  };
}

export function listNotificationChannels(): PublicChannel[] {
  return loadStore().channels.map(publicChannel);
}

function cleanText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  return result;
}

function normalizeTopics(value: unknown): NotificationTopic[] {
  if (!Array.isArray(value)) throw new Error('请选择至少一种通知内容');
  const allowed = new Set<string>(NOTIFICATION_TOPICS.map((item) => item.key));
  const topics = [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    .filter((item): item is NotificationTopic => allowed.has(item));
  if (!topics.length) throw new Error('请选择至少一种通知内容');
  return topics;
}

function normalizeWebhook(raw: unknown): string {
  const value = cleanText(raw, '飞书 Webhook 地址', 500);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('飞书 Webhook 地址无效'); }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'open.feishu.cn' ||
    !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+\/?$/.test(url.pathname) ||
    url.username || url.password
  ) throw new Error('请填写飞书群自定义机器人的 HTTPS Webhook 地址');
  return url.toString();
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function saveNotificationChannel(input: NotificationChannelInput): PublicChannel {
  const store = loadStore();
  const id = input.id ? cleanText(input.id, '渠道 id', 80) : crypto.randomUUID();
  const current = store.channels.find((item) => item.id === id);
  if (input.id && !current) throw new Error('通知渠道不存在');
  if (!current && store.channels.length >= MAX_CHANNELS) throw new Error(`最多添加 ${MAX_CHANNELS} 个通知渠道`);

  const name = cleanText(input.name, '渠道名称', 48);
  if (!name) throw new Error('请填写渠道名称');
  const topics = normalizeTopics(input.topics);
  const enabled = input.enabled !== false;
  const now = Date.now();
  const createdAt = current?.createdAt ?? now;

  let channel: StoredChannel;
  if (input.provider === 'email') {
    if (input.emailProvider !== 'qq' && input.emailProvider !== 'netease') throw new Error('邮箱服务商仅支持 QQ 邮箱和网易邮箱');
    const emailProvider = input.emailProvider;
    const account = cleanText(input.account, '发件邮箱', 254).toLowerCase();
    const recipient = cleanText(input.recipient, '收件邮箱', 254).toLowerCase();
    const domain = account.split('@').at(-1) ?? '';
    const qqAccount = emailProvider === 'qq' && ['qq.com', 'foxmail.com'].includes(domain);
    const neteaseAccount = emailProvider === 'netease' && ['163.com', '126.com', 'yeah.net'].some((item) => domain === item || domain.endsWith(`.${item}`));
    if ((!qqAccount && !neteaseAccount) || !validEmail(account)) throw new Error(emailProvider === 'qq' ? '发件邮箱必须是 QQ 邮箱（qq.com 或 foxmail.com）' : '发件邮箱须使用网易邮箱（163.com、126.com 或 yeah.net）');
    if (!validEmail(recipient)) throw new Error('请输入有效的收件邮箱地址');
    const passwordInput = typeof input.password === 'string' ? input.password : '';
    const canReusePassword = current?.provider === 'email' && current.emailProvider === emailProvider && current.account === account;
    const password = passwordInput || (canReusePassword ? current.password : '');
    if (input.clearPassword === true) throw new Error('如需更换授权码，请直接输入新的授权码后保存');
    if (!password) throw new Error('请输入邮箱 SMTP 授权码');
    channel = { id, name, provider: 'email', enabled, topics, emailProvider, account, recipient, password, createdAt, updatedAt: now };
  } else if (input.provider === 'feishu') {
    const previous = current?.provider === 'feishu' ? current : null;
    const webhookInput = typeof input.webhookUrl === 'string' ? input.webhookUrl.trim() : '';
    const webhookUrl = webhookInput ? normalizeWebhook(webhookInput) : previous?.webhookUrl ?? '';
    if (!webhookUrl || input.clearWebhookUrl === true) throw new Error('请填写飞书 Webhook 地址');
    const keywordInput = cleanText(input.keyword ?? '', '自定义关键词', 80);
    const keyword = keywordInput || (input.clearKeyword === true ? '' : previous?.keyword ?? '');
    const secretInput = typeof input.signingSecret === 'string' ? input.signingSecret : '';
    const signingSecret = secretInput || (input.clearSigningSecret === true ? '' : previous?.signingSecret ?? '');
    channel = { id, name, provider: 'feishu', enabled, topics, webhookUrl, keyword, signingSecret, createdAt, updatedAt: now };
  } else {
    throw new Error('通知渠道仅支持邮箱和飞书');
  }

  if (current) store.channels = store.channels.map((item) => item.id === id ? channel : item);
  else store.channels.push(channel);
  saveStore(store);
  return publicChannel(channel);
}

export function deleteNotificationChannel(id: string): boolean {
  const store = loadStore();
  const next = store.channels.filter((item) => item.id !== id);
  if (next.length === store.channels.length) return false;
  store.channels = next;
  saveStore(store);
  return true;
}

function safeDiagnostic(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join('[已隐藏]');
  return message.replace(/https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+/g, '[飞书 Webhook]');
}

function notificationText(message: NotificationMessage, test = false): string {
  const topic = NOTIFICATION_TOPICS.find((item) => item.key === message.topic)?.label ?? '通知';
  const parts = [test ? 'BlockCraft 通知测试' : `BlockCraft · ${topic}`, message.title];
  if (message.worldName) parts.push(`世界：${message.worldName}`);
  if (message.body) parts.push(message.body);
  parts.push(`时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  return parts.join('\n');
}

function smtpSettings(channel: StoredEmailChannel): { host: string; port: number } {
  if (channel.emailProvider === 'qq') return { host: 'smtp.qq.com', port: 465 };
  const domain = channel.account.split('@').at(-1)?.toLowerCase() ?? '';
  const host = domain.endsWith('126.com') ? 'smtp.126.com' : domain.endsWith('yeah.net') ? 'smtp.yeah.net' : 'smtp.163.com';
  return { host, port: 465 };
}

function feishuSignature(secret: string, timestamp: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', Buffer.from(stringToSign, 'utf8')).update(Buffer.alloc(0)).digest('base64');
}

async function sendChannel(channel: StoredChannel, message: NotificationMessage, test = false): Promise<void> {
  const text = notificationText(message, test);
  if (channel.provider === 'email') {
    const smtp = smtpSettings(channel);
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      auth: { user: channel.account, pass: channel.password },
    });
    try {
      const result = await transporter.sendMail({
        from: { name: 'BlockCraft', address: channel.account },
        to: channel.recipient,
        subject: `${test ? '【BlockCraft 测试】' : '【BlockCraft 通知】'}${message.title}`,
        text,
      });
      if (!result.accepted?.length) throw new Error('SMTP 服务器未接受收件人');
    } finally {
      transporter.close();
    }
    return;
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const body: Record<string, unknown> = {
    msg_type: 'text',
    content: { text: channel.keyword ? `${channel.keyword}\n${text}` : text },
  };
  if (channel.signingSecret) {
    body.timestamp = timestamp;
    body.sign = feishuSignature(channel.signingSecret, timestamp);
  }
  const response = await fetch(channel.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  const result = await response.json().catch(() => ({})) as { code?: number; StatusCode?: number; msg?: string; StatusMessage?: string };
  const hasCode = typeof result.code === 'number' || typeof result.StatusCode === 'number';
  const code = result.code ?? result.StatusCode;
  if (!response.ok || !hasCode || code !== 0) throw new Error(result.msg ?? result.StatusMessage ?? `飞书返回 HTTP ${response.status}`);
}

const channelQueues = new Map<string, Promise<void>>();
const channelLastSentAt = new Map<string, number>();

function enqueueChannelSend(channel: StoredChannel, message: NotificationMessage, test = false): Promise<void> {
  const previous = channelQueues.get(channel.id) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    // Keep a small per-channel gap so bursts of join/leave events stay below Feishu's webhook rate limit.
    const wait = Math.max(0, 250 - (Date.now() - (channelLastSentAt.get(channel.id) ?? 0)));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    await sendChannel(channel, message, test);
    channelLastSentAt.set(channel.id, Date.now());
  });
  channelQueues.set(channel.id, pending);
  void pending.then(() => {
    if (channelQueues.get(channel.id) === pending) channelQueues.delete(channel.id);
  }, () => {
    if (channelQueues.get(channel.id) === pending) channelQueues.delete(channel.id);
  });
  return pending;
}

export async function testNotificationChannel(id: string): Promise<void> {
  const channel = loadStore().channels.find((item) => item.id === id);
  if (!channel) throw new Error('通知渠道不存在');
  try {
    await enqueueChannelSend(channel, { topic: 'task_success', title: '通知渠道连接测试', body: '如果收到这条消息，BlockCraft 已成功发送测试通知。' }, true);
  } catch (error) {
    const secrets = channel.provider === 'email'
      ? [channel.password]
      : [channel.webhookUrl, channel.signingSecret];
    throw new Error(safeDiagnostic(error, secrets));
  }
}

export function dispatchNotification(message: NotificationMessage): void {
  const channels = loadStore().channels.filter((item) => item.enabled && item.topics.includes(message.topic));
  for (const channel of channels) {
    void enqueueChannelSend(channel, message).catch((error: unknown) => {
      const secrets = channel.provider === 'email' ? [channel.password] : [channel.webhookUrl, channel.signingSecret];
      logger.warn(`通知渠道「${channel.name}」发送失败`, safeDiagnostic(error, secrets));
    });
  }
}

const diskLowByRoot = new Map<string, boolean>();
let diskTimer: NodeJS.Timeout | null = null;

function checkDiskSpace(): void {
  const roots = new Set([path.parse(DATA_DIR).root, path.parse(INSTANCES_DIR).root]);
  for (const root of roots) {
    if (!root) continue;
    const info = diskInfo(root);
    if (info.totalGb <= 0) continue;
    const freePercent = info.freeGb / info.totalGb * 100;
    const wasLow = diskLowByRoot.get(root) ?? false;
    if (freePercent <= DISK_LOW_PERCENT && !wasLow) {
      diskLowByRoot.set(root, true);
      const body = `${root} 可用 ${info.freeGb.toFixed(1)} GB / ${info.totalGb.toFixed(1)} GB（${freePercent.toFixed(1)}%）；空间恢复到 ${DISK_RECOVERY_PERCENT}% 后才会重新提醒。`;
      dispatchNotification({ topic: 'disk_low', title: '磁盘空间不足', body });
      logger.warn('检测到磁盘空间不足', { root, freeGb: info.freeGb, totalGb: info.totalGb });
    } else if (freePercent >= DISK_RECOVERY_PERCENT && wasLow) {
      diskLowByRoot.set(root, false);
    }
  }
}

export function startNotificationMonitor(): void {
  if (diskTimer) return;
  checkDiskSpace();
  diskTimer = setInterval(checkDiskSpace, 60_000);
  diskTimer.unref();
}

