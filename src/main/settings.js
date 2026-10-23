// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * @typedef {object} Settings
 * @property {number} alertMinutesBefore
 * @property {'random' | 'favorites' | 'mixed'} pokemonMode  a random Pokémon each time, one of the favorites, or favorites 60% / random 40%
 * @property {string[]} favoriteSpecies  up to 6 manifest keys, used in "favorites" and "mixed" modes
 * @property {number[]} generations  generations random mode picks from
 * @property {boolean} launchAtStartup
 * @property {boolean} nativeNotification
 * @property {number} cryVolume  0–1, 0 = mute the Pokémon's cry
 * @property {number} musicVolume  0–1, 0 = no background music
 * @property {number} pollIntervalSec
 * @property {number} lookaheadMinutes
 * @property {string[]} ignoredTitles  meetings with these titles get no reminder (see shared/ignored-meetings.js)
 * @property {{ clientId: string, clientSecret: string, enabled: boolean, allCalendars: boolean }} google
 * @property {{ clientId: string, enabled: boolean }} microsoft
 * @property {{ enabled: boolean, refreshMinutes: number }} ical  calendars subscribed by private iCal link
 * @property {import('./calendar/browser-bridge').BridgeConfig} browserBridge  Outlook / Teams via the browser extension
 * @property {string | null} defaultBrowser  browser profile id (see browsers.js) for links of unmapped accounts; null = system default browser
 * @property {Record<string, string | null>} accountBrowsers  CalendarSource id → browser profile id
 */

/** @type {Settings} */
const DEFAULTS = {
  alertMinutesBefore: 5,
  pokemonMode: 'random',
  favoriteSpecies: [],
  generations: [1, 2, 3, 4, 5],
  launchAtStartup: false,
  nativeNotification: false,
  cryVolume: 0.5,
  musicVolume: 1,
  pollIntervalSec: 60,
  lookaheadMinutes: 60,
  ignoredTitles: ['Focus time (company-wide)'],
  google: { clientId: '', clientSecret: '', enabled: true, allCalendars: false },
  microsoft: { clientId: '', enabled: true },
  ical: { enabled: true, refreshMinutes: 5 },
  browserBridge: { enabled: true, port: 47321, token: '', toastReminders: true },
  defaultBrowser: null,
  accountBrowsers: {},
};

/**
 * Fills in defaults for missing keys, recursing into plain objects only.
 * @param {any} defaults
 * @param {any} value
 * @returns {any}
 */
function deepMerge(defaults, value) {
  if (!isPlainObject(defaults) || !isPlainObject(value)) return value === undefined ? defaults : value;
  /** @type {Record<string, any>} */
  const out = { ...defaults };
  for (const [k, v] of Object.entries(value)) out[k] = k in defaults ? deepMerge(defaults[k], v) : v;
  return out;
}

/**
 * Upgrades a settings.json from before multiple favorites: the single
 * favoriteSpecies (string, or null for random) becomes a one-entry list, and
 * the removed "Always shiny" switch is dropped.
 * @param {any} raw
 * @returns {any}
 */
function migrate(raw) {
  if (!isPlainObject(raw)) return raw;
  const out = { ...raw };
  if (typeof out.favoriteSpecies === 'string' || out.favoriteSpecies === null) {
    if (!('pokemonMode' in out)) out.pokemonMode = out.favoriteSpecies ? 'favorites' : 'random';
    out.favoriteSpecies = out.favoriteSpecies ? [out.favoriteSpecies] : [];
  }
  delete out.forceShiny;
  return out;
}

/** @param {unknown} v */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * JSON settings in userData/settings.json. Reads once; every update is
 * written atomically (.tmp + rename) so a crash never leaves a torn file.
 */
function createSettings(file = path.join(app.getPath('userData'), 'settings.json')) {
  /** @type {Settings} */
  let current;
  try {
    current = deepMerge(DEFAULTS, migrate(JSON.parse(fs.readFileSync(file, 'utf8'))));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') console.warn('settings.json unreadable, using defaults:', err);
    current = structuredClone(DEFAULTS);
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(current, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  }

  return {
    file,
    get: () => current,
    /** @param {Partial<Settings>} patch */
    update(patch) {
      current = deepMerge(current, patch);
      try {
        save();
      } catch (err) {
        console.error('Failed to save settings:', err);
      }
      return current;
    },
  };
}

module.exports = { createSettings, deepMerge, migrate, DEFAULTS };
