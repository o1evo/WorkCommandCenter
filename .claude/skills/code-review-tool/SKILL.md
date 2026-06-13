---
name: code-review-tool
description: Drive the local file-bridge code-review app (the "Work Command Center" / CodeReviews app) — a private Vite+React viewer that renders an annotated diff plus per-hunk chat threads, persisted to reviews/<id>/thread.json. Use when the user asks to answer review questions / reply in the review app, import or refresh a diff for review, seed findings as annotations, start/open the review app, or mentions "the review app", "CodeReviews", "Work Command Center", "WCC", "thread.json", "review widget", or asks you to participate as the reviewer. The app and a Claude session communicate ONLY through thread.json (no MCP, no network); the app polls it every 3s.
---

# Code Review Tool

A local, private code-review app (the CodeReviews / Work Command Center repo). It renders a
git diff as annotated hunks plus chat threads, and persists everything to
`reviews/<id>/thread.json`. There is **no MCP and no server→agent push**: the app and a
Claude session talk *only* by reading/writing that JSON file. The app polls it every ~3s,
so any write you make appears within ~3s. All local; never sends source anywhere.

> **Where the app lives.** Run these commands from the CodeReviews repo root (the repo that
> contains `bin/import.mjs` and `package.json` — this skill ships inside it under
> `.claude/skills/`). The helper scripts default their review root to that repo automatically;
> pass `--root <dir>` only to target a different checkout.

The app hosts **multiple reviews at once** — pick one in the header switcher dropdown; the
3s poll is scoped to the selected id. Each review is an independent `reviews/<id>/thread.json`
(and may target a different repo/clone), so reviews share nothing. Convention: `<id>` is a
short lowercase slug (e.g. a ticket id like `cu-1234`, or any stable name).

## Concurrency & parallel reviews — one reviewer per review id

The app's API writes `thread.json` **atomically** (temp + `rename`), so no reader ever sees
a half-written file and two UI posts can't interleave. What is **not** solved is a **lost
update** (last-writer-wins) when two *long-window* writers touch the **same** review id — a
reviewer session that Reads → thinks for seconds → Writes, racing the API (a question posted
in the UI) or a second reviewer session.

Two rules:

1. **One reviewer session per review id.** Never point two sessions at the same id.
   *Parallel reviews are fully supported* — run one session each on **different** ids (each
   may target a different repo/clone). Different ids → different files → zero contention. Tell
   each session which it owns: "You're the reviewer for `<id>`."
2. **Reply only via `scripts/answer.mjs`** — it re-reads `thread.json` *immediately* before
   the atomic write (no think-time inside the window), shrinking the one remaining race
   (reviewer vs. a UI post on the same id) to near-zero. **Never hand-write the reply** into
   the file — the read→think→write window is exactly where updates get lost.

## Answer the user's review questions (the main job)

```bash
S=.claude/skills/code-review-tool/scripts   # run from the CodeReviews repo root
# 1. see what's unanswered
node $S/list_pending.mjs --id <review-id>
# 2. write your reply to a file (so code fences/quotes survive the shell), then:
node $S/answer.mjs --id <review-id> --msg <author-msg-id|next> --file reply.txt
```

- `--msg next` answers the oldest unanswered author message; or pass a specific
  `--msg <id>` from `list_pending`. The reply lands in that message's thread and flips it
  to `answered`. `list_pending` labels each thread — `(general)`, `(file — hunk-level)`, or
  `(file :: finding tag)` for a **per-finding** thread (threads follow each annotation).
- The scripts default their root to the repo this skill lives in; pass `--root <dir>` to
  target a different CodeReviews checkout.
- Replies render as **Markdown**: fenced ` ```ruby ` / ` ```js ` / ` ```json ` / ` ```yaml `
  blocks get Prism syntax highlighting; inline `` `code` `` is styled. Put code in fenced
  blocks. Other languages render as plain text (only those grammars are loaded).

After writing, the open page shows the reply on its next poll — no restart, no refresh.

## Start / open the app

```bash
npm run review   # from the repo root → Vite dev on http://127.0.0.1:5174 (or next free port)
```
Then open the review id shown in the UI. If it's already running, just open the URL.

## Import a diff (first time) / refresh it (each round)

First import:
```bash
node bin/import.mjs --repo <repo-path> --base <ref> --head <ref> \
  --id <review-id> --title "..." [--seed reviews/seeds/<id>.json]
```
- Use `--head WORKTREE` when the change is uncommitted (diffs the working tree vs base).
  This is common — branch work is often staged/unstaged, not yet on HEAD.
- `--seed <file>` attaches curated findings as annotations (and optional seed threads).

**After each round of code changes, re-sync the diff with `--refresh`:**
```bash
node bin/import.mjs --id <review-id> --refresh
```
- Re-runs the diff and writes the new hunks, but **preserves the live state**: annotations
  (re-attached by hunk id, so resolved/deleted findings + their states carry over), all
  chat threads, and Log-page comment anchors. Repo/base/head/title default to the existing
  review, so the `--id … --refresh` form is enough.
- This is THE fix for "the Code Review tab shows stale code after a round." Use it whenever
  the branch changes; you don't lose the conversation.
- Caveat: re-attachment is by hunk id (`<file>#<index>`) — stable while a file's hunk
  structure is unchanged. If a file splits into a different number of hunks, some
  finding/line threads may orphan (still in the file, just not rendered).
- **`--force`** is the destructive overwrite (regenerates from the seed, wiping threads) —
  only for starting a completely fresh round.

## Findings / severity

Annotations carry `{ tag, severity, note }`. The UI styles severities
**`blocker` / `high` / `medium` / `low`**; anything else (e.g. `resolved`) renders but
uncolored. When a finding is fixed, set its `severity` to `resolved` and rewrite the note,
then `--refresh` so the hunk shows the corrected code (the resolved state carries over).

## Details

`thread.json` shape, the seed format, and the full import/annotation reference live in
`references/thread-format.md` — read it when importing, seeding, or editing the file by hand.
