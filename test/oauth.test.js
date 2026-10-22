// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPkce, challengeFor } = require('../src/main/calendar/pkce');
const { startLoopback } = require('../src/main/calendar/loopback');

test('PKCE: S256 challenge matches WebCrypto, and values are fresh per attempt', async () => {
  const verifier = 'test-verifier-0123456789-abcdefghijklmnopqrstu';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  assert.equal(challengeFor(verifier), Buffer.from(digest).toString('base64url'));
  const a = createPkce();
  const b = createPkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.challenge, challengeFor(a.verifier));
});

test('loopback: ignores wrong state and other paths, resolves the code, then closes', async () => {
  const lb = await startLoopback({ expectedState: 's1' });
  assert.match(lb.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal((await fetch(`http://127.0.0.1:${lb.port}/favicon.ico`)).status, 404);
  assert.equal((await fetch(`${lb.redirectUri}?code=evil&state=nope`)).status, 400);
  const res = await fetch(`${lb.redirectUri}?code=good&state=s1`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Connected/);
  assert.equal(await lb.waitForCode(), 'good');
  await assert.rejects(fetch(lb.redirectUri));
});

test('loopback: provider errors, close() and timeouts reject', async () => {
  const denied = await startLoopback({ expectedState: 's' });
  await fetch(`${denied.redirectUri}?error=access_denied&state=s`);
  await assert.rejects(denied.waitForCode(), /access_denied/);

  const cancelled = await startLoopback({ expectedState: 's' });
  cancelled.close();
  await assert.rejects(cancelled.waitForCode(), /cancelled/);

  const slow = await startLoopback({ expectedState: 's', timeoutMs: 20 });
  await assert.rejects(slow.waitForCode(), /Timed out/);
});
