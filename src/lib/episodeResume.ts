/** Closer to either end than this, an episode starts over. */
const START_SEC = 5;
const END_SEC = 30;

/** Left this close to its end, an episode counts as played. */
export function episodePlayed(positionSec: number, durationSec: number): boolean {
  return durationSec > 0 && positionSec >= durationSec - END_SEC;
}

/** The second to pick an episode up at, given where it was left. */
export function episodeResumeAt(positionSec: number, durationSec: number): number {
  if (positionSec < START_SEC || episodePlayed(positionSec, durationSec)) return 0;
  return positionSec;
}
