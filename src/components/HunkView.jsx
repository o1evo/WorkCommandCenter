import React, { useState } from 'react';
import { diffLines } from '../diffLines.js';
import Thread from './Thread.jsx';

// One diff hunk: its added/removed lines, annotation badges, and a collapsible
// chat thread scoped to this hunk.
export default function HunkView({ hunk, messages, onSend }) {
  const [open, setOpen] = useState(
    () => messages.some((m) => m.role === 'author' && !m.answered) || hunk.annotations.length > 0
  );
  const lines = diffLines(hunk.diff);
  const pending = messages.filter((m) => m.role === 'author' && !m.answered).length;

  return (
    <div className="hunk">
      <div className="hunk-range">{hunk.range}</div>

      <table className="diff">
        <tbody>
          {lines.map((ln, i) =>
            ln.kind === 'meta' ? null : (
              <tr key={i} className={`row row-${ln.kind}`}>
                <td className="ln">{ln.oldNo ?? ''}</td>
                <td className="ln">{ln.newNo ?? ''}</td>
                <td className="gutter">{ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ' '}</td>
                <td className="code">{ln.text || ' '}</td>
              </tr>
            )
          )}
        </tbody>
      </table>

      {hunk.annotations.length > 0 && (
        <div className="annotations">
          {hunk.annotations.map((a, i) => (
            <div key={i} className={`annotation sev-${(a.severity || 'note').toLowerCase()}`}>
              <span className={`sev-badge sev-${(a.severity || 'note').toLowerCase()}`}>
                {a.severity || 'note'}
              </span>
              {a.tag && <span className="tag">{a.tag}</span>}
              <span className="annotation-note">{a.note}</span>
            </div>
          ))}
        </div>
      )}

      <button className="thread-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Discussion ({messages.length})
        {pending > 0 && <span className="badge-pending">{pending} pending</span>}
      </button>

      {open && <Thread messages={messages} onSend={onSend} compact />}
    </div>
  );
}
