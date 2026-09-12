import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: { outDir: '../dist/client', emptyOutDir: true, target: 'es2022' },
  server: {
    host: true,
    // Tunnel hostnames (loca.lt, trycloudflare, etc.) fail Vite's DNS-rebinding
    // check unless we allow them. Fine for a LAN / hackathon demo.
    allowedHosts: true,
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      // Same-origin /ws in the browser; Vite forwards the upgrade to Express.
      '/ws': { target: 'http://localhost:8787', ws: true },
    },
  },
});
