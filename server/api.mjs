// The "tiny backend": a request handler for /api/* that reads and writes
// work/<id>/thread.json. Mounted into the Vite dev server as middleware
// (see vite.config.mjs) so `npm run review` is a single process. No outbound
// network calls, ever — it only touches the local filesystem.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureAnnotationIds, annotationIds } from './annotations.mjs';
import { liveDiff } from './livediff.mjs';

export function createApi(workDir) {
  // Per-review change-token cache for the live diff. Maps id -> { hash, mtime }.
  // We re-run `git diff` on every poll (cheap, single-user, local), but only
  // mint a NEW poll token (mtime) when the diff text actually changed — so the
  // client's mtime-gated re-render fires on real code changes and skips the
  // no-op polls. In-memory only; a server restart just causes one extra render.
  const liveCache = new Map();
  function reviewPath(id) {
    // id is a slug; reject anything with path separators to be safe.
    if (!/^[a-z0-9-]+$/i.test(id)) return null;
    return join(workDir, id, 'thread.json');
  }

  // The Claude-authored interactive work-log page for a task (the "Log" tab).
  // Optional — a task may have a review (thread.json) without a page yet.
  function pagePath(id) {
    if (!/^[a-z0-9-]+$/i.test(id)) return null;
    return join(workDir, id, 'Page.jsx');
  }

  // The QA test plan for a task (the "QA Plan" tab) — plain Markdown so it can be
  // copied out and handed to QA. Optional.
  function qaPath(id) {
    if (!/^[a-z0-9-]+$/i.test(id)) return null;
    return join(workDir, id, 'qa-plan.md');
  }

  function load(id, { live = false } = {}) {
    const p = reviewPath(id);
    if (!p || !existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    let mtime = statSync(p).mtimeMs;

    // Stream the diff live from the repo instead of serving the hunks baked
    // into thread.json. The persisted hunks stay the durable annotation store;
    // here we overlay the CURRENT `git diff` and re-attach annotations by hunk
    // id — the same contract as `import.mjs --refresh`, now automatic on every
    // poll. (--diff-file imports have no repo, so they keep the snapshot.)
    if (live && data.review && data.review.repo) {
      try {
        const fresh = liveDiff(data.review);
        if (fresh) {
          const prevAnn = {};
          for (const h of data.hunks || []) prevAnn[h.id] = h.annotations || [];
          data.hunks = fresh.hunks.map((h) => ({
            id: h.id,
            file: h.file,
            range: h.range,
            diff: h.diff,
            annotations: prevAnn[h.id] || [], // carry findings forward by hunk id
          }));
          // Bump the poll token only when the diff text actually changed.
          const cached = liveCache.get(id);
          let liveMtime;
          if (cached && cached.hash === fresh.hash) {
            liveMtime = cached.mtime;
          } else {
            liveMtime = Date.now();
            liveCache.set(id, { hash: fresh.hash, mtime: liveMtime });
          }
          if (liveMtime > mtime) mtime = liveMtime;
        }
      } catch (err) {
        // Repo moved / bad ref / git missing — fall back to the persisted
        // snapshot rather than 500, and tell the client the diff may be stale.
        data._liveError = String(err && err.message ? err.message : err);
      }
    }

    ensureAnnotationIds(data); // deterministic ids so threads can key per finding

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
    delete copy._liveError;
    // Atomic write: a concurrent reader (the 3s poll, or a reviewer Claude
    // session editing the same file) sees either the old or the new complete
    // file, never a torn one. rename(2) is atomic within a filesystem.
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(copy, null, 2) + '\n');
    renameSync(tmp, p);
  }

  // Per-page UI metadata (display name override, hidden, starred, project) lives in
  // a single WCC-owned, gitignored file — NOT in thread.json (which is the proprietary
  // review data). Keyed by review id. Absent file → no metadata, everything default.
  const metaPath = join(workDir, '..', '.wcc', 'pages.json');
  const META_FIELDS = ['name', 'hidden', 'starred', 'project', 'tags', 'order'];
  // The file holds both the per-page metadata (`pages`) and the workspace-wide tag
  // catalog (`tags`: [{ name, color }]). Per-page `tags` are just names referencing
  // the catalog, so a rename/delete cascades across pages.
  function loadDoc() {
    try { const d = JSON.parse(readFileSync(metaPath, 'utf8')); return d && typeof d === 'object' ? d : {}; } catch { return {}; }
  }
  function loadMeta() { return loadDoc().pages || {}; }
  function loadTags() { const t = loadDoc().tags; return Array.isArray(t) ? t : []; }
  function writeDoc(doc) {
    try { mkdirSync(join(workDir, '..', '.wcc'), { recursive: true }); } catch { /* exists */ }
    const out = {};
    if (Array.isArray(doc.tags) && doc.tags.length) out.tags = doc.tags; // catalog first for readability
    out.pages = doc.pages || {};
    const tmp = `${metaPath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
    renameSync(tmp, metaPath);
  }
  function saveMeta(pages) { const doc = loadDoc(); doc.pages = pages; writeDoc(doc); }
  function saveTags(tags) { const doc = loadDoc(); doc.tags = tags; writeDoc(doc); }

  function listReviews() {
    if (!existsSync(workDir)) return [];
    const meta = loadMeta();
    return readdirSync(workDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => existsSync(join(workDir, name, 'thread.json')))
      .map((name) => {
        const data = load(name);
        const m = meta[name] || {};
        return {
          id: name,
          title: data?.review?.title || name,
          hasPage: !!data?._page, // does this task have a bespoke Log page yet?
          name: m.name || null,    // display-name override (falls back to title in the UI)
          hidden: !!m.hidden,
          starred: !!m.starred,
          project: m.project || null,
          tags: Array.isArray(m.tags) ? m.tags : [],
          order: typeof m.order === 'number' ? m.order : null,
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

      // POST /api/page-meta { id, patch: { name?, hidden?, starred?, project?, tags?, order? } }
      // Update a page's UI metadata in .wcc/pages.json. Falsy/empty values clear the
      // field (and an emptied page is dropped) so the file stays lean.
      if (path === '/api/page-meta' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.id || '');
        if (!/^[a-z0-9-]+$/i.test(id)) return json(res, 400, { error: 'bad id' });
        const patch = body.patch || {};
        const pages = loadMeta();
        const cur = { ...(pages[id] || {}) };
        for (const k of META_FIELDS) {
          if (!(k in patch)) continue;
          const v = patch[k];
          // Falsy/empty clears the field so the file stays lean. For tags, an
          // empty array is the "no tags" state; order 0 is a legitimate value
          // (first), so only null clears it.
          if (v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0)) delete cur[k];
          else cur[k] = v;
        }
        if (Object.keys(cur).length) pages[id] = cur; else delete pages[id];
        saveMeta(pages);
        return json(res, 200, { id, meta: pages[id] || {} });
      }

      // GET /api/tags — the workspace-wide tag catalog [{ name, color }].
      if (path === '/api/tags' && req.method === 'GET') {
        return json(res, 200, loadTags());
      }

      // POST /api/tags — manage the catalog.
      //   { op: 'upsert', original: name|null, name, color }  create (original null) or rename/recolor
      //   { op: 'delete', name }                              remove from catalog + every page
      // A rename cascades to each page's `tags` so references never dangle.
      if (path === '/api/tags' && req.method === 'POST') {
        const body = await readBody(req);
        const op = body.op;
        const tags = loadTags();
        const has = (n) => tags.some((t) => t.name.toLowerCase() === String(n).toLowerCase());
        if (op === 'upsert') {
          const name = String(body.name || '').trim();
          const color = String(body.color || '').trim();
          if (!name) return json(res, 400, { error: 'tag name is required' });
          if (name.length > 32) return json(res, 400, { error: 'tag name too long' });
          if (!/^#[0-9a-f]{3,8}$/i.test(color)) return json(res, 400, { error: 'bad color' });
          const original = body.original ? String(body.original) : null;
          if (original == null) {
            if (has(name)) return json(res, 409, { error: 'a tag with that name already exists' });
            tags.push({ name, color });
            saveTags(tags);
          } else {
            const idx = tags.findIndex((t) => t.name === original);
            if (idx < 0) return json(res, 404, { error: 'tag not found' });
            if (name.toLowerCase() !== original.toLowerCase() && has(name)) {
              return json(res, 409, { error: 'a tag with that name already exists' });
            }
            tags[idx] = { name, color };
            saveTags(tags);
            if (name !== original) { // cascade the rename across every page
              const pages = loadMeta();
              let touched = false;
              for (const id of Object.keys(pages)) {
                const pt = pages[id].tags;
                if (Array.isArray(pt) && pt.includes(original)) {
                  pages[id].tags = pt.map((t) => (t === original ? name : t));
                  touched = true;
                }
              }
              if (touched) saveMeta(pages);
            }
          }
          return json(res, 200, loadTags());
        }
        if (op === 'delete') {
          const name = String(body.name || '');
          saveTags(tags.filter((t) => t.name !== name));
          const pages = loadMeta(); // strip it from every page that referenced it
          let touched = false;
          for (const id of Object.keys(pages)) {
            const pt = pages[id].tags;
            if (Array.isArray(pt) && pt.includes(name)) {
              const left = pt.filter((t) => t !== name);
              if (left.length) pages[id].tags = left; else delete pages[id].tags;
              touched = true;
            }
          }
          if (touched) saveMeta(pages);
          return json(res, 200, loadTags());
        }
        return json(res, 400, { error: 'bad op' });
      }

      // GET /api/review/:id
      let m = path.match(/^\/api\/review\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const data = load(m[1], { live: true });
        if (!data) return json(res, 404, { error: 'review not found' });
        return json(res, 200, data);
      }

      // POST /api/review/:id/message  { target: "general"|hunkId, text }
      m = path.match(/^\/api\/review\/([^/]+)\/message$/);
      if (m && req.method === 'POST') {
        const id = m[1];
        const data = load(id, { live: true }); // resolve hunk targets against current diff
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
        const anchor = {
          quote,
          prefix: String(body.prefix || '').slice(0, 200),
          suffix: String(body.suffix || '').slice(0, 200),
          state: existing.state || 'open',
          createdAt: existing.createdAt || new Date().toISOString(),
        };
        // Exact-offset anchoring: persist the selection's character span so the
        // highlight reattaches deterministically. Preserve prior offsets on update
        // when the caller doesn't resend them.
        const startVal = body.start != null ? body.start : existing.start;
        const endVal = body.end != null ? body.end : existing.end;
        if (startVal != null && Number.isFinite(+startVal)) anchor.start = Math.trunc(+startVal);
        if (endVal != null && Number.isFinite(+endVal)) anchor.end = Math.trunc(+endVal);
        data.anchors[key] = anchor;
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

      // POST /api/review/:id/anchor-delete  { key }
      // Remove a free-selection comment entirely — drop the anchor AND its thread.
      // (anchor-state 'hidden' only stops it rendering but keeps the data; this is
      // the real "delete this highlight comment".)
      m = path.match(/^\/api\/review\/([^/]+)\/anchor-delete$/);
      if (m && req.method === 'POST') {
        const id = m[1];
        const data = load(id);
        if (!data) return json(res, 404, { error: 'review not found' });
        const body = await readBody(req);
        const key = String(body.key || '');
        const hadAnchor = !!(data.anchors && data.anchors[key]);
        const hadThread = !!(data.threads && data.threads[key]);
        if (!hadAnchor && !hadThread) return json(res, 404, { error: `unknown anchor: ${key}` });
        if (data.anchors) delete data.anchors[key];
        if (data.threads) delete data.threads[key];
        save(id, data);
        return json(res, 200, { deleted: key });
      }

      // POST /api/review/:id/annotations  { target: hunkId, annotations: [...] }
      m = path.match(/^\/api\/review\/([^/]+)\/annotations$/);
      if (m && req.method === 'POST') {
        const id = m[1];
        const data = load(id, { live: true }); // attach findings to current-diff hunks
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
