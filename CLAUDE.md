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
