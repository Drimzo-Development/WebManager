import { defineConfig } from 'vite';

// The terminal runs in its own page (/console/N, an iframe of the dashboard) with its own build and style sheet: the terminal
// library is large and needs inline styles, which only that page is allowed to use (see ConsoleApi::page).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: '../public/assets/console',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: 'src/console/main.ts',
      output: { entryFileNames: 'console.js', chunkFileNames: 'chunk-[name].js', assetFileNames: 'console[extname]' },
    },
  },
});
