import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { getSafeDirectWsOrigin } from './src/lib/realtime/dev-ws-origin';

// In direct-socket diagnostic mode the browser goes to loopback FastAPI itself.
// Disable only the /api WebSocket proxy, not the REST proxy or Vite HMR.
const directWebSocketMode = getSafeDirectWsOrigin(process.env.VITE_TRISHUL_WS_ORIGIN) !== null;

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: process.env.TRISHUL_API_ORIGIN || 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: !directWebSocketMode,
      },
    },
  },
});
