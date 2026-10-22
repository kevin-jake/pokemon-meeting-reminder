// @ts-check
'use strict';
const path = require('node:path');
const { app, clipboard, dialog, shell, safeStorage, powerMonitor, Notification } = require('electron');
const { createTray } = require('./tray');
const { createOverlayQueue } = require('./overlay');
const { createSettings } = require('./settings');
const { mediaDir } = require('./media');
const { pickSpecies, buildScene, speciesByGen } = require('./species');
const { createSecureStore } = require('./secure-store');
const { createGoogleAccounts } = require('./calendar/google-accounts');
const { createRegistry } = require('./calendar/registry');
const { createBrowserBridge, toastReminder, newPairingToken, pairingCode } = require('./calendar/browser-bridge');
const { createReminderScheduler } = require('../shared/reminder-scheduler');
const { createPoller, mergeTitles } = require('./poller');
const { loadBuiltInClients, resolveGoogleClient } = require('./oauth-clients');

const APP_ID = 'com.kevinc.pokemon-meeting-reminder';
const openDevTools = process.argv.includes('--devtools');
// `--species=charizard` forces who appears in test scenes (handy for checking flyers / left-facing GIFs).
const forcedSpecies = process.argv.find((a) => a.startsWith('--species='))?.slice('--species='.length) || null;

/**
 * Button target for a reminder: the first meeting's video call, else its
 * calendar invite. A merged reminder ("Standup + 1 more") links the first one.
 * @param {import('./calendar/types').CalendarEvent[]} events
 * @returns {import('./overlay').MeetingLink | null}
 */
function meetingLinkOf([first]) {
  if (first?.joinUrl) return { url: first.joinUrl, kind: 'join' };
  if (first?.link) return { url: first.link, kind: 'invite' };
  return null;
}

/** The unpacked browser extension, for Edge / Chrome "Load unpacked". */
function extensionDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'browser-extension')
    : path.join(app.getAppPath(), 'browser-extension');
}

const GOOGLE_SETUP = [
  'Google Calendar needs an OAuth client of your own (free):',
  '',
  '1. console.cloud.google.com → create a project → enable "Google Calendar API".',
  '2. OAuth consent screen: External, add yourself as a test user.',
  '3. Credentials → Create OAuth client ID → Application type "Desktop app".',
  '4. Paste its client ID and secret into settings.json under "google" (clientId, clientSecret), then Connect Google again.',
  '',
  'Or set PMR_GOOGLE_CLIENT_ID / PMR_GOOGLE_CLIENT_SECRET in the environment.',
  'To build it into the app for everyone you share it with, put them in src/main/oauth-clients.local.json instead (format documented in oauth-clients.js).',
].join('\n');

// One tray icon only: a second launch pings the first instance and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);

  /** @type {ReturnType<typeof createTray> | null} */
  let tray = null;

  app.on('second-instance', () => {
    tray?.notify('Pokémon Meeting Reminder is already running in the tray.');
  });

  // Tray-only app: subscribing to this event stops Electron from quitting
  // when the last overlay window is destroyed.
  app.on('window-all-closed', () => {});

  app.whenReady().then(() => {
    const settings = createSettings();
    const overlays = createOverlayQueue({ openDevTools });
    const builtInClients = loadBuiltInClients();
    const store = createSecureStore({ dir: path.join(app.getPath('userData'), 'secrets'), safeStorage });

    const google = createGoogleAccounts({
      getConfig: () => {
        const g = settings.get().google;
        return { ...g, ...resolveGoogleClient(g, process.env, builtInClients) };
      },
      store,
      openExternal: (url) => shell.openExternal(url),
    });
    if (!settings.get().browserBridge.token) settings.update({ browserBridge: { ...settings.get().browserBridge, token: newPairingToken() } });
    const bridge = createBrowserBridge({
      getConfig: () => settings.get().browserBridge,
      onMeetingsChanged: () => void poller.pollNow(),
      onToast: (toast) => {
        if (!settings.get().browserBridge.toastReminders) return;
        const reminder = toastReminder(toast, poller.events(), Date.now());
        if (reminder) playReminder(reminder.title, reminder.minutesUntil);
      },
      onPortChanged: (port) => settings.update({ browserBridge: { ...settings.get().browserBridge, port } }),
    });
    const registry = createRegistry(() => [...google.sources(), bridge.source]);
    const scheduler = createReminderScheduler({ alertMinutes: settings.get().alertMinutesBefore });

    /**
     * Plays one reminder scene.
     * @param {string} meetingTitle
     * @param {number} minutesUntil  0 = the meeting is starting now (urgent: parks until dismissed)
     * @param {{ species?: string | null, meetingLink?: import('./overlay').MeetingLink | null }} [opts]
     *   species overrides the favorite; meetingLink adds the Join / Open invite button
     */
    function playReminder(meetingTitle, minutesUntil, { species = null, meetingLink = null } = {}) {
      const prefs = settings.get();
      const pick = pickSpecies({ ...prefs, favoriteSpecies: species ?? prefs.favoriteSpecies });
      overlays.enqueue(buildScene(pick, { meetingTitle, minutesUntil, mediaDir: mediaDir(), meetingLink }));
    }

    /** Test scenes get an "Open invite" button that opens Google Calendar. @param {number} minutesUntil */
    const playTest = (minutesUntil) =>
      playReminder('Test meeting', minutesUntil, {
        species: forcedSpecies,
        meetingLink: { url: 'https://calendar.google.com/', kind: 'invite' },
      });

    function syncPrefs() {
      const { favoriteSpecies, forceShiny } = settings.get();
      tray?.setPrefs({ favoriteSpecies, forceShiny });
    }

    function accounts() {
      return registry
        .sources()
        .filter((s) => s.isEnabled() && s !== bridge.source)
        .map((s) => ({ id: s.id, provider: 'google', name: s.name, state: s.state(), label: s.accountLabel() }));
    }
    const syncAccounts = () => tray?.setAccounts(accounts());

    const poller = createPoller({
      registry,
      scheduler,
      getSettings: () => settings.get(),
      onStatus: (text) => {
        tray?.setBrowserBridge(bridge.statusLabel());
        tray?.setStatus(text);
      },
      onSourcesChanged: () => {
        syncAccounts();
        for (const s of registry.sources()) {
          if (s.state() === 'reconnect') {
            tray?.notify(`${s.name} sign-in expired for ${s.accountLabel() ?? 'an account'}. Reconnect it from the tray menu.`);
          }
        }
      },
      onReminders: (due, now) => {
        // Meetings starting now first: they loop until dismissed and matter most.
        for (const kind of /** @type {const} */ (['start', 'warn'])) {
          const group = due.filter((d) => d.kind === kind);
          if (!group.length) continue;
          const title = mergeTitles(group.map((d) => d.event.title));
          const minutesUntil =
            kind === 'start' ? 0 : Math.max(1, Math.round((group[0].event.start.getTime() - now) / 60_000));
          playReminder(title, minutesUntil, { meetingLink: meetingLinkOf(group.map((d) => d.event)) });
          if (settings.get().nativeNotification && Notification.isSupported()) {
            new Notification({
              title: kind === 'start' ? `${title} is starting now` : `${title} in ${minutesUntil} min`,
              silent: true,
            }).show();
          }
        }
      },
    });

    /**
     * Runs a browser sign-in (new account or reconnect) and reports the outcome.
     * @param {(onStarted: () => void) => Promise<import('./calendar/types').CalendarSource | undefined>} signIn
     */
    async function runSignIn(signIn) {
      if (!google.isConfigured()) {
        settings.update({}); // make sure settings.json exists before offering to open it
        const { response } = await dialog.showMessageBox({
          type: 'info',
          title: 'Connect Google',
          message: 'Google is not set up yet',
          detail: GOOGLE_SETUP,
          buttons: ['Open settings file', 'Close'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) void shell.openPath(settings.file);
        return;
      }
      try {
        // onStarted shows the "waiting for browser sign-in…" row.
        const source = await signIn(syncAccounts);
        const who = source?.accountLabel();
        tray?.notify(`Google connected${who ? ` as ${who}` : ''}.`);
      } catch (err) {
        console.warn('Google sign-in failed:', err);
        const message = err instanceof Error ? err.message : String(err);
        if (message !== 'Sign-in cancelled') dialog.showErrorBox('Could not connect Google', message);
      }
      syncAccounts();
      void poller.pollNow();
    }

    /** @param {string} id */
    async function disconnect(id) {
      await google.remove(id);
      syncAccounts();
      void poller.pollNow();
    }

    tray = createTray(
      {
        onTestReminder: () => playTest(5),
        onTestMeetingNow: () => playTest(0),
        onDismiss: () => overlays.dismiss(),
        onPickFavorite: (key) => {
          settings.update({ favoriteSpecies: key });
          syncPrefs();
          // Preview the new pick right away (Random previews a random one).
          playTest(5);
        },
        onToggleShiny: (on) => {
          settings.update({ forceShiny: on });
          syncPrefs();
        },
        onAddAccount: () => void runSignIn((onStarted) => google.add(onStarted)),
        onReconnect: (id) =>
          void runSignIn(async (onStarted) => {
            await google.reconnect(id, onStarted);
            return google.find(id);
          }),
        onDisconnect: (id) => void disconnect(id),
        onCancelConnect: (id) => google.find(id)?.cancelConnect(),
        onCopyPairingCode: () => {
          clipboard.writeText(pairingCode(bridge.port(), settings.get().browserBridge.token));
          tray?.notify('Pairing code copied. Paste it into the extension options page in Edge / Chrome.');
        },
        onOpenExtensionFolder: () => void shell.openPath(extensionDir()),
        onClearBrowserMeetings: () => {
          void bridge.source.disconnect().then(() => poller.pollNow());
        },
        onQuit: () => app.quit(),
      },
      {
        speciesByGen: speciesByGen(),
        prefs: { favoriteSpecies: settings.get().favoriteSpecies, forceShiny: settings.get().forceShiny },
        accounts: accounts(),
        browserBridge: bridge.statusLabel(),
      },
    );

    void bridge.start().then(() => tray?.setBrowserBridge(bridge.statusLabel()));
    app.on('before-quit', () => bridge.stop());
    poller.start();
    // Timers drift or stall across sleep; catch up on anything missed as soon as the user is back.
    powerMonitor.on('resume', () => void poller.pollNow());
    powerMonitor.on('unlock-screen', () => void poller.pollNow());
    app.on('before-quit', () => poller.stop());

    // `npm start -- --test` / `--test-now` play a reminder right away (handy while iterating on scenes).
    if (process.argv.includes('--test')) playTest(5);
    if (process.argv.includes('--test-now')) playTest(0);
  });
}
