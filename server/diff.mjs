// Parse unified `git diff` output into a flat list of hunks.
//
// Each hunk: { id, file, range, diff } where
//   file  = the new path (b/…), or old path for deletions
//   range = the "@@ -a,b +c,d @@" header text
//   diff  = the raw patch text for just this hunk (header + body lines)
//   id    = `${file}#${indexWithinFile}` — deterministic for a given diff
//
// We keep this deliberately small: enough to render +/-/context lines and to
// give every hunk a stable id the seed file can target.

export function parseDiff(text) {
  const lines = text.split('\n');
  const hunks = [];
  let file = null;
  let perFileIndex = 0;
  let current = null;

  const flush = () => {
    if (current) {
      hunks.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      file = null;
      perFileIndex = 0;
      continue;
    }
    // Prefer the new path; fall back to old path for pure deletions.
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null') file = stripPrefix(p);
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null' && !file) file = stripPrefix(p);
      continue;
    }
    if (line.startsWith('@@')) {
      flush();
      const range = (line.match(/@@ .* @@/) || [line])[0];
      current = {
        id: `${file}#${perFileIndex}`,
        file,
        range,
        diff: line + '\n',
      };
      perFileIndex += 1;
      continue;
    }
    if (current) {
      // Body lines belong to the open hunk. Stop collecting at the next
      // file/hunk header (handled above) or trailing "\ No newline" markers.
      current.diff += line + '\n';
    }
  }
  flush();
  return hunks;
}

function stripPrefix(p) {
  // Drop the a/ or b/ git path prefix if present.
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

// Split a hunk's raw diff into renderable lines for the UI.
// Returns [{ kind: 'add'|'del'|'ctx'|'meta', text }].
export function hunkLines(diff) {
  return diff.split('\n').map((line) => {
    if (line.startsWith('@@')) return { kind: 'meta', text: line };
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
    if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) };
    if (line.startsWith('\\')) return { kind: 'meta', text: line };
    return { kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line };
  });
}
