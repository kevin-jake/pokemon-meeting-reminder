// @ts-check
'use strict';
const { app } = require('electron');
const { createTray } = require('./tray');
const { createOverlayQueue } = require('./overlay');
const { createSettings } = require('./settings');
const { mediaDir } = require('./media');
const { pickSpecies, buildScene, speciesByGen } = require('./species');

const APP_ID = 'com.kevinc.pokemon-meeting-reminder';
const openDevTools = process.argv.includes('--devtools');
// `--species=charizard` forces who appears in test scenes (handy for checking flyers / left-facing GIFs).
const forcedSpecies = process.argv.find((a) => a.startsWith('--species='))?.slice('--species='.length) || null;

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

    /**
     * Test scenes stand in for real meetings until the calendar sources land (M3/M4).
     * @param {number} minutesUntil  0 = the meeting is starting now (urgent: three passes, then parks until dismissed)
     */
    function playTest(minutesUntil) {
      const prefs = settings.get();
      const pick = pickSpecies({ ...prefs, favoriteSpecies: forcedSpecies ?? prefs.favoriteSpecies });
      overlays.enqueue(buildScene(pick, { meetingTitle: 'Test meeting', minutesUntil, mediaDir: mediaDir() }));
    }

    function syncPrefs() {
      const { favoriteSpecies, forceShiny } = settings.get();
      tray?.setPrefs({ favoriteSpecies, forceShiny });
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
        onQuit: () => app.quit(),
      },
      {
        speciesByGen: speciesByGen(),
        prefs: { favoriteSpecies: settings.get().favoriteSpecies, forceShiny: settings.get().forceShiny },
      },
    );
    tray.setStatus('Next: calendar not connected yet');
    // `npm start -- --test` / `--test-now` play a reminder right away (handy while iterating on scenes).
    if (process.argv.includes('--test')) playTest(5);
    if (process.argv.includes('--test-now')) playTest(0);
  });
}
