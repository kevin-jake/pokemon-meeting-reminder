// @ts-check
'use strict';

/** Caps for the list as stored in settings (it comes from an editable textarea). */
const MAX_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 200;

/** @param {string} s */
const normalize = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Turns the exception list into a title predicate. A pattern matches a whole
 * title, ignoring case and extra whitespace; `*` matches any run of
 * characters, so "Focus time*" covers every title starting with "Focus time".
 * @param {readonly string[]} patterns
 * @returns {(title: string) => boolean}
 */
function createTitleFilter(patterns) {
  const exact = new Set();
  /** @type {RegExp[]} */
  const wildcards = [];
  for (const raw of patterns) {
    const p = normalize(raw);
    if (!p) continue;
    if (!p.includes('*')) exact.add(p);
    else wildcards.push(new RegExp(`^${p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));
  }
  return (title) => {
    const t = normalize(title);
    return exact.has(t) || wildcards.some((re) => re.test(t));
  };
}

/** Shape check for the `ignoredTitles` setting coming from the Settings page. @param {unknown} v */
const isValidIgnoredTitles = (v) =>
  Array.isArray(v) && v.length <= MAX_PATTERNS && v.every((t) => typeof t === 'string' && t.length <= MAX_PATTERN_LENGTH);

module.exports = { createTitleFilter, isValidIgnoredTitles };
