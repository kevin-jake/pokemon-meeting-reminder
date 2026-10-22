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

  return el('div', { class: 'account' }, [
    el('span', { class: 'who', text: `${a.name}: ${a.state === 'connecting' ? 'new account' : who}` }),
    el('span', { class: `state${warn ? ' warn' : ''}`, text: stateText }),
    el('label', { class: 'browser inline' }, ['Open links with ', browserSel]),
    el('div', { class: 'actions row' }, buttons),
  ]);
}

/** @param {SettingsState} state */
function render(state) {
  const s = state.settings;
  select('alertMinutes').value = String(s.alertMinutesBefore);
  if (select('alertMinutes').value !== String(s.alertMinutesBefore)) {
    // A value edited by hand in settings.json: show it rather than the first option.
    select('alertMinutes').append(el('option', { value: String(s.alertMinutesBefore), text: String(s.alertMinutesBefore) }));
    select('alertMinutes').value = String(s.alertMinutesBefore);
  }
  checkbox('nativeNotification').checked = s.nativeNotification;
  checkbox('launchAtStartup').checked = s.launchAtStartup;
  checkbox('launchAtStartup').disabled = !state.isPackaged;
  $('startupHint').textContent = state.isPackaged ? '' : '(only for the installed app, not npm start)';

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
  fillProfiles(select('addGoogleBrowser'), state.profiles, null, 'the default browser');
  $('addGoogle').title = state.googleConfigured ? '' : 'Google is not set up yet; the button explains how.';

  $('bridgeStatus').textContent = state.browserBridge ?? 'Switched off';
  $('bridgeStatus').classList.toggle('warn', Boolean(state.browserBridge?.includes('⚠')));
  checkbox('bridgeEnabled').checked = s.browserBridge.enabled;
  checkbox('toastReminders').checked = s.browserBridge.toastReminders;
  fillProfiles(select('bridgeBrowser'), state.profiles, s.accountBrowsers.browser ?? null, 'Default profile');

  fillProfiles(select('defaultBrowser'), state.profiles, s.defaultBrowser, 'System default browser');
  $('profilesHint').textContent = state.profiles.length
    ? `${state.profiles.length} profile${state.profiles.length === 1 ? '' : 's'} found in Chrome, Edge and Brave. Accounts without their own choice open links here.`
    : 'No Chrome, Edge or Brave profiles were found; links open in the system default browser.';
}

async function refresh() {
  const state = await api.getState();
  if (state) render(state);
}

/** Checkbox / select → settings patch. */
document.addEventListener('change', (e) => {
  const t = e.target;
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
  const t = e.target;
  if (!(t instanceof HTMLButtonElement) || !t.dataset.action) return;
  const action = t.dataset.action;
  /** @type {unknown} */
  let arg = t.dataset.id ?? (t.dataset.arg !== undefined ? Number(t.dataset.arg) : undefined);
  if (action === 'addGoogle') arg = select('addGoogleBrowser').value || null;
  void api.action(action, arg).then(refresh);
});

api.onChanged(() => void refresh());
void refresh();
