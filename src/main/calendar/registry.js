// @ts-check
'use strict';

/** @typedef {import('./types').CalendarEvent} CalendarEvent */
/** @typedef {import('./types').CalendarSource} CalendarSource */

/**
 * Drops events that share a start time and title (case- and
 * whitespace-insensitive), e.g. the same invite on two calendars. The first
 * occurrence wins; the result is sorted by start time.
 * @param {CalendarEvent[]} events
 */
function dedupeEvents(events) {
  const seen = new Set();
  /** @type {CalendarEvent[]} */
  const out = [];
  for (const e of [...events].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const key = `${e.start.getTime()}|${e.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * All calendar sources in one place. Fetching uses allSettled so one failing
 * source never blocks the others.
 * @param {CalendarSource[]} sources
 */
function createRegistry(sources) {
  const connected = () => sources.filter((s) => s.isEnabled() && s.isConnected());
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
