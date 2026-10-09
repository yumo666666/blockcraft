import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.ts';
import { initializeTheme } from './lib/theme.ts';
import './styles/base.css';

initializeTheme();
createApp(App).use(router).mount('#app');
