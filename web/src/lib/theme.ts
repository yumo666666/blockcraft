import { ref } from 'vue';

export const THEME_CHOICES = [
  { id: 'white', label: '白色', shortLabel: '白色', description: '清爽明亮 · 柔和蓝灰', swatches: ['#f4f6f8', '#ffffff', '#47718b'] },
  { id: 'black', label: '黑色', shortLabel: '黑色', description: '深色低光 · 柔和绿光', swatches: ['#101411', '#1d2520', '#83c75e'] },
  { id: 'minecraft', label: 'Minecraft 绿', shortLabel: '方块绿', description: '草方块绿 · 温暖自然', swatches: ['#eaf0e4', '#fffef8', '#4b8732'] },
] as const;

export type ThemeId = (typeof THEME_CHOICES)[number]['id'];

const STORAGE_KEY = 'blockcraft.theme';
const THEME_COLORS: Record<ThemeId, string> = {
  white: '#f4f6f8',
  black: '#101411',
  minecraft: '#eaf0e4',
};

function isThemeId(value: string | null): value is ThemeId {
  return THEME_CHOICES.some((choice) => choice.id === value);
}

export function getTheme(): ThemeId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemeId(stored) ? stored : 'white';
  } catch {
    return 'white';
  }
}

export const activeTheme = ref<ThemeId>(getTheme());

function updateDocument(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'black' ? 'dark' : 'light';
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = THEME_COLORS[theme];
}

export function initializeTheme(): void {
  const theme = getTheme();
  activeTheme.value = theme;
  updateDocument(theme);
}

export function setTheme(theme: ThemeId): void {
  activeTheme.value = theme;
  updateDocument(theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The selected theme still applies for this page even when storage is unavailable.
  }
}
