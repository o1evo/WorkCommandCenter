#!/usr/bin/env node
// feature-stream — a supervised-local entrypoint that turns a unit of work into
// a feature worktree + GSD workstream + a live WCC mirror, then lets you drive
// the GSD phases yourself and refresh/capture at each checkpoint.
//
//   GSD's .planning/ is the source of truth. WCC is a REFRESHED MIRROR — the
//   page only updates when you re-run `start`/`refresh`. The mirror direction is
//   a total re-projection from a single writer, so it can be stale but cannot
//   drift; the human decisions flow back the one way, via capture-gsd.
//
// Bring-your-own-launcher seam: if an external launcher already created the
// worktree + GSD workstream, SKIP `start` and just `refresh` the mirror against
// that worktree. `start` is the self-contained path for when nothing else makes
// the worktree for you.
//
// Subcommands:
//   start      worktree + branch off a base, gsd workstream, WCC mirror
//   refresh    re-run the mirror for an existing worktree (the checkpoint)
//   integrate  additive merge the stream branch back into a target branch
//
// Usage:
//   node bin/feature-stream.mjs start --repo <path> --slug <short> \
//        [--base <ref>] [--id <wcc-id>] [--title "..."] [--branch <name>]
//   node bin/feature-stream.mjs refresh --id <wcc-id> --worktree <path> [--workstream <name>] [--base <ref>]
//   node bin/feature-stream.mjs integrate --worktree <path> --into <branch> [--keep-worktree]
//
// Rooting golden rule: GSD resolves .planning/ from cwd. This CLI is
// cwd-independent (it passes explicit paths), but when YOU open a session to run
// the GSD phase loop, root it INSIDE the worktree this prints — never the parent.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..'); // the WCC checkout this CLI ships in

function die(msg) { console.error(`feature-stream: ${msg}`); process.exit(1); }
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

// git, captured. Returns trimmed stdout; throws on non-zero unless allowFail.
function git(cwd, gitArgs, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-C', cwd, ...gitArgs], { encoding: 'utf8' }).trim();
  } catch (e) {
    if (allowFail) return null;
    die(`git ${gitArgs.join(' ')} failed in ${cwd}\n  ${e.stderr?.toString().trim() || e.message}`);
  }
}

// git, streamed (for side-effecting commands the user should see).
function gitLoud(cwd, gitArgs) {
  try {
    execFileSync('git', ['-C', cwd, ...gitArgs], { stdio: 'inherit' });
  } catch {
    die(`git ${gitArgs.join(' ')} failed in ${cwd}`);
  }
}

function repoRoot(p) {
  const root = git(p, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!root) die(`not a git repo: ${p}`);
  return root;
}

function planningExistsAt(ref, root) {
  const out = git(root, ['ls-tree', '-d', ref, '--', '.planning'], { allowFail: true });
  return !!(out && out.trim());
}

// Create the GSD workstream inside the worktree. gsd-tools is part of gsd-core;
// when absent we warn and leave a manual instruction rather than failing — the
// worktree + WCC page are still useful.
function createWorkstream(worktree, slug) {
  const hasGsd = (() => { try { execFileSync('gsd-tools', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (!hasGsd) {
    console.warn(`! gsd-tools not found — skipping workstream create.`);
    console.warn(`  Open a session rooted in the worktree and create the workstream by hand.`);
    return false;
  }
  try {
    execFileSync('gsd-tools', ['workstream', 'create', slug, '--raw'], {
      cwd: worktree, stdio: 'inherit', env: { ...process.env, GSD_WORKSTREAM: slug },
    });
    return true;
  } catch {
    console.warn(`! gsd-tools workstream create "${slug}" failed (may already exist) — continuing.`);
    return false;
  }
}

function importGsd(extra) {
  execFileSync('node', [join(REPO, 'bin', 'import-gsd.mjs'), ...extra], { stdio: 'inherit' });
}

// ── start ────────────────────────────────────────────────────────────────────
function cmdStart(args) {
  if (!args.repo) die('start needs --repo <path-to-repo>');
  if (!args.slug) die('start needs --slug <short>');

  const root = repoRoot(resolve(args.repo));
  const repoName = basename(root);
  const slug = slugify(args.slug === true ? '' : args.slug);
  if (!slug) die('start needs a non-empty --slug');

  const base = (args.base && args.base !== true) ? args.base : 'main';
  if (!planningExistsAt(base, root)) {
    die(`base "${base}" has no .planning/ — GSD is not initialized on it.\n  Initialize GSD on ${repoName} first (gsd-new-project).`);
  }

  const branch = (args.branch && args.branch !== true) ? args.branch : `feature/${slug}`;
  const worktree = join(dirname(root), `${repoName}-${slug}`);
  const wccId = slugify(args.id && args.id !== true ? args.id : slug);
  const title = (args.title && args.title !== true) ? args.title : `${repoName} · ${slug}`;

  console.log(`feature-stream start`);
  console.log(`  repo:      ${root}`);
  console.log(`  base:      ${base}`);
  console.log(`  branch:    ${branch}`);
  console.log(`  worktree:  ${worktree}`);
  console.log(`  workstream:${slug}`);
  console.log(`  wcc id:    ${wccId}\n`);

  // 1. Worktree + branch — idempotent.
  if (existsSync(worktree)) {
    console.log(`✓ worktree already present — reusing`);
  } else {
    git(root, ['worktree', 'prune'], { allowFail: true });
    const branchExists = git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }) !== null;
    const addArgs = branchExists
      ? ['worktree', 'add', worktree, branch]
      : ['worktree', 'add', '-b', branch, worktree, base];
    gitLoud(root, addArgs);
  }

  // 2. GSD workstream (soft-skips without gsd-tools).
  createWorkstream(worktree, slug);

  // 3. WCC mirror.
  importGsd([
    '--planning', join(worktree, '.planning'),
    '--workstream', slug,
    '--id', wccId,
    '--title', title,
    '--repo', worktree,
    '--base', base,
    '--head', 'WORKTREE',
  ]);

  printLoop(worktree, wccId, slug);
}

// ── refresh (the checkpoint mirror) ───────────────────────────────────────────
function cmdRefresh(args) {
  if (!args.worktree) die('refresh needs --worktree <path>');
  if (!args.id) die('refresh needs --id <wcc-id>');
  const worktree = resolve(args.worktree);
  if (!existsSync(join(worktree, '.planning'))) die(`no .planning/ under ${worktree}`);
  const base = (args.base && args.base !== true) ? args.base : 'main';
  const extra = ['--planning', join(worktree, '.planning'), '--id', String(args.id),
    '--repo', worktree, '--base', base, '--head', 'WORKTREE'];
  if (args.workstream && args.workstream !== true) extra.push('--workstream', String(args.workstream));
  importGsd(extra);
  console.log(`\n✓ mirror refreshed for ${args.id}. Review in WCC; mark outcomes in threads, then capture:`);
  console.log(`  node bin/capture-gsd.mjs --id ${args.id} --planning ${join(worktree, '.planning')}`);
}

// ── integrate ─────────────────────────────────────────────────────────────────
function cmdIntegrate(args) {
  if (!args.worktree) die('integrate needs --worktree <path>');
  if (!args.into) die('integrate needs --into <target-branch>');
  const worktree = resolve(args.worktree);
  const root = repoRoot(worktree);
  const into = String(args.into);

  const dirty = git(worktree, ['status', '--porcelain'], { allowFail: true });
  if (dirty) die(`worktree has uncommitted changes — commit or stash first:\n${dirty}`);
  const branch = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);

  console.log(`feature-stream integrate`);
  console.log(`  merging ${branch} → ${into} (additive, --no-ff) in ${root}\n`);
  gitLoud(root, ['checkout', into]);
  gitLoud(root, ['merge', '--no-ff', '--no-edit', branch]);
  console.log(`\n✓ merged ${branch} into ${into}. NOT pushed — review the merge, then push yourself.`);
  if (args['keep-worktree']) {
    console.log(`  worktree kept at ${worktree}`);
  } else {
    git(root, ['worktree', 'remove', worktree], { allowFail: true });
    console.log(`  worktree removed (pass --keep-worktree to retain it).`);
  }
}

function printLoop(worktree, wccId, slug) {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`Supervised loop — you drive GSD; WCC mirrors at each checkpoint:`);
  console.log(`
  1. Open a session ROOTED INSIDE the worktree (golden rule):
       ${worktree}
  2. Run the GSD phase loop. It stops at a fork / phase boundary / failed gate —
     that stop is your checkpoint.
  3. At each checkpoint, refresh the WCC mirror:
       node bin/feature-stream.mjs refresh --id ${wccId} --worktree ${worktree} --workstream ${slug}
     Review on WCC (open id "${wccId}"); discuss in threads.
  4. Mark outcomes in threads with **Decision:** / **Open question:** / **Blocker:**, then capture back to GSD:
       node bin/capture-gsd.mjs --id ${wccId} --planning ${join(worktree, '.planning')}
  5. Answer the fork, resume the loop. At milestone-done, integrate:
       node bin/feature-stream.mjs integrate --worktree ${worktree} --into <target-branch>
`);
  console.log(`Start the app if it isn't up:  npm run review   →  open id "${wccId}"`);
}

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);
switch (cmd) {
  case 'start': cmdStart(args); break;
  case 'refresh': cmdRefresh(args); break;
  case 'integrate': cmdIntegrate(args); break;
  default:
    console.error(`feature-stream: unknown command "${cmd || ''}"`);
    console.error(`  usage: feature-stream <start|refresh|integrate> [--flags]`);
    process.exit(1);
}
