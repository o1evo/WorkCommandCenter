// Work Command Center — VS Code extension.
//
// Renders WCC (a local Vite/React app on 127.0.0.1:<port>) inside a webview
// panel. When the server isn't up, the panel shows a Start button instead of a
// blank iframe. Starting reuses the same convention as bin/wcc-mcp.mjs: the dev
// server is spawned DETACHED so it outlives this VS Code window, and its pid/log
// land in <root>/.wcc — so the extension and the MCP control the same server.

const vscode = require('vscode');
const { spawn, execFile } = require('node:child_process');
const { createConnection } = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

// ── config ───────────────────────────────────────────────────────────────────

function cfg() {
  const c = vscode.workspace.getConfiguration('wcc');
  return {
    rootPath: (c.get('rootPath') || '').trim(),
    port: Number(c.get('port')) || 7777,
    host: (c.get('host') || '127.0.0.1').trim() || '127.0.0.1',
  };
}

// The URL rendered in the webview. Host is configurable (e.g. an /etc/hosts
// alias); the probe below always uses loopback since that's where it binds.
function wccUrl() {
  const { host, port } = cfg();
  return `http://${host}:${port}`;
}

// Locate the WCC repo: explicit config → an open workspace folder that looks
// like WCC → the extension's own parent (it ships inside the repo).
function resolveRoot() {
  const { rootPath } = cfg();
  if (rootPath && looksLikeWcc(rootPath)) return rootPath;
  for (const f of vscode.workspace.workspaceFolders || []) {
    if (looksLikeWcc(f.uri.fsPath)) return f.uri.fsPath;
  }
  const parent = path.resolve(__dirname, '..');
  if (looksLikeWcc(parent)) return parent;
  return rootPath || parent; // best effort
}

function looksLikeWcc(dir) {
  try {
    return fs.existsSync(path.join(dir, 'vite.config.mjs')) &&
           fs.existsSync(path.join(dir, 'package.json'));
  } catch { return false; }
}

// ── server lifecycle (mirrors bin/wcc-mcp.mjs) ────────────────────────────────

function isUp(timeoutMs = 600) {
  const { port } = cfg();
  return new Promise((res) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    const done = (up) => { sock.destroy(); res(up); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function listeningPids() {
  const { port } = cfg();
  return new Promise((res) => {
    execFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], (err, out) => {
      if (err || !out) return res([]);
      res(String(out).split('\n').map((s) => s.trim()).filter(Boolean));
    });
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn `npm run review` detached + unref'd so the server survives this window.
async function startServer() {
  if (await isUp()) return { started: false, alreadyRunning: true };
  const root = resolveRoot();
  if (!looksLikeWcc(root)) {
    throw new Error(`Could not find the WCC repo. Set "wcc.rootPath" in settings (looked at: ${root}).`);
  }
  const stateDir = path.join(root, '.wcc');
  fs.mkdirSync(stateDir, { recursive: true });
  const fd = fs.openSync(path.join(stateDir, 'server.log'), 'a');
  const child = spawn('npm', ['run', 'review'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref();
  try { fs.writeFileSync(path.join(stateDir, 'server.pid'), String(child.pid)); } catch {}
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await delay(300);
    if (await isUp()) return { started: true };
  }
  throw new Error(`WCC did not come up on :${cfg().port} within 20s — check ${path.join(stateDir, 'server.log')}.`);
}

async function stopServer() {
  const pids = await listeningPids();
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch {}
  }
  return { stopped: pids.length > 0, killed: pids };
}

async function restartServer() {
  await stopServer();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await isUp())) await delay(200);
  return startServer();
}

// ── webview ───────────────────────────────────────────────────────────────────

// The editor panel renders the app (full width). The activity-bar icon is just a
// launcher: clicking it reveals a tiny view that immediately opens this panel and
// collapses the sidebar — so the icon behaves like an "open WCC in editor" button.
let panel = null;          // vscode.WebviewPanel | null
let pollTimer = null;
let lastUp = null;

function escAttr(s) { return String(s).replace(/"/g, '&quot;'); }

function runningHtml(url) {
  // CSP must explicitly allow framing the WCC origin. default-src 'none' keeps
  // everything else locked down; the iframe gets its own permissions via sandbox.
  //
  // `allow` delegates Permissions-Policy features to the cross-origin (127.0.0.1)
  // iframe. clipboard-write defaults to `self` only, so without this the embedded
  // app — and ⌘C of a selection — can't write to the clipboard at all.
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; frame-src ${url}; style-src 'unsafe-inline';">
<style>
  html, body { margin:0; padding:0; height:100%; width:100%; overflow:hidden; background:#1e1e1e; }
  iframe { border:0; width:100%; height:100%; display:block; }
</style></head>
<body>
  <iframe src="${escAttr(url)}"
    allow="clipboard-read ${url}; clipboard-write ${url}"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads">
  </iframe>
</body></html>`;
}

function downHtml(url, starting) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html, body { margin:0; height:100%; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  body { display:flex; align-items:center; justify-content:center; background: var(--vscode-editor-background); }
  .card { text-align:center; max-width:420px; padding:1.5rem; }
  h1 { font-size:1.1rem; font-weight:600; margin:0 0 .4rem; }
  p { opacity:.75; margin:0 0 1.2rem; line-height:1.5; font-size:.85rem; word-break:break-all; }
  code { background: var(--vscode-textCodeBlock-background); padding:.1em .4em; border-radius:3px; }
  button {
    font-size:.9rem; padding:.55rem 1.2rem; border:0; border-radius:4px; cursor:pointer; margin:.2rem;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity:.6; cursor:default; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .spin { display:inline-block; width:1em; height:1em; vertical-align:-.15em; margin-right:.5em;
    border:2px solid currentColor; border-right-color:transparent; border-radius:50%;
    animation: r .7s linear infinite; }
  @keyframes r { to { transform: rotate(360deg); } }
</style></head>
<body>
  <div class="card">
    <h1>WCC isn't running</h1>
    <p>Expected at <code>${escAttr(url)}</code>.</p>
    <button id="start" ${starting ? 'disabled' : ''}>
      ${starting ? '<span class="spin"></span>Starting…' : '▶ Start WCC'}
    </button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const btn = document.getElementById('start');
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span>Starting…';
      vscode.postMessage({ type: 'start' });
    });
  </script>
</body></html>`;
}

// Wire the panel webview to the Start button message.
function attach(webview) {
  webview.onDidReceiveMessage(async (msg) => {
    if (msg && msg.type === 'start') {
      try { await render(true); await startServer(); }
      catch (e) { vscode.window.showErrorMessage(`WCC: ${e.message}`); }
      await render(false);
    }
  });
}

// Refresh the panel. `starting` paints the in-progress button state.
async function render(starting) {
  if (!panel) return;
  const up = await isUp();
  lastUp = up;
  const url = wccUrl();
  panel.webview.html = up ? runningHtml(url) : downHtml(url, !!starting);
}

// Hard-reload the webview. Repainting the same HTML won't reload the iframe, so
// blank it first, then repaint with a cache-busting query so the embedded app
// reloads from scratch — the recovery path for a wedged view (F5).
async function reload() {
  if (!panel) { await openPanel(); return; }
  if (!(await isUp())) { await render(false); return; }
  const url = wccUrl();
  const busted = url + (url.includes('?') ? '&' : '?') + 'r=' + Date.now();
  panel.webview.html = '<!DOCTYPE html><html><body></body></html>';
  panel.webview.html = runningHtml(busted);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!panel) return stopPolling();
    const up = await isUp();
    if (up !== lastUp) await render(false); // reflect external start/stop
  }, 3000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function openPanel() {
  if (panel) { panel.reveal(vscode.ViewColumn.Active); return; }
  panel = vscode.window.createWebviewPanel('wcc', 'Work Command Center', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.onDidDispose(() => { panel = null; stopPolling(); });
  attach(panel.webview);
  await render(false);
  startPolling();
}

// The activity-bar view is a launcher only: as soon as it becomes visible
// (icon clicked), open the editor panel and collapse the sidebar, so the icon
// acts like an "open WCC in editor" button rather than hosting the app itself.
const sidebarProvider = {
  resolveWebviewView(webviewView) {
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);
  padding:1rem;font-size:.85rem;line-height:1.5}</style></head>
<body>Opening Work Command Center in the editor…</body></html>`;
    const launch = () => {
      if (!webviewView.visible) return;
      openPanel();
      // Collapse the sidebar so the icon click reads as "open in editor".
      vscode.commands.executeCommand('workbench.action.closeSidebar');
    };
    webviewView.onDidChangeVisibility(launch);
    launch();
  },
};

// ── status bar ─────────────────────────────────────────────────────────────────

let statusItem = null;

async function refreshStatusBar() {
  if (!statusItem) return;
  const up = await isUp();
  statusItem.text = up ? '$(server) WCC' : '$(debug-disconnect) WCC';
  statusItem.tooltip = up ? `WCC running — ${wccUrl()} (click to open)` : 'WCC stopped — click to open / start';
  statusItem.show();
}

// ── activation ───────────────────────────────────────────────────────────────

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'wcc.open';
  context.subscriptions.push(statusItem);

  const sbTimer = setInterval(refreshStatusBar, 4000);
  context.subscriptions.push({ dispose: () => clearInterval(sbTimer) });
  refreshStatusBar();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('wcc.sidebar', sidebarProvider),
    vscode.commands.registerCommand('wcc.open', () => openPanel()),
    vscode.commands.registerCommand('wcc.start', async () => {
      try {
        const r = await startServer();
        vscode.window.showInformationMessage(r.alreadyRunning ? 'WCC already running.' : 'WCC started.');
      } catch (e) { vscode.window.showErrorMessage(`WCC: ${e.message}`); }
      await refreshStatusBar();
      if (panel) await render(false);
    }),
    vscode.commands.registerCommand('wcc.stop', async () => {
      const r = await stopServer();
      vscode.window.showInformationMessage(r.stopped ? `WCC stopped (pid ${r.killed.join(', ')}).` : 'WCC was not running.');
      await refreshStatusBar();
      if (panel) await render(false);
    }),
    vscode.commands.registerCommand('wcc.restart', async () => {
      try { await restartServer(); vscode.window.showInformationMessage('WCC restarted.'); }
      catch (e) { vscode.window.showErrorMessage(`WCC: ${e.message}`); }
      await refreshStatusBar();
      if (panel) await render(false);
    }),
    vscode.commands.registerCommand('wcc.openExternal', () => {
      vscode.env.openExternal(vscode.Uri.parse(wccUrl()));
    }),
    vscode.commands.registerCommand('wcc.refresh', () => reload()),
  );
}

function deactivate() { stopPolling(); }

module.exports = { activate, deactivate };
