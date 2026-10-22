// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleAccounts } = require('../src/main/calendar/google-accounts');
const { createRegistry } = require('../src/main/calendar/registry');

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

const config = () => ({ clientId: 'cid', clientSecret: 'cs', enabled: true, allCalendars: false });
const tokens = (/** @type {string} */ account) =>
  JSON.stringify({ refreshToken: `rt-${account}`, accessToken: `at-${account}`, expiresAt: Date.now() + 3600_000, account });
const json = (/** @type {number} */ status, /** @type {any} */ body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Sequential keys so tests can predict secret names. */
const keys = () => {
  let n = 0;
  return () => `k${++n}`;
};

/**
 * Fake Google: the token endpoint issues tokens and /calendars/primary
 * answers with whichever account the "browser" picked last.
 * @param {{ account: string }} browser
 */
function fakeGoogle(browser) {
  /** @type {typeof fetch} */
  const fetchFn = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/token') return json(200, { access_token: `at-${browser.account}`, refresh_token: `rt-${browser.account}`, expires_in: 3600 });
    if (url.pathname === '/revoke') return new Response('', { status: 200 });
    if (url.pathname.endsWith('/calendars/primary')) return json(200, { id: browser.account });
    if (url.pathname.endsWith('/events')) {
      const who = String(/** @type {any} */ (init?.headers).Authorization).slice('Bearer at-'.length);
      return json(200, { items: [{ id: 'e1', summary: `Sync (${who})`, start: { dateTime: '2026-10-22T09:00:00Z' }, end: { dateTime: '2026-10-22T09:30:00Z' } }] });
    }
    throw new Error(`unexpected ${url}`);
  };
  /** Follows the consent redirect back to the loopback server, like a browser would. @param {string} authUrl */
  const openExternal = async (authUrl) => {
    const u = new URL(authUrl);
    const back = new URL(/** @type {string} */ (u.searchParams.get('redirect_uri')));
    back.searchParams.set('code', 'c');
    back.searchParams.set('state', /** @type {string} */ (u.searchParams.get('state')));
    setImmediate(() => void globalThis.fetch(back));
  };
  return { fetchFn, openExternal };
}

test('the single-account secret is migrated to a per-account entry', () => {
  const store = memoryStore({ google: tokens('a@x.com') });
  const accounts = createGoogleAccounts({ getConfig: config, store, openExternal: async () => {}, newKey: keys() });
  assert.equal(store.get('google'), null);
  assert.deepEqual(store.list('google-'), ['google-k1']);
  assert.deepEqual(accounts.sources().map((s) => [s.id, s.accountLabel(), s.state()]), [['google:k1', 'a@x.com', 'connected']]);
});

test('existing accounts load from the store; unreadable entries are skipped', () => {
  const store = memoryStore({ 'google-aa': tokens('a@x.com'), 'google-bb': tokens('b@y.com'), 'google-cc': 'garbage' });
  const accounts = createGoogleAccounts({ getConfig: config, store, openExternal: async () => {} });
  assert.deepEqual(accounts.sources().map((s) => s.accountLabel()), ['a@x.com', 'b@y.com']);
});

test('add() signs in a second account; both feed the registry with their own source ids', async () => {
  const browser = { account: 'b@y.com' };
  const { fetchFn, openExternal } = fakeGoogle(browser);
  const store = memoryStore({ 'google-k0': tokens('a@x.com') });
  const accounts = createGoogleAccounts({ getConfig: config, store, openExternal, fetchFn, newKey: keys() });
  let started = 0;
  const added = await accounts.add(() => {
    started += 1;
    assert.equal(accounts.sources().at(-1)?.state(), 'connecting');
  });
  assert.equal(started, 1);
  assert.equal(added.accountLabel(), 'b@y.com');
  assert.deepEqual(store.list('google-'), ['google-k0', 'google-k1']);

  const { events } = await createRegistry(() => accounts.sources()).fetchAll(60);
  assert.deepEqual(events.map((e) => [e.source, e.title]).sort(), [
    ['google:k0', 'Sync (a@x.com)'],
    ['google:k1', 'Sync (b@y.com)'],
  ]);
});

test('adding an account that is already connected replaces the old entry without revoking', async () => {
  const browser = { account: 'A@x.com' };
  const { fetchFn, openExternal } = fakeGoogle(browser);
  /** @type {string[]} */
  const revoked = [];
  /** @type {typeof fetch} */
  const spy = async (input, init) => {
    if (String(input).includes('/revoke')) revoked.push(String(input));
    return fetchFn(input, init);
  };
  const store = memoryStore({ 'google-k0': tokens('a@x.com') });
  const accounts = createGoogleAccounts({ getConfig: config, store, openExternal, fetchFn: spy, newKey: keys() });
  await accounts.add();
  assert.deepEqual(accounts.sources().map((s) => s.id), ['google:k1']);
  assert.deepEqual(store.list('google-'), ['google-k1']);
  assert.deepEqual(revoked, []);
});

test('a cancelled add leaves nothing behind', async () => {
  const store = memoryStore();
  /** @type {ReturnType<typeof createGoogleAccounts>} */
  let accounts;
  accounts = createGoogleAccounts({
    getConfig: config,
    store,
    newKey: keys(),
    openExternal: async () => void setImmediate(() => accounts.sources()[0].cancelConnect()),
  });
  await assert.rejects(accounts.add(), /cancelled/);
  assert.deepEqual(accounts.sources(), []);
  assert.deepEqual(store.list('google-'), []);
});

test('remove() revokes and forgets just that account', async () => {
  const { fetchFn, openExternal } = fakeGoogle({ account: 'unused' });
  const store = memoryStore({ 'google-aa': tokens('a@x.com'), 'google-bb': tokens('b@y.com') });
  const accounts = createGoogleAccounts({ getConfig: config, store, openExternal, fetchFn });
  await accounts.remove('google:aa');
  assert.deepEqual(accounts.sources().map((s) => s.accountLabel()), ['b@y.com']);
  assert.deepEqual(store.list('google-'), ['google-bb']);
});

test('reconnect pre-selects the expired account with login_hint', async () => {
  /** @type {string | null} */
  let hint = null;
  const browser = { account: 'a@x.com' };
  const { fetchFn, openExternal } = fakeGoogle(browser);
  const store = memoryStore({ 'google-aa': tokens('a@x.com') });
  const accounts = createGoogleAccounts({
    getConfig: config,
    store,
    fetchFn,
    openExternal: async (url) => {
      hint = new URL(url).searchParams.get('login_hint');
      assert.equal(new URL(url).searchParams.get('prompt'), 'select_account consent');
      return openExternal(url);
    },
  });
  await accounts.reconnect('google:aa');
  assert.equal(hint, 'a@x.com');
  assert.equal(accounts.find('google:aa')?.state(), 'connected');
});
