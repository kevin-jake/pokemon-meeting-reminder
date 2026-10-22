// @ts-check
'use strict';
const { randomBytes, createHash } = require('node:crypto');

/**
 * OAuth 2.0 PKCE (RFC 7636) material for one sign-in attempt: a random
 * verifier, its S256 challenge, and a random state to match the callback.
 */
function createPkce() {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: challengeFor(verifier),
    method: /** @type {const} */ ('S256'),
    state: randomBytes(16).toString('base64url'),
  };
}

/** @param {string} verifier */
function challengeFor(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

module.exports = { createPkce, challengeFor };
