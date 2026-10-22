// @ts-check
'use strict';
/**
 * Settings page. Main owns the state: every change is sent as a settings
 * patch or an action, and the page re-renders from `settings:state` whenever
 * main says something changed. The DOM is built with createElement (the CSP
 * forbids inline scripts and handlers).
 */

/** @typedef {import('../main/settings-window').SettingsState} SettingsState */
/** @typedef {import('../main/browsers').BrowserProfile} BrowserProfile */

/**
 * @type {{
 *   getState(): Promise<SettingsState | null>,
 *   update(patch: object): Promise<void>,
 *   action(name: string, arg?: unknown): Promise<void>,
 *   onChanged(cb: () => void): void,
 * }}
 */
const api = /** @type {any} */ (window).settingsApi;

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
const select = (id) => /** @type {HTMLSelectElement} */ (document.getElementById(id));
/** @param {string} id */
const checkbox = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

/** Value for "no profile chosen" in the profile selects (null in settings). */
const NONE = '';

/**
 * @param {string} tag
 * @param {Record<string, string> & { text?: string }} [attrs]
 * @param {Array<HTMLElement | string>} [children]
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

/**
 * Fills a profile select: the "none" entry first, then every discovered
 * profile. A mapping to a profile that disappeared is shown as-is so the user
 * sees it rather than silently losing it.
 * @param {HTMLSelectElement} sel
 * @param {BrowserProfile[]} profiles
 * @param {string | null} value
 * @param {string} noneLabel
 */
function fillProfiles(sel, profiles, value, noneLabel) {
  sel.replaceChildren(el('option', { value: NONE, text: noneLabel }));
  for (const p of profiles) sel.append(el('option', { value: p.id, text: p.label }));
  if (value && !profiles.some((p) => p.id === value)) sel.append(el('option', { value, text: `${value} (not found)` }));
  sel.value = value ?? NONE;
}

/**
 * One connected calendar: who it is, its state, its browser profile, and the
 * actions that make sense in that state (mirrors the old tray submenus).
 * @param {SettingsState['accounts'][number]} a
 * @param {SettingsState} state
 */
function accountRow(a, state) {
  const who = a.label ?? 'account';
  const isLink = a.provider === 'ical';
  /** @param {string} text @param {string} action @param {string} [cls] */
  const button = (text, action, cls = '') => el('button', { type: 'button', 'data-action': action, 'data-id': a.id, class: cls, text });

  /** @type {HTMLElement[]} */
  const buttons = [];
  let stateText = 'Connected';
  let warn = false;
  switch (a.state) {
    case 'connecting':
      stateText = 'Waiting for the browser sign-in…';
      buttons.push(button('Copy sign-in link', 'copySignInLink'), button('Cancel sign-in', 'cancelConnect'));
      break;
    case 'reconnect':
      stateText = isLink ? '⚠ The link stopped working' : '⚠ Sign-in expired';
      warn = true;
      buttons.push(button(isLink ? 'Replace with link from clipboard…' : 'Reconnect…', 'reconnect', 'primary'), button('Disconnect', 'disconnect'));
      break;
    default:
      buttons.push(button('Disconnect', 'disconnect'));
  }

  const browserSel = /** @type {HTMLSelectElement} */ (el('select', { 'data-source': a.id }));
  fillProfiles(browserSel, state.profiles, state.settings.accountBrowsers[a.id] ?? null, 'Default profile');

  const stateClass = warn ? ' warn' : a.state === 'connecting' ? ' pending' : '';
  return el('div', { class: 'account' }, [
    icon(isLink ? ICONS.link : ICONS.calendar, 'icon provider'),
    el('div', { class: 'who-block' }, [
      el('span', { class: 'who', text: `${a.name}: ${a.state === 'connecting' ? 'new account' : who}` }),
      el('span', { class: `state${stateClass}`, text: stateText }),
    ]),
    el('div', { class: 'actions row' }, buttons),
    el('label', { class: 'browser' }, ['Open meeting links with', browserSel]),
  ]);
}

/** Path data for icons built at runtime (the static ones live in settings.html). */
const ICONS = {
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
};

/** @param {string} d @param {string} cls */
function icon(d, cls) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return /** @type {HTMLElement} */ (/** @type {unknown} */ (svg));
}

/** Shows the warning dot on a sidebar entry. @param {string} section @param {boolean} on */
function setBadge(section, on) {
  $(`badge-${section}`).hidden = !on;
}

/** Sidebar navigation: one pane visible at a time; the last one is remembered. */
const SECTION_KEY = 'settings.section';

/** @param {string} section */
function showSection(section) {
  const panes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.pane'));
  if (![...panes].some((p) => p.dataset.pane === section)) section = 'general';
  for (const p of panes) p.hidden = p.dataset.pane !== section;
  for (const b of document.querySelectorAll('.nav-item')) {
    if (/** @type {HTMLElement} */ (b).dataset.section === section) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  document.querySelector('main')?.scrollTo(0, 0);
  try {
    localStorage.setItem(SECTION_KEY, section);
  } catch {
    // Storage unavailable: the page just opens on General next time.
  }
}

/* ---------- Pokémon ---------- */

/** Most favorites; main enforces the same cap (MAX_FAVORITES in species.js). */
const MAX_FAVORITES = 6;

/** Region names for the generation switches and picker headings. */
const REGIONS = /** @type {Record<number, string>} */ ({ 1: 'Kanto', 2: 'Johto', 3: 'Hoenn', 4: 'Sinnoh', 5: 'Unova', 6: 'Kalos', 7: 'Alola', 8: 'Galar', 9: 'Paldea' });

/** @param {number} gen */
const genLabel = (gen) => `Gen ${gen}${REGIONS[gen] ? ` · ${REGIONS[gen]}` : ''}`;

/** The favorites as last rendered; picker clicks edit a copy of this. */
let favorites = /** @type {string[]} */ ([]);
/** Every species by key, for the favorite slots. */
const speciesInfo = /** @type {Map<string, { name: string, sprite: string }>} */ (new Map());

/** @param {string} src @param {string} [cls] */
const sprite = (src, cls = 'sprite') => el('img', { src, alt: '', class: cls, loading: 'lazy', decoding: 'async', draggable: 'false' });

/**
 * Builds the picker's option list once: 600+ animated rows are too many to
 * rebuild on every refresh, and rebuilding would reset the scroll position.
 * @param {SettingsState['speciesByGen']} byGen
 */
function buildPicker(byGen) {
  if (speciesInfo.size) return;
  const list = $('pickerList');
  for (const [gen, entries] of byGen) {
    const group = el('div', { class: 'picker-group', role: 'group', 'aria-label': genLabel(gen) }, [el('div', { class: 'picker-gen', text: genLabel(gen) })]);
    for (const e of entries) {
      speciesInfo.set(e.key, e);
      group.append(
        el('button', { type: 'button', class: 'picker-option', role: 'option', 'data-pick': e.key, 'data-name': e.name.toLowerCase(), tabindex: '-1' }, [
          sprite(e.sprite),
          el('span', { class: 'picker-name', text: e.name }),
          icon('M5 12l5 5L20 7', 'icon check'),
        ]),
      );
    }
    list.append(group);
  }
}

/** @param {SettingsState} state */
function renderPokemon(state) {
  const s = state.settings;
  buildPicker(state.speciesByGen);
  favorites = s.favoriteSpecies.filter((k) => speciesInfo.has(k));
  const favoritesMode = s.pokemonMode === 'favorites';
  select('pokemonMode').value = s.pokemonMode;
  $('favoritesSetting').hidden = !favoritesMode;
  if (!favoritesMode) closePicker();

  // Six slots: the chosen ones, then empty ones that open the picker.
  const slots = favorites.map((key) => {
    const info = /** @type {{ name: string, sprite: string }} */ (speciesInfo.get(key));
    return el('li', { class: 'slot filled' }, [
      sprite(info.sprite, 'sprite big'),
      el('span', { class: 'slot-name', text: info.name }),
      el('button', { type: 'button', class: 'slot-remove', 'data-unpick': key, title: `Remove ${info.name}`, 'aria-label': `Remove ${info.name}` }, [
        icon('M6 6l12 12M18 6L6 18', 'icon'),
      ]),
    ]);
  });
  for (let i = favorites.length; i < MAX_FAVORITES; i++) {
    slots.push(el('li', { class: 'slot' }, [el('button', { type: 'button', class: 'slot-add', 'data-open-picker': '', title: 'Add a favorite', 'aria-label': 'Add a favorite' }, [icon('M12 5v14M5 12h14', 'icon')])]));
  }
  $('favorites').replaceChildren(...slots);

  const full = favorites.length >= MAX_FAVORITES;
  const left = MAX_FAVORITES - favorites.length;
  $('favoritesHint').textContent = !favorites.length
    ? `Pick up to ${MAX_FAVORITES}. Until you do, reminders send a random Pokémon. A short preview plays for each one you add.`
    : full
      ? 'Each reminder sends one of these. Remove one to pick another.'
      : `Each reminder sends one of these. You can add ${left} more.`;
  $('pickerLabel').textContent = full ? `All ${MAX_FAVORITES} chosen` : 'Add a favorite';
  /** @type {HTMLButtonElement} */ ($('pickerToggle')).disabled = full;
  if (full) closePicker();

  for (const opt of /** @type {NodeListOf<HTMLButtonElement>} */ ($('pickerList').querySelectorAll('.picker-option'))) {
    const chosen = favorites.includes(/** @type {string} */ (opt.dataset.pick));
    opt.setAttribute('aria-selected', String(chosen));
    opt.disabled = full && !chosen;
  }

  $('generations').replaceChildren(
    ...state.speciesByGen.map(([gen, entries]) => {
      const on = s.generations.includes(gen);
      const box = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', class: 'switch', 'data-gen': String(gen), 'aria-label': genLabel(gen) }));
      box.checked = on;
      // At least one generation stays on, or random mode would have no one to send.
      box.disabled = on && s.generations.length === 1;
      return el('label', { class: 'gen' }, [
        el('span', { class: 'gen-text' }, [el('span', { class: 'gen-title', text: genLabel(gen) }), el('span', { class: 'gen-count', text: `${entries.length} Pokémon` })]),
        box,
      ]);
    }),
  );
}

/** @param {string[]} next */
function saveFavorites(next) {
  favorites = next;
  void api.update({ favoriteSpecies: next }).then(refresh);
}

function openPicker() {
  const pop = $('pickerPop');
  if (!pop.hidden || favorites.length >= MAX_FAVORITES) return;
  pop.hidden = false;
  $('pickerToggle').setAttribute('aria-expanded', 'true');
  const search = /** @type {HTMLInputElement} */ ($('pickerSearch'));
  search.value = '';
  filterPicker('');
  $('pickerList').scrollTop = 0;
  search.focus();
}

function closePicker() {
  $('pickerPop').hidden = true;
  $('pickerToggle').setAttribute('aria-expanded', 'false');
}

/** Shows only names containing `query`, and hides generations left empty. @param {string} query */
function filterPicker(query) {
  const q = query.trim().toLowerCase();
  let any = false;
  for (const group of /** @type {NodeListOf<HTMLElement>} */ ($('pickerList').querySelectorAll('.picker-group'))) {
    let shown = 0;
    for (const opt of /** @type {NodeListOf<HTMLElement>} */ (group.querySelectorAll('.picker-option'))) {
      opt.hidden = Boolean(q) && !opt.dataset.name?.includes(q);
      if (!opt.hidden) shown++;
    }
    group.hidden = shown === 0;
    any ||= shown > 0;
  }
  $('pickerEmpty').hidden = any;
}

/** Visible, enabled options in list order, for arrow-key moves. */
function pickerOptions() {
  return [.../** @type {NodeListOf<HTMLButtonElement>} */ ($('pickerList').querySelectorAll('.picker-option'))].filter(
    (o) => !o.hidden && !o.disabled && !(/** @type {HTMLElement} */ (o.parentElement).hidden),
  );
}

$('pickerSearch').addEventListener('input', (e) => filterPicker(/** @type {HTMLInputElement} */ (e.target).value));

/** Keyboard: arrows move through the list, Enter in the search box picks the first match, Escape closes. */
$('picker').addEventListener('keydown', (e) => {
  if ($('pickerPop').hidden) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closePicker();
    $('pickerToggle').focus();
    return;
  }
  const options = pickerOptions();
  const at = options.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
  if (e.key === 'Enter' && document.activeElement === $('pickerSearch') && options[0]) {
    e.preventDefault();
    options[0].click();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    options[Math.min(at + 1, options.length - 1)]?.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (at <= 0) $('pickerSearch').focus();
    else options[at - 1].focus();
  }
});

/** Clicks outside the open picker close it. */
document.addEventListener('pointerdown', (e) => {
  if (!$('pickerPop').hidden && e.target instanceof Node && !$('picker').contains(e.target)) closePicker();
});

/** @param {SettingsState} state */
function render(state) {
  const s = state.settings;
  select('alertMinutes').value = String(s.alertMinutesBefore);
  if (select('alertMinutes').value !== String(s.alertMinutesBefore)) {
    // A value edited by hand in settings.json: show it rather than the first option.
    const n = s.alertMinutesBefore;
    select('alertMinutes').append(el('option', { value: String(n), text: `${n} minute${n === 1 ? '' : 's'} before` }));
    select('alertMinutes').value = String(s.alertMinutesBefore);
  }
  checkbox('nativeNotification').checked = s.nativeNotification;
  for (const id of /** @type {const} */ (['cryVolume', 'musicVolume'])) {
    // Don't yank the slider out from under a drag when a poll re-renders.
    if (document.activeElement !== checkbox(id)) checkbox(id).value = String(Math.round(s[id] * 100));
    showVolume(id);
  }
  checkbox('launchAtStartup').checked = s.launchAtStartup;
  checkbox('launchAtStartup').disabled = !state.isPackaged;
  $('startupHint').textContent = state.isPackaged ? '' : 'Only available in the installed app, not when running with npm start.';
  // Re-renders come with every poll: don't clobber a list that is being typed.
  const ignored = /** @type {HTMLTextAreaElement} */ ($('ignoredTitles'));
  if (document.activeElement !== ignored) ignored.value = s.ignoredTitles.join('\n');

  renderPokemon(state);

  $('accounts').replaceChildren(...state.accounts.map((a) => accountRow(a, state)));
  setBadge('calendars', state.accounts.some((a) => a.state === 'reconnect'));
  fillProfiles(select('addGoogleBrowser'), state.profiles, null, 'the default browser');
  $('addGoogle').title = state.googleConfigured ? '' : 'Google is not set up yet; the button explains how.';

  const bridgeWarn = Boolean(state.browserBridge?.includes('⚠'));
  $('bridgeStatus').textContent = state.browserBridge ?? 'Switched off';
  $('bridgeStatus').classList.toggle('warn', bridgeWarn);
  $('bridgeDot').className = `status-dot${bridgeWarn ? ' warn' : state.browserBridge ? ' ok' : ''}`;
  setBadge('outlook', bridgeWarn);
  checkbox('bridgeEnabled').checked = s.browserBridge.enabled;
  checkbox('toastReminders').checked = s.browserBridge.toastReminders;
  fillProfiles(select('bridgeBrowser'), state.profiles, s.accountBrowsers.browser ?? null, 'Default profile');

  fillProfiles(select('defaultBrowser'), state.profiles, s.defaultBrowser, 'System default browser');
  $('profilesHint').textContent = state.profiles.length
    ? `Found ${state.profiles.length} profile${state.profiles.length === 1 ? '' : 's'} in Chrome, Edge and Brave. Click Refresh if you added a profile since the app started.`
    : 'No Chrome, Edge or Brave profiles were found, so links open in the system default browser. Click Refresh after adding one.';
}

/** @param {'cryVolume' | 'musicVolume'} id */
function showVolume(id) {
  const v = Number(checkbox(id).value);
  $(`${id}Value`).textContent = v === 0 ? 'Off' : `${v}%`;
}

/** Live label while a volume slider is dragged; the setting saves on release (change). */
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && (t.id === 'cryVolume' || t.id === 'musicVolume')) showVolume(t.id);
});

async function refresh() {
  const state = await api.getState();
  if (state) render(state);
}

/** Checkbox / select → settings patch. */
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t instanceof HTMLTextAreaElement && t.id === 'ignoredTitles') {
    // One title per line; main checks the list's shape and caps.
    const titles = [...new Set(t.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
    void api.update({ ignoredTitles: titles.slice(0, 200).map((l) => l.slice(0, 200)) }).then(refresh);
    return;
  }
  if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return;
  const sourceId = t.getAttribute('data-source');
  /** @type {object | null} */
  let patch = null;
  if (sourceId) patch = { accountBrowsers: { [sourceId]: t.value || null } };
  else if (t.dataset.gen) {
    const boxes = /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[data-gen]'));
    const generations = [...boxes].filter((b) => b.checked).map((b) => Number(b.dataset.gen));
    if (generations.length) patch = { generations };
  } else if (t instanceof HTMLInputElement) {
    switch (t.id) {
      case 'nativeNotification':
      case 'launchAtStartup':
        patch = { [t.id]: t.checked };
        break;
      case 'cryVolume':
      case 'musicVolume':
        patch = { [t.id]: Number(t.value) / 100 };
        break;
      case 'bridgeEnabled':
        patch = { browserBridge: { enabled: t.checked } };
        break;
      case 'toastReminders':
        patch = { browserBridge: { toastReminders: t.checked } };
        break;
    }
  } else {
    switch (t.id) {
      case 'alertMinutes':
        patch = { alertMinutesBefore: Number(t.value) };
        break;
      case 'pokemonMode':
        patch = { pokemonMode: t.value };
        break;
      case 'defaultBrowser':
        patch = { defaultBrowser: t.value || null };
        break;
    }
  }
  if (patch) void api.update(patch).then(refresh);
});

/** Buttons → actions. The argument is the account id, the test minutes, or the chosen sign-in profile. */
document.addEventListener('click', (e) => {
  // Buttons hold icons, so the click may land on the svg inside.
  const t = e.target instanceof Element ? e.target.closest('button') : null;
  if (!t) return;
  if (t.id === 'pickerToggle' || t.dataset.openPicker !== undefined) {
    if (t.id === 'pickerToggle' && !$('pickerPop').hidden) closePicker();
    else openPicker();
    return;
  }
  if (t.dataset.pick) {
    const key = t.dataset.pick;
    if (favorites.includes(key)) saveFavorites(favorites.filter((k) => k !== key));
    else if (favorites.length < MAX_FAVORITES) saveFavorites([...favorites, key]);
    // The list stays open for more picks until all six are chosen.
    if (favorites.length >= MAX_FAVORITES) closePicker();
    return;
  }
  if (t.dataset.unpick) {
    saveFavorites(favorites.filter((k) => k !== t.dataset.unpick));
    return;
  }
  if (t.dataset.section) {
    showSection(t.dataset.section);
    return;
  }
  if (!t.dataset.action) return;
  const action = t.dataset.action;
  /** @type {unknown} */
  let arg = t.dataset.id ?? (t.dataset.arg !== undefined ? Number(t.dataset.arg) : undefined);
  if (action === 'addGoogle') arg = select('addGoogleBrowser').value || null;
  void api.action(action, arg).then(refresh);
});

/** @type {string | null} */
let lastSection = null;
try {
  lastSection = localStorage.getItem(SECTION_KEY);
} catch {
  // Storage unavailable: start on General.
}
showSection(lastSection ?? 'general');

api.onChanged(() => void refresh());
void refresh();
