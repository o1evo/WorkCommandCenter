# TaskForge

**A local-first workspace where a Claude Code session reviews your code and tracks your work** — three tabs per task, all backed by plain local files. No DB, no telemetry, nothing leaves your machine.

A localhost web app — open it in a browser **or as a VS Code editor panel**
([vscode-extension/](vscode-extension/)) — for driving a single unit of work,
keyed by its task id, across **three tabs that share one `work/<id>/` directory**:

| tab | what it is | source of truth | authored via |
|-----|-----------|-----------------|--------------|
| **Log** | a bespoke, interactive React work-log page (status, findings, timeline, follow-ups) with chat threads anchored to any text | `work/<id>/Page.jsx` | `taskforge-worklog` skill |
| **Code Review** | an annotated diff with per-hunk / per-line / per-finding chat threads | `work/<id>/thread.json` | `taskforge-review` skill |
| **QA Plan** | a plain-Markdown QA test plan with a **Copy markdown** button (lift it into a ticket/email) | `work/<id>/qa-plan.md` | hand-written markdown |

In every tab a *separate Claude Code session* (the "reviewer") joins the chat by
reading and writing one plain JSON file (`thread.json`). No data ever leaves this
machine: **no MCP, no external API, no outbound network calls** — the source under
review never goes anywhere.

- **Stack:** Vite + React frontend; the "backend" is a Vite dev-server
  *middleware plugin* ([vite.config.mjs](vite.config.mjs) → [server/api.mjs](server/api.mjs)),
  so the whole tool is one process. Deps: `react`, `react-dom`, `vite`,
  `prismjs` (offline syntax highlighting), `@babel/standalone` (transforms
  `Page.jsx` in the browser — no build step), `marked` (Markdown for messages,
  QA plans, and `taskforge.Markdown`). No DB, no telemetry.
- **Navigation:** a **⌘K command palette** switches tasks (fuzzy filter, `#tag`
  to narrow), a **Manage** modal renames/deletes them, and an in-page **⌘F find
  bar** searches the rendered content (the editor's native find can't reach
  inside the diff/page). Three built-in **themes** (Navy / Dark neutral / Light)
  drive both the chrome and Log pages via `taskforge.theme`.

## Quick start

**Easiest — let Claude do it:** open this repo in **Claude Code** and ask it to
*"set up and start TaskForge"*. It runs setup and launches the server for you.

Or by hand:

```bash
git clone https://github.com/o1evo/TaskForge.git
cd TaskForge
npm run setup     # installs deps, makes the skills global, offers a localhost hosts alias
npm run review    # serves on http://127.0.0.1:7777
```

Open the printed URL — a **sample task** is already loaded, so you can click through all
three tabs immediately. Delete `work/sample/` once you've imported your own.

## Uninstall

Ask Claude to *"uninstall TaskForge"*, or run:

```bash
npm run uninstall-skill     # removes the global skill symlinks (safe; --force also removes copies)
```

Then, if you used them: `claude mcp remove taskforge` (the optional server MCP), drop the
`127.0.0.1 taskforge` line from `/etc/hosts`, and delete this folder (that also clears the
`.taskforge/` runtime state). Your `work/` data is just files — nothing is left behind elsewhere.

`npm run setup` also asks whether to add a `127.0.0.1 taskforge` line to `/etc/hosts`
(sudo, you can decline) so you can open TaskForge at **http://taskforge:7777** instead of the
loopback IP. The port and alias are configurable: set `TASKFORGE_PORT` (default `7777`) and/or
`TASKFORGE_HOST` (default `taskforge`) — both `npm run setup` and `npm run review` read them.
`npm run install-skill` alone (no deps, no alias) still works if you only want the skills global.

Open the printed URL. The app hosts **multiple tasks at once** — switch between
them with the **⌘K command palette** (or rename/delete via the **Manage**
modal); the 3s poll is scoped to the selected id.

**Requirements:** Node 18+ (the scripts use `node:` built-ins and `import.meta`).

### Server lifecycle via the `taskforge` MCP (optional)

Instead of keeping a terminal on `npm run review`, you can let a Claude session
manage the server through a tiny **zero-dependency MCP controller**
([bin/taskforge-mcp.mjs](bin/taskforge-mcp.mjs)). Register it once (user scope → available in
every project):

```bash
claude mcp add --scope user taskforge -- node /absolute/path/to/CodeReviews/bin/taskforge-mcp.mjs
```

Claude Code spawns the controller when a session starts; it **autostarts TaskForge**
(unless `TASKFORGE_AUTOSTART=0`) and runs it **detached**, so the server outlives the
MCP and the session. Tools:

- `taskforge_status` — running? URL + listening PIDs + log path.
- `taskforge_start` / `taskforge_stop` — bring it up (no-op if already up) / shut it down.
- **`taskforge_restart`** — reload after editing server-side code (`server/*.mjs`,
  `vite.config.mjs`), which Vite only reads at startup. (Client `src/` changes
  hot-reload — no restart needed.)
- `taskforge_logs` — tail the server log.

Runtime state (pidfile + log) lives in the gitignored `.taskforge/`. The controller is
only a *remote*: it acts while a Claude session exists, so it doesn't replace a
`launchd`/login daemon if you want TaskForge up before any session (or across reboots).

### Skills (the reviewer/author automation)

Claude Code skills ship **inside this repo** under
[.claude/skills/](.claude/skills/). The two core ones:

- **`taskforge-review`** — the reviewer bridge: answer threads, import / refresh /
  seed diffs (see "Participating as the reviewer").
- **`taskforge-worklog`** — author the Log page + QA plan for a task.

Two more drive larger workflows (see their sections below):

- **`gsd-bridge`** — mirror a [GSD / gsd-core](https://github.com/open-gsd/gsd-core) `.planning/` tree
  into a TaskForge task, and capture resolved review threads back into it.
- **`feature-stream`** — a supervised loop that turns a unit of work into a
  feature worktree + GSD workstream + a live TaskForge mirror.

When you run Claude Code **inside this repo**, project-level skills are
auto-discovered — **nothing to install.** To also drive reviews from *other*
repos, run `npm run install-skill` to symlink them into `~/.claude/skills/`
(`--copy` to copy instead, `--force` to replace an existing one). Only
`install-skill` installs the cross-project skills globally; running Claude
inside this repo always sees all of them.

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
- **Live diff streaming** ([server/livediff.mjs](server/livediff.mjs)): for a
  review imported from a repo, the backend re-runs `git diff` (using the stored
  `repo`/`base`/`head`) on every poll and overlays the **current** hunks, re-attaching
  annotations by hunk id — the persisted `hunks` are just the durable annotation
  store. So the Code Review tab reflects code edits within ~3s with **no manual
  re-import**. The re-diff is gated by a hash of the diff text, so it costs one
  fast `git` spawn per poll but only bumps `_mtime` (triggering a re-render) when
  the diff actually changed. On git failure it falls back to the persisted hunks
  and reports `_liveError`. (`--diff`-file imports have no repo, so they stay a
  static snapshot.)
- **Reviewer bridge:** a Claude session reads the JSON, answers pending author
  questions (in *any* tab's threads), and saves — the UI shows the reply on its
  next poll. No push/websockets (a Claude reviewer can't be pushed to); the app
  polls instead.
- **Page runtime** ([src/components/PageRuntime.jsx](src/components/PageRuntime.jsx)):
  the Log page is JSX compiled in the browser with `@babel/standalone` and run as
  `function Page({ taskforge }) { … }` (no imports/exports; `React` + hooks in scope). A
  compile or runtime error shows an error panel, never a white screen.
  **SECURITY:** this evaluates Claude-authored code — acceptable only because the
  tool is localhost-only and single-user. Do not expose it.

## Where state lives

One directory per task — **`work/<id>/`** — holding up to three files:

| file | feeds tab | required? |
|------|-----------|-----------|
| `thread.json` | Code Review (+ all chat threads, for every tab) | yes |
| `Page.jsx` | Log | optional (no file → no Log tab) |
| `qa-plan.md` | QA Plan | optional (no file → no QA tab) |

`thread.json` is the single source of truth for the diff, hunks, annotations, and
**every chat message across all three tabs** (Log/QA threads use `log:` keys, see
below). The `work/` tree is **gitignored** because it embeds proprietary
source. There is no database, no in-memory cache, no `localStorage`/cookies.
Restarting the server or reloading the tab changes nothing — both rebuild from
these files. (`work/seeds/*.json` are curated annotation inputs for `import`.)

By convention `<id>` is a short lowercase slug — a ticket id, an issue number, or
any stable name (e.g. `cu-1234`, `issue-42`, `auth-refactor`). Using the same id
for all three tabs is what pairs the work log, its diff, and its QA plan.

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
  | `"log:<anchor>"` | a thread on the Log page — either a free-selection comment or an author-placed `<taskforge.Thread>` | Log |
- **Anchors** (free-selection Log comments) live alongside `threads` and carry the
  quoted text plus `prefix`/`suffix` context so a comment **re-attaches by fuzzy
  text match** after Claude edits `Page.jsx`; if the quote no longer resolves it's
  flagged **outdated** rather than lost. Each anchor has a `state`
  (`open`/`resolved`/`hidden`). See [src/anchors.js](src/anchors.js) +
  [src/components/CommentLayer.jsx](src/components/CommentLayer.jsx).

Messages render **Markdown** via `marked` ([src/components/Markdown.jsx](src/components/Markdown.jsx)),
with fenced code blocks Prism-highlighted ([src/highlight.js](src/highlight.js)).
The same renderer backs `taskforge.Markdown` on a Log page and the whole QA Plan tab.

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

# Seed annotations/threads from a curated JSON (see work/seeds/):
node bin/import.mjs --repo ... --base ... --head ... --title "..." \
  --id my-id --seed work/seeds/my-seed.json

# Re-persist the snapshot or change the stored base/head/title:
node bin/import.mjs --id my-id --refresh
```

- `--head WORKTREE` diffs the working tree vs base — common, since branch work is
  often staged/unstaged, not yet committed to HEAD.
- `--seed <file>` attaches curated findings as annotations (targets hunks by
  `{file, contains?}`) and optional seed threads.
- **You usually don't need `--refresh` anymore:** the backend streams the diff
  live on every poll (see "Live diff streaming" above), so after-the-round code
  edits show up automatically. `--refresh` remains for re-persisting the snapshot
  or changing the stored `repo`/`base`/`head`/`title` — it re-runs the diff for an
  existing `--id` while preserving the conversation, annotations with their
  resolved/deleted states, and Log-page comment anchors.
- **`--force` is destructive:** re-import overwrites `thread.json` from the seed,
  wiping the live conversation. Only use it to start a fresh round.

## Authoring the Log & QA tabs

Both are Claude-authored files dropped into `work/<id>/`; the app picks them up
on the next 3s poll (no restart), and the tab only appears when its file exists.

- **Log page → `work/<id>/Page.jsx`** — bespoke interactive React for *this*
  task (status pill, findings, dated timeline, follow-ups). Contract: define
  `function Page({ taskforge }) { … }`, **no imports/exports**; `React` + hooks are in
  scope and `taskforge` is injected (data + `<taskforge.Thread target="log:…">` to pin a
  discussion + `<taskforge.Markdown>`). Readers can also select any text on the page to
  drop a 💬 comment (a `log:` anchor) — no code needed. Authored via the
  **`taskforge-worklog`** skill.
- **QA plan → `work/<id>/qa-plan.md`** — plain Markdown (no JSX), rendered with
  a **Copy markdown** button so QA can lift it into your tracker/email. Group by
  business capability, tier P0→P3, and give each case Do / Pass / Hits. Also
  covered by the `taskforge-worklog` skill.

> **Skills that drive this app:** `taskforge-worklog` (start a task, author the Log page
> + QA plan) and `taskforge-review` (the reviewer bridge — answer threads, import/
> refresh/seed diffs). Both are local-only and route through the same
> `thread.json`.

## GSD bridge — mirror a planning tree into a task

If your work is tracked in a [GSD / gsd-core](https://github.com/open-gsd/gsd-core) `.planning/` tree,
the **`gsd-bridge`** skill (CLIs [bin/import-gsd.mjs](bin/import-gsd.mjs) /
[bin/capture-gsd.mjs](bin/capture-gsd.mjs)) wires it to a TaskForge task — no
hand-authoring:

```bash
# Render STATE/ROADMAP/phases into the Log tab and the latest *-UAT.md into QA:
node bin/import-gsd.mjs --planning /path/to/.planning --id my-task --title "..."
#   ...add --repo/--base/--head to also populate the Code Review tab from a diff.

# Pull resolved review threads back into the planning artifacts:
node bin/capture-gsd.mjs --planning /path/to/.planning --id my-task
```

`import-gsd` writes `Page.jsx` (phases, plan tasks, state) and `qa-plan.md` (the
UAT matrix); both survive a `--refresh` and the Code Review tab still streams the
diff live. It can also inline an optional **custom tab** for extra planning prose.
`npm run import-gsd` / `npm run capture-gsd` wrap the same CLIs.

## feature-stream — supervised GSD ↔ TaskForge loop

The **`feature-stream`** skill ([bin/feature-stream.mjs](bin/feature-stream.mjs))
is a higher-level entrypoint: it turns a unit of work into a feature **git
worktree** + a **GSD workstream** + a **live TaskForge mirror**, then you drive the GSD
phases yourself and `refresh`/`integrate` at each checkpoint. Three subcommands —
`start`, `refresh`, `integrate`. Workstation-specific overlays of this loop also
ship as skills in [.claude/skills/](.claude/skills/).

## Relay — story checkpoint runner (PoC)

[bin/relay-*](bin/) is an experimental loop where a headless Claude works a story
and, when it hits a real product decision, posts a **code-anchored question into
TaskForge** and stops; a human answers in the diff context and clicks **▶ Resume
runner** (`POST /api/review/:id/run`). See [bin/relay-README.md](bin/relay-README.md).
**Security:** that endpoint runs a local process with no auth — fine for a
127.0.0.1 single box, but **gate it behind authentication before exposing TaskForge on
any network.**

## VS Code extension

[vscode-extension/](vscode-extension/) renders TaskForge inside a VS Code editor tab,
with a **▶ Start TaskForge** button when the server is down and a status-bar toggle. It
shares the same detached server (pid/log in `.taskforge/`) as the MCP, so an external
start/stop is reflected within 3s. Build + install:

```bash
cd vscode-extension && npx @vscode/vsce package
code --install-extension work-command-center-vscode-0.1.0.vsix
```

See [vscode-extension/README.md](vscode-extension/README.md) for commands and settings.

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

2. **The `taskforge-review` skill** (recommended) — ships in-repo at
   [.claude/skills/taskforge-review/](.claude/skills/taskforge-review/) and
   automates the same protocol safely. It auto-triggers when you ask Claude to
   "answer the review questions," "reply in the review app," import/seed a diff,
   etc. It ships helper scripts so you never hand-write into the file (run them
   from the repo root; they resolve the review root automatically):

   ```bash
   S=.claude/skills/taskforge-review/scripts
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

## Try it

Point it at any local git repo with a change to review (`<id>` is any short
lowercase slug):

```bash
# Review uncommitted work in some repo:
node bin/import.mjs --repo /path/to/repo --base main --head WORKTREE \
  --id my-change --title "My change"
npm run review        # open http://127.0.0.1:7777 (or http://taskforge:7777) and pick "my-change"
```

To seed curated findings as annotations, write a seed JSON (shape in
[.claude/skills/taskforge-review/references/thread-format.md](.claude/skills/taskforge-review/references/thread-format.md))
and pass `--seed work/seeds/<id>.json`. Everything under `work/` is
gitignored, so your diffs and conversations never get committed.

## License

[MIT](LICENSE).
