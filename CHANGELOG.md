# Changelog

All notable changes to TaskForge are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/) (`0.x` while pre-stable). The app
and the VS Code extension share one version line — a single `vX.Y.Z` tag releases
both.

## [Unreleased]

_Work landed on `main` but not yet tagged goes here._

## [0.1.3-beta.1]

_Prerelease._

- Code Review sidebar is now a GitHub-style **file tree** (with file-type icons)
  that jumps to a file's section in the diff. The findings/comments index moved
  into a floating, per-tab **threads bubble** — Code Review threads and Log
  threads are kept separate.
- Replaced the theme dropdown + translucency toggle with a single **palette
  control**: one popover for Palette, a **Transparency** slider (thins the app
  backing so an editor vibrancy blur can show through — panels stay solid), and
  decorative **Backdrop** effects (Glow, Wash, Grid, Dotted grid, Hatch, Grain,
  Aurora) with an Intensity slider.
- The VS Code webview host is now transparent so the transparency setting can
  actually reach a vibrancy blur behind the panel.

## [0.1.2-beta.1]

_Prerelease._

- New TaskForge icon — an anvil with hammer and sparkles — for the VS Code
  activity bar, replacing the placeholder glyph. Tightened viewBox and a bolder
  outline so it reads at 16–24px.

## [0.1.0]

Baseline release.

- Three-tab task workspace (Log / Code Review / QA Plan) backed by plain
  `work/<id>/` files — no DB, no telemetry, nothing leaves the machine.
- Live `git diff` streaming with annotations re-attached by hunk id.
- Claude reviewer bridge over `thread.json`; `taskforge-review` + `taskforge-worklog` skills.
- `gsd-bridge` (import/capture a GSD `.planning/` tree) and `feature-stream`
  supervised loop.
- ⌘K command palette + Manage modal task switcher, ⌘F in-page find bar, and
  Navy / Dark neutral / Light themes.
- VS Code extension (webview panel + Start button + status bar).
- Optional `taskforge` MCP controller for detached server lifecycle.

[Unreleased]: https://github.com/o1evo/TaskForge/compare/v0.1.3-beta.1...HEAD
[0.1.3-beta.1]: https://github.com/o1evo/TaskForge/compare/v0.1.2-beta.1...v0.1.3-beta.1
[0.1.2-beta.1]: https://github.com/o1evo/TaskForge/releases/tag/v0.1.2-beta.1
[0.1.0]: https://github.com/o1evo/TaskForge/releases/tag/v0.1.0
