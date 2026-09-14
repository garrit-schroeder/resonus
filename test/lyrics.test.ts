/**
 * Word-timed lyrics (#165): the TTML reader, enhanced LRC both ways, and the
 * OpenSubsonic cues. What goes wrong here goes wrong quietly, as a line that
 * lights up whole or a word that lights up under the wrong syllable.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseLrc, serializeLrc } from '@/lib/lrc';
import { indexOfByte, wordsFromCues } from '@/lib/lyricWords';
import { parseTtml, ttmlTime } from '@/lib/ttml';

/** The start of the file attached to #165, and one line from its end. */
const USSEEWA =
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" ' +
  'xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="ja"><head><metadata>' +
  '<ttm:agent type="person" xml:id="v1"/><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal" ' +
  'leadingSilence="0.300"><translations/><songwriters><songwriter>syudou</songwriter></songwriters>' +
  '<audio lyricOffset="-0.137" role="spatial"/></iTunesMetadata></metadata></head><body dur="3:24.920">' +
  '<div begin="0.972" end="7.446" itunes:songPart="Verse">' +
  '<p begin="0.972" end="3.351" itunes:key="L1" ttm:agent="v1"><span begin="0.972" end="1.930">正しさとは</span> ' +
  '<span begin="2.389" end="2.913">愚かさ</span><span begin="2.913" end="3.351">とは</span></p>' +
  '<p begin="2:57.507" end="3:00.958" itunes:key="L51" ttm:agent="v1"><span begin="2:57.507" end="2:58.224">何回</span>' +
  '<span begin="2:58.224" end="2:59.629">聞かせるんだ</span></p></div></body></tt>';

const pairs = (words?: { start: number; value: string }[]) => words?.map((w) => [w.start, w.value]);

describe('TTML', () => {
  it('reads the file from #165 word by word, the space between spans included', () => {
    const lyrics = parseTtml(USSEEWA);
    assert.ok(lyrics?.synced);
    assert.equal(lyrics.lines.length, 2);
    const [first, second] = lyrics.lines;
    assert.equal(first.start, 972);
    assert.equal(first.value, '正しさとは 愚かさとは');
    assert.deepEqual(pairs(first.words), [
      [972, '正しさとは '],
      [2389, '愚かさ'],
      [2913, 'とは'],
    ]);
    assert.equal(first.words?.[0].end, 1930);
    assert.equal(second.start, 177507);
    assert.equal(second.value, '何回聞かせるんだ');
  });

  it('keeps what is in the head out of the lyrics', () => {
    const text = parseTtml(USSEEWA)!.lines.map((l) => l.value).join('\n');
    assert.ok(!text.includes('syudou'));
  });

  it('leaves out backing vocals and anything else with a role', () => {
    const lyrics = parseTtml(
      '<tt><body><div><p begin="1s" end="3s"><span begin="1s">Hey</span> ' +
        '<span ttm:role="x-bg"><span begin="2s">(hey)</span></span></p></div></body></tt>',
    );
    const [line] = lyrics!.lines;
    assert.equal(line.value, 'Hey');
    assert.deepEqual(pairs(line.words), [[1000, 'Hey']]);
  });

  it('reads a file timed by the line, without words', () => {
    const lyrics = parseTtml(
      '<tt><body><p begin="00:00:01.500" end="00:00:03.000">One &amp; two</p>' +
        '<p begin="00:00:04.000">Three&#x21;</p></body></tt>',
    );
    assert.ok(lyrics?.synced);
    assert.deepEqual(
      lyrics.lines.map((l) => [l.start, l.value, l.words]),
      [
        [1500, 'One & two', undefined],
        [4000, 'Three!', undefined],
      ],
    );
  });

  it('reads an untimed file as plain lyrics', () => {
    const lyrics = parseTtml('<tt><body><p>One</p><p>Two<br/>and a half</p></body></tt>');
    assert.equal(lyrics?.synced, false);
    assert.deepEqual(
      lyrics.lines.map((l) => l.value),
      ['One', 'Two and a half'],
    );
  });

  it('reads an indented file with prefixed tags', () => {
    const lyrics = parseTtml(
      '<tt:tt>\n  <tt:body>\n    <tt:p begin="1.0s">\n      <tt:span begin="1.0s">Hel</tt:span>' +
        '<tt:span begin="1.4s">lo</tt:span>\n    </tt:p>\n  </tt:body>\n</tt:tt>',
    );
    const [line] = lyrics!.lines;
    assert.equal(line.value, 'Hello');
    assert.deepEqual(pairs(line.words), [
      [1000, 'Hel'],
      [1400, 'lo'],
    ]);
  });

  it('reads every way of writing a time', () => {
    assert.equal(ttmlTime('0.972'), 972);
    assert.equal(ttmlTime('2:57.507'), 177507);
    assert.equal(ttmlTime('01:02:03.5'), 3723500);
    assert.equal(ttmlTime('1.5s'), 1500);
    assert.equal(ttmlTime('1500ms'), 1500);
    assert.equal(ttmlTime('00:00:01:12'), undefined);
  });

  it('is not fooled by a file that is not TTML', () => {
    assert.equal(parseTtml('[00:01.00]Just an LRC'), null);
  });
});

describe('Enhanced LRC', () => {
  const LINE = '[00:01.00]<00:01.00>Hello <00:01.50>world<00:02.25>';

  it('reads the word timestamps', () => {
    const [line] = parseLrc(LINE)!.lines;
    assert.equal(line.value, 'Hello world');
    assert.deepEqual(pairs(line.words), [
      [1000, 'Hello '],
      [1500, 'world'],
    ]);
    assert.equal(line.words?.[1].end, 2250);
  });

  it('writes them back as it read them', () => {
    assert.equal(serializeLrc(parseLrc(LINE)!), LINE);
  });

  it('moves the words with the offset, like the lines', () => {
    const [line] = parseLrc('[offset:500]\n[00:02.00]<00:02.00>a <00:03.00>b')!.lines;
    assert.equal(line.start, 1500);
    assert.deepEqual(pairs(line.words), [
      [1500, 'a '],
      [2500, 'b'],
    ]);
  });

  it('keeps a chorus stamped twice, without words', () => {
    const lyrics = parseLrc('[00:01.00][00:10.00]<00:01.00>La <00:01.50>la')!;
    assert.deepEqual(
      lyrics.lines.map((l) => [l.start, l.value, l.words]),
      [
        [1000, 'La la', undefined],
        [10000, 'La la', undefined],
      ],
    );
  });

  it('leaves plain LRC as it was', () => {
    const text = '[00:01.00]Hello world\n[00:02.50]Again';
    assert.equal(serializeLrc(parseLrc(text)!), text);
  });
});

describe('OpenSubsonic cues', () => {
  const LINE = '눈을 뜬 순간';

  it('cuts by byte offset, three bytes to a Korean syllable', () => {
    const words = wordsFromCues(LINE, [
      { start: 2747, end: 3018, value: '눈', byteStart: 0 },
      { start: 3018, end: 3179, value: '을', byteStart: 3 },
      { start: 3179, end: 3400, value: '뜬', byteStart: 7 },
      { start: 3400, end: 4000, value: '순간', byteStart: 11 },
    ]);
    assert.deepEqual(pairs(words), [
      [2747, '눈'],
      [3018, '을 '],
      [3179, '뜬 '],
      [3400, '순간'],
    ]);
  });

  it('falls back to the words themselves when the bytes are wrong', () => {
    // Counted in characters instead of bytes.
    const words = wordsFromCues(LINE, [
      { start: 1, value: '눈', byteStart: 0 },
      { start: 2, value: '을', byteStart: 1 },
      { start: 3, value: '뜬', byteStart: 3 },
      { start: 4, value: '순간', byteStart: 5 },
    ]);
    assert.deepEqual(
      words?.map((w) => w.value),
      ['눈', '을 ', '뜬 ', '순간'],
    );
  });

  it('applies the offset', () => {
    const words = wordsFromCues('a b', [
      { start: 1000, end: 1400, value: 'a', byteStart: 0 },
      { start: 1500, end: 1900, value: 'b', byteStart: 2 },
    ], 200);
    assert.deepEqual(
      words?.map((w) => [w.start, w.end]),
      [
        [800, 1200],
        [1300, 1700],
      ],
    );
  });

  it('counts a character outside the basic plane as four bytes and two units', () => {
    assert.equal(indexOfByte('a😀b', 5), 3);
    assert.equal(indexOfByte('a😀b', 2), -1);
  });
});
