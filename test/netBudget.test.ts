/** The budget for speculative requests (src/lib/netBudget.ts). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { speculativeSlots } from '@/lib/netBudget';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('speculativeSlots', () => {
  it('lets four at a time out, and holds a fifth waiting', async () => {
    const started: number[] = [];
    for (const n of [1, 2, 3, 4, 5]) void speculativeSlots.take().then(() => started.push(n));
    await tick();
    // The fifth is the one the app has left free: a cover the mirror is saving,
    // or the track ahead of the one playing, never takes it.
    assert.deepEqual(started, [1, 2, 3, 4]);
    speculativeSlots.release();
    await tick();
    assert.deepEqual(started, [1, 2, 3, 4, 5]);
    // Four are still holding (the one that freed its slot handed it straight to
    // the fifth), and letting go of those leaves the pool as it started.
    for (let n = 0; n < 4; n += 1) speculativeSlots.release();
  });
});
