// @ts-check
'use strict';
const path = require('node:path');
const { app, Tray, Menu, nativeImage } = require('electron');

/**
 * @typedef {object} TrayHandlers
 * @property {() => void} onTestReminder      5-minute warning scene
 * @property {() => void} onTestMeetingNow    meeting-start scene (loops until dismissed)
 * @property {() => void} onDismiss
 * @property {() => void} onOpenSettings      accounts, Pokémon, browser profiles… live in the Settings window
 * @property {() => void} onQuit
 */

/** Builds the 16 px tray image with a 32 px representation for 200% scaling. */
function loadTrayIcon() {
  const dir = path.join(app.getAppPath(), 'assets', 'tray');
  const icon = nativeImage.createFromPath(path.join(dir, 'pokeball-16.png'));
  const big = nativeImage.createFromPath(path.join(dir, 'pokeball-32.png'));
  icon.addRepresentation({ scaleFactor: 2, buffer: big.toPNG() });
  return icon;
}

/**
 * Creates the tray icon. The menu only carries the status line and the few
 * things worth reaching without a window; it is rebuilt when the status changes.
 * @param {TrayHandlers} handlers
 */
function createTray(handlers) {
  const tray = new Tray(loadTrayIcon());
  let status = 'Starting…';

  function rebuild() {
    tray.setToolTip(`Pokémon Meeting Reminder\n${status}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: status, enabled: false },
        { type: 'separator' },
        { label: 'Dismiss reminder', click: handlers.onDismiss },
        {
          label: 'Test reminder',
          submenu: [
            { label: '5 min warning', click: handlers.onTestReminder },
            { label: 'Meeting now', click: handlers.onTestMeetingNow },
          ],
        },
        { type: 'separator' },
        { label: 'Settings…', click: handlers.onOpenSettings },
        { label: 'Quit', click: handlers.onQuit },
      ]),
    );
  }

  // Left click opens the same menu as right click; double click goes straight to Settings.
  tray.on('click', () => tray.popUpContextMenu());
  tray.on('double-click', handlers.onOpenSettings);
  rebuild();

  return {
    /** @param {string} text */
    setStatus(text) {
      if (text === status) return;
      status = text;
      rebuild();
    },
    /** @param {string} content */
    notify(content) {
      tray.displayBalloon({ title: 'Pokémon Meeting Reminder', content, iconType: 'info' });
    },
  };
}

module.exports = { createTray };
