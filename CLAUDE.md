# Work Command Center (WCC) — Claude operating guide

## First-run setup (do this once, before anything else)

If a user asks to **"use WCC" / "set up the Work Command Center" / "start tracking work"** and
the app isn't set up yet, run these from this repo's root:

```bash
npm run setup          # installs deps, makes the skills global, and offers an /etc/hosts alias
npm run review         # then start the app → http://127.0.0.1:7777  (or http://wcc:7777)
```

`npm run setup` does three things: `npm install` (deps), `node bin/install-skill.mjs` (symlink
the two skills into `~/.claude/skills/` so they work from ANY repo), and an **interactive prompt**
asking whether to add `127.0.0.1 wcc` to `/etc/hosts` (sudo; decline-able). The listen port
and alias are configurable via `WCC_PORT` (default `7777`) and `WCC_HOST` (default `wcc`) —
both `setup` and `review` honor them. If you only want the skills global, `npm run install-skill`
alone still works.

- `npm install` is required to run the app (`npm run review` → http://127.0.0.1:7777).
- `npm run install-skill` makes `work-log-v2` and `code-review-tool` **global**. This is
  **required for the normal cross-project workflow** (importing diffs from / logging work for
  *other* repos): the skills ship as *project-level* skills, so without this step Claude only
  discovers them while running inside **this** repo. Flags: `--copy` (copy instead of symlink, if
  the clone may move), `--force` (replace an existing skill of the same name).
- After install, from any repo the user can say *"new task" / "start tracking" / "use WCC"* and
  the `work-log-v2` / `code-review-tool` skills take over. Import a change with
  `node bin/import.mjs --repo <path> --base main --head WORKTREE --id <slug> --title "..."`.

---

# Reviewer protocol — read this before participating

You are the **reviewer** in a local, file-bridge code review. A human author is
reading an annotated diff in a web UI and asking you questions. You answer by
editing one JSON file on disk. There is no MCP, no server to call, no network.
The UI polls the file every 3 seconds, so your saved replies appear
automatically — the author does not refresh.

## The one file you touch

`reviews/<review-id>/thread.json`

If you weren't told the `<review-id>`, list the directories under `reviews/`
(ignore `reviews/seeds/`) and pick the one the author named, or the only one
present.

## Shape of the file (only the parts you edit)

```jsonc
{
  "review": { "id", "title", "repo", "base", "head", "createdAt" },
  "hunks": [
    { "id", "file", "range", "diff", "annotations": [ { "tag", "severity", "note" } ] }
  ],
  "threads": {
    "general":            [ { "id", "role", "text", "ts", "answered" } ],
    "<hunkId>":           [ { "id", "role", "text", "ts", "answered" } ]
  }
}
```

- `role` is `"author"` (the human) or `"reviewer"` (you).
- A thread key is either `"general"` or a hunk's `id` (e.g.
  `"app/models/failed_job.rb#0"`). The matching hunk holds the `diff` and the
  `annotations` that question is about — **read them for context before
  answering.**

## Your job, every turn

1. **Read** `reviews/<review-id>/thread.json`.
2. **Find** every message where `role == "author"` **and** `answered == false`.
   These are the open questions, across `general` and every hunk thread.
3. For each one, **understand the context**: read that thread's hunk `diff` and
   `annotations`. If you need more, read the real source in the `repo` at
   `base`/`head` — you have local file access.
4. **Append** a reply to the *same thread array*, immediately after the question:
   ```jsonc
   {
     "id": "r_<something-unique>",
     "role": "reviewer",
     "text": "Your answer. Be concrete and reference the hunk/line.",
     "ts": "<current ISO-8601 timestamp>",
     "answered": true
   }
   ```
5. **Mark the author's question answered**: set its `"answered": true`.
6. **Save** the file. Valid JSON only — preserve everything else byte-for-byte
   (other threads, hunks, annotations, the `review` block). Do not reorder or
   drop fields. Do not touch `diff` text.

## Rules

- Only ever **append** reviewer messages and **flip `answered` to true**. Never
  edit or delete the author's text, never remove other messages.
- One reviewer reply per open author question. If a question is unclear, still
  reply (ask for the clarification in your `text`) and set both `answered`s true
  so it doesn't loop.
- Keep `id`s unique within the file. A short prefix + a counter is fine
  (`r_1`, `r_2`, …); just don't collide with an existing `id`.
- `ts` should be the actual current time in ISO-8601 (e.g. `2026-06-04T18:22:05Z`).
- If there are **no** unanswered author messages, do nothing and say so.
- **Never** send any of this content anywhere off this machine. The diff is
  proprietary source.

## Quick checklist

- [ ] Opened `reviews/<id>/thread.json`
- [ ] Listed every `author` + `answered:false` message
- [ ] Read each one's hunk `diff` + `annotations` (and source if needed)
- [ ] Appended a `reviewer` reply with a fresh `id` and real `ts`
- [ ] Set the author message's `answered` to `true`
- [ ] Saved valid JSON; left everything else untouched
