// @ts-check
'use strict';
const { randomBytes } = require('node:crypto');
const { createIcalSource, normalizeFeedUrl } = require('./ical');

const PREFIX = 'ical-';

/** @typedef {ReturnType<typeof createIcalSource>} IcalSource */

/**
 * Every subscribed calendar link, one source each. Like Google accounts they
 * are discovered from the secure store (`ical-<key>` entries).
 * @param {object} deps
 * @param {() => { enabled: boolean, refreshMinutes: number }} deps.getConfig
 * @param {Parameters<typeof createIcalSource>[0]['store'] & { list(prefix: string): string[] }} deps.store
 * @param {typeof fetch} [deps.fetchFn]
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.newKey]
 */
function createIcalAccounts({ getConfig, store, fetchFn, now, newKey = () => randomBytes(4).toString('hex') }) {
  /** @param {string} key */
  const make = (key) => createIcalSource({ id: `ical:${key}`, secretName: `${PREFIX}${key}`, store, getConfig, fetchFn, now });

  /** @type {IcalSource[]} */
  let list = store
    .list(PREFIX)
    .map((name) => make(name.slice(PREFIX.length)))
    .filter((s) => s.state() !== 'disconnected');

  /** @param {string} id */
  const find = (id) => list.find((s) => s.id === id);

  /** @param {string} text */
  function urlOrThrow(text) {
    const url = normalizeFeedUrl(text);
    if (!url) throw new Error('That is not a calendar link (expected an https:// or webcal:// address ending in .ics).');
    return url;
  }

  return {
    sources: () => [...list],
    find,

    /**
     * Subscribes to a link after checking that it serves a calendar. Adding a
     * link that is already subscribed returns the existing entry.
     * @param {string} text  the pasted link
     */
    async add(text) {
      const url = urlOrThrow(text);
      const existing = list.find((s) => s.feedUrl() === url);
      if (existing) return existing;
      const source = make(newKey());
      source.setUrl(url);
      try {
        await source.verify();
      } catch (err) {
        await source.disconnect();
        throw err;
      }
      list.push(source);
      return source;
    },

    /**
     * Points an entry at a new link (e.g. after the old one was reset). The
     * old link is kept when the new one does not work.
     * @param {string} id
     * @param {string} text
     */
    async replace(id, text) {
      const source = find(id);
      if (!source) throw new Error('That calendar link is no longer in the list.');
      const url = urlOrThrow(text);
      const probe = make(`probe-${newKey()}`);
      probe.setUrl(url);
      try {
        await probe.verify();
      } finally {
        await probe.disconnect();
      }
      source.setUrl(url);
      return source;
    },

    /** @param {string} id */
    async remove(id) {
      const source = find(id);
      if (!source) return;
      list = list.filter((s) => s !== source);
      await source.disconnect();
    },
  };
}

module.exports = { createIcalAccounts };
