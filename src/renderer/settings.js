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
  checkbox('launchAtStartup').checked = s.launchAtStartup;
  checkbox('launchAtStartup').disabled = !state.isPackaged;
  $('startupHint').textContent = state.isPackaged ? '' : 'Only available in the installed app, not when running with npm start.';
  // Re-renders come with every poll: don't clobber a list that is being typed.
  const ignored = /** @type {HTMLTextAreaElement} */ ($('ignoredTitles'));
  if (document.activeElement !== ignored) ignored.value = s.ignoredTitles.join('\n');

  const favorite = select('favorite');
  favorite.replaceChildren(el('option', { value: NONE, text: 'Random' }));
  for (const [gen, list] of state.speciesByGen) {
    const group = el('optgroup', { label: `Gen ${gen}` });
    for (const e of list) group.append(el('option', { value: e.key, text: `#${String(e.dex).padStart(3, '0')} ${e.name}` }));
    favorite.append(group);
  }
  favorite.value = s.favoriteSpecies ?? NONE;
  checkbox('forceShiny').checked = s.forceShiny;

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
  else if (t instanceof HTMLInputElement) {
    switch (t.id) {
      case 'nativeNotification':
      case 'launchAtStartup':
      case 'forceShiny':
        patch = { [t.id]: t.checked };
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
      case 'favorite':
        patch = { favoriteSpecies: t.value || null };
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
