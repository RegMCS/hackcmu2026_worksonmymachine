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
    // Honour PORT so parallel worktrees can each run their own dev server;
    // unset it and this is the usual 5173.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      // The relay shares the API port. `ws: true` is what makes Vite forward the
      // HTTP Upgrade rather than answering it as a normal request - without it
      // the socket fails to connect in dev only, which reads as a broken relay.
      // Path must track WS_PATH in shared/net.ts.
      '/ws': { target: 'http://localhost:8787', ws: true, changeOrigin: true },
    },
  },
});
