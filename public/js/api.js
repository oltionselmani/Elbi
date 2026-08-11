/** Thin fetch wrapper: JSON in, JSON out, errors as thrown Error objects. */

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload || {};
  }
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(method, path, { body, raw, query, signal, headers } = {}) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const init = { method, signal, credentials: 'same-origin', headers: { ...(headers || {}) } };
  if (raw !== undefined) {
    init.body = raw;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, init);
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await res.json().catch(() => ({})) : {};

  if (!res.ok) {
    if (res.status === 401 && payload.authRequired && onUnauthorized) onUnauthorized();
    throw new ApiError(payload.error || `Request failed (${res.status})`, res.status, payload);
  }
  return payload;
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
  patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
  del: (path, opts) => request('DELETE', path, opts),

  authStatus: () => request('GET', '/api/auth/status'),
  login: (password) => request('POST', '/api/auth/login', { body: { password } }),
  logout: () => request('POST', '/api/auth/logout'),

  library: (profileId) => request('GET', '/api/library', { query: { profile: profileId } }),

  createTitle: (fields) => request('POST', '/api/titles', { body: fields }),
  patchTitle: (id, fields) => request('PATCH', `/api/titles/${id}`, { body: fields }),
  deleteTitle: (id, deleteFiles) => request('DELETE', `/api/titles/${id}`, { query: { deleteFiles: deleteFiles ? 1 : '' } }),
  addSource: (id, source) => request('POST', `/api/titles/${id}/sources`, { body: source }),
  deleteSource: (id, sourceId) => request('DELETE', `/api/titles/${id}/sources/${sourceId}`),
  addEpisode: (id, payload) => request('POST', `/api/titles/${id}/episodes`, { body: payload }),
  deleteEpisode: (id, episodeId) => request('DELETE', `/api/titles/${id}/episodes/${episodeId}`),
  deleteSubtitle: (id, subId) => request('DELETE', `/api/titles/${id}/subtitles/${subId}`),

  uploadSubtitle: (id, file, { label, lang, episodeId }) => request('POST', `/api/titles/${id}/subtitles`, {
    raw: file,
    query: { filename: file.name, label, lang, episodeId },
    headers: { 'Content-Type': 'application/octet-stream' },
  }),

  uploadArtwork: (file) => request('POST', '/api/artwork', {
    raw: file,
    query: { filename: file.name },
    headers: { 'Content-Type': 'application/octet-stream' },
  }),

  startUpload: (meta) => request('POST', '/api/uploads', { body: meta }),
  uploadStatus: (uploadId) => request('GET', `/api/uploads/${uploadId}`),
  putChunk: (uploadId, offset, blob, signal) => request('PUT', `/api/uploads/${uploadId}`, {
    raw: blob, query: { offset }, signal, headers: { 'Content-Type': 'application/octet-stream' },
  }),
  completeUpload: (uploadId, payload) => request('POST', `/api/uploads/${uploadId}/complete`, { body: payload }),
  cancelUpload: (uploadId) => request('DELETE', `/api/uploads/${uploadId}`),

  saveProgress: (payload) => request('POST', '/api/progress', { body: payload }),
  clearProgress: (profileId, key) => request('DELETE', `/api/progress/${profileId}/${key}`),

  addToList: (profileId, titleId) => request('POST', '/api/mylist', { body: { profileId, titleId } }),
  removeFromList: (profileId, titleId) => request('DELETE', '/api/mylist', { body: { profileId, titleId } }),

  // The profile roster is fixed in code; only the watch history is mutable.
  resetProfile: (id) => request('POST', `/api/reset-profile/${id}`, { body: {} }),

  patchSettings: (fields) => request('PATCH', '/api/settings', { body: fields }),
  scan: (dir) => request('POST', '/api/scan', { body: { dir } }),

  discover: (params, signal) => request('GET', '/api/discover', { query: params, signal }),
  discoverItem: (identifier, signal) => request('GET', `/api/discover/${encodeURIComponent(identifier)}`, { signal }),
  discoverAdd: (identifier) => request('POST', `/api/discover/${encodeURIComponent(identifier)}/add`, { body: {} }),

  // Skip-intro markers. `applyTo` is 'episode' | 'season' | 'all'.
  setIntro: (id, { intro, episodeId, applyTo }) => request('POST', `/api/titles/${id}/markers`, {
    body: { intro, episodeId, applyTo },
  }),

  // Posters and metadata.
  metadataStatus: () => request('GET', '/api/metadata/status'),
  matchOptions: (id, query, signal) => request('GET', `/api/titles/${id}/match`, { query, signal }),
  applyMatch: (id, choice) => request('POST', `/api/titles/${id}/match`, { body: choice || {} }),
  enrichMetadata: (payload) => request('POST', '/api/metadata/enrich', { body: payload || {} }),

  // Subtitle search — Albanian by default, see ELBI_SUBTITLE_LANG.
  searchSubtitles: (params, signal) => request('GET', '/api/subsearch', { query: params, signal }),
  fetchSubtitle: (id, payload) => request('POST', `/api/titles/${id}/subtitles/fetch`, { body: payload || {} }),
};

/**
 * Canonical playback URL. Remote sources are streamed through the server, so
 * this stays same-origin — which is also what lets the service worker cache it
 * and answer range requests offline.
 */
export function streamUrl(titleId, sourceId, { download = false, redirect = false } = {}) {
  const url = new URL(`/api/stream/${titleId}/${sourceId}`, location.origin);
  if (download) url.searchParams.set('download', '1');
  if (redirect) url.searchParams.set('redirect', '1');
  return url.pathname + url.search;
}

export function subtitleUrl(titleId, subtitleId) {
  return `/api/subtitles/${titleId}/${subtitleId}.vtt`;
}
