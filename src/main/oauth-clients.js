// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Built-in OAuth clients, so people the app is shared with can "Connect
 * Google…" without registering their own. The values live in the git-ignored
 * oauth-clients.local.json next to this file (see oauth-clients.example.json)
 * and are bundled into the packaged app. For a Google "Desktop app" client
 * the secret is not confidential (PKCE protects the sign-in), but keeping it
 * out of the public repo avoids leaked-credential scanners revoking it.
 *
 * @typedef {{ google: { clientId: string, clientSecret: string } }} BuiltInClients
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
  return {
    google: { clientId: String(raw.google?.clientId ?? ''), clientSecret: String(raw.google?.clientSecret ?? '') },
  };
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

module.exports = { loadBuiltInClients, resolveGoogleClient };
