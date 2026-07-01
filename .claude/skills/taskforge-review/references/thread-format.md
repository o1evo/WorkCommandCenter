# thread.json + seed format

Read this when importing, seeding, or hand-editing a review. Source of truth is the
CodeReviews app itself (`bin/import.mjs`, `server/diff.mjs` in the repo root).

## thread.json

Output of an import; lives at `work/<id>/thread.json` (gitignored — never committed).
The app lists every `work/<id>/` in a header switcher; each review is fully independent
and may target a different repo/clone (see `review.repo`). One reviewer session per id.

```json
{
  "review": { "id": "cu-1234", "title": "...", "repo": "/abs/path",
              "base": "main", "head": "WORKTREE", "createdAt": "ISO" },
  "hunks": [
    { "id": "app/models/widget.rb#0",   // <file>#<index>; also the thread key
      "file": "app/models/widget.rb",
      "range": "@@ -1,4 +1,9 @@",
      "diff": "<raw unified-diff text for this hunk>",
      "annotations": [ { "tag": "B-1 ...", "severity": "blocker", "note": "..." } ] }
  ],
  "threads": {
    "general": [ { "id": "m_1", "role": "author", "text": "...", "ts": "ISO", "answered": false } ],
    "app/models/widget.rb#0": [ /* messages keyed by hunk id */ ]
  }
}
```

- **Thread keys**: `"general"`, a hunk `id` (`<file>#<index>`, hunk-level chat), an
  **annotation `id`** (`<hunkId>::<slug(tag)>`, the per-finding thread), a per-line key
  (`<hunkId>#L<n>`), or a Log-page anchor (`log:<slug>`). Each annotation carries a
  deterministic `id`; a discussion follows each finding individually.
- **Message**: `{ id, role: "author"|"reviewer", text, ts, answered }`. Author messages
  carry `answered`; reviewer messages are always answered. `text` is Markdown (fenced
  ` ```lang ` code blocks + inline `` `code` ``).
- **Severity** styled by the UI: `blocker`, `high`, `medium`, `low`. Others render uncolored.
- Highlighted fence languages (grammars loaded): `ruby`/`rb`, `javascript`/`js`/`jsx`/`ts`,
  `json`, `yaml`/`yml`. Anything else → plain text.

## Import

```
node bin/import.mjs --repo <path> --base <ref> --head <ref> --id <id> --title "..." [--seed <file>]
node bin/import.mjs --diff <file.diff> --id <id> --title "..." [--seed <file>]
node bin/import.mjs --id <id> --refresh        # re-diff in place, keep the conversation
```

- `--head WORKTREE` → `git diff <base>` (working tree vs base) for uncommitted work.
  Otherwise `git diff <base> <head>`.
- Writes `work/<id>/thread.json` (atomic). Refuses to overwrite an existing review unless
  `--refresh` or `--force`.
- **`--refresh`** re-runs the diff for an existing review and writes new hunks while
  **preserving** annotations (re-attached by hunk id → resolved/deleted states carry over),
  threads, and Log-page anchors. repo/base/head/title default to the existing review. Use it
  after each round. Re-attachment is by hunk id (`<file>#<index>`), stable while a file's hunk
  structure is unchanged.
- **`--force`** regenerates from the diff + seed → **wipes any live conversation.** Fresh start only.

## Seed file (`work/seeds/<id>.json`)

Curated findings + optional starter threads, merged into matching hunks at import.

```json
{
  "review": { "title": "..." },
  "annotations": [
    { "file": "app/models/widget.rb", "contains": "optional substring to disambiguate",
      "annotations": [ { "tag": "B-1 ...", "severity": "blocker", "note": "..." } ] }
  ],
  "threads": [
    { "target": "general", "messages": [ { "role": "author", "answered": false, "text": "..." } ] },
    { "target": { "file": "app/x.rb", "contains": "..." }, "messages": [ ... ] }
  ]
}
```

- `annotations[].file` (+ optional `contains`) matches the first hunk for that file; its
  `annotations` are appended to that hunk.
- `threads[].target` is `"general"` or `{ file, contains }`; messages get ids/ts filled in.
- Mark a fixed finding by setting its `severity` to `resolved` and rewriting the note.

## Editing by hand vs the scripts

To **answer questions**, use `scripts/answer.mjs` (race-safe + atomic) — do not hand-write
the reply into `thread.json`, because the app backend may write concurrently and a naive
write loses data. For other edits (adding/resolving annotations), prefer re-import with an
updated seed; if editing `thread.json` directly, write to a temp file and `rename` it into
place so the 3s poll never reads a half-written file.
