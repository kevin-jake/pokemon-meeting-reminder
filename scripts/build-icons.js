// @ts-check
'use strict';
/**
 * Crops frame 0 of media/pokeball_sprite_sheet.png (6 stacked 64x64 frames),
 * trims the transparent border and writes pixel-perfect upscales:
 *   build/icon.png               256 px (electron-builder converts to .ico)
 *   assets/tray/pokeball-16.png  16 px
 *   assets/tray/pokeball-32.png  32 px (used as the @2x tray image)
 * Outputs are committed, so sharp is only needed when re-running this script.
 */
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const sheet = path.join(root, 'media', 'pokeball_sprite_sheet.png');
const FRAME = 64;

async function main() {
  const frame = await sharp(sheet).extract({ left: 0, top: 0, width: FRAME, height: FRAME }).png().toBuffer();
  const ball = await sharp(frame).trim().png().toBuffer();

  /** @type {Array<[string, number]>} */
  const outputs = [
    [path.join(root, 'build', 'icon.png'), 256],
    [path.join(root, 'assets', 'tray', 'pokeball-16.png'), 16],
    [path.join(root, 'assets', 'tray', 'pokeball-32.png'), 32],
  ];
  for (const [out, size] of outputs) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await sharp(ball)
      .resize(size, size, { kernel: 'nearest', fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(out);
    console.log(`wrote ${path.relative(root, out)} (${size}px)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
