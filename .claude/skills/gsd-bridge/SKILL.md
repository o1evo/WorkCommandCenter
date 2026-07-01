---
name: gsd-bridge
description: Bridge a GSD (gsd-core) .planning tree to the TaskForge — render its phases/state/UAT into a TaskForge task (Log + Code Review + QA tabs), and capture resolved review threads back into GSD's planning artifacts. Use when a task is tracked in a GSD .planning/ tree, when the user says "import gsd", "gsd planning", "show the plan in TaskForge", "capture decisions back to gsd", "TaskForge-CAPTURES", or mentions a .planning workstream/phase. Two CLIs: import-gsd (read) and capture-gsd (writeback).
---

# GSD ↔ TaskForge bridge

[GSD / gsd-core](https://github.com/open-gsd/gsd-core) is a phase-based process engine: it writes
plain-Markdown artifacts under `.planning/` (STATE, ROADMAP, per-phase PLAN/SUMMARY/UAT, PROJECT
Key Decisions) but has **no human-facing surface**. TaskForge is that surface. This skill drives the two
CLIs that connect them — `bin/import-gsd.mjs` (read) and `bin/capture-gsd.mjs` (writeback). GSD
stays the **single writer** of its own files; TaskForge never edits them directly.

Run everything from the TaskForge repo root.

## 1. Import a planning tree → TaskForge (read)

Render a `.planning/` tree (or one workstream of it) into a TaskForge task `work/<id>/`:

```bash
npm run import-gsd -- --planning <path/to/.planning-or-project-root> [--workstream <name>] \
  --id <id> [--title "..."] [--repo <code-repo> --base <ref> --head <ref>]
```

- Produces `work/<id>/Page.jsx` (Log tab: milestone, % progress, **per-phase cards**, a
  **requirement-traceability grid** — REQ-ID → phases + UAT coverage, and an **execution-wave
  view** — phases grouped by `wave` with `depends_on` edges), `qa-plan.md`
  (QA tab, seeded from the latest phase UAT), and `thread.json` (Code Review tab; pass
  `--repo/--base/--head` to populate the diff — `--head WORKTREE` for uncommitted work).
- **Workstream mode** (STATE/ROADMAP under `.planning/workstreams/<name>/`): `--workstream` is
  **optional** — it auto-detects via the gitignored `.planning/active-workstream` pointer or a sole
  workstream; pass the flag only to disambiguate when several exist. The page header shows the
  active workstream.
- **Re-run any time to refresh** — it preserves the conversation + comment anchors (like
  `import.mjs --refresh`). The Code Review diff streams live on the 3s poll; the Log tab refreshes
  on re-import; the header carries an *imported-at* stamp so staleness is visible.
- **Diagram:** if `work/<id>/architecture.svg` exists, it's auto-embedded in an Architecture
  section (survives re-imports, no view-time network).

Then start the app (`npm run review`) and open `<id>`.

## 2. Discuss — in TaskForge

Each phase card has its own discussion thread keyed `log:phase:<phase-dir>`; the engineer can also
select any text to drop a free comment, and the Code Review tab has hunk/line threads. A reviewer
session answers via the normal TaskForge thread bridge (see `taskforge-review`).

**The capture contract (load-bearing):** when a thread reaches an outcome, the reviewer ends a
message with a marked line — this is the *only* signal capture acts on, so distillation stays a
human judgment, not machine summary:

- `**Decision:** <one crisp line>`
- `**Open question:** <one line>`
- `**Blocker:** <one line>`

Keep it to a single distilled line — it lands verbatim in a GSD artifact.

## 3. Capture resolved threads → GSD (writeback)

```bash
npm run capture-gsd -- --id <id> --planning <path> [--workstream <name>] [--dry-run]
```

- Appends each marked outcome to a **TaskForge-owned** `.planning/TaskForge-CAPTURES.md` handoff file
  (append-only, idempotent — stamps `captured` on the thread message and fingerprints each entry).
  TaskForge never edits GSD's reconstructable files (e.g. STATE.md), so `gsd-tools state sync` can't clobber it.
- **Phase-scoped routing:** an outcome from a `log:phase:<dir>` thread targets *that phase's*
  artifact (`phases/<dir>/<NN>-CONTEXT.md`); general / code-review / free-comment threads route to
  the global store (Decision → PROJECT Key Decisions, Open question → todos, Blocker → STATE).
- Always `--dry-run` first to preview targets.

**Ingest (GSD side):** for each `[ ]` entry in `TaskForge-CAPTURES.md`, fold it into the listed target
and tick `[x]`. GSD's `/gsd-capture` (or a reviewer session) does this — it is *not* automatic, by
design: TaskForge produces the handoff, GSD consumes it on its own terms.

## Verify

`npm run test:gsd` — hermetic smoke test of both halves (render compiles, phases/QA seeded, both
routing paths, idempotency, STATE untouched). Run it after changing either CLI.

## Notes

- Generic GSD adapter — keep project/team specifics out of these tools and this skill so it
  stays upstreamable.
- `work/` is gitignored: imported pages, threads, and any `architecture.svg` never get committed.
