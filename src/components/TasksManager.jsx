import React, { useMemo, useState } from 'react';

// Swatch palette offered when creating/recoloring a tag.
const TAG_COLORS = ['#e5534b', '#d9822b', '#d9a521', '#3fb950', '#2da7b0', '#388bfd', '#8957e5', '#db61a2', '#768390'];

// The "manage tasks" modal: the home for editing per-page metadata — inline
// rename + project (real text fields, no prompts), star/hide toggles, grouped by
// project, with a show-hidden toggle. Clicking a row's "open" switches to it.
//
// An "Edit" toggle reveals the heavier controls: a workspace-wide tag catalog bar
// (create/rename/recolor/delete colored tags), per-page tag assignment from that
// catalog, and drag-to-reorder within a project group. Manual order, once set,
// overrides the default starred-then-alpha sort for that group.
export default function TasksManager({ reviews, tags = [], currentId, onSelect, onMeta, onReorder, onUpsertTag, onRemoveTag, onClose }) {
  const [showHidden, setShowHidden] = useState(false);
  const [editMode, setEditMode] = useState(false);
  // While a drag is in flight, holds the previewed id order for the group being
  // reordered: { project: [id, …] }. Null when not dragging.
  const [dragId, setDragId] = useState(null);
  const [liveOrder, setLiveOrder] = useState(null);
  // The catalog tag being created/edited: { original, name, color }. original=null → create.
  const [tagEditor, setTagEditor] = useState(null);
  // The page id whose "add tag" menu is open (only one at a time).
  const [pickerFor, setPickerFor] = useState(null);
  const hiddenCount = reviews.filter((r) => r.hidden).length;
  const tagColor = useMemo(() => Object.fromEntries(tags.map((t) => [t.name, t.color])), [tags]);

  const groups = useMemo(() => {
    const anyProject = reviews.some((r) => r.project);
    const rows = reviews.filter((r) => showHidden || !r.hidden);
    const by = {};
    for (const r of rows) {
      const k = r.project || (anyProject ? '— no project' : 'All tasks');
      (by[k] ||= []).push(r);
    }
    // Manual order wins when present (rows with an order sort by it, ascending,
    // ahead of unordered rows); otherwise fall back to starred-then-alpha.
    const cmp = (a, b) => {
      const ao = typeof a.order === 'number', bo = typeof b.order === 'number';
      if (ao && bo) return a.order - b.order;
      if (ao !== bo) return ao ? -1 : 1;
      return (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || (a.name || a.title).localeCompare(b.name || b.title);
    };
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

  function addTagToPage(r, name) {
    const cur = r.tags || [];
    if (!cur.includes(name)) onMeta(r.id, { tags: [...cur, name] });
    setPickerFor(null);
  }
  function removeTagFromPage(r, name) {
    onMeta(r.id, { tags: (r.tags || []).filter((t) => t !== name) });
  }

  function saveTagEditor() {
    const name = tagEditor.name.trim();
    if (!name) { setTagEditor(null); return; }
    onUpsertTag?.({ original: tagEditor.original, name, color: tagEditor.color });
    setTagEditor(null);
  }
  function deleteCatalogTag(name) {
    if (window.confirm(`Delete tag “${name}”? It will be removed from every page.`)) onRemoveTag?.(name);
  }

  // The live (possibly previewed) row order for a group during a drag.
  function rowsFor(g) {
    const ids = liveOrder?.[g.project];
    if (!ids) return g.rows;
    const byId = Object.fromEntries(g.rows.map((r) => [r.id, r]));
    return ids.map((id) => byId[id]).filter(Boolean);
  }

  function onDragOver(e, g, overRow) {
    if (!dragId || dragId === overRow.id) return;
    const cur = liveOrder?.[g.project] || g.rows.map((r) => r.id);
    if (!cur.includes(dragId)) return; // dragged from another group — reorder is within-group only
    e.preventDefault();
    const next = cur.filter((id) => id !== dragId);
    next.splice(next.indexOf(overRow.id), 0, dragId);
    setLiveOrder({ ...(liveOrder || {}), [g.project]: next });
  }

  function endDrag(g) {
    const ids = liveOrder?.[g.project];
    setDragId(null);
    setLiveOrder(null);
    if (ids) onReorder?.(ids.map((id, i) => ({ id, order: i })));
  }

  return (
    <div className="tm-backdrop" onMouseDown={onClose}>
      <div className="tm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="tm-head">
          <h2>Manage tasks</h2>
          <span className="tm-spacer" />
          <button className={`tm-toggle ${editMode ? 'on' : ''}`} onClick={() => setEditMode((s) => !s)}
            title="Edit tags and ordering">{editMode ? '✓ Editing' : '✎ Edit'}</button>
          {hiddenCount > 0 && (
            <button className="tm-toggle" onClick={() => setShowHidden((s) => !s)}>
              {showHidden ? 'Hide hidden' : `Show hidden (${hiddenCount})`}
            </button>
          )}
          <button className="tm-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>

        {editMode && (
          <div className="tm-tagbar">
            {tags.map((t) => (
              <span key={t.name} className="tm-catchip" style={{ background: t.color }}
                title="Click to rename or recolor" onClick={() => setTagEditor({ original: t.name, name: t.name, color: t.color })}>
                {t.name}
                <button className="tm-catchip-x" title="Delete tag" aria-label={`Delete tag ${t.name}`}
                  onClick={(e) => { e.stopPropagation(); deleteCatalogTag(t.name); }}>✕</button>
              </span>
            ))}
            <button className="tm-tagnew" title="New tag"
              onClick={() => setTagEditor({ original: null, name: '', color: TAG_COLORS[0] })}>+</button>
          </div>
        )}
        {editMode && tagEditor && (
          <div className="tm-tagedit">
            <input className="tm-tagedit-name" autoFocus value={tagEditor.name}
              placeholder="tag name"
              onChange={(e) => setTagEditor({ ...tagEditor, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') saveTagEditor(); if (e.key === 'Escape') setTagEditor(null); }} />
            <div className="tm-swatches">
              {TAG_COLORS.map((c) => (
                <button key={c} className={`tm-swatch ${tagEditor.color === c ? 'on' : ''}`} style={{ background: c }}
                  aria-label={`Color ${c}`} onClick={() => setTagEditor({ ...tagEditor, color: c })} />
              ))}
            </div>
            <button className="tm-tagedit-save" onClick={saveTagEditor}>{tagEditor.original ? 'Save' : 'Add'}</button>
            <button className="tm-tagedit-cancel" onClick={() => setTagEditor(null)}>Cancel</button>
          </div>
        )}

        <div className="tm-body">
          {groups.map((g) => (
            <div key={g.project} className="tm-group">
              <div className="tm-grouphead">{g.project}</div>
              {rowsFor(g).map((r) => (
                <div key={r.id} className={`tm-item ${dragId === r.id ? 'dragging' : ''}`}
                  onDragOver={editMode ? (e) => onDragOver(e, g, r) : undefined}
                  onDrop={editMode ? () => endDrag(g) : undefined}>
                  <div className={`tm-row ${r.id === currentId ? 'current' : ''} ${r.hidden ? 'is-hidden' : ''}`}>
                    {editMode && (
                      <span className="tm-drag" title="Drag to reorder" aria-label="Drag to reorder" draggable
                        onDragStart={() => setDragId(r.id)} onDragEnd={() => endDrag(g)}>⠿</span>
                    )}
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
                  {editMode && (
                    <div className="tm-tags">
                      {(r.tags || []).map((name) => (
                        <span key={name} className="tm-tag" style={{ background: tagColor[name] || '#768390' }}>{name}
                          <button className="tm-tag-x" title="Remove from this task" aria-label={`Remove tag ${name}`}
                            onClick={() => removeTagFromPage(r, name)}>✕</button>
                        </span>
                      ))}
                      <span className="tm-tagpick">
                        <button className="tm-tagpick-btn" onClick={() => setPickerFor((id) => (id === r.id ? null : r.id))}>+ tag</button>
                        {pickerFor === r.id && (
                          <span className="tm-tagmenu">
                            {tags.filter((t) => !(r.tags || []).includes(t.name)).map((t) => (
                              <button key={t.name} className="tm-tagmenu-item" onClick={() => addTagToPage(r, t.name)}>
                                <span className="tm-tagdot" style={{ background: t.color }} />{t.name}
                              </button>
                            ))}
                            {tags.filter((t) => !(r.tags || []).includes(t.name)).length === 0 && (
                              <span className="tm-tagmenu-empty">{tags.length ? 'All tags added' : 'No tags yet — create some above'}</span>
                            )}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="tm-foot">
          {editMode
            ? 'Manage tags up top (click to rename/recolor) · drag ⠿ to reorder · “+ tag” assigns one to a task.'
            : 'Names & projects save on blur or Enter. Empty clears the override.'}
        </div>
      </div>
    </div>
  );
}
