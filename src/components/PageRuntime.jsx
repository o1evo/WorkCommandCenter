import React, { useMemo, useRef } from 'react';
import * as Babel from '@babel/standalone';
import Thread from './Thread.jsx';
import Markdown from './Markdown.jsx';
import CommentLayer from './CommentLayer.jsx';

// Renders a Claude-authored interactive work-log page (`reviews/<id>/Page.jsx`).
//
// The page source is transformed from JSX in the browser with Babel-standalone
// (no build step — a Claude edit to Page.jsx re-renders on the next 3s poll)
// and evaluated. SECURITY: this runs arbitrary Claude-authored code in the page.
// That is acceptable ONLY because this tool is localhost-only, single-user, and
// touches nothing but the local filesystem (see README). Do not expose it.
//
// Authoring contract (kept deliberately tiny so pages are easy for Claude to
// write): the file defines `function Page({ wcc }) { … }` and uses NO imports /
// exports. In scope it gets: `React`, the common hooks (`useState`, `useEffect`,
// `useRef`, `useMemo`, `useCallback`), and receives `wcc` as a prop — the page
// API built in buildWcc() below (data + a <wcc.Thread> for chat-on-a-section).

const HOOK_PREAMBLE =
  'const { useState, useEffect, useRef, useMemo, useCallback } = React;';

function compile(source) {
  // Be forgiving if a page slips in import/export (the contract says don't, but
  // we strip rather than hard-fail): drop import lines, unwrap `export default`.
  const normalized = source
    .replace(/^\s*import\s.*$/gm, '')
    .replace(/export\s+default\s+/g, '');
  const { code } = Babel.transform(normalized, {
    presets: ['react'],
    filename: 'Page.jsx',
  });
  // Function-body scope: declarations hoist, so `return Page;` after the user
  // code yields the component. React is captured here (stable); fresh data is
  // delivered per-render via the wcc prop, not closed over at compile time.
  const factory = new Function('React', `${HOOK_PREAMBLE}\n${code}\n; return Page;`);
  const Page = factory(React);
  if (typeof Page !== 'function') {
    throw new Error('Page.jsx must define `function Page({ wcc }) { … }`');
  }
  return Page;
}

export default function PageRuntime({ source, wcc }) {
  // Only re-transform when the source actually changes; re-render with fresh
  // wcc every poll so threads/data stay live without recompiling.
  const compiled = useMemo(() => {
    try {
      return { Page: compile(source), error: null };
    } catch (err) {
      return { Page: null, error: err };
    }
  }, [source]);

  const pageRef = useRef(null);

  if (compiled.error) return <CompileError error={compiled.error} source={source} />;

  const { Page } = compiled;
  return (
    <PageErrorBoundary source={source}>
      <div className="wcc-page" ref={pageRef} style={{ position: 'relative' }}>
        <Page wcc={wcc} />
        <CommentLayer
          pageRef={pageRef}
          anchors={wcc.data.anchors || {}}
          threads={wcc.threads}
          version={wcc.data._mtime}
          onCreate={wcc.createAnchor}
          onSetState={wcc.setAnchorState}
          onSend={wcc.send}
          onDelete={wcc.deleteMessage}
        />
      </div>
    </PageErrorBoundary>
  );
}

// Builds the page API handed to every Page as the `wcc` prop. Rebuilt each
// render from the latest polled data, so <wcc.Thread> always shows live messages.
export function buildWcc({ id, data, onSend, onDelete, onAnchor, onAnchorState }) {
  const threads = data.threads || {};

  // <wcc.Thread target="log:my-section" title="…" /> — a self-contained chat
  // anchored to a section/idea the page chooses. Reuses the same file-bridge
  // Thread the Code Review tab uses; the reviewer Claude session answers it.
  function PageThread({ target, title, compact = true }) {
    const messages = threads[target] || [];
    const pending = messages.filter((m) => m.role === 'author' && !m.answered).length;
    return (
      <div className="page-thread">
        {title && (
          <div className="page-thread-title">
            {title}
            {pending > 0 && <span className="page-thread-badge">{pending}</span>}
          </div>
        )}
        <Thread messages={messages} onSend={(t) => onSend(target, t)}
          onDelete={onDelete && ((mid) => onDelete(target, mid))} compact={compact} />
      </div>
    );
  }

  return {
    id,
    data,
    review: data.review || {},
    hunks: data.hunks || [],
    threads,
    Thread: PageThread,
    Markdown, // <wcc.Markdown text="# full markdown\n- lists, tables, ```fences``` " />
    send: (target, text) => onSend(target, text),
    deleteMessage: (target, messageId) => onDelete(target, messageId),
    createAnchor: (anchor) => onAnchor(anchor), // used by the comment layer
    setAnchorState: (key, state) => onAnchorState(key, state),
  };
}

class PageErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidUpdate(prev) {
    // A fresh page edit should get a fresh chance to render.
    if (prev.source !== this.props.source && this.state.error) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="wcc-page-error">
          <strong>This page threw while rendering.</strong>
          <pre>{String(this.state.error && this.state.error.stack || this.state.error)}</pre>
          <p>Fix <code>Page.jsx</code> and it will re-render on the next poll.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function CompileError({ error }) {
  return (
    <div className="wcc-page-error">
      <strong>Page.jsx didn’t compile.</strong>
      <pre>{String(error && error.message || error)}</pre>
      <p>
        Pages use plain JSX with no imports/exports and must define{' '}
        <code>function Page({'{ wcc }'}) {'{ … }'}</code>.
      </p>
    </div>
  );
}
