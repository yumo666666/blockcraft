import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    // 把测试页面的 origin 设成面板自己，这样相对路径就是同源请求，不会被 CORS 拦
    environmentOptions: { happyDOM: { url: 'http://127.0.0.1:8081/' } },
    include: ['src/__tests__/**/*.spec.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    testTimeout: 90000,
    hookTimeout: 90000,
  },
});
