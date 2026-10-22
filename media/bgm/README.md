# Background music

Tracks are not in the repo. The [Pokémon Game Sound Library](https://soundlibrary.pokemon.co.jp/)
only permits personal, non-commercial use of files you download there yourself,
so they stay local and are git-ignored.

Drop audio files (`.mp3`, `.ogg`, `.wav`, `.m4a`, `.flac`) into:

- `normal/` — played during the "in N min" warning
- `battle/` — looped for the meeting-start alarm

A packaged build copies the whole local `media/` folder (including these
tracks) next to `app.asar` via electron-builder `extraResources`, so build the
package from a checkout that has the tracks in place.
