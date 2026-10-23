import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.ts';
import { initializeTheme } from './lib/theme.ts';
import { initializeBackground } from './lib/background.ts';
import './styles/base.css';

initializeTheme();
initializeBackground();
createApp(App).use(router).mount('#app');
