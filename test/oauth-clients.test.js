// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBuiltInClients, resolveGoogleClient } = require('../src/main/oauth-clients');

const builtIn = { google: { clientId: 'built-in-id', clientSecret: 'built-in-secret' } };
const empty = { clientId: '', clientSecret: '' };

test('Google client precedence: env, then settings.json, then built-in', () => {
  assert.deepEqual(resolveGoogleClient(empty, {}, builtIn), builtIn.google);
  assert.deepEqual(resolveGoogleClient({ clientId: 'mine', clientSecret: 's' }, {}, builtIn), { clientId: 'mine', clientSecret: 's' });
  assert.deepEqual(
    resolveGoogleClient({ clientId: 'mine', clientSecret: 's' }, { PMR_GOOGLE_CLIENT_ID: 'env', PMR_GOOGLE_CLIENT_SECRET: 'es' }, builtIn),
    { clientId: 'env', clientSecret: 'es' },
  );
  // A custom id never borrows the built-in secret.
  assert.deepEqual(resolveGoogleClient({ clientId: 'mine', clientSecret: '' }, {}, builtIn), { clientId: 'mine', clientSecret: '' });
});

test('built-in clients load from the local file, or are empty without it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmr-'));
  const file = path.join(dir, 'oauth-clients.local.json');
  assert.deepEqual(loadBuiltInClients(file), { google: empty });
  fs.writeFileSync(file, JSON.stringify(builtIn));
  assert.deepEqual(loadBuiltInClients(file), builtIn);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the example file has the shape the loader expects', () => {
  const example = loadBuiltInClients(path.join(__dirname, '..', 'src', 'main', 'oauth-clients.example.json'));
  assert.match(example.google.clientId, /\.apps\.googleusercontent\.com$/);
});
