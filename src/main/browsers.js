// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { safeHttpsUrl } = require('./calendar/meeting-links');

/**
 * One browser profile links can be opened in. Chromium browsers list their
 * profiles in `<User Data>/Local State` and pick one with
 * `--profile-directory=<dir>`, so the same meeting can open in the profile
 * that is signed in to the account it came from.
 * @typedef {object} BrowserProfile
 * @property {string} id          '<browser>:<profileDir>', what settings store
 * @property {string} browser     'chrome' | 'edge' | 'brave'
 * @property {string} exe         full path of the browser executable
 * @property {string} profileDir  'Default', 'Profile 1', …
 * @property {string} name        the profile's display name
 * @property {string | null} email  the Google / Microsoft account the profile is signed in to, when known
 * @property {string} label       for menus: 'Chrome · Work (me@example.com)'
 */

/** Chromium browsers we know how to find on Windows. Paths are relative to %LOCALAPPDATA% / Program Files. */
const BROWSERS = [
  { id: 'chrome', name: 'Chrome', userData: 'Google\\Chrome\\User Data', exe: 'chrome.exe', appDir: 'Google\\Chrome\\Application' },
  { id: 'edge', name: 'Edge', userData: 'Microsoft\\Edge\\User Data', exe: 'msedge.exe', appDir: 'Microsoft\\Edge\\Application' },
  { id: 'brave', name: 'Brave', userData: 'BraveSoftware\\Brave-Browser\\User Data', exe: 'brave.exe', appDir: 'BraveSoftware\\Brave-Browser\\Application' },
];

/** @typedef {(typeof BROWSERS)[number]} BrowserDef */

/**
 * Profiles from a parsed `Local State` file. `Default` comes first, the rest
 * in name order. Profiles whose entry is malformed are skipped.
 * @param {any} localState
 * @param {BrowserDef} browser
 * @param {string} exe
 * @returns {BrowserProfile[]}
 */
function parseLocalState(localState, browser, exe) {
  const cache = localState?.profile?.info_cache;
  if (!cache || typeof cache !== 'object') return [];
  /** @type {BrowserProfile[]} */
  const out = [];
  for (const [profileDir, info] of Object.entries(cache)) {
    if (!info || typeof info !== 'object') continue;
    const name = String(/** @type {any} */ (info).name ?? '').trim() || profileDir;
    const email = String(/** @type {any} */ (info).user_name ?? '').trim() || null;
    out.push({
      id: `${browser.id}:${profileDir}`,
      browser: browser.id,
      exe,
      profileDir,
      name,
      email,
      label: `${browser.name} · ${name}${email && email !== name ? ` (${email})` : ''}`,
    });
  }
  return out.sort((a, b) => (a.profileDir === 'Default' ? -1 : b.profileDir === 'Default' ? 1 : a.name.localeCompare(b.name)));
}

/**
 * `reg query` for an App Paths entry (how Windows itself finds chrome.exe & co).
 * @param {string} exe
 * @returns {Promise<string | null>}
 */
function regAppPath(exe) {
  /** @param {string} hive */
  const query = (hive) =>
    new Promise((resolve) => {
      execFile('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'], (err, stdout) => {
        const m = !err && stdout.match(/REG_SZ\s+(.+?)\s*$/m);
        resolve(m ? m[1].trim() : null);
      });
    });
  return query('HKLM').then((p) => p ?? query('HKCU'));
}

/**
 * Every profile of every installed Chromium browser. A browser counts as
 * installed when both its executable and its `Local State` exist.
 * @param {object} [deps]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {(p: string) => boolean} [deps.exists]
 * @param {(p: string) => string} [deps.readFile]
 * @param {(exe: string) => Promise<string | null>} [deps.appPath]  registry fallback for the executable
 * @returns {Promise<BrowserProfile[]>}
 */
async function discoverBrowsers({ env = process.env, exists = fs.existsSync, readFile = (p) => fs.readFileSync(p, 'utf8'), appPath = regAppPath } = {}) {
  const localAppData = env.LOCALAPPDATA ?? '';
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], localAppData].filter((r) => Boolean(r));
  /** @type {BrowserProfile[]} */
  const profiles = [];
  for (const browser of BROWSERS) {
    const localState = path.join(localAppData, browser.userData, 'Local State');
    if (!localAppData || !exists(localState)) continue;
    let exe = roots.map((r) => path.join(/** @type {string} */ (r), browser.appDir, browser.exe)).find((p) => exists(p)) ?? null;
    if (!exe) exe = await appPath(browser.exe).catch(() => null);
    if (!exe || !exists(exe)) continue;
    try {
      profiles.push(...parseLocalState(JSON.parse(readFile(localState)), browser, exe));
    } catch (err) {
      console.warn(`${browser.name}: could not read its profile list:`, err);
    }
  }
  return profiles;
}

/**
 * The profile to open links of `sourceId` in: its own mapping, else the
 * default profile, else null (system default browser). Mappings that point
 * at a profile that no longer exists fall through the same way.
 * @param {{ defaultBrowser: string | null, accountBrowsers: Record<string, string | null> }} settings
 * @param {BrowserProfile[]} profiles
 * @param {string | null | undefined} sourceId
 */
function resolveProfile(settings, profiles, sourceId) {
  /** @param {string | null | undefined} id */
  const find = (id) => (id ? profiles.find((p) => p.id === id) : undefined);
  return find(sourceId ? settings.accountBrowsers[sourceId] : null) ?? find(settings.defaultBrowser) ?? null;
}

/** @param {BrowserProfile} profile @param {string} url */
const launchArgs = (profile, url) => [`--profile-directory=${profile.profileDir}`, url];

/**
 * Opens an https link in the given profile, or in the system default browser
 * when there is none (or its executable has gone). Anything that is not a
 * plain https URL is refused, since event fields come from whoever sent the
 * invite.
 * @param {unknown} url
 * @param {BrowserProfile | null} profile
 * @param {object} [deps]
 * @param {(url: string) => Promise<void>} [deps.openExternal]
 * @param {typeof spawn} [deps.spawnFn]
 * @param {(p: string) => boolean} [deps.exists]
 */
async function openUrl(url, profile, { openExternal, spawnFn = spawn, exists = fs.existsSync } = {}) {
  const safe = safeHttpsUrl(url);
  if (!safe) return;
  if (!profile || !exists(profile.exe)) {
    await (openExternal ?? require('electron').shell.openExternal)(safe);
    return;
  }
  const child = spawnFn(profile.exe, launchArgs(profile, safe), { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', (err) => console.warn(`Could not start ${profile.label}:`, err));
  child.unref();
}

module.exports = { BROWSERS, parseLocalState, discoverBrowsers, resolveProfile, launchArgs, openUrl };
