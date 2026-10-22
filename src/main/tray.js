// @ts-check
'use strict';
const path = require('node:path');
const { app, Tray, Menu, nativeImage } = require('electron');

/**
 * @typedef {object} TrayHandlers
 * @property {() => void} onTestReminder      5-minute warning scene
 * @property {() => void} onTestMeetingNow    meeting-start scene (loops until dismissed)
 * @property {() => void} onDismiss
 * @property {() => void} onOpenSettings      adding accounts, Pokémon, browser profiles… live in the Settings window
 * @property {(sourceId: string) => void} onReconnect
 * @property {(sourceId: string) => void} onDisconnect
 * @property {(sourceId: string) => void} onCancelConnect
 * @property {(sourceId: string) => void} onCopySignInLink  pending browser sign-in URL → clipboard
 * @property {() => void} onQuit
 */

/**
 * One calendar account row in the menu.
 * @typedef {object} TrayAccount
 * @property {string} id
 * @property {string} provider  'google' | 'ical'
 * @property {string} name      provider display name
 * @property {import('./calendar/types').SourceState} state
 * @property {string | null} label  signed-in account, e.g. an email address
 */

/**
 * Accounts ▸ one submenu per connected account (its state and the actions it
 * allows), then "Add account…" which opens Settings.
 * @param {TrayAccount[]} accounts
 * @param {TrayHandlers} handlers
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function accountItems(accounts, handlers) {
  return accounts.map((a) => {
    const who = a.label ?? 'account';
    const disconnect = { label: 'Disconnect', click: () => handlers.onDisconnect(a.id) };
    switch (a.state) {
      case 'connecting':
        return {
          label: `${a.name}: waiting for browser sign-in…`,
          submenu: [
            { label: 'Copy sign-in link', click: () => handlers.onCopySignInLink(a.id) },
            { label: 'Cancel sign-in', click: () => handlers.onCancelConnect(a.id) },
          ],
        };
      case 'reconnect': {
        const isLink = a.provider === 'ical';
        return {
          label: `${a.name}: ${who} ⚠ ${isLink ? 'link stopped working' : 'sign-in expired'}`,
          submenu: [
            { label: isLink ? 'Replace with link from clipboard…' : 'Reconnect…', click: () => handlers.onReconnect(a.id) },
            disconnect,
          ],
        };
      }
      default:
        return { label: `${a.name}: ${who}`, submenu: [disconnect] };
    }
  });
}

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
 * @param {{ accounts: TrayAccount[] }} init
 */
function createTray(handlers, init) {
  const tray = new Tray(loadTrayIcon());
  let status = 'Starting…';
  let accounts = init.accounts;

  function rebuild() {
    tray.setToolTip(`Pokémon Meeting Reminder\n${status}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: status, enabled: false },
        { type: 'separator' },
        {
          label: accounts.length ? `Accounts (${accounts.length})` : 'Accounts: none connected',
          submenu: [
            ...accountItems(accounts, handlers),
            ...(accounts.length ? [{ type: /** @type {const} */ ('separator') }] : []),
            { label: 'Add account…', click: handlers.onOpenSettings },
          ],
        },
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
    /** @param {TrayAccount[]} next */
    setAccounts(next) {
      accounts = next;
      rebuild();
    },
    /** @param {string} content */
    notify(content) {
      tray.displayBalloon({ title: 'Pokémon Meeting Reminder', content, iconType: 'info' });
    },
  };
}

module.exports = { createTray };
