#!/usr/bin/env node
// Capture resolved TaskForge threads into a GSD planning tree — the writeback half of
// the GSD↔TaskForge bridge (see bin/import-gsd.mjs for the read half).
//
// DESIGN (single-writer handoff, not a merge): TaskForge threads are the conversation
// GSD doesn't have. Rather than edit GSD-owned files — STATE.md is *reconstructed*
// by `gsd-tools state sync`, so anything TaskForge writes there can be silently clobbered
// — this tool APPENDS marked outcomes to a dedicated, TaskForge-owned handoff file:
//
//     .planning/TaskForge-CAPTURES.md
//
// TaskForge is the sole appender; GSD never reconstructs this file. GSD (or a reviewer
// session) then ingests pending entries into GSD's CANONICAL stores on its own
// terms and checks the box — a producer→consumer queue, decoupled in time:
//
//   **Decision:** <text>       ─▶  PROJECT.md → Key Decisions table
//   **Open question:** <text>  ─▶  .planning/todos/  (via /gsd-capture)
//   **Blocker:** <text>        ─▶  STATE.md → Blockers/Concerns
//
// The marker is the gate: a thread is captured only once a reviewer message states
// a marked outcome — distillation stays a human judgment, not machine summary.
// Idempotent via a stable per-(thread, message, KIND) marker
// <!-- taskforge:<key>#<msg>:<kind> --> on each entry, so re-runs never duplicate AND a single
// message that states multiple outcomes (e.g. a Decision AND an Open question) yields one
// entry per kind. (The msg is also stamped {captured:true} for the UI, but the file marker
// is the sole idempotency source.) MIGRATION: pre-fix markers were kind-agnostic
// <!-- taskforge:<key>#<msg> -->; on first run after upgrading, a previously-captured outcome may
// be re-appended once under the new kind-suffixed marker, then is idempotent thereafter.
//
// Usage:
//   node bin/capture-gsd.mjs --id <id> --planning <path> [--workstream <name>] [--dry-run]

import { readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURES_FILE = 'TaskForge-CAPTURES.md';

const MARKERS = [
  { re: /\*\*Decision:\*\*\s*(.+)/i, kind: 'Decision', target: 'PROJECT.md → Key Decisions' },
  { re: /\*\*Open question:\*\*\s*(.+)/i, kind: 'Open question', target: '.planning/todos/ (via /gsd-capture)' },
  { re: /\*\*Blocker:\*\*\s*(.+)/i, kind: 'Blocker', target: 'STATE.md → Blockers/Concerns' },
];

// Route an outcome to its GSD target. A thread anchored to a phase
// (key `log:phase:<dir>`, emitted by import-gsd's per-phase discussion threads)
// files into THAT phase's artifact — so a decision about phase 06 lands in its
// CONTEXT, not the global bucket. Everything else (general / code-review / free
// log comments) keeps the global, kind-based target.
function targetFor(marker, key) {
  const ph = key.match(/^log:phase:(.+)$/);
  if (!ph) return marker.target;
  const name = ph[1];
  const num = (name.match(/^(\d+)/) || [])[1];
  const ctx = num ? `phases/${name}/${num}-CONTEXT.md` : `phases/${name}/ (CONTEXT)`;
  // Blockers stay centrally tracked in STATE, tagged with the phase; decisions
  // and open questions about a phase belong in that phase's CONTEXT.
  return marker.kind === 'Blocker'
    ? `STATE.md → Blockers/Concerns (phase ${name})`
    : `${ctx} (phase ${marker.kind.toLowerCase()})`;
}

const HEADER = `# TaskForge Captures

> **TaskForge-owned handoff file — GSD does not reconstruct this.** \`bin/capture-gsd.mjs\`
> appends marked outcomes from TaskForge review threads here (append-only, idempotent).
> GSD or a reviewer session **ingests** each pending entry into its canonical store
> (see *target*), then ticks the box. This decouples the conversation surface from
> GSD's own files so neither clobbers the other.
>
> **To ingest:** for each \`[ ]\` entry, fold it into the listed target (a Decision →
> PROJECT.md Key Decisions row; an Open question → \`/gsd-capture\`; a Blocker →
> STATE.md), then change \`[ ]\` to \`[x]\`. Do not delete entries — the checkbox is
> the audit trail.

`;

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
function die(msg) { console.error(`capture-gsd: ${msg}`); process.exit(1); }

// Mirrors import-gsd's resolver: explicit --workstream wins; else auto-detect a
// workstream-mode tree via the gitignored active-workstream pointer or a sole workstream.
function resolvePlanningRoot(args) {
  let p = resolve(args.planning === true ? '.planning' : args.planning || '.planning');
  if (!existsSync(p)) die(`no such path: ${p}`);
  if (statSync(p).isDirectory() && basename(p) !== '.planning' && existsSync(join(p, '.planning'))) p = join(p, '.planning');
  const wsDir = join(p, 'workstreams');
  let ws = args.workstream === true ? null : args.workstream;
  if (!ws && existsSync(wsDir)) {
    const names = readdirSync(wsDir).filter((d) => { try { return statSync(join(wsDir, d)).isDirectory(); } catch { return false; } });
    let active = ''; try { active = readFileSync(join(p, 'active-workstream'), 'utf8').trim(); } catch {}
    if (active && names.includes(active)) ws = active;
    else if (names.length === 1) ws = names[0];
    else if (names.length > 1) die(`workstream mode: ${names.length} workstreams (${names.join(', ')}) and no --workstream / active-workstream. Pass --workstream <name>.`);
  }
  if (ws) {
    const wsPath = join(wsDir, ws);
    if (!existsSync(wsPath)) die(`no workstream "${ws}" under ${wsDir}`);
    return wsPath;
  }
  return p;
}

function oneLine(s) { return s.replace(/\s+/g, ' ').trim(); }
function kindSlug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function writeAtomic(out, contents) {
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, out);
}

// One handoff entry: a checkbox line + provenance + ingest target, fingerprinted
// with a stable HTML-comment marker so re-runs are idempotent on the file too.
function renderEntry(marker, kind, text, key, msgId, date, workId, target) {
  return [
    `- [ ] **${kind}** — ${oneLine(text)} <!-- ${marker} -->`,
    `      ↳ source: TaskForge thread \`${key}\` · msg ${msgId} · ${date} · work/${workId}`,
    `      ↳ target: ${target}`,
    '',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id) die('provide --id <taskforge work id>.');
  if (!args.planning) die('provide --planning <path to .planning dir or project root>.');
  const dryRun = !!args['dry-run'];
  const workId = String(args.id);

  const threadPath = join(ROOT, 'work', workId, 'thread.json');
  if (!existsSync(threadPath)) die(`no thread.json at ${threadPath}`);
  const review = JSON.parse(readFileSync(threadPath, 'utf8'));

  const planningRoot = resolvePlanningRoot(args);
  const capturesPath = join(planningRoot, CAPTURES_FILE);
  let captures = existsSync(capturesPath) ? readFileSync(capturesPath, 'utf8') : HEADER;

  const date = new Date().toISOString().slice(0, 10);
  const captured = [];
  const skipped = [];

  for (const [key, msgs] of Object.entries(review.threads || {})) {
    for (const msg of msgs) {
      if (msg.role !== 'reviewer') continue;
      let any = false;
      for (const m of MARKERS) {
        const hit = msg.text.match(m.re);
        if (!hit) continue;
        // Per-(thread, message, KIND) marker — so a message stating both a **Decision:**
        // and an **Open question:** produces both entries (not just the first). The file
        // marker is the sole idempotency gate; msg.captured below is an informational stamp.
        const marker = `taskforge:${key}#${msg.id}:${kindSlug(m.kind)}`;
        if (captures.includes(`<!-- ${marker} -->`)) {
          skipped.push({ key, kind: m.kind, reason: 'already in TaskForge-CAPTURES.md' });
          any = true;
          continue;
        }
        const target = targetFor(m, key);
        captures += renderEntry(marker, m.kind, hit[1], key, msg.id, date, workId, target);
        captured.push({ key, kind: m.kind, target });
        any = true;
      }
      if (any) msg.captured = true;
    }
  }

  if (captured.length === 0 && skipped.length === 0) {
    console.log('No marked outcomes (**Decision:** / **Open question:** / **Blocker:**) to capture.');
    return;
  }

  console.log(dryRun ? '— DRY RUN (no files written) —\n' : '');
  for (const c of captured) console.log(`  ✓ ${c.kind.padEnd(13)} → ${c.target}`);
  for (const s of skipped) console.log(`  • skipped ${s.kind} (${s.key}): ${s.reason}`);

  if (dryRun) { console.log(`\nRun without --dry-run to append to ${capturesPath} and stamp threads captured.`); return; }
  if (captured.length) {
    writeAtomic(capturesPath, captures);
    writeAtomic(threadPath, JSON.stringify(review, null, 2) + '\n');
    console.log(`\nAppended ${captured.length} entry(ies) to ${capturesPath}`);
    console.log(`Stamped ${captured.length} thread message(s) captured in ${threadPath}`);
    console.log(`\nNext: ingest the [ ] entries into their GSD targets, then tick the boxes.`);
  }
}

main();
