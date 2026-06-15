#!/usr/bin/env node
// WCC controller — a tiny, zero-dependency MCP (stdio) server that lets a Claude
// session manage the Work Command Center dev server's lifecycle: status / start /
// stop / restart / logs.
//
// Why an MCP instead of `npm run review` in a terminal: the dev server kept
// dying with whatever terminal or agent launched it. This controller starts WCC
// **detached** (its own process group, unref'd), so the server OUTLIVES both this
// MCP process and the Claude session — the MCP is a remote control, not the
// parent. It also means "I changed server/api.mjs, restart it" is a single tool
// call (wcc_restart) instead of a manual kill + relaunch.
//
// Transport: newline-delimited JSON-RPC 2.0 on stdio (the MCP stdio convention).
// stdout carries ONLY protocol messages; everything human-facing goes to stderr
// or the server log. No external deps — the protocol surface we need is small.
//
// Register (user scope, available in every project):
//   claude mcp add --scope user wcc -- node /Users/kassiter/code/CodeReviews/bin/wcc-mcp.mjs
//
// Env knobs (shared with vite.config.mjs / setup.mjs):
//   WCC_PORT       default 7777   — the port WCC listens on
//   WCC_HOST       default wcc.test — host shown in the opened URL
//   WCC_AUTOSTART  default 1      — start WCC on MCP init if not already up (0 to disable)

import { spawn, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { openSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WCC_PORT) || 7777;
const HOST = process.env.WCC_HOST || 'wcc.test';
const URL = `http://${HOST}:${PORT}`;
const STATE_DIR = join(ROOT, '.wcc');
const LOG_FILE = join(STATE_DIR, 'server.log');
const PID_FILE = join(STATE_DIR, 'server.pid');

const log = (...a) => process.stderr.write(`[wcc-mcp] ${a.join(' ')}\n`);

// ── server lifecycle ────────────────────────────────────────────────────────

// Is something accepting connections on PORT? A direct TCP probe — no lsof, no
// HTTP assumptions — so it works the instant Vite binds the socket.
function isUp(timeoutMs = 600) {
  return new Promise((res) => {
    const sock = createConnection({ host: '127.0.0.1', port: PORT });
    const done = (up) => { sock.destroy(); res(up); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// PIDs currently listening on PORT (the source of truth for stop — more reliable
// than our recorded pid, since the listener is a grandchild of `npm run review`).
function listeningPids() {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // lsof exits non-zero when nothing matches
  }
}

async function start() {
  if (await isUp()) return { started: false, alreadyRunning: true, url: URL };
  mkdirSync(STATE_DIR, { recursive: true });
  const fd = openSync(LOG_FILE, 'a');
  // detached + own stdio + unref => survives this MCP process and the session.
  const child = spawn('npm', ['run', 'review'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  // Wait for the socket to come up so we report truthfully (Vite takes ~1-2s).
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await delay(300);
    if (await isUp()) return { started: true, url: URL, launcherPid: child.pid };
  }
  return { started: false, error: `server did not come up on :${PORT} within 20s — see ${LOG_FILE}`, url: URL };
}

function stop() {
  const pids = listeningPids();
  if (pids.length === 0) return { stopped: false, wasRunning: false };
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
  }
  return { stopped: true, killed: pids };
}

async function restart() {
  const before = stop();
  // Give the port a moment to free before rebinding (strictPort would fail otherwise).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await isUp())) await delay(200);
  const after = await start();
  return { restarted: true, ...before, ...after };
}

async function status() {
  const up = await isUp();
  return { running: up, url: URL, port: PORT, pids: up ? listeningPids() : [], logFile: LOG_FILE, root: ROOT };
}

function tailLog(lines = 60) {
  if (!existsSync(LOG_FILE)) return `(no log yet at ${LOG_FILE})`;
  const all = readFileSync(LOG_FILE, 'utf8').split('\n');
  return all.slice(-lines).join('\n');
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── MCP tool surface ──────────────────────────────────────────────────────────

const TOOLS = [
  { name: 'wcc_status', description: `Report whether the Work Command Center (WCC) dev server is running, its URL (${URL}), listening PIDs, and the log path.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'wcc_start', description: 'Start the WCC dev server detached (survives this session). No-op if already running. Waits until it is accepting connections, then returns the URL.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'wcc_stop', description: 'Stop the WCC dev server (SIGTERM the process listening on its port).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'wcc_restart', description: 'Restart the WCC dev server — use after changing server-side code (server/*.mjs, vite.config.mjs) so the new code is loaded.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'wcc_logs', description: 'Return the tail of the WCC server log (default 60 lines).',
    inputSchema: { type: 'object', properties: { lines: { type: 'integer', minimum: 1, maximum: 1000 } }, additionalProperties: false } },
];

async function runTool(name, args) {
  switch (name) {
    case 'wcc_status': return status();
    case 'wcc_start': return start();
    case 'wcc_stop': return stop();
    case 'wcc_restart': return restart();
    case 'wcc_logs': return { log: tailLog(args && args.lines) };
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// ── JSON-RPC stdio plumbing ─────────────────────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) — acknowledge by doing nothing that needs a response.
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('client initialized');
    return;
  }
  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'wcc', version: '0.1.0' },
        });
        // Streamline: bring WCC up on session start unless disabled.
        if (process.env.WCC_AUTOSTART !== '0') {
          start().then((r) => log('autostart:', JSON.stringify(r))).catch((e) => log('autostart failed:', e.message));
        }
        return;
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call': {
        const result = await runTool(params.name, params.arguments || {});
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      }
      default:
        return replyError(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    // For a failed tool call, surface the error as tool content (isError) so the
    // model sees it; for protocol methods, a JSON-RPC error.
    if (method === 'tools/call') {
      return reply(id, { content: [{ type: 'text', text: String(err && err.message ? err.message : err) }], isError: true });
    }
    return replyError(id, -32603, String(err && err.message ? err.message : err));
  }
}

let buf = '';
const pending = new Set(); // in-flight handlers, so we don't exit mid-response
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('bad JSON-RPC line:', line.slice(0, 200)); continue; }
    const p = Promise.resolve(handle(msg)).catch((e) => log('handler error:', e.message)).finally(() => pending.delete(p));
    pending.add(p);
  }
});
// Client closed the pipe — drain any in-flight handler, then exit cleanly.
process.stdin.on('end', async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
log(`ready — controlling WCC on :${PORT} (${URL}); root=${ROOT}`);
