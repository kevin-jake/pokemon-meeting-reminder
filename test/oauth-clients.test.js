// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBuiltInClients, resolveGoogleClient } = require('../src/main/oauth-clients');
const { resolveMicrosoftClient } = require('../src/main/oauth-clients');

const builtIn = { google: { clientId: 'built-in-id', clientSecret: 'built-in-secret' }, microsoft: { clientId: 'built-in-ms' } };
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
  assert.deepEqual(loadBuiltInClients(file), { google: empty, microsoft: { clientId: '' } });
  fs.writeFileSync(file, JSON.stringify(builtIn));
  assert.deepEqual(loadBuiltInClients(file), builtIn);
  // The JSON Google Cloud Console downloads works unchanged.
  fs.writeFileSync(
    file,
    JSON.stringify({
      installed: { client_id: 'dl-id', project_id: 'p', auth_uri: 'https://accounts.google.com/o/oauth2/auth', client_secret: 'dl-secret', redirect_uris: ['http://localhost'] },
    }),
  );
  assert.deepEqual(loadBuiltInClients(file), { google: { clientId: 'dl-id', clientSecret: 'dl-secret' }, microsoft: { clientId: '' } });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the example file has the shape the loader expects', () => {
  const example = loadBuiltInClients(path.join(__dirname, '..', 'src', 'main', 'oauth-clients.example.json'));
  assert.match(example.google.clientId, /\.apps\.googleusercontent\.com$/);
});

test('Microsoft client precedence: env, then settings.json, then built-in', () => {
  assert.equal(resolveMicrosoftClient({ clientId: '' }, {}, builtIn), 'built-in-ms');
  assert.equal(resolveMicrosoftClient({ clientId: 'mine' }, {}, builtIn), 'mine');
  assert.equal(resolveMicrosoftClient({ clientId: 'mine' }, { PMR_MS_CLIENT_ID: 'env' }, builtIn), 'env');
});

test('the example file carries a Microsoft client id too', () => {
  const example = loadBuiltInClients(path.join(__dirname, '..', 'src', 'main', 'oauth-clients.example.json'));
  assert.match(example.microsoft.clientId, /^[0-9a-f-]{36}$/);
});
