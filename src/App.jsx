import React, { useEffect, useRef, useState } from 'react';
import { listReviews, getReview, postMessage } from './api.js';
import HunkView from './components/HunkView.jsx';
import Thread from './components/Thread.jsx';

const POLL_MS = 3000;

export default function App() {
  const [reviews, setReviews] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const mtimeRef = useRef(null);

  // Load the list of reviews once, pick the first by default.
  useEffect(() => {
    listReviews()
      .then((list) => {
        setReviews(list);
        if (list.length && !currentId) setCurrentId(list[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  // Poll the selected review; only swap state when the file actually changed.
  useEffect(() => {
    if (!currentId) return;
    let alive = true;
    mtimeRef.current = null;

    async function tick() {
      try {
        const next = await getReview(currentId);
        if (!alive) return;
        if (!next) {
          setError('review not found');
          return;
        }
        setError(null);
        if (next._mtime !== mtimeRef.current) {
          mtimeRef.current = next._mtime;
          setData(next);
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
    }

    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [currentId]);

  async function send(target, text) {
    await postMessage(currentId, target, text);
    // Force an immediate refresh rather than waiting for the next poll.
    const next = await getReview(currentId);
    mtimeRef.current = next._mtime;
    setData(next);
  }

  if (error && !data) return <div className="app"><Banner error={error} /></div>;
  if (!currentId) return <div className="app"><Empty /></div>;
  if (!data) return <div className="app"><div className="loading">Loading…</div></div>;

  const { review, hunks, threads } = data;
  const byFile = groupByFile(hunks);
  const totalPending = countPending(threads);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1>{review.title}</h1>
          <div className="review-meta">
            <code>{review.base} → {review.head}</code>
            {review.repo && <span className="repo">{review.repo}</span>}
          </div>
        </div>
        <div className="header-right">
          {reviews.length > 1 && (
            <select value={currentId} onChange={(e) => setCurrentId(e.target.value)}>
              {reviews.map((r) => (
                <option key={r.id} value={r.id}>{r.title}</option>
              ))}
            </select>
          )}
          <span className="poll-dot" title={`polling every ${POLL_MS / 1000}s`}>● live</span>
          {totalPending > 0 && <span className="header-pending">{totalPending} awaiting reviewer</span>}
        </div>
      </header>

      {error && <Banner error={error} />}

      <section className="general">
        <h2>General discussion</h2>
        <Thread
          messages={threads.general || []}
          onSend={(t) => send('general', t)}
        />
      </section>

      {Object.entries(byFile).map(([file, fileHunks]) => (
        <section key={file} className="file">
          <h2 className="file-name">{file}</h2>
          {fileHunks.map((h) => (
            <HunkView
              key={h.id}
              hunk={h}
              threads={threads}
              onSend={send}
            />
          ))}
        </section>
      ))}

      <footer className="app-footer">
        Local file-bridge review · data in <code>reviews/{review.id}/thread.json</code> ·
        reviewer protocol in <code>CLAUDE.md</code>
      </footer>
    </div>
  );
}

function groupByFile(hunks) {
  const out = {};
  for (const h of hunks) {
    (out[h.file] = out[h.file] || []).push(h);
  }
  return out;
}

function countPending(threads) {
  let n = 0;
  for (const msgs of Object.values(threads || {})) {
    n += msgs.filter((m) => m.role === 'author' && !m.answered).length;
  }
  return n;
}

function Banner({ error }) {
  return <div className="banner-error">⚠ {error}</div>;
}

function Empty() {
  return (
    <div className="empty">
      <h1>No reviews yet</h1>
      <p>Import one with:</p>
      <pre>node bin/import.mjs --repo &lt;path&gt; --base main --head HEAD --title "…"</pre>
    </div>
  );
}
