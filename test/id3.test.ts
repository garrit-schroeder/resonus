/**
 * The ID3 parser, which is the one file in the app whose failures are silent.
 *
 * It reads bytes somebody else's encoder wrote, and the header of
 * `src/lib/id3.ts` says at length that the encoders get it wrong often enough
 * that the reader has to forgive them. Every one of those forgiving paths
 * loses the cover while leaving the text perfectly readable, so a file looks
 * correctly scanned and simply has no artwork anywhere (#141). Nothing but a
 * test can tell that the forgiveness still works: there is no error to see.
 *
 * The tags here are built byte by byte rather than read from a fixture, so
 * what each case is about is in the case and not in a binary nobody can open.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { base64ToUint8, parseID3 } from '@/lib/id3';

const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

/** Four bytes, most significant first: the size an ID3v2.3 frame declares. */
function plainSize(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** The same number with the top bit of each byte left clear, as 2.4 writes it. */
function synchsafeSize(n: number): number[] {
  return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
}

/** One frame: its id, its size in the given spelling, two flag bytes, its body. */
function frame(id: string, body: Uint8Array, size: (n: number) => number[]): Uint8Array {
  return Uint8Array.from([...latin1(id), ...size(body.length), 0, 0, ...body]);
}

/** A text frame in ISO-8859-1, which is encoding 0. */
function textBody(text: string): Uint8Array {
  return Uint8Array.from([0x00, ...latin1(text)]);
}

/** A text frame in UTF-16 with a byte order mark, which is encoding 1. */
function utf16Body(text: string): Uint8Array {
  const out = [0x01, 0xff, 0xfe];
  for (const char of text) {
    const code = char.charCodeAt(0);
    out.push(code & 0xff, (code >>> 8) & 0xff);
  }
  return Uint8Array.from(out);
}

function tag(verMajor: number, frames: Uint8Array[], flags = 0): Uint8Array {
  const body = frames.reduce<number[]>((all, f) => [...all, ...f], []);
  return Uint8Array.from([
    ...latin1('ID3'),
    verMajor,
    0,
    flags,
    ...synchsafeSize(body.length),
    ...body,
  ]);
}

const v23 = (frames: [string, Uint8Array][], flags = 0) =>
  tag(3, frames.map(([id, body]) => frame(id, body, plainSize)), flags);

const v24 = (frames: [string, Uint8Array][], flags = 0) =>
  tag(4, frames.map(([id, body]) => frame(id, body, synchsafeSize)), flags);

describe('parseID3, ID3v2 text', () => {
  it('reads the fields a library list is built from', () => {
    const tags = parseID3(
      v23([
        ['TIT2', textBody('Paranoid Android')],
        ['TPE1', textBody('Radiohead')],
        ['TPE2', textBody('Radiohead')],
        ['TALB', textBody('OK Computer')],
        ['TRCK', textBody('2/12')],
        ['TYER', textBody('1997')],
      ]),
    );
    assert.equal(tags.title, 'Paranoid Android');
    assert.equal(tags.artist, 'Radiohead');
    assert.equal(tags.albumArtist, 'Radiohead');
    assert.equal(tags.album, 'OK Computer');
    assert.equal(tags.track, 2, 'the disc position, not the "2/12" it is written as');
    assert.equal(tags.year, 1997);
  });

  it('decodes UTF-16 with a byte order mark', () => {
    const tags = parseID3(v23([['TIT2', utf16Body('Björk: Jóga')]]));
    assert.equal(tags.title, 'Björk: Jóga');
  });

  it('takes the year from the front of a full 2.4 date', () => {
    const tags = parseID3(v24([['TDRC', textBody('2016-09-30T12:00')]]));
    assert.equal(tags.year, 2016);
  });

  it('reads the iTunes advisory both ways round', () => {
    const advisory = (value: string) =>
      Uint8Array.from([0x00, ...latin1('ITUNESADVISORY'), 0x00, ...latin1(value)]);
    assert.equal(parseID3(v23([['TXXX', advisory('1')]])).explicitStatus, 'explicit');
    assert.equal(parseID3(v23([['TXXX', advisory('2')]])).explicitStatus, 'clean');
    assert.equal(
      parseID3(v23([['TXXX', advisory('0')]])).explicitStatus,
      undefined,
      'zero is a record nobody rated, not a clean one',
    );
  });
});

describe('parseID3, the cover', () => {
  /** An APIC frame: encoding, mime, a picture type, a description, the bytes. */
  function picture(mime: string, bytes: number[], description = ''): Uint8Array {
    return Uint8Array.from([
      0x00,
      ...latin1(mime),
      0x00,
      0x03,
      ...latin1(description),
      0x00,
      ...bytes,
    ]);
  }

  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03];

  it('comes back as its mime type and the bytes that went in', () => {
    const tags = parseID3(
      v23([
        ['TIT2', textBody('A song')],
        ['APIC', picture('image/jpeg', jpeg)],
      ]),
    );
    assert.equal(tags.coverMime, 'image/jpeg');
    assert.deepEqual(
      [...base64ToUint8(tags.coverBase64 as string)],
      jpeg,
      'the round trip through base64 is the one the phone does',
    );
  });

  it('skips a frame holding a link instead of a picture', () => {
    const tags = parseID3(
      v23([
        ['TIT2', textBody('A song')],
        ['APIC', picture('-->', [...latin1('http://example.com/a.jpg')])],
      ]),
    );
    assert.equal(tags.coverMime, undefined, 'there is nothing in a link to draw');
    assert.equal(tags.coverBase64, undefined);
  });
});

describe('parseID3, the tags encoders get wrong', () => {
  // The bug in #141, and the reason the parser forgives at all: a 2.4 tag whose
  // writer spelled its frame sizes the 2.3 way. Read as synchsafe, a size over
  // 127 lands the walk in the middle of the frame, and everything past it is
  // lost. It has to be over 127 to be a case at all: below that the two
  // spellings are the same bytes.
  it('reads a 2.4 frame whose size was written the 2.3 way', () => {
    const title = 'A'.repeat(200);
    const body = textBody(title);
    assert.ok(body.length > 127, 'the case only exists above 127 bytes');
    const misspelled = tag(4, [frame('TIT2', body, plainSize)]);
    assert.equal(parseID3(misspelled).title, title);
  });

  // A tag can be unsynchronised as a whole, which 2.3 does by writing 00 after
  // every FF. Undoing it has to happen before the frames are walked, or every
  // offset past the first FF 00 is wrong.
  it('undoes the unsynchronisation of a whole 2.3 tag', () => {
    const cover = [0xff, 0xd8, 0xff, 0xe0, 0x05];
    const apic = Uint8Array.from([0x00, ...latin1('image/jpeg'), 0x00, 0x03, 0x00, ...cover]);
    const frames = [frame('TIT2', textBody('Loud'), plainSize), frame('APIC', apic, plainSize)];
    const raw = frames.reduce<number[]>((all, f) => [...all, ...f], []);
    // Every FF grows a 00 behind it, which is what the flag says was done.
    const stuffed = raw.flatMap((byte) => (byte === 0xff ? [0xff, 0x00] : [byte]));
    const unsynced = Uint8Array.from([
      ...latin1('ID3'),
      3,
      0,
      0x80,
      ...synchsafeSize(stuffed.length),
      ...stuffed,
    ]);
    const tags = parseID3(unsynced);
    assert.equal(tags.title, 'Loud', 'the frame after the stuffed bytes is still found');
    assert.deepEqual([...base64ToUint8(tags.coverBase64 as string)], cover);
  });

  it('says which frame was cut when the tag was only half read', () => {
    const whole = v23([
      ['TIT2', textBody('A song')],
      ['APIC', Uint8Array.from([0x00, ...latin1('image/jpeg'), 0x00, 0x03, 0x00, ...jpegish()])],
    ]);
    // What the first scan pass reads: the header and the text, and the picture
    // left behind (see `readTags` in localLibrary).
    const cut = whole.subarray(0, whole.length - 40);
    const tags = parseID3(cut);
    assert.equal(tags.title, 'A song', 'what did fit is still read');
    assert.equal(tags.cutFrame, 'APIC', 'and the caller is told what to come back for');
  });

  function jpegish(): number[] {
    return Array.from({ length: 60 }, (_, i) => (i % 251) + 1);
  }
});

describe('parseID3, ID3v1 at the end of the file', () => {
  /** The last 128 bytes: TAG, then fixed-width fields with no terminators. */
  function v1({ title = '', artist = '', album = '', year = '', track = 0 }): Uint8Array {
    const out = new Uint8Array(128);
    out.set(latin1('TAG'), 0);
    out.set(latin1(title.slice(0, 30)), 3);
    out.set(latin1(artist.slice(0, 30)), 33);
    out.set(latin1(album.slice(0, 30)), 63);
    out.set(latin1(year.slice(0, 4)), 93);
    // ID3v1.1 keeps the track in the last byte of the comment, behind a zero.
    if (track > 0) out[126] = track;
    return out;
  }

  it('is read when there is no ID3v2 tag at all', () => {
    const file = new Uint8Array(1024);
    file.set(v1({ title: 'Teen Age Riot', artist: 'Sonic Youth', year: '1988', track: 1 }), 896);
    const tags = parseID3(file);
    assert.equal(tags.title, 'Teen Age Riot');
    assert.equal(tags.artist, 'Sonic Youth');
    assert.equal(tags.year, 1988);
    assert.equal(tags.track, 1);
  });

  // `parseID3` returns the v2 tag whole the moment it has a title, so a v1 tag
  // behind it is not read at all. That is the rule and this pins it: a file
  // with a v2 title and a v1 artist keeps the title and has no artist. Merging
  // the two would be a kinder answer, and it is deliberately not what happens,
  // so changing it should be a change somebody meant to make.
  it('ignores a v1 tag entirely once v2 has found a title', () => {
    const head = v23([['TIT2', textBody('The real title')]]);
    const file = new Uint8Array(1024);
    file.set(head, 0);
    file.set(v1({ title: 'The stale one', artist: 'Somebody' }), 896);
    const tags = parseID3(file);
    assert.equal(tags.title, 'The real title');
    assert.equal(tags.artist, undefined);
  });

  it('merges v1 in when the v2 tag has no title to offer', () => {
    const head = v23([['TPE2', textBody('An album artist')]]);
    const file = new Uint8Array(1024);
    file.set(head, 0);
    file.set(v1({ title: 'From v1', artist: 'Also from v1' }), 896);
    const tags = parseID3(file);
    assert.equal(tags.title, 'From v1');
    assert.equal(tags.artist, 'Also from v1');
    assert.equal(tags.albumArtist, 'An album artist', 'and v2 keeps what it did have');
  });
});

describe('parseID3, what it refuses to throw on', () => {
  // It runs over every file of a local library during a scan, so anything it
  // cannot make sense of has to come back empty rather than stop the scan.
  it('answers nothing for input that is not a tag', () => {
    for (const input of [
      new Uint8Array(0),
      new Uint8Array(4),
      latin1('ID3'),
      latin1('not a tag at all'),
      Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256),
    ]) {
      assert.deepEqual(parseID3(input), {}, `${input.length} bytes`);
    }
  });

  it('stops at the padding instead of reading it as frames', () => {
    const withPadding = Uint8Array.from([...v23([['TIT2', textBody('A song')]]), ...new Uint8Array(64)]);
    assert.equal(parseID3(withPadding).title, 'A song');
  });
});
