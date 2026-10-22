// @ts-check
'use strict';
// The CommonJS build exports the API object itself; the bundled typings only describe the ES module.
const ICAL = /** @type {any} */ (require('ical.js'));
const { ReconnectNeededError } = require('./types');
const { findJoinUrlInText, safeHttpsUrl } = require('./meeting-links');

/** @typedef {import('./types').CalendarEvent} CalendarEvent */
/** @typedef {import('./types').CalendarSource} CalendarSource */
/** @typedef {import('./types').SourceState} SourceState */

const MIN = 60_000;
const HOUR = 60 * MIN;
const REQUEST_TIMEOUT_MS = 30_000;
/** Feeds hold the whole calendar history; anything bigger than this is not a calendar we can poll. */
const MAX_FEED_BYTES = 25 * 1024 * 1024;
/** Occurrences walked per recurring series before giving up on it (a minutely rule, say). */
const MAX_OCCURRENCES = 20_000;
/** Back-off ceiling after failed downloads (rate limiting, outages). */
const MAX_BACKOFF_MS = 30 * MIN;
/** With the feed failing, cached meetings are still used for this long. */
const STALE_MS = 12 * HOUR;
/** Each parse expands this far ahead, so most polls just filter. */
const PARSE_AHEAD_MS = 48 * HOUR;

/**
 * https URL of a calendar feed from pasted text (webcal:// becomes https://),
 * or null when the text is not a feed link.
 * @param {unknown} text
 */
function normalizeFeedUrl(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/^webcals?:\/\//i, 'https://');
  const url = safeHttpsUrl(trimmed);
  if (!url) return null;
  const { pathname } = new URL(url);
  return /\.ics$/i.test(pathname) || /\/ical\//i.test(pathname) ? url : null;
}

/** The link with its secret parts hidden, for dialogs and logs. @param {string} url */
function maskFeedUrl(url) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/private-[^/]+/i, '/private-•••').replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/•••');
  return `${u.host}${path}${u.search ? '?•••' : ''}`;
}

/**
 * The calendar's owner for Google secret addresses
 * (…/calendar/ical/<calendar id>/private-…/basic.ics), else null. Used to
 * find the user among an event's attendees, i.e. to spot declined invites.
 * @param {string} url
 */
function googleCalendarIdOf(url) {
  const m = new URL(url).pathname.match(/\/calendar\/ical\/([^/]+)\/private-/i);
  if (!m) return null;
  const id = decodeURIComponent(m[1]).toLowerCase();
  return id.includes('@') ? id : null;
}

/** Validity check for IANA zone names (Intl throws on unknown ones). @param {string} zone */
function isIanaZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wall-clock time in an IANA zone → Date. Two passes settle DST edges.
 * @param {{ year: number, month: number, day: number, hour: number, minute: number, second: number }} t
 * @param {string} zone
 */
function zonedToDate(t, zone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const wanted = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  /** @param {number} ms */
  const offsetAt = (ms) => {
    /** @type {Record<string, number>} */
    const p = {};
    for (const { type, value } of fmt.formatToParts(new Date(ms))) p[type] = Number(value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  let guess = wanted - offsetAt(wanted);
  guess = wanted - offsetAt(guess);
  return new Date(guess);
}

/**
 * ICAL.Time → Date. Zones defined in the feed (VTIMEZONE) or UTC are exact.
 * A TZID the feed references without defining it is read as an IANA zone
 * when it is one; anything else is floating, i.e. local time.
 * @param {any} time  ICAL.Time
 */
function toDate(time) {
  const zone = time.zone;
  const known = zone && zone !== ICAL.Timezone.localTimezone && zone.tzid !== 'floating';
  if (known) return time.toJSDate();
  const tzid = typeof time.timezone === 'string' ? time.timezone : null;
  if (tzid && isIanaZone(tzid)) return zonedToDate(time, tzid);
  return new Date(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
}

/** @param {any} component  VEVENT @param {string} name */
const textOf = (component, name) => {
  const v = component.getFirstPropertyValue(name);
  return typeof v === 'string' ? v : null;
};

/**
 * Whether one of `selfEmails` is an attendee who declined.
 * @param {any} component  VEVENT
 * @param {Set<string>} selfEmails  lowercase
 */
function declinedBy(component, selfEmails) {
  if (!selfEmails.size) return false;
  return component.getAllProperties('attendee').some((/** @type {any} */ p) => {
    const email = String(p.getFirstValue() ?? '').replace(/^mailto:/i, '').toLowerCase();
    return selfEmails.has(email) && String(p.getParameter('partstat') ?? '').toUpperCase() === 'DECLINED';
  });
}

/** @param {any} component  VEVENT */
function joinUrlOf(component) {
  return (
    safeHttpsUrl(textOf(component, 'x-google-conference')) ??
    findJoinUrlInText([textOf(component, 'location'), textOf(component, 'description'), textOf(component, 'url')])
  );
}

/**
 * iCalendar text → the timed meetings overlapping [from, to], recurring
 * series expanded (moved and cancelled occurrences honoured). All-day events,
 * cancelled events and invites one of `selfEmails` declined are left out.
 * @param {string} text
 * @param {{ from: number, to: number, source: string, selfEmails?: string[] }} opts
 * @returns {{ events: CalendarEvent[], calendarName: string | null }}
 */
function parseIcalEvents(text, { from, to, source, selfEmails = [] }) {
  const root = new ICAL.Component(ICAL.parse(text));
  const self = new Set(selfEmails.map((e) => e.toLowerCase()));
  const vevents = root.getAllSubcomponents('vevent');

  /** Masters by UID; exceptions (RECURRENCE-ID) are attached to theirs. @type {Map<string, any>} */
  const masters = new Map();
  /** @type {any[]} */
  const exceptions = [];
  for (const c of vevents) {
    if (c.hasProperty('recurrence-id')) exceptions.push(c);
    else masters.set(String(c.getFirstPropertyValue('uid') ?? ''), new ICAL.Event(c, { strictExceptions: false }));
  }
  /** @type {any[]} */
  const standalone = [];
  for (const c of exceptions) {
    const master = masters.get(String(c.getFirstPropertyValue('uid') ?? ''));
    if (master?.isRecurring()) master.relateException(c);
    else standalone.push(new ICAL.Event(c));
  }

  /** @type {CalendarEvent[]} */
  const events = [];
  /**
   * @param {any} item  ICAL.Event the details came from (master or exception)
   * @param {any} startTime @param {any} endTime
   * @param {string} id
   */
  function add(item, startTime, endTime, id) {
    const component = item.component;
    if (startTime.isDate) return; // all-day
    if (String(component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') return;
    if (declinedBy(component, self)) return;
    const start = toDate(startTime);
    const end = endTime ? toDate(endTime) : start;
    if (Number.isNaN(start.getTime()) || end.getTime() <= from || start.getTime() >= to) return;
    events.push({
      id,
      title: String(item.summary ?? '').trim() || '(No title)',
      start,
      end: end < start ? start : end,
      source,
      joinUrl: joinUrlOf(component),
      link: safeHttpsUrl(textOf(component, 'url')),
    });
  }

  for (const [uid, event] of masters) {
    if (!event.startDate) continue;
    if (!event.isRecurring()) {
      add(event, event.startDate, event.endDate, uid);
      continue;
    }
    const it = event.iterator();
    let walked = 0;
    for (let next = it.next(); next; next = it.next()) {
      if (++walked > MAX_OCCURRENCES) {
        console.warn(`iCal: gave up expanding "${event.summary}" after ${MAX_OCCURRENCES} occurrences`);
        break;
      }
      // Occurrences can be moved, so look a day past the window before stopping.
      if (!next.isDate && toDate(next).getTime() > to + 24 * HOUR) break;
      if (next.isDate && new Date(next.year, next.month - 1, next.day).getTime() > to + 24 * HOUR) break;
      const details = event.getOccurrenceDetails(next);
      add(details.item, details.startDate, details.endDate, `${uid}|${toDate(details.recurrenceId).toISOString()}`);
    }
  }
  for (const event of standalone) {
    if (event.startDate) add(event, event.startDate, event.endDate, `${event.uid}|${toDate(event.recurrenceId).toISOString()}`);
  }

  events.sort((a, b) => a.start.getTime() - b.start.getTime());
  const name = root.getFirstPropertyValue('x-wr-calname');
  return { events, calendarName: typeof name === 'string' && name.trim() ? name.trim() : null };
}

/**
 * Stored per link (encrypted): the feed URL. ETags and the downloaded text
 * are kept in memory only.
 * @typedef {object} IcalSecret
 * @property {string} url
 */

/**
 * One calendar subscribed by its private iCal link (Google's "Secret address
 * in iCal format", Outlook's published calendar, …). No sign-in: the link is
 * the credential, so it lives in the secure store. The feed is downloaded at
 * most every `refreshMinutes` (conditional GET), with exponential back-off on
 * failures; between downloads the poller is served from the parsed copy, and
 * the precise reminder timers keep firing on time. A link that stops working
 * (reset in Google, unpublished) switches to the reconnect state.
 * @param {object} deps
 * @param {string} deps.id
 * @param {string} deps.secretName
 * @param {{ get(name: string): string | null, set(name: string, value: string): boolean, delete(name: string): void }} deps.store
 * @param {() => { enabled: boolean, refreshMinutes: number }} deps.getConfig
 * @param {typeof fetch} [deps.fetchFn]
 * @param {() => number} [deps.now]
 */
function createIcalSource({ id, secretName, store, getConfig, fetchFn = fetch, now = Date.now }) {
  /** @returns {IcalSecret | null} */
  function load() {
    try {
      const raw = store.get(secretName);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed.url === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  let secret = load();
  /** @type {SourceState} */
  let state = secret ? 'connected' : 'disconnected';
  /** @type {{ text: string, fetchedAt: number, etag: string | null, lastModified: string | null } | null} */
  let feed = null;
  /** @type {{ events: CalendarEvent[], from: number, to: number } | null} */
  let parsed = null;
  /** @type {string | null} */
  let calendarName = null;
  let nextFetchAt = 0;
  let failures = 0;

  const selfEmails = () => {
    const owner = secret ? googleCalendarIdOf(secret.url) : null;
    return owner ? [owner] : [];
  };

  /** @param {string} message */
  function linkDead(message) {
    state = 'reconnect';
    return new ReconnectNeededError(message);
  }

  /** Downloads the feed (conditionally) and re-parses when it changed. */
  async function download() {
    if (!secret) throw linkDead('No calendar link stored');
    /** @type {Record<string, string>} */
    const headers = { Accept: 'text/calendar, */*;q=0.5' };
    if (feed?.etag) headers['If-None-Match'] = feed.etag;
    if (feed?.lastModified) headers['If-Modified-Since'] = feed.lastModified;
    const res = await fetchFn(secret.url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status === 304 && feed) {
      feed.fetchedAt = now();
      return;
    }
    if ([401, 403, 404, 410].includes(res.status)) {
      throw linkDead(`The calendar link stopped working (HTTP ${res.status}). It may have been reset; copy the new one.`);
    }
    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number(res.headers.get('retry-after'));
      if (retryAfter > 0) nextFetchAt = now() + Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
      throw new Error(`Calendar link rate-limited (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`Calendar link answered HTTP ${res.status}`);
    if (Number(res.headers.get('content-length')) > MAX_FEED_BYTES) throw new Error('Calendar feed is too large');
    const text = await res.text();
    if (text.length > MAX_FEED_BYTES) throw new Error('Calendar feed is too large');
    if (!/^\s*BEGIN:VCALENDAR/i.test(text)) throw new Error('The link did not return an iCalendar feed');
    feed = { text, fetchedAt: now(), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    parsed = null;
  }

  /** Expands the cached feed for [t - 1 h, t + max(48 h, window)] when the current expansion does not cover it. */
  function eventsFor(/** @type {number} */ t, /** @type {number} */ windowMs) {
    if (!feed) return [];
    if (!parsed || parsed.from > t - HOUR || parsed.to < t + windowMs) {
      const from = t - HOUR;
      const to = t + Math.max(PARSE_AHEAD_MS, windowMs);
      const result = parseIcalEvents(feed.text, { from, to, source: id, selfEmails: selfEmails() });
      parsed = { events: result.events, from, to };
      calendarName = result.calendarName;
    }
    return parsed.events;
  }

  /** @type {CalendarSource & { feedUrl: () => string | null, verify: () => Promise<void>, setUrl: (url: string) => void }} */
  const source = {
    id,
    name: 'Calendar link',
    connect: async () => {},
    cancelConnect: () => {},
    async disconnect() {
      store.delete(secretName);
      secret = null;
      feed = parsed = null;
      state = 'disconnected';
    },
    isConnected: () => state === 'connected',
    isConfigured: () => true,
    isEnabled: () => getConfig().enabled,
    state: () => state,
    accountLabel() {
      if (!secret) return null;
      const owner = googleCalendarIdOf(secret.url);
      if (owner) return `Google · ${owner}`;
      return calendarName ?? new URL(secret.url).host;
    },
    feedUrl: () => secret?.url ?? null,

    /** Stores a (new) link and starts over with it. @param {string} url */
    setUrl(url) {
      secret = { url };
      store.set(secretName, JSON.stringify(secret));
      feed = parsed = null;
      calendarName = null;
      state = 'connected';
      nextFetchAt = 0;
      failures = 0;
    },

    /** Downloads and parses right now; throws when the link is not a working calendar feed. */
    async verify() {
      await download();
      eventsFor(now(), 0);
      nextFetchAt = now() + getConfig().refreshMinutes * MIN;
    },

    async fetchUpcoming(windowMinutes) {
      if (state === 'reconnect') throw new ReconnectNeededError('The calendar link stopped working');
      const t = now();
      if (t >= nextFetchAt) {
        try {
          await download();
          failures = 0;
          nextFetchAt = t + getConfig().refreshMinutes * MIN;
        } catch (err) {
          if (err instanceof ReconnectNeededError) throw err;
          failures++;
          nextFetchAt = Math.max(nextFetchAt, t + Math.min(getConfig().refreshMinutes * MIN * 2 ** failures, MAX_BACKOFF_MS));
          // Keep serving the last good copy while it is reasonably fresh.
          if (!feed || t - feed.fetchedAt > STALE_MS) throw err;
          console.warn(`Calendar link ${source.accountLabel()}: ${err instanceof Error ? err.message : err}; using the copy from ${new Date(feed.fetchedAt).toLocaleTimeString()}`);
        }
      }
      const windowMs = windowMinutes * MIN;
      return eventsFor(t, windowMs).filter((e) => e.end.getTime() > t && e.start.getTime() < t + windowMs);
    },
  };
  return source;
}

module.exports = { parseIcalEvents, createIcalSource, normalizeFeedUrl, maskFeedUrl, googleCalendarIdOf };
