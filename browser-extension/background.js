// @ts-check
// Service worker: merges meetings captured in any Outlook / Teams tab and
// pushes the whole list to the tray app on 127.0.0.1 whenever it changes and
// once a minute (so a restarted app catches up). Toasts are forwarded as they
// happen. The worker can be stopped at any time, so all state lives in
// chrome.storage: meetings and status in `session`, the pairing in `local`.
'use strict';
importScripts('lib/meetings.js');

/** @type {{ mergeMeetings: Function, pruneMeetings: Function, snapshotOf: Function }} */
const { mergeMeetings, pruneMeetings, snapshotOf } = /** @type {any} */ (self).__pmrMeetings;

const SITES = new Set([
  'https://outlook.office.com',
  'https://outlook.office365.com',
  'https://outlook.cloud.microsoft',
  'https://outlook.live.com',
  'https://teams.microsoft.com',
  'https://teams.cloud.microsoft',
  'https://teams.live.com',
]);
const PUSH_ALARM = 'push';
const REQUEST_TIMEOUT_MS = 5000;
const LOG_SIZE = 20;

/** Storage read-modify-write must not interleave between messages. */
let queue = Promise.resolve();
/** @param {() => Promise<void>} fn */
function serial(fn) {
  queue = queue.then(fn).catch((err) => console.warn('PMR bridge:', err));
  return queue;
}

function ensureAlarm() {
  chrome.alarms.create(PUSH_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarm();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PUSH_ALARM) void serial(() => push());
});

/** @returns {Promise<{ port: number, token: string } | null>} */
async function pairing() {
  const { pairing } = await chrome.storage.local.get('pairing');
  return pairing?.port && pairing?.token ? pairing : null;
}

/**
 * One authenticated request to the tray app.
 * @param {string} path
 * @param {object} [body]  POST when given, else GET
 */
async function callApp(path, body) {
  const pair = await pairing();
  if (!pair) throw new Error('Not paired with the app yet (paste the pairing code in the options page)');
  const res = await fetch(`http://127.0.0.1:${pair.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${pair.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error('The app rejected the pairing code (copy a fresh one from the tray menu)');
  if (!res.ok) throw new Error(`The app answered HTTP ${res.status}`);
}

/** @param {{ ok: boolean, error?: string }} result */
async function recordPush(result) {
  await chrome.storage.session.set({ lastPush: { ...result, at: Date.now() } });
  await chrome.action.setBadgeText({ text: result.ok ? '' : '!' });
  await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
}

/** Sends the current meeting list. Failures are recorded for the options page and retried by the alarm. */
async function push() {
  const { meetings = {} } = await chrome.storage.session.get('meetings');
  const pruned = pruneMeetings(meetings, Date.now());
  await chrome.storage.session.set({ meetings: pruned });
  try {
    await callApp('/v1/snapshot', {
      meetings: snapshotOf(pruned),
      sentAt: Date.now(),
      version: chrome.runtime.getManifest().version,
    });
    await recordPush({ ok: true });
  } catch (err) {
    await recordPush({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** @param {string} origin @param {any} msg */
async function onMeetings(origin, msg) {
  const { meetings = {}, captureLog = [] } = await chrome.storage.session.get(['meetings', 'captureLog']);
  const merged = mergeMeetings(meetings, origin, msg.items, Date.now());
  const changed = JSON.stringify(snapshotOf(merged)) !== JSON.stringify(snapshotOf(meetings));
  const entry = { at: Date.now(), origin, url: String(msg.url ?? ''), count: Array.isArray(msg.items) ? msg.items.length : 0 };
  await chrome.storage.session.set({ meetings: merged, captureLog: [entry, ...captureLog].slice(0, LOG_SIZE) });
  if (changed) await push();
}

/** @param {string} origin @param {any} msg */
async function onToast(origin, msg) {
  try {
    await callApp('/v1/toast', { site: origin, title: String(msg.title ?? ''), body: String(msg.body ?? ''), at: Date.now() });
  } catch (err) {
    console.warn('PMR bridge: toast not delivered:', err);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Our own options page.
  if (sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''))) {
    if (msg?.type === 'push-now') {
      void serial(() => push()).then(() => sendResponse({ done: true }));
      return true;
    }
    if (msg?.type === 'clear') {
      void serial(async () => {
        await chrome.storage.session.set({ meetings: {}, captureLog: [] });
        await push();
      }).then(() => sendResponse({ done: true }));
      return true;
    }
    return false;
  }
  // Content scripts on the Outlook / Teams sites only.
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : '');
  if (!SITES.has(origin)) return false;
  if (msg?.type === 'meetings') void serial(() => onMeetings(origin, msg));
  else if (msg?.type === 'toast') void onToast(origin, msg);
  return false;
});
