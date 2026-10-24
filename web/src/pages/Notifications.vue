<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import { api } from '../lib/api.ts';
import { toast, toastError } from '../lib/toast.ts';

defineOptions({ name: 'Notifications' });

type NotificationTopic =
  | 'server_crash' | 'startup_failed' | 'world_start_success' | 'world_stop_success' | 'world_restart_success'
  | 'backup_success' | 'backup_failed' | 'save_success' | 'command_success' | 'broadcast_success'
  | 'task_success' | 'task_failed' | 'disk_low' | 'player_join' | 'player_leave';
type Provider = 'email' | 'feishu';
interface Channel {
  id: string;
  name: string;
  provider: Provider;
  enabled: boolean;
  topics: NotificationTopic[];
  emailProvider?: 'qq' | 'netease';
  account?: string;
  recipient?: string;
  passwordConfigured?: boolean;
  webhookConfigured?: boolean;
  keywordConfigured?: boolean;
  signingSecretConfigured?: boolean;
}

const TOPIC_GROUPS: { name: string; topics: { key: NotificationTopic; label: string }[] }[] = [
  { name: '服务状态', topics: [
    { key: 'server_crash', label: '服务器崩溃' },
    { key: 'startup_failed', label: '世界启动失败' },
    { key: 'world_start_success', label: '世界启动就绪' },
    { key: 'world_stop_success', label: '世界关闭完成' },
    { key: 'world_restart_success', label: '世界重启完成' },
  ] },
  { name: '任务中心', topics: [
    { key: 'backup_success', label: '备份成功' },
    { key: 'backup_failed', label: '备份失败' },
    { key: 'save_success', label: '存档保存完成' },
    { key: 'command_success', label: '服务器命令完成' },
    { key: 'broadcast_success', label: '公告发送完成' },
    { key: 'task_success', label: '创建、导入或回退任务完成' },
    { key: 'task_failed', label: '其他任务失败' },
  ] },
  { name: '主机与玩家', topics: [
    { key: 'disk_low', label: '磁盘空间不足' },
    { key: 'player_join', label: '玩家加入' },
    { key: 'player_leave', label: '玩家退出' },
  ] },
];

const channels = ref<Channel[]>([]);
const loading = ref(true);
const formOpen = ref(false);
const saving = ref(false);
const busyId = ref('');
const deleting = ref<Channel | null>(null);
const form = reactive({
  id: '' as string,
  name: '',
  provider: 'email' as Provider,
  enabled: true,
  topics: ['server_crash', 'startup_failed', 'backup_failed', 'disk_low'] as NotificationTopic[],
  emailProvider: 'qq' as 'qq' | 'netease',
  account: '',
  recipient: '',
  password: '',
  webhookUrl: '',
  keyword: '',
  signingSecret: '',
  clearKeyword: false,
  clearSigningSecret: false,
});

const editing = computed(() => Boolean(form.id));
const editingChannel = computed(() => channels.value.find((channel) => channel.id === form.id) ?? null);
const enabledCount = computed(() => channels.value.filter((channel) => channel.enabled).length);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.get<{ channels: Channel[] }>('/api/notifications/channels');
    channels.value = result.channels ?? [];
  } catch (error) {
    toastError(error, '读取通知渠道失败');
  } finally {
    loading.value = false;
  }
}

function resetForm(): void {
  Object.assign(form, {
    id: '', name: '', provider: 'email', enabled: true,
    topics: ['server_crash', 'startup_failed', 'backup_failed', 'disk_low'],
    emailProvider: 'qq', account: '', recipient: '', password: '',
    webhookUrl: '', keyword: '', signingSecret: '', clearKeyword: false, clearSigningSecret: false,
  });
}

function addChannel(): void {
  resetForm();
  formOpen.value = true;
}

function editChannel(channel: Channel): void {
  resetForm();
  Object.assign(form, {
    id: channel.id,
    name: channel.name,
    provider: channel.provider,
    enabled: channel.enabled,
    topics: [...channel.topics],
    emailProvider: channel.emailProvider ?? 'qq',
    account: channel.account ?? '',
    recipient: channel.recipient ?? '',
  });
  formOpen.value = true;
}

function toggleTopic(topic: NotificationTopic): void {
  form.topics = form.topics.includes(topic)
    ? form.topics.filter((item) => item !== topic)
    : [...form.topics, topic];
}

async function saveChannel(): Promise<void> {
  if (!form.name.trim()) {
    toast('warn', '请填写渠道名称');
    return;
  }
  if (!form.topics.length) {
    toast('warn', '请至少选择一种通知内容');
    return;
  }
  saving.value = true;
  try {
    const body = {
      name: form.name,
      provider: form.provider,
      enabled: form.enabled,
      topics: form.topics,
      ...(form.provider === 'email' ? {
        emailProvider: form.emailProvider,
        account: form.account,
        recipient: form.recipient,
        password: form.password,
      } : {
        webhookUrl: form.webhookUrl,
        keyword: form.keyword,
        signingSecret: form.signingSecret,
        clearKeyword: form.clearKeyword,
        clearSigningSecret: form.clearSigningSecret,
      }),
    };
    if (editing.value) await api.put(`/api/notifications/channels/${encodeURIComponent(form.id)}`, body);
    else await api.post('/api/notifications/channels', body);
    formOpen.value = false;
    toast('ok', editing.value ? '通知渠道已更新' : '通知渠道已添加');
    await load();
  } catch (error) {
    toastError(error, '保存通知渠道失败');
  } finally {
    saving.value = false;
  }
}

async function testChannel(channel: Channel): Promise<void> {
  busyId.value = channel.id;
  try {
    await api.post(`/api/notifications/channels/${encodeURIComponent(channel.id)}/test`, {});
    toast('ok', '测试通知已发送', '请检查对应邮箱或飞书群');
  } catch (error) {
    toastError(error, '测试通知发送失败');
  } finally {
    busyId.value = '';
  }
}

async function toggleChannel(channel: Channel): Promise<void> {
  busyId.value = channel.id;
  try {
    await api.put(`/api/notifications/channels/${encodeURIComponent(channel.id)}`, {
      name: channel.name,
      provider: channel.provider,
      enabled: !channel.enabled,
      topics: channel.topics,
      ...(channel.provider === 'email'
        ? { emailProvider: channel.emailProvider, account: channel.account, recipient: channel.recipient }
        : {}),
    });
    await load();
  } catch (error) {
    toastError(error, '更新渠道状态失败');
  } finally {
    busyId.value = '';
  }
}

async function deleteChannel(): Promise<void> {
  if (!deleting.value) return;
  busyId.value = deleting.value.id;
  try {
    await api.del(`/api/notifications/channels/${encodeURIComponent(deleting.value.id)}`);
    toast('ok', '通知渠道已删除');
    deleting.value = null;
    await load();
  } catch (error) {
    toastError(error, '删除通知渠道失败');
  } finally {
    busyId.value = '';
  }
}

function topicsFor(channel: Channel): string[] {
  const names = TOPIC_GROUPS.flatMap((group) => group.topics).filter((topic) => channel.topics.includes(topic.key)).map((topic) => topic.label);
  return names;
}

onMounted(() => { void load(); });
</script>

<template>
  <div class="page col gap-4 notification-page">
    <div class="row-between wrap gap-3 notification-heading">
      <div class="page-heading">
        <h1>通知中心</h1>
        <p>把服务器状态、任务结果和玩家动态发送到邮箱或飞书群。</p>
      </div>
      <button class="btn btn-primary btn-lg" @click="addChannel"><Icon name="plus" :size="16" />添加通知渠道</button>
    </div>

    <div class="notification-summary card">
      <div class="notification-summary-icon"><Icon name="bell" :size="19" /></div>
      <div class="grow">
        <strong>{{ enabledCount }} / {{ channels.length }} 个渠道已启用</strong>
        <p>凭据仅保存在 BlockCraft 服务端；读取渠道列表时不会返回授权码、Webhook 或签名密钥。</p>
      </div>
      <span class="badge badge-outline">QQ 邮箱 · 网易 163 · 飞书</span>
    </div>

    <section class="card notification-list-card">
      <div class="card-head row-between wrap gap-2">
        <h2><span class="head-icon"><Icon name="bell" :size="15" /></span>通知渠道</h2>
        <span class="text-3 small">{{ channels.length }} 个渠道</span>
      </div>
      <div v-if="loading" class="notification-loading" role="status" aria-label="正在读取通知渠道" aria-busy="true">
        <article class="notification-channel notification-channel-loading" aria-hidden="true">
          <div class="notification-channel-main">
            <div class="notification-channel-title">
              <span class="skeleton notification-skeleton-icon" />
              <div class="grow col gap-2"><span class="skeleton notification-skeleton-line notification-skeleton-name" /><span class="skeleton notification-skeleton-line notification-skeleton-destination" /></div>
            </div>
            <div class="notification-topics"><span v-for="item in 4" :key="item" class="skeleton notification-skeleton-topic" /></div>
          </div>
          <div class="notification-actions"><span v-for="item in 4" :key="item" class="skeleton notification-skeleton-button" /></div>
        </article>
      </div>
      <div v-else-if="!channels.length" class="notification-empty">
        <span class="empty-icon"><Icon name="bell" :size="20" /></span>
        <strong>还没有通知渠道</strong>
        <p>添加 QQ / 网易邮箱或飞书群机器人，再勾选希望接收的事件。</p>
        <button class="btn btn-primary" @click="addChannel"><Icon name="plus" :size="15" />添加第一个渠道</button>
      </div>
      <div v-else class="notification-channel-list">
        <article v-for="channel in channels" :key="channel.id" class="notification-channel">
          <div class="notification-channel-main">
            <div class="notification-channel-title">
              <span class="channel-icon"><Icon :name="channel.provider === 'email' ? 'mail' : 'send'" :size="18" /></span>
              <div class="grow">
                <div class="row wrap gap-2">
                  <h3>{{ channel.name }}</h3>
                  <span class="badge" :class="channel.enabled ? 'badge-ok' : 'badge-outline'">{{ channel.enabled ? '已启用' : '已停用' }}</span>
                </div>
                <p class="notification-destination">
                  <template v-if="channel.provider === 'email'">{{ channel.emailProvider === 'qq' ? 'QQ 邮箱' : '网易邮箱' }} · {{ channel.account }} → {{ channel.recipient }}</template>
                  <template v-else>飞书群机器人 · {{ channel.webhookConfigured ? 'Webhook 已配置' : '待配置' }}</template>
                </p>
              </div>
            </div>
            <div class="notification-topics" aria-label="已选择的通知内容">
              <span v-for="topic in topicsFor(channel)" :key="topic" class="badge badge-outline">{{ topic }}</span>
            </div>
          </div>
          <div class="notification-actions">
            <button class="btn btn-soft" :disabled="busyId === channel.id" @click="testChannel(channel)"><span v-if="busyId === channel.id" class="spinner" /><Icon v-else name="send" :size="14" />发送测试</button>
            <button class="btn" :disabled="busyId === channel.id" @click="toggleChannel(channel)">{{ channel.enabled ? '停用' : '启用' }}</button>
            <button class="btn" @click="editChannel(channel)">编辑</button>
            <button class="btn btn-danger" aria-label="删除通知渠道" @click="deleting = channel"><Icon name="trash" :size="15" />删除</button>
          </div>
        </article>
      </div>
    </section>

    <section class="notification-note card">
      <div class="note-mark"><Icon name="info" :size="16" /></div>
      <div>
        <strong>触发说明</strong>
        <p>磁盘可用空间低于 10% 时通知；空间恢复至 12% 后，之后再次不足才会重发。每分钟检查一次。玩家进出根据 Minecraft 服务端日志识别。</p>
      </div>
    </section>

    <Modal v-if="formOpen" :title="editing ? '编辑通知渠道' : '添加通知渠道'" size="lg" @close="formOpen = false">
      <form class="notification-form col gap-4" @submit.prevent="saveChannel">
        <div class="form-grid-2">
          <label class="field"><span class="field-label">渠道名称</span><input v-model="form.name" class="input" maxlength="48" required placeholder="例如：运维邮箱、游戏群机器人" /></label>
          <label class="field"><span class="field-label">通知方式</span><select v-model="form.provider" class="input"><option value="email">邮箱通知</option><option value="feishu">飞书群通知</option></select></label>
        </div>

        <div v-if="form.provider === 'email'" class="notification-provider-fields">
          <div class="form-grid-2">
            <label class="field"><span class="field-label">邮箱服务商</span><select v-model="form.emailProvider" class="input"><option value="qq">QQ 邮箱</option><option value="netease">网易邮箱（163 / 126 / yeah.net）</option></select></label>
            <label class="field"><span class="field-label">发件邮箱</span><input v-model="form.account" class="input" type="email" autocomplete="email" required placeholder="完整邮箱地址" /></label>
            <label class="field"><span class="field-label">收件邮箱</span><input v-model="form.recipient" class="input" type="email" autocomplete="email" required placeholder="通知发送到哪里" /></label>
            <label class="field"><span class="field-label">SMTP 授权码</span><input v-model="form.password" class="input" type="password" autocomplete="new-password" :required="!editingChannel || editingChannel.provider !== 'email' || !editingChannel.passwordConfigured || editingChannel.emailProvider !== form.emailProvider || editingChannel.account !== form.account.trim().toLowerCase()" :placeholder="editingChannel?.provider === 'email' && editingChannel.emailProvider === form.emailProvider && editingChannel.account === form.account.trim().toLowerCase() ? '留空则继续使用已保存的授权码' : '在邮箱设置中生成，不是登录密码'" /></label>
          </div>
          <p class="field-hint">通过 SSL SMTP 发送；网易邮箱会按地址使用 163、126 或 yeah.net 对应服务器，密码填写邮箱生成的客户端授权码。</p>
        </div>

        <div v-else class="notification-provider-fields">
          <label class="field"><span class="field-label">飞书群机器人 Webhook</span><input v-model="form.webhookUrl" class="input mono" type="password" autocomplete="new-password" :required="!editingChannel || editingChannel.provider !== 'feishu' || !editingChannel.webhookConfigured" :placeholder="editingChannel?.provider === 'feishu' ? '留空则继续使用已保存的 Webhook' : 'https://open.feishu.cn/open-apis/bot/v2/hook/…'" /></label>
          <div class="form-grid-2">
            <label class="field"><span class="field-label">自定义关键词 <small>可选</small></span><input v-model="form.keyword" class="input" maxlength="80" placeholder="若机器人启用了关键词校验" /></label>
            <label class="field"><span class="field-label">签名校验密钥 <small>可选</small></span><input v-model="form.signingSecret" class="input" type="password" autocomplete="new-password" placeholder="若机器人启用了签名校验" /></label>
          </div>
          <label v-if="editingChannel?.provider === 'feishu' && (editingChannel.keywordConfigured || editingChannel.signingSecretConfigured)" class="notification-clear-secrets">
            <span v-if="editingChannel.keywordConfigured"><input v-model="form.clearKeyword" type="checkbox" />清除已保存的关键词</span>
            <span v-if="editingChannel.signingSecretConfigured"><input v-model="form.clearSigningSecret" type="checkbox" />清除已保存的签名密钥</span>
          </label>
          <p class="field-hint">飞书群「设置 → 群机器人 → 添加机器人 → 自定义机器人」中可新建；开启关键词校验或签名时，把对应内容填入上方。</p>
        </div>

        <label class="switch notification-enabled"><input v-model="form.enabled" type="checkbox" /><span class="switch-track" /><span class="switch-text">保存后启用此渠道</span></label>

        <fieldset class="notification-topics-fieldset">
          <legend class="field-label">通知内容 <small>至少选择一项</small></legend>
          <div v-for="group in TOPIC_GROUPS" :key="group.name" class="notification-topic-group">
            <h3>{{ group.name }}</h3>
            <div class="notification-topic-grid">
              <label v-for="topic in group.topics" :key="topic.key" class="notification-topic-option" :class="{ selected: form.topics.includes(topic.key) }">
                <input type="checkbox" :checked="form.topics.includes(topic.key)" @change="toggleTopic(topic.key)" />
                <span>{{ topic.label }}</span>
              </label>
            </div>
          </div>
        </fieldset>
      </form>
      <template #footer><button class="btn btn-soft" @click="formOpen = false">取消</button><button class="btn btn-primary" :disabled="saving" @click="saveChannel"><span v-if="saving" class="spinner spinner-on-accent" />{{ editing ? '保存修改' : '添加渠道' }}</button></template>
    </Modal>

    <ConfirmDialog
      :open="Boolean(deleting)"
      title="删除通知渠道"
      :message="`确定删除「${deleting?.name ?? ''}」吗？保存的渠道凭据也会一并移除。`"
      danger
      confirm-text="删除渠道"
      :busy="Boolean(deleting && busyId === deleting.id)"
      @close="deleting = null"
      @confirm="deleteChannel"
    />
  </div>
</template>

<style scoped>
.notification-page { min-width: 0; }
.notification-heading { align-items: flex-end; }
.notification-summary { display: flex; align-items: center; gap: 14px; padding: 15px 18px; }
.notification-summary-icon, .channel-icon { display: grid; place-items: center; flex: none; width: 38px; height: 38px; border: 1px solid var(--accent-border); border-radius: 11px; background: var(--accent-soft); color: var(--accent-text); }
.notification-summary strong { display: block; font-size: 14px; }
.notification-summary p, .notification-note p { margin-top: 3px; color: var(--text-3); font-size: 12.5px; }
.notification-list-card { overflow: hidden; }
.notification-empty { display: grid; min-height: 148px; box-sizing: border-box; justify-items: center; align-content: center; gap: 10px; padding: 24px 18px; text-align: center; }
.notification-loading { min-height: 148px; }
.notification-channel-loading { min-height: 148px; box-sizing: border-box; border-top: 0; }
.notification-skeleton-icon { display: block; width: 38px; height: 38px; flex: none; border-radius: 11px; }
.notification-skeleton-line { display: block; height: 11px; border-radius: 5px; }
.notification-skeleton-name { width: min(180px, 65%); height: 14px; }
.notification-skeleton-destination { width: min(250px, 90%); }
.notification-skeleton-topic { display: block; width: 72px; height: 23px; border-radius: 999px; }
.notification-skeleton-button { display: block; width: 84px; height: 34px; border-radius: var(--r-sm); }
.notification-empty p { color: var(--text-3); font-size: 13px; }
.notification-channel-list { display: grid; }
.notification-channel { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 17px 18px; border-top: 1px solid var(--border); }
.notification-channel:first-child { border-top: 0; }
.notification-channel-main { min-width: 0; display: grid; gap: 12px; }
.notification-channel-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
.notification-channel-title h3 { font-size: 14px; }
.notification-destination { margin-top: 3px; color: var(--text-3); font-size: 12px; overflow-wrap: anywhere; }
.notification-topics { display: flex; flex-wrap: wrap; gap: 6px; }
.notification-actions { display: grid; grid-template-columns: repeat(2, minmax(88px, 1fr)); gap: 7px; }
.notification-actions > * { width: 100%; min-width: 0; }
.notification-note { display: flex; align-items: flex-start; gap: 11px; padding: 14px 16px; }
.note-mark { display: grid; place-items: center; flex: none; width: 27px; height: 27px; color: var(--info-text); border-radius: 8px; background: var(--info-soft); }
.notification-note strong { font-size: 13px; }
.notification-form { min-width: 0; }
.notification-provider-fields { display: grid; gap: 11px; padding: 13px; border: 1px solid var(--border); border-radius: var(--r); background: var(--surface-2); }
.notification-topics-fieldset { display: grid; gap: 13px; min-width: 0; margin: 0; padding: 0; border: 0; }
.notification-topics-fieldset legend { margin-bottom: 1px; }
.notification-topics-fieldset legend small, .field-label small { margin-left: 4px; color: var(--text-3); font-size: 11.5px; font-weight: 400; }
.notification-topic-group { display: grid; gap: 7px; }
.notification-topic-group h3 { color: var(--text-2); font-size: 12px; }
.notification-topic-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
.notification-topic-option { display: flex; align-items: flex-start; gap: 8px; min-height: 38px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); color: var(--text-2); font-size: 12.5px; cursor: pointer; }
.notification-topic-option input { flex: none; width: 16px; height: 16px; margin: 1px 0 0; accent-color: var(--accent-strong); }
.notification-topic-option.selected { border-color: var(--accent-border); background: var(--accent-soft); color: var(--text); }
.notification-clear-secrets { display: flex; flex-wrap: wrap; gap: 12px 18px; color: var(--text-3); font-size: 12px; }
.notification-clear-secrets span { display: inline-flex; align-items: center; gap: 6px; }
.notification-clear-secrets input { width: 15px; height: 15px; accent-color: var(--accent-strong); }
.notification-enabled { align-self: flex-start; }
@media (max-width: 840px) {
  .notification-channel { align-items: flex-start; flex-direction: column; }
  .notification-channel-loading { min-height: 148px; }
  .notification-topic-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .notification-summary > .badge { display: none; }
}
@media (max-width: 520px) {
  .notification-heading { align-items: stretch; }
  .notification-heading > .btn { align-self: flex-start; }
  .notification-topic-grid { grid-template-columns: 1fr; }
  .notification-actions { width: 100%; }
  .notification-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .notification-skeleton-button { height: 44px; }
}
</style>
