// @ts-check
'use strict';
const path = require('node:path');
const { BrowserWindow, ipcMain, screen } = require('electron');

/**
 * @typedef {object} ScenePayload
 * @property {string} species
 * @property {string} displayName
 * @property {boolean} shiny
 * @property {boolean} isFlyer
 * @property {number} spriteSize   native sprite size in px (32 or 64)
 * @property {number} spriteScale  integer upscale factor
 * @property {{ walk: string, idle: string, walkLeft: string | null }} sprites  file:// URLs
 * @property {'ltr' | 'rtl'} direction
 * @property {string} meetingTitle
 * @property {number} minutesUntil
 */

const SCENE_TIMEOUT_MS = 40_000;
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

/**
 * Windows rules for transparent overlays:
 *  - never call maximize() on a transparent window; pass final bounds in the constructor instead
 *  - never call app.disableHardwareAcceleration(); transparency breaks without the GPU path
 *  - frame:false + thickFrame:false, and html/body must have background: transparent
 * @param {boolean} openDevTools
 */
function createOverlayWindow(openDevTools) {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea; // DIP, excludes the taskbar
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    thickFrame: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(RENDERER_DIR, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setIgnoreMouseEvents(true); // click-through
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  if (openDevTools) win.webContents.openDevTools({ mode: 'detach' });
  win.loadFile(path.join(RENDERER_DIR, 'overlay.html'));
  return win;
}

/**
 * Plays one scene: create, ready-to-show, showInactive, scene:play,
 * wait for scene:done (or the hard timeout), destroy.
 * @param {ScenePayload} payload
 * @param {boolean} openDevTools
 * @returns {Promise<void>}
 */
function playScene(payload, openDevTools) {
  return new Promise((resolve) => {
    const win = createOverlayWindow(openDevTools);
    const contents = win.webContents;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ipcMain.removeListener('scene:done', onDone);
      if (!win.isDestroyed()) win.destroy();
      resolve();
    };
    /** @param {Electron.IpcMainEvent} event */
    const onDone = (event) => {
      if (event.sender === contents) finish();
    };
    const timer = setTimeout(finish, SCENE_TIMEOUT_MS);

    ipcMain.on('scene:done', onDone);
    win.once('closed', finish);
    win.once('ready-to-show', () => {
      win.setAlwaysOnTop(true, 'screen-saver'); // re-assert on show; Windows can drop it
      win.showInactive(); // never steal focus from the user's current window
      contents.send('scene:play', payload);
    });
  });
}

/**
 * Serial queue so overlapping reminders never stack windows.
 * @param {{ openDevTools?: boolean }} [options]
 */
function createOverlayQueue(options = {}) {
  /** @type {ScenePayload[]} */
  const pending = [];
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    while (pending.length) {
      const next = /** @type {ScenePayload} */ (pending.shift());
      try {
        await playScene(next, Boolean(options.openDevTools));
      } catch (err) {
        console.error('Overlay scene failed:', err);
      }
    }
    running = false;
  }

  return {
    /** @param {ScenePayload} payload */
    enqueue(payload) {
      pending.push(payload);
      void drain();
    },
  };
}

module.exports = { createOverlayQueue };
