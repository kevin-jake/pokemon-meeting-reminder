// @ts-check
'use strict';
/** @type {{ parsePairingCode: (code: unknown) => { port: number, token: string } | null, snapshotOf: Function }} */
const { parsePairingCode, snapshotOf } = /** @type {any} */ (window).__pmrMeetings;

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {number} ms */
const time = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** @param {HTMLElement} el @param {string} text @param {'ok' | 'bad' | 'muted'} kind */
function show(el, text, kind) {
  el.textContent = text;
  el.className = kind;
}

/** @param {{ port: number, token: string }} pair */
async function ping(pair) {
  const res = await fetch(`http://127.0.0.1:${pair.port}/v1/ping`, {
    headers: { Authorization: `Bearer ${pair.token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 401) throw new Error('the app rejected this code — copy a fresh one from the tray menu');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

$('save').addEventListener('click', async () => {
  const pair = parsePairingCode(/** @type {HTMLInputElement} */ ($('code')).value);
  if (!pair) {
    show($('pairStatus'), 'That is not a pairing code (it starts with "pmr:").', 'bad');
    return;
  }
  await chrome.storage.local.set({ pairing: pair });
  try {
    await ping(pair);
    show($('pairStatus'), 'Connected to the app.', 'ok');
    await chrome.runtime.sendMessage({ type: 'push-now' });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    show($('pairStatus'), `Saved, but the app did not answer: ${why}. Is it running?`, 'bad');
  }
  void render();
});

$('pushNow').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'push-now' });
  void render();
});

$('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clear' });
  void render();
});

async function render() {
  const { pairing } = await chrome.storage.local.get('pairing');
  const input = /** @type {HTMLInputElement} */ ($('code'));
  if (pairing && !input.value && document.activeElement !== input) input.value = `pmr:${pairing.port}:${pairing.token}`;

  const { meetings = {}, captureLog = [], lastPush } = await chrome.storage.session.get(['meetings', 'captureLog', 'lastPush']);
  if (lastPush) {
    show(
      $('pushStatus'),
      lastPush.ok ? `Last sent to the app at ${time(lastPush.at)}.` : `Last attempt at ${time(lastPush.at)} failed: ${lastPush.error}`,
      lastPush.ok ? 'ok' : 'bad',
    );
  }

  const rows = snapshotOf(meetings).map((/** @type {any} */ m) => {
    const tr = document.createElement('tr');
    for (const text of [time(Date.parse(m.start)), m.title, m.joinUrl ? 'yes' : '—']) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  });
  $('meetings').replaceChildren(...rows);
  if (!rows.length) $('meetings').innerHTML = '<tr><td colspan="3" class="muted">None yet — open the Outlook calendar.</td></tr>';

  $('log').replaceChildren(
    ...captureLog.map((/** @type {any} */ e) => {
      const tr = document.createElement('tr');
      const when = document.createElement('td');
      when.textContent = time(e.at);
      const what = document.createElement('td');
      const code = document.createElement('code');
      code.textContent = `${e.url || e.origin} → ${e.count} meeting(s)`;
      what.append(code);
      tr.append(when, what);
      return tr;
    }),
  );
}

void render();
setInterval(() => void render(), 5000);
