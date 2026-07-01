# Releasing TaskForge

Releases are cut on the **public repo** (`o1evo/TaskForge` — the `upstream`
remote). The Finario fork (`finarioapp`, the `origin` remote) tracks it and stacks
the Finario-only skills (`feature-stream-wtf*`) on top; it is **never** tagged for
public consumption.

The app and the VS Code extension share **one version line** — a single `vX.Y.Z`
tag releases both. SemVer, `0.x` while pre-stable.

## How changes flow

1. Build a feature on a short-lived branch off `main`. Keep each commit
   **core-XOR-Finario** (see the `oss-finario` discipline) so core work can be
   upstreamed cleanly.
2. Merge to `finarioapp/main` (your day-to-day).
3. **Upstream the core commits to `o1evo/main`** (cherry-pick / the oss-finario
   flow). The 2 Finario-only skills stay behind.

## Cutting a release (on the public repo)

1. Bump the version in **both** `package.json` and `vscode-extension/package.json`
   (keep them equal).
2. Move the `[Unreleased]` notes in `CHANGELOG.md` under a new `## [X.Y.Z]`
   heading and update the compare links at the bottom.
3. Commit (`chore(release): vX.Y.Z`) and push to `o1evo/main`.
4. Tag and push the tag to the public remote:
   ```bash
   git tag vX.Y.Z
   git push upstream vX.Y.Z      # `upstream` = o1evo
   ```
5. The **Release** GitHub Action ([.github/workflows/release.yml](.github/workflows/release.yml))
   fires on the `v*` tag: it verifies the tag matches the extension version,
   runs `vsce package`, and publishes a GitHub Release with the `.vsix` attached
   and notes pulled from the matching `CHANGELOG.md` section.

Users install the extension from the release with:

```bash
code --install-extension work-command-center-vscode-X.Y.Z.vsix
```

## Later, if reach matters

- **Open VSX** (`ovsx publish`) — free, no Microsoft account, reaches Cursor /
  VSCodium too.
- **VS Code Marketplace** (`vsce publish`) — widest reach; needs a registered
  Azure DevOps publisher (the current `publisher: "taskforge"` must become a real
  registered id) and the `repository` field that's now set.
