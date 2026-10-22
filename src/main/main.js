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
const { createGoogleAccounts } = require('./calendar/google-accounts');
const { createMicrosoftAccounts } = require('./calendar/microsoft-accounts');
const { createRegistry } = require('./calendar/registry');
const { createReminderScheduler } = require('../shared/reminder-scheduler');
const { createPoller, mergeTitles } = require('./poller');
const { loadBuiltInClients, resolveGoogleClient, resolveMicrosoftClient } = require('./oauth-clients');

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

const MICROSOFT_SETUP = [
  'Microsoft 365 / Outlook needs an Azure app registration of your own (free):',
  '',
  '1. portal.azure.com → Microsoft Entra ID → App registrations → New registration.',
  '   Supported account types: "Any organizational directory and personal Microsoft accounts".',
  '2. Authentication → Add a platform → "Mobile and desktop applications" → custom redirect URI http://localhost.',
  '   Under Advanced settings set "Allow public client flows" to Yes.',
  '3. API permissions → Microsoft Graph → Delegated → Calendars.Read.',
  '4. Paste the Application (client) ID into settings.json under "microsoft" (clientId), then Connect Microsoft 365 again.',
  '',
  'Or set PMR_MS_CLIENT_ID in the environment.',
  'To build it into the app for everyone you share it with, put it in src/main/oauth-clients.local.json instead (format documented in oauth-clients.js).',
  'Work accounts may need an admin to approve the app the first time.',
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
    const microsoft = createMicrosoftAccounts({
      getConfig: () => {
        const m = settings.get().microsoft;
        return { ...m, clientId: resolveMicrosoftClient(m, process.env, builtInClients) };
      },
      store,
      openExternal: (url) => shell.openExternal(url),
    });
    /** Account lists by provider id, with what the setup dialog needs. */
    const providers = {
      google: { accounts: google, name: 'Google', setup: GOOGLE_SETUP },
      microsoft: { accounts: microsoft, name: 'Microsoft 365', setup: MICROSOFT_SETUP },
    };
    /** Source ids are `<provider>:<key>`. @param {string} id */
    const providerOf = (id) => providers[/** @type {keyof typeof providers} */ (id.split(':')[0])];
    const registry = createRegistry(() => [...google.sources(), ...microsoft.sources()]);
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
        .filter((s) => s.isEnabled())
        .map((s) => ({ id: s.id, provider: s.id.split(':')[0], name: s.name, state: s.state(), label: s.accountLabel() }));
    }
    const syncAccounts = () => tray?.setAccounts(accounts());

    const poller = createPoller({
      registry,
      scheduler,
      getSettings: () => settings.get(),
      onStatus: (text) => tray?.setStatus(text),
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
     * @param {typeof providers[keyof typeof providers]} provider
     * @param {(onStarted: () => void) => Promise<import('./calendar/types').CalendarSource | undefined>} signIn
     */
    async function runSignIn(provider, signIn) {
      const { name } = provider;
      if (!provider.accounts.isConfigured()) {
        settings.update({}); // make sure settings.json exists before offering to open it
        const { response } = await dialog.showMessageBox({
          type: 'info',
          title: `Connect ${name}`,
          message: `${name} is not set up yet`,
          detail: provider.setup,
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
        tray?.notify(`${name} connected${who ? ` as ${who}` : ''}.`);
      } catch (err) {
        console.warn(`${name} sign-in failed:`, err);
        const message = err instanceof Error ? err.message : String(err);
        if (message !== 'Sign-in cancelled') dialog.showErrorBox(`Could not connect ${name}`, message);
      }
      syncAccounts();
      void poller.pollNow();
    }

    /** @param {string} id */
    async function disconnect(id) {
      await providerOf(id)?.accounts.remove(id);
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
        onAddAccount: (providerId) => {
          const provider = providerOf(providerId);
          if (provider) void runSignIn(provider, (onStarted) => provider.accounts.add(onStarted));
        },
        onReconnect: (id) => {
          const provider = providerOf(id);
          if (!provider) return;
          void runSignIn(provider, async (onStarted) => {
            await provider.accounts.reconnect(id, onStarted);
            return provider.accounts.find(id);
          });
        },
        onDisconnect: (id) => void disconnect(id),
        onCancelConnect: (id) => providerOf(id)?.accounts.find(id)?.cancelConnect(),
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
