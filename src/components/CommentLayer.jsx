import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Thread from './Thread.jsx';
import { captureSelection, locate, rectsOf, freshKey } from '../anchors.js';

// Free-selection commenting over a Log page. Renders three things, all tagged
// data-wcc-ui so they're excluded from the anchor text math:
//   1. highlight overlays for every non-hidden anchor that can be located,
//   2. a floating "Comment" button when there's a text selection,
//   3. a popover (the chat thread) for the focused anchor.
// All app chrome — independent of what the page author wrote.
export default function CommentLayer({ pageRef, anchors, threads, version, onCreate, onSetState, onDeleteAnchor, onSend, onDelete }) {
  const [positions, setPositions] = useState({}); // key -> rects[]
  const [orphans, setOrphans] = useState([]); // keys whose quote no longer resolves
  const [pending, setPending] = useState(null); // { quote, prefix, suffix, rect }
  const [draft, setDraft] = useState(null); // an in-memory anchor not yet persisted (no thread until first send)
  const [openKey, setOpenKey] = useState(null);
  const [showOrphans, setShowOrphans] = useState(false);
  const popRef = useRef(null);

  // Recompute highlight rects on real changes (anchors/version) and on layout
  // shifts (fonts/resize/reflow). All triggers COALESCE into a single rAF, and we
  // bail out of setState when nothing moved — so a flurry of triggers (ResizeObserver
  // + resize + settle) is one measurement pass and zero re-renders if rects are stable.
  // (Chinook avoids this entirely by drawing markers inside an iframe; that's the real
  // long-term fix — this just removes the per-trigger thrash without the rearchitecture.)
  useLayoutEffect(() => {
    let raf = 0;
    function compute() {
      raf = 0;
      const root = pageRef.current;
      if (!root) return;
      const pos = {};
      const orph = [];
      for (const [key, a] of Object.entries(anchors || {})) {
        if (a.state === 'hidden') continue;
        const loc = locate(root, a);
        if (!loc) { orph.push(key); continue; }
        const rects = rectsOf(root, loc);
        if (rects.length) pos[key] = rects; else orph.push(key);
      }
      setPositions((prev) => (samePositions(prev, pos) ? prev : pos));
      setOrphans((prev) => (sameKeys(prev, orph) ? prev : orph));
    }
    function schedule() { if (!raf) raf = requestAnimationFrame(compute); }
    // First pass via rAF (after layout); re-schedule after fonts settle and on reflow.
    schedule();
    const settle = setTimeout(schedule, 300);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule).catch(() => {});
    const ro = new ResizeObserver(schedule);
    if (pageRef.current) ro.observe(pageRef.current);
    window.addEventListener('resize', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(settle);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [pageRef, anchors, version]);

  // Detect a text selection inside the page (ignore clicks within our own UI).
  useEffect(() => {
    function onMouseUp(e) {
      if (e.target.closest && e.target.closest('[data-wcc-ui]')) return;
      const root = pageRef.current;
      if (!root) return;
      const sel = captureSelection(root);
      setPending(sel); // null clears the button
    }
    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
  }, [pageRef]);

  // Open a thread by clicking its highlight. The highlight overlay is now
  // pointer-events:none (so it never blocks selecting/copying the text under it),
  // so we hit-test a plain click against the measured rects instead. A drag that
  // leaves a selection is NOT a click-to-open — that's the user copying text.
  useEffect(() => {
    function onClick(e) {
      if (e.target.closest && e.target.closest('[data-wcc-ui]')) return; // our own UI
      const root = pageRef.current;
      if (!root) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return; // a real selection — leave it for copy
      const cr = root.getBoundingClientRect();
      const x = e.clientX - cr.left, y = e.clientY - cr.top;
      for (const [key, rects] of Object.entries(positions)) {
        for (const r of rects) {
          if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) {
            setOpenKey(key);
            return;
          }
        }
      }
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [positions, pageRef]);

  // Close the popover (or discard an untyped draft) on outside click / Escape.
  useEffect(() => {
    if (!openKey && !draft) return;
    function close() { setOpenKey(null); setDraft(null); }
    function onDown(e) {
      if (e.target.closest && e.target.closest('[data-wcc-ui]')) return;
      close();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [openKey, draft]);

  // "Comment" opens an in-memory DRAFT composer — it does NOT persist an anchor yet,
  // so cancelling without typing leaves nothing behind (no empty thread / stray highlight).
  function startDraft() {
    if (!pending) return;
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    setDraft({ key: freshKey(), quote: pending.quote, prefix: pending.prefix, suffix: pending.suffix, start: pending.start, end: pending.end, rect: pending.rect });
    setPending(null);
  }

  // First send is what actually creates the comment: persist the anchor, post the
  // message, then promote the draft to a normal open anchor.
  async function sendDraft(text) {
    const d = draft;
    if (!d) return;
    await onCreate({ key: d.key, quote: d.quote, prefix: d.prefix, suffix: d.suffix, start: d.start, end: d.end });
    await onSend(d.key, text);
    setDraft(null);
    setOpenKey(d.key); // highlight appears on the next recompute
  }

  const openAnchor = openKey ? (anchors || {})[openKey] : null;
  const openRects = openKey ? positions[openKey] : null;
  const anchorPoint = openRects && openRects[0];

  return (
    <div className="wcc-comments" data-wcc-ui>
      {/* highlight overlays */}
      {Object.entries(positions).map(([key, rects]) => {
        const a = anchors[key];
        if (!a) return null; // anchor just deleted; positions/orphans lag anchors by a render
        const cls = `wcc-hl ${a.state === 'resolved' ? 'resolved' : ''} ${openKey === key ? 'active' : ''}`;
        return rects.map((r, i) => (
          <div
            key={`${key}-${i}`}
            className={cls}
            style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
          />
        ));
      })}

      {/* floating Comment button on a fresh selection */}
      {pending && !openKey && !draft && (
        <button
          className="wcc-comment-btn"
          style={{ top: Math.max(0, pending.rect.top - 34), left: pending.rect.left }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={startDraft}
        >
          💬 Comment
        </button>
      )}

      {/* draft: a not-yet-persisted comment — highlight + composer; nothing is saved
          until the first message is sent (cancel/✕ leaves no anchor or empty thread) */}
      {draft && draft.rect && (
        <div className="wcc-hl active" style={{ top: draft.rect.top, left: draft.rect.left, width: draft.rect.width, height: draft.rect.height }} />
      )}
      {draft && (
        <div
          ref={popRef}
          className="wcc-popover"
          style={{ top: draft.rect.top + draft.rect.height + 6, left: clampLeft(draft.rect.left, pageRef) }}
        >
          <div className="wcc-popover-head">
            <span className="wcc-quote">“{truncate(draft.quote, 80)}”</span>
            <div className="wcc-popover-actions">
              <button className="wcc-act" title="Cancel" aria-label="Cancel" onClick={() => setDraft(null)}>✕</button>
            </div>
          </div>
          <Thread messages={[]} onSend={sendDraft} compact />
        </div>
      )}

      {/* the thread popover */}
      {openAnchor && anchorPoint && (
        <div
          ref={popRef}
          className="wcc-popover"
          style={{ top: anchorPoint.top + anchorPoint.height + 6, left: clampLeft(anchorPoint.left, pageRef) }}
        >
          <div className="wcc-popover-head">
            <span className="wcc-quote">“{truncate(openAnchor.quote, 80)}”</span>
            <div className="wcc-popover-actions">
              {openAnchor.state === 'resolved' ? (
                <button className="wcc-act" title="Reopen" aria-label="Reopen" onClick={() => onSetState(openKey, 'open')}>↺</button>
              ) : (
                <button className="wcc-act" title="Resolve" aria-label="Resolve" onClick={() => onSetState(openKey, 'resolved')}>✓</button>
              )}
              <button className="wcc-act" title="Hide (stays in the threads view)" aria-label="Hide" onClick={() => { onSetState(openKey, 'hidden'); setOpenKey(null); }}>⊘</button>
              {onDeleteAnchor && (
                <button className="wcc-act wcc-act-danger" title="Delete comment + thread" aria-label="Delete" onClick={() => { if (window.confirm('Delete this comment and its thread? This cannot be undone.')) { onDeleteAnchor(openKey); setOpenKey(null); } }}>🗑</button>
              )}
              <button className="wcc-act" title="Close" aria-label="Close" onClick={() => setOpenKey(null)}>✕</button>
            </div>
          </div>
          <Thread
            messages={threads[openKey] || []}
            onSend={(t) => onSend(openKey, t)}
            onDelete={onDelete && ((mid) => onDelete(openKey, mid))}
            compact
          />
        </div>
      )}

      {/* outdated (orphaned) comments — quote no longer found after an edit */}
      {orphans.length > 0 && (
        <div className="wcc-orphans" data-wcc-ui>
          <button className="wcc-orphans-chip" onClick={() => setShowOrphans((s) => !s)}>
            {orphans.length} outdated
          </button>
          {showOrphans && (
            <div className="wcc-orphans-list">
              {orphans.map((key) => {
                const a = anchors[key];
                if (!a) return null; // deleted anchor still in the lagging orphans list
                return (
                  <div key={key} className="wcc-orphan">
                    <span className="wcc-quote">“{truncate(a.quote, 60)}”</span>
                    <button onClick={() => onSetState(key, 'hidden')}>Dismiss</button>
                    {onDeleteAnchor && <button onClick={() => onDeleteAnchor(key)}>Delete</button>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Cheap equality so a recompute that finds the same rects doesn't trigger a re-render.
function samePositions(a, b) {
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const ra = a[k], rb = b[k];
    if (!rb || ra.length !== rb.length) return false;
    for (let i = 0; i < ra.length; i++) {
      const p = ra[i], q = rb[i];
      if (p.top !== q.top || p.left !== q.left || p.width !== q.width || p.height !== q.height) return false;
    }
  }
  return true;
}
function sameKeys(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }

function clampLeft(left, pageRef) {
  const w = pageRef.current ? pageRef.current.clientWidth : 800;
  return Math.min(Math.max(0, left), Math.max(0, w - 360));
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
