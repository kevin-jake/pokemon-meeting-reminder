// @ts-check
'use strict';
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { safeHttpsUrl } = require('./meeting-links');

/** @typedef {import('./types').CalendarEvent} CalendarEvent */
/** @typedef {import('./types').CalendarSource} CalendarSource */

const SOURCE_ID = 'browser';
const SOURCE_NAME = 'Outlook / Teams (browser)';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MEETINGS = 500;
const MIN = 60_000;
/** The extension pushes every minute; longer silence means the browser is closed. */
const LIVE_MS = 3 * MIN;
/** After this long without a push the captured meetings are not trusted any more. */
const STALE_MS = 12 * 60 * MIN;
/** The same toast (by title) is acted on once per this window. */
const TOAST_REPEAT_MS = 15 * MIN;

/**
 * @typedef {object} BridgeConfig
 * @property {boolean} enabled
 * @property {number} port   fixed, so the extension knows where to find us
 * @property {string} token  shared secret from the pairing code
 * @property {boolean} toastReminders  act on meeting toasts that match no captured meeting
 */

/**
 * @typedef {object} BridgeToast
 * @property {string} site   origin of the page that raised it
 * @property {string} title
 * @property {string} body
 */

const newPairingToken = () => randomBytes(24).toString('base64url');

/** What the user pastes into the extension. @param {number} port @param {string} token */
const pairingCode = (port, token) => `pmr:${port}:${token}`;

/**
 * One meeting from the extension → CalendarEvent, or null when malformed.
 * The extension already skips all-day, cancelled and declined meetings; the
 * flags are honoured here too in case an older extension sends them.
 * @param {any} raw
 * @param {string} [source]
 * @returns {CalendarEvent | null}
 */
function normalizeBridgeMeeting(raw, source = SOURCE_ID) {
  if (!raw || typeof raw !== 'object' || raw.cancelled || raw.declined) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.start !== 'string' && typeof raw.start !== 'number') return null;
  const start = new Date(raw.start);
  const end = new Date(raw.end ?? raw.start);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '';
  return {
    id: raw.id.slice(0, 512),
    title: title || '(No title)',
    start,
    end,
    source,
    joinUrl: safeHttpsUrl(raw.joinUrl),
    link: safeHttpsUrl(raw.link),
  };
}

const MEETING_WORD = /\b(?:meeting|call)\b/i;
const STARTED = /\b(?:has started|started|is starting|starting now|starts now)\b/i;
const IN_MINUTES = /\b(?:in|starts in)\s+(\d{1,3})\s*(?:min|mins|minutes)\b/i;

/**
 * Decides whether a toast should play a reminder on its own. Toasts naming a
 * meeting we already know about are left to the scheduler (it fires on time
 * anyway); otherwise only meeting-ish texts count, so chat and mail toasts
 * never trigger: "… meeting … started" plays the urgent scene, "… in N min"
 * plays a warning.
 * @param {BridgeToast} toast
 * @param {CalendarEvent[]} events  meetings currently known from every calendar
 * @param {number} now
 * @returns {{ title: string, minutesUntil: number } | null}
 */
function toastReminder(toast, events, now) {
  const text = `${toast.title}\n${toast.body}`;
  const lower = text.toLowerCase();
  const known = events.some(
    (e) =>
      e.title.length >= 3 &&
      lower.includes(e.title.toLowerCase()) &&
      e.end.getTime() > now - 5 * MIN &&
      e.start.getTime() < now + 2 * 60 * MIN,
  );
  if (known) return null;
  const firstBodyLine = toast.body.split('\n').find((l) => l.trim())?.trim() ?? '';
  // Generic titles ("Meeting started") name the meeting in the body.
  const title = (STARTED.test(toast.title) || IN_MINUTES.test(toast.title)) && firstBodyLine ? firstBodyLine : toast.title.trim();
  if (MEETING_WORD.test(text) && STARTED.test(text)) return { title: title || 'Meeting', minutesUntil: 0 };
  const m = text.match(IN_MINUTES);
  if (m && (MEETING_WORD.test(text) || /reminder/i.test(text) || /^https:\/\/outlook\./.test(toast.site))) {
    return { title: title || 'Meeting', minutesUntil: Math.max(1, Number(m[1])) };
  }
  return null;
}

/** @param {string} a @param {string} b */
function sameSecret(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** @param {Date} d */
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Receives what the browser extension captures in Outlook on the web and
 * Teams: a full meeting list (POST /v1/snapshot, every minute and on change)
 * and toasts (POST /v1/toast). Listens on 127.0.0.1 only, checks the Host
 * header (DNS rebinding) and requires the pairing token on every request, so
 * web pages in the browser cannot feed it. The meetings are exposed as an
 * ordinary CalendarSource, so the scheduler handles them like Google's.
 * @param {object} deps
 * @param {() => BridgeConfig} deps.getConfig
 * @param {() => void} deps.onMeetingsChanged
 * @param {(toast: BridgeToast) => void} deps.onToast  already de-duplicated
 * @param {(port: number) => void} [deps.onPortChanged]  the configured port was taken and another was picked; persist it
 * @param {() => number} [deps.now]
 */
function createBrowserBridge({ getConfig, onMeetingsChanged, onToast, onPortChanged = () => {}, now = Date.now }) {
  /** @type {CalendarEvent[]} */
  let events = [];
  let fingerprint = '[]';
  /** @type {number | null} */
  let lastPushAt = null;
  /** @type {string | null} */
  let serverError = null;
  /** Listening on a new port the extension does not know yet: it needs a fresh pairing code. */
  let needsRepair = false;
  /** @type {http.Server | null} */
  let server = null;
  /** @type {Map<string, number>} */
  const recentToasts = new Map();

  const isConnected = () => lastPushAt !== null && now() - lastPushAt < STALE_MS;

  /** @param {any} body */
  function acceptSnapshot(body) {
    const list = Array.isArray(body?.meetings) ? body.meetings.slice(0, MAX_MEETINGS) : [];
    const next = list.map((m) => normalizeBridgeMeeting(m)).filter((e) => e !== null);
    lastPushAt = now();
    needsRepair = false;
    const nextFingerprint = JSON.stringify(next);
    if (nextFingerprint === fingerprint) return;
    events = next;
    fingerprint = nextFingerprint;
    onMeetingsChanged();
  }

  /** @param {any} body */
  function acceptToast(body) {
    const toast = {
      site: String(body?.site ?? ''),
      title: String(body?.title ?? '').slice(0, 300),
      body: String(body?.body ?? '').slice(0, 1000),
    };
    if (!toast.title && !toast.body) return;
    const t = now();
    for (const [k, at] of recentToasts) if (t - at > TOAST_REPEAT_MS) recentToasts.delete(k);
    const key = `${toast.title}\n${toast.body}`.trim().toLowerCase();
    if (recentToasts.has(key)) return;
    recentToasts.set(key, t);
    onToast(toast);
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  function handle(req, res) {
    /** @param {number} status @param {object} [json] */
    const send = (status, json) => {
      if (json) res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
      else res.writeHead(status).end();
    };
    const { port, token } = getConfig();
    const actualPort = /** @type {import('node:net').AddressInfo} */ (server?.address())?.port ?? port;
    const host = String(req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) return send(403);
    const auth = String(req.headers.authorization ?? '');
    if (!token || !auth.startsWith('Bearer ') || !sameSecret(auth.slice('Bearer '.length), token)) return send(401);

    const route = `${req.method} ${new URL(req.url ?? '/', 'http://127.0.0.1').pathname}`;
    if (route === 'GET /v1/ping') return send(200, { ok: true, app: 'pokemon-meeting-reminder' });
    if (route !== 'POST /v1/snapshot' && route !== 'POST /v1/toast') return send(404);

    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (/** @type {Buffer} */ chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        send(413);
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400);
      }
      if (route === 'POST /v1/snapshot') acceptSnapshot(body);
      else acceptToast(body);
      send(204);
    });
  }

  /** @type {CalendarSource} */
  const source = {
    id: SOURCE_ID,
    name: SOURCE_NAME,
    connect: async () => {},
    async disconnect() {
      events = [];
      fingerprint = '[]';
      lastPushAt = null;
    },
    cancelConnect: () => {},
    isConnected,
    isConfigured: () => true,
    isEnabled: () => getConfig().enabled,
    state: () => (isConnected() ? 'connected' : 'disconnected'),
    accountLabel: () => 'Outlook on the web',
    fetchUpcoming: async (windowMinutes) => {
      const t = now();
      return events.filter((e) => e.end.getTime() > t && e.start.getTime() < t + windowMinutes * MIN);
    },
  };

  return {
    source,
    /** Meetings from the last push (for matching toasts). */
    events: () => (isConnected() ? [...events] : []),

    /**
     * Starts listening when enabled. When the configured port cannot be bound
     * (in use, or reserved by Windows / Hyper-V), a free port is picked and
     * reported through onPortChanged so it sticks across restarts; the
     * extension then needs a fresh pairing code once. Resolves once listening,
     * or after recording why it could not.
     */
    async start() {
      const { enabled, port } = getConfig();
      if (!enabled || server) return;
      /** @param {number} p @returns {Promise<http.Server>} */
      const listen = (p) =>
        new Promise((resolve, reject) => {
          const s = http.createServer(handle);
          s.once('error', reject);
          s.listen(p, '127.0.0.1', () => resolve(s));
        });
      try {
        server = await listen(port);
        serverError = null;
      } catch (err) {
        console.warn(`Browser bridge could not listen on port ${port}:`, err);
        try {
          server = await listen(0);
          serverError = null;
          needsRepair = true;
          onPortChanged(/** @type {import('node:net').AddressInfo} */ (server.address()).port);
        } catch (err2) {
          serverError = `could not listen (${/** @type {NodeJS.ErrnoException} */ (err2).code ?? err2})`;
          console.warn('Browser bridge could not listen:', err2);
        }
      }
    },

    stop() {
      server?.close();
      server?.closeAllConnections();
      server = null;
    },

    /** Port actually listened on (differs from the config only when it asked for 0). */
    port: () => /** @type {import('node:net').AddressInfo | null} */ (server?.address() ?? null)?.port ?? getConfig().port,

    /** Tray row text, or null when the bridge is switched off. */
    statusLabel() {
      if (!getConfig().enabled) return null;
      if (serverError) return `${SOURCE_NAME}: ⚠ ${serverError}`;
      if (needsRepair) return `${SOURCE_NAME}: ⚠ port changed, copy the pairing code again`;
      if (lastPushAt === null) return `${SOURCE_NAME}: waiting for the extension…`;
      if (now() - lastPushAt > LIVE_MS) return `${SOURCE_NAME}: browser not running (last seen ${hhmm(new Date(lastPushAt))})`;
      const t = now();
      const upcoming = events.filter((e) => e.end.getTime() > t).length;
      return `${SOURCE_NAME}: ${upcoming} meeting${upcoming === 1 ? '' : 's'} captured`;
    },
  };
}

module.exports = { createBrowserBridge, normalizeBridgeMeeting, toastReminder, newPairingToken, pairingCode };
