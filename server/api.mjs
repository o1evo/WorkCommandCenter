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

  // The Claude-authored interactive work-log page for a task (the "Log" tab).
  // Optional — a task may have a review (thread.json) without a page yet.
  function pagePath(id) {
    if (!/^[a-z0-9-]+$/i.test(id)) return null;
    return join(reviewsDir, id, 'Page.jsx');
  }

  // The QA test plan for a task (the "QA Plan" tab) — plain Markdown so it can be
  // copied out and handed to QA. Optional.
  function qaPath(id) {
    if (!/^[a-z0-9-]+$/i.test(id)) return null;
    return join(reviewsDir, id, 'qa-plan.md');
  }

  function load(id) {
    const p = reviewPath(id);
    if (!p || !existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    ensureAnnotationIds(data); // deterministic ids so threads can key per finding
    let mtime = statSync(p).mtimeMs;

    // Attach the bespoke page source so a single poll re-renders on either a
    // thread.json change OR a Claude edit to Page.jsx. _mtime is the max of the
    // two, so the client's mtime-gated re-render fires for whichever changed.
    const pp = pagePath(id);
    if (pp && existsSync(pp)) {
      const pmtime = statSync(pp).mtimeMs;
      data._page = { source: readFileSync(pp, 'utf8'), mtime: pmtime };
      if (pmtime > mtime) mtime = pmtime;
    }

    // The QA plan markdown rides along too, so the same poll re-renders the QA
    // tab when qa-plan.md changes.
    const qp = qaPath(id);
    if (qp && existsSync(qp)) {
      const qmtime = statSync(qp).mtimeMs;
      data._qa = { source: readFileSync(qp, 'utf8'), mtime: qmtime };
      if (qmtime > mtime) mtime = qmtime;
    }

    data._mtime = mtime; // lets the client skip no-op re-renders
    return data;
  }

  function save(id, data) {
    const p = reviewPath(id);
    const copy = { ...data };
    // Strip server-injected transients so they never get persisted into the
    // file (_page is the Page.jsx source attached on load; _mtime is the poll
    // token). Both are recomputed on every load.
    delete copy._mtime;
    delete copy._page;
    delete copy._qa;
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
        return {
          id: name,
          title: data?.review?.title || name,
          hasPage: !!data?._page, // does this task have a bespoke Log page yet?
        };
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
        // A Log page anchors threads to its own sections/ideas with keys it
        // chooses, namespaced `log:<anchor>`. The page owns the anchor space, so
        // we validate only the shape (safe chars), not membership.
        const isLogTarget = /^log:[a-z0-9:_-]+$/i.test(target);
        const known =
          target === 'general' ||
          hunkIds.has(target) || // hunk-level thread
          annotationIds(data).has(target) || // per-finding thread
          (lineMatch && hunkIds.has(lineMatch[1])) || // per-line thread
          isLogTarget; // page-defined work-log thread
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

      // POST /api/review/:id/message-delete  { target, messageId }
      // Remove a single message from a thread (any thread type). When the last
      // message in a thread goes, drop the now-empty thread key so the diff/page
      // shows no stray "💬" marker. Same atomic write as every other mutation.
      m = path.match(/^\/api\/review\/([^/]+)\/message-delete$/);
      if (m && req.method === 'POST') {
        const id = m[1];
        const data = load(id);
        if (!data) return json(res, 404, { error: 'review not found' });
        const body = await readBody(req);
        const target = String(body.target || '');
        const messageId = String(body.messageId || '');
        const thread = data.threads && data.threads[target];
        if (!thread) return json(res, 404, { error: `unknown thread: ${target}` });
        const idx = thread.findIndex((msg) => msg.id === messageId);
        if (idx === -1) return json(res, 404, { error: `unknown message: ${messageId}` });
        thread.splice(idx, 1);
        if (thread.length === 0) delete data.threads[target]; // no empty husks
        save(id, data);
        return json(res, 200, { deleted: messageId, remaining: thread.length });
      }

      // POST /api/review/:id/thread-delete  { target }
      // Remove an entire thread (all its messages) in one shot — the "clear this
      // whole discussion" action. No-op-safe: unknown target just 404s.
      m = path.match(/^\/api\/review\/([^/]+)\/thread-delete$/);
      if (m && req.method === 'POST') {
        const id = m[1];
        const data = load(id);
        if (!data) return json(res, 404, { error: 'review not found' });
        const body = await readBody(req);
        const target = String(body.target || '');
        if (!data.threads || !(target in data.threads)) {
          return json(res, 404, { error: `unknown thread: ${target}` });
        }
        const removed = data.threads[target].length;
        delete data.threads[target];
        save(id, data);
        return json(res, 200, { deleted: target, messages: removed });
      }

      // POST /api/review/:id/anchors  { key, quote, prefix, suffix }
      // Create/refresh a free-selection comment anchor on a Log page. The key
      // is page-namespaced (log:<hash>) and owns its own space; we store the
      // quote + surrounding context so the highlight can be re-located on later
      // renders even after Claude edits the page (fuzzy re-attach).
      m = path.match(/^\/api\/review\/([^/]+)\/anchors$/);
      if (m && req.method === 'POST') {
        const id = m[1];
        const data = load(id);
        if (!data) return json(res, 404, { error: 'review not found' });
        const body = await readBody(req);
        const key = String(body.key || '');
        if (!/^log:[a-z0-9:_-]+$/i.test(key)) {
          return json(res, 400, { error: `bad anchor key: ${key}` });
        }
        const quote = String(body.quote || '').slice(0, 2000);
        if (!quote) return json(res, 400, { error: 'quote is required' });
        data.anchors = data.anchors || {};
        const existing = data.anchors[key] || {};
        data.anchors[key] = {
          quote,
          prefix: String(body.prefix || '').slice(0, 200),
          suffix: String(body.suffix || '').slice(0, 200),
          state: existing.state || 'open',
          createdAt: existing.createdAt || new Date().toISOString(),
        };
        save(id, data);
        return json(res, 200, { key, anchor: data.anchors[key] });
      }

      // POST /api/review/:id/anchor-state  { key, state }
      m = path.match(/^\/api\/review\/([^/]+)\/anchor-state$/);
      if (m && req.method === 'POST') {
        const id = m[1];
        const data = load(id);
        if (!data) return json(res, 404, { error: 'review not found' });
        const body = await readBody(req);
        const key = String(body.key || '');
        const state = String(body.state || '');
        if (!['open', 'resolved', 'hidden'].includes(state)) {
          return json(res, 400, { error: `bad state: ${state}` });
        }
        if (!data.anchors || !data.anchors[key]) {
          return json(res, 404, { error: `unknown anchor: ${key}` });
        }
        data.anchors[key].state = state;
        save(id, data);
        return json(res, 200, { key, state });
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
