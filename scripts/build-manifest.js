// @ts-check
'use strict';
/**
 * Builds src/shared/species-manifest.json from the vendored vscode-pokemon
 * species data (vendor/pokemon-data.ts + vendor/types.ts), our curated
 * scripts/flyers.json and the GIFs actually present under media/gen{1..5}/.
 *
 * The TypeScript is transpiled with ts.transpileModule and evaluated in a
 * node:vm sandbox, so nothing upstream ever runs with access to Node.
 *
 * Usage: npm run build-manifest
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * @typedef {object} ManifestEntry
 * @property {string} key          media folder name, e.g. "pikachu", "nidoran_female"
 * @property {string} name         display name
 * @property {number} gen          1..5
 * @property {number} dex          National Dex number (also the PokeAPI cry file name)
 * @property {number} spriteSize   native sprite size in px (32, or 64 for the giants)
 * @property {boolean} hasShiny
 * @property {boolean} hasLeftFacing  ships *_walk_left_8fps.gif (used instead of a CSS flip)
 * @property {boolean} isFlyer
 */

/**
 * Transpiles a TS module to CommonJS source.
 * @param {string} source
 * @param {string} fileName
 */
function transpile(source, fileName) {
  const ts = require('typescript');
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      // Emit const enums so `import { PokemonColor } from './types'` resolves at runtime.
      preserveConstEnums: true,
    },
  }).outputText;
}

/**
 * Evaluates the species data in a sandbox and returns POKEMON_DATA_RAW.
 * @param {string} tsSource     contents of pokemon-data.ts
 * @param {string} [typesSource] contents of types.ts (the only module it imports)
 * @returns {Record<string, any>}
 */
function loadSpeciesData(tsSource, typesSource) {
  const context = vm.createContext({});
  /** @type {Record<string, any>} */
  const modules = {};
  /** @param {string} id */
  const sandboxRequire = (id) => {
    if (id in modules) return modules[id];
    if (id === './types' && typesSource !== undefined) {
      modules[id] = runModule(transpile(typesSource, 'types.ts'));
      return modules[id];
    }
    throw new Error(`pokemon-data.ts imports unsupported module "${id}"`);
  };
  /** @param {string} js */
  const runModule = (js) => {
    const module = { exports: {} };
    const fn = vm.runInContext(`(function (exports, require, module) {${js}\n})`, context, { timeout: 5000 });
    fn(module.exports, sandboxRequire, module);
    return module.exports;
  };
  // Top-level const inside the wrapper is not reachable from outside, so hand it back explicitly.
  const exported = runModule(
    `${transpile(tsSource, 'pokemon-data.ts')}\nmodule.exports.__RAW__ = typeof POKEMON_DATA_RAW !== 'undefined' ? POKEMON_DATA_RAW : undefined;`,
  );
  const raw = exported.__RAW__ ?? exported.POKEMON_DATA;
  if (!raw || typeof raw !== 'object') throw new Error('POKEMON_DATA_RAW not found in pokemon-data.ts');
  // Round-trip through JSON so nothing from the sandbox realm leaks out.
  return JSON.parse(JSON.stringify(raw));
}

/**
 * @param {{ tsSource: string, typesSource?: string, flyers: string[], mediaDir: string, warn?: (msg: string) => void }} input
 * @returns {ManifestEntry[]}
 */
function buildManifest({ tsSource, typesSource, flyers, mediaDir, warn = console.warn }) {
  const data = loadSpeciesData(tsSource, typesSource);

  const unknown = flyers.filter((key) => !(key in data));
  if (unknown.length) throw new Error(`flyers.json has unknown species keys: ${unknown.join(', ')}`);
  const flyerSet = new Set(flyers);

  /** @param {...string} parts */
  const exists = (...parts) => fs.existsSync(path.join(mediaDir, ...parts));

  /** @type {ManifestEntry[]} */
  const entries = [];
  for (const [key, cfg] of Object.entries(data)) {
    const gen = Number(cfg.generation);
    const dir = `gen${gen}`;
    /** @param {string} variant @param {string} state */
    const gif = (variant, state) => exists(dir, key, `${variant}_${state}_8fps.gif`);
    if (!gif('default', 'walk') || !gif('default', 'idle')) {
      warn(`skipping ${key}: missing ${dir}/${key}/default_{walk,idle}_8fps.gif`);
      continue;
    }
    const colors = Array.isArray(cfg.possibleColors) ? cfg.possibleColors : [];
    const hasShiny = colors.includes('shiny') && gif('shiny', 'walk') && gif('shiny', 'idle');
    const extras = Array.isArray(cfg.extraSprites) ? cfg.extraSprites : [];
    // A left-facing GIF must exist for every colour we might pick, or we fall back to flipping.
    const hasLeftFacing =
      extras.includes('left_facing') && gif('default', 'walk_left') && (!hasShiny || gif('shiny', 'walk_left'));
    entries.push({
      key,
      name: String(cfg.name),
      gen,
      dex: Number(cfg.id),
      spriteSize: Number(cfg.originalSpriteSize) || 32,
      hasShiny,
      hasLeftFacing,
      isFlyer: flyerSet.has(key),
    });
  }
  entries.sort((a, b) => a.dex - b.dex || a.key.localeCompare(b.key));
  return entries;
}

function main() {
  const root = path.join(__dirname, '..');
  const vendorDir = path.join(root, 'vendor');
  const tsSource = fs.readFileSync(path.join(vendorDir, 'pokemon-data.ts'), 'utf8');
  const typesSource = fs.readFileSync(path.join(vendorDir, 'types.ts'), 'utf8');
  const flyers = JSON.parse(fs.readFileSync(path.join(__dirname, 'flyers.json'), 'utf8'));
  const manifest = buildManifest({ tsSource, typesSource, flyers, mediaDir: path.join(root, 'media') });
  const out = path.join(root, 'src', 'shared', 'species-manifest.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 1)}\n`);
  const count = (/** @type {(e: ManifestEntry) => boolean} */ fn) => manifest.filter(fn).length;
  console.log(
    `wrote ${path.relative(root, out)}: ${manifest.length} species ` +
      `(${count((e) => e.isFlyer)} flyers, ${count((e) => e.spriteSize === 64)} giants, ` +
      `${count((e) => e.hasLeftFacing)} left-facing)`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

module.exports = { buildManifest, loadSpeciesData };
