// Thin fetch wrappers around the local file-bridge API.

export async function listReviews() {
  const r = await fetch('/api/reviews');
  if (!r.ok) throw new Error('failed to list reviews');
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

export async function postAnnotations(id, target, annotations) {
  const r = await fetch(`/api/review/${encodeURIComponent(id)}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, annotations }),
  });
  if (!r.ok) throw new Error('failed to write annotations');
  return r.json();
}
