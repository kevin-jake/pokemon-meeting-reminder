// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGoogleEvent } = require('../src/main/calendar/google');

const timed = {
  id: 'evt1',
  summary: '  Standup ',
  status: 'confirmed',
  eventType: 'default',
  start: { dateTime: '2026-10-22T09:00:00-07:00' },
  end: { dateTime: '2026-10-22T09:15:00-07:00' },
};

test('Google: timed events normalize with offsets applied and titles trimmed', () => {
  const e = normalizeGoogleEvent(timed);
  assert.ok(e);
  assert.equal(e.id, 'evt1');
  assert.equal(e.title, 'Standup');
  assert.equal(e.source, 'google');
  assert.equal(e.start.toISOString(), '2026-10-22T16:00:00.000Z');
  assert.equal(e.end.toISOString(), '2026-10-22T16:15:00.000Z');
});

test('Google: untitled events get a placeholder title', () => {
  assert.equal(normalizeGoogleEvent({ ...timed, summary: undefined })?.title, '(No title)');
});

test('Google: all-day, cancelled and declined events are skipped', () => {
  assert.equal(normalizeGoogleEvent({ ...timed, start: { date: '2026-10-22' }, end: { date: '2026-10-23' } }), null);
  assert.equal(normalizeGoogleEvent({ ...timed, status: 'cancelled' }), null);
  assert.equal(
    normalizeGoogleEvent({ ...timed, attendees: [{ email: 'x@y', responseStatus: 'accepted' }, { self: true, responseStatus: 'declined' }] }),
    null,
  );
});

test('Google: accepted / tentative / no-response invites still fire', () => {
  for (const responseStatus of ['accepted', 'tentative', 'needsAction']) {
    assert.ok(normalizeGoogleEvent({ ...timed, attendees: [{ self: true, responseStatus }] }), responseStatus);
  }
  // Someone else declining does not matter.
  assert.ok(normalizeGoogleEvent({ ...timed, attendees: [{ responseStatus: 'declined' }] }));
});

test('Google: working-location, out-of-office and focus-time blocks are skipped', () => {
  for (const eventType of ['workingLocation', 'outOfOffice', 'focusTime']) {
    assert.equal(normalizeGoogleEvent({ ...timed, eventType }), null, eventType);
  }
});
