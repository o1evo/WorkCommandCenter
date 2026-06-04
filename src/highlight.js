// Token-level syntax highlighting via Prism — fully offline, no network.
// We highlight per diff line (the table renders one line per row), which is the
// standard diff-viewer tradeoff: multi-line constructs (heredocs, block strings)
// aren't tracked across rows, but that doesn't occur in these hunks.
import Prism from 'prismjs';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-json';
// JavaScript/JSX is bundled in Prism core.

const BY_EXT = {
  rb: 'ruby',
  rake: 'ruby',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
};

export function langForFile(file) {
  const ext = String(file).split('.').pop().toLowerCase();
  const lang = BY_EXT[ext];
  return lang && Prism.languages[lang] ? lang : null;
}

// Map a fenced-code-block tag (```ruby, ```js, ```json …) to a loaded grammar.
// Unknown/absent tags return null so the block renders as plain (escaped) text.
const BY_TAG = {
  rb: 'ruby', ruby: 'ruby',
  yml: 'yaml', yaml: 'yaml',
  json: 'json',
  js: 'javascript', javascript: 'javascript', jsx: 'javascript',
  ts: 'javascript', tsx: 'javascript', mjs: 'javascript',
};

export function langForTag(tag) {
  const lang = BY_TAG[String(tag || '').toLowerCase()];
  return lang && Prism.languages[lang] ? lang : null;
}

// Returns highlighted HTML (Prism escapes its input), or null when there's no
// grammar for this language — callers then fall back to a plain text node.
export function highlight(code, lang) {
  if (!lang || !code) return null;
  const grammar = Prism.languages[lang];
  if (!grammar) return null;
  return Prism.highlight(code, grammar, lang);
}
