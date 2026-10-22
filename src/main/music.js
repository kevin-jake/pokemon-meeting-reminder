// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * Background music comes from the Pokémon Game Sound Library
 * (https://soundlibrary.pokemon.co.jp/). Its terms only allow files the user
 * downloaded from that site themselves, so tracks are never committed: the
 * user drops them into media/bgm/{normal,battle}/ and we pick one at random.
 *  - normal: played during the "in N min" warning
 *  - battle: played only for the meeting-start alarm (urgent scene), looped
 */

const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.flac']);

/**
 * @param {string} mediaDir
 * @param {'normal' | 'battle'} kind
 * @param {() => number} [rng]
 * @returns {string | null} file:// URL, or null when the folder has no tracks
 */
function pickTrack(mediaDir, kind, rng = Math.random) {
  const dir = path.join(mediaDir, 'bgm', kind);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()));
  } catch {
    return null;
  }
  if (!files.length) return null;
  const file = files[Math.floor(rng() * files.length)];
  return pathToFileURL(path.join(dir, file)).href;
}

module.exports = { pickTrack };
