// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIcalEvents, createIcalSource, normalizeFeedUrl, maskFeedUrl, googleCalendarIdOf } = require('../src/main/calendar/ical');
const { createIcalAccounts } = require('../src/main/calendar/ical-accounts');
const { ReconnectNeededError } = require('../src/main/calendar/types');

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-22T08:00:00Z'); // Thursday
const GOOGLE_URL = 'https://calendar.google.com/calendar/ical/jane%40example.com/private-0123456789abcdef0123456789abcdef/basic.ics';

const FEED = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
X-WR-CALNAME:jane@example.com
X-WR-TIMEZONE:Europe/Berlin
BEGIN:VTIMEZONE
TZID:Europe/Berlin
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=Europe/Berlin:20261022T110000
DTEND;TZID=Europe/Berlin:20261022T113000
UID:single@google.com
SUMMARY:Design review
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Berlin:20240101T100000
DTEND;TZID=Europe/Berlin:20240101T101500
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
EXDATE;TZID=Europe/Berlin:20261023T100000
UID:standup@google.com
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Berlin:20261022T103000
DTEND;TZID=Europe/Berlin:20261022T104500
RECURRENCE-ID;TZID=Europe/Berlin:20261022T100000
UID:standup@google.com
SUMMARY:Standup (moved)
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261022
DTEND;VALUE=DATE:20261023
UID:allday@google.com
SUMMARY:Holiday
END:VEVENT
BEGIN:VEVENT
DTSTART:20261022T120000Z
DTEND:20261022T130000Z
UID:cancelled@google.com
STATUS:CANCELLED
SUMMARY:Gone
END:VEVENT
BEGIN:VEVENT
DTSTART:20261022T140000Z
DTEND:20261022T150000Z
UID:declined@google.com
SUMMARY:Optional talk
ATTENDEE;CN=Jane;PARTSTAT=DECLINED:mailto:jane@example.com
ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com
END:VEVENT
BEGIN:VEVENT
DTSTART:20261022T150000Z
DTEND:20261022T153000Z
UID:teams@example.com
SUMMARY:Vendor call
DESCRIPTION:Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0
ATTENDEE;PARTSTAT=DECLINED:mailto:bob@example.com
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20261022T090000
DTEND;TZID=America/New_York:20261022T093000
UID:ny@example.com
SUMMARY:NY sync
END:VEVENT
END:VCALENDAR
`;

const parse = (/** @type {number} */ from, /** @type {number} */ to, selfEmails = ['jane@example.com']) =>
  parseIcalEvents(FEED, { from, to, source: 'ical:test', selfEmails });

test('iCal: meetings in the window, with zones, moved occurrences, exclusions and declines honoured', () => {
  const { events, calendarName } = parse(NOW - HOUR, NOW + 48 * HOUR);
  assert.equal(calendarName, 'jane@example.com');
  assert.deepEqual(
    events.map((e) => [e.title, e.start.toISOString(), e.id]),
    [
      // Thursday's standup moved to 10:30 Berlin (CEST, +2); Friday's is excluded.
      ['Standup (moved)', '2026-10-22T08:30:00.000Z', 'standup@google.com|2026-10-22T08:00:00.000Z'],
      ['Design review', '2026-10-22T09:00:00.000Z', 'single@google.com'],
      // TZID without a VTIMEZONE: read as the IANA zone (EDT, -4).
      ['NY sync', '2026-10-22T13:00:00.000Z', 'ny@example.com'],
      ['Vendor call', '2026-10-22T15:00:00.000Z', 'teams@example.com'],
    ],
  );
  const byTitle = Object.fromEntries(events.map((e) => [e.title, e]));
  assert.equal(byTitle['Design review'].joinUrl, 'https://meet.google.com/abc-defg-hij');
  assert.equal(byTitle['Vendor call'].joinUrl, 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0');
  assert.equal(byTitle['Design review'].source, 'ical:test');
});

test('iCal: a recurring series follows the zone across the DST change', () => {
  const monday = Date.parse('2026-10-26T00:00:00Z');
  const { events } = parse(monday, monday + 24 * HOUR);
  // 10:00 Berlin is 09:00Z once CET (+1) applies.
  assert.deepEqual(events.map((e) => [e.title, e.start.toISOString()]), [['Standup', '2026-10-26T09:00:00.000Z']]);
});

test('iCal: without knowing who the user is, declined invites still show', () => {
  const { events } = parse(NOW - HOUR, NOW + 48 * HOUR, []);
  assert.ok(events.some((e) => e.title === 'Optional talk'));
});

test('feed links: webcal becomes https, other links are refused, secrets are masked', () => {
  assert.equal(normalizeFeedUrl(` ${GOOGLE_URL} `), GOOGLE_URL);
  assert.equal(normalizeFeedUrl('webcal://example.com/cal/basic.ics'), 'https://example.com/cal/basic.ics');
  for (const bad of ['http://example.com/cal.ics', 'https://example.com/agenda', 'hello', '', null]) {
    assert.equal(normalizeFeedUrl(bad), null, String(bad));
  }
  assert.equal(maskFeedUrl(GOOGLE_URL), 'calendar.google.com/calendar/ical/jane%40example.com/private-•••/basic.ics');
  assert.equal(googleCalendarIdOf(GOOGLE_URL), 'jane@example.com');
  assert.equal(googleCalendarIdOf('https://outlook.office365.com/owa/calendar/abc/def/calendar.ics'), null);
});

/** In-memory stand-in for secure-store. */
function memoryStore() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return {
    m,
    get: (/** @type {string} */ k) => m.get(k) ?? null,
    set: (/** @type {string} */ k, /** @type {string} */ v) => (m.set(k, v), true),
    delete: (/** @type {string} */ k) => void m.delete(k),
    list: (/** @type {string} */ prefix) => [...m.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}

/**
 * Fake feed server: answers from `reply`, records each request's headers.
 * @param {{ reply: () => Response }} server
 */
function fakeFetch(server) {
  /** @type {Array<Record<string, string>>} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchFn = async (_url, init) => {
    calls.push(/** @type {Record<string, string>} */ ({ ...(init?.headers ?? {}) }));
    return server.reply();
  };
  return { fetchFn, calls };
}

const feedResponse = () => new Response(FEED, { status: 200, headers: { ETag: '"v1"', 'Content-Type': 'text/calendar' } });

test('iCal source: downloads at most every refreshMinutes, revalidates with the ETag, keeps the copy on 304', async () => {
  let now = NOW;
  const server = { reply: feedResponse };
  const { fetchFn, calls } = fakeFetch(server);
  const store = memoryStore();
  const source = createIcalSource({ id: 'ical:a', secretName: 'ical-a', store, getConfig: () => ({ enabled: true, refreshMinutes: 5 }), fetchFn, now: () => now });
  source.setUrl(GOOGLE_URL);
  await source.verify();
  assert.equal(source.accountLabel(), 'Google · jane@example.com');
  assert.deepEqual((await source.fetchUpcoming(120)).map((e) => e.title), ['Standup (moved)', 'Design review']);
  now += 2 * MIN;
  await source.fetchUpcoming(60);
  assert.equal(calls.length, 1, 'no download inside the refresh interval');

  now += 4 * MIN;
  server.reply = () => new Response(null, { status: 304 });
  assert.equal((await source.fetchUpcoming(120)).length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]['If-None-Match'], '"v1"');
  assert.ok(JSON.parse(/** @type {string} */ (store.get('ical-a'))).url === GOOGLE_URL);
});

test('iCal source: rate limiting backs off and keeps serving the last copy; a dead link needs a new one', async () => {
  let now = NOW;
  const server = { reply: feedResponse };
  const { fetchFn, calls } = fakeFetch(server);
  const source = createIcalSource({ id: 'ical:a', secretName: 'ical-a', store: memoryStore(), getConfig: () => ({ enabled: true, refreshMinutes: 5 }), fetchFn, now: () => now });
  source.setUrl(GOOGLE_URL);
  await source.verify();

  now += 6 * MIN;
  server.reply = () => new Response('slow down', { status: 429 });
  assert.deepEqual((await source.fetchUpcoming(120)).map((e) => e.title), ['Standup (moved)', 'Design review'], 'cached copy still used');
  assert.equal(calls.length, 2);
  now += 6 * MIN;
  await source.fetchUpcoming(120);
  assert.equal(calls.length, 2, 'backed off past the normal interval');

  now += 30 * MIN;
  server.reply = () => new Response('gone', { status: 404 });
  await assert.rejects(source.fetchUpcoming(120), ReconnectNeededError);
  assert.equal(source.state(), 'reconnect');
});

test('iCal source: a link that does not return a calendar is rejected', async () => {
  const { fetchFn } = fakeFetch({ reply: () => new Response('<html>Sign in</html>', { status: 200 }) });
  const source = createIcalSource({ id: 'ical:a', secretName: 'ical-a', store: memoryStore(), getConfig: () => ({ enabled: true, refreshMinutes: 5 }), fetchFn, now: () => NOW });
  source.setUrl(GOOGLE_URL);
  await assert.rejects(source.verify(), /did not return an iCalendar feed/);
});

test('iCal accounts: add checks the link, ignores duplicates, replace keeps the old link on failure, remove forgets it', async () => {
  const server = { reply: feedResponse };
  const { fetchFn } = fakeFetch(server);
  const store = memoryStore();
  let n = 0;
  const deps = { getConfig: () => ({ enabled: true, refreshMinutes: 5 }), store, fetchFn, now: () => NOW, newKey: () => `k${++n}` };
  const accounts = createIcalAccounts(deps);

  await assert.rejects(accounts.add('https://example.com/agenda'), /not a calendar link/);
  const a = await accounts.add(GOOGLE_URL);
  assert.equal(a.id, 'ical:k1');
  assert.equal(await accounts.add(`webcal://${GOOGLE_URL.slice('https://'.length)}`), a, 'same link → same entry');
  assert.deepEqual(store.list('ical-'), ['ical-k1']);

  server.reply = () => new Response('nope', { status: 404 });
  await assert.rejects(accounts.add('https://example.com/other.ics'), ReconnectNeededError);
  await assert.rejects(accounts.replace(a.id, 'https://example.com/new.ics'), ReconnectNeededError);
  assert.equal(a.feedUrl(), GOOGLE_URL, 'old link kept');
  assert.deepEqual(store.list('ical-'), ['ical-k1'], 'failed attempts leave nothing behind');

  // Restart: entries come back from the store.
  assert.deepEqual(createIcalAccounts(deps).sources().map((s) => s.id), ['ical:k1']);
  await accounts.remove(a.id);
  assert.deepEqual(accounts.sources(), []);
  assert.deepEqual(store.list('ical-'), []);
});
