/**
 * TTML lyrics: the XML Apple Music uses, and what the tools that fetch
 * word-timed lyrics save next to the music (#165). Read here for files on the
 * phone; a server reads its own and sends them already cut into words.
 *
 * Not an XML parser, which React Native has none of: the body is walked as
 * tags and text, which is all a lyrics file uses. A paragraph is a line, a
 * timed span inside it a word or a syllable, and the text between spans (a
 * space, usually) goes with the word before. A span with a role (`x-bg`
 * backing vocals, `x-translation`, `x-roman`) is not the line being sung and
 * is left out.
 *
 * Times are taken as they are written, from the start of the track. The spec
 * makes them relative to the parent element, but Apple's files, and so every
 * file made to look like them, repeat the absolute time on every level.
 */
import type { LyricLine, SongLyrics } from '@/api/subsonic';
import { trimmedWords, type WordMark } from './lyricWords';

const TOKEN_RE =
  /<!--[\s\S]*?-->|<[?!][^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const hex = e[1] === 'x' || e[1] === 'X';
      const code = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** An attribute by its local name, whatever prefix it was written with. */
function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? (m[1] ?? m[2]) : undefined;
}

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

/** A clock time (`1:02.5`, `00:01:02.500`) or an offset (`62.5s`, `1500ms`), in ms. */
export function ttmlTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const offset = v.match(/^(\d+(?:\.\d+)?)(h|m|s|ms)$/);
  if (offset) return Math.round(parseFloat(offset[1]) * UNIT_MS[offset[2]]);
  const parts = v.split(':');
  if (parts.length > 3 || !parts.every((p) => /^\d+(?:\.\d+)?$/.test(p))) return undefined;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + parseFloat(p);
  return Math.round(sec * 1000);
}

export function parseTtml(text: string): SongLyrics | null {
  const body = text.search(/<(?:[\w.-]+:)?body[\s>/]/);
  if (body < 0) return null;
  const lines: LyricLine[] = [];
  let line: { start?: number; raw: string; marks: WordMark[] } | null = null;
  /** One per open span: whether what is inside it is left out. */
  let spans: boolean[] = [];

  const finish = (l: { start?: number; raw: string; marks: WordMark[] }) => {
    const { value, words } = trimmedWords(l.raw, l.marks);
    if (!value) return;
    const start = l.start ?? words?.[0].start;
    lines.push({ ...(start !== undefined ? { start } : {}), value, ...(words ? { words } : {}) });
  };

  for (const m of text.slice(body).matchAll(TOKEN_RE)) {
    const [, slash, tag, attrs = '', content] = m;
    if (content !== undefined) {
      // XML folds any run of white space into one, newlines of an indented
      // file included.
      if (line && !spans.includes(true)) line.raw += decode(content.replace(/\s+/g, ' '));
      continue;
    }
    if (!tag) continue; // a comment or a declaration
    const name = tag.replace(/^.*:/, '');
    const empty = attrs.endsWith('/');
    if (name === 'p') {
      if (slash) {
        if (line) finish(line);
        line = null;
        spans = [];
      } else if (!empty) {
        line = { start: ttmlTime(attr(attrs, 'begin')), raw: '', marks: [] };
      }
    } else if (name === 'span' && line) {
      if (slash) spans.pop();
      else if (!empty) {
        const skip = spans.includes(true) || attr(attrs, 'role') !== undefined;
        spans.push(skip);
        const begin = skip ? undefined : ttmlTime(attr(attrs, 'begin'));
        if (begin !== undefined) {
          const end = ttmlTime(attr(attrs, 'end'));
          line.marks.push({ at: line.raw.length, start: begin, ...(end !== undefined ? { end } : {}) });
        }
      }
    } else if (name === 'br' && line && !spans.includes(true)) {
      line.raw += ' ';
    }
  }

  if (lines.length === 0) return null;
  if (!lines.some((l) => l.start !== undefined)) return { synced: false, lines };
  // A line with no time of its own keeps the place of the one before it.
  let prev = 0;
  const timed = lines.map((l) => {
    prev = l.start ?? prev;
    return { ...l, start: prev };
  });
  timed.sort((a, b) => a.start - b.start);
  return { synced: true, lines: timed };
}
