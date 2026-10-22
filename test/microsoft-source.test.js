// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMicrosoftSource } = require('../src/main/calendar/microsoft');
const { createMicrosoftAccounts } = require('../src/main/calendar/microsoft-accounts');
const { createRegistry } = require('../src/main/calendar/registry');
const { ReconnectNeededError } = require('../src/main/calendar/types');

/** In-memory stand-in for secure-store, including list(). @param {Record<string, string>} [initial] */
function memoryStore(initial = {}) {
  /** @type {Map<string, string>} */
  const m = new Map(Object.entries(initial));
  return {
    m,
    get: (/** @type {string} */ k) => m.get(k) ?? null,
    set: (/** @type {string} */ k, /** @type {string} */ v) => (m.set(k, v), true),
    delete: (/** @type {string} */ k) => void m.delete(k),
    list: (/** @type {string} */ prefix) => [...m.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}

const config = () => ({ clientId: 'cid', enabled: true });
const json = (/** @type {number} */ status, /** @type {any} */ body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** Sequential keys so tests can predict secret names. */
const keys = () => {
  let n = 0;
  return () => `k${++n}`;
};

/**
 * Fake MSAL + Microsoft identity platform. The "browser" signs in as
 * `browser.account`; `browser.expired` makes silent renewal demand an
 * interactive sign-in. Every cache access goes through the real cache plugin,
 * like MSAL does, so persistence is exercised end to end.
 * @param {{ account: string, expired?: boolean }} browser
 */
function fakeMicrosoft(browser) {
  /** @type {any[]} */
  const authRequests = [];
  /** @type {boolean[]} */
  const silentForce = [];

  /** @type {NonNullable<Parameters<typeof createMicrosoftSource>[0]['createClient']>} */
  const createClient = (clientId, plugin) => {
    assert.equal(clientId, 'cid');
    /** @type {{ accounts: Record<string, any>, tokens: Record<string, string> }} */
    let data = { accounts: {}, tokens: {} };
    let changed = false;
    const tokenCache = {
      serialize: () => JSON.stringify(data),
      deserialize: (/** @type {string} */ s) => void (data = JSON.parse(s)),
    };
    /** @template T @param {() => T} fn @returns {Promise<T>} */
    const access = async (fn) => {
      await plugin.beforeCacheAccess(/** @type {any} */ ({ tokenCache, cacheHasChanged: false }));
      try {
        return fn();
      } finally {
        await plugin.afterCacheAccess(/** @type {any} */ ({ tokenCache, cacheHasChanged: changed }));
        changed = false;
      }
    };
    const cache = {
      getAccountByHomeId: (/** @type {string} */ id) => access(() => data.accounts[id] ?? null),
      getAllAccounts: () => access(() => Object.values(data.accounts)),
      removeAccount: (/** @type {any} */ a) =>
        access(() => {
          delete data.accounts[a.homeAccountId];
          delete data.tokens[a.homeAccountId];
          changed = true;
        }),
    };
    return /** @type {any} */ ({
      getTokenCache: () => cache,
      async getAuthCodeUrl(/** @type {any} */ req) {
        authRequests.push(req);
        const q = new URLSearchParams({ redirect_uri: req.redirectUri, state: req.state, prompt: req.prompt });
        if (req.loginHint) q.set('login_hint', req.loginHint);
        return `https://login.example/authorize?${q}`;
      },
      acquireTokenByCode: (/** @type {any} */ req) =>
        access(() => {
          assert.equal(req.code, 'c');
          assert.ok(req.codeVerifier);
          const account = { homeAccountId: `hid-${browser.account.toLowerCase()}`, username: browser.account };
          data.accounts[account.homeAccountId] = account;
          data.tokens[account.homeAccountId] = `at-${browser.account}`;
          changed = true;
          return { accessToken: data.tokens[account.homeAccountId], account };
        }),
      acquireTokenSilent: (/** @type {any} */ req) =>
        access(() => {
          silentForce.push(Boolean(req.forceRefresh));
          if (browser.expired) throw Object.assign(new Error('AADSTS700082: refresh token expired'), { name: 'InteractionRequiredAuthError' });
          return { accessToken: data.tokens[req.account.homeAccountId], account: req.account };
        }),
    });
  };

  /** Follows the consent redirect back to the loopback server, like a browser would. @param {string} authUrl */
  const openExternal = async (authUrl) => {
    const u = new URL(authUrl);
    const back = new URL(/** @type {string} */ (u.searchParams.get('redirect_uri')));
    back.searchParams.set('code', 'c');
    back.searchParams.set('state', /** @type {string} */ (u.searchParams.get('state')));
    setImmediate(() => void globalThis.fetch(back));
  };

  /** @type {Array<{ url: URL, headers: Record<string, string> }>} */
  const graphCalls = [];
  /** @type {typeof fetch} */
  const fetchFn = async (input, init) => {
    const url = new URL(String(input));
    const headers = /** @type {Record<string, string>} */ (init?.headers);
    graphCalls.push({ url, headers });
    assert.equal(url.pathname, '/v1.0/me/calendarView');
    const who = headers.Authorization.slice('Bearer at-'.length);
    return json(200, {
      value: [
        {
          id: 'm1',
          subject: `Sync (${who})`,
          start: { dateTime: '2026-10-22T09:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-10-22T09:30:00.0000000', timeZone: 'UTC' },
          onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
        },
        { id: 'allday', subject: 'Holiday', isAllDay: true, start: { dateTime: '2026-10-22T00:00:00', timeZone: 'UTC' } },
      ],
    });
  };

  return { createClient, openExternal, fetchFn, authRequests, silentForce, graphCalls };
}

test('connect signs in through a localhost redirect, persists the cache and fetches Graph in UTC', async () => {
  const fake = fakeMicrosoft({ account: 'Ann@Contoso.com' });
  const store = memoryStore();
  const src = createMicrosoftSource({ getConfig: config, store, ...fake });
  assert.equal(src.state(), 'disconnected');
  await src.connect();

  assert.equal(src.state(), 'connected');
  assert.equal(src.accountLabel(), 'Ann@Contoso.com');
  const [req] = fake.authRequests;
  assert.match(req.redirectUri, /^http:\/\/localhost:\d+$/);
  assert.equal(req.codeChallengeMethod, 'S256');
  assert.equal(req.prompt, 'select_account');
  assert.deepEqual(req.scopes, ['Calendars.Read']);

  const stored = JSON.parse(/** @type {string} */ (store.get('microsoft')));
  assert.equal(stored.homeAccountId, 'hid-ann@contoso.com');
  assert.match(stored.cache, /at-Ann@Contoso.com/);

  const events = await src.fetchUpcoming(60);
  assert.deepEqual(events.map((e) => [e.id, e.title, e.start.toISOString(), e.joinUrl]), [
    ['m1', 'Sync (Ann@Contoso.com)', '2026-10-22T09:00:00.000Z', 'https://teams.microsoft.com/l/meetup-join/abc'],
  ]);
  const { url, headers } = fake.graphCalls[0];
  assert.equal(headers.Prefer, 'outlook.timezone="UTC"');
  assert.ok(url.search.includes('$select='), url.search);
  assert.ok(url.searchParams.get('$select')?.includes('isAllDay'));
  assert.ok(url.searchParams.get('startDateTime') && url.searchParams.get('endDateTime'));
});

test('a restart restores the account from the stored cache without signing in again', async () => {
  const fake = fakeMicrosoft({ account: 'ann@contoso.com' });
  const store = memoryStore();
  await createMicrosoftSource({ getConfig: config, store, ...fake }).connect();

  const restarted = createMicrosoftSource({ getConfig: config, store, ...fake });
  assert.equal(restarted.state(), 'connected');
  assert.equal(restarted.accountLabel(), 'ann@contoso.com');
  assert.equal((await restarted.fetchUpcoming(60)).length, 1);
  assert.equal(fake.authRequests.length, 1);
});

test('a 401 from Graph retries once with a forced token refresh', async () => {
  const fake = fakeMicrosoft({ account: 'ann@contoso.com' });
  let first = true;
  /** @type {typeof fetch} */
  const fetchFn = async (input, init) => {
    if (first) {
      first = false;
      return new Response('', { status: 401 });
    }
    return fake.fetchFn(input, init);
  };
  const src = createMicrosoftSource({ getConfig: config, store: memoryStore(), ...fake, fetchFn });
  await src.connect();
  assert.equal((await src.fetchUpcoming(60)).length, 1);
  assert.deepEqual(fake.silentForce, [false, true]);
});

test('an expired sign-in switches to reconnect; reconnecting pre-selects the account', async () => {
  const browser = { account: 'ann@contoso.com', expired: false };
  const fake = fakeMicrosoft(browser);
  const store = memoryStore();
  const src = createMicrosoftSource({ getConfig: config, store, ...fake });
  await src.connect();

  browser.expired = true;
  await assert.rejects(src.fetchUpcoming(60), ReconnectNeededError);
  assert.equal(src.state(), 'reconnect');
  assert.equal(src.isConnected(), false);
  assert.equal(src.accountLabel(), 'ann@contoso.com');
  // No more token attempts until the user signs in again.
  await assert.rejects(src.fetchUpcoming(60), ReconnectNeededError);
  assert.equal(fake.silentForce.length, 1);

  browser.expired = false;
  await src.connect();
  assert.equal(fake.authRequests[1].loginHint, 'ann@contoso.com');
  assert.equal(src.state(), 'connected');
  assert.equal((await src.fetchUpcoming(60)).length, 1);
});

test('reconnecting as a different account forgets the old one', async () => {
  const browser = { account: 'ann@contoso.com' };
  const fake = fakeMicrosoft(browser);
  const store = memoryStore();
  const src = createMicrosoftSource({ getConfig: config, store, ...fake });
  await src.connect();
  browser.account = 'bob@contoso.com';
  await src.connect();
  assert.equal(src.accountLabel(), 'bob@contoso.com');
  const stored = JSON.parse(/** @type {string} */ (store.get('microsoft')));
  assert.equal(stored.homeAccountId, 'hid-bob@contoso.com');
  assert.deepEqual(Object.keys(JSON.parse(stored.cache).accounts), ['hid-bob@contoso.com']);
});

test('disconnect forgets the token cache', async () => {
  const fake = fakeMicrosoft({ account: 'ann@contoso.com' });
  const store = memoryStore();
  const src = createMicrosoftSource({ getConfig: config, store, ...fake });
  await src.connect();
  await src.disconnect();
  assert.equal(src.state(), 'disconnected');
  assert.equal(store.get('microsoft'), null);
});

test('connect without a client id explains what is missing', async () => {
  const src = createMicrosoftSource({ getConfig: () => ({ clientId: '', enabled: true }), store: memoryStore(), openExternal: async () => {} });
  assert.equal(src.isConfigured(), false);
  await assert.rejects(src.connect(), /clientId/);
  assert.equal(src.state(), 'disconnected');
});

test('accounts: two Microsoft accounts feed the registry; re-adding one replaces it; a cancelled add leaves nothing', async () => {
  const browser = { account: 'ann@contoso.com' };
  const fake = fakeMicrosoft(browser);
  const store = memoryStore();
  const accounts = createMicrosoftAccounts({ getConfig: config, store, ...fake, newKey: keys() });
  await accounts.add();
  browser.account = 'bob@outlook.com';
  await accounts.add();
  assert.deepEqual(store.list('microsoft-'), ['microsoft-k1', 'microsoft-k2']);

  const { events } = await createRegistry(() => accounts.sources()).fetchAll(60);
  assert.deepEqual(events.map((e) => [e.source, e.title]).sort(), [
    ['microsoft:k1', 'Sync (ann@contoso.com)'],
    ['microsoft:k2', 'Sync (bob@outlook.com)'],
  ]);

  browser.account = 'ANN@contoso.com';
  await accounts.add();
  assert.deepEqual(accounts.sources().map((s) => s.id), ['microsoft:k2', 'microsoft:k3']);
  assert.deepEqual(store.list('microsoft-'), ['microsoft-k2', 'microsoft-k3']);

  // Restart: both accounts come back from the store.
  const again = createMicrosoftAccounts({ getConfig: config, store, ...fake });
  assert.deepEqual(again.sources().map((s) => s.accountLabel()), ['bob@outlook.com', 'ANN@contoso.com']);

  /** @type {ReturnType<typeof createMicrosoftAccounts>} */
  let cancelling;
  cancelling = createMicrosoftAccounts({
    getConfig: config,
    store: memoryStore(),
    createClient: fake.createClient,
    newKey: keys(),
    openExternal: async () => void setImmediate(() => cancelling.sources()[0].cancelConnect()),
  });
  await assert.rejects(cancelling.add(), /cancelled/);
  assert.deepEqual(cancelling.sources(), []);
});
