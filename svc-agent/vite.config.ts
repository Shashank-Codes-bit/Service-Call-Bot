import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/web/dealer',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../../../dist/dealer', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001', '/auth': 'http://localhost:3001' },
  },
});
