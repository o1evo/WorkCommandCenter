#!/usr/bin/env node
// Append a reviewer reply to a review thread — race-safe.
//
// The CodeReviews app backend ALSO writes thread.json (on each posted question)
// with no locking, so a naive read→modify→write from here can clobber a question
// the user just posted (lost update). This script minimizes that window:
// re-read immediately before writing, and write atomically (temp file + rename).
//
// Usage:
//   node answer.mjs --id <review-id> --msg <author-msg-id|next> --file <reply.txt> [--thread <key>] [--root <dir>]
//   node answer.mjs --id <review-id> --msg next --text "reply..." [--thread <key>]
//
// --msg next  picks the oldest unanswered author message (in --thread if given,
//             else across all threads). The reply lands in that message's thread.
// Reply body supports Markdown fenced ```lang code blocks + inline `code`
// (rendered + Prism-highlighted in the app). Prefer --file for replies with code.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const args = parse(process.argv.slice(2));
// Default root = the repo this skill lives in (see list_pending.mjs); --root overrides.
const root = args.root || resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
if (!args.id) die('Pass --id <review-id>.');
if (!args.msg) die('Pass --msg <author-msg-id|next>.');
const text = args.file ? readFileSync(args.file, 'utf8').replace(/\n$/, '') : args.text;
if (!text) die('Pass --file <path> or --text "...".');

const path = join(root, 'work', args.id, 'thread.json');

// --- re-read immediately before mutating (shrinks the lost-update window) ---
const t = JSON.parse(readFileSync(path, 'utf8'));
t.threads = t.threads || {};

const { key, msg } = locate(t, args.thread, args.msg);
if (!msg) die(`No matching author message (thread=${args.thread || 'any'}, msg=${args.msg}).`);

msg.answered = true;
t.threads[key] = t.threads[key] || [];
t.threads[key].push({
  id: 'r_' + Date.now(),
  role: 'reviewer',
  text,
  ts: new Date().toISOString(),
  answered: true,
});

// --- atomic write: never let a reader (the 3s poll) see a half-written file ---
const tmp = path + '.tmp';
writeFileSync(tmp, JSON.stringify(t, null, 2) + '\n');
renameSync(tmp, path);
console.log(`answered ${msg.id} in thread "${key}"; reviewer reply appended.`);

function locate(t, threadKey, msgSel) {
  const keys = threadKey ? [threadKey] : Object.keys(t.threads);
  if (msgSel === 'next') {
    let best = null;
    for (const k of keys) {
      for (const m of t.threads[k] || []) {
        if (m.role === 'author' && !m.answered) {
          if (!best || (m.ts || '') < (best.msg.ts || '')) best = { key: k, msg: m };
        }
      }
    }
    return best || {};
  }
  for (const k of keys) {
    const m = (t.threads[k] || []).find((x) => x.id === msgSel);
    if (m) return { key: k, msg: m };
  }
  return {};
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) o[k] = true;
      else { o[k] = v; i++; }
    }
  }
  return o;
}
function die(m) { console.error('error: ' + m); process.exit(1); }
