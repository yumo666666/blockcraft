<template>
  <div class="world-loading" role="status" aria-label="正在读取世界详情" aria-busy="true">
    <section class="card" aria-hidden="true">
      <div class="card-body world-loading-hero">
        <div class="row gap-2">
          <span class="skeleton world-loading-title" />
          <span class="skeleton world-loading-status" />
        </div>
        <span class="skeleton world-loading-line world-loading-line-wide" />
        <div class="row gap-2 wrap">
          <span v-for="chip in 4" :key="chip" class="skeleton world-loading-chip" />
        </div>
      </div>
    </section>

    <section class="card" aria-hidden="true">
      <div class="card-head"><span class="skeleton world-loading-heading" /></div>
      <div class="card-body">
        <div class="world-loading-chart-grid">
          <div v-for="chart in 3" :key="chart" class="world-loading-chart-card">
            <div class="row-between gap-2">
              <span class="skeleton world-loading-chart-title" />
              <span class="skeleton world-loading-chart-value" />
            </div>
            <div class="skeleton world-loading-chart" />
          </div>
        </div>
      </div>
    </section>

    <div class="world-bottom-grid" aria-hidden="true">
      <section v-for="panel in 2" :key="panel" class="card world-panel">
        <div class="card-head"><span class="skeleton world-loading-heading" /></div>
        <div class="card-body world-facts">
          <div v-for="fact in (panel === 1 ? 8 : 7)" :key="fact" class="world-fact">
            <span class="skeleton world-loading-fact-label" />
            <strong class="skeleton world-loading-fact-value" />
          </div>
        </div>
      </section>
      <section class="card world-panel world-actions-card">
        <div class="card-head"><span class="skeleton world-loading-heading" /></div>
        <div class="card-body col gap-2">
          <div v-for="action in 4" :key="action" class="world-action world-loading-action">
            <span class="skeleton world-loading-action-icon" />
            <span class="world-loading-action-copy">
              <span class="skeleton world-loading-action-title" />
              <span class="skeleton world-loading-action-subtitle" />
            </span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.world-loading { display: flex; flex-direction: column; gap: var(--sp-4); }
.world-loading-hero { display: flex; min-height: 156px; flex-direction: column; justify-content: center; gap: 14px; }
.world-loading-title { width: 150px; height: 24px; }
.world-loading-status { width: 66px; height: 22px; border-radius: 999px; }
.world-loading-line { height: 12px; border-radius: 6px; }
.world-loading-line-wide { width: min(68%, 460px); }
.world-loading-chip { width: 88px; height: 26px; border-radius: 999px; }
.world-loading-heading { display: block; width: 118px; height: 18px; }
.world-loading-chart-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.world-loading-chart-card { display: flex; min-width: 0; min-height: 142px; flex-direction: column; gap: 14px; padding: 14px; border: 1px solid var(--border); border-radius: var(--r); background: var(--surface-2); }
.world-loading-chart-title, .world-loading-chart-value { height: 13px; border-radius: 5px; }
.world-loading-chart-title { width: 42%; }
.world-loading-chart-value { width: 58px; }
.world-loading-chart { width: 100%; height: 78px; margin-top: auto; border-radius: var(--r-xs); }
.world-bottom-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-4); align-items: stretch; }
.world-panel { display: flex; min-width: 0; flex-direction: column; }
.world-panel > .card-body { flex: 1; }
.world-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start; gap: 14px 20px; }
.world-fact { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.world-loading-fact-label { width: 68px; height: 11px; border-radius: 5px; }
.world-loading-fact-value { width: min(78%, 132px); height: 14px; margin-top: 2px; border-radius: 5px; }
.world-loading-action { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 11px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); }
.world-loading-action-icon { width: 17px; height: 17px; flex: none; border-radius: 4px; }
.world-loading-action-copy { display: flex; min-width: 0; flex-direction: column; gap: 5px; }
.world-loading-action-title { width: 82px; height: 12px; border-radius: 5px; }
.world-loading-action-subtitle { width: 126px; max-width: 100%; height: 10px; border-radius: 5px; }
@media (max-width: 1100px) {
  .world-bottom-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .world-actions-card { grid-column: 1 / -1; }
  .world-actions-card .card-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 980px) { .world-loading-chart-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 780px) {
  .world-bottom-grid { grid-template-columns: minmax(0, 1fr); }
  .world-actions-card { grid-column: auto; }
  .world-actions-card .card-body { display: flex; }
}
@media (max-width: 620px) { .world-loading-chart-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
