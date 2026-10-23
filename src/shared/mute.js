// @ts-check
'use strict';

/**
 * A mute window: no reminders from `from` until `until` (both ms since epoch).
 * @typedef {{ from: number, until: number }} Mute
 */

/** Quick mute choices, in minutes from now. */
const MUTE_PRESETS = [30, 60, 120];
/** Longest mute the app accepts, so a typo can't silence it for a year. */
const MAX_MUTE_MS = 14 * 24 * 60 * 60_000;

/** @param {Mute | null} mute @param {number} now */
const isMuted = (mute, now) => mute !== null && mute.from <= now && now < mute.until;

/** A mute that has not ended yet (running now, or scheduled for later). @param {Mute | null} mute @param {number} now */
const isPending = (mute, now) => mute !== null && now < mute.until;

/**
 * Shape check for a mute window coming from the Settings page: it must end
 * after it starts, end in the future, and last at most MAX_MUTE_MS.
 * @param {unknown} v
 * @param {number} now
 * @returns {v is Mute}
 */
function isValidMute(v, now) {
  if (typeof v !== 'object' || v === null) return false;
  const { from, until } = /** @type {Record<string, unknown>} */ (v);
  return (
    typeof from === 'number' &&
    typeof until === 'number' &&
    Number.isFinite(from) &&
    Number.isFinite(until) &&
    from < until &&
    until > now &&
    until - Math.max(from, now) <= MAX_MUTE_MS
  );
}

/** @param {number} minutes @param {number} now @returns {Mute} */
const muteFor = (minutes, now) => ({ from: now, until: now + minutes * 60_000 });

/** "30 min", "1 hour", "2 hours". @param {number} minutes */
const presetLabel = (minutes) => (minutes < 60 ? `${minutes} min` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`);

/** @param {Date} d */
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * "14:30", "tomorrow 09:00" or "Mon 27 Oct 09:00", relative to `now`.
 * @param {number} t
 * @param {number} now
 */
function when(t, now) {
  const d = new Date(t);
  const today = new Date(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return hhmm(d);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${hhmm(d)}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${hhmm(d)}`;
}

/**
 * Status text for the tray and the Settings page, or null when nothing is muted.
 * @param {Mute | null} mute
 * @param {number} now
 */
function describeMute(mute, now) {
  if (!isPending(mute, now)) return null;
  const m = /** @type {Mute} */ (mute);
  if (isMuted(m, now)) return `Reminders muted until ${when(m.until, now)}`;
  return `Reminders muted from ${when(m.from, now)} to ${when(m.until, now)}`;
}

/**
 * Next moment the mute state flips (it starts or ends), or null.
 * @param {Mute | null} mute
 * @param {number} now
 */
function nextMuteChange(mute, now) {
  if (!isPending(mute, now)) return null;
  const m = /** @type {Mute} */ (mute);
  return m.from > now ? m.from : m.until;
}

module.exports = { MUTE_PRESETS, MAX_MUTE_MS, isMuted, isPending, isValidMute, muteFor, presetLabel, describeMute, nextMuteChange };
