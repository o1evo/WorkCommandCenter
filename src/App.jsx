import React, { useEffect, useRef, useState } from 'react';
import { listReviews, getReview, postMessage, deleteMessage, deleteThread, postAnchor, setAnchorState } from './api.js';
import HunkView from './components/HunkView.jsx';
import Thread from './components/Thread.jsx';
import PageRuntime, { buildWcc } from './components/PageRuntime.jsx';
import Markdown from './components/Markdown.jsx';
import CopyButton from './components/CopyButton.jsx';

const POLL_MS = 3000;

export default function App() {
  const [reviews, setReviews] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState(null); // null → default per task (Log if it has a page)
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
    setView(null); // reset to per-task default when switching tasks

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

  // Force an immediate refresh rather than waiting for the next poll.
  async function refresh() {
    const next = await getReview(currentId);
    if (next) {
      mtimeRef.current = next._mtime;
      setData(next);
    }
  }

  async function send(target, text) {
    await postMessage(currentId, target, text);
    await refresh();
  }

  async function removeMessage(target, messageId) {
    await deleteMessage(currentId, target, messageId);
    await refresh();
  }

  async function removeThread(target) {
    await deleteThread(currentId, target);
    await refresh();
  }

  async function createAnchor(anchor) {
    await postAnchor(currentId, anchor);
    await refresh();
  }

  async function changeAnchorState(key, state) {
    await setAnchorState(currentId, key, state);
    await refresh();
  }

  if (error && !data) return <div className="app"><Banner error={error} /></div>;
  if (!currentId) return <div className="app"><Empty /></div>;
  if (!data) return <div className="app"><div className="loading">Loading…</div></div>;

  const { review, hunks, threads } = data;
  const byFile = groupByFile(hunks);
  const totalPending = countPending(threads);
  const hasPage = !!data._page;
  const activeView = view || (hasPage ? 'log' : 'review');

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <div className="brand">Work Control Center</div>
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

      <nav className="tabs">
        <button
          className={`tab ${activeView === 'log' ? 'active' : ''}`}
          onClick={() => setView('log')}
        >
          Log
        </button>
        <button
          className={`tab ${activeView === 'review' ? 'active' : ''}`}
          onClick={() => setView('review')}
        >
          Code Review
          {totalPending > 0 && <span className="tab-badge">{totalPending}</span>}
        </button>
        <button
          className={`tab ${activeView === 'qa' ? 'active' : ''}`}
          onClick={() => setView('qa')}
        >
          QA Plan
        </button>
      </nav>

      {error && <Banner error={error} />}

      {activeView === 'log' && (
        hasPage ? (
          <PageRuntime
            source={data._page.source}
            wcc={buildWcc({
              id: currentId,
              data,
              onSend: send,
              onDelete: removeMessage,
              onAnchor: createAnchor,
              onAnchorState: changeAnchorState,
            })}
          />
        ) : (
          <NoPage id={currentId} />
        )
      )}

      {activeView === 'review' && (
        <ReviewView review={review} byFile={byFile} threads={threads} onSend={send} onDelete={removeMessage} onDeleteThread={removeThread} />
      )}

      {activeView === 'qa' && <QaView id={currentId} qa={data._qa} />}

      <footer className="app-footer">
        Local file-bridge · <code>reviews/{review.id}/</code> ·
        Log page <code>Page.jsx</code> · review <code>thread.json</code> ·
        protocol in <code>CLAUDE.md</code>
      </footer>
    </div>
  );
}

function ReviewView({ review, byFile, threads, onSend, onDelete, onDeleteThread }) {
  return (
    <>
      <section className="general">
        <h2>General discussion</h2>
        <Thread messages={threads.general || []} onSend={(t) => onSend('general', t)}
          onDelete={(mid) => onDelete('general', mid)} />
      </section>

      {Object.entries(byFile).map(([file, fileHunks]) => (
        <section key={file} className="file">
          <h2 className="file-name">{file}</h2>
          {fileHunks.map((h) => (
            <HunkView key={h.id} hunk={h} threads={threads} onSend={onSend} onDelete={onDelete} onDeleteThread={onDeleteThread} />
          ))}
        </section>
      ))}
    </>
  );
}

function QaView({ id, qa }) {
  if (!qa) {
    return (
      <div className="empty">
        <h1>No QA plan yet</h1>
        <p>
          Add a markdown QA plan at <code>reviews/{id}/qa-plan.md</code> — it renders here and can be
          copied out and handed to QA. Group tests by capability, tier them P0–P3, and give each a
          Do / Pass / Hits.
        </p>
      </div>
    );
  }
  return (
    <section className="qa">
      <div className="qa-toolbar">
        <span className="qa-file">reviews/{id}/qa-plan.md</span>
        <CopyButton text={qa.source} label="Copy markdown" />
      </div>
      <Markdown text={qa.source} />
    </section>
  );
}

function NoPage({ id }) {
  return (
    <div className="empty">
      <h1>No Log page yet</h1>
      <p>
        Ask Claude to build an interactive page for this task — it writes{' '}
        <code>reviews/{id}/Page.jsx</code> and it renders here live.
      </p>
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
