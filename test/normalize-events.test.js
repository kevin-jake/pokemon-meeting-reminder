// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGoogleEvent } = require('../src/main/calendar/google');
const { normalizeGraphEvent, parseGraphDateTime } = require('../src/main/calendar/microsoft');

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

const graph = {
  id: 'AAMk1',
  subject: '  Planning ',
  isAllDay: false,
  isCancelled: false,
  responseStatus: { response: 'accepted' },
  start: { dateTime: '2026-10-22T16:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-10-22T16:30:00.0000000', timeZone: 'UTC' },
  webLink: 'https://outlook.office365.com/owa/?itemid=AAMk1',
};

test('Graph: UTC times without a Z are parsed as UTC; titles trimmed', () => {
  const e = normalizeGraphEvent(graph);
  assert.ok(e);
  assert.equal(e.id, 'AAMk1');
  assert.equal(e.title, 'Planning');
  assert.equal(e.source, 'microsoft');
  assert.equal(e.start.toISOString(), '2026-10-22T16:00:00.000Z');
  assert.equal(e.end.toISOString(), '2026-10-22T16:30:00.000Z');
  assert.equal(e.link, graph.webLink);
  assert.equal(normalizeGraphEvent({ ...graph, subject: '' })?.title, '(No title)');
});

test('Graph: date-time parsing keeps milliseconds, honours explicit offsets and rejects other zones', () => {
  assert.equal(parseGraphDateTime({ dateTime: '2026-10-22T16:00:00.1234567', timeZone: 'UTC' })?.toISOString(), '2026-10-22T16:00:00.123Z');
  assert.equal(parseGraphDateTime({ dateTime: '2026-10-22T09:00:00-07:00' })?.toISOString(), '2026-10-22T16:00:00.000Z');
  assert.equal(parseGraphDateTime({ dateTime: '2026-10-22T16:00:00', timeZone: 'Pacific Standard Time' }), null);
  assert.equal(parseGraphDateTime({ dateTime: 'garbage', timeZone: 'UTC' }), null);
  assert.equal(parseGraphDateTime(undefined), null);
});

test('Graph: all-day, cancelled and declined events are skipped', () => {
  assert.equal(normalizeGraphEvent({ ...graph, isAllDay: true }), null);
  assert.equal(normalizeGraphEvent({ ...graph, isCancelled: true }), null);
  assert.equal(normalizeGraphEvent({ ...graph, responseStatus: { response: 'declined' } }), null);
  for (const response of ['none', 'organizer', 'tentativelyAccepted', 'notResponded']) {
    assert.ok(normalizeGraphEvent({ ...graph, responseStatus: { response } }), response);
  }
});

test('Graph: join link from the Teams meeting, the legacy field, or the location/body', () => {
  const teams = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0';
  assert.equal(normalizeGraphEvent({ ...graph, onlineMeeting: { joinUrl: teams } })?.joinUrl, teams);
  assert.equal(normalizeGraphEvent({ ...graph, onlineMeetingUrl: teams })?.joinUrl, teams);
  assert.equal(
    normalizeGraphEvent({ ...graph, bodyPreview: 'Join Zoom: https://acme.zoom.us/j/123456789 thanks' })?.joinUrl,
    'https://acme.zoom.us/j/123456789',
  );
  assert.equal(normalizeGraphEvent({ ...graph, onlineMeeting: { joinUrl: 'javascript:alert(1)' } })?.joinUrl, null);
});
