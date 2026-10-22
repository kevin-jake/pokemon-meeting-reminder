// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findJoinUrlInText, safeHttpsUrl } = require('../src/main/calendar/meeting-links');
const { normalizeGoogleEvent } = require('../src/main/calendar/google');

const timed = {
  id: 'evt1',
  summary: 'Standup',
  start: { dateTime: '2026-10-22T09:00:00Z' },
  end: { dateTime: '2026-10-22T09:15:00Z' },
  htmlLink: 'https://www.google.com/calendar/event?eid=abc',
};

test('safeHttpsUrl only lets https through', () => {
  assert.equal(safeHttpsUrl('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
  for (const bad of ['http://example.com', 'file:///C:/Windows/System32/calc.exe', 'ms-settings:', 'javascript:alert(1)', 'not a url', 42, null]) {
    assert.equal(safeHttpsUrl(bad), null, String(bad));
  }
});

test('join links are found in plain-text and HTML descriptions', () => {
  assert.equal(findJoinUrlInText(['Room 4', 'Join: https://us02web.zoom.us/j/123456789?pwd=abc.']), 'https://us02web.zoom.us/j/123456789?pwd=abc');
  assert.equal(
    findJoinUrlInText(['<a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d">Join</a>']),
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d',
  );
  assert.equal(findJoinUrlInText([null, 'https://acme.webex.com/meet/jane']), 'https://acme.webex.com/meet/jane');
  assert.equal(findJoinUrlInText(['See https://example.com/agenda']), null);
});

test('Google: conference data wins, then hangoutLink, then links in location/description', () => {
  const withConference = normalizeGoogleEvent({
    ...timed,
    hangoutLink: 'https://meet.google.com/old-link-xyz',
    conferenceData: {
      entryPoints: [
        { entryPointType: 'phone', uri: 'tel:+1-555-0100' },
        { entryPointType: 'video', uri: 'https://zoom.us/j/999' },
      ],
    },
  });
  assert.equal(withConference?.joinUrl, 'https://zoom.us/j/999');
  assert.equal(normalizeGoogleEvent({ ...timed, hangoutLink: 'https://meet.google.com/abc-defg-hij' })?.joinUrl, 'https://meet.google.com/abc-defg-hij');
  assert.equal(normalizeGoogleEvent({ ...timed, location: 'https://meet.google.com/aaa-bbbb-ccc' })?.joinUrl, 'https://meet.google.com/aaa-bbbb-ccc');
});

test('Google: no video link leaves joinUrl null but keeps the invite link', () => {
  const e = normalizeGoogleEvent({ ...timed, location: 'Room 4' });
  assert.equal(e?.joinUrl, null);
  assert.equal(e?.link, 'https://www.google.com/calendar/event?eid=abc');
  assert.equal(normalizeGoogleEvent({ ...timed, htmlLink: 'javascript:alert(1)' })?.link, null);
});
