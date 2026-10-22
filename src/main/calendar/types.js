// @ts-check
'use strict';

/**
 * One timed meeting, normalized from whichever calendar it came from.
 * @typedef {object} CalendarEvent
 * @property {string} id      provider event id (unique within its source)
 * @property {string} title
 * @property {Date} start
 * @property {Date} end
 * @property {string} source  CalendarSource id, e.g. 'google'
 */

/**
 * Connection state shown in the tray:
 *  - disconnected: never connected, or the user disconnected
 *  - connecting:   browser sign-in in progress
 *  - connected:    tokens on hand
 *  - reconnect:    the refresh token was revoked or expired; the user must sign in again
 * @typedef {'disconnected' | 'connecting' | 'connected' | 'reconnect'} SourceState
 */

/**
 * @typedef {object} CalendarSource
 * @property {string} id
 * @property {string} name
 * @property {() => Promise<void>} connect      interactive browser sign-in
 * @property {() => Promise<void>} disconnect
 * @property {() => void} cancelConnect         abandons a sign-in that is still waiting on the browser
 * @property {() => boolean} isConnected
 * @property {() => boolean} isConfigured       false until a client id is in settings
 * @property {() => boolean} isEnabled          false when switched off in settings
 * @property {() => SourceState} state
 * @property {() => string | null} accountLabel  e.g. the signed-in email address
 * @property {(windowMinutes: number) => Promise<CalendarEvent[]>} fetchUpcoming  events overlapping [now, now + window]
 */

/** Thrown when stored credentials can no longer be refreshed. */
class ReconnectNeededError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ReconnectNeededError';
  }
}

module.exports = { ReconnectNeededError };
