#!/usr/bin/env node
// Capture resolved WCC threads into a GSD planning tree — the writeback half of
// the GSD↔WCC bridge (see bin/import-gsd.mjs for the read half).
//
// DESIGN (single-writer handoff, not a merge): WCC threads are the conversation
// GSD doesn't have. Rather than edit GSD-owned files — STATE.md is *reconstructed*
// by `gsd-tools state sync`, so anything WCC writes there can be silently clobbered
// — this tool APPENDS marked outcomes to a dedicated, WCC-owned handoff file:
//
//     .planning/WCC-CAPTURES.md
//
// WCC is the sole appender; GSD never reconstructs this file. GSD (or a reviewer
// session) then ingests pending entries into GSD's CANONICAL stores on its own
// terms and checks the box — a producer→consumer queue, decoupled in time:
//
//   **Decision:** <text>       ─▶  PROJECT.md → Key Decisions table
//   **Open question:** <text>  ─▶  .planning/todos/  (via /gsd-capture)
//   **Blocker:** <text>        ─▶  STATE.md → Blockers/Concerns
//
// The marker is the gate: a thread is captured only once a reviewer message states
// a marked outcome — distillation stays a human judgment, not machine summary.
// Idempotent two ways: each message is stamped {captured:true} in thread.json, and
// each entry carries a stable <!-- wcc:<key>#<msg> --> marker so re-runs never
// duplicate even if the stamp is lost.
//
// Usage:
//   node bin/capture-gsd.mjs --id <id> --planning <path> [--workstream <name>] [--dry-run]

import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURES_FILE = 'WCC-CAPTURES.md';

const MARKERS = [
  { re: /\*\*Decision:\*\*\s*(.+)/i, kind: 'Decision', target: 'PROJECT.md → Key Decisions' },
  { re: /\*\*Open question:\*\*\s*(.+)/i, kind: 'Open question', target: '.planning/todos/ (via /gsd-capture)' },
  { re: /\*\*Blocker:\*\*\s*(.+)/i, kind: 'Blocker', target: 'STATE.md → Blockers/Concerns' },
];

const HEADER = `# WCC Captures

> **WCC-owned handoff file — GSD does not reconstruct this.** \`bin/capture-gsd.mjs\`
> appends marked outcomes from WCC review threads here (append-only, idempotent).
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

function resolvePlanningRoot(args) {
  let p = resolve(args.planning === true ? '.planning' : args.planning || '.planning');
  if (!existsSync(p)) die(`no such path: ${p}`);
  if (statSync(p).isDirectory() && basename(p) !== '.planning' && existsSync(join(p, '.planning'))) p = join(p, '.planning');
  if (args.workstream) {
    const ws = join(p, 'workstreams', args.workstream);
    if (!existsSync(ws)) die(`no workstream "${args.workstream}" under ${join(p, 'workstreams')}`);
    return ws;
  }
  return p;
}

function oneLine(s) { return s.replace(/\s+/g, ' ').trim(); }
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
    `      ↳ source: WCC thread \`${key}\` · msg ${msgId} · ${date} · work/${workId}`,
    `      ↳ target: ${target}`,
    '',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id) die('provide --id <wcc work id>.');
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
      for (const m of MARKERS) {
        const hit = msg.text.match(m.re);
        if (!hit) continue;
        const marker = `wcc:${key}#${msg.id}`;
        // Idempotent on the file (stable marker) AND on the thread (captured stamp).
        if (captures.includes(`<!-- ${marker} -->`)) {
          skipped.push({ key, kind: m.kind, reason: 'already in WCC-CAPTURES.md' });
          msg.captured = true;
          continue;
        }
        if (msg.captured) { skipped.push({ key, kind: m.kind, reason: 'thread already stamped captured' }); continue; }
        captures += renderEntry(marker, m.kind, hit[1], key, msg.id, date, workId, m.target);
        msg.captured = true;
        captured.push({ key, kind: m.kind, target: m.target });
      }
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
