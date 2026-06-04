import React, { useState } from 'react';
import { diffLines } from '../diffLines.js';
import { langForFile, highlight } from '../highlight.js';
import Thread from './Thread.jsx';

// One diff hunk: its added/removed lines (each line can host its own inline
// thread), then each finding (annotation) with its own discussion thread, plus a
// hunk-level thread. Thread keys: `<hunkId>#L<n>` per line, annotation.id per
// finding, hunk.id for the hunk-level one, "general" for the review.
export default function HunkView({ hunk, threads, onSend }) {
  const lines = diffLines(hunk.diff);
  const lang = langForFile(hunk.file);
  const [openLines, setOpenLines] = useState(() => new Set());

  const toggleLine = (key) =>
    setOpenLines((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <div className="hunk">
      <div className="hunk-range">{hunk.range}</div>

      <table className="diff">
        <tbody>
          {lines.map((ln, i) => {
            if (ln.kind === 'meta') return null;
            const key = `${hunk.id}#L${ln.newNo ?? ln.oldNo}`;
            const msgs = threads[key] || [];
            const open = openLines.has(key) || msgs.length > 0;
            return (
              <React.Fragment key={i}>
                <tr className={`row row-${ln.kind}`}>
                  <td className="ln ln-comment" title="comment on this line" onClick={() => toggleLine(key)}>{ln.oldNo ?? ''}</td>
                  <td className="ln ln-comment" title="comment on this line" onClick={() => toggleLine(key)}>{ln.newNo ?? ''}</td>
                  <td className="gutter">{ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ' '}</td>
                  <td className="code">
                    {renderCode(ln.text, lang)}
                    {msgs.length > 0 && (
                      <span className="line-has-comments" title={`${msgs.length} comment(s)`}> 💬</span>
                    )}
                  </td>
                </tr>
                {open && (
                  <tr className="line-thread-row">
                    <td colSpan={4}>
                      <div className="line-thread">
                        <div className="line-thread-head">
                          💬 Line {ln.newNo ?? ln.oldNo}
                          <button className="line-thread-close" title="hide" onClick={() => toggleLine(key)}>×</button>
                        </div>
                        <Thread messages={msgs} onSend={(t) => onSend(key, t)} compact />
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      {hunk.annotations.map((a) => (
        <Annotation key={a.id} ann={a} messages={threads[a.id] || []} onSend={(t) => onSend(a.id, t)} />
      ))}

      <Discussion label="Hunk discussion" messages={threads[hunk.id] || []} onSend={(t) => onSend(hunk.id, t)} />
    </div>
  );
}

// A finding plus the thread that follows it.
function Annotation({ ann, messages, onSend }) {
  const sev = (ann.severity || 'note').toLowerCase();
  return (
    <div className={`annotation sev-${sev}`}>
      <div className="annotation-head">
        <span className={`sev-badge sev-${sev}`}>{ann.severity || 'note'}</span>
        {ann.tag && <span className="tag">{ann.tag}</span>}
      </div>
      <div className="annotation-note">{ann.note}</div>
      <Discussion label="Discuss" messages={messages} onSend={onSend} startOpenIfPending />
    </div>
  );
}

// Collapsible thread (per-finding or hunk-level). Opens by default when it has a
// pending question.
function Discussion({ label, messages, onSend, startOpenIfPending }) {
  const pending = messages.filter((m) => m.role === 'author' && !m.answered).length;
  const [open, setOpen] = useState(() => (startOpenIfPending ? pending > 0 : false));
  return (
    <div className="discussion">
      <button className="thread-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {label} ({messages.length})
        {pending > 0 && <span className="badge-pending">{pending} pending</span>}
      </button>
      {open && <Thread messages={messages} onSend={onSend} compact />}
    </div>
  );
}

// Render one line of code: syntax-highlighted HTML when a grammar matched,
// otherwise a plain (React-escaped) text node. Empty lines keep their height
// with a non-breaking space.
function renderCode(text, lang) {
  if (!text) return ' ';
  const html = highlight(text, lang);
  if (html == null) return text;
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
