// Pure DOM/text helpers for free-selection comment anchoring on a Log page.
//
// An anchor is { quote, prefix, suffix } — the selected text plus a little
// surrounding context. We store character offsets relative to the *concatenation
// of the page container's text nodes* (a single consistent coordinate space used
// for both capture and re-location), then re-derive a DOM Range from offsets to
// paint overlay highlights. Re-location is fuzzy: if the quote no longer appears
// after Claude edits the page, the anchor is "orphaned" (caller decides).

const CTX = 40; // chars of prefix/suffix context kept for disambiguation

// All text nodes under `root`, in document order — but skip the comment layer's
// own UI (anything under [data-wcc-ui]) so highlights/popover text never pollute
// the coordinate space we anchor against.
function textNodes(root) {
  const out = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      for (let p = n.parentElement; p && p !== root.parentElement; p = p.parentElement) {
        if (p.hasAttribute && p.hasAttribute('data-wcc-ui')) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walk.nextNode())) out.push(n);
  return out;
}

function fullText(root) {
  return textNodes(root).map((n) => n.nodeValue).join('');
}

// Absolute offset (in fullText space) of a (node, offsetInNode) position.
function offsetOf(root, node, offsetInNode) {
  let acc = 0;
  for (const t of textNodes(root)) {
    if (t === node) return acc + offsetInNode;
    acc += t.nodeValue.length;
  }
  return acc; // position was past the last text node
}

// Build a DOM Range spanning [start, end) in fullText space.
function rangeFromOffsets(root, start, end) {
  const nodes = textNodes(root);
  const range = document.createRange();
  let acc = 0;
  let setStart = false;
  for (const t of nodes) {
    const len = t.nodeValue.length;
    if (!setStart && start <= acc + len) {
      range.setStart(t, Math.max(0, start - acc));
      setStart = true;
    }
    if (setStart && end <= acc + len) {
      range.setEnd(t, Math.max(0, end - acc));
      return range;
    }
    acc += len;
  }
  if (setStart) {
    const last = nodes[nodes.length - 1];
    if (last) range.setEnd(last, last.nodeValue.length);
    return range;
  }
  return null;
}

// Read the current selection inside `container`. Returns the anchor fields +
// a container-relative bounding rect (for placing the "Comment" button), or null.
export function captureSelection(container) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const text = fullText(container);
  let start = offsetOf(container, range.startContainer, range.startOffset);
  let end = offsetOf(container, range.endContainer, range.endOffset);
  if (end < start) [start, end] = [end, start];

  // Trim whitespace at the edges of the selection.
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  const quote = text.slice(start, end);
  if (quote.trim().length < 2) return null;

  const cr = container.getBoundingClientRect();
  const br = range.getBoundingClientRect();
  return {
    quote,
    prefix: text.slice(Math.max(0, start - CTX), start),
    suffix: text.slice(end, end + CTX),
    rect: { top: br.top - cr.top, left: br.left - cr.left, width: br.width, height: br.height },
  };
}

// Find the best occurrence of anchor.quote in the container, scored by how well
// the surrounding text matches the stored prefix/suffix. Returns {start,end} or null.
export function locate(container, anchor) {
  const text = fullText(container);
  const q = anchor.quote;
  if (!q) return null;
  const hits = [];
  let i = text.indexOf(q);
  while (i !== -1) {
    hits.push(i);
    i = text.indexOf(q, i + 1);
  }
  if (hits.length === 0) return null;
  if (hits.length === 1) return { start: hits[0], end: hits[0] + q.length };

  // Disambiguate by context: count matching trailing prefix / leading suffix chars.
  const score = (at) => {
    const pre = text.slice(Math.max(0, at - CTX), at);
    const suf = text.slice(at + q.length, at + q.length + CTX);
    return common(pre, anchor.prefix || '', true) + common(suf, anchor.suffix || '', false);
  };
  let best = hits[0];
  let bestScore = -1;
  for (const at of hits) {
    const s = score(at);
    if (s > bestScore) { bestScore = s; best = at; }
  }
  return { start: best, end: best + q.length };
}

// Count matching chars between a and b, aligned at the end (fromEnd) or start.
function common(a, b, fromEnd) {
  const len = Math.min(a.length, b.length);
  let c = 0;
  for (let k = 1; k <= len; k++) {
    const ca = fromEnd ? a[a.length - k] : a[k - 1];
    const cb = fromEnd ? b[b.length - k] : b[k - 1];
    if (ca === cb) c++; else break;
  }
  return c;
}

// Container-relative rects covering the located quote (one per visual line).
export function rectsOf(container, loc) {
  const range = rangeFromOffsets(container, loc.start, loc.end);
  if (!range) return [];
  const cr = container.getBoundingClientRect();
  return Array.from(range.getClientRects()).map((r) => ({
    top: r.top - cr.top,
    left: r.left - cr.left,
    width: r.width,
    height: r.height,
  }));
}

// A page-namespaced, unique-enough anchor key: log:<base36>.
export function freshKey() {
  const rnd = Math.floor(Math.random() * 0xffffff).toString(36);
  const t = Date.now().toString(36);
  return `log:${t}${rnd}`;
}
