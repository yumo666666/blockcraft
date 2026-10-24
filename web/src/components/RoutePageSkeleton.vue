<script setup lang="ts">
import WorldPageSkeleton from './WorldPageSkeleton.vue';

defineProps<{ name: string; label?: string }>();
</script>

<template>
  <div class="page col gap-4 route-skeleton" role="status" :aria-label="`正在打开${label || '页面'}`" aria-busy="true">
    <WorldPageSkeleton v-if="name === 'world'" />

    <template v-else-if="name === 'overview'">
      <section class="card route-overview-hero" aria-hidden="true">
        <div class="route-overview-intro">
          <div class="col gap-3">
            <span class="skeleton route-eyebrow" />
            <span class="skeleton route-title route-title-lg" />
            <span class="skeleton route-line route-line-wide" />
          </div>
          <span class="skeleton route-pill route-status-pill" />
        </div>
        <div class="route-overview-summary">
          <div class="route-host-summary"><span class="skeleton route-icon-lg" /><div class="col gap-2"><span class="skeleton route-line route-line-sm" /><span class="skeleton route-line route-line-md" /></div></div>
          <div class="route-overview-metrics"><span v-for="item in 2" :key="item" class="skeleton route-metric" /></div>
          <div class="route-overview-actions"><span v-for="item in 3" :key="item" class="skeleton route-action" /></div>
        </div>
      </section>
      <div class="route-overview-grid" aria-hidden="true">
        <section class="card"><div class="card-head"><span class="skeleton route-heading" /></div><div class="card-body route-monitor"><span class="skeleton route-line route-line-sm" /><div class="route-stat-grid"><span v-for="item in 8" :key="item" class="skeleton route-stat" /></div><span class="skeleton route-line route-line-sm" /><span class="skeleton route-row" /></div></section>
        <section class="card"><div class="card-head"><span class="skeleton route-heading" /><span class="skeleton route-pill" /></div><div class="card-body route-frp"><span v-for="item in 3" :key="item" class="skeleton route-line" /><div class="route-frp-pair"><span class="skeleton route-action" /><span class="skeleton route-action" /></div><span class="skeleton route-line route-line-wide" /></div></section>
      </div>
    </template>

    <template v-else-if="name === 'websites'">
      <header class="col gap-2" aria-hidden="true"><span class="skeleton route-eyebrow" /><span class="skeleton route-title" /><span class="skeleton route-line route-line-wide" /></header>
      <section class="route-website-grid" aria-hidden="true"><article v-for="item in 6" :key="item" class="card route-website-card"><span class="skeleton route-icon-lg" /><span class="skeleton route-title route-title-sm" /><span class="skeleton route-line route-line-wide" /><span class="skeleton route-line" /><div class="route-website-list"><span v-for="line in 3" :key="line" class="skeleton route-line" /></div><span class="skeleton route-button" /></article></section>
    </template>

    <template v-else-if="name === 'wizard-create' || name === 'wizard-import'">
      <header class="col gap-2" aria-hidden="true"><span class="skeleton route-title" /><span class="skeleton route-line route-line-wide" /></header>
      <div class="route-wizard-grid" aria-hidden="true">
        <section class="card route-wizard-main"><div class="card-head route-wizard-head"><span class="skeleton route-heading" /><div class="route-step-pills"><span v-for="item in 5" :key="item" class="skeleton route-pill" /></div></div><div class="card-body col gap-4"><div v-if="name === 'wizard-create'" class="route-form-grid"><div class="route-field route-field-wide"><span class="skeleton route-label" /><span class="skeleton route-control" /><span class="skeleton route-line route-line-md" /></div><div v-for="item in 2" :key="item" class="route-field"><span class="skeleton route-label" /><span class="skeleton route-control" /></div><div class="route-field route-field-wide route-inline"><span v-for="item in 2" :key="item" class="skeleton route-line route-line-md" /></div></div><template v-else><span class="skeleton route-control route-upload" /><span class="skeleton route-line route-line-wide" /><div v-for="item in 3" :key="item" class="skeleton route-row" /></template></div><div class="card-foot row-between"><span class="skeleton route-button" /><span class="skeleton route-button route-button-primary" /></div></section>
        <section class="card route-wizard-flow"><div class="card-head"><span class="skeleton route-heading" /></div><div class="card-body col gap-3"><span v-for="item in 5" :key="item" class="skeleton route-flow-step" /></div></section>
        <section class="card"><div class="card-head"><span class="skeleton route-heading" /></div><div class="card-body col gap-3"><span v-for="item in 5" :key="item" class="skeleton route-kv" /></div></section>
        <section class="card"><div class="card-head"><span class="skeleton route-heading" /></div><div class="card-body col gap-3"><span v-for="item in 3" :key="item" class="skeleton route-line route-line-wide" /><span class="skeleton route-note" /></div></section>
      </div>
    </template>

    <template v-else-if="name === 'events'">
      <header class="row-between wrap gap-3" aria-hidden="true"><div class="col gap-2"><span class="skeleton route-title" /><span class="skeleton route-line route-line-wide" /></div><div class="row gap-2"><span class="skeleton route-switch" /><span class="skeleton route-button" /></div></header>
      <section class="card"><div class="card-head"><span class="skeleton route-heading" /><span class="skeleton route-line route-line-sm" /></div><div class="card-body route-event-log" aria-hidden="true"><div v-for="line in 14" :key="line" class="route-event-row"><span class="skeleton route-event-time" /><span class="skeleton route-event-kind" /><span class="skeleton route-event-world" /><span class="skeleton route-event-text" :class="`route-event-text-${line % 3}`" /></div></div></section>
    </template>

    <template v-else-if="name === 'files'">
      <header class="row-between wrap gap-3" aria-hidden="true"><div class="col gap-2"><span class="skeleton route-title" /><span class="skeleton route-line route-line-wide" /></div><div class="row gap-2"><span class="skeleton route-pill" /><span v-for="item in 3" :key="item" class="skeleton route-button" /></div></header>
      <section class="card route-files-shell" aria-hidden="true">
        <aside class="route-files-tree"><div class="route-files-pane-head"><span class="skeleton route-heading" /><span class="skeleton route-line route-line-xs" /></div><div class="route-files-tree-rows"><span v-for="row in 10" :key="row" class="skeleton route-tree-row" :class="{ nested: row % 3 !== 1 }" /></div><span class="skeleton route-line route-line-wide" /></aside>
        <div class="route-files-content"><div class="route-files-breadcrumb"><span class="skeleton route-line route-line-md" /><span class="skeleton route-line route-line-sm" /></div><div class="route-files-selection"><span class="skeleton route-line route-line-sm" /><span class="skeleton route-line route-line-xs" /><div class="row gap-2"><span class="skeleton route-button" /><span class="skeleton route-button" /></div></div><div class="route-files-table-head"><span v-for="col in 5" :key="col" class="skeleton route-line" /></div><div class="route-files-rows"><div v-for="row in 8" :key="row" class="route-files-row"><span class="skeleton route-checkbox" /><span class="skeleton route-line route-line-wide" /><span class="skeleton route-line route-line-xs" /><span class="skeleton route-line route-line-sm" /><span class="skeleton route-line route-line-md" /></div></div></div>
      </section>
    </template>

    <template v-else-if="name === 'settings'">
      <header class="col gap-2" aria-hidden="true"><span class="skeleton route-title" /><span class="skeleton route-line route-line-wide" /></header>
      <section class="card route-appearance"><div class="card-head"><span class="skeleton route-heading" /><span class="skeleton route-line route-line-sm" /></div><div class="card-body route-appearance-grid"><div class="col gap-2"><span class="skeleton route-label" /><div class="route-theme-cards"><div v-for="item in 3" :key="item" class="route-theme-card"><span class="skeleton route-theme-preview" /><span class="skeleton route-line route-line-sm" /><span class="skeleton route-line route-line-md" /></div></div></div><div class="route-field"><span class="skeleton route-label" /><div class="route-wallpaper"><span class="skeleton route-wallpaper-thumb" /><div class="col gap-2 grow"><span class="skeleton route-button" /><span class="skeleton route-line route-line-wide" /></div></div></div></div></section>
      <div class="route-settings-grid" aria-hidden="true"><section v-for="(rows, index) in [3, 2, 3, 3, 2, 3, 4, 3, 2]" :key="index" class="card"><div class="card-head"><span class="skeleton route-heading" /></div><div class="card-body col gap-3"><div v-for="row in rows" :key="row" class="route-field"><span class="skeleton route-label" /><span class="skeleton route-control" /></div></div></section></div>
    </template>

    <template v-else-if="name === 'console'">
      <header class="row-between wrap gap-3" aria-hidden="true"><div class="col gap-2"><span class="skeleton route-title" /><span class="skeleton route-pill" /></div><div class="route-console-stats"><span v-for="item in 3" :key="item" class="skeleton route-stat" /></div></header>
      <div class="route-console-grid" aria-hidden="true"><section class="card"><div class="card-head"><span class="skeleton route-heading" /><div class="route-console-toolbar"><span class="skeleton route-switch" /><span class="skeleton route-button" /><span class="skeleton route-control route-filter" /></div></div><div class="card-body route-console-log"><span v-for="line in 14" :key="line" class="skeleton route-console-line" :class="`route-console-line-${line % 4}`" /></div><div class="card-foot col gap-2"><span class="skeleton route-control" /><span class="skeleton route-line route-line-wide" /></div></section><section class="card"><div class="card-head"><span class="skeleton route-heading" /></div><div class="card-body col gap-3"><span class="skeleton route-note" /><span class="skeleton route-control" /><span class="skeleton route-control" /><span class="skeleton route-note" /><div v-for="group in 3" :key="group" class="route-shortcut-chips"><span v-for="chip in 3" :key="chip" class="skeleton route-pill" /></div></div></section></div>
      <section class="card"><div class="card-head"><span class="skeleton route-heading" /><span class="skeleton route-line route-line-md" /></div><div class="card-body route-schedule-grid"><span v-for="item in 4" :key="item" class="skeleton route-control" /></div></section>
    </template>

    <template v-else-if="name === 'backups'">
      <header class="row-between wrap gap-3" aria-hidden="true"><div class="row gap-3"><span class="skeleton route-title" /><span class="skeleton route-pill" /><span class="skeleton route-pill route-pill-wide" /></div><span class="skeleton route-button route-button-primary" /></header>
      <section class="card route-backup-stats" aria-hidden="true"><div v-for="item in 4" :key="item" class="col gap-2"><span class="skeleton route-label" /><span class="skeleton route-stat" /></div></section>
      <section class="card"><div class="card-head"><span class="skeleton route-heading" /><div class="row gap-2"><span class="skeleton route-button" /><span class="skeleton route-button" /></div></div><div class="card-body col gap-3"><span class="skeleton route-line route-line-wide" /><div v-for="item in 3" :key="item" class="route-backup-row"><div class="col gap-3 grow"><div class="row gap-2"><span class="skeleton route-line route-line-md" /><span class="skeleton route-pill" /><span class="skeleton route-pill" /></div><div class="row gap-2 wrap"><span v-for="meta in 4" :key="meta" class="skeleton route-line route-line-sm" /></div></div><div class="row gap-2"><span v-for="action in 3" :key="action" class="skeleton route-button" /></div></div></div></section>
      <section class="card"><div class="card-head"><span class="skeleton route-heading" /><span class="skeleton route-line route-line-md" /></div><div class="card-body col gap-3"><span class="skeleton route-switch" /><div class="route-form-grid"><div v-for="item in 4" :key="item" class="route-field"><span class="skeleton route-label" /><span class="skeleton route-control" /></div></div></div></section>
    </template>

    <template v-else-if="name === 'mods'">
      <header class="row-between wrap gap-3" aria-hidden="true"><div class="col gap-2"><div class="row gap-2"><span class="skeleton route-title" /><span class="skeleton route-pill" /></div><span class="skeleton route-line route-line-wide" /></div><div class="row gap-2"><span v-for="item in 4" :key="item" class="skeleton route-button" /></div></header>
      <section class="card route-mod-filters" aria-hidden="true"><div class="route-field route-field-search"><span class="skeleton route-label" /><span class="skeleton route-control" /></div><div v-for="item in 3" :key="item" class="route-field"><span class="skeleton route-label" /><span class="skeleton route-control" /></div><span class="skeleton route-button" /></section>
      <section class="route-mod-grid" aria-hidden="true"><article v-for="item in 6" :key="item" class="card route-mod-card"><div class="row-between gap-2"><span class="skeleton route-line route-line-md" /><span class="skeleton route-pill" /></div><div class="col gap-2"><span class="skeleton route-line route-line-wide" /><span class="skeleton route-line route-line-md" /></div><span class="skeleton route-line route-line-sm" /><div class="row gap-2"><span v-for="action in 3" :key="action" class="skeleton route-mod-action" /></div></article></section>
    </template>

    <template v-else-if="name === 'players'">
      <header class="row-between wrap gap-3" aria-hidden="true"><div class="col gap-2"><span class="skeleton route-title" /><span class="skeleton route-line route-line-md" /></div><span class="skeleton route-button" /></header>
      <section class="card"><div class="card-head"><span class="skeleton route-heading" /><span class="skeleton route-line route-line-md" /></div><div class="card-body route-player-grid" aria-hidden="true"><article v-for="item in 4" :key="item" class="route-player-card"><span class="skeleton route-player-avatar" /><span class="skeleton route-line route-line-md" /><span class="skeleton route-pill" /><span class="skeleton route-line route-line-sm" /><div class="route-player-actions"><span v-for="action in 5" :key="action" class="skeleton route-player-action" /></div></article></div></section>
      <section class="card"><div class="card-head"><span class="skeleton route-heading" /></div><div class="card-body col gap-3"><span class="skeleton route-line route-line-wide" /><div class="route-player-pool"><span v-for="item in 5" :key="item" class="skeleton route-skin-tile" /></div></div></section>
    </template>

    <template v-else-if="name === 'performance-detail'">
      <header class="row gap-3" aria-hidden="true"><span class="skeleton route-button" /><div class="col gap-2"><span class="skeleton route-title" /><span class="skeleton route-line route-line-wide" /></div></header>
      <section class="card"><div class="card-head row-between wrap gap-3"><div class="row gap-2"><span class="skeleton route-icon" /><div class="col gap-2"><span class="skeleton route-heading" /><span class="skeleton route-line route-line-sm" /></div></div><div class="row gap-1"><span v-for="item in 4" :key="item" class="skeleton route-range" /></div></div><div class="card-body col gap-4"><div class="route-performance-summary"><div v-for="item in 4" :key="item" class="route-perf-value"><span class="skeleton route-label" /><span class="skeleton route-stat" /></div></div><div class="route-performance-chart"><span v-for="line in 5" :key="line" class="route-chart-gridline" :style="{ top: `${line * 18}%` }" /><span class="skeleton route-chart-trend" /></div><div class="row-between wrap gap-2"><span class="skeleton route-line route-line-md" /><span class="skeleton route-line route-line-wide" /></div></div></section>
    </template>

    <template v-else>
      <header class="row-between gap-3" aria-hidden="true"><span class="skeleton route-title" /><span class="skeleton route-button" /></header>
      <section class="card"><div class="card-head"><span class="skeleton route-heading" /></div><div class="card-body col gap-3"><span v-for="row in 6" :key="row" class="skeleton route-row" /></div></section>
    </template>
  </div>
</template>

<style scoped>
.route-skeleton { min-width: 0; }
.route-title, .route-heading, .route-line, .route-label, .route-control, .route-note, .route-row, .route-pill, .route-button, .route-icon, .route-icon-lg { display: block; }
.route-title { width: min(34%, 220px); height: 26px; border-radius: 6px; }
.route-title-lg { width: 260px; height: 34px; }
.route-title-sm { width: 72%; height: 20px; }
.route-heading { width: 118px; height: 16px; border-radius: 5px; }
.route-eyebrow { width: 154px; height: 10px; border-radius: 5px; }
.route-line { width: min(76%, 420px); height: 11px; border-radius: 5px; }
.route-line-wide { width: min(94%, 620px); }
.route-line-md { width: min(64%, 300px); }
.route-line-sm { width: min(42%, 180px); }
.route-line-xs { width: 48px; }
.route-label { width: min(52%, 160px); height: 12px; border-radius: 5px; }
.route-control { width: 100%; height: 38px; border-radius: var(--r-sm); }
.route-pill { width: 74px; height: 24px; border-radius: 999px; }
.route-pill-wide { width: 170px; }
.route-button { width: 92px; height: 38px; border-radius: var(--r-sm); }
.route-button-primary { width: 112px; }
.route-icon { width: 32px; height: 32px; border-radius: 9px; }
.route-icon-lg { width: 46px; height: 46px; border-radius: 13px; }
.route-note { width: 100%; height: 62px; border-radius: var(--r-sm); }
.route-row { width: 100%; height: 36px; border-radius: var(--r-sm); }
.route-overview-hero { overflow: hidden; }
.route-overview-intro, .route-overview-summary { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 23px 24px; }
.route-overview-intro { min-height: 164px; align-items: flex-start; border-bottom: 1px solid var(--border); }
.route-status-pill { width: 200px; height: 42px; flex: none; }
.route-overview-summary { min-height: 92px; }
.route-host-summary { display: flex; align-items: center; gap: 14px; }
.route-overview-metrics, .route-overview-actions { display: flex; gap: 8px; }
.route-metric { width: 102px; height: 58px; border-radius: var(--r-sm); }
.route-action { width: clamp(120px, 14vw, 205px); height: 58px; border-radius: var(--r-sm); }
.route-overview-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(300px, 1fr); gap: var(--sp-4); }
.route-monitor, .route-frp { display: flex; flex-direction: column; gap: 18px; min-height: 330px; }
.route-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px 14px; }
.route-stat { display: block; width: 100%; height: 24px; border-radius: 5px; }
.route-frp-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 18px; }
.route-website-grid, .route-mod-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-4); }
.route-website-card { display: flex; min-height: 250px; flex-direction: column; align-items: flex-start; gap: 13px; padding: var(--sp-4); }
.route-website-list { display: flex; width: 100%; flex-direction: column; gap: 8px; margin-top: auto; padding-top: 12px; border-top: 1px solid var(--border); }
.route-website-list .route-line { width: 68%; }
.route-button:last-child { margin-top: 4px; }
.route-wizard-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(280px, 1fr); grid-template-rows: 338px 219px; gap: var(--sp-4); }
.route-wizard-grid > section { min-width: 0; overflow: hidden; }
.route-wizard-main { grid-column: 1; grid-row: 1; display: flex; flex-direction: column; }
.route-wizard-flow { grid-column: 2; grid-row: 1; }
.route-step-pills { display: flex; gap: 5px; }
.route-step-pills .route-pill { width: 61px; height: 21px; }
.route-wizard-head { display: flex; justify-content: space-between; gap: 12px; }
.route-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.route-field { display: flex; min-width: 0; flex-direction: column; gap: 8px; }
.route-field-wide { grid-column: 1 / -1; }
.route-inline { flex-direction: row; gap: 24px; }
.route-upload { height: 64px; }
.route-wizard-grid > section:nth-child(3) { grid-column: 1; grid-row: 2; }
.route-wizard-grid > section:nth-child(4) { grid-column: 2; grid-row: 2; }
.route-flow-step { display: block; width: 100%; height: 43px; border-radius: var(--r-sm); }
.route-kv { display: block; width: 100%; height: 20px; border-radius: 4px; }
.route-event-log { min-height: min(64vh, 620px); display: flex; flex-direction: column; gap: 10px; }
.route-event-row { display: flex; min-height: 14px; align-items: center; gap: 8px; }
.route-event-row > span { display: block; height: 10px; border-radius: 4px; }
.route-event-time { width: 102px; flex: none; }.route-event-kind { width: 36px; flex: none; }.route-event-world { width: 76px; flex: none; }.route-event-text { width: min(58%, 480px); }.route-event-text-0 { width: min(72%, 620px); }.route-event-text-1 { width: min(42%, 360px); }
.route-appearance { min-height: 190px; }.route-appearance-grid { display: grid; grid-template-columns: minmax(0, 1.75fr) minmax(250px, 1fr); gap: 22px; align-items: start; }.route-theme-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }.route-theme-card { display: flex; min-width: 0; flex-direction: column; gap: 8px; padding: 9px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface-2); }.route-theme-preview { display: block; height: 54px; border-radius: 8px; }.route-wallpaper { display: flex; align-items: flex-start; gap: 12px; }.route-wallpaper-thumb { display: block; width: 88px; height: 64px; flex: none; border-radius: var(--r-sm); }
.route-settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-areas: 'access source' 'skins java' 'limits frp' 'ports storage' 'about about'; gap: var(--sp-4); }
.route-settings-grid > section { min-height: 165px; }.route-settings-grid > section:nth-child(1) { grid-area: access; }.route-settings-grid > section:nth-child(2) { grid-area: source; }.route-settings-grid > section:nth-child(3) { grid-area: skins; }.route-settings-grid > section:nth-child(4) { grid-area: java; }.route-settings-grid > section:nth-child(5) { grid-area: limits; }.route-settings-grid > section:nth-child(6) { grid-area: frp; }.route-settings-grid > section:nth-child(7) { grid-area: ports; }.route-settings-grid > section:nth-child(8) { grid-area: storage; }.route-settings-grid > section:nth-child(9) { grid-area: about; }
.route-console-stats { display: flex; gap: 20px; }.route-console-stats .route-stat { width: 86px; height: 38px; }
.route-console-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 330px); gap: var(--sp-4); align-items: stretch; }
.route-console-grid > section { display: flex; min-width: 0; flex-direction: column; }.route-console-toolbar { display: flex; align-items: center; gap: 8px; }.route-console-toolbar .route-switch { width: 82px; height: 20px; }.route-console-toolbar .route-button { width: 66px; height: 30px; }.route-console-toolbar .route-filter { width: 112px; height: 30px; }
.route-console-log { display: flex; min-height: 390px; flex-direction: column; gap: 12px; background: var(--surface-2); }.route-console-line { display: block; width: 74%; height: 12px; border-radius: 4px; }.route-console-line-0 { width: 88%; }.route-console-line-1 { width: 61%; }.route-console-line-2 { width: 79%; }.route-console-line-3 { width: 47%; }.route-shortcut-chips { display: flex; flex-wrap: wrap; gap: 6px; }.route-shortcut-chips .route-pill { width: 62px; height: 28px; }
.route-schedule-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.route-backup-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; padding: 18px; }.route-backup-stats .route-stat { max-width: 140px; }.route-backup-row { display: flex; min-height: 82px; align-items: center; justify-content: space-between; gap: 16px; padding: 12px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); }.route-form-grid { min-width: 0; }.route-mod-filters { display: grid; grid-template-columns: minmax(220px, 1fr) 148px 132px 106px auto; align-items: end; gap: 12px; padding: 16px; }.route-field-search { min-width: 0; }.route-mod-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }.route-mod-card { display: flex; min-height: 190px; flex-direction: column; justify-content: space-between; gap: 14px; padding: 15px; }.route-mod-action { display: block; min-width: 0; height: 32px; flex: 1; border-radius: var(--r-xs); }
.route-player-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--sp-3); }.route-player-card { display: flex; min-width: 0; flex-direction: column; align-items: center; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); }.route-player-avatar { display: block; width: 76px; height: 88px; border-radius: var(--r-sm); }.route-player-actions { display: grid; width: 100%; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }.route-player-action { display: block; height: 28px; border-radius: var(--r-xs); }.route-player-pool { display: flex; flex-wrap: wrap; gap: 10px; }.route-skin-tile { display: block; width: 72px; height: 92px; border-radius: var(--r-sm); }
.route-performance-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }.route-perf-value { display: flex; min-width: 0; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); }.route-perf-value .route-stat { width: 84px; height: 20px; }.route-range { display: block; width: 56px; height: 30px; border-radius: var(--r-xs); }.route-performance-chart { position: relative; height: clamp(250px, 34vw, 390px); overflow: hidden; border: 1px solid var(--border); border-radius: var(--r); background: var(--surface-2); }.route-chart-gridline { position: absolute; right: 14px; left: 58px; border-top: 1px dashed var(--border); }.route-chart-trend { position: absolute; top: 48%; right: 8%; left: 8%; height: 3px; border-radius: 999px; transform: rotate(-2deg); }
.route-files-shell { display: grid; min-height: min(700px, calc(100vh - 240px)); grid-template-columns: minmax(210px, 250px) minmax(0, 1fr); overflow: hidden; }.route-files-tree { display: flex; min-width: 0; flex-direction: column; gap: 12px; padding-bottom: 12px; border-right: 1px solid var(--border); background: var(--surface-2); }.route-files-pane-head { display: flex; min-height: 51px; align-items: center; justify-content: space-between; padding: 0 14px; border-bottom: 1px solid var(--border); }.route-files-tree-rows { display: flex; flex-direction: column; gap: 6px; padding: 8px; }.route-tree-row { display: block; width: 88%; height: 30px; border-radius: var(--r-sm); }.route-tree-row.nested { width: 72%; margin-left: 20px; }.route-files-tree > .route-line { margin-inline: 12px; }.route-files-content { display: flex; min-width: 0; flex-direction: column; }.route-files-breadcrumb, .route-files-selection, .route-files-table-head { display: flex; min-height: 44px; align-items: center; gap: 12px; padding: 6px 14px; border-bottom: 1px solid var(--border); }.route-files-breadcrumb { min-height: 51px; justify-content: space-between; }.route-files-selection { justify-content: space-between; }.route-files-table-head { display: grid; grid-template-columns: 28px minmax(155px, 1fr) minmax(78px, 105px) minmax(115px, 145px) minmax(188px, 230px); }.route-files-table-head .route-line { width: 72%; }.route-files-table-head .route-line:first-child { width: 16px; }.route-files-row { display: grid; min-height: 61px; grid-template-columns: 28px minmax(155px, 1fr) minmax(78px, 105px) minmax(115px, 145px) minmax(188px, 230px); align-items: center; gap: 10px; padding: 0 13px; border-bottom: 1px solid var(--border); }.route-files-row .route-line { height: 12px; }.route-checkbox { width: 16px; height: 16px; border: 1px solid var(--border-strong); border-radius: 3px; background: var(--surface-strong); }
@media (max-width: 940px) { .route-overview-grid, .route-console-grid { grid-template-columns: 1fr; } .route-website-grid, .route-mod-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .route-wizard-grid { grid-template-columns: minmax(0, 1.5fr) minmax(240px, 1fr); } }
@media (max-width: 760px) { .route-overview-intro, .route-overview-summary { align-items: flex-start; flex-direction: column; padding: 17px; }.route-overview-summary { gap: 14px; }.route-overview-actions { width: 100%; flex-wrap: wrap; }.route-action { flex: 1 1 110px; }.route-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.route-website-grid, .route-mod-grid { grid-template-columns: 1fr; }.route-wizard-grid { display: flex; flex-direction: column; }.route-wizard-grid > section { min-height: 190px; }.route-wizard-main { min-height: 338px !important; }.route-step-pills { display: none; }.route-appearance-grid { grid-template-columns: 1fr; }.route-settings-grid { grid-template-columns: 1fr; grid-template-areas: none; }.route-settings-grid > section { grid-area: auto !important; }.route-mod-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }.route-mod-filters > :first-child { grid-column: 1 / -1; }.route-mod-filters > :last-child { width: 100%; }.route-backup-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }.route-backup-row { align-items: stretch; flex-direction: column; }.route-files-shell { display: flex; min-height: 0; flex-direction: column; }.route-files-tree { max-height: 210px; border-right: 0; border-bottom: 1px solid var(--border); }.route-files-tree-rows { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }.route-tree-row.nested { margin-left: 0; }.route-files-content { min-height: 440px; }.route-files-table-head, .route-files-row { grid-template-columns: 24px minmax(0, 1fr) minmax(110px, auto); gap: 6px; padding-inline: 9px; }.route-files-table-head > :nth-child(3), .route-files-table-head > :nth-child(4), .route-files-row > :nth-child(3), .route-files-row > :nth-child(4) { display: none; }.route-performance-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }.route-performance-chart { height: 280px; }.route-console-log { min-height: 300px; }.route-console-toolbar .route-switch, .route-console-toolbar .route-filter { display: none; } }
@media (prefers-reduced-motion: reduce) { .route-skeleton :deep(.skeleton) { animation: none; background-position: 50% 50%; } }
</style>
