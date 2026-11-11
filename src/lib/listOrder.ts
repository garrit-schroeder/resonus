/**
 * What a row's travel does to a list's order.
 *
 * The drag engine answers with two numbers — where the row lifted from and where
 * it dropped — and the app has to answer with the order it will act on. On a
 * playlist that order goes to the server and rewrites the list there, so the
 * splice that leaves a song out, moves one twice or drops one at the wrong end
 * is not something a later tap can undo. It is spelled here rather than inline
 * for that reason, and it is pure so a test can hold it; the settings lists that
 * reorder a shelf of sections hand-roll the same three lines because their
 * places are always inside the list and their cost of a wrong one is a settings
 * screen, not a server.
 */
export function applyDrag<T>(rows: T[], from: number, to: number): T[] {
  // A drag that lifted nothing has nothing to put down: the order is the one it
  // came in with, and a write built from it is the order the list already has.
  if (from < 0 || from >= rows.length) return rows;
  if (from === to) return rows;
  const next = rows.slice();
  const [moved] = next.splice(from, 1);
  // The engine's `to` counts the list the row is still sitting in, so past the
  // two ends there is nothing to drop into: first and last are the two ends.
  const at = to < 0 ? 0 : Math.min(to, next.length);
  next.splice(at, 0, moved);
  return next;
}
