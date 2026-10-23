// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_MUTE_MS, isMuted, isValidMute, muteFor, presetLabel, describeMute, nextMuteChange } = require('../src/shared/mute');

const now = new Date(2026, 9, 23, 10, 0).getTime();
const min = 60_000;

test('isMuted is true only inside the window', () => {
  const mute = { from: now, until: now + 30 * min };
  assert.equal(isMuted(null, now), false);
  assert.equal(isMuted(mute, now - 1), false);
  assert.equal(isMuted(mute, now), true);
  assert.equal(isMuted(mute, now + 30 * min - 1), true);
  assert.equal(isMuted(mute, now + 30 * min), false);
});

test('muteFor starts now', () => {
  assert.deepEqual(muteFor(60, now), { from: now, until: now + 60 * min });
});

test('isValidMute rejects malformed, backwards, past and overlong windows', () => {
  assert.equal(isValidMute({ from: now, until: now + min }, now), true);
  assert.equal(isValidMute({ from: now + 60 * min, until: now + 120 * min }, now), true);
  // Already started: only the part still to come counts towards the cap.
  assert.equal(isValidMute({ from: now - 60 * min, until: now + MAX_MUTE_MS }, now), true);
  for (const bad of [null, 'x', {}, { from: now }, { from: 'a', until: 'b' }, { from: NaN, until: now + min }]) {
    assert.equal(isValidMute(bad, now), false, JSON.stringify(bad));
  }
  assert.equal(isValidMute({ from: now + min, until: now }, now), false);
  assert.equal(isValidMute({ from: now - 2 * min, until: now - min }, now), false);
  assert.equal(isValidMute({ from: now, until: now + MAX_MUTE_MS + 1 }, now), false);
});

test('presetLabel', () => {
  assert.equal(presetLabel(30), '30 min');
  assert.equal(presetLabel(60), '1 hour');
  assert.equal(presetLabel(120), '2 hours');
});

test('describeMute covers running, scheduled and finished mutes', () => {
  assert.equal(describeMute(null, now), null);
  assert.equal(describeMute({ from: now, until: now + 90 * min }, now), 'Reminders muted until 11:30');
  assert.equal(describeMute({ from: now + 120 * min, until: now + 180 * min }, now), 'Reminders muted from 12:00 to 13:00');
  assert.equal(describeMute({ from: now, until: now + 24 * 60 * min }, now), 'Reminders muted until tomorrow 10:00');
  assert.equal(describeMute({ from: now - 60 * min, until: now }, now), null);
});

test('nextMuteChange is the start of a scheduled mute, else its end', () => {
  assert.equal(nextMuteChange(null, now), null);
  assert.equal(nextMuteChange({ from: now + min, until: now + 2 * min }, now), now + min);
  assert.equal(nextMuteChange({ from: now, until: now + 2 * min }, now), now + 2 * min);
  assert.equal(nextMuteChange({ from: now - 2 * min, until: now - min }, now), null);
});
