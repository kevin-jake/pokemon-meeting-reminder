// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { statusText, mergeTitles, createPoller } = require('../src/main/poller');
const { createRegistry, dedupeEvents } = require('../src/main/calendar/registry');
const { createReminderScheduler } = require('../src/shared/reminder-scheduler');

const MIN = 60_000;
const NOW = new Date(2026, 9, 22, 9, 0).getTime();

/** @param {string} id @param {number} startMs @param {string} [source] @param {string} [title] */
const ev = (id, startMs, source = 'google', title = id) => ({ id, title, start: new Date(startMs), end: new Date(startMs + 30 * MIN), source });

/** @param {string} id @param {() => Promise<any[]>} fetchUpcoming @returns {import('../src/main/calendar/types').CalendarSource} */
const source = (id, fetchUpcoming) => ({
  id,
  name: id,
  connect: async () => {},
  disconnect: async () => {},
  cancelConnect: () => {},
  isConnected: () => true,
  isConfigured: () => true,
  isEnabled: () => true,
  state: () => 'connected',
  accountLabel: () => null,
  fetchUpcoming,
});

test('statusText covers not connected, idle and next meeting', () => {
  const base = { now: NOW, connected: 1, failed: [], lookaheadMinutes: 60 };
  assert.equal(statusText({ ...base, events: [], connected: 0 }), 'Not connected');
  assert.equal(statusText({ ...base, events: [] }), 'No meetings in the next hour');
  assert.equal(statusText({ ...base, events: [ev('Standup', NOW + 12 * MIN)] }), 'Next: Standup at 09:12 (in 12 min)');
  // In-progress meetings are skipped for "next".
  assert.equal(statusText({ ...base, events: [ev('Now', NOW - MIN), ev('Later', NOW + 30 * MIN)], failed: ['Google'] }), 'Next: Later at 09:30 (in 30 min) · Google unavailable');
});

test('mergeTitles keeps the "+ N more" suffix within the banner cap', () => {
  assert.equal(mergeTitles(['Standup']), 'Standup');
  assert.equal(mergeTitles(['Standup', 'Sync']), 'Standup + 1 more');
  const long = mergeTitles(['A very long meeting title that goes on and on', 'b', 'c']);
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('… + 2 more'));
});

test('registry: one failing source does not block another; duplicates across sources collapse', async () => {
  const reg = createRegistry([
    source('google', async () => [ev('g1', NOW + 10 * MIN, 'google', 'Standup'), ev('g2', NOW + 20 * MIN, 'google', 'Review')]),
    source('microsoft', async () => [ev('m1', NOW + 10 * MIN, 'microsoft', ' standup ')]),
    source('broken', async () => {
      throw new Error('offline');
    }),
  ]);
  const r = await reg.fetchAll(60);
  assert.deepEqual(r.events.map((e) => e.id), ['g1', 'g2']);
  assert.equal(r.errors.length, 1);
  assert.equal(r.polled, 3);
  assert.deepEqual(dedupeEvents([]), []);
});

test('poller fires due reminders, reports status and keeps cached events when every source fails', async () => {
  let fail = false;
  const reg = createRegistry([
    source('google', async () => {
      if (fail) throw new Error('offline');
      return [ev('a', NOW + 3 * MIN)];
    }),
  ]);
  let now = NOW;
  /** @type {string[]} */
  const fired = [];
  /** @type {string[]} */
  const statuses = [];
  const poller = createPoller({
    registry: reg,
    scheduler: createReminderScheduler(),
    getSettings: () => ({ pollIntervalSec: 60, lookaheadMinutes: 60, alertMinutesBefore: 5 }),
    onReminders: (due) => fired.push(...due.map((d) => `${d.event.id}:${d.kind}`)),
    onStatus: (s) => statuses.push(s),
    now: () => now,
  });
  await poller.pollNow();
  assert.deepEqual(fired, ['a:warn']);
  assert.equal(statuses.at(-1), 'Next: a at 09:03 (in 3 min)');
  fail = true;
  now = NOW + 3 * MIN;
  await poller.pollNow();
  assert.deepEqual(fired, ['a:warn', 'a:start']);
  assert.match(/** @type {string} */ (statuses.at(-1)), /google unavailable/);
  poller.stop();
});

test('dedupe keeps the first copy but borrows a join link from the duplicate it drops', () => {
  const g = { ...ev('g1', NOW + 10 * MIN, 'google:a', 'Standup'), link: 'https://calendar.google.com/e/g1' };
  const m = { ...ev('m1', NOW + 10 * MIN, 'microsoft:b', 'STANDUP'), joinUrl: 'https://teams.microsoft.com/l/meetup-join/x', link: 'https://outlook.office.com/m1' };
  const [kept, ...rest] = dedupeEvents([g, m]);
  assert.equal(rest.length, 0);
  assert.equal(kept.id, 'g1');
  assert.equal(kept.joinUrl, m.joinUrl);
  assert.equal(kept.link, g.link);
});
