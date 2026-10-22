# Attribution

Pokémon Meeting Reminder is an unofficial, non-commercial fan project. It is
not affiliated with, endorsed by or sponsored by Nintendo, Creatures Inc.,
GAME FREAK inc. or The Pokémon Company. Pokémon and all related names,
characters, sprites and sounds are trademarks and © of their respective
owners. Do not sell this app or publish it to an app store.

## Sprites and species data

- **Source:** [jakobhoeg/vscode-pokemon](https://github.com/jakobhoeg/vscode-pokemon)
  (the exact commit is recorded in `vendor/UPSTREAM.txt`).
- **Files:** `media/gen1/` … `media/gen5/` (animated GIFs) and
  `vendor/pokemon-data.ts`, `vendor/types.ts` (species names, Dex numbers,
  sprite sizes), fetched by `npm run fetch-media`.
- **License:** the vscode-pokemon code and data are CC0 1.0. The sprite
  artwork is © The Pokémon Company / Nintendo / Creatures / GAME FREAK and is
  used here only for personal, non-commercial fan use.

## Cries

- **Source:** [PokeAPI/cries](https://github.com/PokeAPI/cries)
  (`cries/pokemon/latest/{dex}.ogg`), fetched by `npm run fetch-media` into
  `media/cries/`.
- **License:** the sounds are © The Pokémon Company / Nintendo / Creatures /
  GAME FREAK; used here only for personal, non-commercial fan use.

## Background music

- **Source:** the [Pokémon Game Sound Library](https://soundlibrary.pokemon.co.jp/).
  Its terms only permit personal, non-commercial use of files you download
  there yourself, so this project does not fetch or redistribute any tracks.
  See `media/bgm/README.md` for how to add your own.
- **License:** music © The Pokémon Company / Nintendo / Creatures / GAME FREAK.

## Icon

The Poké Ball tray and app icons are cropped from `media/pokeball_sprite_sheet.png`
by `npm run build-icons`.
