// @ts-check
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');
const { createTray } = require('./tray');
const { createOverlayQueue } = require('./overlay');

const APP_ID = 'com.kevinc.pokemon-meeting-reminder';
const openDevTools = process.argv.includes('--devtools');

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
    const overlays = createOverlayQueue({ openDevTools });
    tray = createTray({
      onTestReminder: () => overlays.enqueue(buildTestScene(5)),
      onTestMeetingNow: () => overlays.enqueue(buildTestScene(0)),
      onDismiss: () => overlays.dismiss(),
      onQuit: () => app.quit(),
    });
    tray.setStatus('Next: calendar not connected yet');
    // `npm start -- --test` / `--test-now` play a reminder right away (handy while iterating on scenes).
    if (process.argv.includes('--test')) overlays.enqueue(buildTestScene(5));
    if (process.argv.includes('--test-now')) overlays.enqueue(buildTestScene(0));
  });
}

/**
 * M1: hardcoded Pikachu scene. M2 replaces this with species.pickSpecies().
 * @param {number} minutesUntil  0 = the meeting is starting now (urgent, loops until dismissed)
 * @returns {import('./overlay').ScenePayload}
 */
function buildTestScene(minutesUntil) {
  const shiny = Math.random() < 1 / 64;
  const variant = shiny ? 'shiny' : 'default';
  const mediaDir = path.join(app.getAppPath(), 'media');
  const spriteDir = path.join(mediaDir, 'gen1', 'pikachu');
  /** @param {string} state */
  const url = (state) => pathToFileURL(path.join(spriteDir, `${variant}_${state}_8fps.gif`)).href;
  return {
    species: 'pikachu',
    displayName: 'Pikachu',
    shiny,
    isFlyer: false,
    spriteSize: 32,
    spriteScale: 4,
    sprites: { walk: url('walk'), idle: url('idle'), walkLeft: null },
    // PokeAPI/cries files are keyed by National Dex number; Pikachu is 25.
    cry: pathToFileURL(path.join(mediaDir, 'cries', '25.ogg')).href,
    direction: Math.random() < 0.5 ? 'ltr' : 'rtl',
    meetingTitle: 'Test meeting',
    minutesUntil,
    urgent: minutesUntil <= 0,
  };
}
