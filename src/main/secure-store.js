// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Small encrypted secret store: each secret is a string encrypted with
 * Electron safeStorage (DPAPI on Windows) at <dir>/<name>.bin. If encryption
 * is unavailable the secret is kept in memory for this session only and
 * never written in plaintext.
 *
 * safeStorage is only async now, so every secret is decrypted once up front
 * and reads are served from memory; writes go to disk in the background, in
 * order. `flush()` waits for them (call it before quitting).
 * @param {{ dir: string, safeStorage: Pick<Electron.SafeStorage, 'isAsyncEncryptionAvailable' | 'encryptStringAsync' | 'decryptStringAsync'> }} opts
 */
async function openSecureStore({ dir, safeStorage }) {
  /** Decrypted secrets; null = the file exists but no longer decrypts. @type {Map<string, string | null>} */
  const cache = new Map();
  const available = await safeStorage.isAsyncEncryptionAvailable().catch(() => false);
  if (!available) console.warn('safeStorage encryption unavailable: credentials will not survive a restart.');
  /** Disk writes and deletes, chained so they land in the order they were made. */
  let queue = Promise.resolve();

  /** @param {string} name */
  const fileOf = (name) => {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`Bad secret name: ${name}`);
    return path.join(dir, `${name}.bin`);
  };

  /** @param {string} name @param {string} value */
  async function write(name, value) {
    const file = fileOf(name);
    const encrypted = await safeStorage.encryptStringAsync(value);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(`${file}.tmp`, encrypted);
    await fs.promises.rename(`${file}.tmp`, file);
  }

  /** @param {() => Promise<void>} job @param {string} what */
  function enqueue(job, what) {
    queue = queue.then(job).catch((err) => console.warn(`Secret ${what} failed:`, err));
  }

  /** @type {string[]} */
  let files = [];
  try {
    files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.bin'));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') console.warn('Secrets folder unreadable:', err);
  }
  await Promise.all(
    files.map(async (f) => {
      const name = f.slice(0, -'.bin'.length);
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(await fs.promises.readFile(path.join(dir, f)));
        cache.set(name, result);
        // The OS key was rotated: store it again under the current key.
        if (shouldReEncrypt && available) enqueue(() => write(name, result), `"${name}" re-encrypt`);
      } catch (err) {
        console.warn(`Secret "${name}" unreadable:`, err);
        cache.set(name, null);
      }
    }),
  );

  return {
    /** @param {string} name @returns {string | null} */
    get(name) {
      fileOf(name);
      return cache.get(name) ?? null;
    },
    /** @param {string} name @param {string} value @returns {boolean} true when it will be persisted to disk */
    set(name, value) {
      fileOf(name);
      cache.set(name, value);
      if (available) enqueue(() => write(name, value), `"${name}" save`);
      return available;
    },
    /** Names of the stored secrets that start with `prefix`, sorted. @param {string} prefix */
    list(prefix) {
      return [...cache.keys()].filter((n) => n.startsWith(prefix)).sort();
    },
    /** @param {string} name */
    delete(name) {
      const file = fileOf(name);
      cache.delete(name);
      enqueue(() => fs.promises.rm(file, { force: true }), `"${name}" delete`);
    },
    /** Resolves once every save and delete so far has reached the disk. */
    flush: () => queue,
  };
}

module.exports = { openSecureStore };
