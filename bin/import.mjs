#!/usr/bin/env node
// Import a code change into a review thread.json.
//
// Usage:
//   node bin/import.mjs --repo <path> --base <ref> --head <ref> --title "..." [--id <id>] [--seed <file>]
//   node bin/import.mjs --diff <file.diff> --title "..." [--id <id>] [--seed <file>]
//   node bin/import.mjs --id <id> --refresh        # re-diff in place, keep the conversation
//
// Notes:
//   - With --repo we run `git diff <base> <head>` inside that repo. If --base
//     and --head resolve to the same commit (e.g. branch work still staged in
//     the working tree), pass --head WORKTREE to diff the working tree against
//     base instead: `git diff <base>`.
//   - --seed merges curated annotations/threads into matching hunks. See
//     reviews/seeds/*.json for the shape.
//   - --refresh RE-RUNS the diff for an existing review and writes the new hunks,
//     while PRESERVING the live state: annotations (re-attached by hunk id, so
//     resolved/deleted findings and their states carry over), all chat threads,
//     and Log-page comment anchors. Repo/base/head/title default to the existing
//     review, so `--id <id> --refresh` is enough. Use this after each round so the
//     Code Review tab shows current code without losing the discussion. (--force
//     still does a destructive overwrite from the seed.)
//   - Output goes to reviews/<id>/thread.json (gitignored).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiff } from '../server/diff.mjs';
import { ensureAnnotationIds } from '../server/annotations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function getDiff(args) {
  if (args.diff) {
    return readFileSync(resolve(args.diff), 'utf8');
  }
  if (!args.repo) die('Provide --repo <path> (with --base/--head) or --diff <file>.');
  const repo = resolve(args.repo);
  const base = args.base || 'main';
  const head = args.head || 'HEAD';

  // `--head WORKTREE` => diff working tree (staged + unstaged) against base.
  const gitArgs =
    head === 'WORKTREE'
      ? ['diff', base]
      : ['diff', `${base}`, `${head}`];

  try {
    return execFileSync('git', ['-C', repo, ...gitArgs], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    die(`git ${gitArgs.join(' ')} failed in ${repo}:\n${e.message}`);
  }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function nowIso() {
  return new Date().toISOString();
}

function applySeed(review, seedPath) {
  const seed = JSON.parse(readFileSync(resolve(seedPath), 'utf8'));

  // Optional metadata overrides.
  for (const k of ['title', 'repo', 'base', 'head']) {
    if (seed.review && seed.review[k] != null) review.review[k] = seed.review[k];
  }

  // annotations: [{ file, contains?, annotations: [{tag, severity, note}] }]
  // Matches the first hunk whose file matches and whose diff includes `contains`.
  for (const entry of seed.annotations || []) {
    const hunk = findHunk(review.hunks, entry);
    if (!hunk) {
      console.warn(`! seed annotation: no hunk matched ${entry.file} contains=${JSON.stringify(entry.contains)}`);
      continue;
    }
    hunk.annotations.push(...entry.annotations);
  }

  // threads: { "general": [...], "<file|contains>": [...] } where each thread
  // entry may be keyed by "general" or by {file, contains}. To keep the seed
  // readable we accept an array form: [{ target: "general" | {file, contains}, messages: [...] }]
  for (const t of seed.threads || []) {
    let key;
    if (t.target === 'general') {
      key = 'general';
    } else {
      const hunk = findHunk(review.hunks, t.target);
      if (!hunk) {
        console.warn(`! seed thread: no hunk matched ${JSON.stringify(t.target)}`);
        continue;
      }
      key = hunk.id;
    }
    review.threads[key] = review.threads[key] || [];
    for (const m of t.messages) {
      review.threads[key].push({
        id: m.id || `m_${review._seq++}`,
        role: m.role,
        text: m.text,
        ts: m.ts || nowIso(),
        answered: m.role === 'author' ? !!m.answered : true,
      });
    }
  }
}

function findHunk(hunks, { file, contains }) {
  return hunks.find(
    (h) => h.file === file && (!contains || h.diff.includes(contains))
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let id = args.id ? slug(args.id) : null;

  // --refresh: re-diff an existing review in place, preserving the conversation.
  // Backfill repo/base/head/title from the existing review so `--id <id> --refresh`
  // is enough.
  let prev = null;
  if (args.refresh) {
    if (!id) die('--refresh needs --id <id>.');
    const prevPath = join(ROOT, 'reviews', id, 'thread.json');
    if (!existsSync(prevPath)) die(`--refresh: ${prevPath} does not exist — do a normal import first.`);
    prev = JSON.parse(readFileSync(prevPath, 'utf8'));
    args.repo = args.repo || prev.review?.repo;
    args.base = args.base || prev.review?.base;
    args.head = args.head || prev.review?.head;
    args.title = args.title || prev.review?.title;
  }

  const diffText = getDiff(args);
  const parsed = parseDiff(diffText);
  if (parsed.length === 0) die('No hunks found in the diff. Check your refs/paths.');

  const title = args.title || 'Untitled review';
  id = id || slug(title);

  const review = {
    _seq: 1, // internal counter for generating message ids during seeding
    review: {
      id,
      title,
      repo: args.repo ? resolve(args.repo) : (args.diff ? resolve(args.diff) : null),
      base: args.base || (args.diff ? null : 'main'),
      head: args.head || (args.diff ? null : 'HEAD'),
      createdAt: prev?.review?.createdAt || nowIso(),
    },
    hunks: parsed.map((h) => ({
      id: h.id,
      file: h.file,
      range: h.range,
      diff: h.diff,
      annotations: [],
    })),
    threads: { general: [] },
  };

  if (prev) {
    // Carry the LIVE state forward onto the freshly-diffed hunks (the live
    // thread.json — not the seed — is the source of truth after round 1):
    //  - annotations re-attach by hunk id (stable while a file's hunk structure
    //    is unchanged), so resolved/deleted findings + their states carry over;
    //  - threads and Log-page anchors are preserved verbatim. Threads whose
    //    hunk/line keys no longer exist just stop rendering (still in the file).
    const prevAnn = {};
    for (const h of prev.hunks || []) prevAnn[h.id] = h.annotations || [];
    for (const h of review.hunks) if (prevAnn[h.id]) h.annotations = prevAnn[h.id];
    review.threads = prev.threads || review.threads;
    if (prev.anchors) review.anchors = prev.anchors;
  } else if (args.seed) {
    applySeed(review, args.seed);
  }

  ensureAnnotationIds(review); // per-finding thread ids
  delete review._seq;

  const dir = join(ROOT, 'reviews', id);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'thread.json');
  if (existsSync(out) && !args.force && !args.refresh) {
    die(`${out} already exists. Pass --refresh to update the diff (keeps threads + comments + finding states) or --force to overwrite from the seed.`);
  }

  // Atomic write: the app may be polling/serving this file.
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, JSON.stringify(review, null, 2) + '\n');
  renameSync(tmp, out);

  const annCount = review.hunks.reduce((n, h) => n + h.annotations.length, 0);
  const threadCount = Object.keys(review.threads || {}).length;
  console.log(`Wrote ${out}`);
  console.log(`  ${review.hunks.length} hunks across ${new Set(review.hunks.map((h) => h.file)).size} files`);
  console.log(prev ? `  ${annCount} annotations + ${threadCount} threads carried over (refresh)` : `  ${annCount} annotations seeded`);
  console.log(`\nStart the app with:  npm run review`);
  console.log(`Then open the review id:  ${id}`);
}

function die(msg) {
  console.error(`import: ${msg}`);
  process.exit(1);
}

main();
