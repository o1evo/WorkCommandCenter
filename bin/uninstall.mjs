#!/usr/bin/env node
// Reverse install-skill.mjs: remove TaskForge's global skills from ~/.claude/skills, and
// print how to undo the optional bits setup added (the taskforge MCP, the /etc/hosts alias).
// Run via `npm run uninstall-skill`, or just ask Claude to "uninstall TaskForge".
//
//   node bin/uninstall.mjs           # remove the symlinks we created (safe)
//   node bin/uninstall.mjs --force   # ALSO remove copied skill dirs of the same name
//
// Safe by default: we only auto-remove a ~/.claude/skills/<name> that is a SYMLINK
// pointing back at THIS repo — never a skill you have from somewhere else. A copied
// skill (a real directory) can't be proven ours, so it's left unless you pass --force.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync, unlinkSync } from 'node:fs';

const FORCE = process.argv.slice(2).includes('--force');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, '.claude', 'skills');
const DEST = join(homedir(), '.claude', 'skills');

function isSymlink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

const names = existsSync(SRC)
  ? readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];

let removed = 0, skipped = 0;
for (const name of names) {
  const from = join(SRC, name);
  const to = join(DEST, name);

  if (!isSymlink(to) && !existsSync(to)) { console.log(`= ${name} (not installed)`); continue; }

  if (isSymlink(to)) {
    const target = resolve(dirname(to), readlinkSync(to));
    if (target === from) {
      unlinkSync(to); // removes the symlink only, never the repo's real skill files
      console.log(`- ${name} (unlinked)`);
      removed++;
    } else {
      console.log(`! ${name} → ${target} — points elsewhere, left alone`);
      skipped++;
    }
  } else {
    // a real directory: a --copy install, or your own same-named skill
    if (FORCE) {
      rmSync(to, { recursive: true, force: true });
      console.log(`- ${name} (removed copied dir)`);
      removed++;
    } else {
      console.log(`! ${name} is a directory (copied?) — can't prove it's ours; pass --force to remove`);
      skipped++;
    }
  }
}

console.log(`\nSkills: ${removed} removed${skipped ? `, ${skipped} left alone` : ''}.`);

// The optional extras setup may have added — we don't touch sudo or your Claude
// config, so undo these yourself if you used them:
const HOST_ALIAS = process.env.TASKFORGE_HOST || 'taskforge';
console.log('\nOptional extras to remove yourself:');
console.log('  • taskforge MCP (if you registered it):     claude mcp remove taskforge');
console.log(`  • /etc/hosts alias (if you added it): remove the "127.0.0.1 ${HOST_ALIAS}" line (needs sudo)`);
console.log(`  • the app + its runtime state (.taskforge/): just delete this folder — ${ROOT}`);
