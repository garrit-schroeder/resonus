/** Where a podcast episode picks up (src/lib/episodeResume.ts). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { episodePlayed, episodeResumeAt } from '@/lib/episodeResume';

describe('episodeResumeAt', () => {
  it('resumes in the middle', () => {
    assert.equal(episodeResumeAt(1200, 3600), 1200);
  });

  it('starts over when barely begun', () => {
    assert.equal(episodeResumeAt(3, 3600), 0);
  });

  it('starts over when finished', () => {
    assert.equal(episodeResumeAt(3580, 3600), 0);
    assert.equal(episodeResumeAt(3600, 3600), 0);
  });

  it('resumes when the length is unknown', () => {
    assert.equal(episodeResumeAt(1200, 0), 1200);
  });
});

describe('episodePlayed', () => {
  it('is played near the end only', () => {
    assert.equal(episodePlayed(3580, 3600), true);
    assert.equal(episodePlayed(1200, 3600), false);
  });

  it('holds for one marked by hand with no known length', () => {
    assert.equal(episodePlayed(1, 1), true);
  });

  it('is not played when the length is unknown', () => {
    assert.equal(episodePlayed(1200, 0), false);
  });
});
