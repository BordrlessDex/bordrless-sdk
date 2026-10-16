import { describe, expect, it } from 'vitest';
import { SCRIPT_PAYOUT_OPEN, claimBeneficiaryPart, feeSplitOf, feesOfSplit, launcherShareOfFees, scriptAuthorShare } from './index.ts';

describe('feeSplitOf / feesOfSplit', () => {
  it('sums the fees and splits as the launch form', () => {
    expect(feeSplitOf({ creatorFeeBps: 50, companionFeeBps: 100 })).toEqual({ creatorFeeBps: 150, split: { buybackBps: 0, holdersBps: 0, beneficiaryBps: 3_333 }, potBps: 6_667 });
    expect(feeSplitOf({ creatorFeeBps: 100, companionFeeBps: 100 }, { potBps: 0, buybackBps: 5_000, holdersBps: 5_000 })).toEqual({ creatorFeeBps: 200, split: { buybackBps: 2_500, holdersBps: 2_500, beneficiaryBps: 5_000 }, potBps: 0 });
    expect(launcherShareOfFees({ creatorFeeBps: 0, companionFeeBps: 0 })).toBe(10_000);
  });
  it('reads the fees back', () => {
    expect(feesOfSplit(150, 3_333)).toEqual({ creatorFeeBps: 50, companionFeeBps: 100 });
    expect(feesOfSplit(200, 10_000)).toEqual({ creatorFeeBps: 200, companionFeeBps: 0 });
    for (const [c, p] of [[50, 50], [100, 50], [200, 200], [0, 100], [300, 200]] as const) {
      const s = feeSplitOf({ creatorFeeBps: c, companionFeeBps: p });
      expect(feesOfSplit(s.creatorFeeBps, s.split.beneficiaryBps)).toEqual({ creatorFeeBps: c, companionFeeBps: p });
    }
  });
});

describe('scriptAuthorShare', () => {
  it('is half of the launcher part of the fee taken, rounded down at each step', () => {
    expect(scriptAuthorShare(1_000_001n, 1n, 3_333)).toBe(166_650n);
    expect(scriptAuthorShare(100n, 200n, 5_000)).toBe(0n);
  });
  it('is capped at the claim beneficiary part', () => {
    expect(scriptAuthorShare(1_000n, 0n, 10_000, 100n)).toBe(100n);
    // got 1,000, 1% bounty, hook cut 100: rest 990, from the hook 99, base 891, half of it 445.
    expect(claimBeneficiaryPart(1_000n, 100n, 100, 5_000)).toBe(445n);
    expect(scriptAuthorShare(1_100n, 100n, 5_000, { got: 1_000n, bountyBps: 100 })).toBe(250n);
    expect(scriptAuthorShare(10_000n, 0n, 5_000, { got: 1_000n, bountyBps: 0 })).toBe(500n);
  });
});

it('SCRIPT_PAYOUT_OPEN is open', () => {
  expect(SCRIPT_PAYOUT_OPEN).toEqual({ stepBps: 10_000, holdingBps: 10_000, windowBps: 10_000, windowSecs: 10 });
});
