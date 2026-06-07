import React, { useState } from 'react';

// Copies `text` to the clipboard with brief "Copied!" feedback. Uses the async
// Clipboard API (available on http://127.0.0.1, a secure context) with an
// execCommand fallback for older/edge cases.
export default function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      alert('Copy failed: ' + e.message);
    }
  }

  return (
    <button className="copy-btn" onClick={copy} title="Copy markdown to clipboard">
      {copied ? '✓ Copied' : `⧉ ${label}`}
    </button>
  );
}
