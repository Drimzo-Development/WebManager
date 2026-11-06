import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Fixed file names (no hashes): PHP adds a content based ?v= to the URLs, see asset() in app/bootstrap.php.
export default defineConfig({
  plugins: [preact()],
  publicDir: false,
  build: {
    outDir: '../public/assets/app',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: 'src/main.tsx',
      output: { entryFileNames: 'app.js', chunkFileNames: 'chunk-[name].js', assetFileNames: 'app[extname]' },
    },
  },
});
