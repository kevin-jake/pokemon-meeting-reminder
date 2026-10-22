# Background music

Tracks come from the **Pokémon Game Sound Library**: https://soundlibrary.pokemon.co.jp/

Its terms allow free personal, non-commercial use **only of files you download
from that site yourself**, so this repo does not ship any tracks (both folders
are git-ignored). To enable music:

1. Open the Sound Library, accept the terms, and download the tracks you want (WAV).
2. Drop them into:
   - `normal/` → played during the "in N min" warning (e.g. a town, route or Pokémon Center theme)
   - `battle/` → played, looped, **only** for the meeting-start alarm (e.g. a wild or trainer battle theme)

One track is picked at random from the folder each time. An empty folder means
no music; the cry still plays. Supported: .wav .mp3 .ogg .m4a .flac.

Music © The Pokémon Company / Nintendo / Creatures / GAME FREAK.

## Currently installed (local only)

The tracks in these folders on this machine were downloaded from an archive.org
upload of the *Pokémon FireRed & LeafGreen Super Music Collection*
(https://archive.org/details/pkmn-frlg-soundtrack), not from the Sound Library.
That upload carries no license, so keep them on this machine for personal use:
never commit them, and never ship them in a build for other people.
