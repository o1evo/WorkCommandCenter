# Changelog

All notable changes to TaskForge are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/) (`0.x` while pre-stable). The app
and the VS Code extension share one version line — a single `vX.Y.Z` tag releases
both.

## [Unreleased]

_Work landed on `main` but not yet tagged goes here._

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

[Unreleased]: https://github.com/o1evo/TaskForge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/o1evo/TaskForge/releases/tag/v0.1.0
