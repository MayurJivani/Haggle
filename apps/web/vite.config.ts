import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4371}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5273),
    proxy: {
      '/api': api,
      '/healthz': api,
      '/ws': { target: api, ws: true },
    },
  },
});
