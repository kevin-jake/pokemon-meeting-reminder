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
 * @property {(providerId: string) => void} onAddAccount  e.g. 'google'
 * @property {(sourceId: string) => void} onReconnect
 * @property {(sourceId: string) => void} onDisconnect
 * @property {(sourceId: string) => void} onCancelConnect
 * @property {() => void} onCopyPairingCode       browser extension pairing code → clipboard
 * @property {() => void} onOpenExtensionFolder   for "Load unpacked" in Edge / Chrome
 * @property {() => void} onClearBrowserMeetings
 * @property {() => void} onQuit
 */

/**
 * One calendar account row in the menu.
 * @typedef {object} TrayAccount
 * @property {string} id
 * @property {string} provider  e.g. 'google'
 * @property {string} name      provider display name
 * @property {import('./calendar/types').SourceState} state
 * @property {string | null} label  signed-in account, e.g. an email address
 */

/**
 * @typedef {object} TrayPrefs
 * @property {string | null} favoriteSpecies
 * @property {boolean} forceShiny
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
  return `#${String(e.dex).padStart(3, '0')} ${e.name}`;
}

/** Calendar providers that get an "Add … account" item. */
const PROVIDERS = [{ id: 'google', name: 'Google' }];

/**
 * One submenu per connected account.
 * @param {TrayAccount} a
 * @param {TrayHandlers} handlers
 * @returns {Electron.MenuItemConstructorOptions}
 */
function accountItem(a, handlers) {
  const who = a.label ?? 'account';
  const disconnect = { label: 'Disconnect', click: () => handlers.onDisconnect(a.id) };
  switch (a.state) {
    case 'connecting':
      return {
        label: `${a.name}: waiting for browser sign-in…`,
        submenu: [{ label: 'Cancel sign-in', click: () => handlers.onCancelConnect(a.id) }],
      };
    case 'reconnect':
      return {
        label: `${a.name}: ${who} ⚠ sign-in expired`,
        submenu: [{ label: 'Reconnect…', click: () => handlers.onReconnect(a.id) }, disconnect],
      };
    default:
      return { label: `${a.name}: ${who}`, submenu: [disconnect] };
  }
}

/**
 * Account rows followed by "Connect Google…" (no account yet) or
 * "Add another Google account…".
 * @param {TrayAccount[]} accounts
 * @param {TrayHandlers} handlers
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function accountItems(accounts, handlers) {
  return PROVIDERS.flatMap((p) => {
    const mine = accounts.filter((a) => a.provider === p.id);
    return [
      ...mine.map((a) => accountItem(a, handlers)),
      {
        label: mine.length ? `Add another ${p.name} account…` : `Connect ${p.name}…`,
        click: () => handlers.onAddAccount(p.id),
      },
    ];
  });
}

/**
 * Outlook / Teams (browser): N meetings captured ▸ pairing and setup helpers.
 * @param {string | null} label  null when the bridge is switched off
 * @param {TrayHandlers} handlers
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function browserBridgeItems(label, handlers) {
  if (!label) return [];
  return [
    {
      label,
      submenu: [
        { label: 'Copy pairing code', click: handlers.onCopyPairingCode },
        { label: 'Open extension folder (Load unpacked)', click: handlers.onOpenExtensionFolder },
        { label: 'Forget captured meetings', click: handlers.onClearBrowserMeetings },
      ],
    },
  ];
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
 * @param {{ speciesByGen: Array<[number, ManifestEntry[]]>, prefs: TrayPrefs, accounts: TrayAccount[], browserBridge: string | null }} init
 */
function createTray(handlers, init) {
  const tray = new Tray(loadTrayIcon());
  tray.setToolTip('Pokémon Meeting Reminder');
  let status = 'Starting…';
  let prefs = init.prefs;
  /** @type {TrayAccount[]} */
  let accounts = init.accounts;
  let browserBridge = init.browserBridge;

  function rebuild() {
    const favorite = init.speciesByGen.flatMap(([, list]) => list).find((e) => e.key === prefs.favoriteSpecies);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: status, enabled: false },
        { type: 'separator' },
        ...accountItems(accounts, handlers),
        ...browserBridgeItems(browserBridge, handlers),
        { type: 'separator' },
        { label: 'Dismiss reminder', click: handlers.onDismiss },
        { type: 'separator' },
        { label: 'Test reminder (5 min warning)', click: handlers.onTestReminder },
        { label: 'Test reminder (meeting now)', click: handlers.onTestMeetingNow },
        {
          label: `Favorite Pokémon: ${favorite ? favorite.name : 'Random'}${prefs.forceShiny ? ' ✨' : ''}`,
          submenu: favoriteSubmenu(init.speciesByGen, prefs, handlers),
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
    /** @param {string | null} label */
    setBrowserBridge(label) {
      if (label === browserBridge) return;
      browserBridge = label;
      rebuild();
    },
    /** @param {string} content */
    notify(content) {
      tray.displayBalloon({ title: 'Pokémon Meeting Reminder', content, iconType: 'info' });
    },
  };
}

module.exports = { createTray };
