# CodeReviews — local, private, file-bridge code review

A localhost web app for reviewing a code change as annotated diff hunks **and**
chatting about each hunk — where a *separate Claude Code session* (the
"reviewer") joins the chat by reading and writing a plain JSON file. No data
ever leaves this machine: no MCP, no external API, no outbound network calls.

## Run it

```bash
npm install
npm run review      # starts Vite + the file-bridge API on http://127.0.0.1:5174
```

Open the printed URL. If more than one review exists, pick it from the dropdown.

## How it works

- **Frontend:** Vite + React (`src/`). Polls `GET /api/review/:id` every 3s and
  re-renders only when the file's mtime changes.
- **Backend:** a tiny request handler (`server/api.mjs`) mounted as Vite
  middleware — one process, localhost only, filesystem only.
- **Data:** each review lives in `reviews/<id>/thread.json` (gitignored, because
  it embeds proprietary source). See the data model in that file.
- **Reviewer bridge:** a Claude Code session reads the JSON, answers pending
  author questions, and saves — the UI picks the replies up on its next poll.
  The protocol is in [CLAUDE.md](CLAUDE.md).

## API

| Method | Route | Body | Effect |
|--------|-------|------|--------|
| GET  | `/api/reviews` | — | list `{id, title}` |
| GET  | `/api/review/:id` | — | full `thread.json` (+ `_mtime`) |
| POST | `/api/review/:id/message` | `{target, text}` | append `role:"author"` message (`answered:false`) |
| POST | `/api/review/:id/annotations` | `{target, annotations}` | replace a hunk's annotations |

`target` is `"general"` or a hunk `id` (e.g. `app/models/failed_job.rb#0`).

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
```

Hunk ids are `"<file>#<indexWithinFile>"` and are stable for a given diff, so
seed files can target them by `{file, contains?}`.

## Seeded example

`reviews/cu-86ah0tff9/thread.json` is the in-flight f2 review
(`feature/ov-resilient-job-enqueue-fallback-CU-86ah0tff9`), with the round-2
self-review findings attached as annotations. Regenerate it with:

```bash
node bin/import.mjs --repo /Users/kassiter/code/f2 --base main --head WORKTREE \
  --title "Resilient job enqueue fallback (CU-86ah0tff9)" \
  --id CU-86ah0tff9 --seed reviews/seeds/CU-86ah0tff9.json --force
```
