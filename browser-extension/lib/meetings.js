// @ts-check
// The background worker's merged view of every meeting seen in any Outlook /
// Teams tab. Pages only ever show a slice of the calendar, so captures are
// merged by id instead of replacing each other.
// UMD: importScripts() in the service worker, require() in node tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).__pmrMeetings = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Meetings that ended this long ago are dropped. */
  const ENDED_GRACE_MS = 10 * 60_000;
  /** Meetings not seen again for this long are dropped (deleted in Outlook, most likely). */
  const UNSEEN_MS = 3 * 24 * 60 * 60_000;
  const MAX_MEETINGS = 500;

  /**
   * @typedef {object} Meeting
   * @property {string} id
   * @property {string} title
   * @property {string} start  ISO
   * @property {string} end    ISO
   * @property {string | null} joinUrl
   * @property {string | null} link     where "Open invite" goes
   * @property {string} origin
   * @property {number} seenAt
   */

  /** Calendar page for the site the meeting came from (Teams has no stable one). @param {string} origin */
  const calendarLinkOf = (origin) => (/^https:\/\/outlook\./.test(origin) ? `${origin}/calendar/view/day` : null);

  /**
   * Drops ended and long-unseen meetings, keeping at most MAX_MEETINGS (the soonest).
   * @param {Record<string, Meeting>} store
   * @param {number} now
   * @returns {Record<string, Meeting>}
   */
  function pruneMeetings(store, now) {
    const kept = Object.entries(store)
      .filter(([, m]) => Date.parse(m.end) > now - ENDED_GRACE_MS && m.seenAt > now - UNSEEN_MS)
      .sort(([, a], [, b]) => Date.parse(a.start) - Date.parse(b.start))
      .slice(0, MAX_MEETINGS);
    return Object.fromEntries(kept);
  }

  /**
   * Merges one capture into the store. Cancelled or declined copies remove the meeting.
   * @param {Record<string, Meeting>} store
   * @param {string} origin  site the capture came from
   * @param {Array<{ id: string, title: string, start: string, end: string, joinUrl?: string | null, cancelled?: boolean, declined?: boolean }>} items
   * @param {number} now
   */
  function mergeMeetings(store, origin, items, now) {
    /** @type {Record<string, Meeting>} */
    const next = { ...store };
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item.id !== 'string' || typeof item.title !== 'string') continue;
      const key = `${origin}|${item.id}`;
      if (item.cancelled || item.declined) {
        delete next[key];
        continue;
      }
      next[key] = {
        id: key,
        title: item.title.slice(0, 200),
        start: item.start,
        end: item.end,
        joinUrl: item.joinUrl ?? null,
        link: calendarLinkOf(origin),
        origin,
        seenAt: now,
      };
    }
    return pruneMeetings(next, now);
  }

  /**
   * What is sent to the app: the meetings sorted by start, without bookkeeping.
   * @param {Record<string, Meeting>} store
   */
  function snapshotOf(store) {
    return Object.values(store)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .map(({ id, title, start, end, joinUrl, link }) => ({ id, title, start, end, joinUrl, link }));
  }

  /**
   * "pmr:<port>:<token>" from the tray's "Copy pairing code" → { port, token }, or null.
   * @param {unknown} code
   */
  function parsePairingCode(code) {
    const m = typeof code === 'string' ? code.trim().match(/^pmr:(\d{2,5}):([A-Za-z0-9_-]{16,})$/) : null;
    if (!m) return null;
    const port = Number(m[1]);
    return port > 0 && port < 65536 ? { port, token: m[2] } : null;
  }

  return { mergeMeetings, pruneMeetings, snapshotOf, parsePairingCode };
});
