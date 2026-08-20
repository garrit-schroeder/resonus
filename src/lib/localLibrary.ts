/**
 * Getting at the music on the phone, for the offline mode. Two sources:
 *
 * - 'device': everything on the device, through expo-media-library.
 * - 'folder': one SAF folder, chosen by hand.
 *
 * It reads each file's ID3v2 tags (title, artist, album, track number, embedded
 * cover) and builds a catalog of albums and artists out of them. The catalog is
 * cached in memory so the tags are not read again on every query.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { StorageAccessFramework } from 'expo-file-system/legacy';
/**
 * The legacy entry point, spelled out, and it has to stay spelled out.
 *
 * SDK 56 turned `expo-media-library` into a class-based API and kept the old
 * function names at the package root as stubs that `console.warn` and then
 * THROW — `getAssetsAsync` among them. Nothing about that import stops
 * compiling or type-checking, so the phone-wide scan went on looking exactly
 * as it did and found nothing at all, every time, on every phone. The warning
 * in the log is the whole of the notice you get.
 *
 * `expo-media-library/legacy` is the same functions that worked before,
 * signatures and all. Migrating to the new API is a separate piece of work and
 * not a like-for-like swap: it hands assets over as `content://`, which is not
 * what `parentDirOf` reads for the folder an album is named after, nor what
 * `expo-file-system` opens for the tag read.
 */
import * as MediaLibrary from 'expo-media-library/legacy';

import { type Song } from '@/api/subsonic';
import { bump } from '@/lib/perfLog';
import { useScanProgress } from '@/store/scanProgress';
import { base64ToUint8, parseID3, type ID3Tags } from './id3';
import * as Db from './localDb';

const AUDIO_EXT = /\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|alac|aif|aiff)$/i;

// ── The local catalog ──────────────────────────────────────────────────────

export interface LocalAlbum {
  id: string;
  name: string;
  artist?: string;
  /**
   * The embedded cover, which only passes through here during the scan (and
   * sits in older catalogs on disk): it is written out to a file and `coverUri`
   * is left in its place.
   */
  coverBase64?: string;
  coverMime?: string;
  /** `file://` URI of the cover once written to disk. */
  coverUri?: string;
  songCount: number;
  year?: number;
  /** Date of the album's newest file (ms), for "Recently added". */
  addedAt?: number;
}

export interface LocalArtist {
  id: string;
  name: string;
  /** `file://` URI of the cover, inherited from one of their albums. */
  coverUri?: string;
  albumCount: number;
}

export interface LocalCatalog {
  songs: Song[];
  albums: LocalAlbum[];
  artists: LocalArtist[];
}

/** In-memory cache, keyed by source. */
const catalogCache = new Map<string, LocalCatalog>();

function cacheKey(sourceMode: string, uri?: string): string {
  return uri ? `${sourceMode}:${uri}` : sourceMode;
}

// ── Bounded concurrency ──────────────────────────────────────────────────────

/**
 * How many files have their tags read at once. An ID3 read is almost entirely
 * waiting on I/O (hops between JS and native), so overlapping them makes the
 * scan several times faster. A moderate number keeps the bridge and the memory
 * from being swamped: each read can bring back a cover of up to ~2 MB.
 */
const SCAN_CONCURRENCY = 8;

/** Runs `worker` over `items` with at most `limit` of them in flight at once. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/**
 * Returns a function to call after each file is dealt with. It batches the
 * progress updates so the indicator is not re-rendered once per file for the
 * whole scan.
 *
 * The batch is ~1% of the total rather than a fixed number: 20 files is a 10%
 * jump in a folder of 200 songs, which made the bar lurch, and 0.4% in one of
 * 5000, which is far more re-renders than anyone can see. At ~100 ticks the bar
 * moves just as smoothly in both.
 */
function progressBumper(total: number): () => void {
  const every = Math.max(1, Math.round(total / 100));
  let done = 0;
  let pending = 0;
  return () => {
    done++;
    pending++;
    if (pending >= every || done === total) {
      useScanProgress.getState().tick(pending);
      pending = 0;
    }
  };
}

// ── Reading ID3 off a file ─────────────────────────────────────────────────

/**
 * Ceiling on how much of a tag is read. A tag fatter than this is almost always
 * an oversized cover; whatever fits is what we keep.
 */
const TAG_CAP = 2_500_000;

/**
 * How much of a tag is read when only the text is wanted. The text frames
 * (title, artist, album, year…) come first and take a few KB; 16 KB is room to
 * spare without dragging the cover along.
 */
const TEXT_TAG_BYTES = 16_384;

/**
 * Reads `length` bytes from `position`, however many goes it takes.
 *
 * The read underneath is a single `InputStream.read(buffer, 0, length)`, and
 * that call is allowed to hand back fewer bytes than asked for: what comes
 * back is one chunk of whatever stream the file happens to be behind. Nothing
 * about it is visible from up here, because a short read is not an error, it
 * is simply a smaller buffer — and what gets cut off is the end of the tag,
 * which is where the cover lives.
 *
 * It used to be papered over by asking for a third more than was needed. That
 * cushion is proportional to the request, so it is generous for a few KB of
 * text frames and nothing at all for a 300 KB picture. Reading until the bytes
 * are actually there costs one round trip per chunk and cannot come up short.
 *
 * Whether this was ever the reason a cover went missing is not established:
 * `tag read · came up short` in Diagnostics is there to say whether it happens
 * on real files and on which source, since it cannot be seen from a
 * screenshot. A read that returns nothing is the end of the file, and the only
 * way out of the loop that is not "we have it all".
 */
async function readBytes(uri: string, position: number, length: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let got = 0;
  while (got < length) {
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: position + got,
      length: length - got,
    });
    const chunk = base64ToUint8(b64, length - got);
    if (chunk.length === 0) break;
    parts.push(chunk);
    got += chunk.length;
    // Counted: if a report still says the covers are missing and this reads
    // zero, the reading is not where to look.
    if (got < length) bump('tag read · came up short');
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(got);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Reads the ID3v2 tag buffer: the 10-byte header first and, if there is a tag,
 * up to `maxBytes` of the rest. Byte reads only, no `stat`, which is an
 * expensive hop into native and is only needed for the ID3v1 fallback, dealt
 * with separately and lazily.
 */
async function readTagBuffer(uri: string, maxBytes: number): Promise<Uint8Array | null> {
  try {
    const head = await readBytes(uri, 0, 10);
    if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) {
      return head;
    }
    const tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    return await readBytes(uri, 0, Math.min(10 + tagSize, maxBytes));
  } catch {
    return null;
  }
}

/**
 * Reads a file's ID3 tags. `maxBytes` bounds how much of the tag is brought
 * over: with `TEXT_TAG_BYTES` it stops at the text and leaves the cover out,
 * which is what the scan's first pass wants; by default it reads the whole tag.
 *
 * When the tag is cut short there are two cases. If what was left out is the
 * cover (APIC nearly always comes last) and the text arrived whole, the read
 * stands as it is: that is exactly what was asked for. If it was cut at another
 * frame, or at the cover but with the cover ahead of the text (rare, but legal)
 * and we are left with no title, the whole tag is read again: better to pay for
 * the read than to write the song off as nameless.
 *
 * If there is still no title, it tries ID3v1 at the end, reading the file size
 * to get there.
 */
export async function readTags(uri: string, maxBytes = TAG_CAP): Promise<ID3Tags | null> {
  const buf = await readTagBuffer(uri, maxBytes);
  if (!buf) return null;
  let tags = parseID3(buf);
  if (maxBytes < TAG_CAP && tags.cutFrame && (tags.cutFrame !== 'APIC' || !tags.title)) {
    const full = await readTagBuffer(uri, TAG_CAP);
    if (full) tags = parseID3(full);
  }
  // Only when ID3v2 gave no title do we go to the end for an ID3v1 tag. That is
  // rare, so the `stat` needed to know the size and read the last 128 bytes is
  // paid here rather than on every file.
  if (!tags.title) {
    try {
      const info = await FileSystem.getInfoAsync(uri);
      const fileSize = info.exists ? ((info as any).size as number) || 0 : 0;
      if (fileSize > 128) {
        const v1 = parseID3(await readBytes(uri, fileSize - 128, 128));
        if (v1.title) {
          tags.title = v1.title;
          tags.artist = tags.artist || v1.artist;
          tags.album = tags.album || v1.album;
          tags.track = tags.track ?? v1.track;
          tags.year = tags.year ?? v1.year;
        }
      }
    } catch {
      // errors reading the tail are not worth anything
    }
  }
  return tags;
}

/** A file's `mtime` in ms, for "Recently added" in folder mode. */
async function readMtime(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    // modificationTime comes in seconds; this wants ms.
    return info.exists && (info as any).modificationTime
      ? ((info as any).modificationTime as number) * 1000
      : 0;
  } catch {
    return 0;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function titleFromFilename(name: string): string {
  return name.replace(/\.[^/.]+$/, '');
}

function nameFromSafUri(uri: string): string {
  const decoded = decodeURIComponent(uri);
  const last = decoded.split('/').pop() ?? decoded;
  return titleFromFilename(last);
}

/**
 * What an album and an artist are grouped under when the file says nothing.
 *
 * They are in Spanish, and they have to stay that way: `normKey` of these is
 * the album's and the artist's id, so they are written into every catalog
 * already scanned, into the `albumId` of every song in it, and into the name of
 * every cover file on disk. Translating them here would orphan all of that.
 *
 * Nobody reads them either: what is shown for an untagged album is decided when
 * the catalog is read (see `toAlbum` in localQueries), where they become
 * "Unknown album" and "Unknown artist" in whatever language the app is in.
 */
export const UNKNOWN_ALBUM = 'Álbum desconocido';
export const UNKNOWN_ARTIST = 'Artista desconocido';

/** Normalises a string for grouping: lower case, no stray whitespace. */
export function normKey(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** A short stable hash (FNV-1a → base36), safe to use as an id in a path. */
export function hashKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** A readable folder name out of its SAF URI, without the [year] prefix. */
function folderNameFromUri(dirUri: string): string {
  const decoded = decodeURIComponent(dirUri);
  const last = (decoded.split('/').pop() ?? decoded).split(':').pop() ?? decoded;
  return last.replace(/^\[\d{4}\]\s*/, '').trim() || last;
}

/** The folder a `file://` file sits in, for device mode. */
function parentDirOf(uri: string): string | null {
  const decoded = decodeURIComponent(uri);
  const idx = decoded.lastIndexOf('/');
  if (idx <= 0) return null;
  return decoded.slice(0, idx);
}

/**
 * Assigns the album by folder: a stable id from the folder's path and, when the
 * track carries no album tag, the folder's name. That way each folder is one
 * album and a collaboration does not split it, which is what Navidrome does.
 */
function assignFolderAlbum(base: Record<string, unknown>, dirPath: string, hasAlbumTag: boolean) {
  base.albumId = 'f' + hashKey(dirPath);
  base.coverArt = base.albumId;
  if (!hasAlbumTag) base.album = folderNameFromUri(dirPath);
}

/** Which album a song belongs to: its own id, or its name normalised. */
function albumKeyOf(song: Song): string {
  return song.albumId || normKey(song.album || UNKNOWN_ALBUM);
}

/** The most frequent name in a list, which is the one worth displaying. */
function pickBestName(names: string[]): string {
  const freq = new Map<string, number>();
  for (const n of names) {
    freq.set(n, (freq.get(n) ?? 0) + 1);
  }
  let best = names[0];
  let bestCount = 0;
  for (const [n, c] of freq) {
    if (c > bestCount || (c === bestCount && n.length < best.length)) {
      best = n;
      bestCount = c;
    }
  }
  return best;
}

function groupByAlbum(songs: Song[]): LocalAlbum[] {
  const map = new Map<string, {
    songs: Song[];
    coverBase64?: string;
    coverMime?: string;
    year?: number;
    addedAt?: number;
  }>();
  for (const song of songs) {
    // The grouping key is the album id already worked out per song: in folder
    // mode that is the subfolder, whose tracks are all one album, and in device
    // mode the normalised album name. An album with collaborations is not split
    // that way; who the artist is gets decided by majority below.
    const key = albumKeyOf(song);
    let entry = map.get(key);
    if (!entry) {
      entry = { songs: [] };
      map.set(key, entry);
    }
    entry.songs.push(song);
    if (song.coverBase64) {
      entry.coverBase64 = song.coverBase64;
      entry.coverMime = song.coverMime;
    }
    if (song.year) entry.year = song.year;
    if (song.addedAt && song.addedAt > (entry.addedAt ?? 0)) entry.addedAt = song.addedAt;
  }
  // The album and artist names to display (the most frequent ones) are worked
  // out once per group and not per song, which is what keeps the scan from
  // costing O(n²).
  return Array.from(map.entries()).map(([key, v]) => {
    const artist = pickBestName(v.songs.map((s) => s.artist || UNKNOWN_ARTIST));
    return {
      id: key,
      name: pickBestName(v.songs.map((s) => s.album || UNKNOWN_ALBUM)),
      artist: artist !== UNKNOWN_ARTIST ? artist : undefined,
      coverBase64: v.coverBase64,
      coverMime: v.coverMime,
      songCount: v.songs.length,
      year: v.year,
      addedAt: v.addedAt,
    };
  });
}

function groupByArtist(albums: LocalAlbum[]): LocalArtist[] {
  const map = new Map<string, {
    albums: LocalAlbum[];
    coverUri?: string;
  }>();
  for (const album of albums) {
    const key = normKey(album.artist || UNKNOWN_ARTIST);
    let entry = map.get(key);
    if (!entry) {
      entry = { albums: [] };
      map.set(key, entry);
    }
    entry.albums.push(album);
    if (album.coverUri) entry.coverUri = album.coverUri;
  }
  return Array.from(map.entries()).map(([key, v]) => ({
    id: key,
    name: pickBestName(v.albums.map((a) => a.artist || UNKNOWN_ARTIST)),
    coverUri: v.coverUri,
    albumCount: v.albums.length,
  }));
}

/**
 * The scan's second pass: each album's cover, read out of the whole tag of one
 * single song of its own.
 *
 * The first pass reads text only (see `readTags`), so the covers are left out
 * unless they fit within `TEXT_TAG_BYTES`. They are picked up here, at one big
 * read per album instead of one per song: `groupByAlbum` keeps a single cover
 * per album and throws the rest away anyway, so reading them all was time and
 * megabytes spent on nothing.
 */
async function loadAlbumCovers(songs: Song[]): Promise<void> {
  const covered = new Set<string>();
  const candidates = new Map<string, Song>();
  for (const song of songs) {
    const key = albumKeyOf(song);
    if (song.coverBase64) {
      // A small cover, already here from the first pass: this album owes nothing.
      covered.add(key);
      candidates.delete(key);
    } else if (song.hasCover && !covered.has(key) && !candidates.has(key)) {
      candidates.set(key, song);
    }
  }
  const pending = Array.from(candidates.values());
  if (!pending.length) return;
  useScanProgress.getState().startCovers(pending.length);
  const bump = progressBumper(pending.length);
  await mapPool(pending, SCAN_CONCURRENCY, async (song) => {
    try {
      const tags = await readTags(song.localUri!);
      if (tags?.coverBase64) {
        song.coverBase64 = tags.coverBase64;
        song.coverMime = tags.coverMime;
      }
    } catch {
      // An album without a cover breaks nothing; the rest of the catalog goes on.
    }
    bump();
  });
}

async function buildCatalog(songs: Song[]): Promise<LocalCatalog> {
  await loadAlbumCovers(songs);
  const albums = groupByAlbum(songs);
  // Embedded covers are written out to files and referred to by `file://` URI:
  // that way neither the catalog nor coverIndex holds megabytes of base64 in
  // RAM, and Android Auto can embed the cover (its native bridge can only read
  // file://; a data URI is neither drawn nor bounded by the binder limit).
  await flushAlbumCovers(albums);
  const artists = groupByArtist(albums);
  // Registering the covers is what makes `localCoverUrl(albumId)` and
  // `localCoverUrl(artistId)` work across the app right after a scan.
  for (const a of albums) registerCover(a.id, a.coverUri);
  for (const a of artists) registerCover(a.id, a.coverUri);
  // The cover already lives on disk, one per album and no more. Holding it on
  // every song would be hundreds of MB in RAM across a few thousand tracks;
  // playback and the UI resolve it through `coverArt`/`albumId` and coverIndex.
  for (const s of songs) {
    delete s.coverBase64;
    delete s.coverMime;
    delete s.hasCover;
  }
  return { songs, albums, artists };
}

/** Fills a song's title, artist, album and ids in from its ID3 tags. */
function applyTags(base: Record<string, unknown>, fallbackTitle: string, tags: ID3Tags | null) {
  base.title = tags?.title || fallbackTitle;
  // The album artist (TPE2) is preferred so everything groups under one artist,
  // the way Navidrome does it; failing that, the track artist (TPE1).
  base.artist = tags?.albumArtist || tags?.artist;
  base.album = tags?.album;
  base.track = tags?.track;
  if (tags?.coverBase64) {
    base.coverBase64 = tags.coverBase64;
    base.coverMime = tags.coverMime;
  } else if (tags?.cutFrame === 'APIC') {
    // It has a cover, but the read stopped just short of it. Noting that down
    // is how `loadAlbumCovers` knows which song to come back to if its album
    // ends up with none.
    base.hasCover = true;
  }
  if (tags?.year) base.year = tags.year;
  // The file's own comment: there is no server here to tell it, so this is the
  // only way the information sheet gets to show it (#59).
  if (tags?.comment) base.comment = tags.comment;
  if (tags?.explicitStatus) base.explicitStatus = tags.explicitStatus;
  // Derived ids, which are the catalog's keys, so a song can be followed to its
  // album or artist the same way it can against a server.
  const album = (base.album as string) || UNKNOWN_ALBUM;
  const artist = (base.artist as string) || UNKNOWN_ARTIST;
  base.albumId = normKey(album);
  base.artistId = normKey(artist);
  base.coverArt = base.albumId;
}

// ── Source: the device (expo-media-library) ───────────────────────────────

// Keeps audio that is not music out when the whole device is scanned.
// MediaStore hands over EVERYTHING (voice notes, recordings, ringtones, sound
// effects), so the usual non-music folders are dropped by path: messaging apps,
// recordings, ringtones and the like. Not by duration: a short song is a real
// thing (interludes, skits).
const NON_MUSIC_PATH =
  /\/(whatsapp|telegram|signal|threema|viber|wechat|kakaotalk|line)\b|voice[ _-]?notes?|voice[ _-]?recorder|call[ _-]?rec|\/recordings?\/|\/ringtones?\/|\/notifications?\/|\/alarms?\//i;

function isLikelyMusic(uri: string): boolean {
  try {
    return !NON_MUSIC_PATH.test(decodeURIComponent(uri));
  } catch {
    return !NON_MUSIC_PATH.test(uri);
  }
}

export async function ensureAudioPermission(): Promise<boolean> {
  const current = await MediaLibrary.getPermissionsAsync(false, ['audio']);
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const res = await MediaLibrary.requestPermissionsAsync(false, ['audio']);
  return res.granted;
}

export async function loadDeviceSongs(): Promise<Song[]> {
  const key = cacheKey('device');
  const cached = catalogCache.get(key);
  if (cached) return cached.songs;
  const disk = await loadCatalogFromDisk('device');
  if (disk) {
    catalogCache.set(key, disk);
    return disk.songs;
  }

  // Finding the files and reading them are two phases and both can take a
  // while, so `begin()` puts the indicator up straight away: walking thousands
  // of files should not look like the app has hung.
  useScanProgress.getState().begin();
  const rawSongs: { id: string; filename: string; duration: number; uri: string; mtime: number }[] = [];
  let songs: Song[];
  let catalog: LocalCatalog;
  try {
    let after: string | undefined;
    let hasNext = true;
    while (hasNext && rawSongs.length < 5000) {
      const page = await MediaLibrary.getAssetsAsync({
        // Lower case: `MediaType` here is the legacy object of string values,
        // not the new API's enum, which spells the same value `AUDIO`.
        mediaType: MediaLibrary.MediaType.audio,
        first: 200,
        after,
      });
      const before = rawSongs.length;
      for (const a of page.assets) {
        // Skips folders that are not music: messaging, recordings, ringtones…
        if (!isLikelyMusic(a.uri)) continue;
        rawSongs.push({
          id: `local:${a.id}`,
          filename: a.filename,
          duration: a.duration,
          uri: a.uri,
          mtime: a.modificationTime || 0,
        });
      }
      // Once per page and not per file: they arrive 200 at a time as it is.
      useScanProgress.getState().tick(rawSongs.length - before);
      after = page.endCursor;
      hasNext = page.hasNextPage;
    }

    useScanProgress.getState().start(rawSongs.length);
    const bump = progressBumper(rawSongs.length);
    songs = await mapPool(rawSongs, SCAN_CONCURRENCY, async (raw) => {
      let tags = null;
      try {
        tags = await readTags(raw.uri, TEXT_TAG_BYTES);
      } catch {
        // If the ID3 read fails, the filename will have to do.
      }
      const base: any = { id: raw.id, localUri: raw.uri, duration: raw.duration };
      applyTags(base, titleFromFilename(raw.filename), tags);
      if (raw.mtime) base.addedAt = raw.mtime; // MediaLibrary already gives ms
      // Grouped by folder, as in folder mode: the album is decided by the
      // directory the file is in, not by each track's tags.
      const dir = parentDirOf(raw.uri);
      if (dir) assignFolderAlbum(base, dir, !!tags?.album);
      bump();
      return base as Song;
    });
    songs.sort((a, b) => a.title.localeCompare(b.title));
    // Inside the `try`: building the catalog still reads the covers, one per
    // album, and that takes time, so the indicator has to stay up.
    catalog = await buildCatalog(songs);
  } finally {
    useScanProgress.getState().done();
  }

  catalogCache.set(key, catalog);
  void saveCatalogToDisk('device', undefined, catalog);
  return songs;
}

// ── Source: one folder (Storage Access Framework) ─────────────────────────

export async function pickFolder(): Promise<string | null> {
  const res = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  return res.granted ? res.directoryUri : null;
}

export async function loadFolderSongs(treeUri: string): Promise<Song[]> {
  const key = cacheKey('folder', treeUri);
  const cached = catalogCache.get(key);
  if (cached) return cached.songs;
  const disk = await loadCatalogFromDisk('folder', treeUri);
  if (disk) {
    catalogCache.set(key, disk);
    return disk.songs;
  }

  const rawSongs: { id: string; filename: string; uri: string; dirUri: string }[] = [];

  async function walk(dirUri: string, depth: number): Promise<void> {
    if (depth > 6 || rawSongs.length >= 5000) return;
    let entries: string[];
    try {
      entries = await StorageAccessFramework.readDirectoryAsync(dirUri);
    } catch {
      return;
    }
    const before = rawSongs.length;
    for (const entryUri of entries) {
      const decoded = decodeURIComponent(entryUri);
      if (AUDIO_EXT.test(decoded)) {
        rawSongs.push({ id: `local:${entryUri}`, filename: nameFromSafUri(entryUri), uri: entryUri, dirUri });
      } else if (!/\.[a-z0-9]{1,5}$/i.test(decoded)) {
        await walk(entryUri, depth + 1);
      }
    }
    // Once per folder: walking a large tree over SAF is not instant, and
    // without this the screen sits dead until the reading starts.
    if (rawSongs.length > before) useScanProgress.getState().tick(rawSongs.length - before);
  }

  // Finding the files and reading them are two phases and both can take a
  // while, so `begin()` puts the indicator up straight away: walking the tree
  // should not look like the app has hung.
  useScanProgress.getState().begin();
  let songs: Song[];
  let catalog: LocalCatalog;
  try {
    await walk(treeUri, 0);

    useScanProgress.getState().start(rawSongs.length);
    const bump = progressBumper(rawSongs.length);
    songs = await mapPool(rawSongs, SCAN_CONCURRENCY, async (raw) => {
      let tags = null;
      let mtime = 0;
      try {
        // SAF gives no mtime in readDirectoryAsync; it is read alongside the tags.
        [tags, mtime] = await Promise.all([readTags(raw.uri, TEXT_TAG_BYTES), readMtime(raw.uri)]);
      } catch {
        // If the ID3 read fails, the filename will have to do.
      }
      const base: any = { id: raw.id, localUri: raw.uri };
      applyTags(base, raw.filename, tags);
      if (mtime) base.addedAt = mtime;
      // In folder mode each subfolder is an album, which is the most reliable
      // reading of it. Loose files at the chosen root group by their album tag
      // instead, a single being the usual case.
      if (raw.dirUri !== treeUri) assignFolderAlbum(base, raw.dirUri, !!tags?.album);
      bump();
      return base as Song;
    });
    songs.sort((a, b) => a.title.localeCompare(b.title));
    // Inside the `try`: building the catalog still reads the covers, one per
    // album, and that takes time, so the indicator has to stay up.
    catalog = await buildCatalog(songs);
  } finally {
    useScanProgress.getState().done();
  }

  catalogCache.set(key, catalog);
  void saveCatalogToDisk('folder', treeUri, catalog);
  return songs;
}

// ── Getting at the whole catalog ───────────────────────────────────────────

export function getLocalCatalog(sourceMode: string, uri?: string): LocalCatalog | undefined {
  return catalogCache.get(cacheKey(sourceMode, uri));
}

// ── The cover index ───────────────────────────────────────────────────────

const coverIndex = new Map<string, string>();

export function registerCover(id: string, uri?: string) {
  if (uri && !coverIndex.has(id)) coverIndex.set(id, uri);
}

/**
 * The same, for a picture that is meant to replace whatever was registered
 * first. The index is first come first served on purpose — a scan should not
 * undo a download — so taking a place that is already filled has to say so.
 * An artist's own picture arriving where an album cover was standing in for it
 * is the case this exists for.
 */
export function replaceCover(id: string, uri?: string) {
  if (uri) coverIndex.set(id, uri);
}

export function localCoverUrl(id: string | undefined): string | undefined {
  if (!id) return undefined;
  // A playlist's own uploaded cover already arrives as a file URI.
  if (id.startsWith('file://')) return id;
  return coverIndex.get(id);
}

/** Throws away the cached catalog and covers, as when the source changes. */
export function clearLocalCatalog(): void {
  catalogCache.clear();
  coverIndex.clear();
}

// ── Keeping the catalog on disk ─────────────────────────────────────────────
// So the ID3 tags of every file are not read again each time the local mode is
// opened: the catalog, covers and all, is saved to disk and comes back
// instantly. The "Scan again" button is what forces a fresh read.
const CATALOG_DIR = FileSystem.documentDirectory + 'local-catalog/';
// Inside CATALOG_DIR so that "Scan again", which deletes the whole directory,
// leaves no orphaned covers piling up.
const COVERS_DIR = CATALOG_DIR + 'covers/';

function catalogFile(sourceMode: string, uri?: string): string {
  return `${CATALOG_DIR}c_${hashKey(cacheKey(sourceMode, uri))}.json`;
}

/**
 * Writes each album's embedded base64 cover out to a file and leaves `coverUri`
 * in its place. An album without one is left without `coverUri` too, and gets
 * the placeholder.
 */
async function flushAlbumCovers(albums: LocalAlbum[]): Promise<void> {
  const pending = albums.filter((a) => a.coverBase64);
  if (pending.length > 0) {
    await FileSystem.makeDirectoryAsync(COVERS_DIR, { intermediates: true }).catch(() => {});
    await mapPool(pending, SCAN_CONCURRENCY, async (a) => {
      const ext = a.coverMime === 'image/png' ? 'png' : 'jpg';
      const file = `${COVERS_DIR}${hashKey(a.id)}.${ext}`;
      try {
        await FileSystem.writeAsStringAsync(file, a.coverBase64!, {
          encoding: FileSystem.EncodingType.Base64,
        });
        a.coverUri = file;
      } catch {
        // If it cannot be written, the album keeps the placeholder.
      }
    });
  }
  for (const a of albums) {
    delete a.coverBase64;
    delete a.coverMime;
  }
}

/**
 * Migration for older catalogs: artists used to carry their cover as base64, and
 * now inherit the URI of the first album of theirs that has one on disk.
 */
function migrateArtistCovers(catalog: LocalCatalog): void {
  const byArtist = new Map<string, string>();
  for (const al of catalog.albums) {
    const key = normKey(al.artist || UNKNOWN_ARTIST);
    if (al.coverUri && !byArtist.has(key)) byArtist.set(key, al.coverUri);
  }
  for (const ar of catalog.artists) {
    delete (ar as any).coverBase64;
    delete (ar as any).coverMime;
    if (!ar.coverUri) ar.coverUri = byArtist.get(ar.id);
  }
}

/** Which database this source's catalog lives in. */
function dbName(sourceMode: string, uri?: string): string {
  return `c_${hashKey(cacheKey(sourceMode, uri))}.db`;
}

async function saveCatalogToDisk(sourceMode: string, uri: string | undefined, catalog: LocalCatalog): Promise<void> {
  try {
    await FileSystem.makeDirectoryAsync(CATALOG_DIR, { intermediates: true }).catch(() => {});
    await Db.saveCatalog(CATALOG_DIR, dbName(sourceMode, uri), catalog);
  } catch {
    // If it cannot be saved, the next time will read it again. No harm done.
  }
}

async function loadCatalogFromDisk(sourceMode: string, uri?: string): Promise<LocalCatalog | null> {
  try {
    await FileSystem.makeDirectoryAsync(CATALOG_DIR, { intermediates: true }).catch(() => {});
    const stored =
      (await Db.loadCatalog<LocalAlbum, LocalArtist>(CATALOG_DIR, dbName(sourceMode, uri))) ??
      (await migrateCatalogFile(sourceMode, uri));
    if (!stored?.songs?.length) return null;
    const catalog: LocalCatalog = stored;
    // Migration: older catalogs carry their covers embedded as base64. They
    // are written out to files once and the lighter catalog is saved again.
    if (catalog.albums.some((a) => a.coverBase64)) {
      await flushAlbumCovers(catalog.albums);
      migrateArtistCovers(catalog);
      void saveCatalogToDisk(sourceMode, uri, catalog);
    }
    // The cover index is not saved separately: it is rebuilt on load.
    for (const a of catalog.albums) registerCover(a.id, a.coverUri);
    for (const a of catalog.artists) registerCover(a.id, a.coverUri);
    return catalog;
  } catch {
    return null;
  }
}

/**
 * Moves a catalog written as one JSON file into the database, once.
 *
 * Anybody using the local profile has one, and it is the whole library: without
 * this they would open the app to an empty shelf and a rescan, which on a phone
 * full of music is minutes of reading tags again. The file goes when its
 * contents are safely in.
 */
async function migrateCatalogFile(
  sourceMode: string,
  uri?: string,
): Promise<LocalCatalog | null> {
  const file = catalogFile(sourceMode, uri);
  try {
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists) return null;
    const catalog = JSON.parse(await FileSystem.readAsStringAsync(file)) as LocalCatalog;
    if (!catalog?.songs?.length) return null;
    await Db.saveCatalog(CATALOG_DIR, dbName(sourceMode, uri), catalog);
    await FileSystem.deleteAsync(file, { idempotent: true }).catch(() => {});
    return catalog;
  } catch {
    return null;
  }
}

/** Deletes the catalog kept on disk, which is what scanning again does. */
export async function clearLocalCatalogDisk(): Promise<void> {
  try {
    // The handles first: a database whose file is deleted underneath it keeps
    // answering from a file nobody can see any more.
    await Db.closeLocalDbs();
    await FileSystem.deleteAsync(CATALOG_DIR, { idempotent: true });
  } catch {
    // ignore
  }
}
