# Work Command Center — local, private, file-bridge work hub

> The repo and npm package are still named `code-reviews`; the product is **Work
> Command Center**.

A localhost web app for driving a single unit of work — keyed by its ClickUp id —
across **three tabs that share one `reviews/<id>/` directory**:

| tab | what it is | source of truth | authored via |
|-----|-----------|-----------------|--------------|
| **Log** | a bespoke, interactive React work-log page (status, findings, timeline, follow-ups) with chat threads anchored to any text | `reviews/<id>/Page.jsx` | `work-log-v2` skill |
| **Code Review** | an annotated diff with per-hunk / per-line / per-finding chat threads | `reviews/<id>/thread.json` | `code-review-tool` skill |
| **QA Plan** | a plain-Markdown QA test plan with a **Copy markdown** button (lift it into ClickUp/email) | `reviews/<id>/qa-plan.md` | hand-written markdown |

In every tab a *separate Claude Code session* (the "reviewer") joins the chat by
reading and writing one plain JSON file (`thread.json`). No data ever leaves this
machine: **no MCP, no external API, no outbound network calls.** The diffs are
proprietary source.

- **Location:** `/Users/kassiter/code/CodeReviews`
- **Stack:** Vite + React frontend; the "backend" is a Vite dev-server
  *middleware plugin* ([vite.config.mjs](vite.config.mjs) → [server/api.mjs](server/api.mjs)),
  so the whole tool is one process. Deps: `react`, `react-dom`, `vite`,
  `prismjs` (offline syntax highlighting), `@babel/standalone` (transforms
  `Page.jsx` in the browser — no build step), `marked` (Markdown for messages,
  QA plans, and `wcc.Markdown`). No DB, no telemetry.

## Run it

```bash
npm install
npm run review      # starts Vite + the file-bridge API on http://127.0.0.1:5174
```

Open the printed URL. The app hosts **multiple reviews at once** — pick one from
the header switcher dropdown (shown when more than one exists); the 3s poll is
scoped to the selected id.

## How it works (poll-based liveness)

```
UI  ──POST /message──▶  thread.json + Page.jsx + qa-plan.md  ◀──reads/edits──  Claude session
 ▲                                    │
 └──── GET every 3s ──────────────────┘   (re-renders only when the max mtime changes)
```

- **Frontend** ([src/App.jsx](src/App.jsx)): polls `GET /api/review/:id` every 3s
  and re-renders only when `_mtime` changes. The response bundles `thread.json`
  plus the `Page.jsx` source (`_page`) and `qa-plan.md` (`_qaPlan`), and `_mtime`
  is the **max of all three** — so editing any one of them re-renders the right
  tab on the next poll, with no restart.
- **Backend** ([server/api.mjs](server/api.mjs)): stateless. Every request does a
  fresh read → mutate → **atomic** write (temp file + `rename`, so a concurrent
  poll/reviewer never sees a half-written file). Localhost only, filesystem only.
- **Reviewer bridge:** a Claude session reads the JSON, answers pending author
  questions (in *any* tab's threads), and saves — the UI shows the reply on its
  next poll. No push/websockets (a Claude reviewer can't be pushed to); the app
  polls instead.
- **Page runtime** ([src/components/PageRuntime.jsx](src/components/PageRuntime.jsx)):
  the Log page is JSX compiled in the browser with `@babel/standalone` and run as
  `function Page({ wcc }) { … }` (no imports/exports; `React` + hooks in scope). A
  compile or runtime error shows an error panel, never a white screen.
  **SECURITY:** this evaluates Claude-authored code — acceptable only because the
  tool is localhost-only and single-user. Do not expose it.

## Where state lives

One directory per task — **`reviews/<id>/`** — holding up to three files:

| file | feeds tab | required? |
|------|-----------|-----------|
| `thread.json` | Code Review (+ all chat threads, for every tab) | yes |
| `Page.jsx` | Log | optional (no file → no Log tab) |
| `qa-plan.md` | QA Plan | optional (no file → no QA tab) |

`thread.json` is the single source of truth for the diff, hunks, annotations, and
**every chat message across all three tabs** (Log/QA threads use `log:` keys, see
below). The `reviews/` tree is **gitignored** because it embeds proprietary
source. There is no database, no in-memory cache, no `localStorage`/cookies.
Restarting the server or reloading the tab changes nothing — both rebuild from
these files. (`reviews/seeds/*.json` are curated annotation inputs for `import`.)

By convention `<id>` is the ClickUp id lowercased, e.g. `cu-86ah0tff9`. Using the
same id for all three tabs is what pairs the work log, its diff, and its QA plan.

## Data model (`thread.json`)

```jsonc
{
  "review": { "id", "title", "repo", "base", "head", "createdAt" },
  "hunks": [
    { "id", "file", "range", "diff",
      "annotations": [ { "id", "tag", "severity", "note" } ] }
  ],
  "threads": {
    "<thread-key>": [ { "id", "role", "text", "ts", "answered" } ]
  }
}
```

- **Hunk `id`** = `"<file>#<indexInFile>"` (e.g. `app/models/failed_job.rb#0`) —
  deterministic and stable for a given diff.
- **Annotation `id`** = `"<hunkId>::<slug(tag)>"` — deterministic from hunk id +
  tag, assigned on read ([server/annotations.mjs](server/annotations.mjs)), so it
  survives a re-import without being persisted.
- **`severity`** ∈ `blocker | high | medium | low | note | resolved` — color-coded
  badges in the UI (`resolved` renders dimmed/green for fixed findings).
- **Message** = `{ id, role: "author"|"reviewer", text, ts, answered }`.
  `author` is the human; `reviewer` is the Claude session.
- **Thread keys** (each maps to a message array):
  | key | scope | tab |
  |-----|-------|-----|
  | `"general"` | review-wide discussion | Code Review |
  | `"<hunkId>"` | hunk-level | Code Review |
  | `"<annotationId>"` | discussion under one finding | Code Review |
  | `"<hunkId>#L<n>"` | inline comment on a specific line | Code Review |
  | `"log:<anchor>"` | a thread on the Log page — either a free-selection comment or an author-placed `<wcc.Thread>` | Log |
- **Anchors** (free-selection Log comments) live alongside `threads` and carry the
  quoted text plus `prefix`/`suffix` context so a comment **re-attaches by fuzzy
  text match** after Claude edits `Page.jsx`; if the quote no longer resolves it's
  flagged **outdated** rather than lost. Each anchor has a `state`
  (`open`/`resolved`/`hidden`). See [src/anchors.js](src/anchors.js) +
  [src/components/CommentLayer.jsx](src/components/CommentLayer.jsx).

Messages render **Markdown** via `marked` ([src/components/Markdown.jsx](src/components/Markdown.jsx)),
with fenced code blocks Prism-highlighted ([src/highlight.js](src/highlight.js)).
The same renderer backs `wcc.Markdown` on a Log page and the whole QA Plan tab.

## API

| Method | Route | Body | Effect |
|--------|-------|------|--------|
| GET  | `/api/reviews` | — | list `{id, title}` (the switcher source) |
| GET  | `/api/review/:id` | — | full `thread.json` + `_page` (Page.jsx) + `_qaPlan` (qa-plan.md) + `_mtime` |
| POST | `/api/review/:id/message` | `{target, text}` | append `role:"author"` message (`answered:false`) |
| POST | `/api/review/:id/message-delete` | `{target, messageId}` | remove one message |
| POST | `/api/review/:id/thread-delete` | `{target}` | remove a whole thread |
| POST | `/api/review/:id/anchors` | `{key, quote, prefix, suffix}` | create/update a free-selection Log comment anchor |
| POST | `/api/review/:id/anchor-state` | `{key, state}` | set an anchor `open`/`resolved`/`hidden` |
| POST | `/api/review/:id/annotations` | `{target, annotations}` | replace a hunk's annotations |

`target` is any thread key above; `/annotations` `target` is a hunk `id`.

## Import a change

```bash
# From a repo (runs `git diff <base> <head>` inside it):
node bin/import.mjs --repo /path/to/repo --base main --head HEAD --title "My change"

# When the branch work is still uncommitted (HEAD == base), diff the working tree:
node bin/import.mjs --repo /path/to/repo --base main --head WORKTREE --title "..."

# From a raw patch file:
node bin/import.mjs --diff change.diff --title "My change"

# Seed annotations/threads from a curated JSON (see reviews/seeds/):
node bin/import.mjs --repo ... --base ... --head ... --title "..." \
  --id my-id --seed reviews/seeds/my-seed.json

# Re-diff an existing review in place after more code lands — keeps the chat:
node bin/import.mjs --id my-id --refresh
```

- `--head WORKTREE` diffs the working tree vs base — common, since branch work is
  often staged/unstaged, not yet committed to HEAD.
- `--seed <file>` attaches curated findings as annotations (targets hunks by
  `{file, contains?}`) and optional seed threads.
- **`--refresh` is the safe re-sync:** it re-runs the diff for an existing `--id`
  (backfilling repo/base/head/title) and rewrites the hunks **while preserving the
  conversation, annotations with their resolved/deleted states, and Log-page
  comment anchors.** Run it after each round so the Code Review tab shows current
  code without losing discussion.
- **`--force` is destructive:** re-import overwrites `thread.json` from the seed,
  wiping the live conversation. Only use it to start a fresh round.

## Authoring the Log & QA tabs

Both are Claude-authored files dropped into `reviews/<id>/`; the app picks them up
on the next 3s poll (no restart), and the tab only appears when its file exists.

- **Log page → `reviews/<id>/Page.jsx`** — bespoke interactive React for *this*
  task (status pill, findings, dated timeline, follow-ups). Contract: define
  `function Page({ wcc }) { … }`, **no imports/exports**; `React` + hooks are in
  scope and `wcc` is injected (data + `<wcc.Thread target="log:…">` to pin a
  discussion + `<wcc.Markdown>`). Readers can also select any text on the page to
  drop a 💬 comment (a `log:` anchor) — no code needed. Authored via the
  **`work-log-v2`** skill.
- **QA plan → `reviews/<id>/qa-plan.md`** — plain Markdown (no JSX), rendered with
  a **Copy markdown** button so QA can lift it into ClickUp/email. Group by
  business capability, tier P0→P3, and give each case Do / Pass / Hits. Also
  covered by the `work-log-v2` skill.

> **Skills that drive this app:** `work-log-v2` (start a task, author the Log page
> + QA plan) and `code-review-tool` (the reviewer bridge — answer threads, import/
> refresh/seed diffs). Both are local-only and route through the same
> `thread.json`.

## Participating as the reviewer (Claude session)

The reviewer answers open questions in **every** tab — Code Review hunk/finding
threads *and* `log:` page threads — all through the same `thread.json`. There are
two layers, both local-only and append-oriented:

1. **`CLAUDE.md`** — the canonical, hand-editable protocol. Read
   [CLAUDE.md](CLAUDE.md): find every `role:"author"` + `answered:false` message
   across all threads, read that thread's hunk `diff`/`annotations` (and real
   source if needed), **append** a `role:"reviewer"` reply with a fresh unique
   `id` and real ISO-8601 `ts`, set the author message's `answered:true`, save
   valid JSON. Append-only — never edit/delete existing messages or `diff` text;
   never send content off-machine.

2. **The `code-review-tool` skill** (recommended) — a user-level skill at
   `/Users/kassiter/.claude/skills/code-review-tool/` that automates the same
   protocol safely. It auto-triggers when you ask Claude to "answer the review
   questions," "reply in the review app," import/seed a diff, etc. It ships
   helper scripts so you never hand-write into the file:

   ```bash
   S=/Users/kassiter/.claude/skills/code-review-tool/scripts
   node $S/list_pending.mjs --id <review-id>                       # see unanswered author msgs
   node $S/answer.mjs --id <review-id> --msg <author-msg-id|next> --file reply.txt
   ```

   - `--msg next` answers the oldest unanswered message; `list_pending` labels
     each thread — `(general)`, `(file — hunk-level)`, or `(file :: finding tag)`.
   - `answer.mjs` **re-reads `thread.json` immediately before its atomic write**
     (no think-time inside the write window), which shrinks the reviewer-vs-UI
     race to near-zero. **Prefer it over hand-editing the file.**
   - Write the reply to a file first so code fences/quotes survive the shell.
   - Full `thread.json` shape + seed format reference lives in the skill's
     `references/thread-format.md`.

## Parallel sessions — one reviewer per review id

Each review is an independent file keyed by `id`, so **parallel reviews are fully
supported**: run one reviewer session per id, on different ids, even targeting
different repos/clones. Different ids → different files → zero contention. Tell
each session which it owns: *"You're the reviewer for `<id>`."*

The hard rule: **never point two reviewer sessions (or a reviewer + active UI
posting) at the *same* id with hand-written edits.** Atomic writes prevent torn
reads and stop two UI posts from interleaving, but they do **not** solve a
*lost update* (last-writer-wins) between two long-window whole-file writers on
the same file. Using `answer.mjs` (read-just-before-write) is the mitigation.

## Seeded examples

Two reviews currently live in `reviews/`:

| id | repo / branch | story |
|----|---------------|-------|
| `cu-86ah0tff9` | `/Users/kassiter/code/f2` · `…ov-resilient-job-enqueue-fallback…` | job-enqueue resilience, seeded with self-review findings |
| `cu-86ah9wzab` | `/Users/kassiter/code/f2-parallel/f2` · `…ov-duplicate-s3-buckets-us-east-2-v2…` | S3 us-east-2 buckets |

Regenerate the first (with its curated findings):

```bash
node bin/import.mjs --repo /Users/kassiter/code/f2 --base main --head WORKTREE \
  --title "Resilient job enqueue fallback (CU-86ah0tff9)" \
  --id CU-86ah0tff9 --seed reviews/seeds/CU-86ah0tff9.json --force
```
