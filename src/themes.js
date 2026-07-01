// Theme presets — the single source of truth for BOTH the app chrome (CSS custom
// properties on :root) and agent-authored Log pages (the taskforge.theme palette). Add a
// theme = add one entry here; chrome + pages pick it up. Each theme lists the full
// CSS-variable set; pagePalette() derives the keys pages use from the same values.

export const THEMES = {
  navy: {
    label: 'Navy',
    vars: {
      '--bg': '#0d1117', '--panel': '#161b22', '--panel-2': '#1c2129', '--border': '#30363d',
      '--text': '#c9d1d9', '--muted': '#8b949e',
      '--add-bg': '#12261e', '--add-gutter': '#2ea04326', '--del-bg': '#25171c', '--del-gutter': '#f8514926',
      '--link': '#58a6ff', '--blocker': '#f85149', '--high': '#db6d28', '--medium': '#d29922',
      '--low': '#3fb950', '--note': '#8b949e', '--resolved': '#2ea043',
    },
  },
  dark: {
    label: 'Dark neutral',
    vars: {
      '--bg': '#191919', '--panel': '#212121', '--panel-2': '#2a2a2a', '--border': '#3a3a3a',
      '--text': '#e6e6e6', '--muted': '#9e9e9e',
      '--add-bg': '#16261c', '--add-gutter': '#3fb95026', '--del-bg': '#2a1a1e', '--del-gutter': '#f8514926',
      '--link': '#6cb6ff', '--blocker': '#f0625b', '--high': '#e3853d', '--medium': '#d6a020',
      '--low': '#4cc46a', '--note': '#9e9e9e', '--resolved': '#4cc46a',
    },
  },
  light: {
    label: 'Light',
    vars: {
      '--bg': '#ffffff', '--panel': '#f6f8fa', '--panel-2': '#eef1f4', '--border': '#d0d7de',
      '--text': '#1f2328', '--muted': '#656d76',
      '--add-bg': '#e6ffec', '--add-gutter': '#1a7f3733', '--del-bg': '#ffebe9', '--del-gutter': '#cf222e33',
      '--link': '#0969da', '--blocker': '#cf222e', '--high': '#bc4c00', '--medium': '#9a6700',
      '--low': '#1a7f37', '--note': '#656d76', '--resolved': '#1a7f37',
    },
  },
};

export const DEFAULT_THEME = 'navy';
export const THEME_LIST = Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label }));

// The palette handed to Log pages as taskforge.theme. Semantic keys (the ones pages use):
// text/muted/border/panel/panel2/link/bg + ok/warn/danger and the severity colors.
export function pagePalette(name) {
  const v = (THEMES[name] || THEMES[DEFAULT_THEME]).vars;
  return {
    bg: v['--bg'], panel: v['--panel'], panel2: v['--panel-2'], border: v['--border'],
    text: v['--text'], muted: v['--muted'], link: v['--link'],
    ok: v['--resolved'], warn: v['--medium'], danger: v['--blocker'],
    blocker: v['--blocker'], high: v['--high'], medium: v['--medium'], low: v['--low'],
    note: v['--note'], resolved: v['--resolved'],
  };
}

// Push a theme's CSS variables onto :root (chrome re-themes instantly; pages re-theme
// via taskforge.theme on the next render). Safe to call before React mounts (no flash).
export function applyTheme(name) {
  if (typeof document === 'undefined') return;
  const t = THEMES[name] || THEMES[DEFAULT_THEME];
  const root = document.documentElement;
  for (const [k, val] of Object.entries(t.vars)) root.style.setProperty(k, val);
  root.setAttribute('data-theme', THEMES[name] ? name : DEFAULT_THEME);
}

export function readSavedTheme() {
  try { return localStorage.getItem('taskforge.theme') || DEFAULT_THEME; } catch { return DEFAULT_THEME; }
}
