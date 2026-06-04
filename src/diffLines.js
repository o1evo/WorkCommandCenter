// Turn a hunk's raw patch text into renderable lines with old/new line numbers.
// Returns [{ kind: 'add'|'del'|'ctx'|'meta', text, oldNo, newNo }].
export function diffLines(diff) {
  const out = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      out.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw === '' ) continue;
    if (raw.startsWith('\\')) {
      out.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else {
      const text = raw.startsWith(' ') ? raw.slice(1) : raw;
      out.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}
