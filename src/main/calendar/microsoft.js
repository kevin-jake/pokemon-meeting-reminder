// @ts-check
'use strict';
const { PublicClientApplication, InteractionRequiredAuthError } = require('@azure/msal-node');
const { createPkce } = require('./pkce');
const { startLoopback } = require('./loopback');
const { ReconnectNeededError } = require('./types');
const { findJoinUrlInText, safeHttpsUrl } = require('./meeting-links');

/** @typedef {import('./types').CalendarEvent} CalendarEvent */
/** @typedef {import('./types').CalendarSource} CalendarSource */
/** @typedef {import('./types').SourceState} SourceState */

// "common" accepts work/school and personal Microsoft accounts.
const AUTHORITY = 'https://login.microsoftonline.com/common';
const GRAPH = 'https://graph.microsoft.com/v1.0';
// MSAL adds openid, profile and offline_access (refresh token) on its own.
const SCOPES = ['Calendars.Read'];
const REQUEST_TIMEOUT_MS = 15_000;
const EVENT_SELECT =
  'id,subject,start,end,isAllDay,isCancelled,responseStatus,webLink,onlineMeeting,onlineMeetingUrl,location,bodyPreview';

/**
 * What one secure-store entry holds: the account this source signs in as,
 * and MSAL's serialized token cache (refresh token included).
 * @typedef {object} MicrosoftSecret
 * @property {string | null} homeAccountId
 * @property {string | null} account  username (usually the email address), for the tray
 * @property {string} cache           MSAL TokenCache.serialize()
 */

/**
 * The bits of PublicClientApplication this module uses, so tests can fake it.
 * @typedef {Pick<PublicClientApplication, 'getAuthCodeUrl' | 'acquireTokenByCode' | 'acquireTokenSilent' | 'getTokenCache'>} MsalClient
 */

/**
 * Graph `{ dateTime, timeZone }` → Date. We ask for UTC (Prefer header), and
 * Graph then sends a zone-less local time like "2026-10-22T16:00:00.0000000",
 * so a Z is appended. Anything not in UTC is rejected rather than guessed.
 * @param {any} value
 * @returns {Date | null}
 */
function parseGraphDateTime(value) {
  if (typeof value?.dateTime !== 'string') return null;
  if (value.timeZone && !/^(utc|etc\/utc)$/i.test(value.timeZone)) return null;
  // Graph sends 7 fractional digits; Date only reliably parses up to 3.
  let s = value.dateTime.trim().replace(/(\.\d{3})\d+/, '$1');
  if (!/(z|[+-]\d{2}:?\d{2})$/i.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Graph calendarView event → CalendarEvent, or null for anything that should
 * never trigger a reminder: all-day events, cancelled events and invites the
 * user declined.
 * @param {any} item  one entry of calendarView `value`
 * @param {string} [source]
 * @returns {CalendarEvent | null}
 */
function normalizeGraphEvent(item, source = 'microsoft') {
  if (!item || !item.id || item.isCancelled || item.isAllDay) return null;
  if (item.responseStatus?.response === 'declined') return null;
  const start = parseGraphDateTime(item.start);
  if (!start) return null;
  const end = parseGraphDateTime(item.end) ?? start;
  return {
    id: String(item.id),
    title: String(item.subject ?? '').trim() || '(No title)',
    start,
    end,
    source,
    joinUrl: graphJoinUrl(item),
    link: safeHttpsUrl(item.webLink),
  };
}

/**
 * Join link: the Teams/Skype online meeting, then the legacy onlineMeetingUrl,
 * then a known link pasted into the location or the body.
 * @param {any} item
 */
function graphJoinUrl(item) {
  return (
    safeHttpsUrl(item.onlineMeeting?.joinUrl) ??
    safeHttpsUrl(item.onlineMeetingUrl) ??
    findJoinUrlInText([item.location?.displayName, item.bodyPreview])
  );
}

/** @param {unknown} err */
function isInteractionRequired(err) {
  return err instanceof InteractionRequiredAuthError || /** @type {any} */ (err)?.name === 'InteractionRequiredAuthError';
}

/**
 * @param {string} clientId
 * @param {import('@azure/msal-node').ICachePlugin} cachePlugin
 * @returns {MsalClient}
 */
function createMsalClient(clientId, cachePlugin) {
  return new PublicClientApplication({ auth: { clientId, authority: AUTHORITY }, cache: { cachePlugin } });
}

/**
 * One Microsoft 365 / Outlook.com account's calendar via MSAL (loopback auth
 * code flow + PKCE) and raw fetch against Graph. MSAL's token cache is kept
 * in the secure store under `secretName` through a cache plugin; tokens are
 * renewed by acquireTokenSilent. When MSAL says the user must sign in again
 * (refresh token revoked or expired) the source switches to the reconnect
 * state. Several accounts are several instances (see microsoft-accounts.js).
 * @param {object} deps
 * @param {() => { clientId: string, enabled: boolean }} deps.getConfig
 * @param {{ get(name: string): string | null, set(name: string, value: string): boolean, delete(name: string): void }} deps.store
 * @param {(url: string) => Promise<void>} deps.openExternal
 * @param {typeof fetch} [deps.fetchFn]
 * @param {typeof createMsalClient} [deps.createClient]
 * @param {string} [deps.id]          source id, also stamped on every event (scheduler keys)
 * @param {string} [deps.secretName]  secure-store entry holding this account's token cache
 * @returns {CalendarSource}
 */
function createMicrosoftSource({
  getConfig,
  store,
  openExternal,
  fetchFn = fetch,
  createClient = createMsalClient,
  id = 'microsoft',
  secretName = 'microsoft',
}) {
  /** @type {MicrosoftSecret | null} */
  let saved = load();
  /** @type {SourceState} */
  let state = saved?.homeAccountId ? 'connected' : 'disconnected';
  /** @type {(() => void) | null} */
  let cancelPending = null;
  /** Bumped per connect() so a cancelled attempt never overwrites a newer one's state. */
  let connectAttempt = 0;
  /** Set by disconnect() so a token refresh still in flight cannot write the cache back. */
  let retired = false;
  /** @type {MsalClient | null} */
  let client = null;
  let clientFor = '';

  function load() {
    const raw = store.get(secretName);
    if (!raw) return null;
    try {
      const s = JSON.parse(raw);
      return s && typeof s.cache === 'string' ? /** @type {MicrosoftSecret} */ (s) : null;
    } catch {
      return null;
    }
  }

  /** @param {MicrosoftSecret} s */
  function save(s) {
    saved = s;
    if (!retired) store.set(secretName, JSON.stringify(s));
  }

  /** @type {import('@azure/msal-node').ICachePlugin} */
  const cachePlugin = {
    async beforeCacheAccess(ctx) {
      if (saved?.cache) ctx.tokenCache.deserialize(saved.cache);
    },
    async afterCacheAccess(ctx) {
      if (ctx.cacheHasChanged) save({ homeAccountId: null, account: null, ...saved, cache: ctx.tokenCache.serialize() });
    },
  };

  /** One MSAL client per client id (settings can change it at runtime). */
  function msal() {
    const { clientId } = getConfig();
    if (!client || clientFor !== clientId) {
      client = createClient(clientId, cachePlugin);
      clientFor = clientId;
    }
    return client;
  }

  function markReconnect() {
    // Keep the stored account label for the tray; the cache is useless now.
    state = 'reconnect';
  }

  /** @param {boolean} [force]  skip the cached access token (after a 401) */
  async function accessToken(force = false) {
    if (state === 'reconnect') throw new ReconnectNeededError('Microsoft sign-in expired');
    if (!saved?.homeAccountId) throw new Error('Microsoft 365 is not connected');
    const pca = msal();
    const account = await pca.getTokenCache().getAccountByHomeId(saved.homeAccountId);
    if (!account) {
      markReconnect();
      throw new ReconnectNeededError('Microsoft account is missing from the token cache');
    }
    try {
      const result = await pca.acquireTokenSilent({ account, scopes: SCOPES, forceRefresh: force });
      return result.accessToken;
    } catch (err) {
      if (isInteractionRequired(err)) {
        markReconnect();
        throw new ReconnectNeededError(`Microsoft sign-in expired: ${/** @type {Error} */ (err).message}`);
      }
      throw err;
    }
  }

  /**
   * GET on Graph with one retry after a 401. Times come back in UTC.
   * @param {string} path
   * @param {Record<string, string>} [query]
   */
  async function graph(path, query = {}) {
    // Graph's OData options read better unescaped ($select rather than %24select).
    const url = `${GRAPH}${path}?${new URLSearchParams(query).toString().replace(/%24/g, '$')}`;
    for (let attempt = 0; ; attempt += 1) {
      const token = await accessToken(attempt > 0);
      const res = await fetchFn(url, {
        headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 401 && attempt === 0) continue;
      if (!res.ok) throw new Error(`Microsoft Graph ${path} failed (${res.status}): ${await res.text().catch(() => '')}`);
      return /** @type {any} */ (await res.json());
    }
  }

  return {
    id,
    name: 'Microsoft 365',
    isConfigured: () => Boolean(getConfig().clientId),
    isEnabled: () => getConfig().enabled,
    isConnected: () => state === 'connected',
    state: () => state,
    accountLabel: () => saved?.account ?? null,

    async connect() {
      const { clientId } = getConfig();
      if (!clientId) throw new Error('Microsoft clientId is not set in settings.json');
      cancelPending?.();
      const mine = ++connectAttempt;
      /** @type {SourceState} */
      const previous = state === 'connecting' ? (saved?.homeAccountId ? 'connected' : 'disconnected') : state;
      state = 'connecting';
      retired = false;
      const pkce = createPkce();
      try {
        // Azure matches a registered http://localhost on any port, but only
        // with the bare origin as the redirect URI.
        const loopback = await startLoopback({ expectedState: pkce.state, redirectHost: 'localhost', callbackPath: '' });
        cancelPending = loopback.close;
        const pca = msal();
        const authUrl = await pca.getAuthCodeUrl({
          scopes: SCOPES,
          redirectUri: loopback.redirectUri,
          codeChallenge: pkce.challenge,
          codeChallengeMethod: pkce.method,
          state: pkce.state,
          prompt: 'select_account', // so another account can be added
          // Reconnecting: preselect the account whose sign-in expired.
          ...(saved?.account ? { loginHint: saved.account } : {}),
        });
        await openExternal(authUrl);
        const code = await loopback.waitForCode();
        const result = await pca.acquireTokenByCode({
          code,
          codeVerifier: pkce.verifier,
          redirectUri: loopback.redirectUri,
          scopes: SCOPES,
        });
        const account = result?.account;
        if (!account) throw new Error('Microsoft did not return an account');
        save({ homeAccountId: account.homeAccountId, account: account.username || null, cache: saved?.cache ?? '' });
        // One account per entry: forget whichever account it held before (a reconnect may pick another).
        const cache = pca.getTokenCache();
        for (const other of await cache.getAllAccounts()) {
          if (other.homeAccountId !== account.homeAccountId) await cache.removeAccount(other);
        }
        state = 'connected';
      } catch (err) {
        if (mine === connectAttempt) state = previous;
        throw err;
      } finally {
        if (mine === connectAttempt) cancelPending = null;
      }
    },

    cancelConnect() {
      cancelPending?.();
    },

    async disconnect() {
      connectAttempt += 1; // an in-flight sign-in must not restore its old state
      cancelPending?.();
      cancelPending = null;
      // Microsoft has no token revocation for public clients: forgetting the cache is the disconnect.
      retired = true;
      saved = null;
      client = null;
      state = 'disconnected';
      store.delete(secretName);
    },

    async fetchUpcoming(windowMinutes) {
      const now = new Date();
      const end = new Date(now.getTime() + windowMinutes * 60_000);
      // calendarView expands recurring series and includes meetings already in progress.
      const json = await graph('/me/calendarView', {
        startDateTime: now.toISOString(),
        endDateTime: end.toISOString(),
        $orderby: 'start/dateTime',
        $select: EVENT_SELECT,
        $top: '50',
      });
      return (json.value ?? []).map((/** @type {any} */ item) => normalizeGraphEvent(item, id)).filter(Boolean);
    },
  };
}

module.exports = { createMicrosoftSource, normalizeGraphEvent, parseGraphDateTime };
