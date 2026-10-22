// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate, deepMerge, DEFAULTS } = require('../src/main/settings');
const { sanitizePatch } = require('../src/main/settings-window');

test('migrate turns the old single favorite into a list and drops forceShiny', () => {
  assert.deepEqual(migrate({ favoriteSpecies: 'pikachu', forceShiny: true }), { favoriteSpecies: ['pikachu'], pokemonMode: 'favorites' });
  assert.deepEqual(migrate({ favoriteSpecies: null, forceShiny: false }), { favoriteSpecies: [], pokemonMode: 'random' });
  const current = { pokemonMode: 'random', favoriteSpecies: ['lugia'], generations: [2] };
  assert.deepEqual(migrate(current), current);
  // Defaults fill in what an old file lacks.
  assert.deepEqual(deepMerge(DEFAULTS, migrate({ favoriteSpecies: 'mew' })).generations, [1, 2, 3, 4, 5]);
});

test('sanitizePatch checks the Pokémon settings', () => {
  assert.deepEqual(sanitizePatch({ pokemonMode: 'favorites' }), { pokemonMode: 'favorites' });
  assert.deepEqual(sanitizePatch({ pokemonMode: 'shiny' }), {});
  assert.deepEqual(sanitizePatch({ favoriteSpecies: ['pikachu', 'mr-mime'] }), { favoriteSpecies: ['pikachu', 'mr-mime'] });
  assert.deepEqual(sanitizePatch({ favoriteSpecies: [] }), { favoriteSpecies: [] });
  assert.deepEqual(sanitizePatch({ favoriteSpecies: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), {});
  assert.deepEqual(sanitizePatch({ favoriteSpecies: ['pikachu', 'pikachu'] }), {});
  assert.deepEqual(sanitizePatch({ favoriteSpecies: 'pikachu' }), {});
  assert.deepEqual(sanitizePatch({ favoriteSpecies: ['../x'] }), {});
  assert.deepEqual(sanitizePatch({ generations: [1, 3] }), { generations: [1, 3] });
  assert.deepEqual(sanitizePatch({ generations: [] }), {});
  assert.deepEqual(sanitizePatch({ generations: [0] }), {});
  assert.deepEqual(sanitizePatch({ generations: [2, 2] }), {});
  assert.deepEqual(sanitizePatch({ forceShiny: true }), {});
});

test('sanitizePatch accepts volumes from 0 to 1 only', () => {
  assert.deepEqual(sanitizePatch({ cryVolume: 0, musicVolume: 0.35 }), { cryVolume: 0, musicVolume: 0.35 });
  assert.deepEqual(sanitizePatch({ cryVolume: 1 }), { cryVolume: 1 });
  assert.deepEqual(sanitizePatch({ cryVolume: 1.5 }), {});
  assert.deepEqual(sanitizePatch({ musicVolume: -0.1 }), {});
  assert.deepEqual(sanitizePatch({ musicVolume: '0.5' }), {});
  assert.deepEqual(sanitizePatch({ musicVolume: Number.NaN }), {});
  assert.equal(deepMerge(DEFAULTS, {}).cryVolume, 0.5);
});
