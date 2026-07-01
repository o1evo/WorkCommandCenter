---
name: feature-stream
description: A supervised-local entrypoint that turns a unit of work into a feature worktree + GSD workstream + a live TaskForge mirror, then you drive the GSD phases yourself and refresh/capture at each checkpoint. Use when the user says "feature stream", "start a feature", "/feature-stream", or wants the supervised mode of a GSD ↔ TaskForge loop. Three subcommands: start, refresh, integrate.
argument-hint: "start --repo <path> --slug <short>  ·  refresh --id <id> --worktree <path>  ·  integrate --worktree <path> --into <branch>"
---

# feature-stream — supervised GSD ↔ TaskForge loop

One command turns a unit of work into a feature worktree + GSD workstream + a
live TaskForge mirror; then you drive the GSD phases and review/refresh at each
checkpoint. "Supervised" = you stop at every checkpoint and answer the forks
yourself (as opposed to an unattended runner).

```
unit of work → feature worktree + GSD workstream → GSD phase loop
   → CHECKPOINT (fork / phase boundary / failed gate):
        refresh TaskForge mirror → review in threads → capture back to GSD
   → resume → milestone done → integrate to the base
```

## Two load-bearing rules

1. **TaskForge is a refreshed mirror, not a live dashboard.** GSD's `.planning/` is the
   single source of truth. The TaskForge page updates **only** when you run `start` or
   `refresh`. The mirror direction is a *total re-projection* from one writer, so
   it can be stale but cannot drift. Human decisions flow back the one way:
   thread outcomes → `capture-gsd` → `TaskForge-CAPTURES.md` → ingested by GSD. TaskForge
   never writes GSD-owned files.
2. **The rooting golden rule.** GSD resolves `.planning/` from the current
   directory, and cwd resets to the parent between sessions. When you open a
   session to run the GSD phase loop, root it **inside the worktree** `start`
   prints — never the parent.

## Bring-your-own-launcher

If something in your environment **already created the worktree + GSD
workstream** (a launcher, a provisioning step), skip `start` entirely and use
`refresh` against that worktree to build/update the TaskForge mirror. `start` is the
self-contained path for when nothing else makes the worktree for you.

## Prerequisites

- Run the CLI from this TaskForge checkout (it ships `bin/feature-stream.mjs` +
  `bin/import-gsd.mjs`). The CLI is cwd-independent — `node <taskforge>/bin/feature-stream.mjs …`
  works from any directory.
- The target repo must be **GSD-initialized** on its base ref (`.planning/`
  present). `start` preflights this and tells you to initialize GSD first if not.
- `gsd-tools` present to create the workstream. Without it, `start` still builds
  the worktree + TaskForge page but soft-skips the workstream create.

## 1. start

```bash
node bin/feature-stream.mjs start --repo <path-to-repo> --slug <short> \
  [--base <ref>] [--id <taskforge-id>] [--title "..."] [--branch <name>]
```

- **Base** defaults to `main` (override with `--base`).
- **Worktree + branch:** creates `<repo>-<slug>` beside the repo on
  `feature/<slug>` (or `--branch`) off the base. Idempotent — reuses an existing
  worktree, reuses the branch if it exists.
- **GSD workstream:** `gsd-tools workstream create <slug>` inside the worktree.
- **TaskForge mirror:** `import-gsd` → `work/<taskforge-id>/` (Log tab from `.planning`,
  Code Review tab from the worktree diff vs base, QA tab from the latest phase UAT).

It prints the supervised loop with the exact next commands.

## 2. refresh — the checkpoint mirror

Each time the GSD phase loop stops, re-mirror the planning tree into TaskForge:

```bash
node bin/feature-stream.mjs refresh --id <taskforge-id> --worktree <path> [--workstream <name>] [--base <ref>]
```

Review on TaskForge (open `<taskforge-id>`), discuss in threads, mark each outcome with a
single distilled line — `**Decision:**` / `**Open question:**` / `**Blocker:**` —
then capture it back to GSD:

```bash
node bin/capture-gsd.mjs --id <taskforge-id> --planning <worktree>/.planning
```

## 3. integrate

At milestone-done, with the worktree committed and clean:

```bash
node bin/feature-stream.mjs integrate --worktree <path> --into <target-branch> [--keep-worktree]
```

- Guards on a clean worktree; `git checkout <into>` then `git merge --no-ff` —
  additive, so the planning knowledge travels back with the code.
- **Never pushes** — you review the merge and push yourself.
- Removes the worktree unless `--keep-worktree`.
