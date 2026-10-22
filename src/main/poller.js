// @ts-check
'use strict';
const { ReconnectNeededError } = require('./calendar/types');

/** @typedef {import('./calendar/types').CalendarEvent} CalendarEvent */
/** @typedef {import('../shared/reminder-scheduler').DueReminder} DueReminder */

/** Longest single setTimeout we arm for a precise reminder; the regular poll covers anything later. */
const MAX_TIMER_MS = 10 * 60_000;

/** @param {Date} d */
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Tray status line for the current state.
 * @param {{ events: CalendarEvent[], now: number, connected: number, failed: string[], lookaheadMinutes: number }} s
 */
function statusText({ events, now, connected, failed, lookaheadMinutes }) {
  if (!connected) return 'Not connected';
  const upcoming = events.find((e) => e.start.getTime() > now);
  const suffix = failed.length ? ` · ${failed.join(', ')} unavailable` : '';
  if (!upcoming) {
    const span = lookaheadMinutes === 60 ? 'hour' : `${lookaheadMinutes} min`;
    return `No meetings in the next ${span}${suffix}`;
  }
  const mins = Math.max(1, Math.round((upcoming.start.getTime() - now) / 60_000));
  return `Next: ${upcoming.title} at ${hhmm(upcoming.start)} (in ${mins} min)${suffix}`;
}

/**
 * Banner title for reminders that fire together: "Standup + 2 more". The
 * first title is shortened so the suffix survives the banner's length cap.
 * @param {string[]} titles
 * @param {number} [max]  the renderer's title cap
 */
function mergeTitles(titles, max = 40) {
  if (titles.length <= 1) return titles[0] ?? '';
  const suffix = ` + ${titles.length - 1} more`;
  const first = titles[0].trim();
  const room = max - suffix.length;
  return `${first.length > room ? `${first.slice(0, room - 1)}…` : first}${suffix}`;
}

/**
 * Polls the calendars every `pollIntervalSec` and feeds the scheduler. Between
 * polls a timer is armed for the next reminder moment, so reminders fire on
 * time (from the cached events) instead of up to a poll interval late.
 * @param {object} deps
 * @param {ReturnType<typeof import('./calendar/registry').createRegistry>} deps.registry
 * @param {ReturnType<typeof import('../shared/reminder-scheduler').createReminderScheduler>} deps.scheduler
 * @param {() => { pollIntervalSec: number, lookaheadMinutes: number, alertMinutesBefore: number }} deps.getSettings
 * @param {(due: DueReminder[], now: number) => void} deps.onReminders
 * @param {(status: string) => void} deps.onStatus
 * @param {() => void} [deps.onSourcesChanged]  a source changed state during a poll (e.g. needs reconnect)
 * @param {() => number} [deps.now]
 */
function createPoller({ registry, scheduler, getSettings, onReminders, onStatus, onSourcesChanged = () => {}, now = Date.now }) {
  /** @type {CalendarEvent[]} */
  let events = [];
  /** @type {string[]} */
  let failed = [];
  let inFlight = false;
  let again = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let interval = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  /** Runs the scheduler over the cached events, reports, and re-arms the precise timer. */
  function check() {
    const t = now();
    const { due, next } = scheduler.ingest(events, t);
    if (due.length) onReminders(due, t);
    onStatus(statusText({ events, now: t, connected: registry.connected().length, failed, lookaheadMinutes: getSettings().lookaheadMinutes }));
    if (timer) clearTimeout(timer);
    timer = null;
    if (next !== null) timer = setTimeout(check, Math.min(Math.max(next - t, 0) + 50, MAX_TIMER_MS));
  }

  async function pollNow() {
    if (inFlight) {
      // Someone asked for fresh data mid-poll (e.g. just connected): poll again right after.
      again = true;
      return;
    }
    inFlight = true;
    try {
      const settings = getSettings();
      scheduler.setAlertMinutes(settings.alertMinutesBefore);
      const result = await registry.fetchAll(settings.lookaheadMinutes);
      let changed = false;
      for (const { source, error } of result.errors) {
        if (error instanceof ReconnectNeededError) changed = true;
        console.warn(`Calendar ${source.name} fetch failed:`, error);
      }
      failed = result.errors.filter((e) => !(e.error instanceof ReconnectNeededError)).map((e) => e.source.name);
      if (result.polled === 0) {
        events = [];
      } else if (result.errors.length === result.polled && failed.length) {
        // Everything failed (offline?): keep the cached events so reminders still fire.
      } else {
        events = result.events;
      }
      if (changed) onSourcesChanged();
      check();
    } catch (err) {
      console.error('Poll failed:', err);
    } finally {
      inFlight = false;
    }
    if (again) {
      again = false;
      await pollNow();
    }
  }

  return {
    start() {
      if (interval) clearInterval(interval);
      interval = setInterval(() => void pollNow(), getSettings().pollIntervalSec * 1000);
      void pollNow();
    },
    stop() {
      if (interval) clearInterval(interval);
      if (timer) clearTimeout(timer);
      interval = timer = null;
    },
    pollNow,
  };
}

module.exports = { createPoller, statusText, mergeTitles };
