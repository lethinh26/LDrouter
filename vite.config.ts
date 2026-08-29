import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: 'src/web',
  publicDir: path.resolve(__dirname, 'src/web/public'),
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@web': path.resolve(__dirname, 'src/web'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:8787',
      '/v1': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
      '/ready': 'http://localhost:8787',
      '/metrics': 'http://localhost:8787',
    },
  },
});
