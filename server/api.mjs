// The "tiny backend": a request handler for /api/* that reads and writes
// reviews/<id>/thread.json. Mounted into the Vite dev server as middleware
// (see vite.config.mjs) so `npm run review` is a single process. No outbound
// network calls, ever — it only touches the local filesystem.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureAnnotationIds, annotationIds } from './annotations.mjs';

export function createApi(reviewsDir) {
  function reviewPath(id) {
    // id is a slug; reject anything with path separators to be safe.
    if (!/^[a-z0-9-]+$/i.test(id)) return null;
    return join(reviewsDir, id, 'thread.json');
  }

  function load(id) {
    const p = reviewPath(id);
    if (!p || !existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    ensureAnnotationIds(data); // deterministic ids so threads can key per finding
    data._mtime = statSync(p).mtimeMs; // lets the client skip no-op re-renders
    return data;
  }

  function save(id, data) {
    const p = reviewPath(id);
    const copy = { ...data };
    delete copy._mtime;
    // Atomic write: a concurrent reader (the 3s poll, or a reviewer Claude
    // session editing the same file) sees either the old or the new complete
    // file, never a torn one. rename(2) is atomic within a filesystem.
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(copy, null, 2) + '\n');
    renameSync(tmp, p);
  }

  function listReviews() {
    if (!existsSync(reviewsDir)) return [];
    return readdirSync(reviewsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => existsSync(join(reviewsDir, name, 'thread.json')))
      .map((name) => {
        const data = load(name);
        return { id: name, title: data?.review?.title || name };
      });
  }

  function nextId(data, prefix) {
    const all = [
      ...Object.values(data.threads || {}).flat(),
    ];
    return `${prefix}_${all.length + 1}_${Math.round(data._mtime || 0)}`;
  }

  // Returns true if it handled the request.
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return false;

    try {
      // GET /api/reviews — list available reviews
      if (path === '/api/reviews' && req.method === 'GET') {
        return json(res, 200, listReviews());
      }

      // GET /api/review/:id
      let m = path.match(/^\/api\/review\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const data = load(m[1]);
        if (!data) return json(res, 404, { error: 'review not found' });
        return json(res, 200, data);
      }

      // POST /api/review/:id/message  { target: "general"|hunkId, text }
      m = path.match(/^\/api\/review\/([^/]+)\/message$/);
      if (m && req.method === 'POST') {
        const id = m[1];
        const data = load(id);
        if (!data) return json(res, 404, { error: 'review not found' });
        const body = await readBody(req);
        const target = body.target || 'general';
        const text = (body.text || '').trim();
        if (!text) return json(res, 400, { error: 'text is required' });
        const hunkIds = new Set(data.hunks.map((h) => h.id));
        const lineMatch = /^(.+)#L\d+$/.exec(target); // per-line thread: <hunkId>#L<n>
        const known =
          target === 'general' ||
          hunkIds.has(target) || // hunk-level thread
          annotationIds(data).has(target) || // per-finding thread
          (lineMatch && hunkIds.has(lineMatch[1])); // per-line thread
        if (!known) {
          return json(res, 400, { error: `unknown target: ${target}` });
        }
        data.threads[target] = data.threads[target] || [];
        const msg = {
          id: nextId(data, 'm'),
          role: 'author',
          text,
          ts: new Date().toISOString(),
          answered: false,
        };
        data.threads[target].push(msg);
        save(id, data);
        return json(res, 200, msg);
      }

      // POST /api/review/:id/annotations  { target: hunkId, annotations: [...] }
      m = path.match(/^\/api\/review\/([^/]+)\/annotations$/);
      if (m && req.method === 'POST') {
        const id = m[1];
        const data = load(id);
        if (!data) return json(res, 404, { error: 'review not found' });
        const body = await readBody(req);
        const hunk = data.hunks.find((h) => h.id === body.target);
        if (!hunk) return json(res, 400, { error: `unknown hunk: ${body.target}` });
        if (!Array.isArray(body.annotations)) {
          return json(res, 400, { error: 'annotations must be an array' });
        }
        hunk.annotations = body.annotations;
        ensureAnnotationIds(data); // give new annotations stable thread ids
        save(id, data);
        return json(res, 200, hunk.annotations);
      }

      return json(res, 404, { error: 'no such api route' });
    } catch (err) {
      return json(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 4 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
