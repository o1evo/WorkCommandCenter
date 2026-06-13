import React, { useMemo, useState } from 'react';

// A sticky index for the Code Review tab: every finding (annotation) grouped by
// severity, and every comment thread, each clickable to scroll its target into
// view. Pure derivation from hunks/threads — no writes. Renders for every review.

const SEV_ORDER = ['blocker', 'high', 'medium', 'low', 'resolved', 'note'];
const SEV_LABEL = { blocker: 'Blocker', high: 'High', medium: 'Medium', low: 'Low', resolved: 'Resolved', note: 'Note' };

export default function ReviewSidebar({ hunks, threads, onJump, onClose }) {
  const [findingFilter, setFindingFilter] = useState('open'); // open | all
  const [commentFilter, setCommentFilter] = useState('all');  // all | pending

  // Findings: flatten annotations, tag each with its hunk's file for context.
  const findings = useMemo(() => {
    const out = [];
    for (const h of hunks || []) {
      for (const a of h.annotations || []) {
        out.push({ ...a, file: h.file, domId: `f-${a.id}`, sev: (a.severity || 'note').toLowerCase() });
      }
    }
    return out;
  }, [hunks]);

  const sevCounts = useMemo(() => {
    const c = {};
    for (const f of findings) c[f.sev] = (c[f.sev] || 0) + 1;
    return c;
  }, [findings]);

  const shownFindings = findings.filter((f) => (findingFilter === 'all' ? true : f.sev !== 'resolved'));
  const bySev = SEV_ORDER.map((sev) => [sev, shownFindings.filter((f) => f.sev === sev)]).filter(([, xs]) => xs.length);

  // Comments: every thread with messages, labeled + resolved to a scroll target.
  const comments = useMemo(() => buildComments(hunks, threads), [hunks, threads]);
  const totalPending = comments.reduce((n, c) => n + c.pending, 0);
  const shownComments = comments.filter((c) => (commentFilter === 'pending' ? c.pending > 0 : true));

  return (
    <aside className="review-sidebar" data-wcc-ui>
      {onClose && (
        <button className="rs-collapse" onClick={onClose} title="hide the index">⟨ hide</button>
      )}
      <div className="rs-section">
        <div className="rs-head">
          <span>Findings</span>
          <span className="rs-sevline">
            {SEV_ORDER.filter((s) => sevCounts[s] && s !== 'note').map((s) => (
              <span key={s} className={`rs-sevcount sev-${s}`} title={SEV_LABEL[s]}>{sevCounts[s]}{s[0].toUpperCase()}</span>
            ))}
          </span>
        </div>
        <div className="rs-filter">
          {['open', 'all'].map((f) => (
            <button key={f} className={findingFilter === f ? 'active' : ''} onClick={() => setFindingFilter(f)}>{f}</button>
          ))}
        </div>
        {bySev.length === 0 && <div className="rs-empty">No findings.</div>}
        {bySev.map(([sev, xs]) => (
          <div key={sev} className="rs-group">
            <div className={`rs-grouphead sev-${sev}`}>{SEV_LABEL[sev] || sev} · {xs.length}</div>
            {xs.map((f) => (
              <button key={f.id} className={`rs-item sev-${f.sev}`} onClick={() => onJump(f.domId)} title={f.note || f.tag}>
                <span className="rs-dot" />
                <span className="rs-item-text">{f.tag || f.note || '(finding)'}</span>
                <span className="rs-item-file">{shortFile(f.file)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="rs-section">
        <div className="rs-head">
          <span>Comments</span>
          {totalPending > 0 && <span className="rs-pending">{totalPending} pending</span>}
        </div>
        <div className="rs-filter">
          {['all', 'pending'].map((f) => (
            <button key={f} className={commentFilter === f ? 'active' : ''} onClick={() => setCommentFilter(f)}>{f}</button>
          ))}
        </div>
        {shownComments.length === 0 && <div className="rs-empty">No comments.</div>}
        {shownComments.map((c) => (
          <button key={c.key} className={`rs-item rs-comment ${c.domId ? '' : 'rs-nojump'}`}
            disabled={!c.domId} onClick={() => c.domId && onJump(c.domId)} title={c.preview}>
            <span className={`rs-kind rs-kind-${c.kind}`}>{c.label}</span>
            <span className="rs-item-text">{c.preview}</span>
            <span className="rs-counts">
              {c.count}{c.pending > 0 && <span className="rs-pending-dot" title={`${c.pending} awaiting reply`}> ●</span>}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

// Map each non-empty thread to a sidebar row: a human label, a scroll target
// (domId) when it lives in the diff, message count, and pending count.
function buildComments(hunks, threads) {
  const hunkIds = new Set((hunks || []).map((h) => h.id));
  const annById = new Map();
  for (const h of hunks || []) for (const a of h.annotations || []) annById.set(a.id, { ...a, file: h.file });

  const rows = [];
  for (const [key, msgs] of Object.entries(threads || {})) {
    if (!msgs || !msgs.length) continue;
    const pending = msgs.filter((m) => m.role === 'author' && !m.answered).length;
    const preview = (msgs[msgs.length - 1].text || '').replace(/\s+/g, ' ').slice(0, 60);
    let label = key, kind = 'other', domId = null;

    if (key === 'general') { label = 'General'; kind = 'general'; }
    else if (annById.has(key)) { const a = annById.get(key); label = a.tag || 'finding'; kind = 'finding'; domId = `f-${key}`; }
    else if (hunkIds.has(key)) { label = `${shortFile(key.split('#')[0])} hunk`; kind = 'hunk'; domId = `h-${key}`; }
    else if (/#L\d+$/.test(key)) { const n = key.match(/#L(\d+)$/)[1]; label = `Line ${n}`; kind = 'line'; domId = `ln-${key}`; }
    else if (key.includes('::')) { label = key.split('::').pop(); kind = 'finding'; domId = null; } // finding thread, annotation no longer on the diff
    else if (/^log:/.test(key)) { label = 'Log page'; kind = 'log'; domId = null; } // lives on the Log tab
    rows.push({ key, label, kind, domId, count: msgs.length, pending, preview });
  }
  // pending first, then by kind grouping order
  const order = { finding: 0, line: 1, hunk: 2, general: 3, log: 4, other: 5 };
  rows.sort((a, b) => (b.pending > 0) - (a.pending > 0) || order[a.kind] - order[b.kind]);
  return rows;
}

function shortFile(path) {
  const p = String(path || '');
  return p.split('/').pop() || p;
}
