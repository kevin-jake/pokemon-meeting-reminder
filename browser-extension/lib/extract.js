// @ts-check
// Finds calendar items in JSON that Outlook on the web / Teams already
// downloaded for themselves. Neither app documents its internal APIs, so this
// does not depend on URLs or one response shape: it walks any JSON and keeps
// objects that look like a meeting (a title plus a start and an end). Known
// shapes: Exchange JSON (OWA service.svc: Subject / Start / End / ItemId),
// Teams calendarView (subject / startTime / endTime / objectId) and Graph-like
// ({ dateTime, timeZone } pairs).
// UMD: a page-world content script in the browser, require() in node tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).__pmrExtract = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TITLE_KEYS = ['Subject', 'subject', 'Title', 'title'];
  const START_KEYS = ['Start', 'start', 'StartDate', 'startDate', 'StartTime', 'startTime', 'startDateTime'];
  const END_KEYS = ['End', 'end', 'EndDate', 'endDate', 'EndTime', 'endTime', 'endDateTime'];
  const ID_KEYS = ['ItemId', 'itemId', 'id', 'Id', 'objectId', 'ObjectId', 'iCalUId', 'UID'];
  const ALL_DAY_KEYS = ['IsAllDayEvent', 'isAllDayEvent', 'IsAllDay', 'isAllDay'];
  const CANCELLED_KEYS = ['IsCancelled', 'isCancelled'];
  const RESPONSE_KEYS = ['ResponseType', 'MyResponseType', 'myResponseType', 'responseStatus', 'responseType'];
  const JOIN_KEYS = ['OnlineMeetingJoinUrl', 'onlineMeetingJoinUrl', 'onlineMeetingUrl', 'skypeTeamsMeetingUrl', 'joinUrl', 'JoinUrl', 'joinWebUrl'];
  const TEAMS_LINK = /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>\\]+/i;
  const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
  const DAY_MS = 24 * 60 * 60_000;
  /** Stops a pathological response from freezing the page. */
  const MAX_NODES = 200_000;
  const MAX_DEPTH = 16;

  /** @param {any} obj @param {string[]} keys */
  function pick(obj, keys) {
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    return undefined;
  }

  /**
   * ms epoch, or null. Strings with an offset are exact; { dateTime, timeZone }
   * honours timeZone "UTC"; anything else without an offset is read as local
   * time (the mailbox time zone is almost always the PC's).
   * @param {unknown} value
   * @param {unknown} [timeZone]
   * @returns {number | null}
   */
  function parseWhen(value, timeZone) {
    if (value && typeof value === 'object') {
      const v = /** @type {any} */ (value);
      return parseWhen(v.dateTime ?? v.DateTime, v.timeZone ?? v.TimeZone);
    }
    if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) return null;
    let text = value.trim();
    if (!HAS_OFFSET.test(text) && typeof timeZone === 'string' && /^(?:utc|etc\/utc|gmt)$/i.test(timeZone)) text += 'Z';
    // Date parses an ISO date-time without an offset as local time.
    const ms = new Date(text).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  /** @param {unknown} v */
  const asId = (v) => {
    if (v && typeof v === 'object') v = /** @type {any} */ (v).Id ?? /** @type {any} */ (v).id;
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
  };

  /** @param {any} obj */
  function joinUrlOf(obj) {
    const direct = pick(obj, JOIN_KEYS) ?? obj.onlineMeeting?.joinUrl ?? obj.OnlineMeeting?.JoinUrl;
    if (typeof direct === 'string' && direct.startsWith('https://')) return direct;
    let text = '';
    try {
      text = JSON.stringify(obj);
    } catch {
      return null;
    }
    const m = text.length < 500_000 ? text.match(TEAMS_LINK) : null;
    return m ? m[0].replace(/[.,;)\]]+$/, '') : null;
  }

  /**
   * One object → meeting, or null when it does not look like a calendar item.
   * Cancelled and declined meetings are returned flagged, so a newer copy can
   * remove an older one.
   * @param {any} obj
   */
  function toMeeting(obj) {
    // Exchange JSON tags item types; only calendar items are meetings
    // (meeting request / cancellation mails also carry Start and End).
    if (typeof obj.__type === 'string' && !/CalendarItem/i.test(obj.__type)) return null;
    const title = pick(obj, TITLE_KEYS);
    if (typeof title !== 'string') return null;
    const startRaw = pick(obj, START_KEYS);
    const endRaw = pick(obj, END_KEYS);
    const tz = obj.timeZone ?? obj.TimeZone ?? obj.StartTimeZoneId;
    const start = parseWhen(startRaw, tz);
    const end = parseWhen(endRaw, tz);
    if (start === null || end === null || end < start) return null;
    if (pick(obj, ALL_DAY_KEYS) === true || end - start >= DAY_MS - 60_000) return null;
    const response = pick(obj, RESPONSE_KEYS);
    const responseText = typeof response === 'object' ? response?.response ?? response?.Response : response;
    return {
      id: asId(pick(obj, ID_KEYS)) ?? `${title}|${start}`,
      title: title.trim(),
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      joinUrl: joinUrlOf(obj),
      cancelled: pick(obj, CANCELLED_KEYS) === true,
      declined: typeof responseText === 'string' && /decline/i.test(responseText),
    };
  }

  /**
   * Every meeting in `json` overlapping [now - 1 h, now + 14 days]. Ids that
   * repeat within one response (series ids on occurrences) get the start
   * appended so occurrences stay distinct.
   * @param {unknown} json
   * @param {{ now?: number }} [opts]
   */
  function extractMeetings(json, { now = Date.now() } = {}) {
    /** @type {Array<ReturnType<typeof toMeeting> & {}>} */
    const found = [];
    let budget = MAX_NODES;
    /** @param {unknown} node @param {number} depth */
    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > MAX_DEPTH || --budget < 0) return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1);
        return;
      }
      const meeting = toMeeting(node);
      if (meeting) {
        found.push(meeting);
        return;
      }
      for (const key of Object.keys(node)) walk(/** @type {any} */ (node)[key], depth + 1);
    }
    walk(json, 0);

    const lo = now - 60 * 60_000;
    const hi = now + 14 * DAY_MS;
    const inRange = found.filter((m) => Date.parse(m.end) > lo && Date.parse(m.start) < hi);
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const m of inRange) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
    return inRange.map((m) => ((counts.get(m.id) ?? 0) > 1 ? { ...m, id: `${m.id}#${m.start}` } : m));
  }

  return { extractMeetings, parseWhen };
});
