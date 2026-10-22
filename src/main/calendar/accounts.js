// @ts-check
'use strict';
const { randomBytes } = require('node:crypto');

/** @typedef {import('./types').CalendarSource} CalendarSource */

/**
 * Every connected account of one provider, one CalendarSource each. Accounts
 * are discovered from the secure store (`<provider>-<key>` entries), so there
 * is no separate list to keep in sync. Source ids are `<provider>:<key>`.
 * Connecting an account that is already present replaces the older entry.
 * @param {object} deps
 * @param {string} deps.provider  e.g. 'google'
 * @param {{ delete(name: string): void, list(prefix: string): string[] }} deps.store
 * @param {(id: string, secretName: string) => CalendarSource} deps.make
 * @param {() => boolean} deps.isConfigured
 * @param {() => string} [deps.newKey]
 */
function createAccountList({ provider, store, make, isConfigured, newKey = () => randomBytes(4).toString('hex') }) {
  const prefix = `${provider}-`;
  /** @param {string} key */
  const makeKey = (key) => make(`${provider}:${key}`, `${prefix}${key}`);
  /** @param {CalendarSource} s */
  const secretOf = (s) => `${prefix}${s.id.slice(provider.length + 1)}`;

  // Entries that no longer decrypt load as 'disconnected'; leave them out.
  /** @type {CalendarSource[]} */
  let list = store
    .list(prefix)
    .map((name) => makeKey(name.slice(prefix.length)))
    .filter((s) => s.state() !== 'disconnected');

  /** @param {string} id */
  const find = (id) => list.find((s) => s.id === id);

  /**
   * After `source` signs in, drop any other entry for the same account. Its
   * secret is only deleted, not revoked: revoking would also kill the fresh
   * tokens, which belong to the same grant.
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
    isConfigured,
    find,

    /**
     * Signs in a new account. Its row shows "waiting for browser sign-in…"
     * until it settles; a failed or cancelled sign-in leaves nothing behind.
     * @param {() => void} [onStarted]  called once the pending row exists
     */
    async add(onStarted) {
      const source = makeKey(newKey());
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

    /** Disconnects (and, where the provider supports it, revokes) one account. @param {string} id */
    async remove(id) {
      const source = find(id);
      if (!source) return;
      list = list.filter((s) => s !== source);
      await source.disconnect();
    },
  };
}

module.exports = { createAccountList };
