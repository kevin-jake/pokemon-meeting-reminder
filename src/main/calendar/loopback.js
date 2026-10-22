// @ts-check
'use strict';
const http = require('node:http');

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** @param {string} title @param {string} body */
const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px 'Segoe UI',sans-serif;text-align:center;padding-top:15vh">` +
  `<h1>${title}</h1><p>${body}</p></body>`;

/**
 * One-shot HTTP server on an ephemeral loopback port that captures the OAuth
 * redirect (`?code=…&state=…`). Listen first, then build the auth URL from
 * the returned redirectUri. The server closes itself after the first valid
 * callback, a provider error, the timeout, or close().
 * @param {{ expectedState: string, host?: string, callbackPath?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ port: number, redirectUri: string, waitForCode: () => Promise<string>, close: () => void }>}
 */
async function startLoopback({ expectedState, host = '127.0.0.1', callbackPath = '/callback', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  /** @type {(code: string) => void} */
  let resolveCode = () => {};
  /** @type {(err: Error) => void} */
  let rejectCode = () => {};
  /** @type {Promise<string>} */
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Avoid an unhandled rejection if nobody ever calls waitForCode().
  codePromise.catch(() => {});
  let settled = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname !== callbackPath) {
      res.writeHead(404).end();
      return;
    }
    /** @param {number} status @param {string} html */
    const send = (status, html) =>
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(html);
    if (url.searchParams.get('state') !== expectedState) {
      // Not ours (a stale tab or a forged request): ignore it and keep waiting.
      send(400, page('Sign-in failed', 'This sign-in link is out of date. Start again from the tray menu.'));
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error || !code) {
      send(400, page('Sign-in cancelled', 'You can close this tab.'));
      finish(new Error(`Authorization failed: ${error ?? 'no code returned'}`));
      return;
    }
    send(200, page('Connected', 'Pokémon Meeting Reminder is connected. You can close this tab.'));
    finish(null, code);
  });

  /** @param {Error | null} err @param {string} [code] */
  function finish(err, code) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    // Drop idle keep-alive sockets so close() completes promptly.
    server.closeAllConnections();
    if (err) rejectCode(err);
    else resolveCode(/** @type {string} */ (code));
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(undefined));
  });
  const timer = setTimeout(() => finish(new Error('Timed out waiting for the browser sign-in')), timeoutMs);
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  return {
    port,
    redirectUri: `http://${host}:${port}${callbackPath}`,
    waitForCode: () => codePromise,
    close: () => finish(new Error('Sign-in cancelled')),
  };
}

module.exports = { startLoopback };
