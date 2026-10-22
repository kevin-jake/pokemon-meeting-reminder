// @ts-check
'use strict';
const { randomBytes } = require('node:crypto');
const { createGoogleSource } = require('./google');
const { createAccountList } = require('./accounts');

/** Single-account builds stored their tokens here; migrated on startup. */
const LEGACY_SECRET = 'google';

/**
 * Every connected Google account (see accounts.js), stored as `google-<key>`.
 * @param {object} deps
 * @param {Parameters<typeof createGoogleSource>[0]['getConfig']} deps.getConfig
 * @param {Parameters<typeof createGoogleSource>[0]['store'] & { list(prefix: string): string[] }} deps.store
 * @param {(url: string) => Promise<void>} deps.openExternal
 * @param {typeof fetch} [deps.fetchFn]
 * @param {() => string} [deps.newKey]
 */
function createGoogleAccounts({ getConfig, store, openExternal, fetchFn, newKey = () => randomBytes(4).toString('hex') }) {
  const legacy = store.get(LEGACY_SECRET);
  if (legacy) {
    store.set(`google-${newKey()}`, legacy);
    store.delete(LEGACY_SECRET);
  }
  return createAccountList({
    provider: 'google',
    store,
    newKey,
    isConfigured: () => Boolean(getConfig().clientId),
    make: (id, secretName) => createGoogleSource({ getConfig, store, openExternal, fetchFn, id, secretName }),
  });
}

module.exports = { createGoogleAccounts };
