import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createApi } from './server/api.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const reviewsDir = resolve(ROOT, 'reviews');

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
    host: '127.0.0.1',
    port: 5174,
    strictPort: false,
  },
});
