// @ts-check
'use strict';
const path = require('node:path');
const { BrowserWindow, ipcMain, screen, shell } = require('electron');
const { safeHttpsUrl } = require('./calendar/meeting-links');

/**
 * @typedef {object} ScenePayload
 * @property {string} species
 * @property {string} displayName
 * @property {boolean} shiny
 * @property {boolean} isFlyer
 * @property {number} spriteSize   native sprite size in px (32 or 64)
 * @property {number} spriteScale  integer upscale factor
 * @property {{ walk: string, idle: string, walkLeft: string | null }} sprites  file:// URLs
 * @property {string | null} cry   file:// URL of the Pokémon's cry, or null
 * @property {string | null} music file:// URL of the background track, or null (battle theme when urgent)
 * @property {'ltr' | 'rtl'} direction
 * @property {number} altitude     flyers: sprite centre as a fraction of the work-area height
 * @property {string} meetingTitle
 * @property {number} minutesUntil  0 = meeting starts now
 * @property {boolean} urgent       cross the monitors URGENT_PASSES times, then park until dismissed
 * @property {MeetingLink | null} meetingLink  shown as a Join / Open invite button on the banner
 */

/**
 * @typedef {object} MeetingLink
 * @property {string} url          https only
 * @property {'join' | 'invite'} kind  join = video call, invite = the event in the calendar
 */

/**
 * What one overlay window is told to play for one pass over its monitor:
 *  - pause:   stop mid-screen, show idle sprite and pop the banner
 *  - park:    stop in the lower-right corner and stay there until scene:stop
 *  - playCry: play the cry on this window during this pass
 *  - fadeOut: fade the stage once the sprite leaves this monitor
 * @typedef {ScenePayload & { pause: boolean, park: boolean, playCry: boolean, fadeOut: boolean }} PassPayload
 */

const URGENT_PASSES = 1;
const PASS_TIMEOUT_MS = 40_000;
const MUSIC_START_TIMEOUT_MS = 2_000;
const STOP_GRACE_MS = 1_000;
const NEVER = new Promise(() => {});
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

/**
 * Windows rules for transparent overlays:
 *  - never call maximize() on a transparent window; pass final bounds in the constructor instead
 *  - never call app.disableHardwareAcceleration(); transparency breaks without the GPU path
 *  - frame:false + thickFrame:false, and html/body must have background: transparent
 * @param {Electron.Display} display
 * @param {boolean} openDevTools
 */
function createOverlayWindow(display, openDevTools) {
  const { x, y, width, height } = display.workArea; // DIP, excludes that monitor's taskbar
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
  // Click-through, but keep forwarding mouse moves so the renderer can ask to
  // become clickable while the cursor is over the Dismiss button.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  if (openDevTools) win.webContents.openDevTools({ mode: 'detach' });
  win.loadFile(path.join(RENDERER_DIR, 'overlay.html'));
  return win;
}

/** @param {BrowserWindow} win */
function whenReadyToShow(win) {
  return new Promise((resolve) => {
    win.once('ready-to-show', resolve);
    win.once('closed', resolve);
  });
}

/**
 * Resolves when `channel` arrives from `win`, when the abort promise settles,
 * when the window closes, or after `timeoutMs`.
 * @param {BrowserWindow} win
 * @param {string} channel
 * @param {Promise<void>} abort
 * @param {number} timeoutMs
 */
function waitFor(win, channel, abort, timeoutMs) {
  return new Promise((resolve) => {
    /** @param {Electron.IpcMainEvent} event */
    const onMessage = (event) => {
      if (!win.isDestroyed() && event.sender === win.webContents) finish();
    };
    const finish = () => {
      clearTimeout(timer);
      ipcMain.removeListener(channel, onMessage);
      win.removeListener('closed', finish);
      resolve(undefined);
    };
    const timer = setTimeout(finish, timeoutMs);
    ipcMain.on(channel, onMessage);
    win.once('closed', finish);
    abort.then(finish);
  });
}

/**
 * Plays one reminder across every monitor. One transparent window per
 * display is created up front and shown; the sprite is then sent through the
 * windows one after another in x order, so it appears to walk from monitor
 * to monitor. It pauses (idle sprite, banner pop, cry) only on the monitor
 * under the mouse cursor. Background music plays once for the whole scene on
 * that same monitor, so it carries on while the sprite crosses the others;
 * the sprite only enters once the music is actually playing.
 * Urgent scenes cross URGENT_PASSES times, reversing direction each pass, and
 * the last pass parks the sprite in the lower-right corner of the primary
 * monitor until the user dismisses it.
 * @param {ScenePayload} payload
 * @param {{ openDevTools: boolean, dismissed: Promise<void>, isDismissed: () => boolean }} ctx
 */
async function playScene(payload, ctx) {
  const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const primaryDisplay = screen.getPrimaryDisplay();
  const windows = screen.getAllDisplays().map((display) => ({
    display,
    win: createOverlayWindow(display, ctx.openDevTools),
  }));

  try {
    await Promise.all(windows.map((w) => whenReadyToShow(w.win)));
    for (const { win } of windows) {
      if (win.isDestroyed()) continue;
      win.setAlwaysOnTop(true, 'screen-saver'); // re-assert on show; Windows can drop it
      win.showInactive(); // never steal focus from the user's current window
    }
    const musicWin = windows.find((w) => w.display.id === activeDisplay.id)?.win;
    if (payload.music && musicWin && !musicWin.isDestroyed()) {
      musicWin.webContents.send('music:play', { url: payload.music, loop: payload.urgent });
      // Hold the sprite back until the track is audible so they start together.
      await waitFor(musicWin, 'music:started', ctx.dismissed, MUSIC_START_TIMEOUT_MS);
    }

    const passes = payload.urgent ? URGENT_PASSES : 1;
    // Urgent scenes alternate direction; pick the start so the last pass heads right, into the corner.
    /** @type {'ltr' | 'rtl'} */
    let direction = payload.urgent ? (passes % 2 ? 'ltr' : 'rtl') : payload.direction;
    for (let pass = 0; pass < passes && !ctx.isDismissed(); pass += 1) {
      const parkPass = payload.urgent && pass === passes - 1;
      const order = [...windows].sort((a, b) =>
        direction === 'ltr' ? a.display.bounds.x - b.display.bounds.x : b.display.bounds.x - a.display.bounds.x,
      );
      for (const [i, { display, win }] of order.entries()) {
        if (ctx.isDismissed() || win.isDestroyed()) break;
        const isActive = display.id === activeDisplay.id;
        const park = parkPass && display.id === primaryDisplay.id;
        /** @type {PassPayload} */
        const pass_ = {
          ...payload,
          direction,
          // Urgent scenes keep moving after the first pass so they read as an alarm.
          pause: isActive && (!payload.urgent || pass === 0),
          park,
          // On the parking pass the cry is saved for when the sprite settles in the corner.
          playCry: parkPass ? park : isActive,
          fadeOut: !payload.urgent && i === order.length - 1,
        };
        win.webContents.send('scene:play', pass_);
        // A parked sprite never finishes its pass; monitors further right are skipped.
        if (park) break;
        await waitFor(win, 'scene:done', ctx.dismissed, PASS_TIMEOUT_MS);
      }
      direction = direction === 'ltr' ? 'rtl' : 'ltr';
    }
    if (payload.urgent) await ctx.dismissed;

    /** @type {Promise<unknown>[]} */
    const fades = [];
    if (payload.urgent) {
      // Dismissed (mid-pass or while parked): let every window fade before tearing down.
      const live = windows.filter((w) => !w.win.isDestroyed());
      for (const { win } of live) win.webContents.send('scene:stop');
      fades.push(...live.map((w) => waitFor(w.win, 'scene:done', NEVER, STOP_GRACE_MS)));
    }
    if (payload.music && musicWin && !musicWin.isDestroyed()) {
      musicWin.webContents.send('music:stop');
      fades.push(waitFor(musicWin, 'music:done', NEVER, STOP_GRACE_MS));
    }
    await Promise.all(fades);
  } finally {
    for (const { win } of windows) if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * Serial queue so overlapping reminders never stack windows, plus the
 * dismiss signal shared by the tray menu and the on-screen button.
 * @param {{ openDevTools?: boolean }} [options]
 */
function createOverlayQueue(options = {}) {
  /** @type {ScenePayload[]} */
  const pending = [];
  let running = false;
  /** @type {{ promise: Promise<void>, resolve: () => void, done: boolean, payload: ScenePayload } | null} */
  let current = null;

  function dismiss() {
    if (current && !current.done) {
      current.done = true;
      current.resolve();
    }
  }

  // The Dismiss button in any overlay window.
  ipcMain.on('scene:dismiss', dismiss);
  // The Join / Open invite button. The renderer never sends a URL: main opens
  // the link of the scene it is playing, then ends the reminder.
  ipcMain.on('scene:join', () => {
    const url = safeHttpsUrl(current?.payload.meetingLink?.url);
    if (url) void shell.openExternal(url);
    dismiss();
  });
  // The renderer toggles click-through while the cursor is over the Dismiss button.
  ipcMain.on('overlay:clickable', (event, /** @type {boolean} */ clickable) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!clickable, { forward: true });
  });

  async function drain() {
    if (running) return;
    running = true;
    while (pending.length) {
      const next = /** @type {ScenePayload} */ (pending.shift());
      /** @type {() => void} */
      let resolve = () => {};
      const promise = new Promise((r) => {
        resolve = () => r(undefined);
      });
      current = { promise, resolve, done: false, payload: next };
      const ctx = {
        openDevTools: Boolean(options.openDevTools),
        dismissed: promise,
        isDismissed: () => Boolean(current?.done),
      };
      try {
        await playScene(next, ctx);
      } catch (err) {
        console.error('Overlay scene failed:', err);
      }
      current = null;
    }
    running = false;
  }

  return {
    /** @param {ScenePayload} payload */
    enqueue(payload) {
      pending.push(payload);
      void drain();
    },
    /** Stops the scene that is playing now (urgent loops end here). */
    dismiss,
    isPlaying: () => current !== null,
  };
}

module.exports = { createOverlayQueue };
