---
name: taskforge-release
description: Cut a versioned release of the TaskForge — bump the shared app + VS Code extension version, update the changelog, tag on the public repo, and let CI build and publish the .vsix. Use when the user says "release TaskForge", "cut a release", "tag a version", "publish the extension", "ship a new TaskForge version", or invokes /taskforge-release. The app and extension share one version line; a single vX.Y.Z tag releases both via .github/workflows/release.yml.
argument-hint: "[patch|minor|major | explicit vX.Y.Z]   (default: ask)"
---

# taskforge-release — cut a TaskForge release

Releases are cut on the **canonical public repo** (`o1evo/TaskForge`, the
`upstream` remote). The app and the VS Code extension **share one version line** —
a single `vX.Y.Z` tag releases both. SemVer; stay in `0.x` while pre-stable.

The release machinery already exists in the repo — this skill drives it; it does
not reinvent it:

- [.github/workflows/release.yml](../../../.github/workflows/release.yml) — fires
  on a `v*` tag: verifies the tag matches the extension version, runs
  `vsce package`, and publishes a GitHub Release with the `.vsix` attached and
  notes from the matching `CHANGELOG.md` section.
- [CHANGELOG.md](../../../CHANGELOG.md) — Keep-a-Changelog; `[Unreleased]` on top.
- [RELEASING.md](../../../RELEASING.md) — the full prose checklist, including the
  downstream-fork sync below.

## The flow in one breath

feature branch off `main` → keep commits **core-XOR-Finario** → merge to the fork
→ **upstream the core commits to `o1evo`** → bump both versions + changelog →
`git tag vX.Y.Z && git push upstream vX.Y.Z` → CI builds & publishes the release
with the `.vsix`. Users install with
`code --install-extension work-command-center-vscode-X.Y.Z.vsix`.

## Steps

0. **Pick the version.** Ask if not given. `0.x`: behaviour-y change → minor
   (`0.2.0`), fixes only → patch (`0.1.1`). Confirm the target before touching
   files.

1. **(Finario fork only) Sync core to the public repo first.** If you maintain a
   downstream fork (e.g. `finarioapp`), the public `o1evo` repo must hold every
   OSS-core commit before you tag — Finario-only content (the `*-wtf*` skills,
   `bin/relay-*`, `deploy/`, the `/run` endpoint wiring) stays behind. This is the
   `oss-finario` discipline: *capability CORE, instance FINARIO.* See
   [RELEASING.md](../../../RELEASING.md). If you release straight from `o1evo`
   with no fork, skip this step.

2. **Bump the version in both manifests, kept equal:**
   - `package.json` → `version`
   - `vscode-extension/package.json` → `version`
   (The CI tag-vs-version guard fails the release if these don't match the tag.)

3. **Update `CHANGELOG.md`:** move the `[Unreleased]` notes under a new
   `## [X.Y.Z]` heading and update the compare-link footnotes at the bottom.

4. **Commit** on the public repo's `main`: `chore(release): vX.Y.Z`, and push.

5. **Tag and push the tag to the public remote** (this is what triggers CI):
   ```bash
   git tag vX.Y.Z
   git push upstream vX.Y.Z      # upstream = o1evo
   ```

6. **Verify the release.** Watch the **Release** Action; confirm the GitHub
   Release appears with `work-command-center-vscode-X.Y.Z.vsix` attached and the
   changelog notes. If the run failed on the version guard, the tag and a
   manifest disagree — fix and re-tag.

## Guardrails

- **Never tag the Finario fork for public consumption** — releases live on
  `o1evo` only.
- **Don't hand-build and commit a `.vsix`** — it's gitignored and CI produces it.
- Keep the two `version` fields equal; the guard exists to catch a forgotten bump.
- Wider distribution (Open VSX, VS Code Marketplace) is deferred — see the tail
  of [RELEASING.md](../../../RELEASING.md). Marketplace needs a real registered
  `publisher` (currently `"taskforge"`).
