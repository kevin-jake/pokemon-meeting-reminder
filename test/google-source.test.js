// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleSource } = require('../src/main/calendar/google');
const { ReconnectNeededError } = require('../src/main/calendar/types');

/** In-memory stand-in for secure-store. */
function memoryStore(initial = {}) {
  /** @type {Map<string, string>} */
  const m = new Map(Object.entries(initial));
  return { get: (/** @type {string} */ k) => m.get(k) ?? null, set: (/** @type {string} */ k, /** @type {string} */ v) => (m.set(k, v), true), delete: (/** @type {string} */ k) => void m.delete(k), m };
}

const config = () => ({ clientId: 'cid', clientSecret: 'csecret', enabled: true, allCalendars: false });
const json = (/** @type {number} */ status, /** @type {any} */ body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stored = (/** @type {Partial<import('../src/main/calendar/google').GoogleTokens>} */ t = {}) =>
  JSON.stringify({ refreshToken: 'rt', accessToken: 'old', expiresAt: 0, account: 'me@example.com', ...t });

/**
 * Fake fetch routed by URL prefix; records every call.
 * @param {Record<string, (url: URL, init: RequestInit | undefined) => Response>} routes
 */
function fakeFetch(routes) {
  /** @type {Array<{ url: URL, init: RequestInit | undefined }>} */
  const calls = [];
  const fn = /** @type {typeof fetch} */ (
    async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      const key = Object.keys(routes).find((k) => `${url.origin}${url.pathname}`.startsWith(k));
      if (!key) throw new Error(`unexpected fetch ${url}`);
      return routes[key](url, init);
    }
  );
  return { fn, calls };
}

test('stored tokens mean connected; expired access tokens are refreshed before fetching', async () => {
  const store = memoryStore({ google: stored() });
  const { fn, calls } = fakeFetch({
    'https://oauth2.googleapis.com/token': (_u, init) => {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'rt');
      assert.equal(body.get('client_secret'), 'csecret');
      return json(200, { access_token: 'fresh', expires_in: 3600 });
    },
    'https://www.googleapis.com/calendar/v3/calendars/primary/events': (url, init) => {
      assert.equal(/** @type {any} */ (init?.headers).Authorization, 'Bearer fresh');
      assert.equal(url.searchParams.get('singleEvents'), 'true');
      return json(200, {
        items: [
          { id: '1', summary: 'Standup', start: { dateTime: '2026-10-22T09:00:00Z' }, end: { dateTime: '2026-10-22T09:15:00Z' } },
          { id: '2', summary: 'Holiday', start: { date: '2026-10-22' }, end: { date: '2026-10-23' } },
        ],
      });
    },
  });
  const g = createGoogleSource({ getConfig: config, store, openExternal: async () => {}, fetchFn: fn });
  assert.equal(g.state(), 'connected');
  assert.equal(g.accountLabel(), 'me@example.com');
  const events = await g.fetchUpcoming(60);
  assert.deepEqual(events.map((e) => e.title), ['Standup']);
  assert.equal(JSON.parse(/** @type {string} */ (store.get('google'))).accessToken, 'fresh');
  // Second fetch reuses the still-valid token.
  await g.fetchUpcoming(60);
  assert.equal(calls.filter((c) => c.url.pathname === '/token').length, 1);
});

test('invalid_grant switches to reconnect-needed', async () => {
  const { fn } = fakeFetch({
    'https://oauth2.googleapis.com/token': () => json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
  });
  const g = createGoogleSource({ getConfig: config, store: memoryStore({ google: stored() }), openExternal: async () => {}, fetchFn: fn });
  await assert.rejects(g.fetchUpcoming(60), ReconnectNeededError);
  assert.equal(g.state(), 'reconnect');
  assert.equal(g.isConnected(), false);
  assert.equal(g.accountLabel(), 'me@example.com');
});

test('a 401 forces one token refresh and a retry', async () => {
  let eventsCalls = 0;
  const { fn } = fakeFetch({
    'https://oauth2.googleapis.com/token': () => json(200, { access_token: 'fresh', expires_in: 3600 }),
    'https://www.googleapis.com/calendar/v3/calendars/primary/events': (_u, init) => {
      eventsCalls += 1;
      return /** @type {any} */ (init?.headers).Authorization === 'Bearer fresh' ? json(200, { items: [] }) : json(401, {});
    },
  });
  const store = memoryStore({ google: stored({ accessToken: 'stale', expiresAt: Date.now() + 3600_000 }) });
  const g = createGoogleSource({ getConfig: config, store, openExternal: async () => {}, fetchFn: fn });
  assert.deepEqual(await g.fetchUpcoming(60), []);
  assert.equal(eventsCalls, 2);
});

test('connect runs the loopback PKCE flow and stores tokens and the account', async () => {
  const store = memoryStore();
  const { fn } = fakeFetch({
    'https://oauth2.googleapis.com/token': (_u, init) => {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), 'the-code');
      assert.match(/** @type {string} */ (body.get('code_verifier')), /^[A-Za-z0-9_-]{43}$/);
      assert.match(/** @type {string} */ (body.get('redirect_uri')), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      return json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    },
    'https://www.googleapis.com/calendar/v3/calendars/primary': () => json(200, { id: 'me@example.com' }),
  });
  const g = createGoogleSource({
    getConfig: config,
    store,
    fetchFn: fn,
    // Play the browser: follow the consent redirect back to the loopback server.
    openExternal: async (authUrl) => {
      const u = new URL(authUrl);
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(u.searchParams.get('access_type'), 'offline');
      assert.equal(g.state(), 'connecting');
      const back = new URL(/** @type {string} */ (u.searchParams.get('redirect_uri')));
      back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', /** @type {string} */ (u.searchParams.get('state')));
      setImmediate(() => void globalThis.fetch(back));
    },
  });
  await g.connect();
  assert.equal(g.state(), 'connected');
  assert.equal(g.accountLabel(), 'me@example.com');
  assert.equal(JSON.parse(/** @type {string} */ (store.get('google'))).refreshToken, 'rt');
});

test('cancelling a sign-in restores the previous state; disconnect revokes and forgets', async () => {
  const store = memoryStore({ google: stored() });
  const { fn, calls } = fakeFetch({ 'https://oauth2.googleapis.com/revoke': () => new Response('', { status: 200 }) });
  const g = createGoogleSource({ getConfig: config, store, fetchFn: fn, openExternal: async () => void setImmediate(() => g.cancelConnect()) });
  await assert.rejects(g.connect(), /cancelled/);
  assert.equal(g.state(), 'connected');
  await g.disconnect();
  assert.equal(g.state(), 'disconnected');
  assert.equal(store.get('google'), null);
  assert.equal(calls[0].url.searchParams.get('token'), 'rt');
});

test('the sign-in link can be copied only while the sign-in is waiting', async () => {
  /** @type {string | null} */
  let seen = null;
  const g = createGoogleSource({
    getConfig: config,
    store: memoryStore(),
    openExternal: async () =>
      void setImmediate(() => {
        seen = g.signInUrl?.() ?? null;
        g.cancelConnect();
      }),
  });
  assert.equal(g.signInUrl?.(), null);
  await assert.rejects(g.connect(), /cancelled/);
  assert.ok(seen && /** @type {string} */ (seen).startsWith('https://accounts.google.com/'));
  assert.equal(new URL(/** @type {string} */ (seen)).searchParams.get('client_id'), 'cid');
  assert.equal(g.signInUrl?.(), null);
});

test('connect refuses without a client id', async () => {
  const g = createGoogleSource({ getConfig: () => ({ ...config(), clientId: '' }), store: memoryStore(), openExternal: async () => {} });
  assert.equal(g.isConfigured(), false);
  await assert.rejects(g.connect(), /clientId/);
  assert.equal(g.state(), 'disconnected');
});
