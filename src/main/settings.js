// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * @typedef {object} Settings
 * @property {number} alertMinutesBefore
 * @property {string | null} favoriteSpecies  manifest key, or null for a random Pokémon
 * @property {boolean} forceShiny
 * @property {boolean} launchAtStartup
 * @property {boolean} nativeNotification
 * @property {number} pollIntervalSec
 * @property {number} lookaheadMinutes
 * @property {{ clientId: string, clientSecret: string, enabled: boolean, allCalendars: boolean }} google
 * @property {{ clientId: string, enabled: boolean }} microsoft
 * @property {import('./calendar/browser-bridge').BridgeConfig} browserBridge  Outlook / Teams via the browser extension
 */

/** @type {Settings} */
const DEFAULTS = {
  alertMinutesBefore: 5,
  favoriteSpecies: null,
  forceShiny: false,
  launchAtStartup: false,
  nativeNotification: false,
  pollIntervalSec: 60,
  lookaheadMinutes: 60,
  google: { clientId: '', clientSecret: '', enabled: true, allCalendars: false },
  microsoft: { clientId: '', enabled: true },
  browserBridge: { enabled: true, port: 47321, token: '', toastReminders: true },
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
    current = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(file, 'utf8')));
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

module.exports = { createSettings, deepMerge, DEFAULTS };
