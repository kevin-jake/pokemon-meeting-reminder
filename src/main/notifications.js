// @ts-check
'use strict';
const { Notification } = require('electron');

/** Notifications we hold on to until they close: a garbage-collected one never fires 'click'. */
const LIVE_LIMIT = 20;

/** @param {string} url */
function serviceName(url) {
  const host = new URL(url).hostname;
  if (host === 'meet.google.com') return 'Google Meet';
  if (host.endsWith('zoom.us')) return 'Zoom';
  if (host.startsWith('teams.')) return 'Teams';
  if (host.endsWith('webex.com')) return 'Webex';
  return host;
}

/**
 * Windows toast for a reminder. Clicking it opens the meeting's join link,
 * or the invite in the calendar when the event has no video link.
 * @param {(url: string) => Promise<void>} openExternal
 */
function createMeetingNotifier(openExternal) {
  /** @type {Set<Notification>} */
  const live = new Set();

  return {
    /**
     * @param {{ title: string, minutesUntil: number, joinUrl?: string | null, link?: string | null }} meeting
     */
    show({ title, minutesUntil, joinUrl = null, link = null }) {
      if (!Notification.isSupported()) return;
      const url = joinUrl ?? link;
      const body = joinUrl ? `Click to join on ${serviceName(joinUrl)}` : link ? 'Click to open the invite' : '';
      const n = new Notification({
        title: minutesUntil <= 0 ? `${title} is starting now` : `${title} in ${minutesUntil} min`,
        body,
        silent: true, // the overlay already plays the cry and music
      });
      const forget = () => live.delete(n);
      n.on('click', () => {
        forget();
        if (url) void openExternal(url);
      });
      n.on('close', forget);
      n.on('failed', forget);
      live.add(n);
      if (live.size > LIVE_LIMIT) live.delete(/** @type {Notification} */ (live.values().next().value));
      n.show();
    },
  };
}

module.exports = { createMeetingNotifier, serviceName };
