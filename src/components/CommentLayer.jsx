import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Thread from './Thread.jsx';
import { captureSelection, locate, rectsOf, freshKey } from '../anchors.js';

// Free-selection commenting over a Log page. Renders three things, all tagged
// data-wcc-ui so they're excluded from the anchor text math:
//   1. highlight overlays for every non-hidden anchor that can be located,
//   2. a floating "Comment" button when there's a text selection,
//   3. a popover (the chat thread) for the focused anchor.
// All app chrome — independent of what the page author wrote.
export default function CommentLayer({ pageRef, anchors, threads, version, onCreate, onSetState, onSend, onDelete }) {
  const [positions, setPositions] = useState({}); // key -> rects[]
  const [orphans, setOrphans] = useState([]); // keys whose quote no longer resolves
  const [pending, setPending] = useState(null); // { quote, prefix, suffix, rect }
  const [openKey, setOpenKey] = useState(null);
  const [showOrphans, setShowOrphans] = useState(false);
  const popRef = useRef(null);

  // Recompute highlight rects after every render/poll and on resize.
  useLayoutEffect(() => {
    function recompute() {
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
      setPositions(pos);
      setOrphans(orph);
    }
    recompute();
    const ro = new ResizeObserver(recompute);
    if (pageRef.current) ro.observe(pageRef.current);
    window.addEventListener('resize', recompute);
    return () => { ro.disconnect(); window.removeEventListener('resize', recompute); };
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

  // Close the popover on outside click / Escape.
  useEffect(() => {
    if (!openKey) return;
    function onDown(e) {
      if (e.target.closest && e.target.closest('[data-wcc-ui]')) return;
      setOpenKey(null);
    }
    function onKey(e) { if (e.key === 'Escape') setOpenKey(null); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [openKey]);

  async function createFromPending() {
    if (!pending) return;
    const key = freshKey();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    setPending(null);
    await onCreate({ key, quote: pending.quote, prefix: pending.prefix, suffix: pending.suffix });
    setOpenKey(key); // open the composer; highlight appears on the next recompute
  }

  const openAnchor = openKey ? (anchors || {})[openKey] : null;
  const openRects = openKey ? positions[openKey] : null;
  const anchorPoint = openRects && openRects[0];

  return (
    <div className="wcc-comments" data-wcc-ui>
      {/* highlight overlays */}
      {Object.entries(positions).map(([key, rects]) => {
        const a = anchors[key];
        const cls = `wcc-hl ${a.state === 'resolved' ? 'resolved' : ''} ${openKey === key ? 'active' : ''}`;
        return rects.map((r, i) => (
          <div
            key={`${key}-${i}`}
            className={cls}
            style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
            onClick={() => setOpenKey(key)}
            title={a.state === 'resolved' ? 'resolved comment' : 'comment'}
          />
        ));
      })}

      {/* floating Comment button on a fresh selection */}
      {pending && !openKey && (
        <button
          className="wcc-comment-btn"
          style={{ top: Math.max(0, pending.rect.top - 34), left: pending.rect.left }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={createFromPending}
        >
          💬 Comment
        </button>
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
                <button onClick={() => onSetState(openKey, 'open')}>Reopen</button>
              ) : (
                <button onClick={() => onSetState(openKey, 'resolved')}>Resolve</button>
              )}
              <button onClick={() => { onSetState(openKey, 'hidden'); setOpenKey(null); }}>Hide</button>
              <button onClick={() => setOpenKey(null)} aria-label="close">✕</button>
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
              {orphans.map((key) => (
                <div key={key} className="wcc-orphan">
                  <span className="wcc-quote">“{truncate(anchors[key].quote, 60)}”</span>
                  <button onClick={() => onSetState(key, 'hidden')}>Dismiss</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function clampLeft(left, pageRef) {
  const w = pageRef.current ? pageRef.current.clientWidth : 800;
  return Math.min(Math.max(0, left), Math.max(0, w - 360));
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
