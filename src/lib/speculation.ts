/**
 * Requests made because they might be useful later wait while the song somebody
 * asked for has not started. On a proxy that fetches each track from somewhere
 * else first, they compete with that song for the proxy's attention (#269).
 *
 * A hold always ends: the timeout is what a load nobody reports back on gets.
 */
const HOLD_TIMEOUT_MS = 120_000;

let current = 0;
let held = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let waiting: (() => void)[] = [];

/** Closes the gate. The number lets its owner release only its own hold. */
export function holdSpeculation(): number {
  current++;
  held = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => releaseSpeculation(), HOLD_TIMEOUT_MS);
  return current;
}

/** Opens the gate, unless a newer hold than `hold` has taken it. */
export function releaseSpeculation(hold?: number): void {
  if (hold !== undefined && hold !== current) return;
  held = false;
  if (timer) clearTimeout(timer);
  timer = null;
  const ready = waiting;
  waiting = [];
  for (const go of ready) go();
}

/** Resolves when nothing is holding the gate. */
export function speculationOpen(): Promise<void> {
  if (!held) return Promise.resolve();
  return new Promise((resolve) => waiting.push(resolve));
}
