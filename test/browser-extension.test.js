// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractMeetings, parseWhen } = require('../browser-extension/lib/extract');
const { mergeMeetings, snapshotOf, parsePairingCode } = require('../browser-extension/lib/meetings');

const NOW = Date.parse('2026-10-22T08:00:00Z');
const MIN = 60_000;
const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d';

/** Exchange JSON as OWA's service.svc returns it. */
const owaResponse = {
  Body: {
    ResponseMessages: {
      Items: [
        {
          RootFolder: {
            Items: [
              {
                __type: 'CalendarItem:#Exchange',
                ItemId: { Id: 'AAMk1', ChangeKey: 'x' },
                Subject: ' Standup ',
                Start: '2026-10-22T10:00:00+02:00',
                End: '2026-10-22T10:15:00+02:00',
                IsAllDayEvent: false,
                MyResponseType: 'Accept',
                Location: { DisplayName: 'Microsoft Teams Meeting' },
              },
              {
                __type: 'CalendarItem:#Exchange',
                ItemId: { Id: 'AAMk2' },
                Subject: 'Holiday',
                Start: '2026-10-22T00:00:00+02:00',
                End: '2026-10-23T00:00:00+02:00',
                IsAllDayEvent: true,
              },
              {
                __type: 'CalendarItem:#Exchange',
                ItemId: { Id: 'AAMk3' },
                Subject: 'Skipped sync',
                Start: '2026-10-22T11:00:00+02:00',
                End: '2026-10-22T11:30:00+02:00',
                MyResponseType: 'Decline',
              },
            ],
          },
        },
      ],
    },
  },
};

test('extract: Exchange JSON calendar items, all-day skipped, declined flagged', () => {
  const items = extractMeetings(owaResponse, { now: NOW });
  assert.deepEqual(
    items.map((m) => [m.id, m.title, m.start, m.declined]),
    [
      ['AAMk1', 'Standup', '2026-10-22T08:00:00.000Z', false],
      ['AAMk3', 'Skipped sync', '2026-10-22T09:00:00.000Z', true],
    ],
  );
});

test('extract: mails and meeting requests are not meetings', () => {
  const inbox = [
    { __type: 'Message:#Exchange', Subject: 'Lunch?', ItemId: { Id: 'm1' } },
    { __type: 'MeetingRequestMessage:#Exchange', Subject: 'Invite', Start: '2026-10-22T10:00:00Z', End: '2026-10-22T11:00:00Z' },
    { __type: 'MeetingCancellationMessage:#Exchange', Subject: 'Cancelled', Start: '2026-10-22T10:00:00Z', End: '2026-10-22T11:00:00Z' },
  ];
  assert.deepEqual(extractMeetings(inbox, { now: NOW }), []);
});

test('extract: Teams calendarView shape with join link and cancelled flag', () => {
  const teams = {
    value: [
      { objectId: 't1', subject: 'Design review', startTime: '2026-10-22T09:00:00Z', endTime: '2026-10-22T10:00:00Z', skypeTeamsMeetingUrl: TEAMS, isCancelled: false },
      { objectId: 't2', subject: 'Old sync', startTime: '2026-10-22T12:00:00Z', endTime: '2026-10-22T12:30:00Z', isCancelled: true },
    ],
  };
  const [a, b] = extractMeetings(teams, { now: NOW });
  assert.equal(a.id, 't1');
  assert.equal(a.joinUrl, TEAMS);
  assert.equal(b.cancelled, true);
});

test('extract: Graph-like { dateTime, timeZone } pairs and join links found in the body', () => {
  const graph = {
    value: [
      {
        id: 'g1',
        subject: 'Planning',
        start: { dateTime: '2026-10-22T13:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-10-22T14:00:00.0000000', timeZone: 'UTC' },
        body: { content: `<a href="${TEAMS}">Join</a>` },
      },
    ],
  };
  const [m] = extractMeetings(graph, { now: NOW });
  assert.equal(m.start, '2026-10-22T13:00:00.000Z');
  assert.equal(m.joinUrl, TEAMS);
});

test('extract: outside [now - 1 h, now + 14 d] is ignored; repeated ids stay distinct', () => {
  const series = ['2026-10-22T09:00:00Z', '2026-10-23T09:00:00Z', '2026-12-01T09:00:00Z', '2026-10-21T09:00:00Z'].map((s) => ({
    id: 'series',
    subject: 'Daily',
    start: s,
    end: new Date(Date.parse(s) + 15 * MIN).toISOString(),
  }));
  const items = extractMeetings(series, { now: NOW });
  assert.deepEqual(items.map((m) => m.id), ['series#2026-10-22T09:00:00.000Z', 'series#2026-10-23T09:00:00.000Z']);
});

test('parseWhen: offsets exact, UTC zone honoured, garbage rejected', () => {
  assert.equal(parseWhen('2026-10-22T10:00:00+02:00'), Date.parse('2026-10-22T08:00:00Z'));
  assert.equal(parseWhen({ dateTime: '2026-10-22T10:00:00', timeZone: 'UTC' }), Date.parse('2026-10-22T10:00:00Z'));
  assert.equal(parseWhen('2026-10-22T10:00:00'), new Date(2026, 9, 22, 10, 0).getTime()); // local time
  for (const bad of ['tomorrow', '2026-10-22', 42, null, {}]) assert.equal(parseWhen(bad), null, String(bad));
});

test('merge: captures from several tabs merge by id; cancelled copies remove; ended ones drop', () => {
  const origin = 'https://outlook.office.com';
  const base = { title: 'Standup', start: '2026-10-22T09:00:00Z', end: '2026-10-22T09:15:00Z' };
  let store = mergeMeetings({}, origin, [{ ...base, id: 'a' }, { ...base, id: 'b', title: 'Review' }], NOW);
  store = mergeMeetings(store, 'https://teams.microsoft.com', [{ ...base, id: 't', joinUrl: TEAMS }], NOW);
  assert.equal(Object.keys(store).length, 3);
  store = mergeMeetings(store, origin, [{ ...base, id: 'b', cancelled: true }], NOW);
  const snap = snapshotOf(store);
  assert.deepEqual(snap.map((m) => m.id), ['https://outlook.office.com|a', 'https://teams.microsoft.com|t']);
  assert.equal(snap[0].link, 'https://outlook.office.com/calendar/view/day');
  assert.equal(snap[1].link, null);
  // Two hours later both have ended.
  assert.deepEqual(snapshotOf(mergeMeetings(store, origin, [], NOW + 120 * MIN)), []);
});

test('pairing codes parse; anything else is rejected', () => {
  assert.deepEqual(parsePairingCode(' pmr:47321:abcdefghijklmnopqrstuvwx '), { port: 47321, token: 'abcdefghijklmnopqrstuvwx' });
  for (const bad of ['', 'pmr:99999:abcdefghijklmnopqrstuvwx', 'pmr:47321:short', 'http://127.0.0.1:47321', null]) {
    assert.equal(parsePairingCode(bad), null, String(bad));
  }
});
