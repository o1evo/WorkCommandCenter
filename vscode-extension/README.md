# TaskForge — VS Code extension

Renders TaskForge inside a VS Code editor tab. When the server isn't running, the
panel shows a **▶ Start TaskForge** button instead of a blank frame; clicking it spawns
the dev server (detached, the same way `bin/taskforge-mcp.mjs` does) and swaps in the
live app once it's accepting connections.

## What it does

- **Webview panel** embeds `http://<host>:<port>` (default `127.0.0.1:7777`) in an iframe.
- **Start button** when the server is down — spawns `npm run review` detached so the
  server outlives the VS Code window. pid/log go to `<root>/.taskforge`, shared with the MCP.
- **Status-bar item** (`$(server) TaskForge`) shows running/stopped and opens the panel.
- Polls every 3s, so an external start/stop (MCP, terminal) is reflected automatically.

## Commands

| Command | Title |
| --- | --- |
| `taskforge.open` | Open the TaskForge panel |
| `taskforge.start` / `taskforge.stop` / `taskforge.restart` | Control the server |
| `taskforge.openExternal` | Open TaskForge in your browser |

## Settings

- `taskforge.rootPath` — path to the TaskForge repo (folder with `vite.config.mjs`). Blank =
  auto-detect from open workspace folders, then the extension's own location.
- `taskforge.port` — default `7777` (mirrors `TASKFORGE_PORT`).
- `taskforge.host` — host used to build the URL shown in the webview (e.g. `taskforge`).

## Run it

From this folder, open VS Code and press **F5** to launch an Extension
Development Host, or package + install:

```bash
cd vscode-extension
npx @vscode/vsce package      # produces work-command-center-vscode-0.1.0.vsix
code --install-extension work-command-center-vscode-0.1.0.vsix
```

Then run **TaskForge: Open** from the command palette.
