import { describe, expect, it } from 'vitest';
import { keeperLaunchTerms, withLauncherShare } from './keeper.ts';
import { FEE_STEP_BPS, WORKSHOP_CONFIG_FEE_WORDS, pairFeeParts, workshopConfigFeeOk } from './workshop.ts';

describe('a Workshop config’s creator fee', () => {
  it('is a whole number of quarter-percent steps, one to the launchpad’s cap', () => {
    expect(FEE_STEP_BPS).toBe(25);
    expect(WORKSHOP_CONFIG_FEE_WORDS).toBe('a whole quarter of a percent, 0.25% to 5%');
    for (const bps of [25, 50, 75, 100, 125, 150, 175, 200, 225, 475, 500]) expect(workshopConfigFeeOk(bps)).toBe(true);
    for (const bps of [0, 10, 24, 26, 60, 201, 510, 525, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(workshopConfigFeeOk(bps)).toBe(false);
  });
});

describe('the launcher’s share fixed on the config page', () => {
  it('rides with the keeper terms when keeper.json fixes none, and never over one it fixes', () => {
    const plain = keeperLaunchTerms(null);
    expect(plain.launcherShareBps).toBeNull();
    expect(withLauncherShare(plain, 2_500)).toEqual({ ...plain, launcherShareBps: 2_500 });
    expect(withLauncherShare(plain, null)).toEqual({ ...plain, launcherShareBps: null });
    expect(withLauncherShare(plain, undefined)).toEqual({ ...plain, launcherShareBps: null });
    const fixed = { ...plain, launcherShareBps: 1_000 };
    expect(withLauncherShare(fixed, 2_500)).toBe(fixed);
    expect(withLauncherShare(fixed, null)).toBe(fixed);
  });
});

describe('a pair’s fee in two parts', () => {
  it('rounds the launcher’s creator fee to the nearest bp, the companion fee the rest', () => {
    expect(pairFeeParts(200, 1_000)).toEqual({ creatorBps: 20, companionBps: 180 });
    expect(pairFeeParts(200, 5_000)).toEqual({ creatorBps: 100, companionBps: 100 });
    // A tie: the creator fee rounds half up (12.5 → 13), as the launch page reads a split back.
    expect(pairFeeParts(25, 5_000)).toEqual({ creatorBps: 13, companionBps: 12 });
    expect(pairFeeParts(150, 3_333)).toEqual({ creatorBps: 50, companionBps: 100 });
    expect(pairFeeParts(0, 5_000)).toEqual({ creatorBps: 0, companionBps: 0 });
    for (const total of [25, 75, 125, 200, 500]) for (const share of [0, 2_500, 5_000, 9_500]) {
      const parts = pairFeeParts(total, share);
      expect(parts.creatorBps + parts.companionBps).toBe(total);
    }
  });
});
