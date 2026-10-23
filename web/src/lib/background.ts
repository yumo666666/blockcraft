import { computed, ref } from 'vue';

/**
 * 壁纸：默认壁纸随主题切换（日光 / 暮色），用户也可以在设置里上传自己的图。
 * 自定义壁纸压成 JPEG 后保存在 localStorage，不经过服务端，换浏览器就没了。
 */
const STORAGE_KEY = 'blockcraft.background';
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1200;
const MAX_BYTES = 3.4 * 1024 * 1024;

export const DEFAULT_WALLPAPERS = {
  light: '/bg/day.svg',
  dark: '/bg/dusk.svg',
} as const;

function readStored(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && value.startsWith('data:image/') ? value : null;
  } catch {
    return null;
  }
}

export const customBackground = ref<string | null>(readStored());
export const usingCustomBackground = computed(() => Boolean(customBackground.value));

function applyBackground(): void {
  const root = document.documentElement;
  if (customBackground.value) {
    root.style.setProperty('--wallpaper', `url("${customBackground.value}")`);
    root.dataset.wallpaper = 'custom';
  } else {
    root.style.removeProperty('--wallpaper');
    root.dataset.wallpaper = 'default';
  }
}

export function initializeBackground(): void {
  applyBackground();
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('这张图片无法读取，换一张试试'));
    };
    img.src = url;
  });
}

function encode(img: HTMLImageElement, quality: number): string {
  const ratio = Math.min(1, MAX_WIDTH / img.naturalWidth, MAX_HEIGHT / img.naturalHeight);
  const width = Math.max(1, Math.round(img.naturalWidth * ratio));
  const height = Math.max(1, Math.round(img.naturalHeight * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器不支持处理图片');
  context.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

function persist(dataUrl: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, dataUrl);
  } catch (error) {
    // Quota exceeded: drop the old value before surfacing the failure, otherwise
    // the stored background and the in-memory one drift apart.
    window.localStorage.removeItem(STORAGE_KEY);
    if (error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22)) {
      throw new Error('图片太大，压缩后仍然超出浏览器存储空间，请换一张更小的图片');
    }
    throw new Error('浏览器禁止写入本地存储，无法保存背景');
  }
}

export async function uploadBackground(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件（JPG / PNG / WebP）');
  if (file.size > 25 * 1024 * 1024) throw new Error('图片不能超过 25 MB');
  const img = await loadImage(file);
  let quality = 0.86;
  let dataUrl = encode(img, quality);
  while (dataUrl.length * 0.75 > MAX_BYTES && quality > 0.45) {
    quality -= 0.12;
    dataUrl = encode(img, quality);
  }
  persist(dataUrl);
  customBackground.value = dataUrl;
  applyBackground();
}

export function resetBackground(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore: the in-memory reset below is still useful for this page.
  }
  customBackground.value = null;
  applyBackground();
}

export function useBackground() {
  return {
    customBackground,
    usingCustomBackground,
    uploadBackground,
    resetBackground,
    preview: computed(() => customBackground.value ?? DEFAULT_WALLPAPERS.light),
  };
}
