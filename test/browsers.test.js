// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { BROWSERS, parseLocalState, discoverBrowsers, resolveProfile, launchArgs, openUrl } = require('../src/main/browsers');

const chrome = BROWSERS[0];
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** Shaped like the real file: most profiles carry no signed-in email. */
const LOCAL_STATE = {
  profile: {
    info_cache: {
      'Profile 7': { name: 'Velmie', user_name: '', gaia_name: '' },
      Default: { name: 'mtmgroup.io', user_name: 'kevin.c@mtmgroup.io', gaia_name: 'Kevin' },
      'Profile 6': { name: 'Terragon', user_name: '' },
      'Profile 9': null,
    },
  },
};

test('parseLocalState lists profiles, Default first, with labels', () => {
  const profiles = parseLocalState(LOCAL_STATE, chrome, CHROME_EXE);
  assert.deepEqual(
    profiles.map((p) => [p.id, p.profileDir, p.label, p.email]),
    [
      ['chrome:Default', 'Default', 'Chrome · mtmgroup.io (kevin.c@mtmgroup.io)', 'kevin.c@mtmgroup.io'],
      ['chrome:Profile 6', 'Profile 6', 'Chrome · Terragon', null],
      ['chrome:Profile 7', 'Profile 7', 'Chrome · Velmie', null],
    ],
  );
  assert.equal(profiles[0].exe, CHROME_EXE);
  assert.deepEqual(parseLocalState({}, chrome, CHROME_EXE), []);
});

test('discoverBrowsers skips browsers without an executable or profile list', async () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  const braveExe = path.join(env.LOCALAPPDATA, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe');
  const edgeExe = 'D:\\Edge\\msedge.exe'; // only findable through the registry
  const files = new Set([
    path.join(env.LOCALAPPDATA, 'Google\\Chrome\\User Data\\Local State'),
    CHROME_EXE,
    path.join(env.LOCALAPPDATA, 'BraveSoftware\\Brave-Browser\\User Data\\Local State'),
    braveExe,
    path.join(env.LOCALAPPDATA, 'Microsoft\\Edge\\User Data\\Local State'),
    edgeExe,
  ]);
  const profiles = await discoverBrowsers({
    env,
    exists: (p) => files.has(p),
    readFile: (p) => JSON.stringify(p.includes('Brave') ? { profile: { info_cache: { Default: { name: 'Personal' } } } } : LOCAL_STATE),
    appPath: async (exe) => (exe === 'msedge.exe' ? edgeExe : null),
  });
  assert.deepEqual(
    profiles.map((p) => [p.id, p.exe]),
    [
      ['chrome:Default', CHROME_EXE],
      ['chrome:Profile 6', CHROME_EXE],
      ['chrome:Profile 7', CHROME_EXE],
      ['edge:Default', edgeExe],
      ['edge:Profile 6', edgeExe],
      ['edge:Profile 7', edgeExe],
      ['brave:Default', braveExe],
    ],
  );

  // No Local State at all → nothing, even if executables exist.
  assert.deepEqual(await discoverBrowsers({ env, exists: (p) => p === CHROME_EXE, readFile: () => '{}', appPath: async () => null }), []);
});

test('resolveProfile prefers the account mapping, then the default, then null', () => {
  const profiles = parseLocalState(LOCAL_STATE, chrome, CHROME_EXE);
  const settings = { defaultBrowser: 'chrome:Profile 6', accountBrowsers: { 'google:aa': 'chrome:Profile 7', 'google:gone': 'edge:Default', 'google:cleared': null } };
  assert.equal(resolveProfile(settings, profiles, 'google:aa')?.id, 'chrome:Profile 7');
  assert.equal(resolveProfile(settings, profiles, 'google:bb')?.id, 'chrome:Profile 6');
  assert.equal(resolveProfile(settings, profiles, 'google:gone')?.id, 'chrome:Profile 6'); // mapped profile vanished
  assert.equal(resolveProfile(settings, profiles, 'google:cleared')?.id, 'chrome:Profile 6');
  assert.equal(resolveProfile(settings, profiles, null)?.id, 'chrome:Profile 6');
  assert.equal(resolveProfile({ defaultBrowser: null, accountBrowsers: {} }, profiles, 'google:aa'), null);
  assert.equal(resolveProfile({ defaultBrowser: 'edge:Default', accountBrowsers: {} }, profiles, null), null);
});

test('openUrl spawns the profile, falls back to the default browser, refuses non-https', async () => {
  const [profile] = parseLocalState(LOCAL_STATE, chrome, CHROME_EXE);
  /** @type {any[]} */
  const spawned = [];
  /** @type {string[]} */
  const external = [];
  const deps = {
    openExternal: async (/** @type {string} */ u) => void external.push(u),
    spawnFn: /** @type {any} */ ((/** @type {string} */ exe, /** @type {string[]} */ args) => {
      spawned.push([exe, args]);
      return { on() {}, unref() {} };
    }),
    exists: (/** @type {string} */ p) => p === CHROME_EXE,
  };
  await openUrl('https://meet.google.com/abc-defg-hij', profile, deps);
  assert.deepEqual(spawned, [[CHROME_EXE, ['--profile-directory=Default', 'https://meet.google.com/abc-defg-hij']]]);
  assert.deepEqual(launchArgs(profile, 'https://x.test/'), ['--profile-directory=Default', 'https://x.test/']);

  await openUrl('https://zoom.us/j/1', null, deps);
  await openUrl('https://zoom.us/j/2', { ...profile, exe: 'C:\\gone.exe' }, deps);
  assert.deepEqual(external, ['https://zoom.us/j/1', 'https://zoom.us/j/2']);

  await openUrl('file:///C:/Windows/notepad.exe', profile, deps);
  await openUrl('--incognito', profile, deps);
  await openUrl(undefined, profile, deps);
  assert.equal(spawned.length, 1);
  assert.equal(external.length, 2);
});
