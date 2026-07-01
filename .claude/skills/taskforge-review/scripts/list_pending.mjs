#!/usr/bin/env node
// List unanswered author questions in a review thread.
// Usage: node list_pending.mjs --id <review-id> [--root <CodeReviews dir>]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const args = parse(process.argv.slice(2));
// Default root = the repo this skill lives in (…/.claude/skills/taskforge-review/scripts → repo).
// Works whether the skill is used in-repo or via a symlink in ~/.claude/skills (Node resolves it).
const root = args.root || resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
if (!args.id) die('Pass --id <review-id>.');

const path = join(root, 'work', args.id, 'thread.json');
let t;
try { t = JSON.parse(readFileSync(path, 'utf8')); }
catch (e) { die(`Cannot read ${path}: ${e.message}`); }

let n = 0;
for (const [key, msgs] of Object.entries(t.threads || {})) {
  for (const m of msgs) {
    if (m.role === 'author' && !m.answered) {
      console.log(`\n[thread] ${key}  ${labelFor(t, key)}`);
      console.log(`  msg-id: ${m.id}`);
      console.log(`  Q: ${String(m.text).replace(/\s+/g, ' ').slice(0, 300)}`);
      n++;
    }
  }
}
console.log(n ? `\n${n} unanswered question(s).` : 'No unanswered questions.');

// Human label for a thread key: hunk file (hunk-level), file :: finding tag
// (per-annotation), or just the key.
function labelFor(t, key) {
  if (key === 'general') return '(general)';
  const hunk = (t.hunks || []).find((h) => h.id === key);
  if (hunk) return `(${hunk.file} — hunk-level)`;
  for (const h of t.hunks || []) {
    const a = (h.annotations || []).find((x) => x.id === key);
    if (a) return `(${h.file} :: ${a.tag || String(a.note || '').slice(0, 30)})`;
  }
  return '';
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
