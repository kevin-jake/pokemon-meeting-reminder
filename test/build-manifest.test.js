// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildManifest } = require('../scripts/build-manifest');

const tsSource = fs.readFileSync(path.join(__dirname, 'fixtures', 'pokemon-data.ts'), 'utf8');
const typesSource = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'types.ts'), 'utf8');

/** Fake media dir: charizard + lugia have default/shiny, togekiss also ships walk_left, missingno has nothing. */
function makeMediaDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmr-manifest-'));
  /** @type {Array<[string, string, string[]]>} */
  const species = [
    ['gen1', 'charizard', ['walk', 'idle']],
    ['gen2', 'lugia', ['walk', 'idle']],
    ['gen4', 'togekiss', ['walk', 'idle', 'walk_left']],
  ];
  for (const [gen, key, states] of species) {
    fs.mkdirSync(path.join(dir, gen, key), { recursive: true });
    for (const variant of ['default', 'shiny']) {
      for (const state of states) fs.writeFileSync(path.join(dir, gen, key, `${variant}_${state}_8fps.gif`), '');
    }
  }
  return dir;
}

test('buildManifest emits sorted entries with sizes, shiny, left-facing and flyer flags', (t) => {
  const mediaDir = makeMediaDir();
  t.after(() => fs.rmSync(mediaDir, { recursive: true, force: true }));
  /** @type {string[]} */
  const warnings = [];
  const manifest = buildManifest({
    tsSource,
    typesSource,
    flyers: ['charizard', 'togekiss'],
    mediaDir,
    warn: (m) => warnings.push(m),
  });

  assert.deepEqual(manifest, [
    { key: 'charizard', name: 'Charizard', gen: 1, dex: 6, spriteSize: 32, hasShiny: true, hasLeftFacing: false, isFlyer: true },
    { key: 'lugia', name: 'Lugia', gen: 2, dex: 249, spriteSize: 64, hasShiny: true, hasLeftFacing: false, isFlyer: false },
    { key: 'togekiss', name: 'Togekiss', gen: 4, dex: 468, spriteSize: 32, hasShiny: true, hasLeftFacing: true, isFlyer: true },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missingno/);
});

test('buildManifest drops left-facing / shiny when those GIFs are missing', (t) => {
  const mediaDir = makeMediaDir();
  t.after(() => fs.rmSync(mediaDir, { recursive: true, force: true }));
  fs.rmSync(path.join(mediaDir, 'gen4', 'togekiss', 'shiny_walk_left_8fps.gif'));
  fs.rmSync(path.join(mediaDir, 'gen1', 'charizard', 'shiny_idle_8fps.gif'));
  const manifest = buildManifest({ tsSource, typesSource, flyers: [], mediaDir, warn: () => {} });
  const byKey = Object.fromEntries(manifest.map((e) => [e.key, e]));
  assert.equal(byKey.togekiss.hasLeftFacing, false);
  assert.equal(byKey.charizard.hasShiny, false);
  assert.equal(byKey.lugia.hasShiny, true);
});

test('buildManifest fails on unknown flyer keys', (t) => {
  const mediaDir = makeMediaDir();
  t.after(() => fs.rmSync(mediaDir, { recursive: true, force: true }));
  assert.throws(
    () => buildManifest({ tsSource, typesSource, flyers: ['charizard', 'ho-oh'], mediaDir, warn: () => {} }),
    /unknown species keys: ho-oh/,
  );
});

test('committed manifest agrees with flyers.json and the media on disk', () => {
  /** @type {import('../scripts/build-manifest').ManifestEntry[]} */
  const manifest = require('../src/shared/species-manifest.json');
  /** @type {string[]} */
  const flyers = require('../scripts/flyers.json');
  assert.ok(manifest.length > 600, `expected ~630 species, got ${manifest.length}`);
  const mediaDir = path.join(__dirname, '..', 'media');
  for (const e of manifest) {
    assert.equal(e.isFlyer, flyers.includes(e.key), e.key);
    // Every species the app can pick must have its sprites on disk.
    for (const state of ['walk', 'idle']) {
      assert.ok(fs.existsSync(path.join(mediaDir, `gen${e.gen}`, e.key, `default_${state}_8fps.gif`)), e.key);
    }
  }
  assert.ok(manifest.some((e) => e.key === 'pikachu'));
});
