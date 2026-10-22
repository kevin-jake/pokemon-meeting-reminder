// @ts-check
'use strict';
const { meetingKey } = require('../../shared/reminder-scheduler');

/** @typedef {import('./types').CalendarEvent} CalendarEvent */
/** @typedef {import('./types').CalendarSource} CalendarSource */

/**
 * Drops events that share a start time and title (case- and
 * whitespace-insensitive), e.g. the same invite on a Google and a Microsoft
 * calendar. The first occurrence wins but borrows a join / invite link it
 * lacks from the copies it replaces; the result is sorted by start time.
 * @param {CalendarEvent[]} events
 */
function dedupeEvents(events) {
  /** @type {Map<string, CalendarEvent>} */
  const byKey = new Map();
  for (const e of [...events].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const key = meetingKey(e);
    const kept = byKey.get(key);
    if (!kept) byKey.set(key, e);
    else if ((!kept.joinUrl && e.joinUrl) || (!kept.link && e.link)) {
      byKey.set(key, { ...kept, joinUrl: kept.joinUrl || e.joinUrl, link: kept.link || e.link });
    }
  }
  return [...byKey.values()];
}

/**
 * All calendar sources in one place. Fetching uses allSettled so one failing
 * source never blocks the others. Accounts come and go at runtime, so the
 * sources can be given as a function that returns the current list.
 * @param {CalendarSource[] | (() => CalendarSource[])} sourcesOrGetter
 */
function createRegistry(sourcesOrGetter) {
  const sources = typeof sourcesOrGetter === 'function' ? sourcesOrGetter : () => sourcesOrGetter;
  const connected = () => sources().filter((s) => s.isEnabled() && s.isConnected());
  return {
    sources,
    connected,
    /**
     * @param {number} windowMinutes
     * @returns {Promise<{ events: CalendarEvent[], errors: Array<{ source: CalendarSource, error: unknown }>, polled: number }>}
     */
    async fetchAll(windowMinutes) {
      const active = connected();
      const results = await Promise.allSettled(active.map((s) => s.fetchUpcoming(windowMinutes)));
      /** @type {CalendarEvent[]} */
      const events = [];
      /** @type {Array<{ source: CalendarSource, error: unknown }>} */
      const errors = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') events.push(...r.value);
        else errors.push({ source: active[i], error: r.reason });
      });
      return { events: dedupeEvents(events), errors, polled: active.length };
    },
  };
}

module.exports = { createRegistry, dedupeEvents };
