// Thin fetch wrappers around the local file-bridge API.

export async function listReviews() {
  const r = await fetch('/api/reviews');
  if (!r.ok) throw new Error('failed to list reviews');
  return r.json();
}

// Update a page's UI metadata (name / hidden / starred / project) in .wcc/pages.json.
export async function setPageMeta(id, patch) {
  const r = await fetch('/api/page-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, patch }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'failed to update page metadata');
  return r.json();
}

// The workspace-wide tag catalog: [{ name, color }].
export async function listTags() {
  const r = await fetch('/api/tags');
  if (!r.ok) throw new Error('failed to list tags');
  return r.json();
}

// Create (original null) or rename/recolor (original = existing name) a catalog tag.
export async function saveTag({ original = null, name, color }) {
  const r = await fetch('/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'upsert', original, name, color }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'failed to save tag');
  return r.json();
}

export async function deleteTag(name) {
  const r = await fetch('/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'delete', name }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'failed to delete tag');
  return r.json();
}

export async function getReview(id) {
  const r = await fetch(`/api/review/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('failed to load review');
  return r.json();
}

export async function postMessage(id, target, text) {
  const r = await fetch(`/api/review/${encodeURIComponent(id)}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, text }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'failed to post message');
  return r.json();
}

export async function deleteMessage(id, target, messageId) {
  const r = await fetch(`/api/review/${encodeURIComponent(id)}/message-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, messageId }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'failed to delete message');
  return r.json();
}

export async function deleteThread(id, target) {
  const r = await fetch(`/api/review/${encodeURIComponent(id)}/thread-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'failed to delete thread');
  return r.json();
}

export async function postAnchor(id, anchor) {
  const r = await fetch(`/api/review/${encodeURIComponent(id)}/anchors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anchor),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'failed to save anchor');
  return r.json();
}

export async function setAnchorState(id, key, state) {
  const r = await fetch(`/api/review/${encodeURIComponent(id)}/anchor-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, state }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'failed to set anchor state');
  return r.json();
}

export async function deleteAnchor(id, key) {
  const r = await fetch(`/api/review/${encodeURIComponent(id)}/anchor-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'failed to delete comment');
  return r.json();
}

export async function postAnnotations(id, target, annotations) {
  const r = await fetch(`/api/review/${encodeURIComponent(id)}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, annotations }),
  });
  if (!r.ok) throw new Error('failed to write annotations');
  return r.json();
}
