// @ts-check
'use strict';
const path = require('node:path');
const { app, clipboard, dialog, shell, safeStorage, powerMonitor, Notification } = require('electron');
const { createTray } = require('./tray');
const { createOverlayQueue } = require('./overlay');
const { createSettings } = require('./settings');
const { createSettingsWindow } = require('./settings-window');
const { discoverBrowsers, resolveProfile, openUrl } = require('./browsers');
const { mediaDir } = require('./media');
const { pickSpecies, buildScene, speciesByGen } = require('./species');
const { openSecureStore } = require('./secure-store');
const { createGoogleAccounts } = require('./calendar/google-accounts');
const { createIcalAccounts } = require('./calendar/ical-accounts');
const { normalizeFeedUrl, maskFeedUrl } = require('./calendar/ical');
const { createRegistry } = require('./calendar/registry');
const { createBrowserBridge, toastReminder, newPairingToken, pairingCode } = require('./calendar/browser-bridge');
const { createReminderScheduler } = require('../shared/reminder-scheduler');
const { createTitleFilter } = require('../shared/ignored-meetings');
const { createPoller, mergeTitles } = require('./poller');
const { loadBuiltInClients, resolveGoogleClient } = require('./oauth-clients');

const APP_ID = 'com.kevinc.pokemon-meeting-reminder';
const openDevTools = process.argv.includes('--devtools');
// `--species=charizard` forces who appears in test scenes (handy for checking flyers / left-facing GIFs).
const forcedSpecies = process.argv.find((a) => a.startsWith('--species='))?.slice('--species='.length) || null;

/**
 * Button target for a reminder: the first meeting's video call, else its
 * calendar invite. A merged reminder ("Standup + 1 more") links the first one.
 * The source id picks the browser profile the link opens in.
 * @param {import('./calendar/types').CalendarEvent[]} events
 * @returns {import('./overlay').MeetingLink | null}
 */
function meetingLinkOf([first]) {
  if (first?.joinUrl) return { url: first.joinUrl, kind: 'join', source: first.source };
  if (first?.link) return { url: first.link, kind: 'invite', source: first.source };
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
  '4. Paste its client ID and secret into settings.json under "google" (clientId, clientSecret), then Add Google account again.',
  '',
  'Or set PMR_GOOGLE_CLIENT_ID / PMR_GOOGLE_CLIENT_SECRET in the environment.',
  'To build it into the app for everyone you share it with, put them in src/main/oauth-clients.local.json instead (format documented in oauth-clients.js).',
].join('\n');

const ICAL_SETUP = [
  'Copy your calendar\'s private iCal link, then choose "Add calendar link from clipboard…" again.',
  '',
  'Google Calendar: Settings → Settings for my calendars → (your calendar) → Integrate calendar → "Secret address in iCal format" → copy.',
  'Outlook on the web: Settings → Calendar → Shared calendars → Publish a calendar → "Can view all details" → Publish → copy the ICS link.',
  '',
  'No sign-in is needed. The link is stored encrypted on this PC and checked every few minutes.',
  'Anyone who has the link can read that calendar: if it leaks, reset it in Google / Outlook and add the new one.',
].join('\n');

/** @param {string} id */
const isIcalId = (id) => id.startsWith('ical:');

// One tray icon only: a second launch pings the first instance and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);

  /** @type {ReturnType<typeof createTray> | null} */
  let tray = null;
  /** @type {ReturnType<typeof createSettingsWindow> | null} */
  let settingsWindow = null;

  app.on('second-instance', () => {
    tray?.notify('Pokémon Meeting Reminder is already running in the tray.');
    settingsWindow?.open();
  });

  // Tray-only app: subscribing to this event stops Electron from quitting
  // when the last overlay / settings window is closed.
  app.on('window-all-closed', () => {});

  app.whenReady().then(async () => {
    const settings = createSettings();
    const builtInClients = loadBuiltInClients();
    const store = await openSecureStore({ dir: path.join(app.getPath('userData'), 'secrets'), safeStorage });
    // Secrets are written in the background: hold the quit until they are on disk.
    let flushed = false;
    app.on('before-quit', (e) => {
      if (flushed) return;
      e.preventDefault();
      flushed = true;
      void store.flush().finally(() => app.quit());
    });

    /** Browser profiles found on this PC; refreshed from Settings. */
    let profiles = await discoverBrowsers();
    /**
     * Opens an https link in the profile mapped to `sourceId` (or the default
     * profile, or the system default browser).
     * @param {string} url
     * @param {string | null} sourceId
     */
    const openInProfile = (url, sourceId) => openUrl(url, resolveProfile(settings.get(), profiles, sourceId));

    const overlays = createOverlayQueue({ openDevTools, openLink: (link) => void openInProfile(link.url, link.source) });

    const google = createGoogleAccounts({
      getConfig: () => {
        const g = settings.get().google;
        return { ...g, ...resolveGoogleClient(g, process.env, builtInClients) };
      },
      store,
      // Reconnects open the sign-in page in the account's own profile.
      openExternal: openInProfile,
    });
    if (!settings.get().browserBridge.token) settings.update({ browserBridge: { ...settings.get().browserBridge, token: newPairingToken() } });
    const bridge = createBrowserBridge({
      getConfig: () => settings.get().browserBridge,
      onMeetingsChanged: () => void poller.pollNow(),
      onToast: (toast) => {
        if (!settings.get().browserBridge.toastReminders) return;
        const reminder = toastReminder(toast, poller.events(), Date.now());
        if (reminder && !createTitleFilter(settings.get().ignoredTitles)(reminder.title)) playReminder(reminder.title, reminder.minutesUntil);
      },
      onPortChanged: (port) => settings.update({ browserBridge: { ...settings.get().browserBridge, port } }),
    });
    const icals = createIcalAccounts({ getConfig: () => settings.get().ical, store });
    const registry = createRegistry(() => [...google.sources(), ...icals.sources(), bridge.source]);
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
        meetingLink: { url: 'https://calendar.google.com/', kind: 'invite', source: null },
      });

    function accounts() {
      return registry
        .sources()
        .filter((s) => s.isEnabled() && s !== bridge.source)
        .map((s) => ({ id: s.id, provider: isIcalId(s.id) ? 'ical' : 'google', name: s.name, state: s.state(), label: s.accountLabel() }));
    }
    const syncAccounts = () => settingsWindow?.notify();

    let lastStatus = '';
    const poller = createPoller({
      registry,
      scheduler,
      getSettings: () => settings.get(),
      onStatus: (text) => {
        tray?.setStatus(text);
        // The bridge row changes with the status; only re-render the page when something did.
        const status = `${text}\n${bridge.statusLabel()}`;
        if (status !== lastStatus) {
          lastStatus = status;
          settingsWindow?.notify();
        }
      },
      onSourcesChanged: () => {
        syncAccounts();
        for (const s of registry.sources()) {
          if (s.state() === 'reconnect') {
            tray?.notify(
              isIcalId(s.id)
                ? `The calendar link for ${s.accountLabel() ?? 'a calendar'} stopped working. Copy the new link and replace it in Settings.`
                : `${s.name} sign-in expired for ${s.accountLabel() ?? 'an account'}. Reconnect it in Settings.`,
            );
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

    /** Message boxes hang off the Settings window while it is open. @param {Electron.MessageBoxOptions} opts */
    const messageBox = (opts) => {
      const parent = settingsWindow?.current();
      return parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
    };
    /** @param {string} title @param {unknown} err */
    const errorBox = (title, err) => dialog.showErrorBox(title, err instanceof Error ? err.message : String(err));

    /**
     * Runs a browser sign-in (new account or reconnect) and reports the outcome.
     * @param {(onStarted: () => void) => Promise<import('./calendar/types').CalendarSource | undefined>} signIn
     */
    async function runSignIn(signIn) {
      if (!google.isConfigured()) {
        settings.update({}); // make sure settings.json exists before offering to open it
        const { response } = await messageBox({
          type: 'info',
          title: 'Add Google account',
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

    /**
     * Adds a Google account, signing in through the chosen browser profile,
     * which then becomes the profile its meeting links open in.
     * @param {string | null} profileId
     */
    const addGoogle = (profileId) =>
      runSignIn(async (onStarted) => {
        const profile = profiles.find((p) => p.id === profileId) ?? null;
        const source = await google.add(onStarted, profile ? (url) => openUrl(url, profile) : undefined);
        if (profile) settings.update({ accountBrowsers: { [source.id]: profile.id } });
        return source;
      });

    /**
     * Adds the calendar link on the clipboard, or swaps it in for `replaceId`
     * (a link that stopped working). Asks first, showing the link with its
     * secret part masked, and clears the clipboard afterwards so the link is
     * not pasted somewhere by accident.
     * (Electron 45's clipboard is async, modelled on navigator.clipboard.)
     * @param {string} [replaceId]
     */
    async function addCalendarLink(replaceId) {
      try {
        const copied = (await clipboard.readText()).trim();
        const url = normalizeFeedUrl(copied);
        if (!url) {
          await messageBox({ type: 'info', title: 'Add calendar link', message: 'Copy the calendar link first', detail: ICAL_SETUP });
          return;
        }
        const { response } = await messageBox({
          type: 'question',
          title: 'Add calendar link',
          message: replaceId ? 'Replace the calendar link with the one on the clipboard?' : 'Add the calendar link on the clipboard?',
          detail: `${maskFeedUrl(url)}\n\nIt is stored encrypted on this PC. Anyone who has this link can read the calendar, so don't share it.`,
          buttons: [replaceId ? 'Replace' : 'Add', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response !== 0) return;
        const source = replaceId ? await icals.replace(replaceId, url) : await icals.add(url);
        if ((await clipboard.readText()).trim() === copied) clipboard.clear();
        tray?.notify(`Calendar link ${replaceId ? 'replaced' : 'added'}: ${source.accountLabel() ?? 'calendar'}.`);
      } catch (err) {
        console.warn('Calendar link failed:', err);
        errorBox('Could not add the calendar link', err);
      }
      syncAccounts();
      void poller.pollNow();
    }

    /** @param {string} id */
    async function disconnect(id) {
      await (isIcalId(id) ? icals.remove(id) : google.remove(id));
      settings.update({ accountBrowsers: { [id]: null } });
      syncAccounts();
      void poller.pollNow();
    }

    /** @param {string} text @param {string} done @param {string} failed */
    const copy = (text, done, failed) =>
      clipboard
        .writeText(text)
        .then(() => tray?.notify(done))
        .catch((err) => errorBox(failed, err));

    /**
     * Everything the Settings page (and the tray) can trigger. Long flows run
     * in the background; their outcome shows up as a balloon or a dialog.
     * @type {Record<string, (arg: any) => void>}
     */
    const actions = {
      testReminder: (minutes) => playTest(Number(minutes) === 0 ? 0 : 5),
      dismiss: () => overlays.dismiss(),
      addGoogle: (profileId) => void addGoogle(typeof profileId === 'string' ? profileId : null),
      addIcal: () => void addCalendarLink(),
      reconnect: (id) => {
        if (typeof id !== 'string') return;
        void (isIcalId(id)
          ? addCalendarLink(id)
          : runSignIn(async (onStarted) => {
              await google.reconnect(id, onStarted);
              return google.find(id);
            }));
      },
      disconnect: (id) => void (typeof id === 'string' && disconnect(id)),
      cancelConnect: (id) => void (typeof id === 'string' && google.find(id)?.cancelConnect()),
      copySignInLink: (id) => {
        const url = typeof id === 'string' ? google.find(id)?.signInUrl?.() : null;
        if (url) void copy(url, 'Sign-in link copied. Paste it into the browser where you want to sign in to Google.', 'Could not copy the sign-in link');
      },
      copyPairingCode: () =>
        void copy(
          pairingCode(bridge.port(), settings.get().browserBridge.token),
          'Pairing code copied. Paste it into the extension options page in Edge / Chrome.',
          'Could not copy the pairing code',
        ),
      openExtensionFolder: () => void shell.openPath(extensionDir()),
      forgetBrowserMeetings: () => void bridge.source.disconnect().then(() => poller.pollNow()),
      openSettingsFile: () => {
        settings.update({});
        void shell.openPath(settings.file);
      },
      refreshBrowsers: () =>
        void discoverBrowsers().then((found) => {
          profiles = found;
          settingsWindow?.notify();
        }),
    };

    /** Applies "Launch at startup" to the Windows Run key (installed builds only). */
    function syncLoginItem() {
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.get().launchAtStartup });
    }

    settingsWindow = createSettingsWindow({
      openDevTools,
      getState: () => ({
        settings: settings.get(),
        accounts: accounts(),
        browserBridge: bridge.statusLabel(),
        profiles,
        speciesByGen: speciesByGen().map(([gen, list]) => [gen, list.map(({ key, name, dex }) => ({ key, name, dex }))]),
        isPackaged: app.isPackaged,
        googleConfigured: google.isConfigured(),
      }),
      update: (patch) => {
        const before = settings.get();
        const after = settings.update(patch);
        if ('launchAtStartup' in patch) syncLoginItem();
        // Preview the new pick right away (Random previews a random one).
        if ('favoriteSpecies' in patch) playTest(5);
        if (after.alertMinutesBefore !== before.alertMinutesBefore) void poller.pollNow();
        if ('ignoredTitles' in patch) poller.recheck();
        if (after.browserBridge.enabled !== before.browserBridge.enabled) {
          if (after.browserBridge.enabled) void bridge.start().then(() => poller.pollNow());
          else {
            bridge.stop();
            void poller.pollNow();
          }
        }
        settingsWindow?.notify();
      },
      action: (name, arg) => actions[name]?.(arg),
    });

    tray = createTray({
      onTestReminder: () => playTest(5),
      onTestMeetingNow: () => playTest(0),
      onDismiss: () => overlays.dismiss(),
      onOpenSettings: () => settingsWindow?.open(),
      onQuit: () => app.quit(),
    });

    syncLoginItem();
    void bridge.start().then(() => settingsWindow?.notify());
    app.on('before-quit', () => bridge.stop());
    poller.start();
    // Timers drift or stall across sleep; catch up on anything missed as soon as the user is back.
    powerMonitor.on('resume', () => void poller.pollNow());
    powerMonitor.on('unlock-screen', () => void poller.pollNow());
    app.on('before-quit', () => poller.stop());

    // `npm start -- --test` / `--test-now` play a reminder right away (handy while iterating on scenes).
    if (process.argv.includes('--test')) playTest(5);
    if (process.argv.includes('--test-now')) playTest(0);
    if (process.argv.includes('--settings')) settingsWindow.open();
  });
}
