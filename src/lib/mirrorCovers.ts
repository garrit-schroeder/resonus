/**
 * Covers for what the library mirror keeps.
 *
 * The mirror is what makes the Library readable without a connection: what you
 * favourited, your playlists, the albums you opened. Their covers, though, were
 * only ever a URL to the server, so offline they either came out of the image
 * loader's cache or not at all. That cache is not ours: it has a size and it
 * evicts, so on a large library most of it was gone and the shelves came out as
 * grey squares.
 *
 * So the covers are saved on purpose, next to the mirror and by the same rule:
 * while online, whatever is written to the mirror gets its cover fetched once,
 * small, and from then on it is a file on disk like a download's. Nothing is
 * crawled ahead of time; this only follows what you were already looking at.
 *
 * Albums, playlists and artists, which is what the shelves are made of, plus
 * the album behind each song a playlist or the favourites keep. Never a song's
 * own cover id: on a server that gives every track one, that would be a file
 * per track, and offline the rows ask for their album's picture instead (see
 * `songCoverUrl`). That last part used to be assumed rather than done, which
 * is why a playlist offline was a column of grey squares.
 */
import * as FileSystem from 'expo-file-system/legacy';

import { COVER, coverArtUrl, type SubsonicAuth } from '@/api/backend';
import { isOfflineMode } from '@/api/netGate';
import { whenIdle } from '@/lib/idle';
import { speculationOpen } from '@/lib/speculation';
import { bump, netTally } from '@/lib/perfLog';
import { hashKey, localCoverUrl, registerCover } from '@/lib/localLibrary';
import * as Db from './mirrorDb';

/** The mirror's own folder, which is where its database is opened. */
const BASE = FileSystem.documentDirectory + 'library-mirror/';
const DIR = BASE + 'covers/';

/**
 * One size for everything, and it has to be the largest anything asks for
 * rather than the smallest: the same file is the 56 px thumbnail in a list and
 * the cover across the top of the album, and a picture saved for the list
 * looks soft where it matters most. The image loader scales down for free;
 * upwards it cannot. Around 50 KB each in practice.
 */
const SIZE = COVER.card;

/**
 * Ceiling on how many are kept. A library browsed end to end, and nobody
 * browses ten thousand albums in a sitting: what this really bounds is the
 * runaway case, which is the only reason to have a number at all.
 * There is a ceiling at all because this grows on its own, and something that
 * grows on its own should have an end somebody chose rather than one they
 * discover. What it takes is counted and shown in Settings › Downloads next to
 * the rest of the offline copy, and it goes when that goes.
 */
const MAX = 10000;

/**
 * What a cover is wanted for: the id to ask the server with, and the ids the
 * screens will look it up by.
 *
 * They are not always the same, and that is the whole reason this type exists.
 * Subsonic gives an album a cover id of its own (`al-123` against the album's
 * `123`), the album header asks by the first and a song row asks by the
 * second, and a picture saved under one was a grey square under the other. A
 * playlist row goes further: all it knows is the song, whose own cover id
 * (`mf-…`) the server does answer, and what it will ask by is the album.
 *
 * So one file, fetched by `from`, found under every one of `keys`.
 */
export interface CoverWant {
  from: string;
  keys: string[];
}

/** Cover ids already on disk for the loaded profile, and what they take. */
let known = new Set<string>();
/** Lookup id → the id whose file it is. Only for the ones that differ. */
let aliases = new Map<string, string>();
let bytes = 0;
let loaded = '';
let saving: Promise<unknown> = Promise.resolve();
/** How many covers are fetched at the same time. */
const FETCH_AT_ONCE = 4;

/** Ids being fetched right now, so two screens don't fetch the same one. */
const inFlight = new Set<string>();

function indexFile(profile: string): string {
  return `${DIR}${profile}.json`;
}

function fileFor(profile: string, coverId: string): string {
  return `${DIR}${profile}_${hashKey(coverId)}.jpg`;
}

/**
 * Writes down what has just been saved, and only that.
 *
 * This used to be an index file rewritten whole every few seconds, which grew
 * with the library: eight hundred ids and their other names, serialised again
 * for each new cover. Rows go into the mirror's database instead, in one
 * statement per batch, and nothing already written is touched.
 */
function persist(profile: string, rows: Db.CoverRow[]): void {
  if (rows.length === 0) return;
  saving = saving.then(() => Db.putCovers(BASE, profile, rows).catch(() => {}));
}

/** The index as it is stored, and as older versions stored it (a bare list). */
function parseIndex(raw: string): {
  ids: string[];
  aliases: Record<string, string>;
  bytes: number;
} {
  const data = JSON.parse(raw) as
    | string[]
    | { ids?: string[]; aliases?: Record<string, string>; bytes?: number };
  if (Array.isArray(data)) return { ids: data, aliases: {}, bytes: 0 };
  return { ids: data.ids ?? [], aliases: data.aliases ?? {}, bytes: data.bytes ?? 0 };
}

/**
 * Registers the covers this profile already has, so an offline lookup finds
 * them. The file name is a hash, so which id each one belongs to has to be
 * written down: that is what the `covers` table holds, along with the other
 * names each file answers to.
 */
export async function loadMirrorCovers(profile: string): Promise<void> {
  if (!profile || loaded === profile) return;
  loaded = profile;
  known = new Set();
  aliases = new Map();
  bytes = 0;
  try {
    let rows = await Db.allCovers(BASE, profile);
    if (rows.length === 0) rows = await migrateIndex(profile);
    for (const r of rows) {
      if (r.aliasOf) continue;
      known.add(r.id);
      bytes += r.bytes;
      registerCover(r.id, fileFor(profile, r.id));
    }
    // The other names the same file answers to. No second copy on disk: the
    // album's cover and the one its songs ask for are one picture.
    for (const r of rows) {
      if (!r.aliasOf || !known.has(r.aliasOf)) continue;
      aliases.set(r.id, r.aliasOf);
      registerCover(r.id, fileFor(profile, r.aliasOf));
    }
  } catch {
    // A table that cannot be read leaves the shelves as placeholders, which is
    // what they were before any of this, rather than taking the screen down.
  }
}

/**
 * Moves an index written as JSON into the table, once.
 *
 * Everybody who has used the app before this has one, holding what may be
 * thousands of covers already on disk; without this they would all look
 * missing and be fetched again. The file goes when its contents are safely in.
 */
async function migrateIndex(profile: string): Promise<Db.CoverRow[]> {
  let index: { ids: string[]; aliases: Record<string, string>; bytes: number };
  try {
    index = parseIndex(await FileSystem.readAsStringAsync(indexFile(profile)));
  } catch {
    return []; // no old index: nothing was ever saved
  }
  if (index.ids.length === 0) return [];
  // The size was kept as one number for the lot, and the table keeps it per
  // row: it is shared out so the total still adds up to what it was.
  const each = Math.round(index.bytes / index.ids.length);
  const saved = new Set(index.ids);
  const rows: Db.CoverRow[] = index.ids.map((id) => ({ id, aliasOf: null, bytes: each }));
  for (const [id, from] of Object.entries(index.aliases)) {
    // An id that has a file of its own is not a name for somebody else's: the
    // table has one row per id, so letting the alias through would replace the
    // file with a pointer and leave the file behind.
    if (saved.has(id)) continue;
    rows.push({ id, aliasOf: from, bytes: 0 });
  }
  await Db.putCovers(BASE, profile, rows);
  await FileSystem.deleteAsync(indexFile(profile), { idempotent: true }).catch(() => {});
  return rows;
}

/**
 * Notes that one more id finds this file, and registers it now.
 *
 * The id a file is named after is not recorded as an alias of itself: the index
 * already has it, and writing it twice would be two ways of saying one thing.
 */
function alias(profile: string, key: string, from: string): boolean {
  if (key === from || aliases.get(key) === from) return false;
  // Never over a file of its own. An album whose songs carry no cover id of
  // their own is saved under the album's, and a later song of the same album
  // that does carry one would otherwise point that same id at its file: two
  // rows for one picture, one of them orphaning a file, and the id counted as
  // a name rather than as something saved.
  if (known.has(key)) return false;
  aliases.set(key, from);
  registerCover(key, fileFor(profile, from));
  return true;
}

/**
 * Keeps the covers of what was just written to the mirror. Best-effort and in
 * the background: a cover that doesn't arrive is a placeholder, not an error.
 *
 * A bare string is the plain case, where the id asked of the server is also the
 * id the screens look it up by. Where those differ, see `CoverWant`.
 */
export function keepMirrorCovers(
  profile: string,
  auth: SubsonicAuth | null,
  ids: (string | CoverWant | undefined)[],
): void {
  // Online only: this is a download, and it goes through the file system rather
  // than the API, so the gate that refuses requests offline cannot see it.
  if (!auth || !profile || isOfflineMode()) return;
  // Every fetch that touches the mirror ends up here, and a pull to refresh is
  // several at once: the favourites alone hand over the album of every
  // favourite song, so on a large library that is thousands of wants rebuilt,
  // deduplicated and filtered, dozens of times a minute, on the thread drawing
  // the screen. Measured at thirty five refreshes of the favourites in three
  // minutes. It is catch-up work, so it is gathered and run on a slow clock.
  // A batch belongs to one profile; another profile's wants start a new one.
  if (pendingFor?.profile !== profile) pending = [];
  pendingFor = { profile, auth };
  for (const want of ids) if (want) pending.push(want);
  if (runScheduled) return;
  runScheduled = true;
  const wait = Math.max(0, lastRun + MIN_GAP_MS - Date.now());
  setTimeout(() => {
    runScheduled = false;
    lastRun = Date.now();
    const batch = pending;
    const owner = pendingFor;
    pending = [];
    pendingFor = null;
    if (owner) runCovers(owner.profile, owner.auth, batch);
  }, wait);
}

/** How long between runs, however often they are asked for. */
const MIN_GAP_MS = 30_000;
let pending: (string | CoverWant)[] = [];
let pendingFor: { profile: string; auth: SubsonicAuth } | null = null;
let runScheduled = false;
let lastRun = 0;

function runCovers(
  profile: string,
  auth: SubsonicAuth,
  ids: (string | CoverWant | undefined)[],
): void {
  // When the thread is free. This is called from the middle of opening an album
  // or a playlist, and downloading a few hundred covers is not something to
  // start while a transition is still running: nothing here is urgent, and a
  // screen that arrives late is what the user actually notices.
  whenIdle(() => {
    void (async () => {
      // What is already on disk has to be known before deciding what is missing.
      // Online the mirror is opened a few seconds after launch, and the first
      // favourites arrive before that: waiting here instead of giving up is the
      // difference between saving them on the first run and on some later one.
      await loadMirrorCovers(profile);
      if (known.size >= MAX) return;
      // Deduplicated by what is being LOOKED UP, not by what is fetched. Twenty
      // favourites off one record ask for twenty different pictures as far as
      // the server is concerned, since each song has a cover id of its own, and
      // all twenty are the album's one file. Keeping the first want that claims
      // a key is what turns eight hundred downloads into two hundred.
      const claimed = new Set<string>();
      const byFrom = new Map<string, CoverWant>();
      for (const want of ids) {
        if (!want) continue;
        const w = typeof want === 'string' ? { from: want, keys: [want] } : want;
        if (!w.from || w.keys.length === 0) continue;
        const seen = byFrom.get(w.from);
        if (seen) {
          for (const k of w.keys) {
            if (claimed.has(k)) continue;
            claimed.add(k);
            seen.keys.push(k);
          }
          continue;
        }
        if (w.keys.every((k) => claimed.has(k))) continue;
        for (const k of w.keys) claimed.add(k);
        byFrom.set(w.from, { from: w.from, keys: [...w.keys] });
      }
      // A want whose keys can all be found already is nothing to do. That is
      // what makes running this over a whole library cheap after the first time.
      const wanted = [...byFrom.values()].filter(
        (w) =>
          !inFlight.has(w.from) &&
          w.keys.some((k) => !localCoverUrl(k)) &&
          !(known.has(w.from) && w.keys.every((k) => localCoverUrl(k))),
      );
      const taking = wanted.slice(0, MAX - known.size);
      if (taking.length === 0) return;
      for (const w of taking) inFlight.add(w.from);
      // What this run has to write down, gathered as it goes and written in one
      // statement at the end rather than a file rewritten per cover.
      const written: Db.CoverRow[] = [];

      /** One want: the file if it is missing, the names for it either way. */
      const fetchOne = async (w: CoverWant): Promise<void> => {
        const id = w.from;
        try {
          // Already on disk, and only the other names for it were missing: the
          // picture does not need fetching twice.
          if (known.has(id)) {
            for (const key of w.keys) {
              if (alias(profile, key, id)) written.push({ id: key, aliasOf: id, bytes: 0 });
            }
            return;
          }
          const url = coverArtUrl(auth, id, SIZE);
          if (!url) return;
          const file = fileFor(profile, id);
          await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
          await speculationOpen();
          netTally('coverArt.view (mirror)');
          const res = await FileSystem.downloadAsync(url, file);
          // A server that answers an error writes that error to the file, and a
          // broken file on disk would pass for a cover for good.
          if (res.status !== 200) {
            await FileSystem.deleteAsync(file, { idempotent: true }).catch(() => {});
            bump('cover refused by server');
            return;
          }
          known.add(id);
          registerCover(id, file);
          for (const key of w.keys) {
            if (alias(profile, key, id)) written.push({ id: key, aliasOf: id, bytes: 0 });
          }
          bump('cover saved');
          // Counted as it is written: walking thousands of files to add up
          // what they take is not something a settings screen should do.
          const info = await FileSystem.getInfoAsync(file).catch(() => null);
          const size = info?.exists ? (info.size ?? 0) : 0;
          bytes += size;
          written.push({ id, aliasOf: null, bytes: size });
        } catch {
          // Network, disk, whatever: it stays unknown and can be tried again.
          bump('cover fetch failed');
        } finally {
          inFlight.delete(id);
        }
      };

      // A few at a time. One after another meant a library's worth of covers
      // took as many round trips as there were albums, and somebody looking at
      // their favourites five minutes in still saw grey. Four, which is what
      // the playlist prefetch settled on: enough to keep the link busy, few
      // enough not to be a burst at somebody's server.
      for (let i = 0; i < taking.length; i += FETCH_AT_ONCE) {
        await Promise.all(taking.slice(i, i + FETCH_AT_ONCE).map(fetchOne));
      }
      persist(profile, written);
    })();
  });
}

/**
 * What is on disk for the loaded profile, for the diagnostics screen. A cover
 * that is missing is either not saved (`saved` low against a big library) or
 * saved under a name nothing asks by (`saved` high and the lookups still
 * missing), and those are two different bugs.
 */
export function mirrorCoverState(): { saved: number; aliases: number } {
  return { saved: known.size, aliases: aliases.size };
}

/**
 * How one cover id resolves here, in words, for the Diagnostics screen.
 *
 * Three answers, and only one of them can hand back a picture that is not the
 * one asked for: a file saved under a DIFFERENT id, which this index points at
 * on purpose so twenty songs off one record share one download. Which id it
 * borrowed from is the part worth reading, since that is the picture that ends
 * up on screen.
 *
 * Read on demand and nowhere else. Counting this on every call would mean a
 * tally per row per render, on the thread drawing the list, for a question
 * nobody is asking unless they have this screen open (#50).
 */
export function coverSourceOf(id: string | undefined): string {
  if (!id) return 'none asked for';
  const from = aliases.get(id);
  if (from) return `alias of ${from}`;
  if (known.has(id)) return 'its own file';
  return 'not saved here';
}

/**
 * Forgets one cover, so the next time its entry is written to the mirror it is
 * fetched again. For when the app itself changes it: a playlist's picture can
 * be replaced from here, and the copy on disk would otherwise be the old one
 * for good. A change made from another client is not seen, same as a
 * download's cover.
 */
export function forgetMirrorCover(profile: string, coverId: string | undefined): void {
  if (!profile || !coverId || !known.delete(coverId)) return;
  // The other names for it go too, or they would keep pointing at a file that
  // is no longer there. One statement takes the lot.
  for (const [key, from] of aliases) if (from === coverId) aliases.delete(key);
  void FileSystem.deleteAsync(fileFor(profile, coverId), { idempotent: true }).catch(() => {});
  saving = saving.then(() => Db.dropCover(BASE, profile, coverId).catch(() => {}));
}

/**
 * Throws away one profile's covers: the index and every file it named. They
 * share a folder with other profiles' (the name carries whose it is), so this
 * takes them one by one rather than deleting the folder.
 */
export async function removeMirrorCovers(profile: string): Promise<void> {
  let ids: string[] = [];
  try {
    ids = (await Db.allCovers(BASE, profile)).filter((r) => !r.aliasOf).map((r) => r.id);
  } catch {
    // No table yet: the files, if any, cannot be told apart from another
    // profile's, and they are bounded and harmless.
  }
  if (loaded === profile) {
    known = new Set();
    aliases = new Map();
    bytes = 0;
    loaded = '';
  }
  for (const id of ids) {
    await FileSystem.deleteAsync(fileFor(profile, id), { idempotent: true }).catch(() => {});
  }
  await Db.dropCovers(BASE, profile).catch(() => {});
  // The index this used to be kept in, for an install that never got as far as
  // migrating it.
  await FileSystem.deleteAsync(indexFile(profile), { idempotent: true }).catch(() => {});
}

/** How many of this profile's covers there are and what they take, for
 *  Settings › Downloads. */
export async function mirrorCoversInfo(
  profile: string,
): Promise<{ bytes: number; count: number }> {
  if (!profile) return { bytes: 0, count: 0 };
  await loadMirrorCovers(profile);
  if (bytes > 0 || known.size === 0) return { bytes, count: known.size };
  // Covers saved before the size was being counted, or an index that lost it.
  // Added up once, here: this is asked by a screen about sizes, which is the
  // one place where walking the files is worth what it costs, and the answer
  // is written down so it is not walked again.
  let total = 0;
  const rows: Db.CoverRow[] = [];
  for (const id of known) {
    const info = await FileSystem.getInfoAsync(fileFor(profile, id)).catch(() => null);
    const size = info?.exists ? (info.size ?? 0) : 0;
    total += size;
    rows.push({ id, aliasOf: null, bytes: size });
  }
  bytes = total;
  persist(profile, rows);
  return { bytes, count: known.size };
}
