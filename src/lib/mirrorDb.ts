/**
 * The offline copy of the library, in SQLite.
 *
 * It was one JSON file per profile with everything in it: favourites, the
 * playlist list, every playlist's tracklist, every album and every artist that
 * had been looked at. Saving any one of those rewrote all of it. On a real
 * install that was 34 MB, thirty seven seconds to write and freezes of fifteen
 * (#50), and the answer so far has been to keep less in it: playlists over five
 * hundred songs dropped, albums already downloaded dropped. Those limits exist
 * because of the format, not because anyone wanted them.
 *
 * The shape here is deliberately not a table per kind of thing. What the app
 * asks for is always "this playlist", "this album", "the favourites", so the
 * store is keyed by exactly that, and the entry travels as JSON. Saving an
 * album writes an album. The one place that needs to look inside is resolving
 * a song by id, and that gets its own table, filled as each tracklist arrives.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

import type { Album, Artist, Playlist, Song, Starred } from '@/api/subsonic';
import type { Remap } from './navidromeRemap';
import { planRemap, remapSong } from './navidromeRemap';
import { timed } from './perfLog';

export type PlaylistDetail = { playlist: Playlist; songs: Song[] };
export type AlbumDetail = { album: Album; songs: Song[] };
export type ArtistDetail = { artist: Artist; albums: Album[] };

/** Kinds of entry. The singletons use an empty id. */
type Kind = 'starred' | 'playlists' | 'playlist' | 'album' | 'artist';

const SCHEMA = `
PRAGMA journal_mode = WAL;
-- See downloadsDb: without a size limit the log keeps whatever it grew to,
-- and this one grew larger than the database it belongs to.
PRAGMA journal_size_limit = 524288;
CREATE TABLE IF NOT EXISTS entries (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  -- Three things asked of every entry at once, kept out of the JSON so that
  -- asking does not mean reading the tracklists: the playlist version the
  -- prefetch compares, and what deciding whether to keep an album or an
  -- artist needs, which is whether it is a favourite and which songs it holds.
  changed TEXT,
  starred INTEGER,
  song_ids TEXT,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL
);
-- The covers kept for browsing offline. The files sit next to this database;
-- what is here is which id each one belongs to, what it takes, and the other
-- ids that find the same file (an album's cover answers to the album's own id
-- and to the one the server gave it). It was a JSON index rewritten whole
-- every few seconds as it grew.
CREATE TABLE IF NOT EXISTS covers (
  id TEXT PRIMARY KEY NOT NULL,
  -- NULL for the one the file is named after; the target for the others.
  alias_of TEXT,
  bytes INTEGER
);
`;

/**
 * One database per profile, named after it.
 *
 * The JSON was one file per profile and this has to be too: they all live in
 * the same folder, so a single `mirror.db` would have been every account's
 * library in one place, and whichever migrated first would have been the one
 * everybody saw.
 */
function dbName(profile: string): string {
  return `mirror-${profile}.db`;
}

/** The JSON this profile is coming from, if it hasn't been migrated yet. */
function jsonFile(dir: string, profile: string): string {
  return `${dir}${profile}.json`;
}

/**
 * One handle per profile, kept open.
 *
 * A single handle that closed on switching profiles looked tidier and was a
 * race: reads are in flight while the switch happens, so the close could land
 * on the database that had just been opened, and every read after it failed
 * quietly and left the app looking like it had no offline library at all.
 * Handles are cheap; keeping them costs nothing and there is nothing to time.
 */
const open = new Map<string, Promise<SQLite.SQLiteDatabase>>();

/**
 * Opens a profile's mirror, migrating its JSON the first time.
 *
 * `dir` is the folder they all share and `profile` the name that tells them
 * apart, which is what the caller knows.
 */
export function mirrorDb(dir: string, profile: string): Promise<SQLite.SQLiteDatabase> {
  const existing = open.get(profile);
  if (existing) return existing;
  // See downloadsDb: a rejected promise left in here would be handed to every
  // later caller, and the offline library would stay unreadable until the app
  // was restarted. Forgetting a failed open lets the next caller retry.
  const handle: Promise<SQLite.SQLiteDatabase> = (async () => {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    // SQLite joins directory and name as plain text: the `file://` that the
    // file system module speaks means nothing to it.
    const db = await SQLite.openDatabaseAsync(
      dbName(profile),
      {},
      dir.replace(/^file:\/\//, ''),
    );
    await db.execAsync(SCHEMA);
    await addSummaryColumns(db);
    await migrateFromJson(db, jsonFile(dir, profile));
    return db;
  })().catch((e) => {
    if (open.get(profile) === handle) open.delete(profile);
    throw e;
  });
  open.set(profile, handle);
  return handle;
}

/** Closes and forgets one profile's mirror, for when its files are about to
 *  go. Not for switching profiles: that was the bug this comment warns about. */
export async function closeMirrorFor(profile: string): Promise<void> {
  // Whatever was held parsed for it goes with the handle: the files are about
  // to, and answering out of memory afterwards would be answering for a
  // library that is no longer there.
  for (const key of [...parsed.keys()]) if (key.startsWith(`${profile}|`)) parsed.delete(key);
  if (idsCache?.profile === profile) idsCache = null;
  const handle = open.get(profile);
  if (!handle) return;
  open.delete(profile);
  await handle.then((db) => db.closeAsync()).catch(() => {});
}

/** Songs written per statement. Two placeholders each, under the limit. */
const SONGS_PER_INSERT = 200;

/** What an entry answers without being read: the three summary columns. */
interface Summary {
  changed: string | null;
  starred: number | null;
  songIds: string | null;
}

const NO_SUMMARY: Summary = { changed: null, starred: null, songIds: null };

/**
 * Pulls out of an entry the few things that get asked of all of them at once.
 *
 * An album keeps the ids of its songs and nothing else about them: deciding
 * whether to keep it asks whether any of them is downloaded, and a list of ids
 * is a fraction of a tracklist.
 */
function summarize(kind: Kind, value: unknown, songs?: Song[]): Summary {
  if (kind === 'playlist') {
    return { ...NO_SUMMARY, changed: (value as PlaylistDetail).playlist?.changed ?? null };
  }
  if (kind === 'album') {
    const d = value as AlbumDetail;
    const ids = (d.songs ?? songs ?? []).map((s) => s.id);
    return { changed: null, starred: d.album?.starred ? 1 : 0, songIds: JSON.stringify(ids) };
  }
  if (kind === 'artist') {
    return { ...NO_SUMMARY, starred: (value as ArtistDetail).artist?.starred ? 1 : 0 };
  }
  return NO_SUMMARY;
}

/**
 * Adds the summary columns to a database made before they existed.
 *
 * The backfill parses each entry once, here, so that nothing else ever has to.
 * Leaving them empty would have worked for the playlists, at the price of every
 * one of them looking out of date and being fetched again, and would have been
 * wrong for the albums, which would all have looked disposable.
 */
async function addSummaryColumns(db: SQLite.SQLiteDatabase): Promise<void> {
  const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(entries)');
  const have = new Set(cols.map((c) => c.name));
  const missing = ([
    ['changed', 'TEXT'],
    ['starred', 'INTEGER'],
    ['song_ids', 'TEXT'],
  ] as const).filter(([name]) => !have.has(name));
  if (missing.length === 0) return;
  for (const [name, type] of missing) {
    await db.execAsync(`ALTER TABLE entries ADD COLUMN ${name} ${type}`);
  }
  const rows = await db.getAllAsync<{ kind: Kind; id: string; data: string }>(
    "SELECT kind, id, data FROM entries WHERE kind IN ('playlist', 'album', 'artist')",
  );
  await serialized(() =>
    db.withTransactionAsync(async () => {
      for (const r of rows) {
        let s: Summary;
        try {
          s = summarize(r.kind, JSON.parse(r.data));
        } catch {
          continue; // unreadable row: treated like a missing one from here on
        }
        await db.runAsync(
          'UPDATE entries SET changed = ?, starred = ?, song_ids = ? WHERE kind = ? AND id = ?',
          [s.changed, s.starred, s.songIds, r.kind, r.id],
        );
      }
    }),
  );
}

// ── Coming from the JSON ────────────────────────────────────────────────────

interface OldMirror {
  starred?: Starred;
  playlists?: Playlist[];
  playlistTracks?: Record<string, PlaylistDetail>;
  albums?: Record<string, AlbumDetail>;
  artists?: Record<string, ArtistDetail>;
}

/**
 * Moves the old file in, once, and renames it rather than deleting it.
 *
 * Everything it held goes in, including what the size limits had been keeping
 * out: there is no longer a reason to leave a long playlist behind.
 */
async function migrateFromJson(db: SQLite.SQLiteDatabase, file: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(file).catch(() => null);
  if (!info?.exists) return;
  const already = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM entries');
  if ((already?.n ?? 0) > 0) return;

  let old: OldMirror;
  try {
    const raw = await timed('mirror migrate read', () => FileSystem.readAsStringAsync(file));
    old = JSON.parse(raw) as OldMirror;
  } catch {
    return; // unreadable: leave it alone and start empty
  }

  await timed('mirror migrate write', async () => {
    await serialized(() =>
      db.withTransactionAsync(async () => {
        if (old.starred) await putEntry(db, 'starred', '', old.starred, old.starred.songs);
        if (old.playlists) await putEntry(db, 'playlists', '', old.playlists);
        for (const [id, d] of Object.entries(old.playlistTracks ?? {})) {
          await putEntry(db, 'playlist', id, d, d.songs);
        }
        for (const [id, d] of Object.entries(old.albums ?? {})) {
          await putEntry(db, 'album', id, d, d.songs);
        }
        for (const [id, d] of Object.entries(old.artists ?? {})) {
          await putEntry(db, 'artist', id, d);
        }
      }),
    );
  });

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


async function putEntry(
  db: SQLite.SQLiteDatabase,
  kind: Kind,
  id: string,
  value: unknown,
  songs?: Song[],
): Promise<void> {
  const s = summarize(kind, value, songs);
  await db.runAsync(
    `INSERT OR REPLACE INTO entries (kind, id, data, changed, starred, song_ids)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [kind, id, JSON.stringify(value), s.changed, s.starred, s.songIds],
  );
  // Every song that goes past leaves its metadata behind, which is what makes
  // resolving one by id a lookup instead of a walk through every tracklist.
  //
  // In batches: one statement per song meant a thousand and forty crossings
  // into native code to store one playlist, and the prefetch stores five of
  // them a run. Two placeholders each, so a chunk of the parameter limit
  // carries two hundred songs.
  const all = songs ?? [];
  for (let i = 0; i < all.length; i += SONGS_PER_INSERT) {
    const part = all.slice(i, i + SONGS_PER_INSERT);
    const rows = part.map(() => '(?, ?)').join(',');
    const params: string[] = [];
    for (const s of part) {
      params.push(s.id, JSON.stringify(s));
    }
    await db.runAsync(`INSERT OR REPLACE INTO songs (id, data) VALUES ${rows}`, params);
  }
}

export async function saveEntry(
  dir: string,
  profile: string,
  kind: Kind,
  id: string,
  value: unknown,
  songs?: Song[],
): Promise<void> {
  const db = await mirrorDb(dir, profile);
  // Timed per kind, and INSIDE the queue on purpose. Writes are serialised, so
  // timing the wait as well turned five albums arriving together into one that
  // took seven hundred milliseconds, which was the queue and not the work. What
  // this measures is the transaction.
  forgetEntry(profile, kind, id);
  await serialized(() =>
    timed(`mirror ${kind}`, () =>
      db.withTransactionAsync(() => putEntry(db, kind, id, value, songs)),
    ),
  );
}

export async function dropEntry(
  dir: string,
  profile: string,
  kind: Kind,
  id: string,
): Promise<void> {
  const db = await mirrorDb(dir, profile);
  forgetEntry(profile, kind, id);
  await serialized(() =>
    db.runAsync('DELETE FROM entries WHERE kind = ? AND id = ?', [kind, id]),
  );
}

/**
 * One cover per album, over every song the mirror holds.
 *
 * A playlist stored months ago is never written again while the server says it
 * has not changed, so the covers of its songs' albums were never asked for
 * either. This is how they are caught up with: the ids come out of the songs
 * table itself, an album at a time, without a single tracklist being parsed.
 */
export async function songCoverIds(
  dir: string,
  profile: string,
): Promise<{ album: string; cover: string | null }[]> {
  const db = await mirrorDb(dir, profile);
  return db.getAllAsync<{ album: string; cover: string | null }>(
    `SELECT json_extract(data, '$.albumId') AS album,
            MIN(json_extract(data, '$.coverArt')) AS cover
       FROM songs
      WHERE album IS NOT NULL
      GROUP BY album`,
  );
}

/**
 * Of these songs, the ones whose cover is not their album's, and what they name
 * instead: a track with a picture of its own, or a disc of its own (#214). The
 * album's cover id is only on the album's entry, so a song whose album was never
 * stored is left out.
 */
export async function ownCoverSongs(
  dir: string,
  profile: string,
  ids: string[],
): Promise<{ id: string; album: string; cover: string }[]> {
  const db = await mirrorDb(dir, profile);
  const albumCover = new Map<string, string>();
  const albums = await db.getAllAsync<{ id: string; cover: string }>(
    `SELECT id, COALESCE(json_extract(data, '$.album.coverArt'), id) AS cover
       FROM entries WHERE kind = 'album'`,
  );
  for (const a of albums) albumCover.set(a.id, a.cover);
  const out: { id: string; album: string; cover: string }[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = await db.getAllAsync<{ id: string; album: string | null; cover: string | null }>(
      `SELECT id, json_extract(data, '$.albumId') AS album, json_extract(data, '$.coverArt') AS cover
         FROM songs WHERE id IN (${part.map(() => '?').join(',')})`,
      part,
    );
    for (const r of rows) {
      const own = r.album ? albumCover.get(r.album) : undefined;
      if (r.album && r.cover && own && r.cover !== own) {
        out.push({ id: r.id, album: r.album, cover: r.cover });
      }
    }
  }
  return out;
}

// ── The covers kept alongside ───────────────────────────────────────────────

export interface CoverRow {
  id: string;
  aliasOf: string | null;
  bytes: number;
}

/** Everything known about this profile's covers, in one query. */
export async function allCovers(dir: string, profile: string): Promise<CoverRow[]> {
  const db = await mirrorDb(dir, profile);
  const rows = await timed('mirror covers read', () =>
    db.getAllAsync<{ id: string; alias_of: string | null; bytes: number | null }>(
      'SELECT id, alias_of, bytes FROM covers',
    ),
  );
  return rows.map((r) => ({ id: r.id, aliasOf: r.alias_of, bytes: r.bytes ?? 0 }));
}

/**
 * Writes down covers that have just been saved, and the other names for them.
 *
 * One statement for the lot: catching a library up is hundreds of these, and
 * the index they replace was rewritten in full for each.
 */
export async function putCovers(dir: string, profile: string, rows: CoverRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await mirrorDb(dir, profile);
  await serialized(async () => {
    for (let i = 0; i < rows.length; i += 200) {
      const part = rows.slice(i, i + 200);
      const marks = part.map(() => '(?, ?, ?)').join(',');
      const params: (string | number | null)[] = [];
      for (const r of part) params.push(r.id, r.aliasOf, r.bytes);
      await db.runAsync(
        `INSERT OR REPLACE INTO covers (id, alias_of, bytes) VALUES ${marks}`,
        params,
      );
    }
  });
}

/** Forgets one cover and every other name that pointed at it. */
export async function dropCover(dir: string, profile: string, id: string): Promise<void> {
  const db = await mirrorDb(dir, profile);
  await serialized(() =>
    db.runAsync('DELETE FROM covers WHERE id = ? OR alias_of = ?', [id, id]),
  );
}

/** Forgets all of them, for when the files are going too. */
export async function dropCovers(dir: string, profile: string): Promise<void> {
  const db = await mirrorDb(dir, profile);
  await serialized(() => db.runAsync('DELETE FROM covers'));
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * The song ids of every stored playlist, without their tracklists.
 *
 * The Library and Home only need the ids: how many there are, and which is the
 * first downloaded one, whose album gives the playlist its picture. Reading the
 * entries themselves meant one query per playlist and every tracklist parsed
 * into JS, fifty of them each time either screen drew, which offline is where
 * the time was going. SQLite pulls the ids out of the JSON itself and hands
 * back a short array per playlist.
 */
let idsCache: { profile: string; map: Map<string, string[]> } | null = null;

export async function playlistSongIds(
  dir: string,
  profile: string,
): Promise<Map<string, string[]>> {
  // Kept until a playlist is written. Pulling the ids out of every stored
  // tracklist is the database's work rather than ours, but on a library with
  // fifty playlists and thousands of songs in them it was measured at nearly
  // three seconds, and Home and the Library ask for it on every refresh.
  if (idsCache?.profile === profile) return idsCache.map;
  const db = await mirrorDb(dir, profile);
  const rows = await timed('mirror read ids', () =>
    db.getAllAsync<{ id: string; ids: string | null }>(
      `SELECT id,
              (SELECT json_group_array(json_extract(value, '$.id'))
                 FROM json_each(json_extract(data, '$.songs'))) AS ids
         FROM entries WHERE kind = 'playlist'`,
    ),
  );
  const out = new Map<string, string[]>();
  for (const r of rows) {
    try {
      out.set(r.id, r.ids ? (JSON.parse(r.ids) as string[]) : []);
    } catch {
      out.set(r.id, []);
    }
  }
  idsCache = { profile, map: out };
  return out;
}

/**
 * The two entries that are read whole, over and over, kept parsed in memory.
 *
 * "The playlists" and "the favourites" are one row each and the whole list is
 * in it, so reading one is a `JSON.parse` of the lot: measured at a third of a
 * second, seven times in three minutes, because Home and the Library both ask
 * and anything that changes offline asks again. The details of an album or a
 * playlist are not here on purpose: there is one per album in the library and
 * holding them all would be the mirror in memory again, which is the thing it
 * was moved into a database to stop being.
 */
const LISTS: Kind[] = ['playlists', 'starred'];
const parsed = new Map<string, unknown>();

function entryKey(profile: string, kind: Kind, id: string): string {
  return `${profile}|${kind}|${id}`;
}

/** Drops what a write has just made wrong. */
function forgetEntry(profile: string, kind: Kind, id: string): void {
  parsed.delete(entryKey(profile, kind, id));
  // A tracklist that changed changes the ids drawn from all of them.
  if (kind === 'playlist' || kind === 'playlists') idsCache = null;
}

async function getEntry<T>(
  dir: string,
  profile: string,
  kind: Kind,
  id: string,
): Promise<T | undefined> {
  const key = entryKey(profile, kind, id);
  if (LISTS.includes(kind) && parsed.has(key)) return parsed.get(key) as T;
  const db = await mirrorDb(dir, profile);
  // Timed like the writes: reading one is a row and a `JSON.parse` of whatever
  // is in it, and a playlist of a thousand songs is not a small one.
  const row = await timed(`mirror read ${kind}`, () =>
    db.getFirstAsync<{ data: string }>('SELECT data FROM entries WHERE kind = ? AND id = ?', [
      kind,
      id,
    ]),
  );
  const value = row ? (JSON.parse(row.data) as T) : undefined;
  if (LISTS.includes(kind) && value !== undefined) parsed.set(key, value);
  return value;
}

/**
 * What is known about an artist who has no entry of their own.
 *
 * Offline you can reach an artist the mirror never stored: from a favourited
 * album, say, whose artist screen was never opened online. Their id is the
 * server's, so the local catalog cannot answer for them either, and what the
 * screen showed was the id itself where the name goes. Their name is in every
 * song of theirs the mirror holds, and their albums are stored under their own
 * entries, so both come out of what is already here.
 */
export async function artistFallback(
  dir: string,
  profile: string,
  artistId: string,
): Promise<{ name?: string; albums: Album[] }> {
  const db = await mirrorDb(dir, profile);
  return timed('mirror artist fallback', async () => {
    const named = await db.getFirstAsync<{ name: string | null }>(
      `SELECT json_extract(data, '$.artist') AS name FROM songs
        WHERE json_extract(data, '$.artistId') = ? AND name IS NOT NULL LIMIT 1`,
      [artistId],
    );
    const rows = await db.getAllAsync<{ data: string }>(
      `SELECT data FROM entries
        WHERE kind = 'album' AND json_extract(data, '$.album.artistId') = ?`,
      [artistId],
    );
    const albums = rows.map((r) => (JSON.parse(r.data) as AlbumDetail).album).filter(Boolean);
    return { name: named?.name ?? undefined, albums };
  });
}

export function getStarred(dir: string, profile: string): Promise<Starred | undefined> {
  return getEntry<Starred>(dir, profile, 'starred', '');
}

export function getPlaylists(dir: string, profile: string): Promise<Playlist[] | undefined> {
  return getEntry<Playlist[]>(dir, profile, 'playlists', '');
}

export function getPlaylistDetail(
  dir: string,
  profile: string,
  id: string,
): Promise<PlaylistDetail | undefined> {
  return getEntry<PlaylistDetail>(dir, profile, 'playlist', id);
}

export function getAlbumDetail(
  dir: string,
  profile: string,
  id: string,
): Promise<AlbumDetail | undefined> {
  return getEntry<AlbumDetail>(dir, profile, 'album', id);
}

export function getArtistDetail(
  dir: string,
  profile: string,
  id: string,
): Promise<ArtistDetail | undefined> {
  return getEntry<ArtistDetail>(dir, profile, 'artist', id);
}

/** Songs by id, from whatever tracklist they arrived in. In chunks, because
 *  SQLite counts placeholders and a playlist can carry thousands of ids. */
export async function getSongs(
  dir: string,
  profile: string,
  ids: string[],
): Promise<Map<string, Song>> {
  const out = new Map<string, Song>();
  if (ids.length === 0) return out;
  const db = await mirrorDb(dir, profile);
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

/** A song by id, from whatever tracklist it arrived in. */
export async function getSong(dir: string, profile: string, id: string): Promise<Song | undefined> {
  const db = await mirrorDb(dir, profile);
  const row = await db.getFirstAsync<{ data: string }>('SELECT data FROM songs WHERE id = ?', [id]);
  return row ? (JSON.parse(row.data) as Song) : undefined;
}

/** An album as pruning sees it: whether it is a favourite and what it holds. */
export interface AlbumSummary {
  id: string;
  starred: boolean;
  songIds: string[];
}

/** Every stored album, without their tracklists. */
export async function albumSummaries(dir: string, profile: string): Promise<AlbumSummary[]> {
  const db = await mirrorDb(dir, profile);
  const rows = await db.getAllAsync<{ id: string; starred: number | null; song_ids: string | null }>(
    "SELECT id, starred, song_ids FROM entries WHERE kind = 'album'",
  );
  return rows.map((r) => {
    let songIds: string[] = [];
    try {
      songIds = r.song_ids ? (JSON.parse(r.song_ids) as string[]) : [];
    } catch {
      // no ids: kept only if it is a favourite
    }
    return { id: r.id, starred: !!r.starred, songIds };
  });
}

/** Drops the artists that aren't favourites. Nothing to read: they are kept
 *  for that reason alone, and downloads rebuild the rest from the catalog. */
export async function dropUnstarredArtists(dir: string, profile: string): Promise<void> {
  const db = await mirrorDb(dir, profile);
  await serialized(() =>
    db.runAsync("DELETE FROM entries WHERE kind = 'artist' AND (starred IS NULL OR starred = 0)"),
  );
}

/** Drops these entries, in chunks: SQLite counts placeholders. */
export async function dropEntries(
  dir: string,
  profile: string,
  kind: Kind,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = await mirrorDb(dir, profile);
  for (const id of ids) forgetEntry(profile, kind, id);
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const marks = part.map(() => '?').join(',');
    await serialized(() =>
      db.runAsync(`DELETE FROM entries WHERE kind = ? AND id IN (${marks})`, [kind, ...part]),
    );
  }
}

/** Which albums are already stored, to know which ones are missing. */
export async function albumIds(dir: string, profile: string): Promise<Set<string>> {
  const db = await mirrorDb(dir, profile);
  const rows = await db.getAllAsync<{ id: string }>(
    "SELECT id FROM entries WHERE kind = 'album'",
  );
  return new Set(rows.map((r) => r.id));
}

/** Which of these playlists are already stored, and with which `changed`, so
 *  the prefetch can ask only for what moved. */
/**
 * What is already stored for this entry, as the two things worth comparing
 * before writing it again: the version the server gave it, and the ids of the
 * songs in it.
 *
 * Writing a playlist means inserting every one of its songs, and a playlist of
 * a thousand songs was measured at a second and a half of that. Opening one
 * did it every time, whether or not anything about it had changed.
 */
export async function entrySummary(
  dir: string,
  profile: string,
  kind: Kind,
  id: string,
): Promise<{ changed: string | null; songIds: string | null } | undefined> {
  const db = await mirrorDb(dir, profile);
  const row = await db.getFirstAsync<{ changed: string | null; song_ids: string | null }>(
    'SELECT changed, song_ids FROM entries WHERE kind = ? AND id = ?',
    [kind, id],
  );
  return row ? { changed: row.changed, songIds: row.song_ids } : undefined;
}

export async function playlistVersions(
  dir: string,
  profile: string,
): Promise<Record<string, string | undefined>> {
  const db = await mirrorDb(dir, profile);
  // The version column, not the entries: reading `data` here meant hauling
  // every stored tracklist across to the JS thread and parsing it to get one
  // date each. Measured at 1.7 MB for twenty two playlists, every prefetch run.
  const rows = await db.getAllAsync<{ id: string; changed: string | null }>(
    "SELECT id, changed FROM entries WHERE kind = 'playlist'",
  );
  const out: Record<string, string | undefined> = {};
  for (const r of rows) out[r.id] = r.changed ?? undefined;
  return out;
}

export interface MirrorStats {
  bytes: number;
  albums: number;
  artists: number;
  playlists: number;
  starredSongs: number;
}

/** What it holds, for Settings › Downloads. */
export async function stats(dir: string, profile: string): Promise<MirrorStats> {
  const db = await mirrorDb(dir, profile);
  const counts = await db.getAllAsync<{ kind: string; n: number }>(
    'SELECT kind, COUNT(*) AS n FROM entries GROUP BY kind',
  );
  const by = (k: string) => counts.find((c) => c.kind === k)?.n ?? 0;
  const starred = await getStarred(dir, profile);
  let bytes = 0;
  // The database is three files on disk, and the log is not the small one: it
  // was measured larger than the database itself. Reporting only the database
  // told the user less than half of what the copy was taking.
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const info = await FileSystem.getInfoAsync(`${dir}${dbName(profile)}${suffix}`);
      if (info.exists) bytes += info.size ?? 0;
    } catch {
      // counted as zero
    }
  }
  return {
    bytes,
    albums: by('album'),
    artists: by('artist'),
    playlists: by('playlist'),
    starredSongs: starred?.songs?.length ?? 0,
  };
}

/* ── Repairing the ids after a server migration ───────────────────────────── */

/**
 * Rewrites what can be rewritten in the offline mirror, and throws away what
 * is cheaper to ask for again.
 *
 * Unlike the download catalog, the mirror is a cache: everything in it came
 * from the server and the server can be asked for it again. That is what makes
 * the split here the right one rather than a shortcut.
 *
 * - **Covers are remapped and not one file is re-fetched.** A cover file is
 *   named after the id it belongs to, so moving the id would normally orphan
 *   megabytes of artwork. It does not, because this table already has
 *   `alias_of` for the case of several ids sharing one file: the new id keeps
 *   the old one as its alias, and the file is still found under the name it
 *   has always had.
 * - **Songs are remapped**, because they are plain rows of the same shape the
 *   catalog holds, and re-fetching them means a request per album.
 * - **Entries are dropped.** Each holds a different structure by kind (an
 *   album's detail, an artist's, a playlist's), and rewriting ids inside each
 *   of those is a lot of code that would silently rot as the shapes change.
 *   They are also the cheapest thing here to fetch again, and a repair only
 *   ever happens at a moment when the server has just answered. What it costs
 *   is a browse or two feeling cold straight afterwards.
 */
export async function remapMirrorIds(
  dir: string,
  profile: string,
  f: Remap,
): Promise<{ songs: number; covers: number; entriesDropped: number }> {
  const db = await mirrorDb(dir, profile);

  const songRows = await db.getAllAsync<{ id: string; data: string }>('SELECT id, data FROM songs');
  const coverRows = await db.getAllAsync<{ id: string; alias_of: string | null }>(
    'SELECT id, alias_of FROM covers',
  );

  // Same refusal as the catalog: two rows becoming one loses a row, and here
  // it would take an album's artwork with it.
  const songPlan = planRemap(
    songRows.map((r) => r.id),
    f,
  );
  const coverPlan = planRemap(
    coverRows.map((r) => r.id),
    f,
  );
  if (songPlan.collisions.length > 0 || coverPlan.collisions.length > 0) {
    throw new Error(
      `mirror remap would collide (${songPlan.collisions.length} songs, ${coverPlan.collisions.length} covers)`,
    );
  }

  const songUpdates: { from: string; to: string; data: string }[] = [];
  for (const row of songRows) {
    const song = remapSong(JSON.parse(row.data) as Song, f);
    const data = JSON.stringify(song);
    if (song.id !== row.id || data !== row.data) {
      songUpdates.push({ from: row.id, to: song.id, data });
    }
  }

  // Looked up through a map: a `find` per pair reads the whole cover table
  // again each time, and a large library has thousands of them.
  const aliasOf = new Map(coverRows.map((r) => [r.id, r.alias_of]));
  const coverUpdates = coverPlan.pairs.map(({ from, to }) => ({
    from,
    to,
    // The file is named after whichever id owned it. Keeping that as the alias
    // is what leaves the artwork on disk exactly where it is.
    alias: aliasOf.get(from) ?? from,
  }));

  const entries = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM entries');

  await serialized(() =>
    db.withTransactionAsync(async () => {
      for (const u of songUpdates) {
        await db.runAsync('UPDATE songs SET id = ?, data = ? WHERE id = ?', [u.to, u.data, u.from]);
      }
      for (const u of coverUpdates) {
        await db.runAsync('UPDATE covers SET id = ?, alias_of = ? WHERE id = ?', [
          u.to,
          u.alias,
          u.from,
        ]);
      }
      await db.runAsync('DELETE FROM entries');
    }),
  );

  return {
    songs: songUpdates.length,
    covers: coverUpdates.length,
    entriesDropped: entries?.n ?? 0,
  };
}
