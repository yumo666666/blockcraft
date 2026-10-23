import { ref } from 'vue';

/**
 * 主题模型：界面只区分「日光 / 暮色 / 跟随系统」。
 * 具体的色板写在 styles/base.css 的 [data-theme='light'|'dark'] 里，
 * 这里负责把用户选择解析成最终生效的 data-theme。
 */
export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_CHOICES = [
  {
    id: 'light',
    label: '日光',
    shortLabel: '日光',
    description: '清透玻璃 · 海盐蓝',
    swatches: ['#a9d1fb', '#e8f3ff', '#4a9eff'],
  },
  {
    id: 'dark',
    label: '暮色',
    shortLabel: '暮色',
    description: '夜色玻璃 · 莫兰迪粉',
    swatches: ['#241b27', '#4a3f45', '#d8a9ab'],
  },
  {
    id: 'system',
    label: '跟随系统',
    shortLabel: '自动',
    description: '随系统深色偏好切换',
    swatches: ['#a9d1fb', '#241b27', '#4a9eff'],
  },
] as const satisfies readonly { id: ThemeMode; label: string; shortLabel: string; description: string; swatches: readonly string[] }[];

const STORAGE_KEY = 'blockcraft.theme';
const LEGACY_MAP: Record<string, ThemeMode> = {
  white: 'light',
  black: 'dark',
  minecraft: 'light',
};

const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#a9d1fb',
  dark: '#241b27',
};

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function getThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isThemeMode(stored)) return stored;
    if (stored && LEGACY_MAP[stored]) return LEGACY_MAP[stored];
  } catch {
    // Storage can be disabled; the OS preference still drives the theme.
  }
  return 'system';
}

function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? systemTheme() : mode;
}

/** 用户选择（light / dark / system） */
export const themeMode = ref<ThemeMode>(getThemeMode());
/** 当前真正生效的色板 */
export const activeTheme = ref<ResolvedTheme>(resolveTheme(themeMode.value));

let watchingSystem = false;

function updateDocument(mode: ThemeMode): void {
  const resolved = resolveTheme(mode);
  activeTheme.value = resolved;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeMode = mode;
  root.style.colorScheme = resolved;
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = THEME_COLORS[resolved];
}

function watchSystemPreference(): void {
  if (watchingSystem) return;
  watchingSystem = true;
  try {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (themeMode.value === 'system') updateDocument('system');
    };
    if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
    else query.addListener(onChange);
  } catch {
    // Old browsers: a manual choice still works.
  }
}

export function initializeTheme(): void {
  const mode = getThemeMode();
  themeMode.value = mode;
  updateDocument(mode);
  // Persist the normalised value so legacy theme ids disappear after one visit.
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage can be disabled; the resolved theme still applies.
  }
  watchSystemPreference();
}

export function setTheme(mode: ThemeMode): void {
  themeMode.value = mode;
  updateDocument(mode);
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // The selected theme still applies for this page even when storage is unavailable.
  }
}
