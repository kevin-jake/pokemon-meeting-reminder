// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Built-in OAuth clients, so people the app is shared with can "Connect
 * Google…" / "Connect Microsoft 365…" without registering their own. The
 * values live in the git-ignored oauth-clients.local.json next to this file
 * and are bundled into the packaged app:
 *
 *   { "google": { "clientId": "<id>.apps.googleusercontent.com", "clientSecret": "<secret>" },
 *     "microsoft": { "clientId": "<azure-app-guid>" } }
 *
 * For
 * a Google "Desktop app" client the secret is not confidential (PKCE protects
 * the sign-in), but keeping it out of the public repo avoids leaked-credential
 * scanners revoking it. An Azure public client has no secret at all.
 *
 * @typedef {{ google: { clientId: string, clientSecret: string }, microsoft: { clientId: string } }} BuiltInClients
 */

const LOCAL_FILE = path.join(__dirname, 'oauth-clients.local.json');

/** @param {string} [file] @returns {BuiltInClients} */
function loadBuiltInClients(file = LOCAL_FILE) {
  /** @type {any} */
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') console.warn('oauth-clients.local.json unreadable:', err);
  }
  // Also accept the client_secret_….json that Google Cloud Console downloads as-is.
  const g = raw.google ?? { clientId: raw.installed?.client_id, clientSecret: raw.installed?.client_secret };
  const google = { clientId: String(g.clientId ?? ''), clientSecret: String(g.clientSecret ?? '') };
  const microsoft = { clientId: String(raw.microsoft?.clientId ?? '') };
  if (!google.clientId && !microsoft.clientId && Object.keys(raw).length) {
    console.warn(
      'oauth-clients.local.json has no client id: expected {"google":{"clientId",…},"microsoft":{"clientId"}} or Google\'s {"installed":{…}} download.',
    );
  }
  return { google, microsoft };
}

/**
 * Effective Google client: environment, then settings.json, then the built-in
 * client. The id and secret always come from the same place, so a custom id is
 * never paired with the built-in secret.
 * @param {{ clientId: string, clientSecret: string }} fromSettings
 * @param {NodeJS.ProcessEnv} env
 * @param {BuiltInClients} builtIn
 */
function resolveGoogleClient(fromSettings, env, builtIn) {
  if (env.PMR_GOOGLE_CLIENT_ID) return { clientId: env.PMR_GOOGLE_CLIENT_ID, clientSecret: env.PMR_GOOGLE_CLIENT_SECRET ?? '' };
  if (fromSettings.clientId) return { clientId: fromSettings.clientId, clientSecret: fromSettings.clientSecret };
  return { ...builtIn.google };
}

/**
 * Effective Microsoft (Azure app registration) client id: environment, then
 * settings.json, then the built-in client.
 * @param {{ clientId: string }} fromSettings
 * @param {NodeJS.ProcessEnv} env
 * @param {BuiltInClients} builtIn
 */
function resolveMicrosoftClient(fromSettings, env, builtIn) {
  return env.PMR_MS_CLIENT_ID || fromSettings.clientId || builtIn.microsoft.clientId;
}

module.exports = { loadBuiltInClients, resolveGoogleClient, resolveMicrosoftClient };
