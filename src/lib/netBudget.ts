/**
 * How many requests the app may have on its way to the server because they
 * might be useful later, rather than because somebody is waiting for one.
 *
 * Android sends at most five requests to one host at a time and queues the rest
 * (the same rule `src/api/subsonic.ts` gives the slow artist lookups two of).
 * Whatever is asked for ahead of time holds one of those five until the server
 * answers it, and on a proxy that has to fetch the song from somewhere else
 * first, answering is the whole download (#137) - so a speculative request can
 * hold a connection for minutes, and one more than these four is the fifth,
 * which is the only thing a stream can be waiting for (#269: tapping a song
 * started only after the tracks behind it had been warmed, and the error the
 * wait produced was read as a dead source).
 *
 * Four: the mirror's batch at the rate it was tuned for, plus the one request
 * the warming window has on its way at any moment. Both take their share here
 * rather than carrying a limit each, since the number that matters is their
 * total: four covers and one warm is five, and the fifth is one the song
 * somebody just tapped cannot get. The three agent lookups keep their own two
 * of the five (see `src/api/subsonic.ts`).
 */
import { createSlots } from '@/lib/slots';

/** The pool every speculative request takes its turn in. */
export const speculativeSlots = createSlots(4);
