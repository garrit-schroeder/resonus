import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Song } from '@/api/subsonic';
import {
  canEditTracks,
  indicesToRemove,
  membershipOf,
  missingFrom,
  needsFetch,
  presentIn,
} from '@/lib/playlistMembership';

const song = (id: string) => ({ id }) as Song;

test('a repeated track counts once', () => {
  const present = presentIn(['a', 'b', 'a'], ['a']);
  assert.deepEqual(present, ['a']);
  assert.equal(membershipOf(present, ['a']), 'all');
});

test('a batch can be none, some or all in', () => {
  assert.equal(membershipOf(presentIn(['x'], ['a', 'b']), ['a', 'b']), 'none');
  assert.equal(membershipOf(presentIn(['a'], ['a', 'b']), ['a', 'b']), 'some');
  assert.equal(membershipOf(presentIn(['b', 'a'], ['a', 'b', 'a']), ['a', 'b', 'a']), 'all');
});

test('adding skips what is there and repeats in the batch', () => {
  const ids = missingFrom(['a'], [song('a'), song('b'), song('b')]).map((s) => s.id);
  assert.deepEqual(ids, ['b']);
});

test('removal takes every copy, last first', () => {
  assert.deepEqual(indicesToRemove(['a', 'b', 'a', 'c', 'a'], ['a']), [4, 2, 0]);
  assert.deepEqual(indicesToRemove(['b'], ['a']), []);
});

test('a stored tracklist is fetched only when absent or changed', () => {
  assert.equal(needsFetch({ id: 'p' }, {}), true);
  assert.equal(needsFetch({ id: 'p' }, { p: undefined }), false);
  assert.equal(needsFetch({ id: 'p', changed: '2' }, { p: '1' }), true);
  assert.equal(needsFetch({ id: 'p', changed: '1' }, { p: '1' }), false);
});

test('only editable playlists are targets', () => {
  assert.equal(canEditTracks({}, undefined), true);
  assert.equal(canEditTracks({ owner: 'me' }, 'me'), true);
  assert.equal(canEditTracks({ owner: 'them' }, 'me'), false);
  assert.equal(canEditTracks({ owner: 'me', readonly: true }, 'me'), false);
});
