// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createBrowserBridge, normalizeBridgeMeeting, toastReminder, pairingCode } = require('../src/main/calendar/browser-bridge');

const MIN = 60_000;
const NOW = Date.parse('2026-10-22T08:00:00Z');
const TOKEN = 'test-token-0123456789abcdef';

/** @param {string} title @param {number} startMs */
const ev = (title, startMs) => ({ id: title, title, start: new Date(startMs), end: new Date(startMs + 30 * MIN), source: 'google' });

test('normalizeBridgeMeeting: valid meetings become events; malformed or unsafe parts are dropped', () => {
  const e = normalizeBridgeMeeting({
    id: 'o|1',
    title: ' Standup ',
    start: '2026-10-22T09:00:00.000Z',
    end: '2026-10-22T09:15:00.000Z',
    joinUrl: 'https://teams.microsoft.com/meet/123?p=x',
    link: 'javascript:alert(1)',
  });
  assert.ok(e);
  assert.equal(e.title, 'Standup');
  assert.equal(e.source, 'browser');
  assert.equal(e.start.toISOString(), '2026-10-22T09:00:00.000Z');
  assert.equal(e.joinUrl, 'https://teams.microsoft.com/meet/123?p=x');
  assert.equal(e.link, null);
  assert.equal(normalizeBridgeMeeting({ id: 'x', title: '', start: '2026-10-22T09:00:00Z' })?.title, '(No title)');
  for (const bad of [null, {}, { id: 'x', start: 'soon' }, { id: 'x', start: '2026-10-22T09:00:00Z', end: '2026-10-22T08:00:00Z' }, { id: 'x', start: '2026-10-22T09:00:00Z', cancelled: true }]) {
    assert.equal(normalizeBridgeMeeting(bad), null, JSON.stringify(bad));
  }
});

test('toastReminder: meeting-start toasts play the urgent scene; chat and mail toasts do nothing', () => {
  const teams = 'https://teams.microsoft.com';
  assert.deepEqual(toastReminder({ site: teams, title: 'Weekly sync', body: 'Meeting started' }, [], NOW), { title: 'Weekly sync', minutesUntil: 0 });
  // Generic title: the meeting name is in the body.
  assert.deepEqual(toastReminder({ site: teams, title: 'Meeting started', body: 'Weekly sync\nJoin now' }, [], NOW), { title: 'Weekly sync', minutesUntil: 0 });
  assert.equal(toastReminder({ site: teams, title: 'Alex', body: 'the build has started' }, [], NOW), null);
  assert.equal(toastReminder({ site: 'https://outlook.office.com', title: 'New mail from Sam', body: 'Lunch?' }, [], NOW), null);
});

test('toastReminder: Outlook "in N min" reminders play a warning', () => {
  assert.deepEqual(
    toastReminder({ site: 'https://outlook.office.com', title: 'Budget review', body: 'Starts in 15 minutes' }, [], NOW),
    { title: 'Budget review', minutesUntil: 15 },
  );
});

test('toastReminder: toasts for meetings the calendar already knows are left to the scheduler', () => {
  const events = [ev('Weekly sync', NOW)];
  assert.equal(toastReminder({ site: 'https://teams.microsoft.com', title: 'Weekly sync', body: 'Meeting started' }, events, NOW), null);
  // A same-named meeting tomorrow does not count.
  assert.ok(toastReminder({ site: 'https://teams.microsoft.com', title: 'Weekly sync', body: 'Meeting started' }, [ev('Weekly sync', NOW + 24 * 60 * MIN)], NOW));
});

test('pairingCode format matches what the extension parses', () => {
  assert.equal(pairingCode(47321, TOKEN), `pmr:47321:${TOKEN}`);
});

/**
 * Raw request so tests can set any Host / Authorization header.
 * @param {number} port
 * @param {{ method?: string, path: string, body?: unknown, token?: string | null, host?: string }} opts
 * @returns {Promise<{ status: number, body: string }>}
 */
function request(port, { method = 'GET', path, body, token = TOKEN, host = `127.0.0.1:${port}` }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          Host: host,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

test('bridge server: auth, Host check, snapshot → calendar source, toast de-duplication', async () => {
  let now = NOW;
  let changes = 0;
  /** @type {any[]} */
  const toasts = [];
  const bridge = createBrowserBridge({
    getConfig: () => ({ enabled: true, port: 0, token: TOKEN, toastReminders: true }),
    onMeetingsChanged: () => changes++,
    onToast: (t) => toasts.push(t),
    now: () => now,
  });
  await bridge.start();
  const port = bridge.port();
  try {
    assert.equal(bridge.statusLabel(), 'Outlook / Teams (browser): waiting for the extension…');
    assert.equal(bridge.source.isConnected(), false);

    assert.equal((await request(port, { path: '/v1/ping', token: null })).status, 401);
    assert.equal((await request(port, { path: '/v1/ping', token: 'wrong-token-0123456789abcd' })).status, 401);
    assert.equal((await request(port, { path: '/v1/ping', host: 'evil.example:80' })).status, 403);
    assert.equal((await request(port, { path: '/v1/ping' })).status, 200);
    assert.equal((await request(port, { path: '/v1/nope' })).status, 404);
    assert.equal((await request(port, { method: 'POST', path: '/v1/snapshot', body: undefined })).status, 400);

    const snapshot = {
      meetings: [
        { id: 'a', title: 'Standup', start: new Date(NOW + 10 * MIN).toISOString(), end: new Date(NOW + 25 * MIN).toISOString() },
        { id: 'b', title: 'Later', start: new Date(NOW + 3 * 60 * MIN).toISOString(), end: new Date(NOW + 4 * 60 * MIN).toISOString() },
      ],
    };
    assert.equal((await request(port, { method: 'POST', path: '/v1/snapshot', body: snapshot })).status, 204);
    assert.equal((await request(port, { method: 'POST', path: '/v1/snapshot', body: snapshot })).status, 204);
    assert.equal(changes, 1, 'an identical snapshot is not a change');
    assert.equal(bridge.source.isConnected(), true);
    assert.deepEqual((await bridge.source.fetchUpcoming(60)).map((e) => e.id), ['a']);
    assert.equal(bridge.statusLabel(), 'Outlook / Teams (browser): 2 meetings captured');

    const toast = { site: 'https://teams.microsoft.com', title: 'Sync', body: 'Meeting started' };
    await request(port, { method: 'POST', path: '/v1/toast', body: toast });
    await request(port, { method: 'POST', path: '/v1/toast', body: toast });
    assert.equal(toasts.length, 1, 'the same toast twice in a row plays once');
    now += 20 * MIN;
    await request(port, { method: 'POST', path: '/v1/toast', body: toast });
    assert.equal(toasts.length, 2);

    assert.match(bridge.statusLabel() ?? '', /browser not running \(last seen/);
    now += 13 * 60 * MIN;
    assert.equal(bridge.source.isConnected(), false, 'meetings go stale after 12 h without a push');
  } finally {
    bridge.stop();
  }
});

test('bridge: a disabled bridge does not listen and shows no tray row', async () => {
  const bridge = createBrowserBridge({
    getConfig: () => ({ enabled: false, port: 0, token: TOKEN, toastReminders: true }),
    onMeetingsChanged: () => {},
    onToast: () => {},
  });
  await bridge.start();
  assert.equal(bridge.statusLabel(), null);
  assert.equal(bridge.source.isEnabled(), false);
  bridge.stop();
});

test('bridge: a taken port falls back to a free one, reports it, and asks for a re-pair until the next push', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', () => resolve(undefined)));
  const taken = /** @type {import('node:net').AddressInfo} */ (blocker.address()).port;
  /** @type {number[]} */
  const reported = [];
  const bridge = createBrowserBridge({
    getConfig: () => ({ enabled: true, port: taken, token: TOKEN, toastReminders: true }),
    onMeetingsChanged: () => {},
    onToast: () => {},
    onPortChanged: (p) => reported.push(p),
  });
  await bridge.start();
  try {
    const port = bridge.port();
    assert.notEqual(port, taken);
    assert.deepEqual(reported, [port]);
    assert.equal(bridge.statusLabel(), 'Outlook / Teams (browser): ⚠ port changed, copy the pairing code again');
    assert.equal((await request(port, { method: 'POST', path: '/v1/snapshot', body: { meetings: [] } })).status, 204);
    assert.equal(bridge.statusLabel(), 'Outlook / Teams (browser): 0 meetings captured');
  } finally {
    bridge.stop();
    blocker.close();
  }
});
