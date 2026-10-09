import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/next/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    open: '/next/',
    proxy: {
      '/api': {
        target: process.env.TRISHUL_API_ORIGIN || 'http://127.0.0.1:8980',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
