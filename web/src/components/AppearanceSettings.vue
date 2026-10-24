<script setup lang="ts">
import { ref } from 'vue';
import Icon from './Icon.vue';
import { toast } from '../lib/toast.ts';
import { activeTheme, setTheme, themeMode, THEME_CHOICES, type ThemeMode } from '../lib/theme.ts';
import { customBackground, resetBackground, uploadBackground } from '../lib/background.ts';

const fileInput = ref<HTMLInputElement | null>(null);
const busy = ref(false);

const defaultPreview = () => (activeTheme.value === 'dark' ? '/bg/dusk.svg' : '/bg/day.svg');

function miniStyle(theme: (typeof THEME_CHOICES)[number]): Record<string, string> {
  return {
    '--mini-bg': theme.swatches[0],
    '--mini-surface': theme.swatches[1],
    '--mini-accent': theme.swatches[2],
  };
}

function pickBackground(): void {
  if (!busy.value) fileInput.value?.click();
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  busy.value = true;
  try {
    await uploadBackground(file);
    toast('ok', '背景已更新', '壁纸只保存在当前浏览器，换设备不会同步');
  } catch (error) {
    toast('error', '背景更新失败', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
    input.value = '';
  }
}

function restoreDefault(): void {
  resetBackground();
  toast('ok', '已恢复默认背景', '默认壁纸会随日光 / 暮色主题切换');
}

function chooseTheme(mode: ThemeMode): void {
  setTheme(mode);
}
</script>

<template>
  <section class="card settings-appearance">
    <div class="card-head">
      <h3><Icon name="palette" :size="16" /> 外观</h3>
      <span class="text-3 small">保存在当前浏览器</span>
    </div>
    <div class="card-body appearance-grid">
      <div class="field">
        <span class="field-label">界面主题</span>
        <div class="theme-cards" role="radiogroup" aria-label="界面主题">
          <button
            v-for="theme in THEME_CHOICES"
            :key="theme.id"
            type="button"
            class="theme-card"
            :class="{ active: themeMode === theme.id }"
            role="radio"
            :aria-checked="themeMode === theme.id"
            @click="chooseTheme(theme.id)"
          >
            <span class="theme-card-preview" :class="`theme-card-preview-${theme.id}`" :style="miniStyle(theme)" aria-hidden="true">
              <span class="mini-accent" />
            </span>
            <span class="theme-card-copy">
              <strong>
                {{ theme.label }}
                <Icon v-if="themeMode === theme.id" class="theme-card-check" name="check" :size="13" />
                <span v-if="theme.id === 'system'" class="badge badge-outline">{{ activeTheme === 'dark' ? '暮色' : '日光' }}</span>
              </strong>
              <small>{{ theme.description }}</small>
            </span>
          </button>
        </div>
      </div>

      <div class="field">
        <span class="field-label">背景壁纸</span>
        <div class="wallpaper-row">
          <div
            class="wallpaper-thumb"
            :style="{ backgroundImage: `url('${customBackground ?? defaultPreview()}')` }"
            role="img"
            aria-label="当前背景预览"
          >
            <span v-if="!customBackground" class="wallpaper-tag">默认</span>
            <span v-else class="wallpaper-tag">自定义</span>
          </div>
          <div class="col gap-2 grow">
            <div class="row gap-2 wrap">
              <button class="btn btn-sm" :disabled="busy" @click="pickBackground">
                <span v-if="busy" class="spinner" />
                <Icon v-else name="upload" :size="15" />
                {{ busy ? '正在处理…' : '上传图片' }}
              </button>
              <button v-if="customBackground" class="btn btn-sm btn-ghost" @click="restoreDefault">
                <Icon name="undo" :size="15" /> 恢复默认
              </button>
            </div>
            <p class="field-hint">
              JPG / PNG / WebP，建议 1920×1080。图片会压缩后只保存在本浏览器，不会上传到服务端。
            </p>
          </div>
        </div>
        <input ref="fileInput" type="file" accept="image/*" hidden @change="onFileChange" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings-appearance { min-width: 0; }
.appearance-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.75fr) minmax(250px, 1fr);
  gap: 22px;
  align-items: start;
}
.theme-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.theme-card {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
  padding: 9px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.16s, background 0.16s, transform 0.16s, box-shadow 0.16s;
}
.theme-card:hover { border-color: var(--border-strong); transform: translateY(-1px); }
.theme-card.active { border-color: var(--accent-border); background: var(--accent-soft); box-shadow: var(--sh-1); }

.theme-card-preview {
  position: relative;
  display: block;
  height: 54px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--mini-surface) 60%, transparent) 0 26px, transparent 26px),
    linear-gradient(150deg, var(--mini-bg), var(--mini-surface));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.theme-card-preview::before {
  content: '';
  position: absolute;
  top: 10px;
  left: 34px;
  right: 9px;
  height: 12px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--mini-surface) 78%, transparent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3);
}
.theme-card-preview::after {
  content: '';
  position: absolute;
  top: 28px;
  left: 34px;
  right: 9px;
  height: 16px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--mini-surface) 52%, transparent);
}
.mini-accent {
  position: absolute;
  left: 9px;
  bottom: 9px;
  width: 10px;
  height: 10px;
  border-radius: 3px;
  background: var(--mini-accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--mini-accent) 60%, transparent);
}
.theme-card-preview-system {
  background:
    linear-gradient(90deg, color-mix(in srgb, #cfe6ff 82%, transparent) 0 50%, color-mix(in srgb, #3a2c35 88%, transparent) 50% 100%);
}
.theme-card-preview-system::before {
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.82) 0 50%, rgba(30, 22, 33, 0.72) 50% 100%);
}
.theme-card-preview-system::after {
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.55) 0 50%, rgba(30, 22, 33, 0.5) 50% 100%);
}
.theme-card-copy { display: flex; min-width: 0; flex-direction: column; gap: 1px; }
.theme-card-copy strong { display: flex; align-items: center; gap: 5px; font-size: 12.5px; font-weight: 650; }
.theme-card-copy strong .badge { height: 17px; padding: 0 5px; font-size: 9.5px; }
.theme-card-copy small { overflow: hidden; color: var(--text-3); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.theme-card-check { color: var(--accent-text); }

.wallpaper-row { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.wallpaper-thumb {
  position: relative;
  flex: none;
  width: 116px;
  height: 72px;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background-color: var(--surface-2);
  background-position: center;
  background-size: cover;
  box-shadow: var(--sh-1);
}
.wallpaper-tag {
  position: absolute;
  left: 6px;
  bottom: 6px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(20, 18, 24, 0.55);
  color: #f4f7fb;
  font-size: 9.5px;
  font-weight: 600;
  backdrop-filter: blur(6px);
}
.wallpaper-row .field-hint { max-width: 34rem; line-height: 1.55; }

@media (max-width: 1024px) {
  .appearance-grid { grid-template-columns: minmax(0, 1fr); gap: 18px; }
}
@media (max-width: 620px) {
  .theme-cards { grid-template-columns: minmax(0, 1fr); }
  .theme-card { flex-direction: row; align-items: center; }
  .theme-card-preview { width: 88px; flex: none; }
  .wallpaper-row { flex-direction: column; }
  .wallpaper-thumb { width: 100%; height: 96px; }
}
</style>
