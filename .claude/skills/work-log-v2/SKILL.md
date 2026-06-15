---
name: work-log-v2
description: Track multi-step work as an interactive page in the Work Command Center app, not just markdown. Use when starting a new story/feature/investigation, when given a task id or URL, or when the user says "new story", "new task", "start tracking", "log this", "work command center", "WCC", "use WCC", "build a log page", or "work log page". The log lives as reviews/<id>/Page.jsx — bespoke interactive React with anchored Claude chat threads — paired with the Code Review tab for the same task id.
---

# Work Log v2 — Work Command Center

The work log is a **bespoke interactive React page** that Claude authors per task and renders
live in the **Work Command Center** app (this repo, `code-reviews`). Each task has tabs that share
one id:

- **Log** — the page you author (`reviews/<id>/Page.jsx`): findings, timeline, follow-ups,
  status — *interactive*, with chat threads you can anchor to any section.
- **Code Review** — the annotated diff + per-hunk threads, driven by the `code-review-tool` skill.
- **QA Plan** — a plain-Markdown test plan (`reviews/<id>/qa-plan.md`) with a Copy button.

`<id>` is a short lowercase slug — a ticket id (`cu-1234`), an issue number, or any stable
name. Using the **same id** for every tab is what pairs the work log with its code review and
QA plan.

> The point of v2 is the **deliverable**: an interactive page instead of a flat `.md`. The
> content discipline (what's worth recording) carries over from any good work log.

---

## Starting a task

### 1. Gather context (read-only)

If the task has a tracker (ticket/issue/PR), read its description, comments, and attachments
for repro steps and stakeholder context. Use whatever source applies to your setup — a
ticketing API, the issue tracker UI, the PR thread. Keep it **read-only**; don't mutate the
tracker. Pull out only what you need (title, status, description, links).

### 2. Ask about branch setup

Before touching code, ask: *"Check out the main branch, pull, and create a new branch?"* If yes,
use a descriptive branch name — e.g. `<feature|fix>/<short-task-name>[-<task-id>]`:

```bash
git checkout main && git pull
git checkout -b <branch-name>
```

`feature` vs `fix` — bug → `fix`, else `feature`; if ambiguous, ask.

### 3. Investigate first when the behavior is unclear

For a production issue, regression, or anything murky, investigate before coding — using
whatever tools fit your environment (application/infra logs, metrics dashboards, the codebase
itself, the tracker's history). **Record the exact queries/commands you ran and the key
findings on the Log page** (in a Findings section), not just a summary — the value is that a
reviewer can see *how* you concluded what you concluded.

---

## When to build a Log page

Build a page when the task involves research, multiple implementation steps, decisions that
need justification for review, or testing with results to record. **Don't** build one for a
one-line fix or typo — those don't need a work log at all.

## Getting the task into the Work Command Center

A task shows up in the app only once `reviews/<id>/` exists. Create it by importing the diff
(this also populates the Code Review tab), from the CodeReviews repo root:

```bash
node bin/import.mjs --repo <repo-path> --base main --head WORKTREE \
  --title "<task name>" --id <id>
```

- `--head WORKTREE` diffs the working tree vs base — normal, since branch work is usually
  uncommitted. **As code lands each round, re-sync the diff with
  `node bin/import.mjs --id <id> --refresh`** — it rewrites the hunks but preserves the
  conversation, annotations (with their resolved/deleted states), and Log-page comments.
  (`--force` is the destructive overwrite-from-seed; only for a fresh start.)
- Early/discovery tasks with no code yet still get a `reviews/<id>/` dir; the diff fills in later.

Then author the Log page → `reviews/<id>/Page.jsx`. Run the app and open it:

```bash
npm run review        # http://127.0.0.1:7777 (or http://wcc:7777; set WCC_PORT to change)
```

The page renders **live**: edit `Page.jsx`, the app re-renders on its 3s poll — no restart.

## Authoring the page

The page is real React you write for *this* task — not a markdown dump. The authoring contract,
the `wcc` page API (data + anchored chat threads + markdown), worked examples, and troubleshooting
are in **[references/page-authoring.md](references/page-authoring.md)** — read it before writing a
page. The essentials:

- Define `function Page({ wcc }) { … }`. **No imports/exports.**
- In scope: `React` + hooks (`useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`).
- A broken page shows an error panel (compile + runtime), never a white screen — iterate freely.

### Two ways to start a thread on the page

1. **Free-selection comments (built-in, no code).** Anyone — you or the user — selects any text on
   the rendered page; a **💬 Comment** button appears; clicking it opens a popover chat anchored to
   that text and paints a highlight. This is the default way to discuss "any idea" and needs nothing
   from the page author. Each comment can be **resolved** or **hidden**; if a later page edit changes
   the quoted text, the comment is flagged **outdated** (an "N outdated" chip) rather than lost.
2. **Author-placed threads.** Pin a discussion to a fixed spot in the page source with
   `<wcc.Thread target="log:<anchor>" title="…" />` — use this for a discussion you want *always
   visible* at a known section (e.g. a key decision), not an ad-hoc note.

Both are `log:` threads in the same `reviews/<id>/thread.json`; the reviewer Claude session answers
both through the same file-bridge as code-review threads.

## What to put on the page

A good Log page lets a reader see what was tried, what worked, what didn't, and why:

| section | content |
|---------|---------|
| header | title + a status pill + a link back to the tracker |
| findings | file:line refs, the exact queries/commands you ran — filter by open/resolved |
| timeline | dated, collapsible; **log reverts and *why*** ("Reverted X because Y" is the valuable part) |
| open questions | a comment on the relevant text (select it → 💬) or a pinned `<wcc.Thread>` |
| follow-ups | a checklist of what's still to do |
| test results | specific numbers, expected vs actual |

- **Add findings as you go** — don't wait until the end.
- **Justify decisions**, don't just state them. Record the exact command/query you ran.
- **Discuss in place, not in a flat Q&A list** — that's the v2 superpower: select the exact sentence
  you're unsure about and comment on it, so the reviewer answers the specific idea where it lives.

## QA Plan tab

The app has a dedicated **QA Plan** tab (third tab, beside Log and Code Review). Unlike the Log
page (bespoke React), the QA plan is **plain Markdown** — write `reviews/<id>/qa-plan.md` and the app
renders it and shows a **Copy markdown** button so the plan can be lifted out and pasted into a
ticket, an email, or handed to QA verbatim. No JSX, no `Page.jsx` — just a markdown file. Build one
for any task QA will validate (especially infrastructure, cutover, or anything touching outside
integrations).

A good QA plan is grouped by **business capability** (what a user does), not by technical service, and
tiered by priority:

- **P0 — Smoke** (≤ 30 min): run first; any failure blocks sign-off.
- **P1 — Core workflows** (half day): the paths customers use daily.
- **P2 — Integrations & edge cases**: less frequent but still customer-visible.
- **P3 — Scheduled / async** (check ≥ 24h later): cron / overnight jobs.

Every test case states three things, so a failure routes itself to an owner:

- **Do** — the click path / action QA performs.
- **Pass** — exactly what QA should see.
- **Hits** — the infrastructure it exercises (load balancer, database, cache, object store, …).

Include, where relevant: an **Environments** note (run on staging first, then re-run P0 smoke on prod
after cutover), **Rollback triggers**, a **Sign-off** checklist (GitHub task-list `- [ ]` items render
as checkboxes), a **Systems covered** reference mapped to the files/config each item lives in, and
**Open questions for QA/devops**.

Notes:
- **It's a document, not an app.** Because it's markdown, the value is that QA can **copy it out** and
  own it elsewhere. The rendered checkboxes are read-only (the source of truth is the `.md`); sign-off
  happens wherever QA pastes it, not by ticking boxes in the viewer.
- **Edit the file to update it.** `qa-plan.md` re-renders on the 3s poll, same as `Page.jsx`.
- **Markdown everywhere.** The same renderer backs `wcc.Markdown` — a Log page can render rich markdown
  inline with `<wcc.Markdown text={`…`} />` (headings, lists, tables, fenced code).

## How the reviewer answers page threads

Page chat threads (`log:<anchor>`) live in the same `reviews/<id>/thread.json` as code-review
threads, so the **`code-review-tool` skill** answers them with the same scripts
(`list_pending.mjs` / `answer.mjs`). Tell that session *"You're the reviewer for `<id>`."* — it
will see and answer page threads alongside hunk/finding threads. Never point two writers at the
same id at once (see the CodeReviews README's lost-update rule).

## Current limitations (state these honestly; don't overclaim)

- **Pages live under the gitignored `reviews/` dir** — so `Page.jsx` / `qa-plan.md` are **not
  version-controlled** with the app. For a durable record of major decisions, also keep a short
  note wherever your team keeps durable docs; don't double-maintain the full narrative — the page
  is primary.
- **Comment threads persist; page widgets don't.** Comment threads and their resolved/hidden state
  *do* persist (in `thread.json`), as do messages. But ad-hoc widgets a page renders — checkboxes,
  toggles, filters — are local React state and do **not** survive a reload. Anything that must
  persist goes in `Page.jsx` source (which you edit) or in a thread. Don't tell the user a checkbox
  "saved".
- **Editing a page can outdate comments.** Because free-selection comments re-attach by matching the
  quoted text, rewriting a quoted passage flags its comment **outdated**. When you edit a section
  that has live comments, preserve the quoted phrasing where you can, or resolve the comment first.
- **Arbitrary code runs in the page.** Fine for this localhost-only, single-user tool; relevant only
  if the app is ever exposed.
