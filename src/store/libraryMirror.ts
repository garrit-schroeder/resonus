/**
 * Server library mirror for offline mode.
 *
 * While online, viewing favorites, playlists, an album or an artist saves a
 * copy (per profile, like the download catalog). Offline with a server
 * account, the Library screen reads from here and marks each song as available
 * (downloaded) or not.
 *
 * It is NOT a mirror of the ENTIRE library: only favorited items, playlists and
 * whatever has downloads, which is what the Library screen shows. What was
 * never seen online won't be there.
 *
 * It lives in SQLite now (see `lib/mirrorDb`). It used to be one JSON file
 * rewritten in full for any change, and that is where its size limits came
 * from: playlists over five hundred songs left out, albums already downloaded
 * left out, purely to keep the file writable (#50). Those are gone. What
 * remains is a rule about what belongs here, which is a different thing.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { create } from 'zustand';

import type { Album, Artist, Playlist, Song, Starred, SubsonicAuth } from '@/api/subsonic';
import { hashKey } from '@/lib/localLibrary';
import { whenIdle } from '@/lib/idle';
import * as Db from '@/lib/mirrorDb';
import {
  keepMirrorCovers,
  loadMirrorCovers,
  mirrorCoversInfo,
  type CoverWant,
} from '@/lib/mirrorCovers';
import { primaryUrl } from '@/lib/serverUrls';
import { useAuthStore } from './auth';

export type { AlbumDetail, ArtistDetail, PlaylistDetail } from '@/lib/mirrorDb';

/**
 * What the mirror needs to know about the downloads to decide what to keep.
 *
 * Handed in by the caller rather than imported: `downloads` already imports
 * this module to mirror the tracklists of what it downloads, and reaching back
 * for it would be a require cycle. `hydrated` is not optional: before the
 * files are read from disk they all look absent, and something downloaded
 * would look disposable.
 */
export interface DownloadsView {
  files: Record<string, string>;
  hydrated: boolean;
}

/**
 * What the offline copy holds. The covers are counted apart from the database
 * because they are most of it: one line saying "the copy takes 90 MB" tells
 * nobody which part to delete or why it grew.
 */
export type MirrorStats = Db.MirrorStats & { coverBytes: number; covers: number };

const DIR = FileSystem.documentDirectory + 'library-mirror/';

/**
 * Keeps the covers of what is being written (see `lib/mirrorCovers`). The
 * session is read here rather than there: that module is under the stores and
 * reaching back up for it was a require cycle.
 */
function keepCovers(profile: string, ids: (string | CoverWant | undefined)[]): void {
  keepMirrorCovers(profile, useAuthStore.getState().auth, ids);
}

/** The folder they share and the name that tells this profile apart, or null
 *  without a session. */
export function pathsFor(auth: SubsonicAuth): { dir: string; profile: string } {
  // PRIMARY URL (not the active one): identifies the profile even when
  // switching networks, same as the download directory.
  return { dir: DIR, profile: hashKey(`${primaryUrl(auth)}|${auth.username}`) };
}

export function active(): { dir: string; profile: string } | null {
  const auth: SubsonicAuth | null = useAuthStore.getState().auth;
  if (!auth) return null;
  // PRIMARY URL (not the active one): identifies the profile even when
  // switching networks, same as the download directory.
  return { dir: DIR, profile: hashKey(`${primaryUrl(auth)}|${auth.username}`) };
}

/**
 * Is this album worth keeping offline?
 *
 * The mirror used to keep every album ever opened online, so it grew without
 * end (#50). What it is for is what the Library offers offline: favourites,
 * playlists, and whatever has downloads. That last one earns its place on a
 * half-downloaded album, where this is the only place the full tracklist
 * lives: without it the missing songs don't appear greyed out, the album just
 * looks shorter than it is.
 */
function worthKeepingAlbum(album: Db.AlbumSummary, files: Record<string, string>): boolean {
  return album.starred || album.songIds.some((id) => !!files[id]);
}

/** The same question where the album itself is at hand, on the way in. */
function worthKeepingAlbumOf(album: Album, songs: Song[], files: Record<string, string>): boolean {
  return worthKeepingAlbum(
    { id: album.id, starred: !!album.starred, songIds: songs.map((s) => s.id) },
    files,
  );
}

/** Artists with downloads are rebuilt offline from the download catalog, so
 *  only the favourited ones need to be here. */
function worthKeepingArtist(artist: Artist): boolean {
  return !!artist.starred;
}

/** Same list, as far as anything here cares: same length and same ends. Cheap
 *  on purpose, since the alternative is comparing thousands of songs. */
function sameEnds<T extends { id: string }>(a: T[] | undefined, b: T[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  if (a.length === 0) return true;
  return a[0].id === b[0].id && a[a.length - 1].id === b[b.length - 1].id;
}

function sameLists(a: Starred | undefined, b: Starred): boolean {
  return (
    !!a && sameEnds(a.songs, b.songs) && sameEnds(a.albums, b.albums) && sameEnds(a.artists, b.artists)
  );
}

function samePlaylists(a: Playlist[] | undefined, b: Playlist[]): boolean {
  if (!sameEnds(a, b)) return false;
  // A playlist can change without the list changing, and `changed` says so.
  return (a ?? []).every((p, i) => p.changed === b[i].changed);
}

/** Runs against the active profile's mirror, or gives up quietly. */
async function withMirror<T>(
  fn: (dir: string, profile: string) => Promise<T>,
  fallback: T,
): Promise<T> {
  const target = active();
  if (!target) return fallback;
  try {
    return await fn(target.dir, target.profile);
  } catch (e) {
    // A mirror that can't be read or written is a degraded offline mode, not
    // a reason to take the screen down with it. It is not something to hide
    // either: swallowing it is what made a broken read look like an empty
    // library, with the app quietly falling back to local files.
    if (__DEV__) console.log('[mirror] failed:', e);
    return fallback;
  }
}

/**
 * The cover a song's row draws, and how to get it.
 *
 * Asked of the server by the song's own cover id, which is one it certainly
 * answers, and looked up by the album's, which is what the row asks for
 * offline (see `songCoverUrl`). One file per album, not one per track: twenty
 * songs off one record want the same picture and dedupe onto it.
 */
function coverOfSong(s: Song): { from: string; keys: string[] } | undefined {
  const key = s.albumId;
  const from = s.coverArt ?? s.albumId;
  return key && from ? { from, keys: [key] } : undefined;
}


/**
 * Is what we are about to write the same as what is there?
 *
 * By the version the server gives the thing, when it gives one, and otherwise
 * by the ids of the songs in it, which is what a rewrite would cost. Anything
 * unknown answers no, so an entry that has never been stored is written.
 */
async function unchanged(
  dir: string,
  profile: string,
  kind: 'playlist' | 'album',
  id: string,
  changed: string | undefined,
  songs: Song[],
): Promise<boolean> {
  const stored = await Db.entrySummary(dir, profile, kind, id);
  if (!stored) return false;
  if (changed != null && stored.changed != null) return stored.changed === changed;
  if (!stored.songIds) return false;
  return stored.songIds === JSON.stringify(songs.map((s) => s.id));
}

/**
 * A write, which is bookkeeping and not what anybody is waiting for.
 *
 * These run off the back of a fetch: opening an album stores it, and the songs
 * screen sorted by "recently added" fetches fifteen albums at once and stores
 * all fifteen. Each one is a transaction and a `JSON.stringify` per song, on
 * the same thread that is drawing the screen that asked. Waiting for the
 * interactions to finish costs nothing here and takes it off the way.
 */
function writeMirror(key: string, fn: (dir: string, profile: string) => Promise<unknown>): void {
  // The last word about a thing is the only one worth writing: a list refetched
  // five times while somebody browses is one row's worth of work, not five.
  queued.set(key, fn);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    whenIdle(() => void flushMirror());
  }, FLUSH_AFTER_MS);
}

/**
 * How long the queue waits before it is written, when nothing asks for it
 * sooner. Long enough to swallow the burst that a pull to refresh sets off,
 * short enough that little is lost if the app is killed.
 */
const FLUSH_AFTER_MS = 8000;
const queued = new Map<string, (dir: string, profile: string) => Promise<unknown>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> = Promise.resolve();

/**
 * Writes down everything waiting, and can be waited for.
 *
 * Going offline waits for it: that is the moment the mirror stops being a copy
 * of what you browsed and becomes the library itself, so nothing may still be
 * in a queue. Everything else lets it happen when it happens.
 */
export function flushMirror(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = [...queued.values()];
  queued.clear();
  if (batch.length === 0) return flushing;
  flushing = flushing.then(async () => {
    for (const fn of batch) {
      await withMirror(fn, undefined);
      // A breath between one and the next. Writing an entry is a transaction
      // and a `JSON.stringify` per song, and a queue of them back to back holds
      // the thread for as long as it takes them all: the screen that was being
      // drawn waits, and so does the tab bar, which is what somebody sees as a
      // navigation that lags behind itself.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  return flushing;
}

interface MirrorState {
  /** Profile whose mirror is open (empty = none). */
  profile: string;
  /** Opens the active profile's mirror, migrating its JSON the first time. */
  load: () => Promise<void>;
  saveStarred: (s: Starred) => void;
  savePlaylists: (list: Playlist[]) => void;
  savePlaylistDetail: (id: string, playlist: Playlist, songs: Song[]) => void;
  savePlaylistDetails: (entries: { id: string; playlist: Playlist; songs: Song[] }[]) => void;
  saveAlbum: (id: string, album: Album, songs: Song[], downloads: DownloadsView) => void;
  saveArtist: (id: string, artist: Artist, albums: Album[]) => void;
  /**
   * Makes sure every album the stored songs belong to has its cover on the
   * phone. Cheap once it has caught up, and the only thing that reaches
   * playlists stored before covers were kept at all.
   */
  keepStoredCovers: () => void;
  /** Writes down everything waiting, for whoever cannot carry on without it. */
  flush: () => Promise<void>;
  /** Applies the "worth keeping" rule to what is already stored. Needs the
   *  downloads hydrated, so it is called after them. */
  prune: (downloads: DownloadsView) => Promise<void>;
  /** Size and contents, for Settings › Downloads. */
  stats: () => Promise<MirrorStats>;

  // Reads. All of them go to the database: nothing is held in memory any more,
  // which is what a whole library sitting in a JS object used to cost.
  starred: () => Promise<Starred | undefined>;
  playlists: () => Promise<Playlist[] | undefined>;
  playlistDetail: (id: string) => Promise<Db.PlaylistDetail | undefined>;
  /** Song ids per stored playlist, without their tracklists. */
  playlistSongIds: () => Promise<Map<string, string[]>>;
  albumDetail: (id: string) => Promise<Db.AlbumDetail | undefined>;
  /** Of these songs, the ones whose cover is not their album's (#214). */
  ownCoverSongs: (ids: string[]) => Promise<{ id: string; album: string; cover: string }[]>;
  artistDetail: (id: string) => Promise<Db.ArtistDetail | undefined>;
  /** Name and albums for an artist with no entry of their own. */
  artistFallback: (id: string) => Promise<{ name?: string; albums: Album[] }>;
  song: (id: string) => Promise<Song | undefined>;
  songs: (ids: string[]) => Promise<Map<string, Song>>;
  playlistVersions: () => Promise<Record<string, string | undefined>>;
  albumIds: () => Promise<Set<string>>;
}

export const useLibraryMirror = create<MirrorState>((set, get) => ({
  profile: '',

  load: async () => {
    const target = active();
    if (!target) {
      set({ profile: '' });
      return;
    }
    if (get().profile === target.profile) return;
    // The previous profile's handle stays open on purpose: closing it here
    // raced with reads that were still in flight (see `mirrorDb`).
    await Db.mirrorDb(target.dir, target.profile).catch(() => {});
    // The covers this profile already has, so the shelves can draw them
    // offline (see `mirrorCovers`).
    await loadMirrorCovers(target.profile);
    set({ profile: target.profile });
  },

  saveStarred: (starred) => {
    // Favourites are fetched again and again and almost always come back
    // identical. Each of those used to dirty the file and cost a full rewrite,
    // measured at thirty seven seconds on a large mirror (#50).
    writeMirror('starred', async (dir, profile) => {
      keepCovers(profile, [
        // One file per album, found by both names: the header asks by the
        // cover id the server gave (`al-123` on Subsonic) and a song row asks
        // by the album's own (`123`).
        ...starred.albums.map((a) => ({
          from: a.coverArt ?? a.id,
          keys: [a.coverArt ?? a.id, a.id],
        })),
        // The photo beside an album is asked for by `artistId`, which is not
        // the artist's own cover id either.
        ...starred.albums.map((a) => a.artistId),
        ...starred.artists.map((a) => ({
          from: a.coverArt ?? a.id,
          keys: [a.coverArt ?? a.id, a.id],
        })),
        // And the album behind every favourite song, which is the picture its
        // row draws offline (see `songCoverUrl`). Fetched by the song's own
        // cover id, which is one the server certainly answers, and found by the
        // album's, which is what the row will ask.
        ...starred.songs.map((s) => coverOfSong(s)),
      ]);
      if (sameLists(await Db.getStarred(dir, profile), starred)) return;
      await Db.saveEntry(dir, profile, 'starred', '', starred, starred.songs);
    });
  },

  savePlaylists: (playlists) => {
    writeMirror('playlists', async (dir, profile) => {
      keepCovers(
        profile,
        playlists.map((p) => ({ from: p.coverArt ?? p.id, keys: [p.coverArt ?? p.id, p.id] })),
      );
      if (samePlaylists(await Db.getPlaylists(dir, profile), playlists)) return;
      await Db.saveEntry(dir, profile, 'playlists', '', playlists);
    });
  },

  savePlaylistDetail: (id, playlist, songs) => {
    writeMirror(`playlist:${id}`, async (dir, profile) => {
      // The playlist's own cover, and the album behind each of its songs: those
      // are the pictures the rows ask for offline. A playlist of five hundred
      // songs is a few hundred albums at most, deduplicated against what is
      // already saved and capped like everything else here.
      keepCovers(profile, [
        { from: playlist.coverArt ?? playlist.id, keys: [playlist.coverArt ?? playlist.id, playlist.id] },
        ...songs.map((s) => coverOfSong(s)),
      ]);
      // Nothing to write if it is the same playlist as the one stored: opening
      // one is a fetch, and a fetch used to be a full rewrite of its tracklist
      // however little had changed. Fifty two of those in half an hour, the
      // worst of them a second and a half.
      if (await unchanged(dir, profile, 'playlist', id, playlist.changed, songs)) return;
      return Db.saveEntry(dir, profile, 'playlist', id, { playlist, songs }, songs);
    });
  },

  savePlaylistDetails: (entries) => {
    if (entries.length === 0) return;
    writeMirror(`playlists:${entries.map((e) => e.id).join(',')}`, async (dir, profile) => {
      keepCovers(profile, [
        ...entries.map((e) => ({
          from: e.playlist.coverArt ?? e.playlist.id,
          keys: [e.playlist.coverArt ?? e.playlist.id, e.playlist.id],
        })),
        ...entries.flatMap((e) => e.songs.map((s) => coverOfSong(s))),
      ]);
      for (const e of entries) {
        if (await unchanged(dir, profile, 'playlist', e.id, e.playlist.changed, e.songs)) continue;
        await Db.saveEntry(
          dir,
          profile,
          'playlist',
          e.id,
          { playlist: e.playlist, songs: e.songs },
          e.songs,
        );
      }
    });
  },

  saveAlbum: (id, album, songs, dl) => {
    writeMirror(`album:${id}`, async (dir, profile) => {
      if (worthKeepingAlbumOf(album, songs, dl.files)) {
        keepCovers(profile, [
          { from: album.coverArt ?? album.id, keys: [album.coverArt ?? album.id, album.id] },
          album.artistId,
        ]);
        // Albums carry no version, so the tracklist is the comparison. A
        // hundred and seventy nine of these in three minutes on the library
        // this came from, nearly all of them writing what was already there.
        if (await unchanged(dir, profile, 'album', id, undefined, songs)) return;
        await Db.saveEntry(dir, profile, 'album', id, { album, songs }, songs);
        return;
      }
      // Before the downloads are read from disk there is no telling a
      // downloaded album from a disposable one, so nothing is thrown away.
      if (!dl.hydrated) return;
      // Dropped, not merely skipped, so unfavouriting takes it out on its own
      // the next time it is looked at.
      await Db.dropEntry(dir, profile, 'album', id);
    });
  },

  saveArtist: (id, artist, albums) => {
    writeMirror(`artist:${id}`, async (dir, profile) => {
      if (worthKeepingArtist(artist)) {
        keepCovers(profile, [
          { from: artist.coverArt ?? artist.id, keys: [artist.coverArt ?? artist.id, artist.id] },
          ...albums.map((a) => ({
            from: a.coverArt ?? a.id,
            keys: [a.coverArt ?? a.id, a.id],
          })),
        ]);
        await Db.saveEntry(dir, profile, 'artist', id, { artist, albums });
        return;
      }
      await Db.dropEntry(dir, profile, 'artist', id);
    });
  },

  keepStoredCovers: () => {
    writeMirror('covers', async (dir, profile) => {
      const rows = await Db.songCoverIds(dir, profile);
      keepCovers(
        profile,
        rows.map((r) => ({ from: r.cover ?? r.album, keys: [r.album] })),
      );
    });
  },

  flush: () => flushMirror(),

  prune: async (dl) => {
    if (!dl.hydrated) return; // everything downloaded would look disposable
    await withMirror(async (dir, profile) => {
      // Summaries, not entries. This runs on every cold start, which is the
      // worst moment to read anything: asking for the albums themselves meant
      // hauling every stored tracklist onto the JS thread and parsing it to
      // look at two fields. Measured at 783 KB on a small library.
      const albums = await Db.albumSummaries(dir, profile);
      const drop = albums.filter((a) => !worthKeepingAlbum(a, dl.files)).map((a) => a.id);
      await Db.dropEntries(dir, profile, 'album', drop);
      // Artists are kept only for being favourites, so the database decides
      // that one on its own.
      await Db.dropUnstarredArtists(dir, profile);
    }, undefined);
  },

  stats: () =>
    withMirror(async (dir, profile) => {
      const st = await Db.stats(dir, profile);
      // The covers are files of their own, next to the database rather than in
      // it, so `bytes` alone was leaving out most of what the copy takes.
      const covers = await mirrorCoversInfo(profile);
      return { ...st, coverBytes: covers.bytes, covers: covers.count };
    }, {
      bytes: 0,
      albums: 0,
      artists: 0,
      playlists: 0,
      starredSongs: 0,
      coverBytes: 0,
      covers: 0,
    }),

  starred: () => withMirror((d, p) => Db.getStarred(d, p), undefined),
  playlists: () => withMirror((d, p) => Db.getPlaylists(d, p), undefined),
  playlistDetail: (id) => withMirror((d, p) => Db.getPlaylistDetail(d, p, id), undefined),
  playlistSongIds: () =>
    withMirror((d, p) => Db.playlistSongIds(d, p), new Map<string, string[]>()),
  albumDetail: (id) => withMirror((d, p) => Db.getAlbumDetail(d, p, id), undefined),
  artistDetail: (id) => withMirror((d, p) => Db.getArtistDetail(d, p, id), undefined),
  artistFallback: (id) =>
    withMirror((d, p) => Db.artistFallback(d, p, id), { albums: [] as Album[] }),
  song: (id) => withMirror((d, p) => Db.getSong(d, p, id), undefined),
  songs: (ids) => withMirror((d, p) => Db.getSongs(d, p, ids), new Map<string, Song>()),
  playlistVersions: () => withMirror((d, p) => Db.playlistVersions(d, p), {}),
  albumIds: () => withMirror((d, p) => Db.albumIds(d, p), new Set<string>()),
  ownCoverSongs: (ids) => withMirror((d, p) => Db.ownCoverSongs(d, p, ids), []),
}));
