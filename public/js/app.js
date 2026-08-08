import { $, $$, el, clear, debounce, toast, hashColor, badgeFor, formatBytes } from './util.js';
import { api, setUnauthorizedHandler } from './api.js';
import {
  state, refresh, subscribe, savedProfileId, rememberProfile, forgetProfile,
} from './state.js';
import {
  renderBrowse, renderLibrary, renderSearch, renderDiscover, renderProfileList,
  openDownloads, openSheet, closeSheet, closeDetail, openDetail,
} from './views.js';
import { openAdd, closeAdd, bindAddTabs, openSettings } from './add.js';
import { initOffline, registerServiceWorker, offlineCount, requestPersistence, onJobsChanged } from './offline.js';
import { isOpen as playerIsOpen, close as closePlayer } from './player.js';

// ---------------------------------------------------------------------------
// routing

function currentRoute() {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  if (path.startsWith('/library')) return { name: 'library' };
  if (path.startsWith('/discover')) return { name: 'discover', q: params.get('q') || '' };
  if (path.startsWith('/search')) return { name: 'search', q: params.get('q') || '' };
  return { name: 'browse' };
}

export function navigate(to, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', to);
  else history.pushState({}, '', to);
  render();
}

function render() {
  if (!state.ready) return;
  const route = currentRoute();

  for (const link of $$('.navlink')) {
    const target = link.dataset.route;
    link.classList.toggle('is-active', target === `/${route.name}` || (route.name === 'browse' && target === '/browse'));
  }

  const search = $('#searchInput');
  if (route.name === 'search') {
    if (search.value !== route.q) search.value = route.q;
    renderSearch(route.q);
  } else if (route.name === 'library') {
    renderLibrary();
  } else if (route.name === 'discover') {
    if (search.value) search.value = '';
    renderDiscover(route.q);
  } else {
    renderBrowse();
  }

  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  updateChrome();
}

/** Cheap fingerprint of everything the browse view draws from. */
function librarySignature() {
  const titles = state.titles
    .map((t) => `${t.id}:${t.name}:${t.sourceCount}:${t.episodeCount}:${t.poster || ''}`)
    .join('|');
  const watched = Object.keys(state.progress).sort().join(',');
  const finished = Object.values(state.progress).filter((p) => p.finished).length;
  return `${titles}#${state.myList.join(',')}#${watched}#${finished}#${state.offlineSources.size}`;
}

function updateChrome() {
  const profile = state.profiles.find((p) => p.id === state.activeProfile);
  const avatar = $('#profileBtn');
  if (profile) {
    avatar.textContent = badgeFor(profile.name, state.profiles.map((p) => p.name));
    avatar.style.background = profile.color || hashColor(profile.name);
    avatar.title = profile.name;
  }

  const count = offlineCount();
  const badge = $('#offlineCount');
  badge.textContent = String(count);
  badge.hidden = count === 0;

  const files = state.titles.reduce((n, t) => n + t.sourceCount, 0);
  $('#footerStats').textContent = state.online
    ? `${state.titles.length} titles · ${files} video files · ${count} saved offline`
    : `Offline — showing your cached library. ${count} title${count === 1 ? '' : 's'} available to watch.`;
}

// ---------------------------------------------------------------------------
// gates

function showLogin() {
  $('#loginGate').hidden = false;
  $('#profileGate').hidden = true;
  $('#app').hidden = true;
  $('#loginPassword')?.focus();
}

function showProfiles() {
  $('#loginGate').hidden = true;
  $('#app').hidden = true;
  const gate = $('#profileGate');
  gate.hidden = false;
  renderProfileList($('#profileList'), (profile) => {
    rememberProfile(profile.id);
    startApp();
  }, savedProfileId());
}

async function startApp() {
  $('#loginGate').hidden = true;
  $('#profileGate').hidden = true;
  $('#app').hidden = false;
  await refresh();
  render();
}

// ---------------------------------------------------------------------------
// boot

async function boot() {
  setUnauthorizedHandler(() => showLogin());
  bindGlobalUi();
  bindAddTabs();

  await initOffline();
  registerServiceWorker();

  let status;
  try {
    status = await api.authStatus();
  } catch {
    // The server is unreachable; the service worker may still have a library.
    status = { authRequired: false, authed: true };
  }

  if (status.authRequired && !status.authed) {
    showLogin();
    return;
  }

  try {
    await refresh();
  } catch (err) {
    if (err.status === 401) return showLogin();
    $('#app').hidden = false;
    clear($('#view')).append(el('div.empty', {}, [
      el('h3', { text: 'Could not load your library' }),
      el('p', { text: err.message }),
      el('button.btn.btn--primary', { type: 'button', onclick: () => location.reload() }, ['Retry']),
    ]));
    return;
  }

  // Always ask who is watching on a fresh load. Continue Watching is only
  // useful if it belongs to one person, and there is no password to make the
  // choice feel like a login. The last pick is highlighted, not auto-applied.
  showProfiles();
  return undefined;
}

function bindGlobalUi() {
  // login
  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#loginError');
    error.hidden = true;
    try {
      await api.login($('#loginPassword').value);
      $('#loginPassword').value = '';
      await boot();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });

  // profile switching (the roster itself is fixed; see store.js)
  $('#profileBtn').addEventListener('click', openProfileMenu);

  // navigation
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-route]');
    if (!link) return;
    event.preventDefault();
    navigate(link.getAttribute('href'));
  });
  window.addEventListener('popstate', render);

  // search
  const search = $('#searchInput');
  const runSearch = debounce(() => {
    const q = search.value.trim();
    if (!q) {
      if (currentRoute().name === 'search') navigate('/browse', { replace: true });
      return;
    }
    navigate(`/search?q=${encodeURIComponent(q)}`, { replace: currentRoute().name === 'search' });
  }, 260);
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { search.value = ''; navigate('/browse'); search.blur(); }
  });

  // header buttons
  $('#addBtn').addEventListener('click', () => openAdd('upload'));
  $('#offlineBtn').addEventListener('click', openDownloads);

  // modals close on scrim / close button / Escape
  for (const id of ['detailModal', 'addModal', 'sheetModal']) {
    const modal = $(`#${id}`);
    modal.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) {
        if (id === 'addModal') closeAdd();
        else if (id === 'sheetModal') closeSheet();
        else closeDetail();
      }
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (playerIsOpen()) return; // the player handles its own Escape
    if (!$('#sheetModal').hidden) closeSheet();
    else if (!$('#addModal').hidden) closeAdd();
    else if (!$('#detailModal').hidden) closeDetail();
  });

  // sticky header shading
  const topbar = $('#topbar');
  const onScroll = () => topbar.classList.toggle('is-stuck', window.scrollY > 24);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Re-render when the library itself changes (a scan, an upload, a deletion),
  // but not for every progress tick — and never while the player owns the screen.
  let signature = '';
  subscribe(() => {
    if ($('#app').hidden) return;
    updateChrome();
    const next = librarySignature();
    if (next === signature) return;
    signature = next;
    if (playerIsOpen()) return;
    // The discover view owns its own async results; re-rendering would drop them.
    if (currentRoute().name === 'discover') return;
    render();
  });
  onJobsChanged(() => updateChrome());
  window.addEventListener('online', () => { toast('Back online.', 'ok'); refresh().then(render).catch(() => {}); });
  window.addEventListener('offline', () => toast('Offline — downloaded titles still play.', 'info'));

  // keyboard shortcuts outside the player
  document.addEventListener('keydown', (event) => {
    if (playerIsOpen()) return;
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '/') { event.preventDefault(); $('#searchInput').focus(); }
    if (event.key === 'a') { event.preventDefault(); openAdd('upload'); }
    if (event.key === 'g') { event.preventDefault(); navigate('/browse'); }
  });
}

function openProfileMenu() {
  const body = clear($('#sheetBody'));
  const current = state.profiles.find((p) => p.id === state.activeProfile);

  body.append(el('div', {}, [
    el('h2', { text: 'Profile' }),
    el('p.muted', { text: `Watching as ${current?.name || 'unknown'}. Progress and My List are per profile.` }),
    el('div.profiles', {}, state.profiles.map((profile) => el('button.profile', {
      type: 'button',
      onclick: async () => {
        rememberProfile(profile.id);
        closeSheet();
        await refresh();
        render();
        toast(`Now watching as ${profile.name}.`, 'ok');
      },
    }, [
      el('div.profile__face', {
        style: {
          background: profile.color || hashColor(profile.name),
          borderColor: profile.id === state.activeProfile ? '#fff' : 'transparent',
        },
        text: badgeFor(profile.name, state.profiles.map((p) => p.name)),
      }),
      el('div.profile__name', { text: profile.name }),
    ]))),
    el('div.row-gap', {}, [
      el('button.btn.btn--ghost', { type: 'button', onclick: openProfileManager }, ['All profiles']),
      el('button.btn.btn--ghost', { type: 'button', onclick: () => { closeSheet(); openSettings(); } }, ['Settings']),
      el('button.btn.btn--ghost', {
        type: 'button',
        onclick: () => { forgetProfile(); closeSheet(); showProfiles(); },
      }, ['Switch profile']),
    ]),
  ]));
  openSheet();
}

function openProfileManager() {
  const body = clear($('#sheetBody'));

  body.append(el('div', {}, [
    el('h2', { text: 'Profiles' }),
    el('p.muted', {
      text: 'Elbi has four fixed profiles and no passwords. Picking a name on the way in exists only to keep Continue Watching and My List separate for each person.',
    }),
    el('div.profiles', {}, state.profiles.map((profile) => {
      const isActive = profile.id === state.activeProfile;
      return el('button.profile', {
        type: 'button',
        onclick: async () => {
          rememberProfile(profile.id);
          closeSheet();
          await refresh();
          render();
          toast(`Now watching as ${profile.name}.`, 'ok');
        },
      }, [
        el('div.profile__face', {
          style: {
            background: profile.color || hashColor(profile.name),
            borderColor: isActive ? '#fff' : 'transparent',
          },
          text: badgeFor(profile.name, state.profiles.map((p) => p.name)),
        }),
        el('div.profile__name', { text: profile.name }),
        isActive ? el('div.profile__hint', { text: 'watching now' }) : null,
      ]);
    })),

    el('div.note', {
      text: 'The roster is fixed in code — edit PROFILES in src/server/store.js if you ever want different names.',
    }),

    el('div.row-gap', { style: { marginTop: '1rem' } }, [
      el('button.btn.btn--ghost', {
        type: 'button',
        onclick: () => { forgetProfile(); closeSheet(); showProfiles(); },
      }, ['Switch profile']),
      el('button.btn.btn--danger', {
        type: 'button',
        onclick: async () => {
          const me = state.profiles.find((p) => p.id === state.activeProfile);
          if (!confirm(`Clear ${me?.name || 'this profile'}'s Continue Watching? Nobody else is affected.`)) return;
          try {
            await api.resetProfile(state.activeProfile);
            await refresh();
            render();
            closeSheet();
            toast('Watch history cleared.', 'ok');
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      }, ['Clear my watch history']),
    ]),
  ]));
  openSheet();
}

// Offline downloads are worth protecting from eviction; ask once, quietly.
requestPersistence().catch(() => {});

boot().catch((err) => {
  console.error('[elbi] boot failed', err);
  document.body.append(el('div.empty', {}, [
    el('h3', { text: 'Elbi failed to start' }),
    el('p', { text: err.message }),
  ]));
});

// Exposed for debugging from the console.
window.elbi = { state, refresh, navigate, openDetail, closePlayer, formatBytes };
