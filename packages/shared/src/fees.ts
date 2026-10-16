/**
 * A launch's two fees as the site shows them and the chain holds them (docs/companions.md). The
 * launcher's **creator fee** and the **companion fee** (the companion's pot's) are, on chain, one
 * `creatorFeeBps` (their sum) and the companion's split of each claim: `split.beneficiaryBps` the
 * launcher's part, the rest the companion's (`potBps`, or buyback and holders). The same rounding as
 * the launch form (`splitForRows` / `rowsOfSplit` in apps/web/src/components/launch/companion.ts).
 */
import type { CompanionSplitBps } from './api.ts';

/** A launch's two fees, basis points of each trade. */
export interface LaunchFees {
  /** The launcher's creator fee. */
  creatorFeeBps: number;
  /** The companion fee (to its pot, or buyback and holders). */
  companionFeeBps: number;
}

/** The companion's parts of its own fee, basis points of 10,000 of it (default: all to the pot). */
export interface CompanionFeeParts {
  potBps: number;
  buybackBps: number;
  holdersBps: number;
}

/** The launcher's share of the whole fee, basis points of it, rounded (10,000 with no fee). */
export const launcherShareOfFees = (f: LaunchFees): number => {
  const total = f.creatorFeeBps + f.companionFeeBps;
  return total === 0 ? 10_000 : Math.round((f.creatorFeeBps / total) * 10_000);
};

/**
 * "Creator fee X, companion fee Y" as the launch sends it: `creatorFeeBps` (X + Y) and the
 * companion's split (`beneficiaryBps` the launcher's share rounded, the rest to the parts in the
 * proportions given, the last part taking the rounding) with its `potBps`.
 */
export function feeSplitOf(fees: LaunchFees, parts: CompanionFeeParts = { potBps: 10_000, buybackBps: 0, holdersBps: 0 }): { creatorFeeBps: number; split: CompanionSplitBps; potBps: number } {
  const beneficiaryBps = launcherShareOfFees(fees);
  const rest = 10_000 - beneficiaryBps;
  const on = (['potBps', 'buybackBps', 'holdersBps'] as const).filter((k) => parts[k] > 0);
  const out: CompanionFeeParts = { potBps: 0, buybackBps: 0, holdersBps: 0 };
  let left = rest;
  on.forEach((k, i) => {
    const v = i === on.length - 1 ? left : Math.round((rest * parts[k]) / 10_000);
    out[k] = v;
    left -= v;
  });
  return { creatorFeeBps: fees.creatorFeeBps + fees.companionFeeBps, split: { buybackBps: out.buybackBps, holdersBps: out.holdersBps, beneficiaryBps }, potBps: out.potBps };
}

/** The way back: a launch's `creatorFeeBps` and its companion's `beneficiaryBps` as the two fees (the creator fee rounded). No companion: pass 10,000. */
export const feesOfSplit = (creatorFeeBps: number, beneficiaryBps: number): LaunchFees => {
  const creator = Math.round((beneficiaryBps * creatorFeeBps) / 10_000);
  return { creatorFeeBps: creator, companionFeeBps: creatorFeeBps - creator };
};

/** The companion program's `AUTHOR_SHARE_BPS`: a script's author gets half of the launcher's part. */
export const SCRIPT_AUTHOR_SHARE_BPS = 5_000;

const bpsOf = (amount: bigint, part: bigint): bigint => (amount * part) / 10_000n;
const sat = (v: bigint): bigint => (v < 0n ? 0n : v);

/**
 * What a fee claim pays a script's author, lamports, as the companion's `process_claim_fees`
 * (bordrless-programs `b91b673`): half of the launcher's part of the creator fee the claim took,
 * `bps(bps(feeTaken - hookCut, beneficiaryBps), 5000)` (each rounded down), capped at the
 * launcher's part of the claim (`toBeneficiary`). `feeTaken` is what the claim moved from the launch
 * (the creator address's balance after less before), `hookCut` the hook's SOL cut in this claim.
 * `toBeneficiary` is the claim's beneficiary part before the author's share; omit it to have it
 * computed from `claim` (`got`: the claim above the set-aside, `bountyBps`), or uncapped with neither.
 * Pays nothing to no author, the beneficiary itself or an author no transfer can pay (not checked here).
 */
export function scriptAuthorShare(feeTaken: bigint, hookCut: bigint, beneficiaryBps: number, toBeneficiary?: bigint | { got: bigint; bountyBps: number }): bigint {
  const share = bpsOf(bpsOf(sat(feeTaken - hookCut), BigInt(beneficiaryBps)), BigInt(SCRIPT_AUTHOR_SHARE_BPS));
  if (toBeneficiary === undefined) return share;
  const cap = typeof toBeneficiary === 'bigint' ? toBeneficiary : claimBeneficiaryPart(toBeneficiary.got, hookCut, toBeneficiary.bountyBps, beneficiaryBps);
  return share < cap ? share : cap;
}

/** A claim's beneficiary part before the author's share, as `process_claim_fees`: the claim less its bounty (of the whole), less the hook's part of what is left (`rest * hookCut / got`, rounded down), at `beneficiaryBps`. */
export function claimBeneficiaryPart(got: bigint, hookCut: bigint, bountyBps: number, beneficiaryBps: number): bigint {
  if (got <= 0n) return 0n;
  const hookGross = hookCut < got ? hookCut : got;
  const rest = got - bpsOf(got, BigInt(bountyBps));
  const base = rest - (rest * hookGross) / got;
  return bpsOf(base, BigInt(beneficiaryBps));
}
