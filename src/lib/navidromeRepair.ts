/**
 * The one thing that decides a repair has to happen, and then makes it happen.
 *
 * Everything under it is checkable in isolation: the transform against
 * Navidrome's vectors, which strings are ids field by field, the verdict
 * against a server that never existed. This is where those meet a real profile
 * with real downloads, so it is deliberately thin. What it owns is only the
 * things that cannot be decided anywhere else:
 *
 * - **Once per profile.** The state is filed under the profile's own key, the
 *   same one the downloads and the queue use. A phone with a Navidrome and a
 *   Jellyfin account must repair one and not touch the other, and getting
 *   scope wrong here has bitten this app before (#34).
 * - **Once at a time.** The probe is reachable from the request path, so it
 *   can be asked for by several screens in the same second. The promise is
 *   shared rather than the work repeated.
 * - **Order.** The catalog first, because it is the one holding files that
 *   cannot be fetched again; the mirror and the outbox after. Each is
 *   independently idempotent, so a repair that dies halfway is retried rather
 *   than rolled back, and the second run finishes what the first started.
 */
import { getSong, type SubsonicAuth } from '@/api/subsonic';
import { remapCatalogIds, someSongIds } from '@/lib/downloadsDb';
import { remapMirrorIds } from '@/lib/mirrorDb';
import { canonicalId } from '@/lib/navidromeIds';
import { probeCandidates, probeMigration, type Verdict } from '@/lib/navidromeMigration';
import { getItem, setItem } from '@/lib/storage';
import { pathsFor as mirrorPathsFor } from '@/store/libraryMirror';
import { serverDir } from '@/store/downloads';
import { useAuthStore } from '@/store/auth';
import { useAutoDownloads } from '@/store/autoDownloads';
import { useOfflineQueue } from '@/store/offlineQueue';
import { remapQueueIds } from '@/store/player';
import { usePins } from '@/store/pins';
import { hashKey } from '@/lib/localLibrary';
import { primaryUrl } from '@/lib/serverUrls';

/** What a profile has been found to be, once it has been looked at. */
type Mark = 'repaired' | 'not-migrated';

function markKey(auth: SubsonicAuth): string {
  return `resonus.idRepair.${hashKey(`${primaryUrl(auth)}|${auth.username}`)}`;
}

function versionKey(auth: SubsonicAuth): string {
  return `${markKey(auth)}.version`;
}

/**
 * The server said which version it is. Worth a look if that changed, and worth
 * one look anyway on a profile nothing has ever concluded anything about.
 *
 * This is the trigger, and the retry in the request path is the safety net
 * under it. On its own the retry is not enough: it only fires on a request
 * that carries an id, and the home screen, the lists and the searches carry
 * none. All of those work perfectly against a migrated server and come back
 * with new ids, while the download catalog still holds old ones, so nothing
 * compares the two until something specific is opened. In that window an album
 * that is on the phone does not read as downloaded, and it can last for days
 * on somebody who only browses.
 *
 * A version is emphatically NOT proof of anything: develop builds carry a git
 * sha, a proxy can rewrite it, and 0.64 shipped the migration in a release
 * nobody could name in advance. All a change does is spend one probe finding
 * out. The proof is still the probe's, with its samples and its guards.
 *
 * It also fixes something the mark alone got wrong: a profile found not to
 * have migrated stayed marked that way forever, so a server upgraded the week
 * after would never have been looked at again.
 */
export async function noteServerVersion(auth: SubsonicAuth, version: string): Promise<void> {
  if (!version) return;
  const key = versionKey(auth);
  // Second line of defence for the same reason `ping` has the first: this
  // reads SecureStore, and it is reached from the path that decides whether
  // the app is online.
  if (versionInMemory.get(key) === version) return;
  const seen = versionInMemory.get(key) ?? (await getItem(key));
  versionInMemory.set(key, version);
  if (seen !== version) await setItem(key, version).catch(() => {});

  const mark = await repairMark(auth);
  if (mark === 'repaired') return;

  // A changed version is the signal, but it cannot be the only one, because
  // the version was being written down long before anything was allowed to act
  // on it. Somebody who upgraded their server to 0.64 while still on the build
  // where the repair was off has 0.64 already filed here, and updating the app
  // changes nothing about it: the one moment that was going to start the look
  // was spent by a build that could not look. Their downloads would then wait
  // on the retry in the request path, which only fires on a request carrying
  // an id, and the home screen, the lists and the searches carry none.
  //
  // So a profile that has never been settled gets one look regardless of the
  // version. It is one look and not one per launch: the probe writes a mark
  // either way it concludes, and the only thing that repeats is a profile it
  // could not conclude anything about, which is the case that wants retrying.
  // A profile with nothing downloaded costs no requests at all, since
  // `candidatesFor` has nothing to ask about.
  if (mark === null || (seen !== null && seen !== version)) {
    void repairIfMigrated(auth).catch(() => {});
  }
}

/**
 * What this session's check did, in one line, for the Diagnostics screen.
 *
 * Kept in memory rather than read back off disk: the report is meant to be
 * openable when something is already wrong, and it should not depend on the
 * storage it is reporting about. It is also the only trace this repair leaves
 * anywhere. Everything else about it is silent by design, which is right until
 * the day somebody says their downloads vanished and the only honest answer
 * would otherwise be a guess.
 */
let outcome = 'not checked this session';

export function repairStatus(): string {
  return outcome;
}

/** What each profile last answered with, so the check above costs no disk. */
const versionInMemory = new Map<string, string>();

/** One in-flight look per profile, so several callers share the answer. */
const running = new Map<string, Promise<Verdict>>();

/**
 * Whether this profile has already been settled.
 *
 * "Not migrated" is remembered too, but only as a hint: a server that had not
 * migrated last week may have been upgraded since, so it does not stop a later
 * look, it only stops the app asking on every screen for the rest of a session
 * that has nothing to find.
 */
export async function repairMark(auth: SubsonicAuth): Promise<Mark | null> {
  return (await getItem(markKey(auth))) as Mark | null;
}

/**
 * Song ids worth asking the server about, taken from the catalog.
 *
 * The downloads are the right place to look and not just a convenient one:
 * they are what a repair exists to save, so a profile with none of them has
 * nothing at stake, and one with them has a supply of ids the server gave us.
 */
async function candidatesFor(auth: SubsonicAuth): Promise<string[]> {
  try {
    // A few rows, not the catalog: enough that some of them will be ids the
    // transform moves, cheap enough to ask on a profile that has nothing to
    // find, which is every profile until the day one server is upgraded.
    return probeCandidates(await someSongIds(serverDir(auth), 200));
  } catch {
    return [];
  }
}

/**
 * Looks at one profile and, if its server has migrated, repairs it.
 *
 * Returns the verdict rather than throwing on "no": every caller of this is
 * somewhere that must carry on regardless, and a probe that could not reach a
 * conclusion is the ordinary case, not a failure.
 */
export async function repairIfMigrated(auth: SubsonicAuth): Promise<Verdict> {
  const key = markKey(auth);
  const already = running.get(key);
  if (already) return already;

  const run = (async (): Promise<Verdict> => {
    if ((await repairMark(auth)) === 'repaired') {
      outcome = 'already repaired';
      return 'migrated';
    }

    const candidates = await candidatesFor(auth);
    if (candidates.length === 0) {
      // Nothing downloaded, or nothing downloaded under an id the transform
      // would move. Either way there is nothing at stake and nothing to ask.
      outcome = 'nothing to check';
      return 'inconclusive';
    }

    const { verdict } = await probeMigration(candidates, async (id) => {
      try {
        return (await getSong(auth, id)) !== null;
      } catch {
        // Could not ask. Not a "no": see the probe's own note on why that
        // distinction is the whole safety of this.
        return undefined;
      }
    });

    if (verdict === 'not-migrated') {
      outcome = 'server has not migrated';
      await setItem(key, 'not-migrated').catch(() => {});
      return verdict;
    }
    if (verdict !== 'migrated') {
      outcome = `no verdict (${candidates.length} candidates)`;
      return verdict;
    }

    // Proof in hand. The catalog first: it is the only one of the three
    // holding something that cannot simply be asked for again.
    let done: { songs: number; albums: number };
    try {
      done = await remapCatalogIds(serverDir(auth), canonicalId);
    } catch (e) {
      // Left unmarked on purpose, so the next attempt tries again rather than
      // believing this one worked.
      outcome = `catalog remap FAILED: ${e instanceof Error ? e.message : 'unknown'}`;
      throw e;
    }

    // The profile being repaired, not whichever is signed in now: this can be
    // reached from a request that outlived a profile switch, and repairing one
    // account's mirror under another's name is the shape of #34.
    const mirror = mirrorPathsFor(auth);
    await remapMirrorIds(mirror.dir, mirror.profile, canonicalId).catch(() => {});

    useOfflineQueue.getState().remapIds(canonicalId);

    // The three that are only visible, after the three that hold data. Each is
    // in memory as well as on disk and each belongs to whichever profile is
    // loaded, so they are only right to touch when that is this one.
    if (useAuthStore.getState().auth === auth) {
      remapQueueIds(canonicalId);
      usePins.getState().remapIds(canonicalId);
      useAutoDownloads.getState().remapIds(canonicalId);
    }

    outcome = `repaired: ${done.songs} songs, ${done.albums} albums`;
    await setItem(key, 'repaired').catch(() => {});
    return verdict;
  })().finally(() => running.delete(key));

  running.set(key, run);
  return run;
}
