// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { pickSpecies, buildScene, speciesByGen, MANIFEST, BALL_ATLAS_COLUMNS, pickBallColumn } = require('../src/main/species');

const mediaDir = path.join(__dirname, '..', 'media');

/** @type {import('../scripts/build-manifest').ManifestEntry[]} */
const manifest = [
  { key: 'pikachu', name: 'Pikachu', gen: 1, dex: 25, spriteSize: 32, hasShiny: true, hasLeftFacing: false, isFlyer: false },
  { key: 'lugia', name: 'Lugia', gen: 2, dex: 249, spriteSize: 64, hasShiny: true, hasLeftFacing: false, isFlyer: true },
  { key: 'togekiss', name: 'Togekiss', gen: 4, dex: 468, spriteSize: 32, hasShiny: false, hasLeftFacing: true, isFlyer: true },
];

/** Deterministic rng that replays `values` in order. @param {number[]} values */
const seq = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test('pickSpecies picks among the favorites that are still in the manifest', () => {
  const prefs = { pokemonMode: /** @type {const} */ ('favorites'), favoriteSpecies: ['togekiss', 'gone', 'pikachu'] };
  // Pool is in manifest order: [pikachu, togekiss].
  assert.equal(pickSpecies(prefs, seq([0, 0.9]), manifest).entry.key, 'pikachu');
  assert.equal(pickSpecies(prefs, seq([0.6, 0.9]), manifest).entry.key, 'togekiss');
  // Favorites are ignored in random mode, and an empty or stale list falls back to random.
  assert.equal(pickSpecies({ ...prefs, pokemonMode: 'random' }, seq([0.5, 0.9]), manifest).entry.key, 'lugia');
  assert.equal(pickSpecies({ pokemonMode: 'favorites', favoriteSpecies: ['gone'] }, seq([0.5, 0.9]), manifest).entry.key, 'lugia');
});

test('pickSpecies: random mode only picks from the enabled generations', () => {
  assert.equal(pickSpecies({ pokemonMode: 'random', generations: [4] }, seq([0, 0.9]), manifest).entry.key, 'togekiss');
  assert.equal(pickSpecies({ pokemonMode: 'random', generations: [1, 2] }, seq([0.99, 0.9]), manifest).entry.key, 'lugia');
  // No enabled generation in the manifest: anyone.
  assert.equal(pickSpecies({ pokemonMode: 'random', generations: [9] }, seq([0.99, 0.9]), manifest).entry.key, 'togekiss');
  // Favorites win over the generation filter.
  assert.equal(pickSpecies({ pokemonMode: 'favorites', favoriteSpecies: ['lugia'], generations: [1] }, seq([0, 0.9]), manifest).entry.key, 'lugia');
});

test('pickSpecies: shiny 1 in 10, never without shiny GIFs', () => {
  const only = (/** @type {string} */ key) => ({ pokemonMode: /** @type {const} */ ('favorites'), favoriteSpecies: [key] });
  assert.equal(pickSpecies(only('pikachu'), seq([0, 0.09, 0]), manifest).shiny, true);
  assert.equal(pickSpecies(only('pikachu'), seq([0, 0.1, 0]), manifest).shiny, false);
  assert.equal(pickSpecies(only('togekiss'), seq([0]), manifest).shiny, false);
});

test('buildScene scales giants x2 and others x4, and wires left-facing GIFs and cries', () => {
  const lugia = buildScene(
    { entry: manifest[1], shiny: true, direction: 'rtl' },
    { meetingTitle: 'Standup', minutesUntil: 5, mediaDir },
  );
  assert.equal(lugia.spriteSize * lugia.spriteScale, 128);
  assert.equal(lugia.isFlyer, true);
  assert.equal(lugia.urgent, false);
  assert.match(lugia.sprites.walk, /gen2\/lugia\/shiny_walk_8fps\.gif$/);
  assert.equal(lugia.sprites.walkLeft, null);
  assert.ok(lugia.altitude >= 0.15 && lugia.altitude <= 0.45);
  assert.equal(path.basename(fileURLToPath(/** @type {string} */ (lugia.cry))), '249.ogg');

  const togekiss = buildScene(
    { entry: manifest[2], shiny: false, direction: 'rtl' },
    { meetingTitle: 'Standup', minutesUntil: 0, mediaDir },
  );
  assert.equal(togekiss.spriteScale, 4);
  assert.equal(togekiss.urgent, true);
  assert.match(togekiss.pokeball.url, /all_balls_atlas.png$/);
  assert.match(/** @type {string} */ (togekiss.sprites.walkLeft), /gen4\/togekiss\/default_walk_left_8fps\.gif$/);
});

test('the committed manifest groups into five generations and every species has a cry', () => {
  const groups = speciesByGen();
  assert.deepEqual(
    groups.map(([gen]) => gen),
    [1, 2, 3, 4, 5],
  );
  assert.equal(
    groups.reduce((n, [, list]) => n + list.length, 0),
    MANIFEST.length,
  );
  for (const entry of MANIFEST) {
    const scene = buildScene({ entry, shiny: false, direction: 'ltr' }, { meetingTitle: 'x', minutesUntil: 5, mediaDir });
    assert.ok(scene.cry, `no cry for ${entry.key} (#${entry.dex})`);
  }
});

test('buildScene carries the meeting link for the banner button', () => {
  const pick = { entry: manifest[0], shiny: false, direction: /** @type {const} */ ('ltr') };
  const meetingLink = { url: 'https://meet.google.com/abc-defg-hij', kind: /** @type {const} */ ('join') };
  assert.deepEqual(buildScene(pick, { meetingTitle: 'x', minutesUntil: 5, mediaDir, meetingLink }).meetingLink, meetingLink);
  assert.equal(buildScene(pick, { meetingTitle: 'x', minutesUntil: 5, mediaDir }).meetingLink, null);
});

test('pickBallColumn: Poké 55 %, Great 20 %, Ultra 13 %, Master 2 %, the rest share 10 %', () => {
  /** @param {number} r */
  const at = (r) => pickBallColumn(() => r);
  assert.equal(at(0), 0);
  assert.equal(at(0.5499), 0);
  assert.equal(at(0.55), 8);
  assert.equal(at(0.7499), 8);
  assert.equal(at(0.75), 26);
  assert.equal(at(0.8799), 26);
  assert.equal(at(0.88), 15);
  assert.equal(at(0.8999), 15);
  assert.equal(at(0.9), 1);
  assert.equal(at(0.99999), 25);

  /** @type {Map<number, number>} */
  const counts = new Map();
  const N = 100000;
  for (let i = 0; i < N; i++) {
    const c = at(i / N);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  assert.equal(counts.size, BALL_ATLAS_COLUMNS);
  assert.ok(Math.abs((counts.get(0) ?? 0) / N - 0.55) < 0.001);
  assert.ok(Math.abs((counts.get(15) ?? 0) / N - 0.02) < 0.001);
  for (const c of [1, 2, 14, 16, 25]) assert.ok(Math.abs((counts.get(c) ?? 0) / N - 0.1 / 23) < 0.001);
});

test('buildScene recalls into a ball from the atlas', () => {
  const pick = { entry: manifest[0], shiny: false, direction: /** @type {const} */ ('ltr') };
  const ball = buildScene(pick, { meetingTitle: 'x', minutesUntil: 5, mediaDir, rng: () => 0 }).pokeball;
  assert.deepEqual(ball.column, 0);
  assert.equal(ball.columns, BALL_ATLAS_COLUMNS);
});

test('buildScene carries the volumes and leaves out muted sounds', () => {
  const pick = { entry: manifest[0], shiny: false, direction: /** @type {const} */ ('ltr') };
  const loud = buildScene(pick, { meetingTitle: 'Standup', minutesUntil: 5, mediaDir, cryVolume: 0.8, musicVolume: 0.3 });
  assert.deepEqual(loud.volume, { cry: 0.8, music: 0.3 });
  assert.ok(loud.cry);

  const muted = buildScene(pick, { meetingTitle: 'Standup', minutesUntil: 0, mediaDir, cryVolume: 0, musicVolume: 0 });
  assert.equal(muted.cry, null);
  assert.equal(muted.music, null);
});
