import React from 'react';
import { highlight, langForTag } from '../highlight.js';

// Renders a message body with Markdown-style fenced code blocks (```lang) and
// inline `code`. Code blocks reuse the offline Prism highlighter; plain text
// keeps its newlines via white-space: pre-wrap on .msg-text.
export default function MessageText({ text }) {
  return <div className="msg-text">{renderBody(text || '')}</div>;
}

function renderBody(text) {
  const segments = [];
  const fence = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) segments.push({ type: 'text', value: text.slice(last, m.index) });
    segments.push({ type: 'code', lang: m[1], value: m[2].replace(/\n$/, '') });
    last = fence.lastIndex;
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });

  return segments.map((seg, i) =>
    seg.type === 'code'
      ? <CodeBlock key={i} lang={seg.lang} code={seg.value} />
      : <React.Fragment key={i}>{renderInline(seg.value)}</React.Fragment>
  );
}

// Split a text run on inline `code` spans; plain strings render fine (newlines
// preserved by the parent's white-space: pre-wrap).
function renderInline(text) {
  const nodes = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(<code key={`ic-${i++}`} className="msg-inline-code">{m[1]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function CodeBlock({ lang, code }) {
  const plang = langForTag(lang);
  const html = plang ? highlight(code, plang) : null;
  return (
    <pre className="msg-code">
      {lang ? <span className="msg-code-lang">{lang}</span> : null}
      {html != null
        ? <code dangerouslySetInnerHTML={{ __html: html }} />
        : <code>{code}</code>}
    </pre>
  );
}
