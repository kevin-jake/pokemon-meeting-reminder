// @ts-check
'use strict';

/** @typedef {import('../main/calendar/types').CalendarEvent} CalendarEvent */

/**
 * @typedef {object} DueReminder
 * @property {CalendarEvent} event
 * @property {'warn' | 'start'} kind  warn = "in N min" scene, start = urgent meeting-start alarm
 * @property {string} key
 */

/** A started meeting still gets its start alarm if first seen this soon after it began (poll gaps, wake from sleep). */
const START_GRACE_MS = 2 * 60_000;
/** Fired keys are kept this long after the meeting's start, then pruned. */
const PRUNE_AFTER_MS = 60 * 60_000;

/**
 * Pure reminder bookkeeping: given the current upcoming events, decides
 * which reminders are due and remembers what already fired. Each meeting
 * fires twice: a warning `alertMinutes` before it starts and the urgent alarm
 * at start time. Keys include the start time, so a rescheduled meeting
 * alerts again.
 * @param {{ alertMinutes?: number }} [opts]
 */
function createReminderScheduler(opts = {}) {
  let alertMs = (opts.alertMinutes ?? 5) * 60_000;
  /** key → meeting start (ms), kept for pruning */
  const fired = new Map();

  /** @param {CalendarEvent} e @param {'warn' | 'start'} kind */
  const keyOf = (e, kind) => `${e.source}:${e.id}:${e.start.getTime()}:${kind}`;

  /**
   * @param {CalendarEvent[]} events
   * @param {number} [now]
   * @returns {{ due: DueReminder[], next: number | null }}  next = earliest future time (ms) a reminder becomes due
   */
  function ingest(events, now = Date.now()) {
    /** @type {DueReminder[]} */
    const due = [];
    /** @type {number | null} */
    let next = null;
    /** @param {number} t */
    const consider = (t) => {
      if (t > now && (next === null || t < next)) next = t;
    };

    for (const event of events) {
      const startMs = event.start.getTime();
      const untilStart = startMs - now;
      const warnKey = keyOf(event, 'warn');
      const startKey = keyOf(event, 'start');

      if (untilStart <= 0) {
        // Started: alarm once, and only shortly after the start (not when the app launches mid-meeting).
        if (!fired.has(startKey) && -untilStart <= START_GRACE_MS) due.push({ event, kind: 'start', key: startKey });
        // A warning would be stale now, whether or not it fired.
        fired.set(startKey, startMs);
        fired.set(warnKey, startMs);
        continue;
      }
      if (untilStart <= alertMs && !fired.has(warnKey)) {
        due.push({ event, kind: 'warn', key: warnKey });
        fired.set(warnKey, startMs);
      }
      if (!fired.has(warnKey)) consider(startMs - alertMs);
      consider(startMs);
    }
    prune(now);
    return { due, next };
  }

  /** Forgets keys for meetings that started more than an hour ago. @param {number} [now] */
  function prune(now = Date.now()) {
    for (const [key, startMs] of fired) if (now - startMs > PRUNE_AFTER_MS) fired.delete(key);
  }

  return {
    ingest,
    prune,
    /** @param {number} minutes */
    setAlertMinutes(minutes) {
      alertMs = minutes * 60_000;
    },
    firedCount: () => fired.size,
  };
}

module.exports = { createReminderScheduler, START_GRACE_MS };
