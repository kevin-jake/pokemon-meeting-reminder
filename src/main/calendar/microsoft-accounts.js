// @ts-check
'use strict';
const { createMicrosoftSource } = require('./microsoft');
const { createAccountList } = require('./accounts');

/**
 * Every connected Microsoft account (see accounts.js), stored as
 * `microsoft-<key>`, each with its own MSAL token cache.
 * @param {object} deps
 * @param {Parameters<typeof createMicrosoftSource>[0]['getConfig']} deps.getConfig
 * @param {Parameters<typeof createMicrosoftSource>[0]['store'] & { list(prefix: string): string[] }} deps.store
 * @param {(url: string) => Promise<void>} deps.openExternal
 * @param {typeof fetch} [deps.fetchFn]
 * @param {Parameters<typeof createMicrosoftSource>[0]['createClient']} [deps.createClient]
 * @param {() => string} [deps.newKey]
 */
function createMicrosoftAccounts({ getConfig, store, openExternal, fetchFn, createClient, newKey }) {
  return createAccountList({
    provider: 'microsoft',
    store,
    newKey,
    isConfigured: () => Boolean(getConfig().clientId),
    make: (id, secretName) => createMicrosoftSource({ getConfig, store, openExternal, fetchFn, createClient, id, secretName }),
  });
}

module.exports = { createMicrosoftAccounts };
