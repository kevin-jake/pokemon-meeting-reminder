// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { pickSpecies, buildScene, speciesByGen, MANIFEST } = require('../src/main/species');

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

test('pickSpecies uses the favorite when it is in the manifest, else a random one', () => {
  assert.equal(pickSpecies({ favoriteSpecies: 'lugia' }, seq([0.9]), manifest).entry.key, 'lugia');
  assert.equal(pickSpecies({ favoriteSpecies: 'gone' }, seq([0.5, 0.9]), manifest).entry.key, 'lugia');
  assert.equal(pickSpecies({ favoriteSpecies: null }, seq([0, 0.9]), manifest).entry.key, 'pikachu');
});

test('pickSpecies: shiny at 1/64, always with forceShiny, never without shiny GIFs', () => {
  assert.equal(pickSpecies({ favoriteSpecies: 'pikachu' }, seq([0.01, 0]), manifest).shiny, true);
  assert.equal(pickSpecies({ favoriteSpecies: 'pikachu' }, seq([0.02, 0]), manifest).shiny, false);
  assert.equal(pickSpecies({ favoriteSpecies: 'pikachu', forceShiny: true }, seq([0.9]), manifest).shiny, true);
  assert.equal(pickSpecies({ favoriteSpecies: 'togekiss', forceShiny: true }, seq([0]), manifest).shiny, false);
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
