/**
 * Navidrome 0.64 leaves `coverArt` out of an album, song, artist or playlist
 * it knows has no artwork, instead of naming an id that would only ever serve
 * its placeholder. Every screen here falls back to the item's own id when
 * `coverArt` is missing, because other servers leave it out for items that do
 * have art. On Navidrome that fallback asked anyway: it got Navidrome's
 * placeholder instead of ours, and a genre card that leaves out albums with no
 * art showed it.
 *
 * So an answer from such a server gets `coverArt: ''` on those items. Empty is
 * what says "none": the fallback does not take it (`'' ?? id` is `''`) and no
 * URL is made of it, while an object the app puts together itself, which lacks
 * `coverArt` for another reason, keeps falling back as before.
 */

/** The keys a Subsonic answer files albums, songs, artists and playlists under. */
const ITEM_KEYS = new Set(['album', 'song', 'child', 'entry', 'artist', 'playlist']);

/** Whether this answer comes from a server that leaves out absent artwork. */
export function omitsAbsentCovers(sub: { type?: unknown; serverVersion?: unknown }): boolean {
  if (sub.type !== 'navidrome' || typeof sub.serverVersion !== 'string') return false;
  const v = /^(\d+)\.(\d+)/.exec(sub.serverVersion);
  return !!v && (Number(v[1]) > 0 || Number(v[2]) >= 64);
}

/** Marks, in place, the items of the answer that came without `coverArt`. */
export function markAbsentCovers(node: unknown, isItem = false): void {
  if (Array.isArray(node)) {
    for (const n of node) markAbsentCovers(n, isItem);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (isItem && typeof obj.id === 'string' && obj.coverArt === undefined) obj.coverArt = '';
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value && typeof value === 'object') markAbsentCovers(value, ITEM_KEYS.has(key));
  }
}
