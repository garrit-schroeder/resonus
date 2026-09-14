/**
 * The first albums of a genre, for the covers that fan out on its card.
 *
 * One request per genre and a grid is all of them, so they go through a gate a
 * few at a time: the covers trickle in instead of opening forty sockets on the
 * way into Search. Each answer is kept for as long as a card is looking at it,
 * because a genre's first albums do not move.
 */
import { useQuery } from '@tanstack/react-query';

import { getAlbumsByGenre } from '@/api/data';
import { useAuthStore } from '@/store/auth';

/** How many covers a card fans out. */
export const GENRE_ART_COUNT = 2;

const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.push(resolve);
  });
}

function release(): void {
  // The slot is handed straight to whoever is next rather than freed and taken
  // again, which is what keeps the count at the ceiling instead of above it.
  const next = waiting.shift();
  if (next) next();
  else inFlight -= 1;
}

/** `undefined` while it is being asked for, and on any server that says no. */
export function useGenreArt(name: string, albumCount?: number) {
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const { data } = useQuery({
    queryKey: ['genreArt', name],
    queryFn: async () => {
      await acquire();
      try {
        return await getAlbumsByGenre(name, GENRE_ART_COUNT);
      } finally {
        release();
      }
    },
    enabled: !!auth && !offline && albumCount !== 0,
    staleTime: Infinity,
    // A card with no art is the same card, so a failure is not worth a second
    // request when the grid is already making dozens.
    retry: false,
  });
  return data;
}
