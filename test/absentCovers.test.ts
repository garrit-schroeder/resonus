/**
 * Navidrome 0.64 leaving `coverArt` out of items with no artwork, and the mark
 * that stops the app asking for Navidrome's placeholder in its place.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { markAbsentCovers, omitsAbsentCovers } from '@/lib/absentCovers';

const cover = (item: object) => (item as { coverArt?: string }).coverArt;

describe('Absent covers', () => {
  it('trusts only Navidrome, and only from 0.64', () => {
    assert.equal(omitsAbsentCovers({ type: 'navidrome', serverVersion: '0.64.0 (4d5f2e1)' }), true);
    assert.equal(omitsAbsentCovers({ type: 'navidrome', serverVersion: '1.0.0' }), true);
    assert.equal(omitsAbsentCovers({ type: 'navidrome', serverVersion: '0.63.2 (a1b2c3d)' }), false);
    assert.equal(omitsAbsentCovers({ type: 'navidrome' }), false);
    assert.equal(omitsAbsentCovers({ type: 'gonic', serverVersion: '0.70.0' }), false);
  });

  it('marks the items that came without coverArt and nothing else', () => {
    const artistRef = { id: 'r1', name: 'Someone' };
    const withArt = { id: 's1', coverArt: 'mf-s1_x', artists: [artistRef], replayGain: { trackGain: -3 } };
    const noArt = { id: 's2' };
    const station = { id: 'ra1', name: 'Radio' };
    const sub = {
      albumList2: { album: [{ id: 'a1', coverArt: 'al-a1_x' }, { id: 'a2' }] },
      album: { id: 'a3', song: [withArt, noArt] },
      artists: { index: [{ name: 'S', artist: [{ id: 'r2' }, { id: 'r3', coverArt: 'ar-r3_x' }] }] },
      playlist: { id: 'p1', entry: [{ id: 's3' }] },
      internetRadioStations: { internetRadioStation: [station] },
    };
    markAbsentCovers(sub);
    assert.equal(cover(sub.albumList2.album[0]), 'al-a1_x');
    assert.equal(cover(sub.albumList2.album[1]), '');
    assert.equal(cover(sub.album), '');
    assert.equal(cover(withArt), 'mf-s1_x');
    assert.equal(cover(noArt), '');
    assert.equal(cover(sub.artists.index[0].artist[0]), '');
    assert.equal(cover(sub.artists.index[0].artist[1]), 'ar-r3_x');
    assert.equal(cover(sub.playlist), '');
    assert.equal(cover(sub.playlist.entry[0]), '');
    // Not items with a cover of their own: a song's artist reference, its
    // ReplayGain block, a radio station.
    assert.equal(cover(artistRef), undefined);
    assert.equal(cover(withArt.replayGain), undefined);
    assert.equal(cover(station), undefined);
  });
});
