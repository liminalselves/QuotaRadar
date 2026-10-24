import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root, plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': { target: process.env.QR_DEV_API_URL || 'http://127.0.0.1:3210', ws: true } } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
