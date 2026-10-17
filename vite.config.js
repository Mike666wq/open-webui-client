import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  // API29's stock system image contains WebView 74. Only the Android local
  // shell is downlevelled; desktop retains Vite's existing build defaults.
  build: (process.env.TAURI_ENV_PLATFORM === 'android' || process.env.TAURI_ENV_TARGET_TRIPLE?.includes('android'))
    ? { target: 'chrome74' } : {},
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
});
