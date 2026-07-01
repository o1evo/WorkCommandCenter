#!/usr/bin/env node
// Import a GSD (`gsd-core`) planning tree into a TaskForge task view.
//
// GSD (https://github.com/open-gsd/gsd-core) is a phase-based process engine: it
// writes plain-Markdown artifacts under `.planning/` (STATE.md, ROADMAP.md, and
// per-phase PLAN/SUMMARY/UAT files). It has no human-facing surface. TaskForge is that
// surface. This adapter maps a `.planning/` tree onto TaskForge's existing `work/<id>/`
// files — nothing GSD-specific touches the server or the page runtime:
//
//   .planning/STATE.md (+ ROADMAP, phases/*) ─▶ work/<id>/Page.jsx   (Log tab)
//   {latest phase}-UAT.md                     ─▶ work/<id>/qa-plan.md (QA tab)
//   --repo/--base/--head git diff (optional)  ─▶ work/<id>/thread.json hunks (Code Review)
//
// Usage:
//   node bin/import-gsd.mjs --planning <path/to/.planning> [--workstream <name>] \
//        --id <id> [--title "..."] [--repo <path> --base <ref> --head <ref>]
//
//   --planning   path to a `.planning` dir (or a project root containing one)
//   --workstream pick `.planning/workstreams/<name>` instead of the top level. OPTIONAL —
//                in workstream mode it auto-detects (active-workstream pointer, or a sole
//                workstream); only needed to disambiguate when several exist
//   --repo/--base/--head  optional: populate the Code Review tab from a git diff
//                (re-uses the same live-diff machinery as bin/import.mjs)
//
// Re-run any time to refresh the snapshot (preserves the conversation + anchors,
// like `import.mjs --refresh`). The Code Review tab streams live on its own.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiff } from '../server/diff.mjs';
import { ensureAnnotationIds } from '../server/annotations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

function die(msg) { console.error(`import-gsd: ${msg}`); process.exit(1); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function nowIso() { return new Date().toISOString(); }
function read(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }

// ── Resolve the planning root ────────────────────────────────────────────────
// Accept either a `.planning` dir directly or a project root that contains one.
// WORKSTREAM mode: when STATE/ROADMAP live under .planning/workstreams/<name>/, pick
// the workstream — an explicit --workstream wins; else AUTO-DETECT via the gitignored
// `.planning/active-workstream` pointer, or a sole workstream; else fail with a clear
// message listing the choices (don't silently import an empty top-level root).
function resolvePlanningRoot(args) {
  let p = resolve(args.planning === true ? '.planning' : args.planning || '.planning');
  if (!existsSync(p)) die(`no such path: ${p}`);
  if (statSync(p).isDirectory() && basename(p) !== '.planning' && existsSync(join(p, '.planning'))) {
    p = join(p, '.planning');
  }
  const wsDir = join(p, 'workstreams');
  let ws = args.workstream === true ? null : args.workstream; // bare --workstream → auto-detect
  if (!ws && existsSync(wsDir)) {
    const names = readdirSync(wsDir).filter((d) => { try { return statSync(join(wsDir, d)).isDirectory(); } catch { return false; } });
    const active = (read(join(p, 'active-workstream')) || '').trim(); // gitignored, branch-local pointer GSD writes
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

// ── Minimal YAML-ish frontmatter parser (zero-dep; STATE.md is shallow) ───────
// Handles `key: value` and one level of nesting (e.g. the `progress:` block).
function parseFrontmatter(md) {
  if (!md) return { data: {}, body: md || '' };
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: md };
  const data = {};
  let parent = null;
  for (const raw of m[1].split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indented = /^\s+\S/.test(raw);
    const kv = raw.match(/^\s*([\w.-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim().replace(/^["']|["']$/g, '');
    if (indented && parent) {
      data[parent][key] = coerce(val);
    } else if (val === '') {
      data[key] = {}; parent = key;
    } else {
      data[key] = coerce(val); parent = null;
    }
  }
  return { data, body: m[2] };
}
function coerce(v) {
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}

// ── Enumerate phases (workstream layout) or quick tasks (top-level layout) ────
function collectPhases(planningRoot) {
  const phasesDir = join(planningRoot, 'phases');
  if (!existsSync(phasesDir)) return [];
  return readdirSync(phasesDir)
    .filter((d) => statSync(join(phasesDir, d)).isDirectory())
    .sort()
    .map((d) => {
      const dir = join(phasesDir, d);
      const files = readdirSync(dir);
      const has = (suffix) => files.some((f) => f.toUpperCase().endsWith(suffix));
      const summaryFile = files.find((f) => f.toUpperCase().endsWith('SUMMARY.MD'));
      const summary = summaryFile ? firstParagraph(read(join(dir, summaryFile))) : null;
      // Stream the phase's own artifacts so they're reviewable in-page (PLAN/RESEARCH/
      // CONTEXT/SPEC/UAT/REVIEW/SUMMARY). Ordered so plans read first, then research.
      const order = (f) => {
        const u = f.toUpperCase();
        const idx = ['BRIEF.MD', 'PLAN.MD', 'CONTEXT.MD', 'SPEC.MD', 'RESEARCH.MD', 'UAT.MD', 'REVIEW.MD', 'SUMMARY.MD']
          .findIndex((s) => u.endsWith(s));
        return idx === -1 ? 99 : idx;
      };
      const docs = files
        .filter((f) => f.toLowerCase().endsWith('.md'))
        .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
        .map((f) => {
          const text = read(join(dir, f));
          if (!text) return null;
          const u = f.toUpperCase();
          let kind = 'prose', plan = null, matrix = null;
          if (u.endsWith('PLAN.MD')) { kind = 'plan'; plan = parsePlan(text); }
          else if (u.endsWith('UAT.MD')) { matrix = parseQaMatrix(text); kind = matrix.length ? 'uat' : 'prose'; }
          return { name: f, text, kind, plan, matrix };
        })
        .filter(Boolean);
      return {
        name: d,
        title: d.replace(/^\d+-/, '').replace(/-/g, ' '),
        artifacts: {
          spec: has('SPEC.MD'), context: has('CONTEXT.MD'), plan: has('PLAN.MD'),
          summary: has('SUMMARY.MD'), uat: has('UAT.MD'), review: has('REVIEW.MD'),
        },
        blurb: summary,
        docs,
      };
    });
}

function firstParagraph(md) {
  if (!md) return null;
  const lines = md.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (l.startsWith('#')) { if (out.length) break; else continue; }
    if (!l.trim()) { if (out.length) break; else continue; }
    out.push(l.trim());
  }
  return out.join(' ').slice(0, 400) || null;
}

// ── Parse GSD's structured artifacts into rich-render data ────────────────────
// GSD .md files are NOT prose — PLAN.md has YAML frontmatter + <task> XML, UAT.md
// has GFM tables. We parse that structure so the page can render React (cards,
// grids) instead of dumping markdown. Prose (RESEARCH/BRIEF/SUMMARY) stays markdown.
function unesc(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function splitFm(md) {
  const m = (md || '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : { fm: '', body: md || '' };
}
function fmScalar(fm, key) {
  const m = fm.match(new RegExp('^\\s*' + key + ':\\s*(.+)$', 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}
function fmInlineArray(fm, key) {
  const m = fm.match(new RegExp('^\\s*' + key + ':\\s*\\[(.*)\\]\\s*$', 'm'));
  return m ? m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : null;
}
// Items of a YAML block list under `label:` — works at any indent / nesting depth
// (stops at the first line that isn't a `- ` item, i.e. the next key).
function fmList(fm, label) {
  const lines = fm.split('\n');
  const i = lines.findIndex((l) => new RegExp('^\\s*' + label + ':\\s*$').test(l));
  if (i === -1) return [];
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const m = lines[j].match(/^\s*-\s+(.*)$/);
    if (!m) break;
    out.push(m[1].trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}
function parsePlan(md) {
  const { fm, body } = splitFm(md);
  const tasks = [];
  const re = /<task\b([^>]*)>([\s\S]*?)<\/task>/g;
  let t;
  while ((t = re.exec(body))) {
    const attrs = t[1] || '', inner = t[2] || '';
    const grab = (tag) => {
      const m = inner.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>'));
      return m ? m[1].trim() : '';
    };
    const at = (k) => { const m = attrs.match(new RegExp(k + '="([^"]*)"')); return m ? m[1] : ''; };
    tasks.push({
      name: unesc(grab('name')), type: at('type'), tdd: at('tdd') === 'true', gate: at('gate'),
      files: unesc(grab('files')), action: unesc(grab('action')),
      verify: unesc(grab('automated') || grab('human-check') || grab('verify')),
      done: unesc(grab('done')),
    });
  }
  return {
    wave: fmScalar(fm, 'wave'), type: fmScalar(fm, 'type'), autonomous: fmScalar(fm, 'autonomous'),
    depends_on: fmInlineArray(fm, 'depends_on') || fmList(fm, 'depends_on'),
    requirements: fmInlineArray(fm, 'requirements') || fmList(fm, 'requirements'),
    files_modified: fmList(fm, 'files_modified'),
    truths: fmList(fm, 'truths'), artifacts: fmList(fm, 'artifacts'), prohibitions: fmList(fm, 'prohibitions'),
    tasks,
  };
}
// GFM tables → {title, headers, rows}[] so a UAT/matrix renders as a real grid.
function parseQaMatrix(md) {
  const { body } = splitFm(md);
  const lines = body.split('\n');
  const tables = [];
  let heading = null;
  const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (h) { heading = h[1].trim(); continue; }
    if (/^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const headers = cells(lines[i]);
      const rows = [];
      let j = i + 2;
      for (; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) rows.push(cells(lines[j]));
      tables.push({ title: heading, headers, rows });
      i = j - 1;
    }
  }
  return tables;
}

// Collect the codebase-map docs GSD's map-codebase writes under .planning/codebase/.
// Generic: any *.md there is surfaced verbatim (STACK, ARCHITECTURE, CONCERNS, …).
function collectCodebase(planningRoot) {
  const dir = join(planningRoot, 'codebase');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort()
    .map((f) => ({ name: f, text: read(join(dir, f)) }))
    .filter((d) => d.text);
}

// Requirement traceability: REQ-ID → which phases declare it (PLAN.md frontmatter
// `requirements:`) and which phases' UAT reference it. Surfaces unverified requirements
// (declared in a plan, never named in any UAT) at a glance.
function buildTraceability(phases) {
  const reqs = {}; // id → { phases:Set, uat:Set }
  const uatDocs = []; // { phase, text }
  for (const ph of phases) {
    for (const doc of ph.docs || []) {
      if (doc.kind === 'plan' && doc.plan) {
        for (const id of doc.plan.requirements || []) (reqs[id] ||= { phases: new Set(), uat: new Set() }).phases.add(ph.name);
      }
      if (/UAT\.MD$/i.test(doc.name) && doc.text) uatDocs.push({ phase: ph.name, text: doc.text });
    }
  }
  for (const id of Object.keys(reqs)) {
    // Word-boundary match so REQ-1 doesn't also match REQ-10.
    const re = new RegExp('(^|[^A-Za-z0-9-])' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9-]|$)');
    for (const u of uatDocs) if (re.test(u.text)) reqs[id].uat.add(u.phase);
  }
  return Object.keys(reqs).sort().map((id) => ({
    id, phases: [...reqs[id].phases].sort(), uat: [...reqs[id].uat].sort(),
  }));
}

// Execution-order view: group phases by their PLAN's `wave` (lower runs first), carrying
// `depends_on` per phase. Returns groups sorted by wave, unscheduled (no wave) last.
function buildWaves(phases) {
  const items = [];
  for (const ph of phases) {
    const pd = (ph.docs || []).find((d) => d.kind === 'plan' && d.plan);
    if (!pd) continue;
    items.push({
      phase: ph.name,
      wave: pd.plan.wave != null ? String(pd.plan.wave) : null,
      type: pd.plan.type || null,
      dependsOn: pd.plan.depends_on || [],
    });
  }
  const groups = {};
  for (const it of items) { const k = it.wave == null ? '∞' : it.wave; (groups[k] ||= []).push(it); }
  const keys = Object.keys(groups).sort((a, b) => (a === '∞' ? 1 : b === '∞' ? -1 : Number(a) - Number(b)));
  return keys.map((k) => ({ wave: k === '∞' ? null : k, items: groups[k] }));
}

// Find the most recent phase UAT file to seed the QA Plan tab.
function latestUat(planningRoot) {
  const phasesDir = join(planningRoot, 'phases');
  if (!existsSync(phasesDir)) return null;
  const dirs = readdirSync(phasesDir).filter((d) => statSync(join(phasesDir, d)).isDirectory()).sort().reverse();
  for (const d of dirs) {
    const dir = join(phasesDir, d);
    const uat = readdirSync(dir).find((f) => f.toUpperCase().endsWith('UAT.MD'));
    if (uat) return { phase: d, text: read(join(dir, uat)) };
  }
  return null;
}

// ── Optional Code Review diff (reuses bin/import.mjs's git path) ──────────────
function gitDiff(args) {
  if (!args.repo) return [];
  const repo = resolve(args.repo);
  const base = args.base || 'main';
  const head = args.head || 'HEAD';
  const gitArgs = head === 'WORKTREE' ? ['diff', base] : ['diff', base, head];
  try {
    const text = execFileSync('git', ['-C', repo, ...gitArgs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return parseDiff(text).map((h) => ({ id: h.id, file: h.file, range: h.range, diff: h.diff, annotations: [] }));
  } catch (e) {
    console.warn(`! git ${gitArgs.join(' ')} failed in ${repo}; Code Review tab will be empty.\n  ${e.message}`);
    return [];
  }
}

// ── Page.jsx generation ───────────────────────────────────────────────────────
// Embeds the parsed GSD snapshot as a JSON literal and renders it with the same
// taskforge runtime contract every Log page uses: function Page({ taskforge }), no imports.
function renderPage(gsd, custom) {
  const json = JSON.stringify(gsd, null, 2)
    .replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16)); // JS string-literal safety
  const base = `// GSD planning view for "${gsd.title}" — generated by bin/import-gsd.mjs.
// Source of truth is the .planning/ tree; re-run the importer to refresh.
// Authoring contract: function Page({ taskforge }) — no imports/exports; React + hooks in scope.

const GSD = ${json};

// Colors come from the app's theme via CSS variables, so generated pages follow the
// active theme (navy / dark-neutral / light) for free — no hardcoded palette.
const C = { text: 'var(--text)', muted: 'var(--muted)', border: 'var(--border)', panel: 'var(--panel)', panel2: 'var(--panel-2)', link: 'var(--link)', ok: 'var(--resolved)', warn: 'var(--medium)' };

/*__CUSTOM_INJECT__*/
function GsdPlanView({ taskforge }) {
  const { Markdown, Thread } = taskforge;
  const p = GSD.progress || {};
  const pct = typeof p.percent === 'number' ? p.percent : null;

  return (
    <div style={{ display: 'grid', gap: 22, color: C.text }}>
      <div>
        <Row style={{ flexWrap: 'wrap' }}>
          <Pill>{GSD.milestone || 'GSD'}</Pill>
          {GSD.workstream && <span style={{ ...tag, color: C.link, borderColor: C.link }}>⌥ {GSD.workstream}</span>}
          <span style={{ fontWeight: 600 }}>{GSD.milestoneName || GSD.title}</span>
          <span style={{ ...tag, color: C.warn, borderColor: C.warn }}>{GSD.status || 'in progress'}</span>
          <span style={{ marginLeft: 'auto', color: C.muted, fontSize: 12 }}>updated {GSD.lastUpdated || '—'}</span>
        </Row>
        <div style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>
          GSD planning view · <code>{GSD.planningPath}</code>
          {GSD.importedAt && <> · <span title="this page is a snapshot — re-run import-gsd to refresh">imported {GSD.importedAt.slice(0, 16).replace('T', ' ')} — re-run to refresh</span></>}
        </div>
      </div>

      {pct !== null && (
        <div>
          <Row style={{ marginBottom: 6 }}>
            <span style={{ fontWeight: 600 }}>Progress</span>
            <span style={{ color: C.muted }}>
              {p.completed_phases ?? '?'}/{p.total_phases ?? '?'} phases · {p.completed_plans ?? '?'}/{p.total_plans ?? '?'} plans
            </span>
            <span style={{ marginLeft: 'auto', fontWeight: 600 }}>{pct}%</span>
          </Row>
          <div style={{ height: 8, borderRadius: 6, background: C.panel2, overflow: 'hidden' }}>
            <div style={{ width: pct + '%', height: '100%', background: pct >= 100 ? C.ok : C.link }} />
          </div>
        </div>
      )}

      {GSD.stoppedAt && (
        <div style={{ ...card, borderLeft: \`3px solid \${C.warn}\` }}>
          <strong>Stopped at:</strong> {GSD.stoppedAt}
          {GSD.resume && <div style={{ color: C.muted, marginTop: 4 }}>Resume: <code>{GSD.resume}</code></div>}
        </div>
      )}

      {GSD.diagram && (
        <Section title="Architecture" defaultOpen>
          <img src={GSD.diagram} alt="architecture diagram"
               style={{ width: '100%', height: 'auto', background: '#0d1117', borderRadius: 8, border: '1px solid ' + C.border }} />
        </Section>
      )}

      {GSD.phases.length > 0 && (
        <Section title={\`Phases (\${GSD.phases.length})\`} defaultOpen>
          <p style={{ marginTop: 0, color: C.muted, fontSize: 13 }}>
            Each phase has its own discussion thread. A <strong>Decision</strong> /
            <strong> Open question</strong> / <strong>Blocker</strong> raised in it is captured back to
            <em> that phase's</em> GSD artifact (phase-scoped routing), not the global bucket.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            {GSD.phases.map((ph) => (
              <div key={ph.name} style={card}>
                <Row style={{ flexWrap: 'wrap' }}>
                  <code style={{ fontWeight: 600 }}>{ph.name}</code>
                  <Row style={{ flexWrap: 'wrap', gap: 4, marginLeft: 'auto' }}>
                    {Object.entries(ph.artifacts).filter(([, v]) => v).map(([k]) => (
                      <span key={k} style={{ ...tag, color: C.muted, borderColor: C.border }}>{k}</span>
                    ))}
                  </Row>
                </Row>
                {ph.blurb && <div style={{ color: C.muted, marginTop: 4 }}>{ph.blurb}</div>}
                {ph.docs && ph.docs.length > 0 && (
                  <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                    {ph.docs.map((doc) => (
                      <Section key={doc.name} title={doc.name} defaultOpen={doc.kind === 'plan' || doc.kind === 'uat'}>
                        {doc.kind === 'plan' ? <PlanView plan={doc.plan} raw={doc.text} Markdown={Markdown} />
                          : doc.kind === 'uat' ? <QaMatrix tables={doc.matrix} raw={doc.text} Markdown={Markdown} />
                          : <Markdown text={doc.text} />}
                      </Section>
                    ))}
                  </div>
                )}
                <Thread target={"log:phase:" + ph.name} title={"Discuss phase " + ph.name} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {GSD.traceability && GSD.traceability.length > 0 && (
        <Section title={\`Requirement traceability (\${GSD.traceability.length})\`} defaultOpen>
          <p style={{ marginTop: 0, color: C.muted, fontSize: 13 }}>
            Each requirement (from a phase PLAN's <code>requirements:</code>) → the phases that
            implement it and the phases whose UAT names it. A requirement with <strong>no UAT</strong>
            is declared but unverified.
          </p>
          <table style={tbl}>
            <thead><tr>{['requirement', 'phases', 'UAT'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {GSD.traceability.map((r) => (
                <tr key={r.id}>
                  <td style={td}><code style={{ color: C.link }}>{r.id}</code></td>
                  <td style={td}>
                    <Row style={{ flexWrap: 'wrap', gap: 4 }}>
                      {r.phases.map((p) => <span key={p} style={{ ...tag, color: C.muted, borderColor: C.border, textTransform: 'none' }}>{p}</span>)}
                    </Row>
                  </td>
                  <td style={td}>
                    {r.uat.length > 0
                      ? <span style={{ color: C.ok, fontWeight: 600 }}>✓ {r.uat.join(', ')}</span>
                      : <span style={{ color: C.warn }}>— no UAT</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {GSD.waves && GSD.waves.length > 0 && (
        <Section title="Execution waves" defaultOpen>
          <p style={{ marginTop: 0, color: C.muted, fontSize: 13 }}>
            Phase plans grouped by <code>wave</code> (lower runs first); each phase's
            <code> depends_on</code> is shown on the right.
          </p>
          <div style={{ display: 'grid', gap: 12 }}>
            {GSD.waves.map((grp, gi) => (
              <div key={gi}>
                <div style={lbl}>{grp.wave == null ? 'Unscheduled' : 'Wave ' + grp.wave}</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {grp.items.map((it) => (
                    <div key={it.phase} style={card}>
                      <Row style={{ flexWrap: 'wrap' }}>
                        <code style={{ fontWeight: 600 }}>{it.phase}</code>
                        {it.type && <span style={{ ...tag, color: C.muted, borderColor: C.border }}>{it.type}</span>}
                        {it.dependsOn.length > 0 && (
                          <span style={{ marginLeft: 'auto', color: C.muted, fontSize: 12 }}>depends on: {it.dependsOn.join(', ')}</span>
                        )}
                      </Row>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {GSD.codebase && GSD.codebase.length > 0 && (
        <Section title={\`Codebase Map (\${GSD.codebase.length})\`} defaultOpen>
          <p style={{ marginTop: 0, color: C.muted, fontSize: 13 }}>
            Streamed from <code>.planning/codebase/</code> (GSD onboarding map). Re-run the importer to refresh.
            Each doc is collapsible; select any text to drop an inline 💬 comment for the reviewer.
          </p>
          <div style={{ display: 'grid', gap: 8 }}>
            {GSD.codebase.map((doc) => (
              <Section key={doc.name} title={doc.name}>
                <Markdown text={doc.text} />
              </Section>
            ))}
          </div>
        </Section>
      )}

      <Section title="Discuss this plan with the reviewer" defaultOpen>
        <p style={{ marginTop: 0, color: C.muted }}>
          Ask the reviewer session anything about the current GSD state, a phase plan, or what to do next.
          You can also select any text on this page to drop an inline 💬 comment.
        </p>
        <Thread target="log:gsd-discussion" title="GSD planning discussion" />
      </Section>

      {GSD.state && (
        <Section title="STATE.md">
          <Markdown text={GSD.state} />
        </Section>
      )}
      {GSD.roadmap && (
        <Section title="ROADMAP.md">
          <Markdown text={GSD.roadmap} />
        </Section>
      )}
    </div>
  );
}

function Section({ title, children, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <section style={{ border: \`1px solid \${C.border}\`, borderRadius: 8, background: C.panel }}>
      <div onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '10px 14px' }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>{title}</h2>
        <span style={{ marginLeft: 'auto', color: C.muted }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && <div style={{ padding: '0 14px 14px' }}>{children}</div>}
    </section>
  );
}
function Pill({ children }) {
  return <span style={{ border: \`1px solid \${C.link}\`, color: C.link, borderRadius: 20, padding: '2px 10px', fontSize: 12, fontWeight: 600 }}>{children}</span>;
}
function Row({ children, style, onClick }) {
  return <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, ...style }}>{children}</div>;
}

// Rich structured render of a GSD PLAN.md (frontmatter chips + must-haves + task cards).
function PlanView({ plan, raw, Markdown }) {
  if (!plan) return <Markdown text={raw} />;
  const chip = (txt, col) => <span style={{ ...tag, color: col || C.muted, borderColor: col || C.border }}>{txt}</span>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <Row style={{ flexWrap: 'wrap', gap: 6 }}>
        {plan.wave && chip('wave ' + plan.wave, C.link)}
        {plan.type && chip(plan.type)}
        {plan.autonomous && chip(plan.autonomous === 'true' ? 'autonomous' : 'checkpoint', plan.autonomous === 'true' ? C.ok : C.warn)}
        {(plan.requirements || []).map((r) => <span key={r} style={{ ...tag, color: C.link, borderColor: C.link }}>{r}</span>)}
      </Row>
      {plan.depends_on && plan.depends_on.length > 0 && (
        <div style={{ color: C.muted, fontSize: 12 }}>depends on: {plan.depends_on.join(', ')}</div>
      )}
      {plan.files_modified && plan.files_modified.length > 0 && (
        <div>
          <div style={lbl}>Files</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {plan.files_modified.map((f) => <code key={f} style={{ ...tag, textTransform: 'none', color: C.text, borderColor: C.border }}>{f}</code>)}
          </div>
        </div>
      )}
      {plan.truths && plan.truths.length > 0 && (
        <div>
          <div style={lbl}>Must be true</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: C.text }}>
            {plan.truths.map((t, i) => <li key={i} style={{ marginBottom: 2 }}>{t}</li>)}
          </ul>
        </div>
      )}
      {plan.tasks && plan.tasks.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={lbl}>Tasks ({plan.tasks.length})</div>
          {plan.tasks.map((t, i) => <TaskCard key={i} task={t} Markdown={Markdown} />)}
        </div>
      )}
      <Section title="Raw PLAN.md"><Markdown text={raw} /></Section>
    </div>
  );
}

function TaskCard({ task, Markdown }) {
  const [open, setOpen] = useState(false);
  const isCheckpoint = (task.type || '').indexOf('checkpoint') === 0 || task.gate === 'blocking';
  return (
    <div style={{ ...card, borderLeft: '3px solid ' + (isCheckpoint ? C.warn : C.border) }}>
      <Row onClick={() => setOpen((v) => !v)} style={{ cursor: 'pointer', flexWrap: 'wrap', gap: 6 }}>
        <span style={{ color: C.muted }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 600 }}>{task.name}</span>
        <Row style={{ marginLeft: 'auto', gap: 4, flexWrap: 'wrap' }}>
          {task.tdd && <span style={{ ...tag, color: C.ok, borderColor: C.ok }}>tdd</span>}
          {isCheckpoint && <span style={{ ...tag, color: C.warn, borderColor: C.warn }}>checkpoint</span>}
        </Row>
      </Row>
      {open && (
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          {task.action && <div><div style={lbl}>Action</div><Markdown text={task.action} /></div>}
          {task.verify && <div><div style={lbl}>Verify</div><pre style={preBox}>{task.verify}</pre></div>}
          {task.done && <div><div style={lbl}>Done when</div><div style={{ color: C.muted }}>{task.done}</div></div>}
        </div>
      )}
    </div>
  );
}

function QaResult({ text }) {
  const t = text || '';
  let col = C.muted;
  if (/PASS/i.test(t) || t.indexOf('✅') >= 0) col = C.ok;
  else if (/FAIL/i.test(t) || t.indexOf('❌') >= 0) col = '#f85149';
  else if (/PENDING/i.test(t) || t.indexOf('⏳') >= 0) col = C.warn;
  else if (/PARTIAL/i.test(t) || t.indexOf('🟡') >= 0) col = '#d29922';
  return <span style={{ color: col, fontWeight: 600 }}>{t}</span>;
}

// Rich structured render of a GSD UAT/QA matrix (GFM tables → colored result grid).
function QaMatrix({ tables, raw, Markdown }) {
  if (!tables || !tables.length) return <Markdown text={raw} />;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {tables.map((tb, ti) => {
        const ri = tb.headers.findIndex((h) => /result|status/i.test(h));
        return (
          <div key={ti}>
            {tb.title && <div style={{ fontWeight: 600, marginBottom: 6 }}>{tb.title}</div>}
            <table style={tbl}>
              <thead><tr>{tb.headers.map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {tb.rows.map((r, i) => (
                  <tr key={i}>{r.map((c, j) => <td key={j} style={td}>{j === ri ? <QaResult text={c} /> : c}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <Section title="Raw UAT.md"><Markdown text={raw} /></Section>
    </div>
  );
}
const card = { border: \`1px solid \${C.border}\`, borderRadius: 8, padding: '8px 12px', background: C.panel2 };
const tag = { border: '1px solid', borderRadius: 4, padding: '0 6px', fontSize: 11, textTransform: 'uppercase' };
const lbl = { fontWeight: 600, fontSize: 11, textTransform: 'uppercase', color: C.muted, marginBottom: 3, letterSpacing: 0.3 };
const preBox = { background: '#0d1117', border: '1px solid ' + C.border, borderRadius: 6, padding: '8px 10px', overflow: 'auto', fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' };
const tbl = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th = { textAlign: 'left', padding: '6px 10px', borderBottom: \`1px solid \${C.border}\`, color: C.muted, fontWeight: 600 };
const td = { padding: '6px 10px', borderBottom: \`1px solid \${C.border}\`, verticalAlign: 'top' };
`;
  // Splice the optional hand-authored custom tab. The projection (GsdPlanView) stays
  // canonical and is always regenerated; the custom code is never touched by the importer,
  // so it survives every refresh. When absent, Page just delegates to GsdPlanView (unchanged).
  const pageDecl = custom
    ? custom.code + "\n\n" + `function Page({ taskforge }) {
  const [tab, setTab] = useState('custom');
  const tb = (a) => ({ display: 'inline-flex', alignItems: 'center', padding: '6px 12px', fontSize: 12.5, borderRadius: 6, cursor: 'pointer', border: '1px solid ' + C.border, background: a ? C.panel2 : 'transparent', color: a ? C.text : C.muted, marginRight: 6 });
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        <button style={tb(tab === 'custom')} onClick={() => setTab('custom')}>${custom.label}</button>
        <button style={tb(tab === 'plan')} onClick={() => setTab('plan')}>GSD Plan</button>
      </div>
      {tab === 'custom' ? <CustomSection taskforge={taskforge} /> : <GsdPlanView taskforge={taskforge} />}
    </div>
  );
}`
    : `function Page({ taskforge }) { return <GsdPlanView taskforge={taskforge} />; }`;
  return base.replace('/*__CUSTOM_INJECT__*/', pageDecl);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.planning) die('provide --planning <path to .planning dir or project root>.');

  const planningRoot = resolvePlanningRoot(args);
  const stateMd = read(join(planningRoot, 'STATE.md'));
  const roadmap = read(join(planningRoot, 'ROADMAP.md'));
  const phases = collectPhases(planningRoot);
  const codebase = collectCodebase(planningRoot);
  // A freshly-onboarded tree may only have a codebase map (no STATE/ROADMAP/phases
  // until gsd-new-project runs). Accept any non-empty planning tree.
  if (!stateMd && !roadmap && phases.length === 0 && codebase.length === 0)
    die(`nothing to import under ${planningRoot} (no STATE.md / ROADMAP.md / phases / codebase) — is this a GSD planning tree?`);
  const { data: fm, body: stateBody } = parseFrontmatter(stateMd);

  const title = args.title || fm.milestone_name || `GSD: ${basename(planningRoot)}`;
  const id = slug(args.id || title);

  const wsMatch = planningRoot.match(/workstreams[/\\]([^/\\]+)\/?$/);
  const gsd = {
    title,
    planningPath: planningRoot,
    workstream: wsMatch ? wsMatch[1] : null,
    importedAt: nowIso(),
    milestone: fm.milestone || null,
    milestoneName: fm.milestone_name || null,
    status: fm.status || null,
    stoppedAt: fm.stopped_at || null,
    lastUpdated: fm.last_updated || null,
    progress: fm.progress || {},
    resume: null,
    phases,
    traceability: buildTraceability(phases),
    waves: buildWaves(phases),
    codebase,
    state: stateBody ? stateBody.trim() : null,
    roadmap: roadmap ? roadmap.trim() : null,
  };
  const resumeMatch = stateBody && stateBody.match(/Resume file:\s*(\S+)/);
  if (resumeMatch) gsd.resume = resumeMatch[1];

  const dir = join(ROOT, 'work', id);
  mkdirSync(dir, { recursive: true });

  // Optional architecture diagram: if work/<id>/architecture.svg exists, embed it
  // inline so it survives re-imports (drop a rendered .svg there and re-run).
  const svgPath = join(dir, 'architecture.svg');
  gsd.diagram = existsSync(svgPath)
    ? 'data:image/svg+xml;base64,' + readFileSync(svgPath).toString('base64')
    : null;

  // Page.jsx — the Log tab. An optional hand-authored work/<id>/custom-section.jsx
  // (defines `function CustomSection({ taskforge })`; optional `// @tab: <label>` directive sets the
  // tab name) is inlined as an extra tab that SURVIVES refresh — the projection stays canonical,
  // the custom code is never regenerated. See renderPage's /*__CUSTOM_INJECT__*/ splice.
  // The custom code shares the generated module's scope (C, useState, the taskforge prop) — its own
  // helpers must avoid the generated names (Page, GsdPlanView, Section, Pill, Row, card, tag, etc.).
  const customPath = join(dir, 'custom-section.jsx');
  let custom = null;
  if (existsSync(customPath)) {
    const code = readFileSync(customPath, 'utf8');
    const m = code.match(/@tab:\s*(.+)/);
    custom = { code, label: (m ? m[1].trim() : 'Notes').replace(/`/g, "'") };
  }
  writeAtomic(join(dir, 'Page.jsx'), renderPage(gsd, custom));

  // thread.json — Code Review tab (+ the chat bridge for every tab). Preserve an
  // existing conversation/anchors on re-run; refresh the diff in place.
  const prev = (() => { try { return JSON.parse(read(join(dir, 'thread.json')) || ''); } catch { return null; } })();
  const review = {
    review: {
      id, title,
      repo: args.repo ? resolve(args.repo) : null,
      base: args.base || (args.repo ? 'main' : null),
      head: args.head || (args.repo ? 'HEAD' : null),
      createdAt: prev?.review?.createdAt || nowIso(),
    },
    hunks: gitDiff(args),
    threads: prev?.threads || { general: [] },
  };
  if (prev?.anchors) review.anchors = prev.anchors;
  // Re-attach prior annotations by hunk id (same contract as import.mjs --refresh).
  if (prev?.hunks) {
    const byId = Object.fromEntries(prev.hunks.map((h) => [h.id, h.annotations || []]));
    for (const h of review.hunks) if (byId[h.id]) h.annotations = byId[h.id];
  }
  ensureAnnotationIds(review);
  writeAtomic(join(dir, 'thread.json'), JSON.stringify(review, null, 2) + '\n');

  // qa-plan.md — QA tab, seeded from the latest phase UAT if present.
  const uat = latestUat(planningRoot);
  const qa = uat
    ? `# QA Plan — ${title}\n\n> Seeded from GSD \`${uat.phase}\` UAT. Edit freely; this is a plain-Markdown TaskForge QA plan.\n\n${uat.text.replace(/^---\n[\s\S]*?\n---\n/, '').trim()}\n`
    : `# QA Plan — ${title}\n\nNo phase UAT found yet. Once a GSD phase produces a \`*-UAT.md\`, re-run the importer to seed this tab.\n`;
  writeAtomic(join(dir, 'qa-plan.md'), qa);

  console.log(`Wrote work/${id}/ (Page.jsx + thread.json + qa-plan.md)`);
  console.log(`  planning: ${planningRoot}`);
  console.log(`  ${phases.length} phases · ${codebase.length} codebase docs · ${review.hunks.length} diff hunks · QA ${uat ? `from ${uat.phase}` : '(stub)'}`);
  console.log(`\nStart the app:  npm run review`);
  console.log(`Then open id:   ${id}`);
}

function writeAtomic(out, contents) {
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, out);
}

main();
