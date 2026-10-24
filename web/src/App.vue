<script setup lang="ts">
import { BLOCK_ICON_SVG } from './lib/blockIcon.ts';
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { api, ApiError, setUnauthorizedHandler } from './lib/api.ts';
import { toast, toastError } from './lib/toast.ts';
import ToastHost from './components/ToastHost.vue';
import ThemeSwitcher from './components/ThemeSwitcher.vue';
import JobProgress from './components/JobProgress.vue';
import Icon from './components/Icon.vue';
import RoutePageSkeleton from './components/RoutePageSkeleton.vue';
import Modal from './components/Modal.vue';
import { backgroundJobId, setBackgroundJob } from './lib/backgroundJob.ts';
import { useWorlds } from './lib/worlds.ts';
import { clearBrowserSnapshots } from './lib/browserSnapshot.ts';
import { STATUS_TEXT, statusClass } from './lib/format.ts';
import type { InstanceSummary, Job } from './lib/types.ts';

const router = useRouter();
const route = useRoute();
type PendingNavigation = { fullPath: string; path: string; name: string | symbol | null | undefined; params: Record<string, unknown> };
const pendingNavigation = shallowRef<PendingNavigation | null>(null);
const navigationTarget = computed(() => pendingNavigation.value ?? route);
const ready = ref(false);
const authed = ref(false);
const token = ref('');
const loginBusy = ref(false);
const loginError = ref('');
const addresses = ref<{ label: string; value: string; kind: string }[]>([]);
const publicAddr = ref<string | null>(null);
const showBackgroundJob = ref(false);
const backgroundJob = ref<Job | null>(null);
const appVersion = ref('');
const showAbout = ref(false);
const mainEl = ref<HTMLElement | null>(null);

router.beforeEach((to) => {
  pendingNavigation.value = { fullPath: to.fullPath, path: to.path, name: to.name, params: to.params };
  if (mainEl.value) mainEl.value.scrollTop = 0;
});
router.afterEach((to, _from, failure) => {
  if (pendingNavigation.value?.fullPath === to.fullPath && (!failure || router.currentRoute.value.fullPath === to.fullPath)) pendingNavigation.value = null;
});
router.onError((_error, to) => {
  if (pendingNavigation.value?.fullPath === to.fullPath) pendingNavigation.value = null;
});

const SIDEBAR_KEY = 'blockcraft.sidebar.collapsed';
const sidebarCollapsed = ref(readSidebarCollapsed());
const mobileNavOpen = ref(false);
const mobileLayoutActive = ref(false);
const sidebarEl = ref<HTMLElement | null>(null);
const mobileNavTrigger = ref<HTMLButtonElement | null>(null);
let mobileLayoutQuery: MediaQueryList | null = null;

function closeMobileNav(restoreFocus = true): void {
  if (!mobileNavOpen.value) return;
  mobileNavOpen.value = false;
  if (restoreFocus) void nextTick(() => mobileNavTrigger.value?.focus());
}

function openMobileNav(event: MouseEvent): void {
  mobileNavTrigger.value = event.currentTarget as HTMLButtonElement;
  mobileNavOpen.value = true;
  void nextTick(() => {
    sidebarEl.value?.querySelector<HTMLElement>('a[href], button:not(:disabled)')?.focus();
  });
}

function updateMobileLayout(event?: MediaQueryListEvent): void {
  mobileLayoutActive.value = event?.matches ?? mobileLayoutQuery?.matches ?? false;
  if (!mobileLayoutActive.value) closeMobileNav(false);
}

function onMobileNavKeydown(event: KeyboardEvent): void {
  if (!mobileLayoutActive.value || !mobileNavOpen.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMobileNav();
    return;
  }
  if (event.key !== 'Tab' || !sidebarEl.value) return;

  const focusable = Array.from(
    sidebarEl.value.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not([type="hidden"]):not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) {
    event.preventDefault();
    sidebarEl.value.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !sidebarEl.value.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !sidebarEl.value.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  try {
    window.localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed.value ? '1' : '0');
  } catch {
    // The state still applies for this page.
  }
}

function openAbout(): void {
  if (mobileNavOpen.value) {
    closeMobileNav();
    void nextTick(() => { showAbout.value = true; });
    return;
  }
  showAbout.value = true;
}

const worldId = computed(() => {
  const id = navigationTarget.value.params.id;
  return typeof id === 'string' && id ? id : null;
});

const {
  instances: worlds,
  worldsReady,
  acquireWorlds,
  releaseWorlds,
  resetWorlds,
  refreshWorlds,
} = useWorlds();

/** 当前世界只由 /w/:id 决定；总览本身不再承载世界详情。 */
const currentWorldId = worldId;
const currentWorld = computed(() => worlds.value.find((world) => world.id === currentWorldId.value) ?? null);
const isWorldActive = (id: string): boolean => currentWorldId.value === id;
const worldStatusTitle = (world: InstanceSummary): string =>
  `${world.name} · ${STATUS_TEXT[world.status] ?? world.status}`;

const navGroups = computed(() => [
  {
    label: '工作台',
    items: [
      { label: '总览', to: '/', icon: 'overview', active: navigationTarget.value.name === 'overview' },
      { label: '事件日志', to: '/events', icon: 'events', active: navigationTarget.value.name === 'events' },
      { label: '文件管理', to: '/files', icon: 'folder', active: navigationTarget.value.name === 'files' },
      { label: '相关网站', to: '/new', icon: 'globe', active: navigationTarget.value.name === 'websites' },
    ],
  },
]);

const worldNav = computed(() => {
  if (!currentWorldId.value) return [];
  const id = currentWorldId.value;
  return [
    { label: '世界详情', to: `/w/${id}`, icon: 'server', active: navigationTarget.value.name === 'world' },
    { label: '控制台', to: `/w/${id}/console`, icon: 'console', active: navigationTarget.value.name === 'console' },
    { label: '备份与回退', to: `/w/${id}/backups`, icon: 'backups', active: navigationTarget.value.name === 'backups' },
    { label: 'MOD 管理', to: `/w/${id}/mods`, icon: 'mods', active: navigationTarget.value.name === 'mods' },
    { label: '玩家管理', to: `/w/${id}/players`, icon: 'players', active: navigationTarget.value.name === 'players' },
  ];
});

const worldImportInput = ref<HTMLInputElement | null>(null);
const importingWorld = ref(false);

function chooseWorldImport(): void {
  if (!importingWorld.value) worldImportInput.value?.click();
}

async function importWorld(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.zip')) {
    toast('error', '世界导入失败', '请选择 BlockCraft 导出的完整世界 ZIP 文件');
    input.value = '';
    return;
  }
  if (file.size > 20 * 1024 * 1024 * 1024) {
    toast('error', '世界导入失败', '单个世界 ZIP 不能超过 20 GB');
    input.value = '';
    return;
  }
  importingWorld.value = true;
  try {
    const result = await api.uploadFile<{ ok: boolean; instance: InstanceSummary }>('/api/instances/import', file);
    await refreshWorlds();
    toast('ok', '世界导入完成', `「${result.instance.name}」已导入并保持停止状态`);
    void router.push(`/w/${result.instance.id}`);
  } catch (err) {
    toastError(err, '世界导入失败');
  } finally {
    importingWorld.value = false;
    input.value = '';
  }
}

const crumbTitle = computed(() => {
  switch (navigationTarget.value.name) {
    case 'overview':
      return '总览';
    case 'events':
      return '事件日志';
    case 'websites':
      return '相关网站';
    case 'wizard-create':
      return '新建世界';
    case 'wizard-import':
      return '导入整合包';
    case 'settings':
      return '面板设置';
    case 'world':
      return '世界详情';
    case 'console':
      return '控制台';
    case 'backups':
      return '备份与回退';
    case 'files':
      return '文件管理';
    case 'mods':
      return 'MOD 管理';
    case 'players':
      return '玩家管理';
    case 'performance-detail':
      return '实时性能';
    default:
      return '总览';
  }
});

const crumbSection = computed(() => {
  if (['overview', 'events', 'websites', 'files'].includes(String(navigationTarget.value.name))) return '工作台';
  return currentWorldId.value ? '世界' : '控制台';
});
const showWorldCrumb = computed(() => navigationTarget.value.name !== 'overview' && Boolean(currentWorldId.value));

const backgroundJobLabel = computed(() => {
  if (!backgroundJobId.value) return '';
  if (!backgroundJob.value) return '后台任务';
  return backgroundJob.value.status === 'running' ? '任务进行中' : '查看任务结果';
});

let worldsHeld = false;
watch(
  authed,
  (loggedIn) => {
    if (loggedIn && !worldsHeld) {
      acquireWorlds();
      worldsHeld = true;
    } else if (!loggedIn && worldsHeld) {
      worldsHeld = false;
      releaseWorlds();
      resetWorlds();
    }
  },
  { immediate: true },
);

watch(() => route.path, () => {
  closeMobileNav(false);
  if (mainEl.value) mainEl.value.scrollTop = 0;
  void nextTick(() => mainEl.value?.focus({ preventScroll: true }));
});
watch(() => route.query, () => {
  closeMobileNav();
});

watch(() => [authed.value, backgroundJobId.value] as const, ([loggedIn, id], _old, onCleanup) => {
  backgroundJob.value = null;
  if (!loggedIn || !id) return;
  let active = true;
  const refresh = async () => {
    try {
      const job = await api.get<Job>(`/api/jobs/${encodeURIComponent(id)}`);
      if (active) backgroundJob.value = job;
    } catch {
      // Keep the recovery button visible if the server is briefly reconnecting.
    }
  };
  void refresh();
  const timer = window.setInterval(refresh, 3000);
  onCleanup(() => {
    active = false;
    window.clearInterval(timer);
  });
});

async function loadShell() {
  const res = await api.get<{ config: { panel: { port: number } }; addresses: { label: string; value: string; kind: string }[] }>(
    '/api/panel',
  );
  addresses.value = res.addresses;
}

async function loadVersion() {
  try {
    const ping = await api.get<{ version: string }>('/api/ping');
    appVersion.value = ping.version ?? '';
  } catch {
    appVersion.value = '';
  }
}

async function checkAuth() {
  try {
    await loadShell();
    authed.value = true;
  } catch (err) {
    authed.value = false;
    if (err instanceof ApiError && err.code === 'UNAUTHORIZED') clearBrowserSnapshots();
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

onMounted(() => {
  mobileLayoutQuery = window.matchMedia('(max-width: 1024px)');
  updateMobileLayout();
  mobileLayoutQuery.addEventListener('change', updateMobileLayout);
  document.addEventListener('keydown', onMobileNavKeydown);
  void checkAuth();
  void loadVersion();
});

onUnmounted(() => {
  mobileLayoutQuery?.removeEventListener('change', updateMobileLayout);
  document.removeEventListener('keydown', onMobileNavKeydown);
});

async function refreshPublic() {
  try {
    const st = await api.get<{ panelProxy: { remotePort: number } | null; server: { addr: string } }>('/api/frp/status');
    publicAddr.value = st.panelProxy && st.server.addr ? `http://${st.server.addr}:${st.panelProxy.remotePort}` : null;
  } catch {
    publicAddr.value = null;
  }
}
onMounted(refreshPublic);
</script>

<template>
  <div v-if="!ready" class="login-wrap">
    <div class="spinner" />
  </div>

  <div v-else-if="!authed" class="login-wrap">
    <div class="login-card">
      <div class="login-brand">
        <div class="brand-mark" aria-hidden="true" v-html="BLOCK_ICON_SVG" />
        <div>
          <div class="login-title">BlockCraft</div>
          <div class="login-sub">多世界 Minecraft 管理面板</div>
        </div>
      </div>

      <p class="login-lede">把每个世界都收进一个面板：启动、配置、备份、玩家与 MOD。</p>

      <div class="field mb-3">
        <label class="field-label" for="access-token">访问令牌</label>
        <input
          id="access-token"
          v-model="token"
          class="input mono"
          type="password"
          placeholder="粘贴 panel.json 里的 token"
          autocomplete="current-password"
          :aria-describedby="loginError ? 'access-token-hint login-error' : 'access-token-hint'"
          :aria-invalid="loginError ? 'true' : undefined"
          @keyup.enter="doLogin"
          @input="loginError = ''"
        />
        <span id="access-token-hint" class="field-hint">令牌在数据目录的 <code class="mono">panel.json</code> 里，也可以在设置页重置</span>
      </div>
      <div v-if="loginError" id="login-error" class="login-error" role="alert">{{ loginError }}</div>
      <button class="btn btn-primary btn-block btn-lg" :disabled="loginBusy || !token" @click="doLogin">
        <span v-if="loginBusy" class="spinner spinner-on-accent" />
        {{ loginBusy ? '正在验证…' : '进入面板' }}
      </button>
      <p class="login-foot">
        局域网内访问本机 IP 即可；公网访问需要配置 FRP。<br />
        界面风格致敬
        <a href="https://github.com/AlkaidLab/foundation-sunshine" target="_blank" rel="noopener noreferrer">Foundation Sunshine</a>
      </p>
    </div>
  </div>

  <div v-else class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <a class="skip-link" href="#main-content">跳到主内容</a>
    <div class="sidebar-scrim" :class="{ show: mobileNavOpen }" aria-hidden="true" @click="closeMobileNav()" />

    <aside
      id="primary-navigation"
      ref="sidebarEl"
      class="sidebar"
      :class="{ open: mobileNavOpen }"
      :role="mobileLayoutActive && mobileNavOpen ? 'dialog' : undefined"
      :aria-modal="mobileLayoutActive && mobileNavOpen ? 'true' : undefined"
      :aria-hidden="mobileLayoutActive && !mobileNavOpen ? 'true' : undefined"
      :inert="mobileLayoutActive && !mobileNavOpen"
      aria-label="主导航"
      tabindex="-1"
    >
      <div class="sidebar-head">
        <RouterLink to="/" class="brand-mark" aria-label="返回总览">
          <span class="brand-mark-inner" v-html="BLOCK_ICON_SVG" />
        </RouterLink>
        <div class="brand-copy">
          <span class="brand-name">BlockCraft</span>
          <span class="brand-sub">Minecraft Panel</span>
        </div>
        <button
          type="button"
          class="sidebar-collapse"
          :title="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          :aria-label="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          @click="toggleSidebar"
        >
          <Icon :name="sidebarCollapsed ? 'chevron-right' : 'chevron-left'" :size="16" />
        </button>
        <button type="button" class="sidebar-close icon-btn" aria-label="关闭导航" @click="closeMobileNav()">
          <Icon name="close" :size="17" />
        </button>
      </div>

      <div class="sidebar-scroll">
        <nav v-for="group in navGroups" :key="group.label" class="nav-group" :aria-label="group.label">
          <p class="nav-label">{{ group.label }}</p>
          <RouterLink
            v-for="item in group.items"
            :key="item.label"
            :to="item.to"
            class="nav-item"
            :class="{ active: item.active }"
            :aria-current="item.active ? 'page' : undefined"
            :title="item.label"
            @click="closeMobileNav()"
          >
            <Icon :name="item.icon" :size="18" />
            <span>{{ item.label }}</span>
          </RouterLink>
        </nav>

        <nav class="nav-group world-list-group" aria-label="我的世界">
          <p class="nav-label">
            <span>我的世界</span>
            <span v-if="worlds.length" class="nav-label-count">{{ worlds.length }}</span>
          </p>

          <RouterLink
            v-for="world in worlds"
            :key="world.id"
            :to="`/w/${world.id}`"
            class="nav-item world-item"
            :class="{ active: isWorldActive(world.id) }"
            :aria-current="isWorldActive(world.id) ? 'page' : undefined"
            :title="worldStatusTitle(world)"
            @click="closeMobileNav()"
          >
            <i class="dot world-dot" :class="statusClass(world.status)" aria-hidden="true" />
            <span class="ellipsis">{{ world.name }}</span>
          </RouterLink>

          <RouterLink
            v-if="worldsReady && !worlds.length"
            to="/create"
            class="nav-item world-empty-row"
            title="新建世界"
            @click="closeMobileNav()"
          >
            <Icon name="plus" :size="18" />
            <span>还没有世界，先新建一个</span>
          </RouterLink>

          <div class="world-actions">
            <RouterLink
              to="/create"
              class="nav-item nav-subtle"
              :class="{ active: navigationTarget.name === 'wizard-create' }"
              title="新建世界"
              @click="closeMobileNav()"
            >
              <Icon name="plus" :size="17" />
              <span>新建世界</span>
            </RouterLink>
            <RouterLink
              to="/import"
              class="nav-item nav-subtle"
              :class="{ active: navigationTarget.name === 'wizard-import' }"
              title="导入整合包"
              @click="closeMobileNav()"
            >
              <Icon name="package" :size="17" />
              <span>导入整合包</span>
            </RouterLink>
            <button
              type="button"
              class="nav-item nav-subtle"
              title="导入 BlockCraft 导出的世界 ZIP"
              :disabled="importingWorld"
              @click="closeMobileNav(); chooseWorldImport()"
            >
              <i v-if="importingWorld" class="spinner" style="width: 15px; height: 15px" />
              <Icon v-else name="upload" :size="17" />
              <span>{{ importingWorld ? '正在导入…' : '导入世界' }}</span>
            </button>
          </div>
          <input ref="worldImportInput" type="file" accept=".zip,application/zip" hidden @change="importWorld" />
        </nav>

        <nav v-if="currentWorldId" class="nav-group" aria-label="当前世界">
          <p class="nav-label">当前世界</p>
          <RouterLink
            v-for="item in worldNav"
            :key="item.to"
            :to="item.to"
            class="nav-item"
            :class="{ active: item.active }"
            :aria-current="item.active ? 'page' : undefined"
            :title="item.label"
            @click="closeMobileNav()"
          >
            <Icon :name="item.icon" :size="18" />
            <span>{{ item.label }}</span>
          </RouterLink>
        </nav>
      </div>

      <div class="sidebar-foot">
        <RouterLink
          to="/settings"
          class="nav-item"
          :class="{ active: navigationTarget.name === 'settings' }"
          :aria-current="navigationTarget.name === 'settings' ? 'page' : undefined"
          title="面板设置"
          @click="closeMobileNav()"
        >
          <Icon name="settings" :size="18" />
          <span>面板设置</span>
        </RouterLink>
        <button type="button" class="nav-item" title="帮助与关于" @click="openAbout">
          <Icon name="help" :size="18" />
          <span>帮助与关于</span>
        </button>
        <div class="sidebar-note">
          <span>{{ appVersion ? `v${appVersion}` : 'BlockCraft' }}</span>
          <span>多世界控制台</span>
        </div>
      </div>
    </aside>

    <main id="main-content" ref="mainEl" class="main" :class="{ 'main-world': navigationTarget.path.startsWith('/w/') }" tabindex="-1">
      <header class="topbar">
        <div class="topbar-left">
          <button
            type="button"
            class="icon-btn menu-btn"
            aria-label="打开导航"
            aria-controls="primary-navigation"
            :aria-expanded="mobileNavOpen"
            @click="openMobileNav"
          >
            <Icon name="menu" :size="18" />
          </button>
          <div class="crumbs">
            <span class="crumb-parent">{{ crumbSection }}</span>
            <span class="sep">/</span>
            <template v-if="showWorldCrumb">
              <span class="mono ellipsis crumb-world-id" :title="currentWorldId ?? undefined">{{ currentWorld?.name ?? currentWorldId }}</span>
              <span class="sep">/</span>
            </template>
            <b>{{ crumbTitle }}</b>
          </div>
        </div>

        <div class="topbar-right">
          <button v-if="backgroundJobId" type="button" class="topbar-chip job-chip" @click="showBackgroundJob = true">
            <span v-if="backgroundJob?.status === 'running'" class="spinner" style="width: 12px; height: 12px" />
            {{ backgroundJobLabel }}
          </button>
          <span v-if="publicAddr" class="badge badge-accent hide-sm" :title="publicAddr">公网已映射</span>
          <span v-if="addresses[0]" class="topbar-chip addr-chip mono">{{ addresses[0].value }}</span>
          <ThemeSwitcher />
          <button type="button" class="icon-btn" title="退出登录" aria-label="退出登录" @click="doLogout">
            <Icon name="logout" :size="17" />
          </button>
        </div>
      </header>

      <RoutePageSkeleton v-if="pendingNavigation" :name="String(navigationTarget.name ?? '')" :label="crumbTitle" />
      <router-view v-else v-slot="{ Component }">
        <!-- World pages own polling and SSE subscriptions; unmount them on route exit so a deleted world cannot keep polling in the background. -->
        <KeepAlive :include="['Overview', 'Wizard', 'MinecraftSites', 'Events', 'Settings']" :max="16">
          <component :is="Component" />
        </KeepAlive>
      </router-view>

      <ToastHost />
      <JobProgress
        :open="showBackgroundJob"
        :job-id="backgroundJobId"
        @background="showBackgroundJob = false"
        @close="((showBackgroundJob = false), setBackgroundJob(null))"
      />

      <Modal v-if="showAbout" title="帮助与关于" size="sm" @close="showAbout = false">
        <div class="about-brand">
          <div class="brand-mark" aria-hidden="true" v-html="BLOCK_ICON_SVG" />
          <div>
            <strong>BlockCraft {{ appVersion ? `v${appVersion}` : '' }}</strong>
            <p class="text-3 small">多世界 Minecraft 服务端管理面板</p>
          </div>
        </div>
        <p class="about-text">
          在一个网页里创建和管理多个独立世界：导入整合包、配置加载器、管理 MOD 与玩家、备份迁移存档，并可用 FRP 提供远程访问。
        </p>
        <div class="about-rows">
          <a class="about-row" href="https://github.com/yumo666666/blockcraft" target="_blank" rel="noopener noreferrer">
            <span class="row gap-2"><Icon name="package" :size="15" /> 项目主页</span>
            <Icon name="external" :size="14" />
          </a>
          <a class="about-row" href="https://github.com/yumo666666/blockcraft/blob/main/docs/PROJECT_GUIDE.md" target="_blank" rel="noopener noreferrer">
            <span class="row gap-2"><Icon name="events" :size="15" /> 使用手册</span>
            <Icon name="external" :size="14" />
          </a>
          <a class="about-row" href="https://github.com/AlkaidLab/foundation-sunshine" target="_blank" rel="noopener noreferrer">
            <span class="row gap-2"><Icon name="palette" :size="15" /> 界面风格：Foundation Sunshine</span>
            <Icon name="external" :size="14" />
          </a>
        </div>
        <p class="about-credit">界面视觉语言致敬 AlkaidLab 的 Foundation Sunshine 控制台，使用自绘壁纸与独立实现。</p>
        <template #footer>
          <button class="btn" @click="showAbout = false">关闭</button>
        </template>
      </Modal>
    </main>
  </div>
</template>

<style scoped>
.login-lede {
  margin: 0 0 20px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.65;
}
.login-error {
  margin-bottom: 12px;
  padding: 8px 11px;
  border: 1px solid var(--danger-border);
  border-radius: var(--r-sm);
  background: var(--danger-soft);
  color: var(--danger-text);
  font-size: 12.5px;
}

.job-chip { cursor: pointer; color: var(--text); }
.job-chip:hover { border-color: var(--border-strong); background: var(--surface-3); }

.about-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.about-brand strong { display: block; font-size: 15px; }
.about-brand p { margin-top: 2px; }
.about-text { color: var(--text-2); font-size: 13px; line-height: 1.65; }
.about-rows { display: flex; flex-direction: column; gap: 7px; margin-top: 16px; }
.about-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12.5px;
  text-decoration: none;
}
.about-row:hover { border-color: var(--border-strong); background: var(--surface-3); color: var(--text); text-decoration: none; }
.about-credit { margin-top: 14px; color: var(--text-3); font-size: 11px; line-height: 1.6; }
</style>
