// Annotation identity. Each finding (annotation) gets a stable, deterministic id
// so a discussion thread can follow it individually (thread key === annotation id).
// Deterministic from (hunk id + tag) means ids are stable across reads without
// persisting them, and a re-import reproduces the same ids for the same findings.

export function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

// Assign `id` to every annotation that lacks one. Idempotent. Disambiguates
// collisions within a hunk with a numeric suffix.
export function ensureAnnotationIds(data) {
  for (const h of data.hunks || []) {
    const seen = new Set((h.annotations || []).filter((a) => a.id).map((a) => a.id));
    for (const a of h.annotations || []) {
      if (a.id) continue;
      const base = `${h.id}::${slug(a.tag || a.note || 'note')}`;
      let id = base;
      let n = 2;
      while (seen.has(id)) id = `${base}-${n++}`;
      seen.add(id);
      a.id = id;
    }
  }
  return data;
}

// Set of all annotation ids in a review (for validating a thread target).
export function annotationIds(data) {
  const ids = new Set();
  for (const h of data.hunks || []) for (const a of h.annotations || []) if (a.id) ids.add(a.id);
  return ids;
}
