import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { holdSpeculation, releaseSpeculation, speculationOpen } from '@/lib/speculation';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('speculation gate', () => {
  afterEach(() => releaseSpeculation());

  it('lets everything through when nothing holds it', async () => {
    await speculationOpen();
  });

  it('keeps a request waiting until the hold is released', async () => {
    const hold = holdSpeculation();
    let through = false;
    void speculationOpen().then(() => (through = true));
    await tick();
    assert.equal(through, false);
    releaseSpeculation(hold);
    await tick();
    assert.equal(through, true);
  });

  it('does not let an older tap open the hold of a newer one', async () => {
    const first = holdSpeculation();
    holdSpeculation();
    let through = false;
    void speculationOpen().then(() => (through = true));
    releaseSpeculation(first);
    await tick();
    assert.equal(through, false);
    releaseSpeculation();
    await tick();
    assert.equal(through, true);
  });
});
