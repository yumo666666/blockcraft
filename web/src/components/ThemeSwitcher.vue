<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from './Icon.vue';
import { activeTheme, setTheme, themeMode, THEME_CHOICES, type ThemeMode } from '../lib/theme.ts';

const router = useRouter();
const menu = ref<HTMLDetailsElement | null>(null);

function choose(mode: ThemeMode): void {
  setTheme(mode);
  if (menu.value) menu.value.open = false;
}

function openSettings(): void {
  if (menu.value) menu.value.open = false;
  void router.push('/settings');
}

function onPointerDown(event: PointerEvent): void {
  if (!menu.value?.open) return;
  if (!menu.value.contains(event.target as Node)) menu.value.open = false;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && menu.value?.open) menu.value.open = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', onPointerDown);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <details ref="menu" class="theme-switcher">
    <summary class="icon-btn theme-trigger" aria-label="外观与主题" title="外观与主题">
      <Icon :name="activeTheme === 'dark' ? 'moon' : 'sun'" :size="17" />
    </summary>

    <div class="theme-popover" role="group" aria-label="选择界面主题">
      <div class="theme-popover-head">
        <strong>外观</strong>
        <span>{{ activeTheme === 'dark' ? '暮色' : '日光' }}<template v-if="themeMode === 'system'"> · 跟随系统</template></span>
      </div>

      <button
        v-for="theme in THEME_CHOICES"
        :key="theme.id"
        type="button"
        class="theme-choice"
        :class="{ active: themeMode === theme.id }"
        :aria-pressed="themeMode === theme.id"
        @click="choose(theme.id)"
      >
        <span class="theme-swatches" aria-hidden="true">
          <i v-for="color in theme.swatches" :key="color" :style="{ background: color }" />
        </span>
        <span class="theme-choice-copy">
          <strong>{{ theme.label }}</strong>
          <small>{{ theme.description }}</small>
        </span>
        <Icon v-if="themeMode === theme.id" class="theme-check" name="check" :size="15" />
      </button>

      <button type="button" class="theme-more" @click="openSettings">
        背景壁纸与更多外观设置
        <Icon name="chevron-right" :size="14" />
      </button>
    </div>
  </details>
</template>

<style scoped>
.theme-switcher { position: relative; flex: none; }
.theme-trigger { list-style: none; }
.theme-trigger::-webkit-details-marker { display: none; }
.theme-trigger svg { transition: transform 0.2s var(--ease); }
.theme-switcher[open] .theme-trigger { border-color: var(--border); background: var(--surface-3); color: var(--accent); }

.theme-popover {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: 120;
  width: min(296px, calc(100vw - 24px));
  padding: 9px;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background: linear-gradient(160deg, color-mix(in srgb, var(--surface-solid) 93%, #fff 7%), var(--surface-solid));
  box-shadow: var(--sh-3);
  backdrop-filter: blur(26px) saturate(150%);
  -webkit-backdrop-filter: blur(26px) saturate(150%);
}

.theme-popover-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 9px 8px;
}
.theme-popover-head strong { font-size: 13px; font-weight: 650; }
.theme-popover-head span { color: var(--text-3); font-size: 11px; }

.theme-choice {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 52px;
  padding: 6px 9px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.theme-choice:hover { background: var(--surface-2); }
.theme-choice.active { border-color: var(--accent-border); background: var(--accent-soft); }

.theme-swatches {
  display: flex;
  width: 38px;
  height: 26px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.theme-swatches i { flex: 1; }
.theme-choice-copy { display: flex; min-width: 0; flex-direction: column; gap: 1px; }
.theme-choice-copy strong { font-size: 12.5px; line-height: 1.35; font-weight: 600; }
.theme-choice-copy small { overflow: hidden; color: var(--text-3); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.theme-check { color: var(--accent); }

.theme-more {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  margin-top: 6px;
  padding: 8px 9px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-2);
  color: var(--text-2);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.theme-more:hover { border-color: var(--border-strong); color: var(--text); }
</style>
