/**
 * Which playlists are favourites, and whether this server can say at all.
 *
 * Every other favourite in the app comes off one Subsonic list (see
 * `useFavoriteIds`). Playlists cannot: Navidrome 0.64 stores their stars per
 * user but keeps them out of the Subsonic responses on purpose, so the heart
 * is written through Subsonic like any other and read back through Navidrome's
 * native API. This hook is the read side, and it doubles as the answer to
 * "should there be a heart here at all".
 *
 * `undefined` means no, and it covers a lot of ground: not a Navidrome, a
 * Navidrome too old to have the column, no password saved to reach the native
 * API with, offline, or the request simply failing. All of those are the same
 * thing to a caller: we cannot read the state, so we do not offer to write
 * it. A heart that appears to work and silently forgets is worse than no
 * heart, and on an older server that is exactly what starring a playlist does:
 * the id falls through to `media_file`, matches nothing, and the server says
 * OK.
 *
 * A `Set` rather than a list because callers ask "is this one starred" per
 * row, and the query is shared by key so several screens asking at once is one
 * request.
 */
import { useQuery } from '@tanstack/react-query';

import { listStarredPlaylistIds } from '@/api/navidrome';
import { serverAtLeast, type SubsonicAuth } from '@/api/subsonic';
import { PLAYLIST_KEY } from '@/lib/favoritesCache';
import { useAuthStore } from '@/store/auth';

/** The release that grew the column, and the API that exposes it. */
const PLAYLIST_STARS_SINCE = { major: 0, minor: 64 };

/**
 * Whether it is worth asking this profile at all, decided before any request.
 *
 * The password is the same one the cover upload needs: the native API wants a
 * JWT and the only way to one is a cleartext login. Where it is missing, the
 * other native-API features put a dialog in front of the user and ask; a heart
 * is not worth a password prompt, so this one just stays away.
 */
function canAsk(auth: SubsonicAuth | null, offline: boolean): boolean {
  if (!auth || offline) return false;
  if (auth.serverType !== 'navidrome') return false;
  if (!(auth.ndPassword ?? auth.password)) return false;
  // Strictly true: `undefined` is "the version said nothing useful", and the
  // safe reading of that is no.
  return serverAtLeast(auth, PLAYLIST_STARS_SINCE.major, PLAYLIST_STARS_SINCE.minor) === true;
}

export function usePlaylistStars(): Set<string> | undefined {
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const enabled = canAsk(auth, offline);

  const { data } = useQuery({
    queryKey: PLAYLIST_KEY,
    // The list is small and changes only when somebody taps a heart, which
    // updates the cache directly (see `favoritesCache`), so there is nothing
    // to gain from asking again on every mount.
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!auth) return [];
      // A failure here is not an error to show anybody: it means the heart is
      // not available, which is what an empty answer would mean too. Returning
      // `null` keeps the two apart, so a server that cannot answer hides the
      // heart instead of drawing every playlist as unstarred.
      try {
        return await listStarredPlaylistIds(auth);
      } catch {
        return null;
      }
    },
    enabled,
  });

  return data ? new Set(data) : undefined;
}
