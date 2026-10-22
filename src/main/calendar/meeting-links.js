// @ts-check
'use strict';

/**
 * Video-meeting join links we recognise inside free text (location,
 * description). Descriptions are often HTML, so a match stops at whitespace,
 * quotes and angle brackets.
 */
const JOIN_URL_PATTERNS = [
  /https:\/\/meet\.google\.com\/[a-z0-9-]+/i,
  /https:\/\/(?:[a-z0-9-]+\.)*zoom\.us\/(?:j|my|w)\/[^\s"'<>]+/i,
  /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>]+/i,
  /https:\/\/teams\.live\.com\/meet\/[^\s"'<>]+/i,
  /https:\/\/(?:[a-z0-9-]+\.)*webex\.com\/[^\s"'<>]+/i,
];

/**
 * The URL if it is a plain https link, else null. Event fields are written by
 * whoever sent the invite, so nothing else (file:, custom protocols) is ever
 * handed to shell.openExternal.
 * @param {unknown} value
 */
function safeHttpsUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim().replace(/&amp;/g, '&'));
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * First recognised join link in the given texts, in order.
 * @param {Array<string | null | undefined>} texts
 */
function findJoinUrlInText(texts) {
  for (const text of texts) {
    if (!text) continue;
    for (const pattern of JOIN_URL_PATTERNS) {
      const match = text.match(pattern);
      const url = match && safeHttpsUrl(match[0].replace(/[.,;)\]]+$/, ''));
      if (url) return url;
    }
  }
  return null;
}

module.exports = { findJoinUrlInText, safeHttpsUrl };
