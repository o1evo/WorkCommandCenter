// server/serve.mjs — production server.
// Serves the built SPA (dist/) and mounts the file-bridge API in one Node
// process. Run after `npm run build`. For local development use `npm run review`
// (the Vite dev server) instead — this entry exists for hosted deployments.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, normalize, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';

const ROOT    = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST    = process.env.TASKFORGE_DIST_DIR    || join(ROOT, 'dist');
const WORK_DIR = process.env.TASKFORGE_WORK_DIR || join(ROOT, 'work');
const PORT    = Number(process.env.TASKFORGE_PORT) || 7777;
const HOST    = process.env.TASKFORGE_BIND || '127.0.0.1';  // container sets 0.0.0.0

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

const handleApi = createApi(WORK_DIR);

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = normalize(join(DIST, urlPath));
  // keep inside DIST (no path traversal)
  if (filePath !== DIST && !filePath.startsWith(DIST + sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    filePath = join(DIST, 'index.html');  // SPA fallback for unknown paths
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    if (await handleApi(req, res)) return;       // /api/* handled by the file-bridge
    if (req.method === 'GET' || req.method === 'HEAD') return void serveStatic(req, res);
    res.writeHead(404); res.end('not found');
  } catch (err) {
    console.error('[taskforge] request error:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end('internal error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[taskforge] serving ${DIST} + file-bridge on http://${HOST}:${PORT}  (work: ${WORK_DIR})`);
});
