import React, { useEffect, useMemo, useRef, useState } from 'react';

// ⌘K task switcher: fuzzy-filter, keyboard-driven (↑/↓/↵/esc). Switching only —
// metadata editing lives in TasksManager. Hidden tasks are excluded (that's the
// point of hiding); reach them via "Manage tasks".
//
// Custom tags can be used to sort/narrow: click a tag chip to filter to it (the
// list then orders by manual order, then starred, then name), or type "#tag" in
// the search box for the same effect from the keyboard.
export default function CommandPalette({ reviews, tags = [], currentId, onSelect, onClose, onManage }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [tagFilter, setTagFilter] = useState(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const tagColor = useMemo(() => Object.fromEntries(tags.map((t) => [t.name, t.color])), [tags]);

  // Every distinct tag actually used by a visible task, for the filter chips.
  const allTags = useMemo(() => {
    const set = new Set();
    for (const r of reviews) if (!r.hidden) for (const t of r.tags || []) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [reviews]);

  const rows = useMemo(() => {
    // A leading "#tag" token in the query acts as a tag filter too; the rest is text.
    let s = q.trim().toLowerCase();
    let typedTag = null;
    const m = s.match(/(?:^|\s)#([^\s]+)/);
    if (m) { typedTag = m[1]; s = s.replace(m[0], '').trim(); }
    const tag = tagFilter || typedTag;
    return reviews
      .filter((r) => !r.hidden)
      .filter((r) => !tag || (r.tags || []).some((t) => t.toLowerCase() === tag.toLowerCase()))
      .filter((r) => !s || `${r.name || r.title} ${r.project || ''} ${(r.tags || []).join(' ')} ${r.id}`.toLowerCase().includes(s))
      .sort((a, b) => {
        const ao = typeof a.order === 'number', bo = typeof b.order === 'number';
        if (ao && bo) return a.order - b.order;
        if (ao !== bo) return ao ? -1 : 1;
        return (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || (a.name || a.title).localeCompare(b.name || b.title);
      });
  }, [reviews, q, tagFilter]);

  useEffect(() => { setActive(0); }, [q, tagFilter]);
  useEffect(() => {
    listRef.current?.querySelector('.cmdk-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = rows[active]; if (r) { onSelect(r.id); onClose(); } }
    else if (e.key === 'Escape') { e.preventDefault(); if (tagFilter) setTagFilter(null); else onClose(); }
  }

  return (
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={inputRef} className="cmdk-input" placeholder="Switch task… (#tag to filter)"
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
        {allTags.length > 0 && (
          <div className="cmdk-tags">
            {allTags.map((t) => (
              <button key={t} className={`cmdk-tag ${tagFilter === t ? 'on' : ''}`}
                style={tagFilter === t ? { background: tagColor[t], borderColor: tagColor[t], color: '#fff' } : { borderColor: tagColor[t], color: tagColor[t] }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setTagFilter((cur) => (cur === t ? null : t))}>#{t}</button>
            ))}
          </div>
        )}
        <div className="cmdk-list" ref={listRef}>
          {rows.length === 0 && <div className="cmdk-empty">No matching tasks.</div>}
          {rows.map((r, i) => (
            <button key={r.id} className={`cmdk-row ${i === active ? 'active' : ''} ${r.id === currentId ? 'current' : ''}`}
              onMouseEnter={() => setActive(i)} onClick={() => { onSelect(r.id); onClose(); }}>
              <span className="cmdk-star">{r.starred ? '★' : ''}</span>
              <span className="cmdk-name">{r.name || r.title}</span>
              {(r.tags || []).map((t) => (
                <span key={t} className="cmdk-tag-chip" style={{ background: tagColor[t] || '#768390', color: '#fff', borderColor: 'transparent' }}>{t}</span>
              ))}
              {r.project && <span className="cmdk-proj">{r.project}</span>}
              {r.id === currentId && <span className="cmdk-cur">current</span>}
            </button>
          ))}
        </div>
        <div className="cmdk-foot">
          <span className="cmdk-hint">↑↓ navigate · ↵ open · esc close</span>
          <button className="cmdk-manage" onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onClose(); onManage(); }}>⚙ Manage tasks</button>
        </div>
      </div>
    </div>
  );
}
