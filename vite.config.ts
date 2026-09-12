import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS (self-signed) so the webcam works when other laptops open the game by IP address:
// browsers only expose getUserMedia on localhost or secure origins.
export default defineConfig({
  root: 'client',
  plugins: [basicSsl()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    host: true,
    port: 5173,
    strictPort: true, // fail loudly instead of silently moving to 5174 when an old dev server is still running
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
