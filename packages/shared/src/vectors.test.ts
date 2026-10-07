/**
 * Every case of `vectors/launch-fees.json` (a copy of bordrless-programs'
 * `programs/tests/vectors/launch-fees.json`; copy it again whenever the programs' math changes) through the TypeScript mirror, with exact
 * equality. The file is rendered by `programs/tests/tests/vectors.rs` from the Rust reference the
 * programs are held to (`bordrless_core`, the tests' `quote_launch_swap`, `max_buy_within` and
 * `dev_buy_max`, and `bordrless_kit::mirror`), which rewrites it and fails when the math changes, so
 * this test always reads what the programs compute today. Integers that can pass 2^53 are decimal
 * strings there (`netIn` may be negative).
 *
 * The fee model changed on 2026-10-07 (Bordrless takes `LAUNCH_PROTOCOL_SHARE_BPS` of what a
 * launch's rules collect, in place of a flat 0.25%; the presets are four, Plain the default): the
 * vectors file carries `constants.launchProtocolShareBps`, a `protocolShareBps` on every swap and
 * dev-buy case, and a `presets` section since then. A file from before (no share constant) is
 * stale: this suite then skips with a note rather than compare against the old model, and the
 * programs' `cargo test -p bordrless-program-tests --test vectors` renders the new one.
 */
import { describe, expect, it } from 'vitest';
import raw from '../vectors/launch-fees.json' with { type: 'json' };
import type { LaunchRulesInput, Side } from './api.ts';
import {
  BPS,
  CURVE_BPS,
  DEFAULT_RULE_PRESET,
  LAUNCH_PROTOCOL_SHARE_BPS,
  LP_FEE_BPS,
  MAX_LAUNCH_SUPPLY,
  MIN_ELIGIBLE,
  MIN_LAUNCH_SUPPLY,
  MIN_SHARE_LAMPORTS,
  NO_RULES,
  PROTOCOL_FEE_BPS,
  RULE_BOUNDS,
  RULE_CEILINGS,
  RULE_PRESETS,
  SCALE,
  SHARE_STREAM_SECS,
  TOKEN_SUPPLY,
  buyLockedUntil,
  curveParams,
  decodeKitHookData,
  devBuyMaxLamports,
  encodeKitHookData,
  kitSettle,
  kitSync,
  kitSynced,
  launchAfterSwap,
  launchBeforeSwap,
  launchRulesAt,
  maxWalletCap,
  maxWalletLeft,
  quoteLaunchSwap,
  rewardTotals,
  rewardsClaimable,
  tradeBurn,
  type CurveParams,
  type KitRewards,
  type LaunchFeeParams,
  type Reserves,
  type RuleBounds,
} from './policy.ts';

type Int = string;

interface Params {
  creatorFeeBps: number;
  holderFeeBuyBps: number;
  holderFeeSellBps: number;
  burnBuyBps: number;
  burnSellBps: number;
  eligible: Int;
  minEligible: Int;
}

interface RawReserves {
  baseReserve: Int;
  quoteReserve: Int;
  virtualBase: Int;
  virtualQuote: Int;
}

interface Vectors {
  constants: {
    bps: Int;
    scale: Int;
    tokenSupply: Int;
    minEligible: Int;
    lpFeeBps: number;
    protocolFeeBps: number;
    /** Since 2026-10-07; a file without it is from the flat 0.25% model. */
    launchProtocolShareBps?: number;
    minLaunchSupply: Int;
    maxLaunchSupply: Int;
    shareStreamSecs: number;
    minShareLamports: Int;
    ruleBounds: RuleBounds;
    ruleCeilings: RuleBounds;
  };
  presets?: { name: string; slug: string; creatorFeeBps: number; rules: LaunchRulesInput; default: boolean }[];
  hookFees: { name: string; callback: 'beforeSwap' | 'afterSwap'; side: Side; amount: Int; params: Params; expected: { creatorFee: Int; holderFee: Int; burn: Int } }[];
  burns: { amount: Int; burnBps: number; expected: Int }[];
  swaps: {
    name: string;
    reserves: RawReserves;
    side: Side;
    amountIn: Int;
    lpFeeBps: number;
    protocolShareBps: number;
    params: Params;
    expected: { creatorFee: Int; holderFee: Int; burn: Int; holderFeeOn: boolean; received: Int; lpFee: Int; protocolFee: Int; netIn: Int; amountOut: Int | null; delivered: Int | null; failure: string | null };
  }[];
  maxWallet: { supply: Int; maxWalletBps: number; balance: Int; expected: { cap: Int; left: Int } }[];
  devBuyMax: {
    name: string;
    curve: { curveTokens: Int; reserveTokens: Int; virtualQuote: Int; virtualBase: Int; graduationQuote: Int };
    supply: Int;
    rules: LaunchRulesInput;
    creatorFeeBps: number;
    lpFeeBps: number;
    protocolShareBps: number;
    expected: Int | null;
  }[];
  earlyLock: { launchedAt: number; earlyWindowSecs: number; earlyLockSecs: number; rules: { earlyWindowEndsAt: number | null; earlyUnlockAt: number | null }; now: number; expected: number | null }[];
  rewards: {
    name: string;
    kit: {
      eligible: Int;
      minEligible: Int;
      accPerShare: Int;
      rem: Int;
      held: Int;
      seen: Int;
      streamRemaining: Int;
      streamLast: number;
      streamEnd: number;
      streamNext: Int;
      totalDistributed: Int;
      totalClaimed: Int;
      totalShared: Int;
    };
    vaultAmount: Int;
    now: number;
    balance: Int;
    hookData: { hex: string; snapshot: Int; owed: Int; earlyLocked: Int };
    excluded: boolean;
    expected: { claimable: Int; payable: Int; distributed: Int; claimed: Int; shared: Int; streaming: Int };
  }[];
}

const V = raw as unknown as Vectors;
const big = (v: Int): bigint => BigInt(v);
const optBig = (v: Int | null): bigint | null => (v === null ? null : BigInt(v));
const params = (p: Params): LaunchFeeParams => ({ ...p, eligible: big(p.eligible), minEligible: big(p.minEligible) });
const reserves = (r: RawReserves): Reserves => ({ baseReserve: big(r.baseReserve), quoteReserve: big(r.quoteReserve), virtualBase: big(r.virtualBase), virtualQuote: big(r.virtualQuote) });
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The file predates the share model (2026-10-07) when it has no share constant or no presets: its
 * swaps were quoted at a flat 0.25%, which this mirror no longer computes.
 */
const STALE = V.constants.launchProtocolShareBps === undefined || V.presets === undefined;
const STALE_NOTE = 'programs/tests/vectors/launch-fees.json predates the share model (no constants.launchProtocolShareBps / presets): the suite is skipped until `cargo test -p bordrless-program-tests --test vectors` renders it again. The TypeScript mirror follows the Rust reference of the share model.';

/** Every case whose fields differ, with what each field should have been: an empty list passes. */
function mismatches<T>(cases: readonly T[], check: (c: T) => Record<string, [unknown, unknown]>, label: (c: T, i: number) => string): string[] {
  const out: string[] = [];
  cases.forEach((c, i) => {
    for (const [field, [got, want]] of Object.entries(check(c))) {
      if (got !== want) out.push(`${label(c, i)}: ${field} is ${String(got)}, the Rust reference says ${String(want)}`);
    }
  });
  return out;
}

describe('launch-fees.json: the vectors file', () => {
  it(STALE ? `is stale: ${STALE_NOTE}` : 'carries the share model (2026-10-07): a share constant, a share on every swap and dev-buy case, and the presets', () => {
    // A stale file is reported through this test's name; the suite below is skipped.
    if (STALE) return;
    expect(V.constants.launchProtocolShareBps).toBe(LAUNCH_PROTOCOL_SHARE_BPS);
    for (const c of V.swaps) expect(typeof c.protocolShareBps).toBe('number');
    for (const c of V.devBuyMax) expect(typeof c.protocolShareBps).toBe('number');
    expect(V.presets!.length).toBe(RULE_PRESETS.length);
  });
});

describe.skipIf(STALE)('launch-fees.json: the TypeScript mirror computes exactly what the Rust reference does', () => {
  it('holds every section, each with cases', () => {
    for (const section of ['presets', 'hookFees', 'burns', 'swaps', 'maxWallet', 'devBuyMax', 'earlyLock', 'rewards'] as const) expect(V[section]!.length).toBeGreaterThan(0);
  });

  it('shares the constants', () => {
    const c = V.constants;
    expect([big(c.bps), big(c.scale), big(c.tokenSupply), big(c.minEligible)]).toEqual([BPS, SCALE, TOKEN_SUPPLY, MIN_ELIGIBLE]);
    expect([c.lpFeeBps, c.protocolFeeBps, c.launchProtocolShareBps, c.shareStreamSecs]).toEqual([LP_FEE_BPS, PROTOCOL_FEE_BPS, LAUNCH_PROTOCOL_SHARE_BPS, SHARE_STREAM_SECS]);
    expect([big(c.minLaunchSupply), big(c.maxLaunchSupply), big(c.minShareLamports)]).toEqual([MIN_LAUNCH_SUPPLY, MAX_LAUNCH_SUPPLY, MIN_SHARE_LAMPORTS]);
    expect(c.ruleBounds).toEqual(RULE_BOUNDS);
    expect(c.ruleCeilings).toEqual(RULE_CEILINGS);
  });

  it('offers the presets of the core (`bordrless_core::policy::presets::ALL`), in order, Plain the default', () => {
    expect(V.presets!.map((p) => ({ name: p.name, slug: p.slug, creatorFeeBps: p.creatorFeeBps, rules: p.rules }))).toEqual(RULE_PRESETS.map((p) => ({ name: p.name, slug: p.slug, creatorFeeBps: p.creatorFeeBps, rules: { ...p.rules } })));
    expect(V.presets!.filter((p) => p.default).map((p) => p.name)).toEqual([DEFAULT_RULE_PRESET]);
  });

  it('takes the pool hook fees of each callback: rates, rounding, the creator + holder guard and the eligible threshold', () => {
    const bad = mismatches(
      V.hookFees,
      (c) => {
        const cut = (c.callback === 'beforeSwap' ? launchBeforeSwap : launchAfterSwap)(c.side, big(c.amount), params(c.params));
        return { creatorFee: [cut.creatorFee, big(c.expected.creatorFee)], holderFee: [cut.holderFee, big(c.expected.holderFee)], burn: [cut.burn, big(c.expected.burn)] };
      },
      (c, i) => `hookFees[${i}] ${c.name}, ${c.callback} ${c.side} of ${c.amount}`,
    );
    expect(bad).toEqual([]);
  });

  it('burns as the hook burns: rounded down, never the whole amount', () => {
    const bad = mismatches(
      V.burns,
      (c) => ({ burn: [tradeBurn(big(c.amount), c.burnBps), big(c.expected)] }),
      (c, i) => `burns[${i}] ${c.burnBps} bps of ${c.amount}`,
    );
    expect(bad).toEqual([]);
  });

  it('quotes every launch-pool swap in the order of the v2 DEX with Bordrless’s share of the cuts, failures included', () => {
    const bad = mismatches(
      V.swaps,
      (c) => {
        const q = quoteLaunchSwap(reserves(c.reserves), c.side, big(c.amountIn), c.lpFeeBps, c.protocolShareBps, params(c.params));
        const e = c.expected;
        return {
          creatorFee: [q.creatorFee, big(e.creatorFee)],
          holderFee: [q.holderFee, big(e.holderFee)],
          burn: [q.burn, big(e.burn)],
          holderFeeOn: [q.holderFeeOn, e.holderFeeOn],
          received: [q.received, big(e.received)],
          lpFee: [q.lpFee, big(e.lpFee)],
          protocolFee: [q.protocolFee, big(e.protocolFee)],
          netIn: [q.netIn, big(e.netIn)],
          amountOut: [q.amountOut, optBig(e.amountOut)],
          delivered: [q.delivered, optBig(e.delivered)],
          failure: [q.failure, e.failure],
        };
      },
      (c, i) => `swaps[${i}] ${c.name}, ${c.side} ${c.amountIn} at lp ${c.lpFeeBps} share ${c.protocolShareBps}`,
    );
    expect(bad).toEqual([]);
  });

  it('fixes the max-wallet cap and what a wallet can still receive', () => {
    const bad = mismatches(
      V.maxWallet,
      (c) => {
        const cap = maxWalletCap(big(c.supply), c.maxWalletBps);
        return { cap: [cap, big(c.expected.cap)], left: [maxWalletLeft(cap, big(c.balance)), big(c.expected.left)] };
      },
      (c, i) => `maxWallet[${i}] ${c.maxWalletBps} bps of ${c.supply}, holding ${c.balance}`,
    );
    expect(bad).toEqual([]);
  });

  it('finds the creator first buy within max wallet (devBuyMaxLamports)', () => {
    const bad = mismatches(
      V.devBuyMax,
      (c) => {
        const curve: CurveParams = { curveTokens: big(c.curve.curveTokens), reserveTokens: big(c.curve.reserveTokens), virtualQuote: big(c.curve.virtualQuote), virtualBase: big(c.curve.virtualBase), graduationQuote: big(c.curve.graduationQuote) };
        // The curve is the policy curve of its virtual quote, as the backend derives it.
        const derived = curveParams(big(c.supply), CURVE_BPS, curve.virtualQuote);
        return {
          curve: [JSON.stringify(derived, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)), JSON.stringify(c.curve)],
          devBuyMaxLamports: [devBuyMaxLamports(curve, big(c.supply), c.rules, c.creatorFeeBps, c.lpFeeBps, c.protocolShareBps), optBig(c.expected)],
        };
      },
      (c, i) => `devBuyMax[${i}] ${c.name}, creator fee ${c.creatorFeeBps}, virtual quote ${c.curve.virtualQuote}`,
    );
    expect(bad).toEqual([]);
  });

  it('locks a buy in the early window until the early unlock', () => {
    const bad = mismatches(
      V.earlyLock,
      (c) => {
        const rules = launchRulesAt({ ...NO_RULES, earlyWindowSecs: c.earlyWindowSecs, earlyLockSecs: c.earlyLockSecs }, c.launchedAt);
        return {
          earlyWindowEndsAt: [rules.earlyWindowEndsAt, c.rules.earlyWindowEndsAt],
          earlyUnlockAt: [rules.earlyUnlockAt, c.rules.earlyUnlockAt],
          lockedUntil: [buyLockedUntil(c.rules, c.now), c.expected],
        };
      },
      (c, i) => `earlyLock[${i}] window ${c.earlyWindowSecs} s, unlock ${c.earlyLockSecs} s, at ${c.now - c.launchedAt} s`,
    );
    expect(bad).toEqual([]);
  });

  it('mirrors the rewards: claimable, payable and the totals, with the paused stream and the waiting share', () => {
    const kit = (c: (typeof V.rewards)[number]): KitRewards => ({
      eligible: big(c.kit.eligible),
      minEligible: big(c.kit.minEligible),
      accPerShare: big(c.kit.accPerShare),
      rem: big(c.kit.rem),
      held: big(c.kit.held),
      seen: big(c.kit.seen),
      streamRemaining: big(c.kit.streamRemaining),
      streamLast: c.kit.streamLast,
      streamEnd: c.kit.streamEnd,
      streamNext: big(c.kit.streamNext),
      totalDistributed: big(c.kit.totalDistributed),
      totalClaimed: big(c.kit.totalClaimed),
      totalShared: big(c.kit.totalShared),
    });
    const bad = mismatches(
      V.rewards,
      (c) => {
        const k = kit(c);
        const vault = big(c.vaultAmount);
        const bytes = hexBytes(c.hookData.hex);
        const data = decodeKitHookData(bytes);
        const claim = rewardsClaimable(k, vault, c.now, big(c.balance), data, c.excluded);
        const totals = rewardTotals(k, vault, c.now);
        return {
          hookData: [JSON.stringify([data.snapshot.toString(), data.owed.toString(), data.earlyLocked.toString()]), JSON.stringify([c.hookData.snapshot, c.hookData.owed, c.hookData.earlyLocked])],
          hookDataBytes: [toHex(encodeKitHookData(data)), c.hookData.hex],
          claimable: [claim?.claimable ?? null, big(c.expected.claimable)],
          payable: [claim?.payable ?? null, big(c.expected.payable)],
          distributed: [totals?.distributed ?? null, big(c.expected.distributed)],
          claimed: [totals?.claimed ?? null, big(c.expected.claimed)],
          shared: [totals?.shared ?? null, big(c.expected.shared)],
          streaming: [totals?.streaming ?? null, big(c.expected.streaming)],
        };
      },
      (c, i) => `rewards[${i}] ${c.name}`,
    );
    expect(bad).toEqual([]);
  });

  it('agrees with the program-side sync and settle on every rewards state, as the Rust test that renders them checks', () => {
    for (const c of V.rewards) {
      if (c.excluded) continue;
      const k: KitRewards = {
        eligible: big(c.kit.eligible),
        minEligible: big(c.kit.minEligible),
        accPerShare: big(c.kit.accPerShare),
        rem: big(c.kit.rem),
        held: big(c.kit.held),
        seen: big(c.kit.seen),
        streamRemaining: big(c.kit.streamRemaining),
        streamLast: c.kit.streamLast,
        streamEnd: c.kit.streamEnd,
        streamNext: big(c.kit.streamNext),
        totalDistributed: big(c.kit.totalDistributed),
        totalClaimed: big(c.kit.totalClaimed),
        totalShared: big(c.kit.totalShared),
      };
      const after = kitSync(k, big(c.vaultAmount), c.now);
      const mirror = kitSynced(k, big(c.vaultAmount), c.now);
      expect(after, c.name).not.toBeNull();
      expect(mirror, c.name).not.toBeNull();
      const balance = big(c.balance);
      const settled = kitSettle(decodeKitHookData(hexBytes(c.hookData.hex)), balance, balance, after!.accPerShare);
      expect(settled?.owed, c.name).toBe(big(c.expected.claimable));
      expect([after!.totalDistributed, after!.streamRemaining, after!.streamNext], c.name).toEqual([mirror!.distributed, mirror!.streamRemaining, mirror!.streamNext]);
    }
  });
});
