// @ts-check
'use strict';
const { randomBytes } = require('node:crypto');
const { createGoogleSource } = require('./google');

/** @typedef {import('./types').CalendarSource} CalendarSource */

/** Single-account builds stored their tokens here; migrated on startup. */
const LEGACY_SECRET = 'google';
const PREFIX = 'google-';

/**
 * Every connected Google account, one CalendarSource each. Accounts are
 * discovered from the secure store (`google-<key>` entries), so there is no
 * separate list to keep in sync. Connecting an account that is already
 * present replaces the older entry.
 * @param {object} deps
 * @param {Parameters<typeof createGoogleSource>[0]['getConfig']} deps.getConfig
 * @param {Parameters<typeof createGoogleSource>[0]['store'] & { list(prefix: string): string[] }} deps.store
 * @param {(url: string) => Promise<void>} deps.openExternal
 * @param {typeof fetch} [deps.fetchFn]
 * @param {() => string} [deps.newKey]
 */
function createGoogleAccounts({ getConfig, store, openExternal, fetchFn, newKey = () => randomBytes(4).toString('hex') }) {
  /** @param {string} key */
  const make = (key) =>
    createGoogleSource({ getConfig, store, openExternal, fetchFn, id: `google:${key}`, secretName: `${PREFIX}${key}` });
  /** @param {CalendarSource} s */
  const secretOf = (s) => `${PREFIX}${s.id.slice('google:'.length)}`;

  const legacy = store.get(LEGACY_SECRET);
  if (legacy) {
    store.set(`${PREFIX}${newKey()}`, legacy);
    store.delete(LEGACY_SECRET);
  }

  // Entries that no longer decrypt load as 'disconnected'; leave them out.
  /** @type {CalendarSource[]} */
  let list = store
    .list(PREFIX)
    .map((name) => make(name.slice(PREFIX.length)))
    .filter((s) => s.state() !== 'disconnected');

  /** @param {string} id */
  const find = (id) => list.find((s) => s.id === id);

  /**
   * After `source` signs in, drop any other entry for the same Google account.
   * Its secret is only deleted, not revoked: revoking at Google would also
   * kill the fresh tokens, which belong to the same grant.
   * @param {CalendarSource} source
   */
  function dropDuplicatesOf(source) {
    const label = source.accountLabel()?.toLowerCase();
    if (!label) return;
    for (const other of list) {
      if (other !== source && other.accountLabel()?.toLowerCase() === label) {
        other.cancelConnect();
        store.delete(secretOf(other));
      }
    }
    list = list.filter((s) => s === source || s.accountLabel()?.toLowerCase() !== label);
  }

  return {
    /** Accounts in the order they were added (pending sign-ins included). */
    sources: () => [...list],
    isConfigured: () => Boolean(getConfig().clientId),
    find,

    /**
     * Signs in a new account. Its row shows "waiting for browser sign-in…"
     * until it settles; a failed or cancelled sign-in leaves nothing behind.
     * @param {() => void} [onStarted]  called once the pending row exists
     */
    async add(onStarted) {
      const source = make(newKey());
      list.push(source);
      const pending = source.connect();
      onStarted?.();
      try {
        await pending;
      } catch (err) {
        list = list.filter((s) => s !== source);
        store.delete(secretOf(source));
        throw err;
      }
      dropDuplicatesOf(source);
      return source;
    },

    /**
     * Signs an existing entry in again (e.g. after "sign-in expired").
     * @param {string} id
     * @param {() => void} [onStarted]
     */
    async reconnect(id, onStarted) {
      const source = find(id);
      if (!source) return;
      const pending = source.connect();
      onStarted?.();
      await pending;
      dropDuplicatesOf(source);
    },

    /** Disconnects (and revokes) one account. @param {string} id */
    async remove(id) {
      const source = find(id);
      if (!source) return;
      list = list.filter((s) => s !== source);
      await source.disconnect();
    },
  };
}

module.exports = { createGoogleAccounts };
