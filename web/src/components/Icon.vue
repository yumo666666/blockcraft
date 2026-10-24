<script setup lang="ts">
/**
 * 一套手写的线性图标，替代散落的 emoji。
 * 统一 24 网格、1.7 线宽，颜色永远取 currentColor，随主题走。
 */
const props = withDefaults(defineProps<{ name: string; size?: number; strokeWidth?: number }>(), {
  size: 20,
  strokeWidth: 1.7,
});

const ICONS: Record<string, string> = {
  overview: '<rect x="3.2" y="3.2" width="7.6" height="7.6" rx="2.2"/><rect x="13.2" y="3.2" width="7.6" height="7.6" rx="2.2"/><rect x="3.2" y="13.2" width="7.6" height="7.6" rx="2.2"/><rect x="13.2" y="13.2" width="7.6" height="7.6" rx="2.2"/>',
  events: '<path d="M6 3.6h9.4L19 7.2v13.2H6z"/><path d="M15 3.8V7.4h3.6"/><path d="M9 11h7M9 14.6h7M9 18.2h4.4"/>',
  bell: '<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
  mail: '<rect x="3.2" y="5.2" width="17.6" height="13.6" rx="2.2"/><path d="m4.2 7 7.8 6 7.8-6"/>',
  send: '<path d="m21 3-7.1 18-3.8-7.2L3 10z"/><path d="M10.1 13.8 21 3"/>',
  globe: '<circle cx="12" cy="12" r="8.6"/><path d="M3.6 12h16.8M12 3.4c2.3 2.3 3.5 5.2 3.5 8.6S14.3 18.3 12 20.6c-2.3-2.3-3.5-5.2-3.5-8.6S9.7 5.7 12 3.4Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  package: '<path d="m12 3.4 8 4.4v8.4l-8 4.4-8-4.4V7.8l8-4.4Z"/><path d="m4.4 8 7.6 4.2L19.6 8M12 12.2v8.4"/><path d="m8.2 5.7 8 4.4"/>',
  settings: '<circle cx="12" cy="12" r="3.1"/><path d="M19.2 13.6a1.7 1.7 0 0 0 .3 1.9l.1.1-2.1 2.1-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-3v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-2.1-2.1.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H4.9v-3h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.1-2.1.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.2h3v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.1 2.1-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v3h-.2a1.7 1.7 0 0 0-1.4.9Z"/>',
  console: '<rect x="3.2" y="4.2" width="17.6" height="15.6" rx="3"/><path d="m7.4 9.4 2.8 2.7-2.8 2.7M12.8 15h4"/>',
  backups: '<rect x="3.2" y="4.2" width="17.6" height="4" rx="1.6"/><path d="M5 8.2v11.4h14V8.2M10 12.4h4"/>',
  mods: '<path d="M10 4.5a2 2 0 0 1 4 0V6h3.5a1 1 0 0 1 1 1v3.5H20a2 2 0 0 1 0 4h-1.5V18a1 1 0 0 1-1 1H14v-1.5a2 2 0 0 0-4 0V19H6.5a1 1 0 0 1-1-1v-3.5H4a2 2 0 0 1 0-4h1.5V7a1 1 0 0 1 1-1H10Z"/>',
  players: '<circle cx="9" cy="8.2" r="3.2"/><path d="M3.4 19.2c.5-3.2 2.7-5 5.6-5s5.1 1.8 5.6 5"/><path d="M15.8 5.4a3 3 0 0 1 0 5.6M17.3 14.6c2 .6 3.3 2.2 3.7 4.6"/>',
  server: '<rect x="3.4" y="4.2" width="17.2" height="6.2" rx="2"/><rect x="3.4" y="13.6" width="17.2" height="6.2" rx="2"/><path d="M7 7.3h.01M7 16.7h.01M11 7.3h6M11 16.7h6"/>',
  cpu: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.2"/><rect x="10" y="10" width="4" height="4" rx="1"/><path d="M9.4 3.2v3.2M14.6 3.2v3.2M9.4 17.6v3.2M14.6 17.6v3.2M3.2 9.4h3.2M3.2 14.6h3.2M17.6 9.4h3.2M17.6 14.6h3.2"/>',
  play: '<path d="M8.4 5.5 18.6 12 8.4 18.5Z"/>',
  stop: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.4"/>',
  download: '<path d="M12 4v10.4M7.6 10.4 12 14.8l4.4-4.4M4.4 19.6h15.2"/>',
  upload: '<path d="M12 19.6V9.2M7.6 13.6 12 9.2l4.4 4.4M4.4 19.6h15.2"/>',
  image: '<rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.6"/><circle cx="8.6" cy="9.4" r="1.6"/><path d="m5.6 17.2 4.4-4.6 3.2 3.2 2.4-2.4 3.2 3.8"/>',
  undo: '<path d="M4.6 9.4h9.6a5 5 0 0 1 0 10H8.4"/><path d="m8.4 5.2-4 4.2 4 4.2"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/>',
  moon: '<path d="M20 14.6A8.4 8.4 0 0 1 9.4 4a8.4 8.4 0 1 0 10.6 10.6Z"/>',
  monitor: '<rect x="3.2" y="4.2" width="17.6" height="12.4" rx="2.4"/><path d="M9 20.4h6M12 16.6v3.8"/>',
  logout: '<path d="M14.4 4.4H6a1.6 1.6 0 0 0-1.6 1.6v12a1.6 1.6 0 0 0 1.6 1.6h8.4"/><path d="M16.4 8.2 20.6 12l-4.2 3.8M20.6 12H9.6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  'chevron-left': '<path d="m14.5 6-6 6 6 6"/>',
  'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  external: '<path d="M14 4.4h5.6V10M19.6 4.4l-8 8"/><path d="M18.4 14v4.2a1.4 1.4 0 0 1-1.4 1.4H5.8a1.4 1.4 0 0 1-1.4-1.4V7a1.4 1.4 0 0 1 1.4-1.4H10"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 10.8v5.4M12 7.8h.01"/>',
  help: '<circle cx="12" cy="12" r="8.6"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.5-1.2 1-1.2 1.9M12 17h.01"/>',
  folder: '<path d="M3.6 6.8a1.6 1.6 0 0 1 1.6-1.6h4l2 2.2h7.6a1.6 1.6 0 0 1 1.6 1.6v8.6a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6Z"/>',
  palette: '<path d="M12 3.4a8.6 8.6 0 1 0 0 17.2h1.2a2 2 0 0 0 1.3-3.5c-.6-.5-.2-1.4.6-1.4h1.2a3.4 3.4 0 0 0 3.4-3.4c0-4.9-3.5-8.9-7.7-8.9Z"/><circle cx="7.6" cy="10.4" r="1"/><circle cx="10.6" cy="7.2" r="1"/><circle cx="14.6" cy="7.8" r="1"/>',
  check: '<path d="m5 12.6 4.4 4.4L19 6.8"/>',
  trash: '<path d="M4.6 7h14.8M9.4 7V4.8h5.2V7M6.4 7l.9 12.2h9.4L17.6 7M10 10.6v5.4M14 10.6v5.4"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.2V12l3.2 1.9"/>',
  sparkle: '<path d="M12 3.4l1.7 5 5 1.7-5 1.7-1.7 5-1.7-5-5-1.7 5-1.7Z"/><path d="M18.6 15.4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"/>',
};
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="props.strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    v-html="ICONS[props.name] ?? ICONS.info"
  />
</template>
