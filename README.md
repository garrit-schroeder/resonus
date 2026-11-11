<p align="center">
  <img src="./assets/images/icon-transparent.png" width="120" alt="Resonus icon" />
</p>

<h1 align="center">Resonus</h1>

<p align="center">
  A clean music player for your self-hosted server, and your local files.
  <br />
  Android, with an experimental iOS build.
</p>

<p align="center">
  <a href="https://github.com/juananzzz/resonus/releases/latest"><img src="./assets/images/badges/download.svg" height="28" alt="Download APK" /></a>
  <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://add/https://github.com/juananzzz/resonus"><img src="./assets/images/obtainium.svg" height="28" alt="Get via Obtainium" /></a>
  <a href="https://altdirect.app/?url=https://raw.githubusercontent.com/juananzzz/resonus/main/Source.json"><img src="./assets/images/badges/altsource.svg" height="28" alt="iOS via AltStore" /></a>
</p>

<p align="center">
  <a href="https://www.navidrome.org"><img src="https://img.shields.io/badge/Navidrome-1F2A44" alt="Works with Navidrome" /></a>
  <a href="https://opensubsonic.netlify.app"><img src="https://img.shields.io/badge/OpenSubsonic-2E7D32" alt="Works with OpenSubsonic" /></a>
  <a href="https://jellyfin.org"><img src="https://img.shields.io/badge/Jellyfin-00A4DC?logo=jellyfin&logoColor=white" alt="Works with Jellyfin" /></a>
  <a href="https://ampache.org"><img src="https://img.shields.io/badge/Ampache-E8590C" alt="Works with Ampache" /></a>
  <br />
  <a href="https://github.com/juananzzz/resonus/actions/workflows/checks.yml"><img src="https://github.com/juananzzz/resonus/actions/workflows/checks.yml/badge.svg" alt="Checks" /></a>
  <a href="https://github.com/juananzzz/resonus/releases/latest"><img src="https://img.shields.io/github/v/release/juananzzz/resonus" alt="Latest release" /></a>
  <a href="https://github.com/juananzzz/resonus/releases"><img src="https://img.shields.io/github/downloads/juananzzz/resonus/total?logo=github&logoColor=white&label=downloads" alt="GitHub downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License: GPL-3.0" /></a>
  <a href="https://github.com/juananzzz/resonus/stargazers"><img src="https://img.shields.io/github/stars/juananzzz/resonus?style=flat" alt="Stars" /></a>
  <a href="https://discord.gg/pecE8MTPVr"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="https://ko-fi.com/juananzzz"><img src="https://img.shields.io/badge/Ko--fi-FF5E5B?logo=kofi&logoColor=white" alt="Support on Ko-fi" /></a>
</p>

---

## Screenshots

| Home | Player | Album | Library |
| :---: | :---: | :---: | :---: |
| <img src="./assets/screenshots/dark-home.jpg" width="200" alt="Home, dark" /> | <img src="./assets/screenshots/dark-player.jpg" width="200" alt="Player, dark" /> | <img src="./assets/screenshots/dark-album.jpg" width="200" alt="Album, dark" /> | <img src="./assets/screenshots/dark-library.jpg" width="200" alt="Library, dark" /> |

| Artist | Lyrics | Queue | Servers |
| :---: | :---: | :---: | :---: |
| <img src="./assets/screenshots/artist.jpg" width="200" alt="Artist" /> | <img src="./assets/screenshots/lyrics.jpg" width="200" alt="Synced lyrics" /> | <img src="./assets/screenshots/queue.jpg" width="200" alt="Queue" /> | <img src="./assets/screenshots/servers.jpg" width="200" alt="Supported servers" /> |

## Download

You need a Navidrome, OpenSubsonic, Jellyfin or Ampache server, or just music files on your device.

### Android

Get the latest APK from the [Releases](https://github.com/juananzzz/resonus/releases/latest) page and install it on your Android device.

Also available on [Obtainium](https://apps.obtainium.imranr.dev/redirect?r=obtainium://add/https://github.com/juananzzz/resonus) for automatic updates.

Requires Android 7.0 or newer. Not on F-Droid yet.

### iOS (experimental)

Download the `.ipa` from the [Releases](https://github.com/juananzzz/resonus/releases/latest)
page and sideload it with AltStore, Sideloadly or similar, or
[add Resonus as an AltSource](https://altdirect.app/?url=https://raw.githubusercontent.com/juananzzz/resonus/main/Source.json)
to get updates. The build is unsigned, so it is not on the App Store or TestFlight.

Not available on iOS yet: CarPlay, casting, the equalizer and gapless playback.

## Features

### Servers and local music

- **Navidrome / OpenSubsonic / Jellyfin / Ampache**: multi-profile login, multi-library support, plus several server addresses with automatic switching
- **Local mode**: play music straight from your device or a folder, no server needed
- **Queue sync across devices**

### Listening

- **Playback**: gapless, crossfade, built-in equalizer, ReplayGain normalization, playback speed, sleep timer, queue with undo, shuffle, repeat, background & lock-screen controls
- **Autoplay & mixes**: keep the music going with similar songs, or start a mix from any track
- **Synced lyrics**: karaoke view with tap-to-seek, word-by-word highlighting (TTML and enhanced LRC), full-screen mode, optional lookup on [LRCLIB](https://lrclib.net) and [lrc.red](https://lrc.red)
- **Internet radio**: browse and manage your stations
- **Podcasts**: search for a show or paste its feed, no server needed; download episodes, favorite them and queue them
- **Cast to speakers**: UPnP/DLNA renderers and Sonos, with room grouping; local music streams to them too
- **Android Auto** (experimental)

### Library and downloads

- **Offline mode**: your favorites, playlists and albums stay browsable with no connection; downloaded songs play, the rest show grayed out, and it switches automatically when the server is unreachable
- **Downloads**: albums, playlists, an artist's whole discography or single songs, in original quality or transcoded
- **Organize**: multi-select (queue, playlist or download in batch), star ratings, pinned items, play history

### Personalization

- **Themes**: dark, light, the phone's own or on a schedule, with a palette of accent colors or one of your own
- **Make it yours**: reorder and show/hide Home sections, chips and tabs, app fonts, lyrics size, mini player buttons, swipe actions and more
- **Landscape and tablet layouts**
- **In 13 languages**: English, Spanish, German, Catalan, Russian, Italian, Simplified Chinese, Ukrainian, Polish, Swedish, Brazilian Portuguese, Turkish, French

## FAQ

The questions that come up most often are answered in
[docs/FAQ.md](./docs/FAQ.md), starting with how to get Resonus to show up in
Android Auto. The app links to it too, from Settings › About.

## Translations

More languages are welcome via pull request. See
[TRANSLATING.md](./TRANSLATING.md) for how to add one, plus context for the
trickier strings.

<a href="./TRANSLATING.md"><img src="https://raw.githubusercontent.com/juananzzz/resonus/i18n-status/translations.svg" alt="Translation progress per language" /></a>

## Community

Join the [Discord server](https://discord.gg/pecE8MTPVr) to share feedback,
report bugs, ask questions, or just follow along with development.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to
set up the project, run it on an emulator, and open a pull request.

## Support

Resonus is free and open source, built in my spare time. If you enjoy it and
want to help me keep working on it, you can buy me a coffee on
[Ko-fi](https://ko-fi.com/juananzzz).

## License

Resonus is licensed under the [GNU General Public License v3.0 or later](./LICENSE).
