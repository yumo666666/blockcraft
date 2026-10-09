<script setup lang="ts">
import { ref } from 'vue';
import { activeTheme, setTheme, THEME_CHOICES, type ThemeId } from '../lib/theme.ts';

const menu = ref<HTMLDetailsElement | null>(null);

function choose(theme: ThemeId): void {
  setTheme(theme);
  if (menu.value) menu.value.open = false;
}
</script>

<template>
  <details ref="menu" class="theme-switcher">
    <summary class="btn btn-ghost btn-sm theme-trigger" aria-label="切换主题" title="切换主题">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 2.3a7.7 7.7 0 1 0 0 15.4h1.1a2.1 2.1 0 0 0 1.4-3.7c-.6-.5-.2-1.5.6-1.5h1.1a3.5 3.5 0 0 0 3.5-3.5C17.7 5.3 14.2 2.3 10 2.3Z" />
        <circle cx="6.2" cy="9" r="1" />
        <circle cx="9.2" cy="5.9" r="1" />
        <circle cx="13.1" cy="6.4" r="1" />
      </svg>
      <span>主题</span>
    </summary>

    <div class="theme-popover" role="group" aria-label="选择面板主题">
      <div class="theme-popover-title">界面主题</div>
      <button
        v-for="theme in THEME_CHOICES"
        :key="theme.id"
        class="theme-choice"
        :class="{ active: activeTheme === theme.id }"
        type="button"
        :aria-pressed="activeTheme === theme.id"
        @click="choose(theme.id)"
      >
        <span class="theme-swatches" aria-hidden="true">
          <i v-for="color in theme.swatches" :key="color" :style="{ background: color }" />
        </span>
        <span class="theme-choice-copy">
          <strong>{{ theme.label }}</strong>
          <small>{{ theme.description }}</small>
        </span>
        <span v-if="activeTheme === theme.id" class="theme-check" aria-label="当前主题">✓</span>
      </button>
      <p class="theme-footnote">主题保存在当前浏览器</p>
    </div>
  </details>
</template>

<style scoped>
.theme-switcher { position: relative; flex: none; }
.theme-trigger { list-style: none; }
.theme-trigger::-webkit-details-marker { display: none; }
.theme-trigger svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.theme-trigger svg circle { fill: currentColor; stroke: none; }
.theme-switcher[open] .theme-trigger { color: var(--accent-hover); background: var(--accent-soft); }
.theme-popover {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: 120;
  width: min(286px, calc(100vw - 24px));
  padding: 9px;
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--surface);
  box-shadow: var(--sh-3);
}
.theme-popover-title { padding: 5px 8px 7px; color: var(--text-3); font-size: 11.5px; font-weight: 700; letter-spacing: 0.05em; }
.theme-choice {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 51px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.theme-choice:hover { background: var(--surface-2); }
.theme-choice.active { border-color: var(--accent-border); background: var(--accent-soft); }
.theme-swatches { display: flex; width: 36px; height: 24px; overflow: hidden; border: 1px solid var(--border); border-radius: 7px; }
.theme-swatches i { flex: 1; border-right: 1px solid rgba(80, 90, 90, 0.14); }
.theme-swatches i:last-child { border-right: 0; }
.theme-choice-copy { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.theme-choice-copy strong { font-size: 12.5px; line-height: 1.3; }
.theme-choice-copy small { overflow: hidden; color: var(--text-3); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.theme-check { color: var(--accent-hover); font-weight: 800; text-align: center; }
.theme-footnote { margin: 6px 8px 3px; color: var(--text-3); font-size: 11px; }
</style>
