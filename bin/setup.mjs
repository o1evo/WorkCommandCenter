#!/usr/bin/env node
// One-step WCC setup, run by `npm run setup` (after `npm install`):
//   1. install the skills globally (idempotent — delegates to install-skill.mjs)
//   2. OPTIONALLY add a friendly /etc/hosts alias so you can open WCC at
//      http://<alias>:<port> instead of http://127.0.0.1:<port>
//
// Everything is idempotent and interactive — safe to re-run. The hosts edit is
// only ever applied after you say yes; otherwise we print the manual command.
//
// Env knobs (shared with vite.config.mjs):
//   WCC_PORT        default 7777   — the port WCC listens on
//   WCC_HOST        default wcc — the alias to map to 127.0.0.1
//   WCC_HOSTS_FILE  default /etc/hosts (or the Windows hosts path) — overridable for testing
//   WCC_SKIP_SKILL_INSTALL=1        — skip step 1 (just (re)configure the alias)
// Extra args (e.g. --copy, --force) are passed through to install-skill.mjs.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.WCC_PORT) || 7777;
const HOST_ALIAS = process.env.WCC_HOST || 'wcc';
const IS_WIN = process.platform === 'win32';
const HOSTS_FILE = process.env.WCC_HOSTS_FILE
  || (IS_WIN ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts');
const URL = `http://${HOST_ALIAS}:${PORT}`;

// ── 1. install skills globally ──
if (process.env.WCC_SKIP_SKILL_INSTALL !== '1') {
  const r = spawnSync('node', [join(ROOT, 'bin', 'install-skill.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}

// ── 2. offer the hosts alias ──
await offerHostsAlias();

async function offerHostsAlias() {
  let hosts = '';
  try { hosts = readFileSync(HOSTS_FILE, 'utf8'); } catch { /* unreadable — fall through to manual */ }

  // Already mapped? Match the alias as a whole hosts field (preceded by whitespace,
  // followed by whitespace or EOL) so a bare alias like `wcc` is NOT considered present
  // just because `wcc.test` is — the trailing `(?![\w.-])` rules out `wcc.<anything>`.
  const aliasWord = HOST_ALIAS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^[^#\\n]*\\s${aliasWord}(?![\\w.-])`, 'm').test(hosts)) {
    console.log(`\n= ${HOST_ALIAS} already maps in ${HOSTS_FILE} — open ${URL}`);
    return;
  }

  // Non-interactive (CI / piped) — don't prompt; just show how.
  if (!process.stdin.isTTY) {
    console.log(`\nTip: add a "${HOST_ALIAS}" alias to open WCC at ${URL}:`);
    printManual();
    return;
  }

  const ans = (await ask(`\nAdd a "${HOST_ALIAS}" alias to ${HOSTS_FILE} so you can open ${URL}? (needs sudo) [y/N] `)).trim();
  if (!/^y(es)?$/i.test(ans)) {
    console.log('Skipped. Add it later with:');
    printManual();
    return;
  }

  if (IS_WIN) {
    console.log('\nOn Windows, add this line to the hosts file from an Administrator prompt:');
    printManual();
    return;
  }

  // Append with sudo; stdio inherited so the password prompt shows in the terminal.
  const line = `127.0.0.1 ${HOST_ALIAS}`;
  const r = spawnSync('sudo', ['sh', '-c', `printf '%s\\n' ${JSON.stringify(line)} >> ${JSON.stringify(HOSTS_FILE)}`], { stdio: 'inherit' });
  if (r.status === 0) {
    console.log(`\n+ Added "${line}" to ${HOSTS_FILE}. Open WCC at ${URL}`);
  } else {
    console.log('\n! Could not edit the hosts file automatically. Add it manually:');
    printManual();
  }
}

function printManual() {
  if (IS_WIN) {
    console.log(`    "127.0.0.1 ${HOST_ALIAS}"  ->  ${HOSTS_FILE}   (edit as Administrator)`);
  } else {
    console.log(`    echo "127.0.0.1 ${HOST_ALIAS}" | sudo tee -a ${HOSTS_FILE}`);
  }
  console.log(`  then open ${URL}`);
}

function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}
