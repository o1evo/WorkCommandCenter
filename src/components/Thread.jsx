import React, { useState } from 'react';
import MessageText from './MessageText.jsx';

// A chat thread (per-hunk or general). Renders messages and an input that posts
// a role:"author" message. Reviewer replies arrive via polling. When `onDelete`
// is supplied, each message gets a × to remove it (onDelete(messageId)).
export default function Thread({ messages, onSend, onDelete, compact }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const pending = messages.filter((m) => m.role === 'author' && !m.answered).length;

  async function remove(m) {
    if (!onDelete) return;
    if (!window.confirm('Delete this comment? This cannot be undone.')) return;
    try {
      await onDelete(m.id);
    } catch (err) {
      alert(err.message);
    }
  }

  async function send(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await onSend(t);
      setText('');
    } catch (err) {
      alert(err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={`thread ${compact ? 'thread-compact' : ''}`}>
      {messages.length === 0 && <div className="thread-empty">No messages yet.</div>}
      {messages.map((m) => (
        <div key={m.id} className={`msg msg-${m.role}`}>
          <div className="msg-head">
            <span className="msg-role">{m.role}</span>
            {m.role === 'author' && (
              <span className={`msg-status ${m.answered ? 'answered' : 'pending'}`}>
                {m.answered ? 'answered' : 'awaiting reviewer'}
              </span>
            )}
            <span className="msg-ts">{fmt(m.ts)}</span>
            {onDelete && (
              <button
                type="button"
                className="msg-delete"
                title="delete this comment"
                onClick={() => remove(m)}
              >
                ×
              </button>
            )}
          </div>
          <MessageText text={m.text} />
        </div>
      ))}
      <form className="thread-form" onSubmit={send}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(e);
          }}
          placeholder="Ask the reviewer a question…  (⌘/Ctrl+Enter to send)"
          rows={compact ? 2 : 3}
        />
        <button type="submit" disabled={sending || !text.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
      {pending > 0 && (
        <div className="thread-pending-note">
          {pending} question{pending > 1 ? 's' : ''} awaiting a reviewer reply.
        </div>
      )}
    </div>
  );
}

function fmt(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}
