// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTitleFilter, isValidIgnoredTitles } = require('../src/shared/ignored-meetings');

test('createTitleFilter matches whole titles, ignoring case and extra whitespace', () => {
  const ignored = createTitleFilter(['Focus time (company-wide)', '  ', 'OOO']);
  assert.equal(ignored('Focus time (company-wide)'), true);
  assert.equal(ignored('  focus   TIME (Company-Wide) '), true);
  assert.equal(ignored('ooo'), true);
  assert.equal(ignored('Focus time'), false);
  assert.equal(ignored('Focus time (company-wide) prep'), false);
  assert.equal(ignored(''), false);
  // Invisible characters calendars slip into titles don't stop a match.
  assert.equal(ignored('​Focus time (company-wide)﻿'), true);
});

test('createTitleFilter treats * as a wildcard and everything else literally', () => {
  const ignored = createTitleFilter(['Lunch*', '*[hold]*', 'a.c']);
  assert.equal(ignored('Lunch'), true);
  assert.equal(ignored('lunch with team'), true);
  assert.equal(ignored('Team lunch'), false);
  assert.equal(ignored('Design review [HOLD] maybe'), true);
  assert.equal(ignored('a.c'), true);
  assert.equal(ignored('abc'), false);
  assert.equal(createTitleFilter([])('anything'), false);
});

test('isValidIgnoredTitles checks shape and caps', () => {
  assert.equal(isValidIgnoredTitles(['a', 'b']), true);
  assert.equal(isValidIgnoredTitles([]), true);
  assert.equal(isValidIgnoredTitles('a'), false);
  assert.equal(isValidIgnoredTitles([1]), false);
  assert.equal(isValidIgnoredTitles(['x'.repeat(201)]), false);
  assert.equal(isValidIgnoredTitles(Array(201).fill('x')), false);
});
