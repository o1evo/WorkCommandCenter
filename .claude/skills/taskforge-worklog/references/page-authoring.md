# Authoring a TaskForge page (`work/<id>/Page.jsx`)

A page is real React, transformed from JSX in the browser (Babel-standalone) and rendered live.
Edit the file → it re-renders on the app's 3s poll. No build, no restart.

## The contract (keep it exactly)

```jsx
// work/<id>/Page.jsx
function Page({ taskforge }) {
  const [tab, setTab] = useState('findings');   // hooks are in scope, no import
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <h2>{taskforge.review.title}</h2>
      {/* … */}
    </div>
  );
}
```

Rules — the runtime is deliberately tiny, so follow these or it won't load:

- **Define `function Page({ taskforge }) { … }`** (a function declaration named `Page`). It is the
  component the app renders.
- **No `import` / no `export`.** Everything you need is injected into scope. (If you slip one in,
  the runtime strips it rather than failing — but don't rely on that; you can't import packages.)
- **In scope:** `React` and the hooks `useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`
  (so write `useState(…)`, not `React.useState(…)` — though both work). And the `taskforge` prop.
- **Helpers at file top level are fine.** You may declare extra components / style objects outside
  `Page` (e.g. `function Pill({children}){…}` or `const h2 = { fontSize: 15 }`) and reference them
  inside `Page` — they share the same scope. Just don't `export` them.

## The `taskforge` page API

`taskforge` is rebuilt from the latest polled data on every render, so anything you read from it is live.

| Member | What it is |
|--------|-----------|
| `taskforge.id` | the task id, e.g. `"cu-1234"` |
| `taskforge.review` | `{ id, title, repo, base, head, createdAt }` from `thread.json` |
| `taskforge.hunks` | the diff hunks (same data the Code Review tab renders) |
| `taskforge.threads` | all chat threads, keyed by thread key (object) |
| `taskforge.theme` | the active color palette — `{ text, muted, border, panel, panel2, link, bg, ok, warn, danger, blocker, high, medium, low, note }`. **Use it for all colors** (see Styling) so the page follows the app's theme. |
| `taskforge.Thread` | **component** — an anchored chat (see below) |
| `taskforge.Markdown` | **component** — `<taskforge.Markdown text="…" />` renders full Markdown (headings, lists, GFM tables, task lists, blockquotes, links, Prism-highlighted fenced code) |
| `taskforge.send(target, text)` | post a `role:"author"` message programmatically; returns a promise |
| `taskforge.createAnchor({ key, quote, prefix, suffix })` | create a free-selection comment anchor (the comment layer uses this; rarely called by hand) |
| `taskforge.setAnchorState(key, state)` | set a comment's `state` — `open` / `resolved` / `hidden` |

### Chat threads — the v2 superpower

A page has two kinds of anchored chat, both answered by the reviewer Claude session through the
same file-bridge as code-review threads. **Prefer free-selection comments** — only reach for a
pinned `<taskforge.Thread>` when a discussion must always be visible at a known spot.

**1. Free-selection comments (built-in app behavior — you write no code for these).**
Anyone selects any text on the rendered page → a **💬 Comment** button → a popover chat anchored to
that text, with a highlight. Resolve / hide per comment. Implemented by the app's comment layer
([src/components/CommentLayer.jsx](../../../../src/components/CommentLayer.jsx) +
[src/anchors.js](../../../../src/anchors.js)) — it works over *any* page regardless of what you
authored. You don't call an API for these; just write good prose and the reader comments on it.
(You, as Claude, can also create one programmatically via `taskforge.createAnchor({ key, quote, prefix,
suffix })` + `taskforge.send(key, text)`, but that's rarely needed.)

**2. Pinned author thread — `<taskforge.Thread>`.**

```jsx
<taskforge.Thread target="log:requeue-ordering" title="Discuss: enqueue-then-destroy ordering" />
```

- `target` is **required** and must match `^log:[a-z0-9:_-]+$` (lowercase, digits, `-_:`). You own
  this anchor space — pick a stable, meaningful slug per discussion (`log:<topic>`).
- `title` (optional) labels the thread and shows an unanswered-count badge.
- `compact` (optional, default `true`) renders a tighter input.

**Data model (both kinds).** Messages live in `thread.json` under `threads["log:<key>"]`. Free
selections additionally record `anchors["log:<key>"] = { quote, prefix, suffix, state }` so the
highlight can be re-located. Everything persists across reloads (unlike local React state).

**Re-attachment & the "outdated" state.** A comment re-attaches by finding its stored `quote` in the
rendered text (using `prefix`/`suffix` to disambiguate repeats). If you edit the page and a quoted
passage changes or disappears, that comment is flagged **outdated** (an "N outdated" chip) rather
than silently dropped. So when revising a section that has live comments, **preserve the quoted
phrasing where you can**, or resolve the comment first.

## Styling — use `taskforge.theme`, don't hardcode hex

The app is themeable (navy / dark-neutral / light, switchable in the header). So **don't author a
hardcoded color palette** — pull the active one from `taskforge.theme` and the page follows the theme for
free (and it's fewer tokens than writing a palette literal):

```jsx
function Page({ taskforge }) {
  const C = taskforge.theme;   // { text, muted, border, panel, panel2, link, bg, ok, warn, danger, blocker, high, medium, low, note }
  return <div style={{ color: C.text, border: `1px solid ${C.border}`, background: C.panel }}>…</div>;
}
```

`ok`/`warn`/`danger` are the semantic accents (green / amber / red); `blocker|high|medium|low|note`
are the severity colors. Equivalent CSS variables exist for non-JS spots
(`var(--text)`, `var(--border)`, `var(--blocker)`, …) — but in JSX prefer `taskforge.theme`.
Never hardcode hex: it locks the page to one theme and looks wrong in the others.

## QA Plan — a markdown file, not JSX

The QA plan is **not** part of `Page.jsx`. It is a plain markdown file `work/<id>/qa-plan.md` that
the app renders in its own **QA Plan** tab (third tab, beside Log and Code Review) with a **Copy
markdown** button. You write markdown; the app handles rendering and copying. Nothing to code.

Why markdown and not a bespoke page: a QA plan is a hand-off document QA copies out and owns
elsewhere — markdown is portable, diffable, and pasteable; JSX is none of those. The rendered
GitHub task-list checkboxes (`- [ ]`) are read-only; the `.md` is the source of truth.

Content shape (full guidance in `SKILL.md` → "QA Plan tab"):

```markdown
# QA Test Plan — <feature>

<goal — what QA is confirming>

## P0 — Smoke (must pass)

### S1. <capability>
- **Do:** <action / how to inject the fault>
- **Pass:** <what QA should see>
- **Hits:** <infra exercised — load balancer, database, cache, object store, …>

## P1 — Core behavior
## P2 — Edge cases
- [ ] <checklist item>

## Rollback triggers
## Sign-off
- [ ] P0 on staging — QA, date
## Systems covered
- `app/...` — <what it covers>
```

The same renderer also backs `taskforge.Markdown`, so a Log page can drop rich markdown inline:
`<taskforge.Markdown text={`## notes\n- a\n- b`} />`.

## Live reload, errors, and iteration

- Save `Page.jsx` → the app re-renders within ~3s (it polls `_mtime`, which now covers `Page.jsx`).
- **Compile error** (bad JSX/syntax) → a red panel with the message; the rest of the app keeps working.
- **Runtime throw** (page crashes while rendering) → an error-boundary panel with the stack. Fix the
  file and it recovers on the next poll. You will never white-screen the app.
- Keep state that must survive a reload in the **source** (you edit it) or in a **thread message** —
  `useState` is ephemeral.

## Sanity-check before relying on it

You can compile-check a page exactly as the runtime does, without a browser (from the repo root):

```bash
node --input-type=module -e "
import * as Babel from '@babel/standalone';
import { readFileSync } from 'node:fs';
const src = readFileSync('work/<id>/Page.jsx','utf8')
  .replace(/^\s*import\s.*\$/gm,'').replace(/export\s+default\s+/g,'');
const { code } = Babel.transform(src, { presets:['react'], filename:'Page.jsx' });
new Function('React','const {useState,useEffect,useRef,useMemo,useCallback}=React;\n'+code+';return Page;');
console.log('compiles OK');
"
```

## The runtime that defines exactly what's in scope

```
src/components/PageRuntime.jsx   (see buildTaskForge + HOOK_PREAMBLE)
```

Copy an existing page from `work/<id>/Page.jsx` as a starting template once you have one.
