/**
 * LRC format (lyrics with `[mm:ss.xx]` timestamps). Used for `.lrc` files
 * next to local music, embedded USLT lyrics (which often contain timestamps),
 * and for caching server or LRCLIB lyrics to disk.
 * Text without timestamps also works: returned as unsynced lyrics.
 *
 * Enhanced LRC as well, which times each word with a `<mm:ss.xx>` in front of
 * it (#165). It is also what a download writes when the server sent words, so
 * the karaoke is still there offline.
 */
import type { LyricLine, LyricWord, SongLyrics } from '@/api/subsonic';
import { trimmedWords, type WordMark } from './lyricWords';

/** LRC metadata tags that are ignored (except `offset`, which is applied). */
const META_RE = /^\[(ar|ti|al|au|by|la|re|ve|tool|length|id|#):[^\]]*\]$/i;
const STAMP_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/y;
const WORD_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

function stampMs(min: string, sec: string, frac = ''): number {
  // 1 digit = tenths, 2 = hundredths, 3 = milliseconds.
  const ms = frac ? parseInt(frac, 10) * [100, 10, 1][frac.length - 1] : 0;
  return (parseInt(min, 10) * 60 + parseInt(sec, 10)) * 1000 + ms;
}

/** A line's text with its word timestamps taken out, and the words they mark. */
function wordStamps(raw: string): { value: string; words?: LyricWord[] } {
  const marks: WordMark[] = [];
  let text = '';
  let last = 0;
  for (const m of raw.matchAll(WORD_RE)) {
    text += raw.slice(last, m.index);
    marks.push({ at: text.length, start: stampMs(m[1], m[2], m[3]) });
    last = (m.index ?? 0) + m[0].length;
  }
  if (marks.length === 0) return { value: raw.trim() };
  return trimmedWords(text + raw.slice(last), marks);
}

function shift(line: LyricLine, offset: number): LyricLine {
  const at = (ms: number) => Math.max(0, ms - offset);
  return {
    ...line,
    start: at(line.start!),
    ...(line.words
      ? {
          words: line.words.map((w) => ({
            ...w,
            start: at(w.start),
            ...(w.end !== undefined ? { end: at(w.end) } : {}),
          })),
        }
      : {}),
  };
}

export function parseLrc(text: string): SongLyrics | null {
  const timed: LyricLine[] = [];
  const plain: LyricLine[] = [];
  let offset = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (META_RE.test(line)) continue;
    const off = line.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
    if (off) {
      offset = parseInt(off[1], 10) || 0;
      continue;
    }
    // Timestamps at the start (a line can have several: choruses).
    const starts: number[] = [];
    let pos = 0;
    for (;;) {
      STAMP_RE.lastIndex = pos;
      const m = STAMP_RE.exec(line);
      if (!m) break;
      starts.push(stampMs(m[1], m[2], m[3]));
      pos = STAMP_RE.lastIndex;
    }
    if (starts.length === 0) {
      plain.push({ value: line });
      continue;
    }
    // A line stamped more than once (a chorus) keeps its text but not its
    // words: those only have the one time.
    const { value, words } = wordStamps(line.slice(pos));
    for (const start of starts) {
      timed.push({ start, value, ...(words && starts.length === 1 ? { words } : {}) });
    }
  }

  if (timed.length > 0) {
    // Positive `offset` = lyrics should appear earlier (same convention as
    // OpenSubsonic offset).
    timed.sort((a, b) => a.start! - b.start!);
    return { synced: true, lines: timed.map((l) => shift(l, offset)) };
  }
  if (plain.length > 0) return { synced: false, lines: plain };
  return null;
}

/**
 * Serializes to LRC text (or plain text if lyrics are unsynced), enhanced LRC
 * for the lines that have words.
 */
export function serializeLrc(lyrics: SongLyrics): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = (at: number) => {
    const ms = Math.max(0, Math.round(at));
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return `${pad(min)}:${pad(sec)}.${pad(cs)}`;
  };
  return lyrics.lines
    .map((l) => {
      if (!lyrics.synced || l.start === undefined) return l.value;
      if (!l.words?.length) return `[${stamp(l.start)}]${l.value}`;
      const words = l.words.map((w) => `<${stamp(w.start)}>${w.value}`).join('');
      const end = l.words[l.words.length - 1].end;
      return `[${stamp(l.start)}]${words}${end !== undefined ? `<${stamp(end)}>` : ''}`;
    })
    .join('\n');
}
