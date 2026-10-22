// @ts-check
'use strict';
const path = require('node:path');
const { app, Tray, Menu, nativeImage } = require('electron');

/** @typedef {import('../../scripts/build-manifest').ManifestEntry} ManifestEntry */

/**
 * @typedef {object} TrayHandlers
 * @property {() => void} onTestReminder      5-minute warning scene
 * @property {() => void} onTestMeetingNow    meeting-start scene (loops until dismissed)
 * @property {() => void} onDismiss
 * @property {(key: string | null) => void} onPickFavorite  null = random Pokémon
 * @property {(on: boolean) => void} onToggleShiny
 * @property {(on: boolean) => void} onToggleNotification
 * @property {(sourceId: string) => void} onConnect
 * @property {(sourceId: string) => void} onDisconnect
 * @property {(sourceId: string) => void} onCancelConnect
 * @property {() => void} onQuit
 */

/**
 * One calendar account row in the menu.
 * @typedef {object} TrayAccount
 * @property {string} id
 * @property {string} name
 * @property {import('./calendar/types').SourceState} state
 * @property {string | null} label  signed-in account, e.g. an email address
 */

/**
 * @typedef {object} TrayPrefs
 * @property {string | null} favoriteSpecies
 * @property {boolean} forceShiny
 * @property {boolean} nativeNotification  also show a clickable Windows notification
 */

/** Builds the 16 px tray image with a 32 px representation for 200% scaling. */
function loadTrayIcon() {
  const dir = path.join(app.getAppPath(), 'assets', 'tray');
  const icon = nativeImage.createFromPath(path.join(dir, 'pokeball-16.png'));
  const big = nativeImage.createFromPath(path.join(dir, 'pokeball-32.png'));
  icon.addRepresentation({ scaleFactor: 2, buffer: big.toPNG() });
  return icon;
}

/** @param {ManifestEntry} e */
function speciesLabel(e) {
  return `#${String(e.dex).padStart(3, '0')} ${e.name}${e.isFlyer ? ' (flies)' : ''}`;
}

/**
 * Connect / Disconnect rows for one calendar source.
 * @param {TrayAccount} a
 * @param {TrayHandlers} handlers
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function accountItems(a, handlers) {
  switch (a.state) {
    case 'connected':
      return [
        { label: `${a.name}: Connected${a.label ? ` as ${a.label}` : ''}`, enabled: false },
        { label: `Disconnect ${a.name}`, click: () => handlers.onDisconnect(a.id) },
      ];
    case 'connecting':
      return [
        { label: `${a.name}: waiting for browser sign-in…`, enabled: false },
        { label: `Cancel ${a.name} sign-in`, click: () => handlers.onCancelConnect(a.id) },
      ];
    case 'reconnect':
      return [
        { label: `Reconnect ${a.name}… (sign-in expired)`, click: () => handlers.onConnect(a.id) },
        { label: `Disconnect ${a.name}`, click: () => handlers.onDisconnect(a.id) },
      ];
    default:
      return [{ label: `Connect ${a.name}…`, click: () => handlers.onConnect(a.id) }];
  }
}

/**
 * Favorite Pokémon ▸ (•) Random | Always shiny | Gen 1 ▸ … Gen 5 ▸
 * Radio items in different submenus don't uncheck each other, but the whole
 * menu is rebuilt on every change, so `checked` is always computed fresh.
 * @param {Array<[number, ManifestEntry[]]>} speciesByGen
 * @param {TrayPrefs} prefs
 * @param {TrayHandlers} handlers
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function favoriteSubmenu(speciesByGen, prefs, handlers) {
  return [
    {
      label: 'Random',
      type: 'radio',
      checked: !prefs.favoriteSpecies,
      click: () => handlers.onPickFavorite(null),
    },
    {
      label: 'Always shiny',
      type: 'checkbox',
      checked: prefs.forceShiny,
      click: (item) => handlers.onToggleShiny(item.checked),
    },
    { type: 'separator' },
    ...speciesByGen.map(([gen, list]) => {
      const pinned = list.some((e) => e.key === prefs.favoriteSpecies);
      return /** @type {Electron.MenuItemConstructorOptions} */ ({
        label: `Gen ${gen}${pinned ? ' •' : ''}`,
        submenu: list.map((e) => ({
          label: speciesLabel(e),
          type: /** @type {const} */ ('radio'),
          checked: e.key === prefs.favoriteSpecies,
          click: () => handlers.onPickFavorite(e.key),
        })),
      });
    }),
  ];
}

/**
 * Creates the tray icon. The menu is rebuilt whenever state changes.
 * @param {TrayHandlers} handlers
 * @param {{ speciesByGen: Array<[number, ManifestEntry[]]>, prefs: TrayPrefs, accounts: TrayAccount[] }} init
 */
function createTray(handlers, init) {
  const tray = new Tray(loadTrayIcon());
  tray.setToolTip('Pokémon Meeting Reminder');
  let status = 'Starting…';
  let prefs = init.prefs;
  /** @type {TrayAccount[]} */
  let accounts = init.accounts;

  function rebuild() {
    const favorite = init.speciesByGen.flatMap(([, list]) => list).find((e) => e.key === prefs.favoriteSpecies);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: status, enabled: false },
        { type: 'separator' },
        ...accounts.flatMap((a) => accountItems(a, handlers)),
        { type: 'separator' },
        { label: 'Dismiss reminder', click: handlers.onDismiss },
        { type: 'separator' },
        { label: 'Test reminder (5 min warning)', click: handlers.onTestReminder },
        { label: 'Test reminder (meeting now)', click: handlers.onTestMeetingNow },
        {
          label: `Favorite Pokémon: ${favorite ? favorite.name : 'Random'}${prefs.forceShiny ? ' ✨' : ''}`,
          submenu: favoriteSubmenu(init.speciesByGen, prefs, handlers),
        },
        {
          label: 'Show Windows notification too (click to join)',
          type: 'checkbox',
          checked: prefs.nativeNotification,
          click: (item) => handlers.onToggleNotification(item.checked),
        },
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
    /** @param {TrayPrefs} next */
    setPrefs(next) {
      prefs = next;
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
