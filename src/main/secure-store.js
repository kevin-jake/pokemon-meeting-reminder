// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Small encrypted secret store: each secret is a string encrypted with
 * Electron safeStorage (DPAPI on Windows) at <dir>/<name>.bin. If encryption
 * is unavailable the secret is kept in memory for this session only and
 * never written in plaintext.
 * @param {{ dir: string, safeStorage: Pick<Electron.SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'> }} opts
 */
function createSecureStore({ dir, safeStorage }) {
  /** @type {Map<string, string>} */
  const memoryOnly = new Map();
  let warned = false;

  /** @param {string} name */
  const fileOf = (name) => {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`Bad secret name: ${name}`);
    return path.join(dir, `${name}.bin`);
  };

  return {
    /** @param {string} name @returns {string | null} */
    get(name) {
      if (memoryOnly.has(name)) return /** @type {string} */ (memoryOnly.get(name));
      try {
        return safeStorage.decryptString(fs.readFileSync(fileOf(name)));
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') console.warn(`Secret "${name}" unreadable:`, err);
        return null;
      }
    },
    /** @param {string} name @param {string} value @returns {boolean} true when persisted to disk */
    set(name, value) {
      if (!safeStorage.isEncryptionAvailable()) {
        if (!warned) console.warn('safeStorage encryption unavailable: credentials will not survive a restart.');
        warned = true;
        memoryOnly.set(name, value);
        return false;
      }
      memoryOnly.delete(name);
      const file = fileOf(name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, safeStorage.encryptString(value));
      fs.renameSync(`${file}.tmp`, file);
      return true;
    },
    /** Names of the stored secrets that start with `prefix`, sorted. @param {string} prefix */
    list(prefix) {
      /** @type {Set<string>} */
      const names = new Set([...memoryOnly.keys()].filter((n) => n.startsWith(prefix)));
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.bin') && f.startsWith(prefix)) names.add(f.slice(0, -'.bin'.length));
        }
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') console.warn('Secrets folder unreadable:', err);
      }
      return [...names].sort();
    },
    /** @param {string} name */
    delete(name) {
      memoryOnly.delete(name);
      fs.rmSync(fileOf(name), { force: true });
    },
  };
}

module.exports = { createSecureStore };
