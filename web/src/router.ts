import { createRouter, createWebHashHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'overview', component: () => import('./pages/Overview.vue') },
    { path: '/new', name: 'websites', component: () => import('./pages/MinecraftSites.vue') },
    { path: '/create', name: 'wizard-create', component: () => import('./pages/Wizard.vue') },
    { path: '/import', name: 'wizard-import', component: () => import('./pages/Wizard.vue') },
    { path: '/tasks', name: 'tasks', component: () => import('./pages/Tasks.vue') },
    { path: '/files', name: 'files', component: () => import('./pages/Files.vue') },
    { path: '/settings', name: 'settings', component: () => import('./pages/Settings.vue') },
    { path: '/w/:id', name: 'world', component: () => import('./pages/World.vue'), props: true },
    { path: '/w/:id/console', name: 'console', component: () => import('./pages/Console.vue'), props: true },
    { path: '/w/:id/backups', name: 'backups', component: () => import('./pages/Backups.vue'), props: true },
    { path: '/w/:id/files', redirect: '/files' },
    { path: '/w/:id/mods', name: 'mods', component: () => import('./pages/Mods.vue'), props: true },
    { path: '/w/:id/players', name: 'players', component: () => import('./pages/Players.vue'), props: true },
    { path: '/w/:id/performance/:metric', name: 'performance-detail', component: () => import('./pages/PerformanceDetail.vue'), props: true },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
