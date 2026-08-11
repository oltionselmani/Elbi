/**
 * Filtering and sorting for the library grid.
 *
 * Pure — no DOM, no app state — so the rules can be tested directly. Watch
 * status is per-profile, so it arrives as a function rather than being read
 * from a module-level store.
 */

/** Sort orders offered above the grid, in the order they are shown. */
export const SORTS = {
  name: {
    label: 'A–Z',
    compare: (a, b) => String(a.name).localeCompare(String(b.name)),
  },
  added: {
    label: 'Recently added',
    // Newest first. A title with no timestamp sorts last rather than first,
    // so an older library missing the field does not jump the queue.
    compare: (a, b) => (b.addedAt || 0) - (a.addedAt || 0)
      || String(a.name).localeCompare(String(b.name)),
  },
  year: {
    label: 'Newest',
    compare: (a, b) => (b.year || 0) - (a.year || 0)
      || String(a.name).localeCompare(String(b.name)),
  },
  oldest: {
    label: 'Oldest',
    // Undated titles go last here too: `|| Infinity` would be wrong for a
    // "newest" sort and is wrong here for the same reason.
    compare: (a, b) => (a.year || Number.MAX_SAFE_INTEGER) - (b.year || Number.MAX_SAFE_INTEGER)
      || String(a.name).localeCompare(String(b.name)),
  },
  runtime: {
    label: 'Longest',
    compare: (a, b) => (b.runtimeMin || 0) - (a.runtimeMin || 0)
      || String(a.name).localeCompare(String(b.name)),
  },
};

export const STATUSES = {
  all: 'Everything',
  unwatched: 'Not started',
  watching: 'In progress',
  finished: 'Finished',
};

export const TYPES = {
  all: 'All',
  movie: 'Films',
  series: 'Series',
};

/** The default view: everything, A–Z. */
export function defaultView() {
  return { sort: 'name', genre: '', status: 'all', type: 'all' };
}

/** Coerce anything (a saved preference, a URL) into a usable view. */
export function normalizeView(input) {
  const base = defaultView();
  if (!input || typeof input !== 'object') return base;
  return {
    sort: Object.hasOwn(SORTS, input.sort) ? input.sort : base.sort,
    status: Object.hasOwn(STATUSES, input.status) ? input.status : base.status,
    type: Object.hasOwn(TYPES, input.type) ? input.type : base.type,
    genre: typeof input.genre === 'string' ? input.genre : base.genre,
  };
}

/** True when the view is showing everything — used to hide the "clear" button. */
export function isDefaultView(view) {
  const v = normalizeView(view);
  const d = defaultView();
  return v.sort === d.sort && v.genre === d.genre && v.status === d.status && v.type === d.type;
}

/**
 * Apply a view to a list of titles.
 *
 * `statusOf(title)` returns 'unwatched' | 'watching' | 'finished'. It is only
 * consulted when a status filter is active, so the common case costs nothing.
 */
export function applyView(titles, view, { statusOf } = {}) {
  const v = normalizeView(view);
  let out = Array.isArray(titles) ? [...titles] : [];

  if (v.type !== 'all') {
    out = out.filter((t) => (t.type === 'series' ? 'series' : 'movie') === v.type);
  }
  if (v.genre) {
    const want = v.genre.toLowerCase();
    out = out.filter((t) => (t.genres || []).some((g) => String(g).toLowerCase() === want));
  }
  if (v.status !== 'all' && typeof statusOf === 'function') {
    out = out.filter((t) => statusOf(t) === v.status);
  }

  return out.sort(SORTS[v.sort].compare);
}

/**
 * Genres present in a list, most common first, with their counts.
 * Only genres that would actually return something are offered.
 */
export function genreCounts(titles) {
  const counts = new Map();
  for (const title of titles || []) {
    for (const genre of title.genres || []) {
      const name = String(genre).trim();
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}
