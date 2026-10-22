// @ts-check
'use strict';
const path = require('node:path');
const { app, dialog, shell, safeStorage, powerMonitor, Notification } = require('electron');
const { createTray } = require('./tray');
const { createOverlayQueue } = require('./overlay');
const { createSettings } = require('./settings');
const { mediaDir } = require('./media');
const { pickSpecies, buildScene, speciesByGen } = require('./species');
const { createSecureStore } = require('./secure-store');
const { createGoogleSource } = require('./calendar/google');
const { createRegistry } = require('./calendar/registry');
const { createReminderScheduler } = require('../shared/reminder-scheduler');
const { createPoller, mergeTitles } = require('./poller');
const { loadBuiltInClients, resolveGoogleClient } = require('./oauth-clients');

const APP_ID = 'com.kevinc.pokemon-meeting-reminder';
const openDevTools = process.argv.includes('--devtools');
// `--species=charizard` forces who appears in test scenes (handy for checking flyers / left-facing GIFs).
const forcedSpecies = process.argv.find((a) => a.startsWith('--species='))?.slice('--species='.length) || null;

const GOOGLE_SETUP = [
  'Google Calendar needs an OAuth client of your own (free):',
  '',
  '1. console.cloud.google.com → create a project → enable "Google Calendar API".',
  '2. OAuth consent screen: External, add yourself as a test user.',
  '3. Credentials → Create OAuth client ID → Application type "Desktop app".',
  '4. Paste its client ID and secret into settings.json under "google" (clientId, clientSecret), then Connect Google again.',
  '',
  'Or set PMR_GOOGLE_CLIENT_ID / PMR_GOOGLE_CLIENT_SECRET in the environment.',
  'To build it into the app for everyone you share it with, put them in src/main/oauth-clients.local.json instead (see oauth-clients.example.json).',
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

    const google = createGoogleSource({
      getConfig: () => {
        const g = settings.get().google;
        return { ...g, ...resolveGoogleClient(g, process.env, builtInClients) };
      },
      store,
      openExternal: (url) => shell.openExternal(url),
    });
    const registry = createRegistry([google]);
    const scheduler = createReminderScheduler({ alertMinutes: settings.get().alertMinutesBefore });

    /**
     * Plays one reminder scene.
     * @param {string} meetingTitle
     * @param {number} minutesUntil  0 = the meeting is starting now (urgent: parks until dismissed)
     * @param {string | null} [species]  overrides the favorite
     */
    function playReminder(meetingTitle, minutesUntil, species = null) {
      const prefs = settings.get();
      const pick = pickSpecies({ ...prefs, favoriteSpecies: species ?? prefs.favoriteSpecies });
      overlays.enqueue(buildScene(pick, { meetingTitle, minutesUntil, mediaDir: mediaDir() }));
    }

    /** @param {number} minutesUntil */
    const playTest = (minutesUntil) => playReminder('Test meeting', minutesUntil, forcedSpecies);

    function syncPrefs() {
      const { favoriteSpecies, forceShiny } = settings.get();
      tray?.setPrefs({ favoriteSpecies, forceShiny });
    }

    function accounts() {
      return registry.sources
        .filter((s) => s.isEnabled())
        .map((s) => ({ id: s.id, name: s.name, state: s.state(), label: s.accountLabel() }));
    }
    const syncAccounts = () => tray?.setAccounts(accounts());

    const poller = createPoller({
      registry,
      scheduler,
      getSettings: () => settings.get(),
      onStatus: (text) => tray?.setStatus(text),
      onSourcesChanged: () => {
        syncAccounts();
        for (const s of registry.sources) {
          if (s.state() === 'reconnect') tray?.notify(`${s.name} sign-in expired. Use "Reconnect ${s.name}…" in the tray menu.`);
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
          playReminder(title, minutesUntil);
          if (settings.get().nativeNotification && Notification.isSupported()) {
            new Notification({
              title: kind === 'start' ? `${title} is starting now` : `${title} in ${minutesUntil} min`,
              silent: true,
            }).show();
          }
        }
      },
    });

    /** @param {string} id */
    async function connect(id) {
      const source = registry.sources.find((s) => s.id === id);
      if (!source) return;
      if (!source.isConfigured()) {
        settings.update({}); // make sure settings.json exists before offering to open it
        const { response } = await dialog.showMessageBox({
          type: 'info',
          title: `Connect ${source.name}`,
          message: `${source.name} is not set up yet`,
          detail: GOOGLE_SETUP,
          buttons: ['Open settings file', 'Close'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) void shell.openPath(settings.file);
        return;
      }
      const pending = source.connect();
      syncAccounts(); // shows "waiting for browser sign-in…"
      try {
        await pending;
        tray?.notify(`${source.name} connected${source.accountLabel() ? ` as ${source.accountLabel()}` : ''}.`);
      } catch (err) {
        console.warn(`${source.name} connect failed:`, err);
        const message = err instanceof Error ? err.message : String(err);
        if (message !== 'Sign-in cancelled') {
          dialog.showErrorBox(`Could not connect ${source.name}`, message);
        }
      }
      syncAccounts();
      void poller.pollNow();
    }

    /** @param {string} id */
    async function disconnect(id) {
      const source = registry.sources.find((s) => s.id === id);
      if (!source) return;
      await source.disconnect();
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
        onConnect: (id) => void connect(id),
        onDisconnect: (id) => void disconnect(id),
        onCancelConnect: (id) => registry.sources.find((s) => s.id === id)?.cancelConnect(),
        onQuit: () => app.quit(),
      },
      {
        speciesByGen: speciesByGen(),
        prefs: { favoriteSpecies: settings.get().favoriteSpecies, forceShiny: settings.get().forceShiny },
        accounts: accounts(),
      },
    );

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
