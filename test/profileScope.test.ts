/**
 * The guard that keeps a profile's data from being read as another's:
 * of two overlapping reads only the last one started may land, and a
 * write only reaches the key the state in memory came from.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { profileScopeGuard } from '@/lib/profileScope';

describe('profileScopeGuard', () => {
  it('owns nothing before a read has landed', () => {
    const guard = profileScopeGuard();
    assert.equal(guard.owns('resonus.x.a'), false);
  });

  it('accepts the only read in flight and then owns its key', () => {
    const guard = profileScopeGuard();
    const token = guard.start();
    assert.equal(guard.accept(token, 'resonus.x.a'), true);
    assert.equal(guard.owns('resonus.x.a'), true);
  });

  it('hands out increasing tokens', () => {
    const guard = profileScopeGuard();
    const first = guard.start();
    const second = guard.start();
    assert.ok(second > first);
  });

  it('discards the earlier of two overlapping reads, whichever lands first', () => {
    const guard = profileScopeGuard();
    const stale = guard.start();
    const fresh = guard.start();
    assert.equal(guard.accept(stale, 'resonus.x.a'), false, 'the slower, older read is refused');
    assert.equal(guard.owns('resonus.x.a'), false, 'and it does not claim its key');
    assert.equal(guard.accept(fresh, 'resonus.x.b'), true);
    assert.equal(guard.owns('resonus.x.b'), true);
  });

  it('refuses a stale read even after the current one has landed', () => {
    const guard = profileScopeGuard();
    const stale = guard.start();
    const fresh = guard.start();
    guard.accept(fresh, 'resonus.x.b');
    assert.equal(guard.accept(stale, 'resonus.x.a'), false);
    assert.equal(guard.owns('resonus.x.b'), true, 'the owner is unchanged');
  });

  it('stops owning the old key the moment a new read starts and lands', () => {
    const guard = profileScopeGuard();
    guard.accept(guard.start(), 'resonus.x.a');
    const next = guard.start();
    assert.equal(guard.owns('resonus.x.a'), true, 'still owned while the new read is in flight');
    guard.accept(next, 'resonus.x.b');
    assert.equal(guard.owns('resonus.x.a'), false);
    assert.equal(guard.owns('resonus.x.b'), true);
  });

  it('keeps every guard to itself', () => {
    const one = profileScopeGuard();
    const two = profileScopeGuard();
    one.accept(one.start(), 'resonus.x.a');
    assert.equal(two.owns('resonus.x.a'), false);
  });
});
