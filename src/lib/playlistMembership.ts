/**
 * Which of a batch of songs a playlist holds. Pure, for the picker and its tests.
 */
import type { Playlist, Song } from '@/api/subsonic';

export type Membership = 'none' | 'some' | 'all';

/** The wanted ids a tracklist holds, each once however often it repeats. */
export function presentIn(tracklist: readonly string[], wanted: readonly string[]): string[] {
  const have = new Set(tracklist);
  return [...new Set(wanted)].filter((id) => have.has(id));
}

export function membershipOf(present: readonly string[], wanted: readonly string[]): Membership {
  if (present.length === 0) return 'none';
  return present.length >= new Set(wanted).size ? 'all' : 'some';
}

/** The songs still to add, each once. */
export function missingFrom(tracklist: readonly string[], songs: readonly Song[]): Song[] {
  const seen = new Set(tracklist);
  return songs.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

/** Positions of every copy of these ids, last first so removing one leaves the rest valid. */
export function indicesToRemove(tracklist: readonly string[], drop: readonly string[]): number[] {
  const gone = new Set(drop);
  const out: number[] = [];
  tracklist.forEach((id, i) => {
    if (gone.has(id)) out.unshift(i);
  });
  return out;
}

/**
 * Whether the stored tracklist is out of date or absent, by `changed`. A server
 * that sends no `changed` leaves a stored one standing, as the prefetch does.
 */
export function needsFetch(
  playlist: Pick<Playlist, 'id' | 'changed'>,
  versions: Record<string, string | undefined>,
): boolean {
  if (!(playlist.id in versions)) return true;
  return playlist.changed != null && versions[playlist.id] !== playlist.changed;
}

/**
 * Whether this user can change the tracks. `readonly` is OpenSubsonic's answer
 * (smart and synced lists, other people's); the owner covers servers without it.
 */
export function canEditTracks(
  playlist: Pick<Playlist, 'owner' | 'readonly'>,
  username: string | undefined,
): boolean {
  if (playlist.readonly) return false;
  return !playlist.owner || playlist.owner === username;
}
