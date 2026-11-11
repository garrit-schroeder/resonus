/** What a row's travel does to a list's order. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyDrag } from '@/lib/listOrder';

const rows = ['a', 'b', 'c', 'd', 'e'];

describe('applyDrag', () => {
  it('moves a row down to the place the finger left it', () => {
    assert.deepEqual(applyDrag(rows, 0, 2), ['b', 'c', 'a', 'd', 'e']);
  });

  it('moves a row up to the place the finger left it', () => {
    assert.deepEqual(applyDrag(rows, 4, 1), ['a', 'e', 'b', 'c', 'd']);
  });

  it('leaves the order alone when the row was released where it came down', () => {
    assert.deepEqual(applyDrag(rows, 2, 2), rows);
  });

  it('lands a row dropped past the ends on the end it went past', () => {
    assert.deepEqual(applyDrag(rows, 0, 9), ['b', 'c', 'd', 'e', 'a']);
    assert.deepEqual(applyDrag(rows, 4, -3), ['e', 'a', 'b', 'c', 'd']);
  });

  it('leaves the order alone when nothing was lifted to move', () => {
    assert.deepEqual(applyDrag(rows, -1, 2), rows);
    assert.deepEqual(applyDrag(rows, 5, 2), rows);
    assert.deepEqual(applyDrag([] as string[], 0, 0), []);
  });

  it('keeps the other rows in their relative order, including a repeated row', () => {
    // The same song twice in a playlist is two rows, and moving one of them
    // must not take its twin with it: rows are keyed by place, not by the song.
    const doubled = [{ id: 's', at: 0 }, { id: 't', at: 1 }, { id: 's', at: 2 }];
    const moved = applyDrag(doubled, 0, 2);
    assert.deepEqual(moved.map((r) => `${r.id}${r.at}`), ['t1', 's2', 's0']);
  });

  it('does not touch the list it was handed', () => {
    const source = [...rows];
    assert.deepEqual(applyDrag(source, 1, 3), ['a', 'c', 'd', 'b', 'e']);
    assert.deepEqual(source, rows);
  });
});
