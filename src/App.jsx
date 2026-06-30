import React, { useEffect, useRef, useState } from 'react';
import { listReviews, getReview, postMessage, deleteMessage, deleteThread, postAnchor, setAnchorState, deleteAnchor, setPageMeta, listTags, saveTag, deleteTag } from './api.js';
import HunkView from './components/HunkView.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import TasksManager from './components/TasksManager.jsx';
import FindBar from './components/FindBar.jsx';
import ReviewSidebar from './components/ReviewSidebar.jsx';
import Thread from './components/Thread.jsx';
import PageRuntime, { buildWcc } from './components/PageRuntime.jsx';
import Markdown from './components/Markdown.jsx';
import CopyButton from './components/CopyButton.jsx';
import { applyTheme, pagePalette, readSavedTheme, THEME_LIST } from './themes.js';

// Apply the saved theme before React mounts (no flash of the default palette).
applyTheme(readSavedTheme());

const POLL_MS = 3000;
const CURRENT_KEY = 'wcc.currentReview';

export default function App() {
  const [reviews, setReviews] = useState([]);
  const [tags, setTags] = useState([]); // workspace-wide tag catalog [{ name, color }]
  const [currentId, setCurrentId] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState(null); // null → default per task (Log if it has a page)
  const [pendingJump, setPendingJump] = useState(null); // DOM id to scroll to after a tab switch
  const [paletteOpen, setPaletteOpen] = useState(false); // ⌘K task switcher
  const [manageOpen, setManageOpen] = useState(false); // "manage tasks" modal
  const [findOpen, setFindOpen] = useState(false); // ⌘F in-page find bar
  const [theme, setTheme] = useState(readSavedTheme); // color theme (chrome + pages)
  const mtimeRef = useRef(null);

  // Cross-tab navigation handed to the Log page via wcc.onNavigate: switch tabs
  // and (optionally) remember a DOM id for the target tab to scroll to once mounted.
  function goToView(targetView, domId) {
    setView(targetView || 'review');
    if (domId) setPendingJump(domId);
  }

  // ⌘K / Ctrl+K toggles the task-switcher palette from anywhere. F5 hard-reloads
  // the whole app — inside the VS Code webview the iframe swallows the default
  // browser reload, so we reload explicitly to recover from a wedged view.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === 'F5' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        window.location.reload();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        // ⌘F: the editor's native find can't reach into our iframe, so open the
        // in-page find bar instead.
        e.preventDefault();
        setFindOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        // Copy the current text selection. Inside the VS Code webview iframe the
        // default ⌘C/Ctrl+C doesn't reliably reach the clipboard, so when there's
        // a real selection (and we're not in an editable field, which handles its
        // own copy) we write it ourselves. No selection → leave the default alone.
        const el = document.activeElement;
        const editable = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (editable) return;
        const text = (window.getSelection()?.toString()) || '';
        if (!text) return;
        if (navigator.clipboard && window.isSecureContext) {
          e.preventDefault();
          navigator.clipboard.writeText(text).catch(() => { /* fall through to default on a later attempt */ });
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Apply + persist the theme whenever it changes (chrome re-themes via CSS vars;
  // pages re-theme via wcc.theme on their next render).
  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem('wcc.theme', theme); } catch { /* ignore */ }
  }, [theme]);

  // Load the list of reviews once. Restore the most-recently-selected task
  // for this client (localStorage is per-browser), falling back to the first.
  useEffect(() => {
    listReviews()
      .then((list) => {
        setReviews(list);
        if (list.length && !currentId) {
          let saved = null;
          try { saved = localStorage.getItem(CURRENT_KEY); } catch {}
          const restored = saved && list.some((r) => r.id === saved) ? saved : list[0].id;
          setCurrentId(restored);
        }
      })
      .catch((e) => setError(e.message));
    listTags().then(setTags).catch(() => { /* catalog optional */ });
  }, []);

  // Switch tasks and remember the choice for this client.
  // Re-fetch the reviews list (e.g. after a metadata change) so star/hide/name/project
  // changes show immediately without a full reload.
  async function refreshReviews() {
    try { setReviews(await listReviews()); } catch { /* keep the stale list */ }
  }
  async function updatePageMeta(id, p) {
    await setPageMeta(id, p);
    await refreshReviews();
  }
  // Persist a manual ordering for a set of pages (drag-to-reorder in the manager),
  // then refresh once rather than per-row.
  async function reorderPages(items) {
    await Promise.all(items.map(({ id, order }) => setPageMeta(id, { order })));
    await refreshReviews();
  }
  // Tag catalog mutations. A rename/delete cascades to page tags server-side, so we
  // refresh the reviews too. Errors (e.g. duplicate name) surface in the banner.
  async function upsertTag(spec) {
    try { setTags(await saveTag(spec)); await refreshReviews(); }
    catch (e) { setError(e.message); }
  }
  async function removeTag(name) {
    try { setTags(await deleteTag(name)); await refreshReviews(); }
    catch (e) { setError(e.message); }
  }

  function selectReview(id) {
    setCurrentId(id);
    try { localStorage.setItem(CURRENT_KEY, id); } catch {}
  }

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

  async function removeAnchor(key) {
    await deleteAnchor(currentId, key);
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
  const curMeta = reviews.find((r) => r.id === currentId) || {};

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <div className="brand">Work Command Center</div>
          <h1>{curMeta.name || review.title}</h1>
          <div className="review-meta">
            <code>{review.base} → {review.head}</code>
            {review.repo && <span className="repo">{review.repo}</span>}
          </div>
        </div>
        <div className="header-right">
          {reviews.length > 0 && (
            <div className="task-switch-wrap">
              <button className="task-switch" onClick={() => setPaletteOpen(true)} title="Switch task (⌘K)">
                {curMeta.starred && <span className="task-switch-star">★</span>}
                <span className="task-switch-name">{curMeta.name || review.title}</span>
                <kbd className="task-switch-kbd">⌘K</kbd>
              </button>
              <button className="task-manage-btn" onClick={() => setManageOpen(true)} title="Manage tasks">⚙</button>
            </div>
          )}
          <select className="theme-pick" value={theme} onChange={(e) => setTheme(e.target.value)} title="Color theme">
            {THEME_LIST.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
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
              onAnchorDelete: removeAnchor,
              onNavigate: goToView,
              theme: pagePalette(theme),
            })}
          />
        ) : (
          <NoPage id={currentId} />
        )
      )}

      {activeView === 'review' && (
        <ReviewView review={review} byFile={byFile} threads={threads} hunks={hunks} onSend={send} onDelete={removeMessage} onDeleteThread={removeThread}
          onDeleteAnchor={removeAnchor} onSetAnchorState={changeAnchorState}
          jumpTarget={pendingJump} onJumped={() => setPendingJump(null)} />
      )}

      {activeView === 'qa' && <QaView id={currentId} qa={data._qa} />}

      <footer className="app-footer">
        Local file-bridge · <code>work/{review.id}/</code> ·
        Log page <code>Page.jsx</code> · review <code>thread.json</code> ·
        protocol in <code>CLAUDE.md</code>
      </footer>

      {findOpen && <FindBar onClose={() => setFindOpen(false)} />}
      {paletteOpen && (
        <CommandPalette reviews={reviews} tags={tags} currentId={currentId} onSelect={selectReview}
          onClose={() => setPaletteOpen(false)} onManage={() => setManageOpen(true)} />
      )}
      {manageOpen && (
        <TasksManager reviews={reviews} tags={tags} currentId={currentId} onSelect={selectReview}
          onMeta={updatePageMeta} onReorder={reorderPages} onUpsertTag={upsertTag} onRemoveTag={removeTag}
          onClose={() => setManageOpen(false)} />
      )}
    </div>
  );
}

function ReviewView({ review, byFile, threads, hunks, onSend, onDelete, onDeleteThread, onDeleteAnchor, onSetAnchorState, jumpTarget, onJumped }) {
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem('wcc.reviewSidebar') !== 'closed'; } catch { return true; }
  });
  function toggleSidebar() {
    setSidebarOpen((v) => {
      const next = !v;
      try { localStorage.setItem('wcc.reviewSidebar', next ? 'open' : 'closed'); } catch {}
      return next;
    });
  }

  // Scroll a finding/hunk/line into view from the sidebar and flash it briefly.
  function jumpTo(domId) {
    const el = document.getElementById(domId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('jump-flash');
    setTimeout(() => el.classList.remove('jump-flash'), 1600);
  }

  // When the Log page jumps here (wcc.openCode), the hunks have just mounted —
  // wait a frame so the target element exists, then scroll to it and clear the request.
  useEffect(() => {
    if (!jumpTarget) return;
    const raf = requestAnimationFrame(() => {
      jumpTo(jumpTarget);
      onJumped && onJumped();
    });
    return () => cancelAnimationFrame(raf);
  }, [jumpTarget]);

  return (
    <div className={`review-layout ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      {sidebarOpen && <ReviewSidebar hunks={hunks} threads={threads} anchors={review.anchors || {}} onJump={jumpTo} onClose={toggleSidebar}
        onDeleteThread={onDeleteThread} onDeleteAnchor={onDeleteAnchor} onSetAnchorState={onSetAnchorState} />}
      <div className="review-main">
        {!sidebarOpen && (
          <button className="rs-toggle" onClick={toggleSidebar} title="show findings & comments index">
            ☰ Findings &amp; comments
          </button>
        )}
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
      </div>
    </div>
  );
}

function QaView({ id, qa }) {
  if (!qa) {
    return (
      <div className="empty">
        <h1>No QA plan yet</h1>
        <p>
          Add a markdown QA plan at <code>work/{id}/qa-plan.md</code> — it renders here and can be
          copied out and handed to QA. Group tests by capability, tier them P0–P3, and give each a
          Do / Pass / Hits.
        </p>
      </div>
    );
  }
  return (
    <section className="qa">
      <div className="qa-toolbar">
        <span className="qa-file">work/{id}/qa-plan.md</span>
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
        <code>work/{id}/Page.jsx</code> and it renders here live.
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
