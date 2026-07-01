#!/usr/bin/env node
// Hermetic smoke test for the GSD bridge (bin/import-gsd.mjs + bin/capture-gsd.mjs).
// No test framework: runs the tools against test/fixtures/gsd-planning, asserts the
// contract, and exits non-zero on any failure. Run with `npm run test:gsd`.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Babel from '@babel/standalone';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'test/fixtures/gsd-planning/.planning');
const ID = 'gsd-smoketest';
const WORK = join(ROOT, 'work', ID);
const WS_ID = 'gsd-smoketest-ws';
const WS_WORK = join(ROOT, 'work', WS_ID);

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };
const node = (file, args) => execFileSync('node', [join(ROOT, 'bin', file), ...args], { encoding: 'utf8' });

// Compile AND render a Page.jsx the way src/components/PageRuntime.jsx does — but with a
// component-walking React stub that actually executes every function component (PlanView,
// TaskCard, QaMatrix, …) and accumulates rendered text. A null-returning stub would let a
// broken component slip through (it did once: `Markdown is not defined`). Returns the
// rendered text; throws if any component throws.
function renderPageText(src) {
  const norm = src.replace(/^\s*import\s.*$/gm, '').replace(/export\s+default\s+/g, '');
  const { code } = Babel.transform(norm, { presets: ['react'], filename: 'Page.jsx' });
  let out = '';
  const pushKids = (kids) => {
    for (const k of kids) {
      if (Array.isArray(k)) pushKids(k);
      else if (typeof k === 'string' || typeof k === 'number') out += k + ' ';
    }
  };
  const React = {
    createElement: (type, props, ...kids) => {
      if (typeof type === 'function') { type({ ...(props || {}), children: kids }); return null; }
      pushKids(kids);
      return null;
    },
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {}, useRef: () => ({ current: null }),
    useMemo: (f) => f(), useCallback: (f) => f,
  };
  const taskforge = {
    Markdown: ({ text }) => { out += (text || '') + ' '; return null; },
    Thread: () => null, CodeRef: () => null, openCode: () => false,
  };
  const Page = new Function('React', `const {useState,useEffect,useRef,useMemo,useCallback}=React;\n${code}\n;return Page;`)(React);
  Page({ taskforge });
  return out;
}
function compiles(src) {
  try { renderPageText(src); return true; }
  catch (e) { console.log('    render error:', e.message); return false; }
}

const sandbox = mkdtempSync(join(tmpdir(), 'gsd-smoke-'));
try {
  // ── READ half ──────────────────────────────────────────────────────────────
  console.log('import-gsd:');
  node('import-gsd.mjs', ['--planning', FIXTURE, '--id', ID, '--title', 'Smoke']);
  ok(existsSync(join(WORK, 'Page.jsx')), 'Page.jsx written');
  ok(existsSync(join(WORK, 'thread.json')), 'thread.json written');
  ok(existsSync(join(WORK, 'qa-plan.md')), 'qa-plan.md written');

  const page = readFileSync(join(WORK, 'Page.jsx'), 'utf8');
  ok(compiles(page), 'Page.jsx compiles + renders through the runtime pipeline (walks components)');
  ok(page.includes('01-foo') && page.includes('02-bar'), 'both phases embedded');
  ok(page.includes('"log:phase:" + ph.name'), 'per-phase discussion threads emitted (provenance hook)');
  ok(page.includes('Built the foo subsystem'), 'phase blurb lifted from SUMMARY');

  // Structured rich-render coverage: the PLAN <task> and the UAT table must actually render
  // (not just be embedded as JSON). renderPageText executes PlanView/TaskCard/QaMatrix.
  const rendered = renderPageText(page);
  ok(rendered.includes('Wire the bar widget'), 'PLAN.md rendered as a task card (task name in output)');
  ok(rendered.includes('FOO-01'), 'plan requirement chips rendered');
  ok(rendered.includes('PASS') && rendered.includes('PENDING'), 'UAT rendered as a QA grid with result cells');
  ok(rendered.includes('Requirement traceability'), 'requirement-traceability grid rendered');
  ok(rendered.includes('no UAT'), 'a declared-but-unverified requirement (FOO-02) is flagged "no UAT"');
  ok(rendered.includes('Execution waves') && rendered.includes('Wave 1') && rendered.includes('Wave 2'),
     'execution-wave view groups phases by wave');
  ok(/depends on:\s+01-foo/.test(rendered), 'wave view renders the depends_on edge (02-bar → 01-foo)');

  const qa = readFileSync(join(WORK, 'qa-plan.md'), 'utf8');
  ok(qa.includes('Bar renders for a fresh tenant'), 'QA plan seeded from latest phase UAT');

  // ── WRITEBACK half — both routing paths ──────────────────────────────────────
  console.log('capture-gsd:');
  const thread = {
    review: { id: ID, title: 'Smoke', repo: null, base: null, head: null, createdAt: '2026-01-01T00:00:00.000Z' },
    hunks: [], threads: {
      'log:phase:01-foo': [
        { id: 'a', role: 'reviewer', text: '**Decision:** Foo uses the singular convention.', ts: '2026-01-01T01:00:00.000Z', answered: true },
      ],
      'log:gsd-discussion': [
        { id: 'b', role: 'reviewer', text: '**Decision:** A global, non-phase decision.', ts: '2026-01-01T01:01:00.000Z', answered: true },
      ],
      'log:phase:02-bar': [
        { id: 'c', role: 'reviewer', text: 'Sounds right.\n\n**Decision:** Bar ships behind a flag.\n\n**Open question:** Who owns the flag rollout?', ts: '2026-01-01T01:02:00.000Z', answered: true },
      ],
    },
  };
  writeFileSync(join(WORK, 'thread.json'), JSON.stringify(thread, null, 2) + '\n');

  cpSync(FIXTURE, join(sandbox, '.planning'), { recursive: true });
  node('capture-gsd.mjs', ['--id', ID, '--planning', join(sandbox, '.planning')]);

  const caps = readFileSync(join(sandbox, '.planning', 'TaskForge-CAPTURES.md'), 'utf8');
  ok(/phases\/01-foo\/01-CONTEXT\.md \(phase decision\)/.test(caps), 'phase-anchored decision routes to the phase CONTEXT');
  ok(/PROJECT\.md → Key Decisions/.test(caps), 'global decision routes to PROJECT Key Decisions');
  ok(/Bar ships behind a flag/.test(caps) && /Who owns the flag rollout/.test(caps),
     'a message with BOTH a Decision and an Open question captures both (kind-specific marker)');
  ok(readFileSync(join(sandbox, '.planning', 'STATE.md'), 'utf8') === readFileSync(join(FIXTURE, 'STATE.md'), 'utf8'),
     'capture leaves GSD-reconstructed STATE.md byte-identical');

  // ── workstream auto-detect: STATE lives under workstreams/<name>/, no --workstream flag ──
  console.log('workstream mode:');
  const wsPlan = join(sandbox, 'wsproj', '.planning');
  mkdirSync(join(wsPlan, 'workstreams', 'alpha', 'phases', '01-init'), { recursive: true });
  writeFileSync(join(wsPlan, 'workstreams', 'alpha', 'STATE.md'),
    '---\nmilestone: v1\nmilestone_name: Alpha Stream\nstatus: active\n---\n# State\n');
  writeFileSync(join(wsPlan, 'active-workstream'), 'alpha\n');
  node('import-gsd.mjs', ['--planning', wsPlan, '--id', WS_ID]);
  const wsPage = readFileSync(join(WS_WORK, 'Page.jsx'), 'utf8');
  ok(/"workstream":\s*"alpha"/.test(wsPage), 'workstream auto-detected via active-workstream (no --workstream flag)');
  ok(/Alpha Stream/.test(wsPage), 'auto-detected workstream STATE.md parsed (milestone_name)');
  ok(/"importedAt":/.test(wsPage), 'page carries an importedAt staleness stamp');

  // Idempotency: a second run captures nothing new.
  const before = caps.length;
  node('capture-gsd.mjs', ['--id', ID, '--planning', join(sandbox, '.planning')]);
  ok(readFileSync(join(sandbox, '.planning', 'TaskForge-CAPTURES.md'), 'utf8').length === before, 'second capture is idempotent (no duplicates)');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
  rmSync(WS_WORK, { recursive: true, force: true });
}

console.log(failures ? `\nFAIL — ${failures} assertion(s) failed` : '\nPASS — all assertions green');
process.exit(failures ? 1 : 0);
