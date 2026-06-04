#!/usr/bin/env node
// Import a code change into a review thread.json.
//
// Usage:
//   node bin/import.mjs --repo <path> --base <ref> --head <ref> --title "..." [--id <id>] [--seed <file>]
//   node bin/import.mjs --diff <file.diff> --title "..." [--id <id>] [--seed <file>]
//
// Notes:
//   - With --repo we run `git diff <base> <head>` inside that repo. If --base
//     and --head resolve to the same commit (e.g. branch work still staged in
//     the working tree), pass --head WORKTREE to diff the working tree against
//     base instead: `git diff <base>`.
//   - --seed merges curated annotations/threads into matching hunks. See
//     reviews/seeds/*.json for the shape.
//   - Output goes to reviews/<id>/thread.json (gitignored).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  const diffText = getDiff(args);
  const parsed = parseDiff(diffText);
  if (parsed.length === 0) die('No hunks found in the diff. Check your refs/paths.');

  const title = args.title || 'Untitled review';
  const id = slug(args.id || title);

  const review = {
    _seq: 1, // internal counter for generating message ids during seeding
    review: {
      id,
      title,
      repo: args.repo ? resolve(args.repo) : (args.diff ? resolve(args.diff) : null),
      base: args.base || (args.diff ? null : 'main'),
      head: args.head || (args.diff ? null : 'HEAD'),
      createdAt: nowIso(),
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

  if (args.seed) applySeed(review, args.seed);
  ensureAnnotationIds(review); // per-finding thread ids
  delete review._seq;

  const dir = join(ROOT, 'reviews', id);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'thread.json');
  if (existsSync(out) && !args.force) {
    die(`${out} already exists. Pass --force to overwrite.`);
  }
  writeFileSync(out, JSON.stringify(review, null, 2) + '\n');

  const annCount = review.hunks.reduce((n, h) => n + h.annotations.length, 0);
  console.log(`Wrote ${out}`);
  console.log(`  ${review.hunks.length} hunks across ${new Set(review.hunks.map((h) => h.file)).size} files`);
  console.log(`  ${annCount} annotations seeded`);
  console.log(`\nStart the app with:  npm run review`);
  console.log(`Then open the review id:  ${id}`);
}

function die(msg) {
  console.error(`import: ${msg}`);
  process.exit(1);
}

main();
