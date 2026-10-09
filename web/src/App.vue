<script setup lang="ts">
import { BLOCK_ICON_SVG } from './lib/blockIcon.ts';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, setUnauthorizedHandler } from './lib/api.ts';
import { toast, toastError } from './lib/toast.ts';
import ToastHost from './components/ToastHost.vue';
import ThemeSwitcher from './components/ThemeSwitcher.vue';

const router = useRouter();
const ready = ref(false);
const authed = ref(false);
const token = ref('');
const loginBusy = ref(false);
const loginError = ref('');
const addresses = ref<{ label: string; value: string; kind: string }[]>([]);
const publicAddr = ref<string | null>(null);

async function loadShell() {
  const res = await api.get<{ config: { panel: { port: number } }; addresses: { label: string; value: string; kind: string }[] }>(
    '/api/panel',
  );
  addresses.value = res.addresses;
}

async function checkAuth() {
  try {
    await loadShell();
    authed.value = true;
  } catch {
    authed.value = false;
  } finally {
    ready.value = true;
  }
}

async function doLogin() {
  loginBusy.value = true;
  loginError.value = '';
  try {
    await api.login(token.value.trim());
    await loadShell();
    authed.value = true;
    toast('ok', '已登录');
  } catch (err) {
    loginError.value = err instanceof Error ? err.message : '登录失败';
  } finally {
    loginBusy.value = false;
  }
}

async function doLogout() {
  await api.logout().catch(() => undefined);
  authed.value = false;
  token.value = '';
}

setUnauthorizedHandler(() => {
  authed.value = false;
});

onMounted(checkAuth);

async function refreshPublic() {
  try {
    const st = await api.get<{ panelProxy: { remotePort: number } | null; server: { addr: string } }>('/api/frp/status');
    publicAddr.value = st.panelProxy && st.server.addr ? `http://${st.server.addr}:${st.panelProxy.remotePort}` : null;
  } catch {
    publicAddr.value = null;
  }
}
onMounted(refreshPublic);

defineExpose({});
</script>

<template>
  <div v-if="!ready" class="login-wrap">
    <div class="spinner" />
  </div>

  <div v-else-if="!authed" class="login-wrap">
    <div class="card login-card">
      <div class="row gap-3 mb-4">
        <div class="brand-mark" v-html="BLOCK_ICON_SVG" />
        <div>
          <h1>BlockCraft</h1>
          <div class="text-3 small">多世界 Minecraft 管理面板</div>
        </div>
      </div>
      <div class="field mb-3">
        <label class="field-label">访问令牌</label>
        <input
          v-model="token"
          class="input mono"
          type="password"
          placeholder="粘贴 panel.json 里的 token"
          @keyup.enter="doLogin"
        />
        <span class="field-hint">令牌在数据目录的 <code class="mono">panel.json</code> 里，也可以在设置页重置</span>
      </div>
      <div v-if="loginError" class="badge badge-danger mb-3">{{ loginError }}</div>
      <button class="btn btn-primary btn-block btn-lg" :disabled="loginBusy || !token" @click="doLogin">
        <span v-if="loginBusy" class="spinner" style="border-top-color: #fff" />
        进入面板
      </button>
      <p class="text-3 small mt-4 center">局域网内访问本机 IP 即可；公网访问需要配置 FRP</p>
    </div>
  </div>

  <template v-else>
    <header class="app-header">
      <div class="brand">
        <div class="brand-mark" v-html="BLOCK_ICON_SVG" />
        <span>BlockCraft</span>
      </div>
      <nav class="row gap-1 grow">
        <button class="btn btn-ghost btn-sm" :class="{ 'btn-soft': $route.name === 'overview' }" @click="router.push('/')">
          总览
        </button>
        <button class="btn btn-ghost btn-sm" :class="{ 'btn-soft': $route.name === 'wizard' }" @click="router.push('/new')">
          新建 / 导入
        </button>
        <button
          class="btn btn-ghost btn-sm"
          :class="{ 'btn-soft': $route.name === 'events' }"
          @click="router.push('/events')"
        >
          日志
        </button>
        <button
          class="btn btn-ghost btn-sm"
          :class="{ 'btn-soft': $route.name === 'settings' }"
          @click="router.push('/settings')"
        >
          设置
        </button>
      </nav>
      <div class="header-meta">
        <ThemeSwitcher />
        <span v-if="addresses[0]" class="hide-sm mono">{{ addresses[0].value }}</span>
        <span v-if="publicAddr" class="badge badge-accent hide-sm">公网已映射</span>
        <button class="btn btn-ghost btn-sm" @click="doLogout">退出</button>
      </div>
    </header>

    <router-view v-slot="{ Component }">
      <component :is="Component" />
    </router-view>

    <ToastHost />
  </template>
</template>
