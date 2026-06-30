---
name: feature-stream-caveman
description: Token-lean variant of the supervised feature-stream loop. Drives the exact same GSD ↔ WCC mechanics as feature-stream, but engages the caveman plugin so conversational narration is compressed (~65% fewer output tokens) while machine-parsed artifacts stay verbatim. Use when the user says "feature stream caveman", "/feature-stream-caveman", or wants the supervised GSD ↔ WCC loop run token-lean. Three subcommands: start, refresh, integrate.
argument-hint: "start --repo <path> --slug <short>  ·  refresh --id <id> --worktree <path>  ·  integrate --worktree <path> --into <branch>"
---

# feature-stream-caveman — the token-lean overlay

This is the **caveman wiring** over the generic `feature-stream` skill. The
generic skill (CORE) owns the GSD ↔ WCC mechanics; this overlay adds exactly one
orthogonal thing: **caveman-style compressed narration** for the conversational
layer of the loop.

> Why split: `feature-stream` is the capability and stays style-neutral.
> Caveman is a separate, optional communication style. Keeping it as an overlay
> (not baked into the CLI or the base skill) means the loop runs identically with
> or without it — only the *talk* changes, never the *work*.

## Prerequisite — the caveman plugin

This variant **requires** the caveman plugin to be installed:

```bash
curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash
```

If `/caveman` is not available, fall back to plain `feature-stream` and tell the
user to install caveman first. Do not silently run uncompressed under this name.

## The one load-bearing rule: compress talk, never artifacts

Caveman compresses **conversational narration only**. The feature-stream loop is
built on machine-parsed artifacts, and these MUST stay verbatim — caveman style
must never bleed into them:

- The capture markers `**Decision:**` / `**Open question:**` / `**Blocker:**` —
  `capture-gsd` parses them literally.
- The `.planning/` tree — `import-gsd` re-projects it verbatim into WCC.
- Commit messages, thread bodies, and any text a CLI reads back.

So: narrate the loop in caveman; write the distilled outcome line and all GSD/WCC
artifacts in full, exact form. When in doubt, an artifact is *not* narration.

## Invocation

Run `/caveman` (default `full`, or the level the user names) once at the top of
the session, then drive the standard feature-stream subcommands unchanged:

### 1. start

```bash
node bin/feature-stream.mjs start --repo <path-to-repo> --slug <short> \
  [--base <ref>] [--id <wcc-id>] [--title "..."] [--branch <name>]
```

Same semantics as `feature-stream` start: worktree + branch off base, GSD
workstream, WCC mirror (`work/<wcc-id>/`). Narrate the result token-lean.

### 2. refresh — the checkpoint mirror

```bash
node bin/feature-stream.mjs refresh --id <wcc-id> --worktree <path> [--workstream <name>] [--base <ref>]
```

Review on WCC, discuss in threads. Mark each outcome with a single distilled
line — `**Decision:**` / `**Open question:**` / `**Blocker:**` — **in full form,
not compressed** — then capture it back:

```bash
node bin/capture-gsd.mjs --id <wcc-id> --planning <worktree>/.planning
```

### 3. integrate

```bash
node bin/feature-stream.mjs integrate --worktree <path> --into <target-branch> [--keep-worktree]
```

Same guards as the base skill: clean worktree, `--no-ff` merge, never pushes.

## Boundaries

- Do **not** fork or modify the `feature-stream` CLI — this overlay is skill-only.
- Do **not** apply caveman compression to capture markers, `.planning/` content,
  commit messages, or anything a CLI parses.
