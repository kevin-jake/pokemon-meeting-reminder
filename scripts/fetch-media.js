// @ts-check
'use strict';
/**
 * Vendors the assets the app ships with:
 *  1. Sprites: sparse, blobless clone of jakobhoeg/vscode-pokemon, copies
 *     media/gen{1..5}/ over ours and src/common/{pokemon-data,types}.ts into
 *     vendor/ (with the upstream commit in vendor/UPSTREAM.txt).
 *  2. Cries: PokeAPI/cries `cries/pokemon/latest/{dex}.ogg` into
 *     media/cries/ for every National Dex number the species data covers.
 *     Existing files are kept unless --force-cries is passed.
 *
 * Background music is never fetched (see media/bgm/README.md).
 *
 * Usage: npm run fetch-media [-- --skip-sprites] [-- --force-cries]
 * Then:  npm run build-manifest
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildManifest } = require('./build-manifest');

const SPRITES_REPO = 'https://github.com/jakobhoeg/vscode-pokemon.git';
const CRY_URL = (/** @type {number} */ dex) =>
  `https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest/${dex}.ogg`;
const GENS = ['gen1', 'gen2', 'gen3', 'gen4', 'gen5'];
const DATA_FILES = ['pokemon-data.ts', 'types.ts'];
const CRY_CONCURRENCY = 8;

const root = path.join(__dirname, '..');
const mediaDir = path.join(root, 'media');
const vendorDir = path.join(root, 'vendor');

/** @param {string[]} args @param {string} [cwd] */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function fetchSprites() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmr-vscode-pokemon-'));
  try {
    console.log(`cloning ${SPRITES_REPO} (sparse) …`);
    git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', SPRITES_REPO, tmp]);
    git(['sparse-checkout', 'set', ...GENS.map((g) => `media/${g}`), 'src/common'], tmp);
    const commit = git(['rev-parse', 'HEAD'], tmp);

    for (const gen of GENS) {
      const dest = path.join(mediaDir, gen);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(path.join(tmp, 'media', gen), dest, { recursive: true });
    }
    fs.mkdirSync(vendorDir, { recursive: true });
    for (const file of DATA_FILES) {
      fs.copyFileSync(path.join(tmp, 'src', 'common', file), path.join(vendorDir, file));
    }
    fs.writeFileSync(
      path.join(vendorDir, 'UPSTREAM.txt'),
      `${SPRITES_REPO}\ncommit ${commit}\nfetched ${new Date().toISOString()}\n` +
        `files: media/gen1..gen5 -> media/, src/common/{${DATA_FILES.join(',')}} -> vendor/\n`,
    );
    const species = GENS.reduce((n, g) => n + fs.readdirSync(path.join(mediaDir, g)).length, 0);
    console.log(`copied ${species} sprite folders and species data @ ${commit.slice(0, 7)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** @param {boolean} force */
async function fetchCries(force) {
  const manifest = buildManifest({
    tsSource: fs.readFileSync(path.join(vendorDir, 'pokemon-data.ts'), 'utf8'),
    typesSource: fs.readFileSync(path.join(vendorDir, 'types.ts'), 'utf8'),
    flyers: JSON.parse(fs.readFileSync(path.join(__dirname, 'flyers.json'), 'utf8')),
    mediaDir,
    warn: () => {}, // build-manifest reports skipped species itself
  });
  const criesDir = path.join(mediaDir, 'cries');
  fs.mkdirSync(criesDir, { recursive: true });
  const dexes = [...new Set(manifest.map((e) => e.dex))];
  const todo = dexes.filter((dex) => force || !fs.existsSync(path.join(criesDir, `${dex}.ogg`)));
  console.log(`cries: ${dexes.length - todo.length} present, downloading ${todo.length} …`);

  /** @type {number[]} */
  const failed = [];
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const dex = todo[next++];
      try {
        const res = await fetchWithRetry(CRY_URL(dex));
        // Write via .tmp + rename so an interrupted run never leaves a truncated cry behind.
        const out = path.join(criesDir, `${dex}.ogg`);
        fs.writeFileSync(`${out}.tmp`, Buffer.from(await res.arrayBuffer()));
        fs.renameSync(`${out}.tmp`, out);
      } catch (err) {
        console.warn(`cry ${dex}: ${err instanceof Error ? err.message : err}`);
        failed.push(dex);
      }
    }
  }
  await Promise.all(Array.from({ length: CRY_CONCURRENCY }, worker));
  if (failed.length) throw new Error(`failed to fetch ${failed.length} cries: ${failed.join(', ')}`);
  console.log(`cries: ${dexes.length} in ${path.relative(root, criesDir)}`);
}

/** @param {string} url */
async function fetchWithRetry(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--skip-sprites')) fetchSprites();
  await fetchCries(argv.includes('--force-cries'));
  console.log('next: npm run build-manifest');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
