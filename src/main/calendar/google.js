// @ts-check
'use strict';
const { createPkce } = require('./pkce');
const { startLoopback } = require('./loopback');
const { ReconnectNeededError } = require('./types');
const { findJoinUrlInText, safeHttpsUrl } = require('./meeting-links');

/** @typedef {import('./types').CalendarEvent} CalendarEvent */
/** @typedef {import('./types').CalendarSource} CalendarSource */
/** @typedef {import('./types').SourceState} SourceState */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const REFRESH_EARLY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const EVENT_FIELDS =
  'items(id,summary,start,end,status,eventType,attendees(self,responseStatus),' +
  'htmlLink,hangoutLink,location,description,conferenceData(entryPoints(entryPointType,uri)))';
/** Calendar blocks that are not meetings. */
const SKIPPED_EVENT_TYPES = new Set(['workingLocation', 'outOfOffice', 'focusTime']);

/**
 * @typedef {object} GoogleTokens
 * @property {string} refreshToken
 * @property {string} accessToken
 * @property {number} expiresAt  ms epoch
 * @property {string | null} account  primary calendar id (the signed-in email)
 */

/**
 * Google Calendar event → CalendarEvent, or null for anything that should
 * never trigger a reminder: all-day events, cancelled events, invites the user
 * declined, and working-location / out-of-office / focus-time blocks.
 * @param {any} item  one entry of events.list `items`
 * @param {string} [source]
 * @returns {CalendarEvent | null}
 */
function normalizeGoogleEvent(item, source = 'google') {
  if (!item || !item.id || item.status === 'cancelled') return null;
  if (!item.start?.dateTime) return null; // all-day events only carry start.date
  if (SKIPPED_EVENT_TYPES.has(item.eventType)) return null;
  const self = Array.isArray(item.attendees) ? item.attendees.find((/** @type {any} */ a) => a.self) : undefined;
  if (self?.responseStatus === 'declined') return null;
  const start = new Date(item.start.dateTime);
  if (Number.isNaN(start.getTime())) return null;
  const end = item.end?.dateTime ? new Date(item.end.dateTime) : start;
  return {
    id: String(item.id),
    title: String(item.summary ?? '').trim() || '(No title)',
    start,
    end,
    source,
    joinUrl: googleJoinUrl(item),
    link: safeHttpsUrl(item.htmlLink),
  };
}

/**
 * Join link: Google's conference data (Meet, or Zoom/Teams add-ons), then the
 * legacy hangoutLink, then a known link pasted into the location/description.
 * @param {any} item
 */
function googleJoinUrl(item) {
  const entryPoints = Array.isArray(item.conferenceData?.entryPoints) ? item.conferenceData.entryPoints : [];
  const video = entryPoints.find((/** @type {any} */ e) => e.entryPointType === 'video' && safeHttpsUrl(e.uri));
  return safeHttpsUrl(video?.uri) ?? safeHttpsUrl(item.hangoutLink) ?? findJoinUrlInText([item.location, item.description]);
}

/**
 * One Google account's calendar via OAuth 2.0 (installed-app loopback flow +
 * PKCE) and raw fetch. Tokens live in the secure store under `secretName`;
 * the access token is refreshed when it has less than a minute left. A
 * rejected refresh (invalid_grant: revoked, or the 7-day expiry of apps left
 * in "Testing") switches to the reconnect state. Several accounts are several
 * instances (see google-accounts.js).
 * @param {object} deps
 * @param {() => { clientId: string, clientSecret: string, enabled: boolean, allCalendars: boolean }} deps.getConfig
 * @param {{ get(name: string): string | null, set(name: string, value: string): boolean, delete(name: string): void }} deps.store
 * @param {(url: string) => Promise<void>} deps.openExternal
 * @param {typeof fetch} [deps.fetchFn]
 * @param {string} [deps.id]          source id, also stamped on every event (scheduler keys)
 * @param {string} [deps.secretName]  secure-store entry holding this account's tokens
 * @returns {CalendarSource}
 */
function createGoogleSource({ getConfig, store, openExternal, fetchFn = fetch, id = 'google', secretName = 'google' }) {
  /** @type {GoogleTokens | null} */
  let tokens = load();
  /** @type {SourceState} */
  let state = tokens ? 'connected' : 'disconnected';
  /** @type {(() => void) | null} */
  let cancelPending = null;
  /** The browser sign-in URL while a connect() is waiting on it, so it can be copied. */
  /** @type {string | null} */
  let pendingUrl = null;
  /** @type {Promise<string> | null} */
  let refreshing = null;
  /** Bumped per connect() so a cancelled attempt never overwrites a newer one's state. */
  let connectAttempt = 0;

  function load() {
    const raw = store.get(secretName);
    if (!raw) return null;
    try {
      const t = JSON.parse(raw);
      return t && typeof t.refreshToken === 'string' ? /** @type {GoogleTokens} */ (t) : null;
    } catch {
      return null;
    }
  }

  /** @param {GoogleTokens} t */
  function save(t) {
    tokens = t;
    store.set(secretName, JSON.stringify(t));
  }

  /**
   * POSTs a form to the token endpoint.
   * @param {Record<string, string>} form
   */
  async function tokenRequest(form) {
    const { clientId, clientSecret } = getConfig();
    const body = new URLSearchParams({ client_id: clientId, ...form });
    // "Desktop app" clients still send their (non-confidential) secret.
    if (clientSecret) body.set('client_secret', clientSecret);
    const res = await fetchFn(TOKEN_URL, { method: 'POST', body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const json = /** @type {any} */ (await res.json().catch(() => ({})));
    if (!res.ok) {
      const err = new Error(`Google token request failed (${res.status}): ${json.error_description ?? json.error ?? 'unknown'}`);
      if (json.error === 'invalid_grant') {
        markReconnect();
        throw new ReconnectNeededError(err.message);
      }
      throw err;
    }
    return json;
  }

  function markReconnect() {
    state = 'reconnect';
    // Keep the stored account label for the tray, but the tokens are useless now.
    if (tokens) tokens = { ...tokens, accessToken: '', expiresAt: 0 };
  }

  /** @param {boolean} [force] */
  async function accessToken(force = false) {
    if (state === 'reconnect') throw new ReconnectNeededError('Google sign-in expired');
    if (!tokens) throw new Error('Google is not connected');
    if (!force && tokens.accessToken && tokens.expiresAt - Date.now() > REFRESH_EARLY_MS) return tokens.accessToken;
    if (!refreshing) {
      const t = tokens;
      refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken })
        .then((json) => {
          save({
            ...t,
            accessToken: json.access_token,
            expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
            // Google rarely rotates refresh tokens, but keep a new one if it does.
            refreshToken: json.refresh_token ?? t.refreshToken,
          });
          return json.access_token;
        })
        .finally(() => {
          refreshing = null;
        });
    }
    return refreshing;
  }

  /**
   * GET on the Calendar API with one retry after a 401.
   * @param {string} path
   * @param {Record<string, string>} [query]
   */
  async function api(path, query = {}) {
    const url = `${API}${path}?${new URLSearchParams(query)}`;
    for (let attempt = 0; ; attempt += 1) {
      const token = await accessToken(attempt > 0);
      const res = await fetchFn(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 401 && attempt === 0) continue;
      if (!res.ok) throw new Error(`Google Calendar ${path} failed (${res.status}): ${await res.text().catch(() => '')}`);
      return /** @type {any} */ (await res.json());
    }
  }

  /** @param {string} calendarId @param {Date} timeMin @param {Date} timeMax */
  async function listEvents(calendarId, timeMin, timeMax) {
    const json = await api(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
      fields: EVENT_FIELDS,
    });
    return (json.items ?? []).map((/** @type {any} */ item) => normalizeGoogleEvent(item, id)).filter(Boolean);
  }

  return {
    id,
    name: 'Google',
    isConfigured: () => Boolean(getConfig().clientId),
    isEnabled: () => getConfig().enabled,
    isConnected: () => state === 'connected',
    state: () => state,
    accountLabel: () => tokens?.account ?? null,

    async connect() {
      const { clientId } = getConfig();
      if (!clientId) throw new Error('Google clientId is not set in settings.json');
      cancelPending?.();
      const mine = ++connectAttempt;
      /** @type {SourceState} */
      const previous = state === 'connecting' ? (tokens ? 'connected' : 'disconnected') : state;
      state = 'connecting';
      const pkce = createPkce();
      try {
        // Listen first: the redirect URI carries the ephemeral port.
        const loopback = await startLoopback({ expectedState: pkce.state });
        cancelPending = loopback.close;
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: loopback.redirectUri,
          response_type: 'code',
          scope: SCOPE,
          code_challenge: pkce.challenge,
          code_challenge_method: pkce.method,
          state: pkce.state,
          access_type: 'offline', // we need a refresh token
          // Account chooser, so another account can be added; consent, because Google
          // only re-issues a refresh token with fresh consent.
          prompt: 'select_account consent',
        });
        // Reconnecting: preselect the account whose sign-in expired.
        if (tokens?.account) params.set('login_hint', tokens.account);
        pendingUrl = `${AUTH_URL}?${params}`;
        await openExternal(pendingUrl);
        const code = await loopback.waitForCode();
        const json = await tokenRequest({
          grant_type: 'authorization_code',
          code,
          code_verifier: pkce.verifier,
          redirect_uri: loopback.redirectUri,
        });
        if (!json.refresh_token) throw new Error('Google did not return a refresh token');
        tokens = {
          refreshToken: json.refresh_token,
          accessToken: json.access_token,
          expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
          account: null,
        };
        state = 'connected';
        // The primary calendar's id is the account's email address.
        const primary = await api('/calendars/primary', { fields: 'id' }).catch(() => null);
        save({ ...tokens, account: primary?.id ?? null });
      } catch (err) {
        if (mine === connectAttempt) state = previous;
        throw err;
      } finally {
        if (mine === connectAttempt) {
          cancelPending = null;
          pendingUrl = null;
        }
      }
    },

    cancelConnect() {
      cancelPending?.();
    },

    signInUrl: () => (state === 'connecting' ? pendingUrl : null),

    async disconnect() {
      connectAttempt += 1; // an in-flight sign-in must not restore its old state
      cancelPending?.();
      cancelPending = null;
      pendingUrl = null;
      const t = tokens;
      tokens = null;
      state = 'disconnected';
      store.delete(secretName);
      if (t?.refreshToken) {
        // Best effort: revoking also removes the app from the user's Google account.
        await fetchFn(`${REVOKE_URL}?${new URLSearchParams({ token: t.refreshToken })}`, {
          method: 'POST',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }).catch((err) => console.warn('Google token revoke failed:', err));
      }
    },

    async fetchUpcoming(windowMinutes) {
      const now = new Date();
      // timeMin filters on the event's end, so in-progress meetings are included too.
      const timeMax = new Date(now.getTime() + windowMinutes * 60_000);
      let calendarIds = ['primary'];
      if (getConfig().allCalendars) {
        const list = await api('/users/me/calendarList', { minAccessRole: 'reader', fields: 'items(id,selected,primary)' });
        const ids = (list.items ?? [])
          .filter((/** @type {any} */ c) => c.selected || c.primary)
          .map((/** @type {any} */ c) => (c.primary ? 'primary' : c.id));
        if (ids.length) calendarIds = ids;
      }
      const lists = await Promise.all(calendarIds.map((id) => listEvents(id, now, timeMax)));
      return lists.flat();
    },
  };
}

module.exports = { createGoogleSource, normalizeGoogleEvent };
