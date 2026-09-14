/**
 * How a library list is ordered and filtered.
 *
 * Lifted out of "Your library" when the Explore tab grew a playlists section:
 * both lists are the same rows sorted the same three ways, and the second one
 * was not worth a second copy of this. Pure functions only, so neither screen
 * has to import the other.
 */
// `import type`, not an inline `type` specifier: the statement is then erased
// outright, so importing these pure functions does not drag the settings store
// (and through it the locales, and expo-secure-store) in behind them. It is
// what lets `test/librarySort.test.ts` run on Node with nothing stubbed.
import type { LibrarySort } from '@/store/settings';

export const SORT_LABELS: Record<LibrarySort, string> = {
  recent: 'Recents',
  added: 'Recently added',
  alpha: 'Alphabetical',
};

/** Locale-aware name compare: right for accents/ñ (albums, artists). */
const byLocale = (a: string, b: string) => a.localeCompare(b);

/**
 * Case-insensitive code-point compare. Leading symbols sort before letters by
 * code point ("+" < "[" < a…), so playlists prefixed with "+" to pin them to
 * the top land there — matching Navidrome, Feishin and other clients.
 * localeCompare instead orders "[" before "+", burying the "+" playlists.
 */
export function byCodepoint(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Sorts by the chosen criterion: alphabetical by name, or by descending score
 * (last play timestamp / added timestamp) with alphabetical tie-break — the
 * never-played ones end up last, in A-Z. `compare` picks the name ordering
 * (locale-aware by default; code point for playlists, see byCodepoint).
 */
export function sortItems<T>(
  items: T[],
  sort: LibrarySort,
  name: (x: T) => string,
  score: (x: T) => number,
  compare: (a: string, b: string) => number = byLocale,
): T[] {
  // Keys computed once per item, not inside the comparator. A sort asks for
  // them about `2·n·log n` times, and `score` here parses a date or walks the
  // play history, so a couple of thousand favourites meant tens of thousands
  // of date parses on every render of the tab (#50).
  const keyed = items.map((item) => ({
    item,
    name: name(item),
    score: sort === 'alpha' ? 0 : score(item),
  }));
  const byName = (a: (typeof keyed)[number], b: (typeof keyed)[number]) =>
    compare(a.name, b.name);
  keyed.sort(sort === 'alpha' ? byName : (a, b) => b.score - a.score || byName(a, b));
  return keyed.map((k) => k.item);
}

/**
 * Normalizes for filtering: lowercase and without accents, so "Nino" finds
 * "Niño" and "cafe" finds "Café".
 */
export function normQ(str: string): string {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Does any of the fields contain the (already normalized) query? */
export function matches(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) return true;
  return fields.some((f) => f && normQ(f).includes(query));
}

