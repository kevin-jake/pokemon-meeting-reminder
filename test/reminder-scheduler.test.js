// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReminderScheduler, START_GRACE_MS } = require('../src/shared/reminder-scheduler');

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 22, 9, 0);

/** @param {string} id @param {number} startMs @returns {import('../src/main/calendar/types').CalendarEvent} */
const ev = (id, startMs, title = id) => ({ id, title, start: new Date(startMs), end: new Date(startMs + 30 * MIN), source: 'google' });

/** @param {ReturnType<ReturnType<typeof createReminderScheduler>['ingest']>} r */
const kinds = (r) => r.due.map((d) => `${d.event.id}:${d.kind}`);

test('warns inside the alert window, not before', () => {
  const s = createReminderScheduler({ alertMinutes: 5 });
  const meeting = ev('a', T0 + 10 * MIN);
  assert.deepEqual(kinds(s.ingest([meeting], T0)), []);
  assert.deepEqual(kinds(s.ingest([meeting], T0 + 4 * MIN)), []);
  assert.deepEqual(kinds(s.ingest([meeting], T0 + 5 * MIN)), ['a:warn']);
});

test('never fires the same reminder twice', () => {
  const s = createReminderScheduler({ alertMinutes: 5 });
  const meeting = ev('a', T0 + 3 * MIN);
  assert.deepEqual(kinds(s.ingest([meeting], T0)), ['a:warn']);
  assert.deepEqual(kinds(s.ingest([meeting], T0 + MIN)), []);
  assert.deepEqual(kinds(s.ingest([meeting], T0 + 3 * MIN)), ['a:start']);
  assert.deepEqual(kinds(s.ingest([meeting], T0 + 3 * MIN + 30_000)), []);
});

test('the start alarm fires at start time, then only within the grace period', () => {
  const s = createReminderScheduler({ alertMinutes: 5 });
  assert.deepEqual(kinds(s.ingest([ev('late', T0 - START_GRACE_MS + 1000)], T0)), ['late:start']);
  // Launching the app well into a meeting does not sound the alarm, nor a stale warning.
  assert.deepEqual(kinds(s.ingest([ev('old', T0 - 10 * MIN)], T0)), []);
});

test('first seeing a meeting right at its start only fires the alarm', () => {
  const s = createReminderScheduler({ alertMinutes: 5 });
  const meeting = ev('a', T0);
  assert.deepEqual(kinds(s.ingest([meeting], T0)), ['a:start']);
  assert.deepEqual(kinds(s.ingest([meeting], T0 + MIN)), []);
});

test('a rescheduled meeting alerts again', () => {
  const s = createReminderScheduler({ alertMinutes: 5 });
  assert.deepEqual(kinds(s.ingest([ev('a', T0 + 4 * MIN)], T0)), ['a:warn']);
  assert.deepEqual(kinds(s.ingest([ev('a', T0 + 8 * MIN)], T0 + MIN)), []);
  assert.deepEqual(kinds(s.ingest([ev('a', T0 + 8 * MIN)], T0 + 3 * MIN)), ['a:warn']);
});

test('widening the alert window fires meetings that are now inside it', () => {
  const s = createReminderScheduler({ alertMinutes: 5 });
  const meeting = ev('a', T0 + 8 * MIN);
  assert.deepEqual(kinds(s.ingest([meeting], T0)), []);
  s.setAlertMinutes(10);
  assert.deepEqual(kinds(s.ingest([meeting], T0)), ['a:warn']);
});

test('next is the earliest future reminder moment', () => {
  const s = createReminderScheduler({ alertMinutes: 5 });
  assert.equal(s.ingest([ev('a', T0 + 20 * MIN), ev('b', T0 + 12 * MIN)], T0).next, T0 + 7 * MIN);
  // Once the warning fired, the next moment is the start itself.
  const after = s.ingest([ev('b', T0 + 12 * MIN)], T0 + 7 * MIN);
  assert.deepEqual(kinds(after), ['b:warn']);
  assert.equal(after.next, T0 + 12 * MIN);
  assert.equal(s.ingest([], T0).next, null);
});

test('prune forgets meetings that started over an hour ago', () => {
  const s = createReminderScheduler({ alertMinutes: 5 });
  s.ingest([ev('a', T0 + MIN)], T0);
  s.ingest([ev('a', T0 + MIN)], T0 + MIN);
  assert.equal(s.firedCount(), 2);
  s.prune(T0 + 30 * MIN);
  assert.equal(s.firedCount(), 2);
  s.prune(T0 + 62 * MIN);
  assert.equal(s.firedCount(), 0);
});

test('events from different sources with the same id are tracked separately', () => {
  const s = createReminderScheduler({ alertMinutes: 5 });
  const a = ev('x', T0 + 2 * MIN);
  // Same provider id by coincidence, different meeting.
  const b = { ...a, source: 'microsoft', title: 'Another meeting' };
  assert.equal(s.ingest([a, b], T0).due.length, 2);
});

test('the same meeting on two calendars fires once, even when the copy that fired drops out', () => {
  const s = createReminderScheduler({ alertMinutes: 5 });
  const google = { ...ev('g', T0 + 3 * MIN, 'Standup'), source: 'google:a' };
  const microsoft = { ...ev('m', T0 + 3 * MIN, ' standup '), source: 'microsoft:b' };
  assert.deepEqual(kinds(s.ingest([google], T0)), ['g:warn']);
  // Google failed this poll, so only the Microsoft copy is left.
  assert.deepEqual(kinds(s.ingest([microsoft], T0 + MIN)), []);
  assert.deepEqual(kinds(s.ingest([microsoft], T0 + 3 * MIN)), ['m:start']);
  assert.deepEqual(kinds(s.ingest([google], T0 + 3 * MIN + 1000)), []);
  // A different meeting at the same time still fires.
  assert.deepEqual(kinds(s.ingest([{ ...microsoft, id: 'x', title: '1:1' }], T0 + 3 * MIN + 2000)), ['x:start']);
});
