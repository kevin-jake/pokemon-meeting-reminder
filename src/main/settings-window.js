// @ts-check
'use strict';
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');
const { isValidIgnoredTitles } = require('../shared/ignored-meetings');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

/**
 * What the Settings page renders. Everything is a plain value: the page is
 * sandboxed and only sees what main sends over `settings:state`.
 * @typedef {object} SettingsState
 * @property {import('./settings').Settings} settings
 * @property {Array<{ id: string, provider: string, name: string, state: import('./calendar/types').SourceState, label: string | null }>} accounts
 * @property {string | null} browserBridge  status row text, null when switched off
 * @property {import('./browsers').BrowserProfile[]} profiles
 * @property {Array<[number, Array<{ key: string, name: string, dex: number }>]>} speciesByGen
 * @property {boolean} isPackaged  "Launch at startup" only works for an installed build
 * @property {boolean} googleConfigured
 */

/** Settings keys the page may change, and how each value is checked. */
const EDITABLE = {
  alertMinutesBefore: (/** @type {unknown} */ v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 60,
  nativeNotification: (/** @type {unknown} */ v) => typeof v === 'boolean',
  launchAtStartup: (/** @type {unknown} */ v) => typeof v === 'boolean',
  favoriteSpecies: (/** @type {unknown} */ v) => v === null || (typeof v === 'string' && /^[a-z0-9_-]+$/.test(v)),
  forceShiny: (/** @type {unknown} */ v) => typeof v === 'boolean',
  ignoredTitles: isValidIgnoredTitles,
  defaultBrowser: (/** @type {unknown} */ v) => v === null || typeof v === 'string',
  accountBrowsers: (/** @type {unknown} */ v) =>
    typeof v === 'object' && v !== null && Object.values(v).every((p) => p === null || typeof p === 'string'),
  browserBridge: (/** @type {unknown} */ v) =>
    typeof v === 'object' && v !== null && Object.entries(v).every(([k, b]) => (k === 'enabled' || k === 'toastReminders') && typeof b === 'boolean'),
};

/**
 * Keeps only the keys the page is allowed to change, with well-formed values.
 * The renderer is sandboxed, but its input is still untrusted.
 * @param {unknown} patch
 * @returns {Partial<import('./settings').Settings>}
 */
function sanitizePatch(patch) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (typeof patch !== 'object' || patch === null) return out;
  for (const [key, value] of Object.entries(patch)) {
    const check = /** @type {Record<string, (v: unknown) => boolean>} */ (EDITABLE)[key];
    if (check && check(value)) out[key] = value;
  }
  return out;
}

/**
 * The one Settings window. Opening it again just focuses it. The page talks
 * to main through three invoke channels; main pokes it with
 * `settings:changed` whenever accounts or the status line change, and the
 * page re-fetches its state.
 * @param {object} deps
 * @param {() => SettingsState} deps.getState
 * @param {(patch: Partial<import('./settings').Settings>) => void} deps.update
 * @param {(name: string, arg: unknown) => void} deps.action  fire-and-forget; errors surface as dialogs
 * @param {boolean} [deps.openDevTools]
 */
function createSettingsWindow({ getState, update, action, openDevTools = false }) {
  /** @type {BrowserWindow | null} */
  let win = null;

  /** Only the Settings page may use these channels. @param {Electron.IpcMainInvokeEvent} event */
  const mine = (event) => win !== null && !win.isDestroyed() && event.sender === win.webContents;

  ipcMain.handle('settings:state', (event) => (mine(event) ? getState() : null));
  ipcMain.handle('settings:update', (event, patch) => {
    if (mine(event)) update(sanitizePatch(patch));
  });
  ipcMain.handle('settings:action', (event, name, arg) => {
    if (mine(event) && typeof name === 'string') action(name, arg);
  });

  function open() {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: 880,
      height: 700,
      minWidth: 480,
      minHeight: 420,
      title: 'Settings · Pokémon Meeting Reminder',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(RENDERER_DIR, 'settings-preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.once('ready-to-show', () => win?.show());
    win.on('closed', () => {
      win = null;
    });
    if (openDevTools) win.webContents.openDevTools({ mode: 'detach' });
    void win.loadFile(path.join(RENDERER_DIR, 'settings.html'));
  }

  return {
    open,
    /** The window while it is open, for parenting dialogs. */
    current: () => (win && !win.isDestroyed() ? win : undefined),
    /** Something the page shows has changed. */
    notify() {
      if (win && !win.isDestroyed()) win.webContents.send('settings:changed');
    },
  };
}

module.exports = { createSettingsWindow, sanitizePatch };
