#!/usr/bin/env node
// Import a GSD (`gsd-core`) planning tree into a WCC task view.
//
// GSD (https://github.com/open-gsd/gsd-core) is a phase-based process engine: it
// writes plain-Markdown artifacts under `.planning/` (STATE.md, ROADMAP.md, and
// per-phase PLAN/SUMMARY/UAT files). It has no human-facing surface. WCC is that
// surface. This adapter maps a `.planning/` tree onto WCC's existing `work/<id>/`
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
//   --workstream pick `.planning/workstreams/<name>` instead of the top level
//                (GSD multi-workstream projects keep STATE/ROADMAP per workstream)
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
// Accept either a `.planning` dir directly or a project root that contains one,
// then optionally descend into a named workstream.
function resolvePlanningRoot(args) {
  let p = resolve(args.planning === true ? '.planning' : args.planning || '.planning');
  if (!existsSync(p)) die(`no such path: ${p}`);
  if (statSync(p).isDirectory() && basename(p) !== '.planning' && existsSync(join(p, '.planning'))) {
    p = join(p, '.planning');
  }
  if (args.workstream) {
    const ws = join(p, 'workstreams', args.workstream);
    if (!existsSync(ws)) die(`no workstream "${args.workstream}" under ${join(p, 'workstreams')}`);
    return ws;
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
      return {
        name: d,
        title: d.replace(/^\d+-/, '').replace(/-/g, ' '),
        artifacts: {
          spec: has('SPEC.MD'), context: has('CONTEXT.MD'), plan: has('PLAN.MD'),
          summary: has('SUMMARY.MD'), uat: has('UAT.MD'), review: has('REVIEW.MD'),
        },
        blurb: summary,
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
// wcc runtime contract every Log page uses: function Page({ wcc }), no imports.
function renderPage(gsd) {
  const json = JSON.stringify(gsd, null, 2)
    .replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16)); // JS string-literal safety
  return `// GSD planning view for "${gsd.title}" — generated by bin/import-gsd.mjs.
// Source of truth is the .planning/ tree; re-run the importer to refresh.
// Authoring contract: function Page({ wcc }) — no imports/exports; React + hooks in scope.

const GSD = ${json};

const C = { text: '#c9d1d9', muted: '#8b949e', border: '#30363d', panel: '#161b22', panel2: '#1c2129', link: '#58a6ff', ok: '#2ea043', warn: '#d29922' };

function Page({ wcc }) {
  const { Markdown, Thread } = wcc;
  const p = GSD.progress || {};
  const pct = typeof p.percent === 'number' ? p.percent : null;

  return (
    <div style={{ display: 'grid', gap: 22, color: C.text }}>
      <div>
        <Row style={{ flexWrap: 'wrap' }}>
          <Pill>{GSD.milestone || 'GSD'}</Pill>
          <span style={{ fontWeight: 600 }}>{GSD.milestoneName || GSD.title}</span>
          <span style={{ ...tag, color: C.warn, borderColor: C.warn }}>{GSD.status || 'in progress'}</span>
          <span style={{ marginLeft: 'auto', color: C.muted, fontSize: 12 }}>updated {GSD.lastUpdated || '—'}</span>
        </Row>
        <div style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>
          GSD planning view · <code>{GSD.planningPath}</code>
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

      {GSD.phases.length > 0 && (
        <Section title={\`Phases (\${GSD.phases.length})\`} defaultOpen>
          <table style={tbl}>
            <thead><tr>{['phase', 'artifacts', 'summary'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {GSD.phases.map((ph) => (
                <tr key={ph.name}>
                  <td style={td}><code>{ph.name}</code></td>
                  <td style={td}>
                    <Row style={{ flexWrap: 'wrap', gap: 4 }}>
                      {Object.entries(ph.artifacts).filter(([, v]) => v).map(([k]) => (
                        <span key={k} style={{ ...tag, color: C.muted, borderColor: C.border }}>{k}</span>
                      ))}
                    </Row>
                  </td>
                  <td style={{ ...td, color: C.muted }}>{ph.blurb || <span style={{ opacity: 0.5 }}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
const card = { border: \`1px solid \${C.border}\`, borderRadius: 8, padding: '8px 12px', background: C.panel2 };
const tag = { border: '1px solid', borderRadius: 4, padding: '0 6px', fontSize: 11, textTransform: 'uppercase' };
const tbl = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th = { textAlign: 'left', padding: '6px 10px', borderBottom: \`1px solid \${C.border}\`, color: C.muted, fontWeight: 600 };
const td = { padding: '6px 10px', borderBottom: \`1px solid \${C.border}\`, verticalAlign: 'top' };
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.planning) die('provide --planning <path to .planning dir or project root>.');

  const planningRoot = resolvePlanningRoot(args);
  const stateMd = read(join(planningRoot, 'STATE.md'));
  if (!stateMd) die(`no STATE.md under ${planningRoot} — is this a GSD planning tree?`);
  const { data: fm, body: stateBody } = parseFrontmatter(stateMd);
  const roadmap = read(join(planningRoot, 'ROADMAP.md'));
  const phases = collectPhases(planningRoot);

  const title = args.title || fm.milestone_name || `GSD: ${basename(planningRoot)}`;
  const id = slug(args.id || title);

  const gsd = {
    title,
    planningPath: planningRoot,
    milestone: fm.milestone || null,
    milestoneName: fm.milestone_name || null,
    status: fm.status || null,
    stoppedAt: fm.stopped_at || null,
    lastUpdated: fm.last_updated || null,
    progress: fm.progress || {},
    resume: null,
    phases,
    state: stateBody ? stateBody.trim() : null,
    roadmap: roadmap ? roadmap.trim() : null,
  };
  const resumeMatch = stateBody && stateBody.match(/Resume file:\s*(\S+)/);
  if (resumeMatch) gsd.resume = resumeMatch[1];

  const dir = join(ROOT, 'work', id);
  mkdirSync(dir, { recursive: true });

  // Page.jsx — the Log tab.
  writeAtomic(join(dir, 'Page.jsx'), renderPage(gsd));

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
    ? `# QA Plan — ${title}\n\n> Seeded from GSD \`${uat.phase}\` UAT. Edit freely; this is a plain-Markdown WCC QA plan.\n\n${uat.text.replace(/^---\n[\s\S]*?\n---\n/, '').trim()}\n`
    : `# QA Plan — ${title}\n\nNo phase UAT found yet. Once a GSD phase produces a \`*-UAT.md\`, re-run the importer to seed this tab.\n`;
  writeAtomic(join(dir, 'qa-plan.md'), qa);

  console.log(`Wrote work/${id}/ (Page.jsx + thread.json + qa-plan.md)`);
  console.log(`  planning: ${planningRoot}`);
  console.log(`  ${phases.length} phases · ${review.hunks.length} diff hunks · QA ${uat ? `from ${uat.phase}` : '(stub)'}`);
  console.log(`\nStart the app:  npm run review`);
  console.log(`Then open id:   ${id}`);
}

function writeAtomic(out, contents) {
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, out);
}

main();
