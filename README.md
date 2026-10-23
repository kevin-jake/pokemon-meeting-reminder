# Pokémon Meeting Reminder

A Windows tray app that sends a Pokémon across your desktop before each meeting.
A few minutes before a meeting starts, a random Pokémon walks along your taskbar
(or flies across the screen) with a banner that names the meeting. When the
meeting starts it comes back, plays the battle theme and stays until you click
**Join** or **Dismiss**.

> **Unofficial fan project.** Pokémon sprites, cries and music are © The Pokémon
> Company / Nintendo / Creatures / GAME FREAK. This app is for personal,
> non-commercial use only. Don't sell it or publish it to a store. See
> [ATTRIBUTION.md](ATTRIBUTION.md).

## Features

- Reads meetings from **Google Calendar** (sign-in), any **private iCal link**
  (Google or Outlook, no sign-in), and **Outlook on the web / Teams** through a
  small browser extension.
- An early warning (1–30 min before, 5 by default), plus an alarm when the
  meeting starts. The alarm stays on screen until you dismiss it.
- **Join** button on the banner when the invite has a video call link. It opens
  in the Chrome / Edge / Brave profile you chose for that calendar.
- About 650 Pokémon from generations 1–5. Flyers fly and the rest walk, and 1 in
  10 is shiny. Pick up to six favorites or limit the generations.
- The Pokémon walks across every monitor and stops on the one under your mouse.
  Click-through, so it never steals focus.
- Cries and optional background music, each with its own volume.
- Skip meetings by title (wildcards supported), launch at startup, and an
  optional regular Windows notification.

## Install

Run one of the files from a release build (see [Build](#build)):

- **`Pokémon Meeting Reminder Setup <version>.exe`** installs for the current
  user (no admin rights) and adds Start menu and desktop shortcuts.
- **`Pokémon Meeting Reminder <version> Portable.exe`** runs without installing.

Both use the same settings and sign-ins as `npm start`
(`%APPDATA%\pokemon-meeting-reminder`), so you can switch between them.

**SmartScreen:** the exe isn't code-signed, so Windows may show "Windows
protected your PC". Click **More info → Run anyway**.

The app lives in the tray (the Poké Ball by the clock; it may be in the `^`
overflow area). Right-click it for the next meeting, test reminders,
**Settings…** and **Quit**.

## Connect a calendar

Open **Settings → Calendars**. You can connect several accounts and kinds of
calendar at once. When the same meeting is on two calendars you get one
reminder.

### Google Calendar (sign-in)

Click **Add Google account…**, then sign in in the browser. This needs an OAuth
client. Builds that ship one in `src/main/oauth-clients.local.json` work right
away. Otherwise create your own (free):

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Google Calendar API**.
2. **OAuth consent screen:** choose External and add yourself as a test user.
3. **Credentials → Create credentials → OAuth client ID**, application type
   **Desktop app**. No redirect URI is needed: the app signs in through
   `http://127.0.0.1:<random port>/callback`.
4. Give the app the client ID and secret, in any one of these ways:
   - in `settings.json` under `google.clientId` / `google.clientSecret`
     (**Settings → General → Open settings.json**);
   - in the `PMR_GOOGLE_CLIENT_ID` / `PMR_GOOGLE_CLIENT_SECRET` environment
     variables;
   - in `src/main/oauth-clients.local.json` before you build, to bundle it for
     everyone you share the build with. Google's downloaded
     `client_secret_….json` works as-is. The file is git-ignored.

**7-day sign-in limit:** while the consent screen is in "Testing" status, Google
expires the sign-in after 7 days and the tray shows "sign-in expired". To avoid
that, click **Publish app** on the consent screen. You'll then see an
"unverified app" warning when you sign in. Click **Advanced → Go to … (unsafe)**
to continue.

The app only asks for read-only calendar access (`calendar.readonly`). Tokens
are encrypted with Windows DPAPI under `%APPDATA%\pokemon-meeting-reminder\secrets`.

### Calendar link (iCal, no sign-in)

Copy your calendar's private iCal address, then click **Add from clipboard…**
next to *Calendar link (iCal)*:

- **Google Calendar:** Settings → *your calendar* → Integrate calendar →
  *Secret address in iCal format*.
- **Outlook on the web:** Settings → Calendar → Shared calendars → Publish a
  calendar → *Can view all details* → copy the ICS link.

The link is stored encrypted and checked every 5 minutes, so changes show up a
little later than with a sign-in. Anyone who has the link can read the calendar.
If it leaks, reset it in Google or Outlook and add the new one.

### Outlook / Teams in the browser

For work accounts where you can't register an app: a small Edge / Chrome
extension reads the meetings Outlook on the web and Teams already load, and
passes them to the app on this PC. See **Settings → Outlook & Teams** for the
three setup steps, and [browser-extension/README.md](browser-extension/README.md)
for how it works. In an installed build the extension folder is
`resources\browser-extension` in the install folder. The **Open folder** button
takes you there.

## Settings

Most options are in the Settings window. Everything is saved to
`%APPDATA%\pokemon-meeting-reminder\settings.json`, which also holds a few
options the window doesn't show:

| Key | Default | |
| --- | --- | --- |
| `alertMinutesBefore` | `5` | Early warning, in minutes |
| `cryVolume` / `musicVolume` | `0.5` / `1` | 0–1, `0` mutes |
| `pokemonMode` | `"random"` | `"random"`, `"favorites"`, or `"mixed"` (favorites 60%, random 40%) |
| `favoriteSpecies` | `[]` | Up to 6 keys, e.g. `"pikachu"` |
| `generations` | `[1,2,3,4,5]` | Generations random mode picks from |
| `ignoredTitles` | `["Focus time (company-wide)"]` | One title per entry, `*` wildcard |
| `nativeNotification` | `false` | Also show a Windows notification |
| `launchAtStartup` | `false` | Installed or portable build only |
| `pollIntervalSec` | `60` | How often calendars are checked |
| `lookaheadMinutes` | `60` | How far ahead calendars are read (keep it above the early warning) |
| `ical.refreshMinutes` | `5` | Download interval for iCal links |
| `browserBridge.port` | `47321` | Local port for the browser extension |
| `browserBridge.toastReminders` | `true` | Remind on Outlook/Teams alerts for unknown meetings |

Quit and restart the app after editing the file by hand.

### Background music

No music ships with the app. The [Pokémon Game Sound Library](https://soundlibrary.pokemon.co.jp/)
only allows personal use of files you download there yourself. Put tracks in
`media\bgm\normal\` (early warning) and `media\bgm\battle\` (meeting start,
looped). See [media/bgm/README.md](media/bgm/README.md). In an installed build
the folder is `resources\media\bgm` in the install folder.

## Good to know

- **Focus Assist / Do not disturb** doesn't hide the Pokémon, which is its own
  window and not a notification. It does hide the optional Windows notification.
- **Exclusive-fullscreen games and the lock screen** cover the overlay. Turn on
  **Windows notification** if you want a fallback there.
- **Sleep:** the app checks your calendars as soon as the PC wakes or unlocks.
  A meeting that started up to 2 minutes earlier still gets its start alarm.
  Older ones are skipped.
- **Several monitors:** the Pokémon crosses all of them and stops on the one
  under your mouse cursor.
- **Microsoft 365 sign-in** (Graph API) isn't included at the moment. Use an
  Outlook iCal link or the browser extension instead.

## Development

Needs Node 22 LTS on Windows. Run all `npm` commands from PowerShell, not WSL
(WSL would download the Linux Electron binary).

```powershell
npm install
npm start                 # tray app from source
npm run dev               # same, with DevTools for the overlay and Settings windows
npm start -- --test       # play a 5-minute warning right away
npm start -- --test-now   # play a meeting-start alarm right away
npm test                  # unit tests (node:test)
```

Sprites, cries and the species manifest are committed. To refresh them from
upstream:

```powershell
npm run fetch-media       # vscode-pokemon sprites + PokeAPI cries
npm run build-manifest    # src/shared/species-manifest.json (flyers from scripts/flyers.json)
npm run build-icons       # build/icon.png and assets/tray/*.png
```

### Project layout

| Path | |
| --- | --- |
| `src/main/` | Electron main process: tray, poller, overlay and Settings windows, settings, encrypted storage |
| `src/main/calendar/` | Calendar sources: Google (OAuth + PKCE), iCal links, browser-extension bridge |
| `src/renderer/` | Overlay and Settings window pages |
| `src/shared/` | Code used by both sides: reminder scheduling, title filters, scene math, species manifest |
| `browser-extension/` | Edge / Chrome extension for Outlook on the web and Teams |
| `media/` | Sprites and cries by generation, plus local background music |
| `scripts/` | Media, manifest and icon build scripts |
| `vendor/` | Upstream vscode-pokemon data the manifest is built from |
| `test/` | Unit tests and fixtures |

## Build

```powershell
npm run dist              # dist\…Setup <version>.exe and dist\…Portable.exe
npm run dist:dir          # unpacked app only, in dist\win-unpacked (faster for testing)
```

electron-builder packs the app code into `app.asar` and copies `media\`
(including any local background music), `browser-extension\` and
`ATTRIBUTION.md` into `resources\`. A built-in Google client in
`src/main/oauth-clients.local.json` is bundled too.

## Credits

Sprites from [jakobhoeg/vscode-pokemon](https://github.com/jakobhoeg/vscode-pokemon),
cries from [PokeAPI/cries](https://github.com/PokeAPI/cries), and the idea from
[conniexu444/meeting-reminder](https://github.com/conniexu444/meeting-reminder).
Details and licenses are in [ATTRIBUTION.md](ATTRIBUTION.md).
