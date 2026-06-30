import React, { useEffect, useRef, useState } from 'react';

// In-page find. The app runs inside a cross-origin iframe in the VS Code webview,
// so the editor's native ⌘F can't search our content — this bar does. It drives
// the browser's built-in window.find(), which selects + scrolls to each match
// (only visible text, so it naturally searches the active tab). ↵ next, ⇧↵ prev,
// esc closes. Tagged data-wcc-ui so the comment layer ignores clicks in it.
export default function FindBar({ onClose }) {
  const [q, setQ] = useState('');
  const [miss, setMiss] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  // window.find continues from the current selection, which gives next/prev for
  // free. `fromTop` collapses the selection first so a new query starts at the top.
  function run(query, backwards, fromTop) {
    if (!query) { setMiss(false); return; }
    if (fromTop) { try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ } }
    const found = typeof window.find === 'function' && window.find(query, false, backwards, true);
    setMiss(!found);
  }

  function onChange(e) { const v = e.target.value; setQ(v); run(v, false, true); }

  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); run(q, e.shiftKey, false); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }

  return (
    <div className="findbar" data-wcc-ui>
      <input ref={inputRef} className={`findbar-input ${miss ? 'miss' : ''}`} placeholder="Find on page…"
        value={q} onChange={onChange} onKeyDown={onKey} />
      {miss && q && <span className="findbar-status">no matches</span>}
      <button className="findbar-btn" title="Previous (⇧↵)" aria-label="Previous match" onClick={() => run(q, true, false)}>↑</button>
      <button className="findbar-btn" title="Next (↵)" aria-label="Next match" onClick={() => run(q, false, false)}>↓</button>
      <button className="findbar-btn" title="Close (esc)" aria-label="Close find" onClick={onClose}>✕</button>
    </div>
  );
}
