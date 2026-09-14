/**
 * Lyrics for local/offline music, in order of preference:
 *
 * 1. `.ttml` or `.lrc` file next to the audio file (same name), in that order
 *    as Navidrome reads them. Also covers downloads: when downloading a song
 *    the server lyrics are cached in the `.lrc`.
 * 2. Embedded lyrics in the file itself (ID3 USLT frame).
 * 3. LRCLIB (lrclib.net), only if the user enables the setting: sends artist
 *    and title externally. The result is cached to disk to avoid re-fetching.
 */
// Not the global `fetch`: it never resolves in the background. See the note
// in `src/api/subsonic.ts`.
import { fetch } from 'expo/fetch';
import * as FileSystem from 'expo-file-system/legacy';

import { type Song, type SongLyrics } from '@/api/subsonic';
import { hashKey, readTags } from './localLibrary';
import { parseLrc } from './lrc';
import { parseTtml } from './ttml';
import { isManualOffline } from '@/api/netGate';

const LRCLIB_CACHE_DIR = FileSystem.documentDirectory + 'lyrics-cache/';
/** Who is asking, for LRCLIB. Sent as both headers: see `fetchLrclib`. */
const CLIENT_UA = 'Resonus (https://github.com/juananzzz/resonus)';
const AUDIO_EXT_RE = /\.[a-z0-9]{1,5}$/i;

/** URI of a sibling file next to an audio file (works for `file://` and SAF). */
function siblingUri(audioUri: string, ext: string): string | null {
  if (!AUDIO_EXT_RE.test(audioUri)) return null;
  return audioUri.replace(AUDIO_EXT_RE, ext);
}

/** URI of the sibling `.lrc` next to an audio file. */
export function siblingLrcUri(audioUri: string): string | null {
  return siblingUri(audioUri, '.lrc');
}

/** Reads a text file; null if it doesn't exist or can't be read. */
async function readTextIfExists(uri: string): Promise<string | null> {
  try {
    const text = await FileSystem.readAsStringAsync(uri);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Reads on-device lyrics only: sibling `.ttml`, `.lrc`, then embedded USLT. */
async function getFileLyrics(song: Song): Promise<SongLyrics | null> {
  const uri = song.localUri;
  if (!uri) return null;
  // 1) .ttml next to the audio file, ahead of the .lrc: with both there, it is
  // the one timed word by word (#165).
  const ttmlUri = siblingUri(uri, '.ttml');
  const ttmlText = ttmlUri ? await readTextIfExists(ttmlUri) : null;
  const fromTtml = ttmlText ? parseTtml(ttmlText) : null;
  if (fromTtml) return fromTtml;

  // 2) .lrc next to the audio file.
  const lrcUri = siblingLrcUri(uri);
  const lrcText = lrcUri ? await readTextIfExists(lrcUri) : null;
  const fromFile = lrcText ? parseLrc(lrcText) : null;
  if (fromFile) return fromFile;

  // 3) Embedded USLT (may contain LRC-style timestamps inside).
  const tags = await readTags(uri);
  return tags?.lyrics ? parseLrc(tags.lyrics) : null;
}

/**
 * Local/offline lyrics. Normally on-device first with LRCLIB as fallback; with
 * `preferOnline` the order flips (LRCLIB first, on-device as fallback). LRCLIB
 * is only used when `allowOnline` is set.
 */
export async function getLocalLyrics(
  song: Song,
  allowOnline: boolean,
  preferOnline = false,
): Promise<SongLyrics | null> {
  if (allowOnline && preferOnline) {
    return (await getOnlineLyrics(song)) ?? (await getFileLyrics(song));
  }
  const fromFile = await getFileLyrics(song);
  if (fromFile) return fromFile;
  if (allowOnline) return getOnlineLyrics(song);
  return null;
}

/**
 * Lyrics from LRCLIB with disk cache. Also serves as last resort for server
 * songs whose server doesn't have lyrics.
 */
export async function getOnlineLyrics(song: Song): Promise<SongLyrics | null> {
  const file = `${LRCLIB_CACHE_DIR}${hashKey(song.id)}.lrc`;
  const cached = await readTextIfExists(file);
  if (cached) return parseLrc(cached);
  const text = await fetchLrclib(song);
  if (!text) return null;
  try {
    await FileSystem.makeDirectoryAsync(LRCLIB_CACHE_DIR, { intermediates: true }).catch(() => {});
    await FileSystem.writeAsStringAsync(file, text);
  } catch {
    // Without cache we still work; it would just repeat the request.
  }
  return parseLrc(text);
}

interface LrclibResult {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
}

function pickLrclibText(r: LrclibResult | undefined): string | null {
  if (!r || r.instrumental) return null;
  return r.syncedLyrics?.trim() || r.plainLyrics?.trim() || null;
}

/** Searches LRCLIB for lyrics by artist+title. Returns LRC/plain text. */
/** Only in development: where a lyrics lookup went, since it never throws. */
function trace(what: string, song: Song): void {
  if (__DEV__) console.log(`[lyrics] lrclib · ${what} · ${song.artist} — ${song.title}`);
}

async function fetchLrclib(song: Song): Promise<string | null> {
  if (!song.title || !song.artist) {
    trace('not asked: the song has no artist or no title', song);
    return null;
  }
  // LRCLIB is somebody else's server, but it is reached the same way and costs
  // the same data, so an offline somebody asked for covers it too: the .lrc
  // cached next to a download is read before this is ever called.
  //
  // An offline the app fell into is a different thing. It means one server
  // stopped answering, not that the phone has no connection, and taking the
  // lyrics away too made the app look broken to whoever never noticed the
  // mode had changed.
  if (isManualOffline()) {
    trace('not asked: offline was chosen', song);
    return null;
  }
  // The User-Agent is not politeness, it is the request working at all. React
  // Native sends okhttp's own on Android, and LRCLIB answers that with a 520
  // from Cloudflare: every lookup failed, silently, on every Android phone.
  // Anything that identifies the client is accepted, and identifying it is
  // what their API asks for anyway.
  const headers = {
    'Lrclib-Client': CLIENT_UA,
    'User-Agent': CLIENT_UA,
  };
  try {
    // /api/get requires the full signature (album + duration); if we have it,
    // it's the most precise path. If not (or 404), /api/search and the first match.
    if (song.album && song.duration) {
      const params = new URLSearchParams({
        artist_name: song.artist,
        track_name: song.title,
        album_name: song.album,
        duration: String(Math.round(song.duration)),
      });
      const res = await fetch(`https://lrclib.net/api/get?${params}`, { headers });
      trace(`get ${res.status}`, song);
      if (res.ok) {
        const text = pickLrclibText((await res.json()) as LrclibResult);
        if (text) return text;
      }
    }
    const params = new URLSearchParams({ artist_name: song.artist, track_name: song.title });
    const res = await fetch(`https://lrclib.net/api/search?${params}`, { headers });
    trace(`search ${res.status}`, song);
    if (!res.ok) return null;
    const results = (await res.json()) as LrclibResult[];
    for (const r of results) {
      const text = pickLrclibText(r);
      if (text) return text;
    }
    trace(`search matched nothing (${results.length} results)`, song);
    return null;
  } catch (e) {
    // No network or the API down: simply no lyrics. Said out loud in
    // development, because a feature that fails in silence cannot be told
    // apart from one that was never asked.
    trace(`failed: ${e instanceof Error ? e.message : String(e)}`, song);
    return null;
  }
}
