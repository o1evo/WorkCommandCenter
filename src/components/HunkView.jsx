import React, { useRef, useState } from 'react';
import { diffLines } from '../diffLines.js';
import { langForFile, highlight } from '../highlight.js';
import Thread from './Thread.jsx';

// One diff hunk: its added/removed lines (each line can host its own inline
// thread), then each finding (annotation) with its own discussion thread, plus a
// hunk-level thread. Clicking a finding toggles a STICKY highlight on the lines
// it concerns (and scrolls them into view); clicking it again clears it. Thread
// keys: `<hunkId>#L<n>` per line, annotation.id per finding, hunk.id hunk-level.
export default function HunkView({ hunk, threads, onSend, onDelete, onDeleteThread }) {
  const lines = diffLines(hunk.diff);
  const lang = langForFile(hunk.file);
  const [openLines, setOpenLines] = useState(() => new Set());   // empty threads opened by a click
  const [collapsedLines, setCollapsedLines] = useState(() => new Set()); // message threads explicitly collapsed
  const [activeFinding, setActiveFinding] = useState(null); // annotation id whose lines are lit
  const rowRefs = useRef({}); // lineKey -> <tr>

  const keyOf = (ln) => `${hunk.id}#L${ln.newNo ?? ln.oldNo}`;

  // Lines a finding concerns: annotation.lines (new-side numbers) if present,
  // else the hunk's changed (+/-) lines.
  const targetKeys = (ann) =>
    Array.isArray(ann.lines) && ann.lines.length
      ? ann.lines.map((n) => `${hunk.id}#L${n}`)
      : lines.filter((l) => l.kind === 'add' || l.kind === 'del').map(keyOf);

  const activeAnn = hunk.annotations.find((a) => a.id === activeFinding);
  const litSet = new Set(activeAnn ? targetKeys(activeAnn) : []);

  // A thread with messages defaults open; the × collapses it (via collapsedLines).
  // An empty thread defaults closed; a gutter click opens it (via openLines).
  const flip = (set, key) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  };
  const toggleLine = (key, hasMsgs) =>
    hasMsgs
      ? setCollapsedLines((prev) => flip(prev, key))
      : setOpenLines((prev) => flip(prev, key));

  function toggleFinding(ann) {
    if (activeFinding === ann.id) { setActiveFinding(null); return; } // manual removal
    setActiveFinding(ann.id);
    const firstEl = targetKeys(ann).map((k) => rowRefs.current[k]).find(Boolean);
    if (firstEl) firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return (
    <div className="hunk">
      <div className="hunk-range">{hunk.range}</div>

      <table className="diff">
        <tbody>
          {lines.map((ln, i) => {
            if (ln.kind === 'meta') return null;
            const key = keyOf(ln);
            const msgs = threads[key] || [];
            const hasMsgs = msgs.length > 0;
            const open = hasMsgs ? !collapsedLines.has(key) : openLines.has(key);
            return (
              <React.Fragment key={i}>
                <tr ref={(el) => { rowRefs.current[key] = el; }}
                    className={`row row-${ln.kind} ${litSet.has(key) ? 'wcc-hl-line' : ''}`}>
                  <td className="ln ln-comment" title="comment on this line" onClick={() => toggleLine(key, hasMsgs)}>{ln.oldNo ?? ''}</td>
                  <td className="ln ln-comment" title="comment on this line" onClick={() => toggleLine(key, hasMsgs)}>{ln.newNo ?? ''}</td>
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
                          {msgs.length > 0 && onDeleteThread && (
                            <button className="line-thread-delete" title="delete this whole line thread"
                              onClick={() => { if (window.confirm(`Delete all ${msgs.length} comment(s) on line ${ln.newNo ?? ln.oldNo}?`)) onDeleteThread(key); }}>
                              🗑 delete thread
                            </button>
                          )}
                          <button className="line-thread-close" title={hasMsgs ? 'collapse (keeps the comments)' : 'hide'} onClick={() => toggleLine(key, hasMsgs)}>×</button>
                        </div>
                        <Thread messages={msgs} onSend={(t) => onSend(key, t)}
                          onDelete={onDelete && ((mid) => onDelete(key, mid))} compact />
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
        <Annotation key={a.id} ann={a} active={activeFinding === a.id}
          messages={threads[a.id] || []} onSend={(t) => onSend(a.id, t)}
          onDelete={onDelete && ((mid) => onDelete(a.id, mid))} onToggle={() => toggleFinding(a)} />
      ))}

      <Discussion label="Hunk discussion" messages={threads[hunk.id] || []} onSend={(t) => onSend(hunk.id, t)}
        onDelete={onDelete && ((mid) => onDelete(hunk.id, mid))} />
    </div>
  );
}

// A finding plus the thread that follows it. Click the head to light up / clear
// the lines it concerns.
function Annotation({ ann, active, messages, onSend, onDelete, onToggle }) {
  const sev = (ann.severity || 'note').toLowerCase();
  return (
    <div className={`annotation sev-${sev} ${active ? 'annotation-active' : ''}`}>
      <div className="annotation-head annotation-jump" onClick={onToggle}
           title={active ? 'clear the highlight' : 'highlight the lines this finding concerns'}>
        <span className={`sev-badge sev-${sev}`}>{ann.severity || 'note'}</span>
        {ann.tag && <span className="tag">{ann.tag}</span>}
        <span className="annotation-jump-hint">{active ? '✕ clear highlight' : '↦ highlight lines'}</span>
      </div>
      <div className="annotation-note">{ann.note}</div>
      <Discussion label="Discuss" messages={messages} onSend={onSend} onDelete={onDelete} startOpenIfPending />
    </div>
  );
}

// Collapsible thread (per-finding or hunk-level). Opens by default when it has a
// pending question.
function Discussion({ label, messages, onSend, onDelete, startOpenIfPending }) {
  const pending = messages.filter((m) => m.role === 'author' && !m.answered).length;
  const [open, setOpen] = useState(() => (startOpenIfPending ? pending > 0 : false));
  return (
    <div className="discussion">
      <button className="thread-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {label} ({messages.length})
        {pending > 0 && <span className="badge-pending">{pending} pending</span>}
      </button>
      {open && <Thread messages={messages} onSend={onSend} onDelete={onDelete} compact />}
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
