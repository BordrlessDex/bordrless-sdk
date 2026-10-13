/** A Lossback coin in a launch request (docs/loss-cover.md): read from `companion.lossCover`, held to the policy's bounds in the launch form's words, the full terms from the defaults. */
import { describe, expect, it } from 'vitest';
import { LOSS_COVER_DEFAULTS, LOSS_COVER_LIMITS, NO_RULES, TOKEN_SUPPLY, lossCoverPotBps, lossCoverProblem, lossCoverRequestOf, lossCoverSentence, lossCoverTermsOf } from './policy.ts';
import { LOSS_COVER_HOOK, LOSS_COVER_SCRIPT, PROGRAM_IDS, lossCoverFeeChoices } from './programs.ts';

const split = { buybackBps: 0, holdersBps: 0, beneficiaryBps: 0 };
const request = { roundSecs: 300, minPotLamports: '1000000000', coverBps: 10_000, minHolding: '100000000000' };

describe('lossCoverRequestOf', () => {
  it('reads the terms, absent or malformed', () => {
    expect(lossCoverRequestOf({ split })).toBeNull();
    expect(lossCoverRequestOf({ split, lossCover: null })).toBeNull();
    expect(lossCoverRequestOf('x')).toBeNull();
    expect(lossCoverRequestOf({ split, lossCover: request })).toEqual(request);
    for (const bad of [{ ...request, roundSecs: '300' }, { ...request, roundSecs: 1.5 }, { ...request, coverBps: 10_001 }, { ...request, coverBps: -1 }, { ...request, minPotLamports: 7 }, { ...request, minPotLamports: '1e9' }, { ...request, minHolding: '' }, 'lossCover']) {
      expect(lossCoverRequestOf({ split, lossCover: bad }), JSON.stringify(bad)).toBe('malformed');
    }
  });
});

describe('lossCoverProblem', () => {
  it('takes the defaults at every offered fee, with the launcher’s part at 0 or above', () => {
    expect(lossCoverProblem(request, split, NO_RULES, 100)).toBeNull();
    expect(lossCoverProblem(request, { ...split, beneficiaryBps: 5_000 }, NO_RULES, 200)).toBeNull();
    expect(lossCoverPotBps(split)).toBe(10_000);
    expect(lossCoverPotBps({ ...split, beneficiaryBps: 5_000 })).toBe(5_000);
  });

  it('refuses what the programs or the policy would', () => {
    expect(lossCoverProblem(request, split, NO_RULES, 0)).toMatch(/creator fee/);
    expect(lossCoverProblem(request, split, { ...NO_RULES, burnBuyBps: 25 }, 100)).toMatch(/no other token rules/);
    expect(lossCoverProblem(request, { ...split, buybackBps: 1_000 }, NO_RULES, 100)).toMatch(/nothing bought back/);
    expect(lossCoverProblem(request, { ...split, beneficiaryBps: 10_000 }, NO_RULES, 100)).toMatch(/part for the pot/);
    expect(lossCoverProblem({ ...request, roundSecs: 59 }, split, NO_RULES, 100)).toMatch(/minute to a day/);
    expect(lossCoverProblem({ ...request, roundSecs: 86_401 }, split, NO_RULES, 100)).toMatch(/minute to a day/);
    expect(lossCoverProblem({ ...request, coverBps: 999 }, split, NO_RULES, 100)).toMatch(/10% to 100%/);
    expect(lossCoverProblem({ ...request, minHolding: '0' }, split, NO_RULES, 100)).toMatch(/least holding/);
    expect(lossCoverProblem({ ...request, minHolding: ((TOKEN_SUPPLY * 101n) / 10_000n).toString() }, split, NO_RULES, 100)).toMatch(/least holding/);
    expect(lossCoverProblem({ ...request, minHolding: ((TOKEN_SUPPLY * 100n) / 10_000n).toString() }, split, NO_RULES, 100)).toBeNull();
    expect(lossCoverProblem({ ...request, minPotLamports: '100000000001' }, split, NO_RULES, 100)).toMatch(/at most 100 SOL/);
    expect(lossCoverProblem({ ...request, minPotLamports: '0' }, split, NO_RULES, 100)).toBeNull();
    // The creator wallet lock is a token rule: refused with the others.
    expect(lossCoverProblem(request, split, { ...NO_RULES, creatorLockDays: 7 }, 100)).toMatch(/no other token rules/);
  });

  it('keeps the step at most a quarter of the round', () => {
    expect(LOSS_COVER_DEFAULTS.stepSecs * LOSS_COVER_LIMITS.stepsPerRoundMin).toBeLessThanOrEqual(LOSS_COVER_LIMITS.minRoundSecs);
    expect(LOSS_COVER_DEFAULTS.stepSecs).toBeGreaterThanOrEqual(LOSS_COVER_LIMITS.minStepSecs);
  });
});

describe('the terms and the sentence', () => {
  it('fill the rest from the defaults', () => {
    expect(lossCoverTermsOf(request)).toEqual({ roundSecs: 300, stepSecs: 15, stepBps: 10_000, holdingBps: 10_000, roundBps: 10_000, coverBps: 10_000, minHolding: '100000000000', minLossLamports: '1000000', minAgeSecs: 60, minPotLamports: '1000000000' });
    expect(lossCoverSentence(request)).toBe('Every 5 minutes, once the pot holds 1 SOL, it pays every holder under water the same share of what they are down, as much as the pot allows, in steps of 15 seconds; a holding counts from 100,000 tokens and 0.001 SOL of loss, 1 minute after it bought.');
    expect(lossCoverSentence({ ...request, minPotLamports: '0', coverBps: 5_000 })).toMatch(/^Every 5 minutes it pays every holder under water the same share of 50% of what they are down/);
  });

  it('names the programs by the keypairs’ public keys', () => {
    expect(LOSS_COVER_HOOK.program).toBe(PROGRAM_IDS.lossCoverHook);
    expect(LOSS_COVER_SCRIPT.program).toBe(PROGRAM_IDS.lossCoverScript);
    expect(LOSS_COVER_HOOK.flags).toBe(145);
    expect(LOSS_COVER_SCRIPT.stateLen).toBe(128);
    expect(lossCoverFeeChoices()).toEqual([50, 100, 200]);
  });
});
