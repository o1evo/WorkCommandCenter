import React, { useMemo, useState } from 'react';

// The "manage tasks" modal: the home for editing per-page metadata — inline
// rename + project (real text fields, no prompts), star/hide toggles, grouped by
// project, with a show-hidden toggle. Clicking a row's "open" switches to it.
export default function TasksManager({ reviews, currentId, onSelect, onMeta, onClose }) {
  const [showHidden, setShowHidden] = useState(false);
  const hiddenCount = reviews.filter((r) => r.hidden).length;

  const groups = useMemo(() => {
    const anyProject = reviews.some((r) => r.project);
    const rows = reviews.filter((r) => showHidden || !r.hidden);
    const by = {};
    for (const r of rows) {
      const k = r.project || (anyProject ? '— no project' : 'All tasks');
      (by[k] ||= []).push(r);
    }
    const cmp = (a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || (a.name || a.title).localeCompare(b.name || b.title);
    return Object.keys(by).sort().map((k) => ({ project: k, rows: by[k].sort(cmp) }));
  }, [reviews, showHidden]);

  // Commit an inline field only when it actually changed.
  function commit(r, field, value) {
    const v = value.trim();
    if (field === 'name') {
      // The field is pre-filled with the effective name (override OR the raw title).
      // Leaving it equal to the title — or clearing it — means "no override" → store '',
      // which the server treats as clear. Only a genuinely different string is an override.
      const next = v === '' || v === r.title ? '' : v;
      if (next === (r.name || '')) return;
      onMeta(r.id, { name: next });
      return;
    }
    if (v === (r.project || '')) return;
    onMeta(r.id, { project: v });
  }

  return (
    <div className="tm-backdrop" onMouseDown={onClose}>
      <div className="tm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="tm-head">
          <h2>Manage tasks</h2>
          <span className="tm-spacer" />
          {hiddenCount > 0 && (
            <button className="tm-toggle" onClick={() => setShowHidden((s) => !s)}>
              {showHidden ? 'Hide hidden' : `Show hidden (${hiddenCount})`}
            </button>
          )}
          <button className="tm-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>
        <div className="tm-body">
          {groups.map((g) => (
            <div key={g.project} className="tm-group">
              <div className="tm-grouphead">{g.project}</div>
              {g.rows.map((r) => (
                <div key={r.id} className={`tm-row ${r.id === currentId ? 'current' : ''} ${r.hidden ? 'is-hidden' : ''}`}>
                  <button className={`tm-star ${r.starred ? 'on' : ''}`} title={r.starred ? 'Unstar' : 'Star'} aria-label="Star"
                    onClick={() => onMeta(r.id, { starred: !r.starred })}>{r.starred ? '★' : '☆'}</button>
                  <input className="tm-name" defaultValue={r.name || r.title} placeholder={r.title} title={`id: ${r.id}`}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    onBlur={(e) => commit(r, 'name', e.target.value)} />
                  <input className="tm-proj" defaultValue={r.project || ''} placeholder="project"
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    onBlur={(e) => commit(r, 'project', e.target.value)} />
                  <button className="tm-open" title="Open this task" onClick={() => { onSelect(r.id); onClose(); }}>open</button>
                  <button className="tm-hide" title={r.hidden ? 'Unhide' : 'Hide'} aria-label={r.hidden ? 'Unhide' : 'Hide'}
                    onClick={() => onMeta(r.id, { hidden: !r.hidden })}>{r.hidden ? '↺' : '⊘'}</button>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="tm-foot">Names &amp; projects save on blur or Enter. Empty clears the override.</div>
      </div>
    </div>
  );
}
