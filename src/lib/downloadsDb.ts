/**
 * The download catalog, in SQLite.
 *
 * It used to be one JSON file per profile holding every downloaded song and
 * album. Any change rewrote the whole thing, and reading it meant parsing all
 * of it into memory before the app could answer the simplest question. On a
 * library of twelve thousand songs that was measured at sixteen seconds to
 * read and thirty seven to write, on the thread that draws the screen (#50).
 *
 * The audio files are not touched by any of this. What changes is the index
 * of them: where each song lives, what it weighs and which album it belongs
 * to. One database per profile, next to that profile's files, so removing a
 * profile still means removing its directory.
 *
 * On the shape of the tables: everything that is filtered, sorted or added up
 * is a real column, and the rest of the song travels along as JSON in `data`.
 * Putting the whole catalog in one JSON column would be the old problem with
 * extra steps; putting the twenty five optional fields of a Subsonic song in
 * twenty five columns would be a migration every time the API grows one.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

import type { Album, Song } from '@/api/subsonic';
import type { Remap, RemapPair } from './navidromeRemap';
import { planRemap, remapAlbum, remapSong } from './navidromeRemap';
import { timed } from './perfLog';

/** Downloaded album: the server's, plus its local cover and download date. */
export type DlAlbum = Album & { coverUri?: string; addedAt?: number; dlBytes?: number };

/**
 * A downloaded album's artist, with their own picture.
 *
 * Artists used to be worked out from the albums alone, which gives their name
 * and their record count but no likeness of them: offline, the artist screen
 * wore whichever album cover came first. So this table holds the one thing the
 * albums cannot say. It has no `data` column, unlike the other two, because
 * there is nothing else of an artist to keep: the discography is the albums.
 *
 * `serverId` is what the server calls them. Everything else here is keyed by
 * `id`, which is their name normalized, because that is the id a scan of the
 * phone would give them and downloads have always merged with a scan. Keeping
 * both is what lets an artist opened by the server's id — from the mirror, or
 * from a search made while online — land on this same artist offline instead
 * of on an empty screen.
 */
export interface DlArtist {
  id: string;
  name: string;
  serverId?: string;
  coverUri?: string;
  dlBytes?: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
-- The write-ahead log is only truncated back down when a checkpoint is told
-- what size to leave behind; without this it stays at its high water mark for
-- as long as the connection lives, which here is the whole session. Measured
-- at 4 MB of log for 356 KB of database after an afternoon of downloading.
PRAGMA journal_size_limit = 524288;
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY NOT NULL,
  album_id TEXT,
  title TEXT,
  artist TEXT,
  disc INTEGER,
  track INTEGER,
  added_at INTEGER,
  dl_bytes INTEGER,
  local_uri TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS songs_album ON songs(album_id);
CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  artist TEXT,
  artist_id TEXT,
  added_at INTEGER,
  dl_bytes INTEGER,
  cover_uri TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS albums_artist ON albums(artist_id);
CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  server_id TEXT,
  dl_bytes INTEGER,
  cover_uri TEXT
);
CREATE INDEX IF NOT EXISTS artists_server ON artists(server_id);
`;

/** One handle per profile directory, opened once. */
const open = new Map<string, Promise<SQLite.SQLiteDatabase>>();

/** The directory already identifies the profile, so the name doesn't have to. */
const DB_NAME = 'catalog.db';

async function openDb(dir: string): Promise<SQLite.SQLiteDatabase> {
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  // The file system module speaks URIs and SQLite speaks paths: it joins the
  // directory and the name as plain text and hands the result to the native
  // open, which knows nothing about `file://`.
  const db = await SQLite.openDatabaseAsync(DB_NAME, {}, dir.replace(/^file:\/\//, ''));
  await db.execAsync(SCHEMA);
  await migrateFromJson(dir, db);
  return db;
}

function catalogDb(dir: string): Promise<SQLite.SQLiteDatabase> {
  const existing = open.get(dir);
  if (existing) return existing;
  // A failure is not remembered. Leaving the rejected promise in the map hands
  // it to every later caller, so one bad moment — no room on disk, a file that
  // wasn't ready — turns into a catalog that stays broken for the rest of the
  // session: nothing downloaded shows, nothing new is written down, deleting
  // fails. Forgetting it means the next caller simply tries again.
  const handle: Promise<SQLite.SQLiteDatabase> = openDb(dir).catch((e) => {
    if (open.get(dir) === handle) open.delete(dir);
    throw e;
  });
  open.set(dir, handle);
  return handle;
}

/** Closes and forgets one profile's catalog, for when its files are about to
 *  go: a handle left open would outlive the file it points at. */
export async function closeCatalog(dir: string): Promise<void> {
  const handle = open.get(dir);
  if (!handle) return;
  open.delete(dir);
  await handle.then((db) => db.closeAsync()).catch(() => {});
}

/** Closes and forgets every open database (profile change, clear all). */
export async function closeCatalogs(): Promise<void> {
  const handles = [...open.values()];
  open.clear();
  for (const h of handles) {
    await h.then((db) => db.closeAsync()).catch(() => {});
  }
}

// ── Coming from the JSON ────────────────────────────────────────────────────

function jsonFile(dir: string): string {
  return `${dir}catalog.json`;
}

/**
 * Moves an existing `catalog.json` into the database, once.
 *
 * The old file is kept, renamed, and only after the row count matches what it
 * held. It is the record of where someone's downloaded music lives: if
 * anything here is wrong, the answer is to still have it, not to have deleted
 * it. A later version can remove it.
 */
async function migrateFromJson(dir: string, db: SQLite.SQLiteDatabase): Promise<void> {
  const file = jsonFile(dir);
  const info = await FileSystem.getInfoAsync(file).catch(() => null);
  if (!info?.exists) return;
  // Anything already here means a previous run did this, or the app has been
  // writing to the database since. The file is the stale one.
  const existing = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM songs');
  if ((existing?.n ?? 0) > 0) return;

  let parsed: { songs?: Song[]; albums?: DlAlbum[] } = {};
  try {
    const raw = await timed('catalog migrate read', () =>
      FileSystem.readAsStringAsync(file),
    );
    parsed = JSON.parse(raw) as { songs?: Song[]; albums?: DlAlbum[] };
  } catch {
    // Unreadable or not JSON: leave it exactly where it is and start empty.
    return;
  }
  const songs = parsed.songs ?? [];
  const albums = parsed.albums ?? [];
  if (songs.length === 0 && albums.length === 0) return;

  await timed('catalog migrate write', async () => {
    await serialized(() =>
      db.withTransactionAsync(async () => {
        for (const s of songs) await insertSong(db, s);
        for (const a of albums) await insertAlbum(db, a);
      }),
    );
  });

  const after = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM songs');
  if ((after?.n ?? 0) < songs.length) return; // short: keep the file as it is
  await FileSystem.moveAsync({ from: file, to: `${file}.bak` }).catch(() => {});
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Writes go one at a time.
 *
 * Two transactions at once on the same connection is an error, not a wait, and
 * downloads commit from several workers in parallel: "cannot start a
 * transaction within a transaction" is what that looks like. The JSON had a
 * lock for the same reason; this is that lock, kept where the writes are.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}


async function insertSong(db: SQLite.SQLiteDatabase, s: Song): Promise<void> {
  await db.runAsync(
    `INSERT OR REPLACE INTO songs
       (id, album_id, title, artist, disc, track, added_at, dl_bytes, local_uri, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.id,
      s.albumId ?? null,
      s.title ?? null,
      s.artist ?? null,
      s.discNumber ?? null,
      s.track ?? null,
      s.addedAt ?? null,
      s.dlBytes ?? null,
      s.localUri ?? null,
      JSON.stringify(s),
    ],
  );
}

async function insertAlbum(db: SQLite.SQLiteDatabase, a: DlAlbum): Promise<void> {
  await db.runAsync(
    `INSERT OR REPLACE INTO albums
       (id, name, artist, artist_id, added_at, dl_bytes, cover_uri, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      a.id,
      a.name ?? null,
      a.artist ?? null,
      a.artistId ?? null,
      a.addedAt ?? null,
      a.dlBytes ?? null,
      a.coverUri ?? null,
      JSON.stringify(a),
    ],
  );
}

/** Adds songs and albums. What is already there is replaced, not duplicated. */
export async function addToCatalog(
  dir: string,
  changes: { songs?: Song[]; albums?: DlAlbum[] },
): Promise<void> {
  const { songs = [], albums = [] } = changes;
  if (songs.length === 0 && albums.length === 0) return;
  const db = await catalogDb(dir);
  await serialized(() =>
    db.withTransactionAsync(async () => {
      for (const s of songs) await insertSong(db, s);
      for (const a of albums) await insertAlbum(db, a);
    }),
  );
}

/**
 * Writes down the artists of what has been downloaded.
 *
 * An upsert rather than a replace, and each field kept when the new row says
 * nothing about it: the artist is written once when their first album is
 * downloaded, when there may be no picture to be had yet, and again later from
 * the artist screen, which is where the picture usually comes from. A replace
 * would have the second write undo the first.
 */
export async function saveArtists(dir: string, artists: DlArtist[]): Promise<void> {
  if (artists.length === 0) return;
  const db = await catalogDb(dir);
  await serialized(() =>
    db.withTransactionAsync(async () => {
      for (const a of artists) {
        await db.runAsync(
          `INSERT INTO artists (id, name, server_id, dl_bytes, cover_uri)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             server_id = COALESCE(excluded.server_id, server_id),
             dl_bytes = COALESCE(excluded.dl_bytes, dl_bytes),
             cover_uri = COALESCE(excluded.cover_uri, cover_uri)`,
          [a.id, a.name, a.serverId ?? null, a.dlBytes ?? null, a.coverUri ?? null],
        );
      }
    }),
  );
}

/**
 * The most a single statement gets asked about at once.
 *
 * SQLite counts placeholders, not rows, and refuses past a limit that a
 * discography can reach on its own. Deleting an artist's downloads would have
 * failed on exactly the libraries this is meant to help.
 */
const PARAM_CHUNK = 400;

function chunked<T>(items: T[], size = PARAM_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Removes songs, and any album left without them. Returns what was removed,
 *  so the caller can delete the files those rows pointed at. */
export async function removeFromCatalog(
  dir: string,
  ids: string[],
): Promise<{ songs: Song[]; albums: DlAlbum[] }> {
  if (ids.length === 0) return { songs: [], albums: [] };
  const db = await catalogDb(dir);

  const songs: Song[] = [];
  for (const part of chunked(ids)) {
    const marks = part.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ data: string }>(
      `SELECT data FROM songs WHERE id IN (${marks})`,
      part,
    );
    for (const r of rows) songs.push(JSON.parse(r.data) as Song);
  }
  if (songs.length === 0) return { songs: [], albums: [] };

  await serialized(() =>
    db.withTransactionAsync(async () => {
      for (const part of chunked(ids)) {
        const marks = part.map(() => '?').join(',');
        await db.runAsync(`DELETE FROM songs WHERE id IN (${marks})`, part);
      }
    }),
  );

  // Now that they are gone, whichever albums are left with nothing. Asked
  // after the fact rather than predicted, so it needs no parameters at all.
  const empty = await db.getAllAsync<{ data: string }>(
    `SELECT data FROM albums WHERE id NOT IN
       (SELECT DISTINCT album_id FROM songs WHERE album_id IS NOT NULL)`,
  );
  if (empty.length > 0) {
    await serialized(() =>
      db.runAsync(
      `DELETE FROM albums WHERE id NOT IN
         (SELECT DISTINCT album_id FROM songs WHERE album_id IS NOT NULL)`,
      ),
    );
  }
  return { songs, albums: empty.map((r) => JSON.parse(r.data) as DlAlbum) };
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Song id to file, for the whole profile.
 *
 * Two columns rather than the whole catalog: this is what the interface asks
 * about constantly (is this one downloaded?) and what used to cost parsing
 * every song in the library to answer.
 */
export async function downloadedFiles(dir: string): Promise<Record<string, string>> {
  const db = await catalogDb(dir);
  // Two columns and nothing else. The bitrate lives inside the row's JSON and
  // used to be dug out here with `json_extract`, which is SQLite parsing that
  // JSON once per row: on a library of sixty thousand songs that is sixty
  // thousand parses on the path the offline start waits for before it can show
  // anything. It is asked for on its own now (see `downloadedBitRates`), out of
  // the way of the opening.
  // In pages, with a turn given back to everyone else between them. The whole
  // catalog in one go is a single block of work with sixty thousand rows in it
  // on a large library, and nothing else runs while it happens: not the first
  // paint, not a tap. Paged, it takes about the same total and stops being a
  // freeze.
  const files: Record<string, string> = {};
  for (let offset = 0; ; offset += PAGE) {
    const rows = await db.getAllAsync<{ id: string; local_uri: string | null }>(
      'SELECT id, local_uri FROM songs WHERE local_uri IS NOT NULL LIMIT ? OFFSET ?',
      [PAGE, offset],
    );
    for (const r of rows) {
      if (!r.local_uri) continue;
      files[r.id] = r.local_uri;
    }
    if (rows.length < PAGE) return files;
  }
}

/** Rows per page of the two reads above. Large enough that the round trips do
 *  not add up, small enough that a page is not a freeze. */
const PAGE = 2000;

/**
 * What each downloaded song was transcoded at, for the ones that were.
 *
 * Only the quality badge and the export note read it, both about one song at a
 * time and both a screen away, so it is fetched after the app is up rather
 * than in the middle of it opening.
 */
export async function downloadedBitRates(dir: string): Promise<Record<string, number>> {
  const db = await catalogDb(dir);
  const out: Record<string, number> = {};
  for (let offset = 0; ; offset += PAGE) {
    const rows = await db.getAllAsync<{ id: string; bit: number | null }>(
      `SELECT id, json_extract(data, '$.dlBitRate') AS bit
         FROM songs WHERE local_uri IS NOT NULL AND data LIKE '%dlBitRate%'
         LIMIT ? OFFSET ?`,
      [PAGE, offset],
    );
    for (const r of rows) if (r.bit != null) out[r.id] = r.bit;
    if (rows.length < PAGE) return out;
  }
}

/**
 * Has this album got anything downloaded? Asked without reading any of it.
 *
 * The album screen asks this every time it opens, and it used to be answered by
 * building the whole catalog in memory and searching it, which is the cost this
 * table exists to avoid.
 */
export async function albumHasSongs(dir: string, albumId: string): Promise<boolean> {
  const db = await catalogDb(dir);
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT 1 AS n FROM songs WHERE album_id = ? LIMIT 1',
    [albumId],
  );
  return !!row;
}

/**
 * The queries the offline screens actually make, answered by the database.
 *
 * Browsing offline used to mean `allSongs` and `allAlbums` in memory and a
 * `filter` per screen: opening a twelve track album walked fifteen thousand
 * songs, and so did every sort, every search and every artist. These do the
 * walking in SQLite, over indexed columns, and hand back the rows asked for.
 */
export async function albumsPage(
  dir: string,
  order: 'name' | 'artist' | 'newest' | 'random',
  limit: number,
  offset: number,
): Promise<DlAlbum[]> {
  const db = await catalogDb(dir);
  const by = {
    name: 'name COLLATE NOCASE ASC',
    artist: 'artist COLLATE NOCASE ASC, name COLLATE NOCASE ASC',
    newest: 'added_at DESC',
    random: 'RANDOM()',
  }[order];
  const rows = await timed('catalog albums page', () =>
    db.getAllAsync<{ data: string }>(
      `SELECT data FROM albums ORDER BY ${by} LIMIT ? OFFSET ?`,
      [limit, offset],
    ),
  );
  return rows.map((r) => JSON.parse(r.data) as DlAlbum);
}

/** One album's songs, in disc and track order. */
export async function albumSongs(dir: string, albumId: string): Promise<Song[]> {
  const db = await catalogDb(dir);
  const rows = await timed('catalog album songs', () =>
    db.getAllAsync<{ data: string }>(
      `SELECT data FROM songs WHERE album_id = ?
        ORDER BY disc IS NULL, disc, track IS NULL, track, title COLLATE NOCASE`,
      [albumId],
    ),
  );
  return rows.map((r) => JSON.parse(r.data) as Song);
}

/** The albums of one artist, by the key their songs were filed under. */
export async function artistAlbums(dir: string, artistId: string): Promise<DlAlbum[]> {
  const db = await catalogDb(dir);
  const rows = await timed('catalog artist albums', () =>
    db.getAllAsync<{ data: string }>(
      `SELECT data FROM albums WHERE artist_id = ? ORDER BY added_at DESC, name COLLATE NOCASE`,
      [artistId],
    ),
  );
  return rows.map((r) => JSON.parse(r.data) as DlAlbum);
}

/** A page of songs, in the order the screen asked for. */
export async function songsPage(
  dir: string,
  order: 'title' | 'artist' | 'newest' | 'random',
  limit: number,
  offset: number,
): Promise<Song[]> {
  const db = await catalogDb(dir);
  const by = {
    title: 'title COLLATE NOCASE ASC',
    artist: 'artist COLLATE NOCASE ASC, title COLLATE NOCASE ASC',
    newest: 'added_at DESC',
    random: 'RANDOM()',
  }[order];
  const rows = await timed('catalog songs page', () =>
    db.getAllAsync<{ data: string }>(
      `SELECT data FROM songs ORDER BY ${by} LIMIT ? OFFSET ?`,
      [limit, offset],
    ),
  );
  return rows.map((r) => JSON.parse(r.data) as Song);
}

/** Songs whose title or artist contains the text. */
export async function searchSongs(dir: string, text: string, limit: number): Promise<Song[]> {
  const db = await catalogDb(dir);
  const like = `%${text}%`;
  const rows = await timed('catalog search songs', () =>
    db.getAllAsync<{ data: string }>(
      `SELECT data FROM songs WHERE title LIKE ? OR artist LIKE ?
        ORDER BY title COLLATE NOCASE LIMIT ?`,
      [like, like, limit],
    ),
  );
  return rows.map((r) => JSON.parse(r.data) as Song);
}

/** Albums whose name or artist contains the text. */
export async function searchAlbums(dir: string, text: string, limit: number): Promise<DlAlbum[]> {
  const db = await catalogDb(dir);
  const like = `%${text}%`;
  const rows = await timed('catalog search albums', () =>
    db.getAllAsync<{ data: string }>(
      `SELECT data FROM albums WHERE name LIKE ? OR artist LIKE ?
        ORDER BY name COLLATE NOCASE LIMIT ?`,
      [like, like, limit],
    ),
  );
  return rows.map((r) => JSON.parse(r.data) as DlAlbum);
}

/**
 * An artist whose albums are filed under somebody else's name.
 *
 * A song's artist and its album's are not always the same string: a track
 * credited to two people sits on an album credited to one, and the ids here
 * are made from those strings, so the artist you tapped may own no album at
 * all. Their name and what they play are in their songs.
 */
export async function artistFromSongs(
  dir: string,
  artistId: string,
): Promise<{ name?: string; albumIds: string[] }> {
  const db = await catalogDb(dir);
  return timed('catalog artist songs', async () => {
    const rows = await db.getAllAsync<{ artist: string | null; album_id: string | null }>(
      `SELECT DISTINCT artist, album_id FROM songs
        WHERE json_extract(data, '$.artistId') = ?`,
      [artistId],
    );
    const albumIds = rows.map((r) => r.album_id).filter((id): id is string => !!id);
    return { name: rows.find((r) => r.artist)?.artist ?? undefined, albumIds };
  });
}

/** The albums with these ids, for an artist reached through their songs. */
export async function albumsByIds(dir: string, ids: string[]): Promise<DlAlbum[]> {
  if (ids.length === 0) return [];
  const db = await catalogDb(dir);
  const marks = ids.map(() => '?').join(',');
  const rows = await db.getAllAsync<{ data: string }>(
    `SELECT data FROM albums WHERE id IN (${marks}) ORDER BY added_at DESC, name COLLATE NOCASE`,
    ids,
  );
  return rows.map((r) => JSON.parse(r.data) as DlAlbum);
}

/** The ones with these ids, for lists whose order comes from elsewhere. */
export async function songsByIds(dir: string, ids: string[]): Promise<Map<string, Song>> {
  const out = new Map<string, Song>();
  if (ids.length === 0) return out;
  const db = await catalogDb(dir);
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const marks = part.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ id: string; data: string }>(
      `SELECT id, data FROM songs WHERE id IN (${marks})`,
      part,
    );
    for (const r of rows) out.set(r.id, JSON.parse(r.data) as Song);
  }
  return out;
}

/**
 * A handful of song ids, without reading the songs.
 *
 * The migration probe needs six ids and nothing else. `allSongs` would parse
 * every song in the catalog to hand them over, which on twelve thousand of
 * them is the freeze that #50 was about, spent on a question that is almost
 * always answered "no".
 */
export async function someSongIds(dir: string, limit: number): Promise<string[]> {
  const db = await catalogDb(dir);
  const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM songs LIMIT ?', [limit]);
  return rows.map((r) => r.id);
}

export async function allSongs(dir: string): Promise<Song[]> {
  const db = await catalogDb(dir);
  const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM songs');
  return rows.map((r) => JSON.parse(r.data) as Song);
}

/**
 * Albums, each with how many of its songs are actually downloaded.
 *
 * That count is what the offline library shows, and it is not the one the
 * server sent: an album can be half downloaded. It used to be kept in the
 * stored album and recomputed on every change, which is what made committing a
 * song scan the whole catalog. Here it is asked for when it is needed.
 */
export async function allAlbums(dir: string): Promise<DlAlbum[]> {
  const db = await catalogDb(dir);
  const rows = await db.getAllAsync<{ data: string; n: number }>(
    `SELECT a.data AS data, (SELECT COUNT(*) FROM songs s WHERE s.album_id = a.id) AS n
     FROM albums a`,
  );
  return rows.map((r) => ({ ...(JSON.parse(r.data) as DlAlbum), songCount: r.n }));
}

/** Every artist written down, for the shelf that draws them. */
export async function allArtists(dir: string): Promise<DlArtist[]> {
  const db = await catalogDb(dir);
  const rows = await db.getAllAsync<{
    id: string;
    name: string | null;
    server_id: string | null;
    cover_uri: string | null;
  }>('SELECT id, name, server_id, cover_uri FROM artists');
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? '',
    serverId: r.server_id ?? undefined,
    coverUri: r.cover_uri ?? undefined,
  }));
}

/**
 * The artist the server calls this, if their music is downloaded.
 *
 * The crossing between the two ids, and the reason the column exists: offline,
 * anything that remembers an artist from when there was a connection — a
 * recent search, a mirrored album — names them the server's way, and that name
 * means nothing to a catalog keyed by the artist's own.
 */
export async function artistByServerId(
  dir: string,
  serverId: string,
): Promise<DlArtist | undefined> {
  const db = await catalogDb(dir);
  const row = await db.getFirstAsync<{
    id: string;
    name: string | null;
    cover_uri: string | null;
  }>('SELECT id, name, cover_uri FROM artists WHERE server_id = ? LIMIT 1', [serverId]);
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name ?? '',
    serverId,
    coverUri: row.cover_uri ?? undefined,
  };
}

/** And back the other way, for an id that only means something on this phone. */
export async function serverIdOfArtist(dir: string, id: string): Promise<string | undefined> {
  const db = await catalogDb(dir);
  const row = await db.getFirstAsync<{ server_id: string | null }>(
    'SELECT server_id FROM artists WHERE id = ? LIMIT 1',
    [id],
  );
  return row?.server_id ?? undefined;
}

/**
 * Artists whose last album has just gone. Returned before they are deleted, so
 * the caller can take their picture off the disk as well.
 */
export async function dropEmptyArtists(dir: string): Promise<DlArtist[]> {
  const db = await catalogDb(dir);
  const rows = await db.getAllAsync<{ id: string; name: string | null; cover_uri: string | null }>(
    `SELECT id, name, cover_uri FROM artists WHERE id NOT IN
       (SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL)`,
  );
  if (rows.length === 0) return [];
  await serialized(() =>
    db.runAsync(
      `DELETE FROM artists WHERE id NOT IN
         (SELECT DISTINCT artist_id FROM albums WHERE artist_id IS NOT NULL)`,
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? '',
    coverUri: r.cover_uri ?? undefined,
  }));
}

/** How many songs there are, without reading any of them. */
export async function songCount(dir: string): Promise<number> {
  const db = await catalogDb(dir);
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM songs');
  return row?.n ?? 0;
}

/**
 * What the downloads take on disk, added up by the database.
 *
 * Sizes are written down when each file is downloaded. Anything from before
 * that has none, and those are reported apart so the caller can measure them
 * once and store them, rather than measuring everything every time.
 */
export async function usageBytes(
  dir: string,
): Promise<{ known: number; missing: { id: string; uri: string }[] }> {
  const db = await catalogDb(dir);
  const songs = await db.getFirstAsync<{ total: number | null }>(
    'SELECT SUM(dl_bytes) AS total FROM songs',
  );
  const albums = await db.getFirstAsync<{ total: number | null }>(
    'SELECT SUM(dl_bytes) AS total FROM albums',
  );
  // The artists' pictures are files on this disk like any other, and a library
  // of a few hundred of them is not nothing.
  const artists = await db.getFirstAsync<{ total: number | null }>(
    'SELECT SUM(dl_bytes) AS total FROM artists',
  );
  const missing = await db.getAllAsync<{ id: string; local_uri: string }>(
    'SELECT id, local_uri FROM songs WHERE local_uri IS NOT NULL AND dl_bytes IS NULL',
  );
  return {
    known: (songs?.total ?? 0) + (albums?.total ?? 0) + (artists?.total ?? 0),
    missing: missing.map((r) => ({ id: r.id, uri: r.local_uri })),
  };
}

/** Writes down sizes measured after the fact, so it happens once per file. */
export async function setSongBytes(
  dir: string,
  sizes: { id: string; bytes: number }[],
): Promise<void> {
  if (sizes.length === 0) return;
  const db = await catalogDb(dir);
  await serialized(() =>
    db.withTransactionAsync(async () => {
      for (const s of sizes) {
        await db.runAsync('UPDATE songs SET dl_bytes = ? WHERE id = ?', [s.bytes, s.id]);
      }
    }),
  );
}

/* ── Repairing the ids after a server migration ───────────────────────────── */

/**
 * Two ids that would become one. Never seen in practice, and fatal if ignored:
 * rewriting one primary key onto another loses a row, and the failure would
 * arrive as a constraint error halfway through the transaction.
 */
export class CatalogCollisionError extends Error {
  constructor(readonly pairs: RemapPair[]) {
    super(`${pairs.length} ids would collide`);
    this.name = 'CatalogCollisionError';
  }
}

/** Where a row's id came from, so a repair can be undone. Added on demand:
 *  the catalog predates it and `CREATE TABLE IF NOT EXISTS` never revisits a
 *  table that is already there. */
async function addLegacyColumns(db: SQLite.SQLiteDatabase): Promise<void> {
  for (const table of ['songs', 'albums']) {
    // No IF NOT EXISTS for columns in SQLite, and asking first costs a query
    // per table on a path that runs once.
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN legacy_id TEXT`).catch(() => {});
  }
}

/** Lets the screen draw between batches. A catalog of twelve thousand songs is
 *  twelve thousand JSON parses, and doing them in one go is what made reading
 *  the old JSON catalog a sixteen second freeze (#50). */
const REPAIR_BATCH = 500;
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

/**
 * Rewrites every server id in the download catalog, in one transaction.
 *
 * The audio files are not touched and do not move. Each row keeps its
 * `local_uri`, which is how a downloaded file is found: nothing recomputes a
 * path from an id, so the bytes stay where they are under the name they
 * already have. The same goes for the covers.
 *
 * The expensive half is deliberately outside the transaction. Reading and
 * re-serialising the song JSON is the part that costs seconds; the writes are
 * fast. Holding the database for the parsing as well would block every reader
 * for the whole of it, for no atomicity that matters: a row inserted in that
 * window simply does not get remapped, and since this is idempotent the next
 * pass takes it.
 */
export async function remapCatalogIds(
  dir: string,
  f: Remap,
): Promise<{ songs: number; albums: number }> {
  const db = await catalogDb(dir);
  await addLegacyColumns(db);

  const songRows = await db.getAllAsync<{ id: string; data: string }>('SELECT id, data FROM songs');
  const albumRows = await db.getAllAsync<{ id: string; data: string }>(
    'SELECT id, data FROM albums',
  );

  const collisions = [
    ...planRemap(
      songRows.map((r) => r.id),
      f,
    ).collisions,
    ...planRemap(
      albumRows.map((r) => r.id),
      f,
    ).collisions,
  ];
  if (collisions.length > 0) throw new CatalogCollisionError(collisions);

  /** A row is rewritten if its id moves or anything inside its song did. */
  type Update = { from: string; to: string; owner: string | null; data: string };
  const songUpdates: Update[] = [];
  const albumUpdates: Update[] = [];

  await timed('catalog remap plan', async () => {
    for (let i = 0; i < songRows.length; i++) {
      if (i > 0 && i % REPAIR_BATCH === 0) await yieldToUi();
      const row = songRows[i];
      const song = remapSong(JSON.parse(row.data) as Song, f);
      const data = JSON.stringify(song);
      if (song.id !== row.id || data !== row.data) {
        songUpdates.push({ from: row.id, to: song.id, owner: song.albumId ?? null, data });
      }
    }
    for (let i = 0; i < albumRows.length; i++) {
      if (i > 0 && i % REPAIR_BATCH === 0) await yieldToUi();
      const row = albumRows[i];
      const album = remapAlbum(JSON.parse(row.data) as DlAlbum, f);
      const data = JSON.stringify(album);
      if (album.id !== row.id || data !== row.data) {
        albumUpdates.push({ from: row.id, to: album.id, owner: album.artistId ?? null, data });
      }
    }
  });

  if (songUpdates.length === 0 && albumUpdates.length === 0) return { songs: 0, albums: 0 };

  await serialized(() =>
    timed('catalog remap write', () =>
      db.withTransactionAsync(async () => {
        // `legacy_id` is only written the first time a row moves. A second
        // repair (a later migration, or this one resumed) must not overwrite
        // where the row originally came from with where it was last.
        for (const u of songUpdates) {
          await db.runAsync(
            `UPDATE songs SET id = ?, album_id = ?, data = ?,
                    legacy_id = COALESCE(legacy_id, ?)
               WHERE id = ?`,
            [u.to, u.owner, u.data, u.from, u.from],
          );
        }
        for (const u of albumUpdates) {
          await db.runAsync(
            `UPDATE albums SET id = ?, artist_id = ?, data = ?,
                    legacy_id = COALESCE(legacy_id, ?)
               WHERE id = ?`,
            [u.to, u.owner, u.data, u.from, u.from],
          );
        }
      }),
    ),
  );

  return { songs: songUpdates.length, albums: albumUpdates.length };
}
