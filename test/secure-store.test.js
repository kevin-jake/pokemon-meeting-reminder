// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openSecureStore } = require('../src/main/secure-store');

/**
 * Reversible fake of Electron's async safeStorage ("enc:" prefix + base64).
 * @param {{ available?: boolean, rotated?: boolean }} [opts]
 */
function fakeSafeStorage({ available = true, rotated = false } = {}) {
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (/** @type {string} */ s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
    decryptStringAsync: async (/** @type {Buffer} */ b) => {
      const text = b.toString();
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
      return { result: Buffer.from(text.slice(4), 'base64').toString(), shouldReEncrypt: rotated };
    },
  };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'secure-store-'));

test('secrets are encrypted on disk and load back on the next open', async () => {
  const dir = tmpDir();
  const a = await openSecureStore({ dir, safeStorage: fakeSafeStorage() });
  assert.equal(a.get('google-1'), null);
  assert.equal(a.set('google-1', 'secret'), true);
  assert.equal(a.get('google-1'), 'secret'); // readable before the write lands
  a.set('ical-1', 'link');
  a.delete('ical-1');
  await a.flush();
  assert.match(fs.readFileSync(path.join(dir, 'google-1.bin'), 'utf8'), /^enc:/);
  assert.equal(fs.existsSync(path.join(dir, 'ical-1.bin')), false);

  const b = await openSecureStore({ dir, safeStorage: fakeSafeStorage() });
  assert.equal(b.get('google-1'), 'secret');
  assert.deepEqual(b.list('google-'), ['google-1']);
});

test('unreadable secrets are listed but read as null; rotated keys re-encrypt', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'google-bad.bin'), 'garbage');
  fs.writeFileSync(path.join(dir, 'google-old.bin'), 'enc:' + Buffer.from('tok').toString('base64'));
  const fake = fakeSafeStorage({ rotated: true });
  /** @type {string[]} */
  const encrypted = [];
  const store = await openSecureStore({
    dir,
    safeStorage: { ...fake, encryptStringAsync: async (s) => (encrypted.push(s), fake.encryptStringAsync(s)) },
  });
  assert.deepEqual(store.list('google-'), ['google-bad', 'google-old']);
  assert.equal(store.get('google-bad'), null);
  assert.equal(store.get('google-old'), 'tok');
  await store.flush();
  assert.deepEqual(encrypted, ['tok']);
});

test('without encryption, secrets live in memory only', async () => {
  const dir = tmpDir();
  const store = await openSecureStore({ dir, safeStorage: fakeSafeStorage({ available: false }) });
  assert.equal(store.set('google-1', 'secret'), false);
  await store.flush();
  assert.equal(store.get('google-1'), 'secret');
  assert.equal(fs.existsSync(path.join(dir, 'google-1.bin')), false);
});
