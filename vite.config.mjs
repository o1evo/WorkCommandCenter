import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createApi } from './server/api.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const reviewsDir = resolve(ROOT, 'reviews');

// Uncommon default port (avoids the usual 3000 / 5173 / 8080 collisions) so the
// address stays free and predictable. Override with WCC_PORT. The optional
// /etc/hosts alias (WCC_HOST, default `wcc`) lets you open http://wcc:7777
// instead of the loopback IP — see bin/setup.mjs.
const PORT = Number(process.env.WCC_PORT) || 7777;

// Mount the file-bridge API as dev-server middleware so the whole tool is one
// process (`npm run review`). Localhost only; no proxy, no external calls.
function apiPlugin() {
  const handle = createApi(reviewsDir);
  return {
    name: 'code-reviews-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const handled = await handle(req, res);
        if (!handled) next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: {
    host: '127.0.0.1',      // loopback only — never bound to a network interface
    port: PORT,
    strictPort: true,        // fail loudly rather than drift to a random port (keeps the URL stable)
    allowedHosts: true,      // accept ANY hostname — safe because we bind to 127.0.0.1 only (not network-reachable),
                             // so you can point any /etc/hosts alias (wcc, wcc.test, …) at it with no config change
  },
});
