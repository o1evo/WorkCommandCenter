#!/usr/bin/env node
// One-step TaskForge setup, run by `npm run setup` (after `npm install`):
//   1. install the skills globally (idempotent — delegates to install-skill.mjs)
//   2. OPTIONALLY add a friendly /etc/hosts alias so you can open TaskForge at
//      http://<alias>:<port> instead of http://127.0.0.1:<port>
//
// Everything is idempotent and interactive — safe to re-run. The hosts edit is
// only ever applied after you say yes; otherwise we print the manual command.
//
// Env knobs (shared with vite.config.mjs):
//   TASKFORGE_PORT        default 7777   — the port TaskForge listens on
//   TASKFORGE_HOST        default taskforge — the alias to map to 127.0.0.1
//   TASKFORGE_HOSTS_FILE  default /etc/hosts (or the Windows hosts path) — overridable for testing
//   TASKFORGE_SKIP_SKILL_INSTALL=1        — skip step 1 (just (re)configure the alias)
// Extra args (e.g. --copy, --force) are passed through to install-skill.mjs.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TASKFORGE_PORT) || 7777;
const HOST_ALIAS = process.env.TASKFORGE_HOST || 'taskforge';
const IS_WIN = process.platform === 'win32';
const HOSTS_FILE = process.env.TASKFORGE_HOSTS_FILE
  || (IS_WIN ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts');
const URL = `http://${HOST_ALIAS}:${PORT}`;

// ── 1. install skills globally ──
if (process.env.TASKFORGE_SKIP_SKILL_INSTALL !== '1') {
  const r = spawnSync('node', [join(ROOT, 'bin', 'install-skill.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}

// ── 2. offer the hosts alias ──
await offerHostsAlias();

async function offerHostsAlias() {
  let hosts = '';
  try { hosts = readFileSync(HOSTS_FILE, 'utf8'); } catch { /* unreadable — fall through to manual */ }

  // Already mapped? Match the alias as a whole hosts field (preceded by whitespace,
  // followed by whitespace or EOL) so a bare alias like `taskforge` is NOT considered present
  // just because `taskforge.test` is — the trailing `(?![\w.-])` rules out `taskforge.<anything>`.
  const aliasWord = HOST_ALIAS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^[^#\\n]*\\s${aliasWord}(?![\\w.-])`, 'm').test(hosts)) {
    console.log(`\n= ${HOST_ALIAS} already maps in ${HOSTS_FILE} — open ${URL}`);
    return;
  }

  // Non-interactive (CI / piped) — don't prompt; just show how.
  if (!process.stdin.isTTY) {
    console.log(`\nTip: add a "${HOST_ALIAS}" alias to open TaskForge at ${URL}:`);
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
    console.log(`\n+ Added "${line}" to ${HOSTS_FILE}. Open TaskForge at ${URL}`);
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
