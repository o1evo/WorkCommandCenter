// Stream the diff straight from the repo instead of serving the snapshot baked
// into thread.json at import time. Given a review's stored {repo, base, head},
// run the same `git diff` that bin/import.mjs runs and parse it to hunks — but
// on demand (every poll), so the Code Review tab always reflects current code
// with no manual `--refresh` step.
//
// This is the live counterpart to import.mjs's getDiff(): it honors the stored
// base/head (WORKTREE => `git diff <base>`; otherwise `git diff <base> <head>`).

import { execFileSync } from 'node:child_process';
import { parseDiff } from './diff.mjs';

// Stable, fast string hash (djb2). Used as a change-token over the raw diff
// text so the caller can tell "same diff as last poll" from "code changed"
// without diffing the parsed structures.
export function diffHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Run the live diff for a review's stored repo metadata.
// Returns { hunks, hash } or null when there's nothing to stream from (a
// --diff-file import has no repo). Throws on git failure — the caller decides
// whether to fall back to the persisted snapshot.
export function liveDiff(meta) {
  const repo = meta && meta.repo;
  if (!repo) return null;
  const base = meta.base || 'main';
  const head = meta.head || 'HEAD';

  // Mirror import.mjs: `--head WORKTREE` diffs the working tree (staged +
  // unstaged) against base; otherwise diff the committed range.
  const gitArgs = head === 'WORKTREE' ? ['diff', base] : ['diff', base, head];

  const text = execFileSync('git', ['-C', repo, ...gitArgs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { hunks: parseDiff(text), hash: diffHash(text) };
}
