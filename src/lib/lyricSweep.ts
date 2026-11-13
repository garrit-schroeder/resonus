/**
 * Karaoke sweep model, ported from BitChord's `am-lyrics` (binimum).
 *
 * BitChord renders word-synced lyrics as a continuous wipe: `revealedChars`
 * is a fractional index into the line's text, so the bright layer is clipped
 * mid-word and the fill moves at the song's own rate instead of flipping
 * whole words on. Words also lift slightly while sung (`rise`) and held notes
 * bloom. Gaps of silence become dot leaders instead of empty space.
 *
 * All functions here are pure (ms in, number out) and worklet-marked where
 * the UI thread reads them every frame. No parser changes: this works on the
 * `LyricLine`/`LyricWord` Resonus already has.
 */
import type { LyricLine, LyricWord } from '@/api/subsonic';
import { wordEnds } from './lyricWords';

/** Silence from which a gap leader is shown, same as BitChord `MIN_GAP_MS`. */
export const SWEEP_GAP_MS = 4000;

/**
 * Silence from which a new stanza is assumed when the source marks none
 * (servers send no stanza info): verse parts rest longer than verse lines.
 */
export const STANZA_GAP_MS = 3000;

/** Auto-scroll lookahead, coerced like BitChord `scrollLead()`. */
export const SCROLL_LEAD_MIN_MS = 350;
export const SCROLL_LEAD_MAX_MS = 500;

/** Word lift envelope: rise clamped like BitChord (`RISE_MIN_MS..riseMs`). */
export const RISE_MIN_MS = 250;
export const RISE_SETTLE_MS = 700;

export function clamp01(value: number): number {
  'worklet';
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** When a line's content is known to be over, in the word clock. */
export function lineEndMs(line: LyricLine, nextStart?: number): number | undefined {
  if (line.words?.length) {
    const ends = wordEnds(line.words, nextStart);
    return ends[ends.length - 1];
  }
  return nextStart;
}

/**
 * Fractional character index sung at `posMs` (BitChord `revealedChars`).
 *
 * Words carry their trailing space, so the walk is over the concatenated
 * words exactly as they read. Gaps between words fill proportionally while
 * the pause lasts, instead of jumping.
 */
export function revealedChars(
  value: string,
  words: LyricLine['words'],
  ends: number[] | undefined,
  lineStart: number,
  posMs: number,
): number {
  'worklet';
  const total = value.length;
  if (!words || words.length === 0) return posMs >= lineStart ? total : 0;
  if (posMs <= lineStart) return 0;
  const safeEnds = ends ?? words.map((w) => w.end ?? Number.POSITIVE_INFINITY);
  let offset = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const len = w.value.length;
    const end = safeEnds[i] ?? Number.POSITIVE_INFINITY;
    if (posMs < w.start) return offset;
    if (posMs < end) {
      const span = Math.max(end - w.start, 1);
      return offset + ((posMs - w.start) / span) * len;
    }
    // Past this word: it stays filled through the pause before the next
    // word (its trailing space is part of `len`, so nothing extra to add).
    offset += len;
  }
  return total;
}

/** 0..1 wipe progress of a line, for the bright overlay's width. */
export function sweepProgress(
  value: string,
  words: LyricLine['words'],
  ends: number[] | undefined,
  lineStart: number,
  posMs: number,
): number {
  'worklet';
  if (value.length === 0) return 0;
  return clamp01(revealedChars(value, words, ends, lineStart, posMs) / value.length);
}

/** 0..1 fill of a single word, for per-word overlays. */
export function wordFill(start: number, end: number, posMs: number): number {
  'worklet';
  return clamp01((posMs - start) / Math.max(end - start, 1));
}

/**
 * 0..1 lift of a word: rises while sung, settles after (BitChord `wordLift`
 * simplified: rise over `clamp(dur, 250..700)`, fall over `RISE_SETTLE_MS`).
 */
export function wordLift(start: number, end: number, posMs: number): number {
  'worklet';
  if (posMs <= start) return 0;
  const dur = Math.max(end - start, 1);
  const riseMs = Math.min(Math.max(dur, RISE_MIN_MS), RISE_SETTLE_MS);
  if (posMs < end) return clamp01((posMs - start) / riseMs);
  return 1 - clamp01((posMs - end) / RISE_SETTLE_MS);
}

/**
 * Index of the line being sung (BitChord `activeLyricRows` cursor: the latest
 * line whose start is past, plus overlap handling for duets via known ends).
 */
export function activeIndex(lines: LyricLine[], posMs: number): number {
  let latest = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i].start ?? 0) <= posMs) latest = i;
    else break;
  }
  return latest;
}

/** Silence after line `i` before the next line starts, in ms. */
export function gapAfterMs(lines: LyricLine[], i: number): number {
  const line = lines[i];
  const nextStart = lines[i + 1]?.start;
  if (nextStart === undefined) return 0;
  const end = lineEndMs(line, nextStart) ?? nextStart;
  return Math.max(0, nextStart - end);
}

/** How far ahead the auto-scroll looks, from the gap after line `i`. */
export function scrollLeadMs(lines: LyricLine[], i: number): number {
  if (i < 0) return SCROLL_LEAD_MIN_MS;
  const gap = gapAfterMs(lines, i);
  return Math.min(Math.max(gap, SCROLL_LEAD_MIN_MS), SCROLL_LEAD_MAX_MS);
}

/**
 * Line the scroll aims at (BitChord `leadLine`): the active line slightly in
 * the future, so long notes arrive centered instead of late.
 */
export function focusIndex(lines: LyricLine[], posMs: number): number {
  const at = activeIndex(lines, posMs);
  if (at < 0) return -1;
  const lead = scrollLeadMs(lines, at);
  const ahead = activeIndex(lines, posMs + lead);
  return ahead >= 0 ? ahead : at;
}

/** Whether line `i` is followed by an instrumental gap worth dots. */
export function hasGapAfter(lines: LyricLine[], i: number): boolean {
  return gapAfterMs(lines, i) >= SWEEP_GAP_MS;
}

/** Silence before the first line, in ms (the intro BitChord shows dots for). */
export function introGapMs(lines: LyricLine[]): number {
  if (lines.length === 0) return 0;
  return Math.max(0, (lines[0].start ?? 0) - 0);
}

/** Whether the intro silence is worth dots. */
export function hasIntroGap(lines: LyricLine[]): boolean {
  return introGapMs(lines) >= SWEEP_GAP_MS;
}

/**
 * Indices opening a new stanza: the source's marks when it sent any (LRC
 * blank lines, TTML song parts), else a long-silence heuristic for sources
 * with no stanza info (servers). Never the first line.
 */
export function stanzaBreaks(lines: LyricLine[]): Set<number> {
  const out = new Set<number>();
  if (lines.some((l) => l.newStanza)) {
    lines.forEach((l, i) => {
      if (l.newStanza && i > 0) out.add(i);
    });
    return out;
  }
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i].start;
    if (cur === undefined) continue;
    // Silence after the previous line's known end; for lines timed by the
    // line alone, whose end is unknowable, the whole interval up to the next
    // attack — seven seconds on one line is a new stanza either way.
    const timed = prev.words?.length ? wordEnds(prev.words, cur) : undefined;
    const end = timed?.length ? timed[timed.length - 1] : (prev.start ?? cur);
    if (cur - end >= STANZA_GAP_MS) out.add(i);
  }
  return out;
}

/** 0..1 travel through the gap after line `i` (drives the dot leader). */
export function gapThrough(lines: LyricLine[], i: number, posMs: number): number {
  const line = lines[i];
  const nextStart = lines[i + 1]?.start;
  if (nextStart === undefined) return 0;
  const end = lineEndMs(line, nextStart) ?? nextStart;
  const span = Math.max(nextStart - end, 1);
  return clamp01((posMs - end) / span);
}

export type { LyricWord };
