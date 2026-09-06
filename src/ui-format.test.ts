import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCountdown, getGlobalRankText } from './ui-format';

describe('daily challenge formatting', () => {
  it('formats a UTC countdown as hh:mm:ss', () => {
    assert.equal(formatCountdown(4 * 60 * 60 + 32 * 60 + 18), '04:32:18');
  });

  it('builds a leaderboard status for a player slightly behind the leader', () => {
    assert.equal(getGlobalRankText(17, 84), '#17 GLOBAL');
    assert.equal(getGlobalRankText(17, 84, true), '#16 is only 84 points away.');
  });
});
