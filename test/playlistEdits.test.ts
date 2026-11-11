/** Whose playlist a hand may rewrite. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isEditable, isMine } from '@/lib/playlistEdits';

/** A list, written out with only the fields the rule reads. */
function list(owner?: string, readonly?: boolean): { id: string; name: string; owner?: string; readonly?: boolean } {
  return { id: '1', name: 'a list', owner, readonly };
}

describe('isMine', () => {
  it('counts a list whose server says nothing about the owner as yours', () => {
    assert.equal(isMine(list(), 'demo'), true);
    assert.equal(isMine(list(), undefined), true);
  });

  it('counts a list whose owner is the one you signed in as as yours', () => {
    assert.equal(isMine(list('demo'), 'demo'), true);
  });

  it("does not count a list somebody else owns as yours, once you or your absence says so", () => {
    assert.equal(isMine(list('admin'), 'demo'), false);
    assert.equal(isMine(list('admin'), undefined), false);
  });

  it('counts nothing loaded yet as yours', () => {
    assert.equal(isMine(undefined, 'demo'), true);
  });
});

describe('isEditable', () => {
  it('refuses a list the server says cannot be edited, yours or not', () => {
    assert.equal(isEditable(list('demo', true), 'demo'), false);
    assert.equal(isEditable(list('admin', true), 'demo'), false);
  });

  it('refuses a list somebody else owns when the server says nothing else', () => {
    assert.equal(isEditable(list('admin'), 'demo'), false);
  });

  it('accepts a list you own that the server does not object to', () => {
    assert.equal(isEditable(list('demo'), 'demo'), true);
    assert.equal(isEditable(list(), undefined), true);
    assert.equal(isEditable(undefined, undefined), true);
  });
});
