// @ts-check
'use strict';
const path = require('node:path');
const { app, Tray, Menu, nativeImage } = require('electron');

/**
 * @typedef {object} TrayHandlers
 * @property {() => void} onTestReminder      5-minute warning scene
 * @property {() => void} onTestMeetingNow    meeting-start scene (loops until dismissed)
 * @property {() => void} onDismiss
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
 * Creates the tray icon. The menu is rebuilt whenever state changes.
 * @param {TrayHandlers} handlers
 */
function createTray(handlers) {
  const tray = new Tray(loadTrayIcon());
  tray.setToolTip('Pokémon Meeting Reminder');
  let status = 'Starting…';

  function rebuild() {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: status, enabled: false },
        { type: 'separator' },
        { label: 'Dismiss reminder', click: handlers.onDismiss },
        { type: 'separator' },
        { label: 'Test reminder (5 min warning)', click: handlers.onTestReminder },
        { label: 'Test reminder (meeting now)', click: handlers.onTestMeetingNow },
        { type: 'separator' },
        { label: 'Quit', click: handlers.onQuit },
      ]),
    );
  }

  // Left click opens the same menu as right click.
  tray.on('click', () => tray.popUpContextMenu());
  rebuild();

  return {
    /** @param {string} text */
    setStatus(text) {
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
