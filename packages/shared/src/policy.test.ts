import { describe, expect, it } from 'vitest';
import type { LaunchRulesInput } from './api.ts';
import {
  BURN_CHOICES_BPS,
  CLAIM_DUST_LAMPORTS,
  COMPANION_DEFAULT_VEST_DAYS,
  COMPANION_SPLITS,
  COMPANION_TEMPLATE_LIST,
  COMPANION_VEST_CHOICES_DAYS,
  CREATOR_FEE_CHOICES_BPS,
  CREATOR_LOCK_CHOICES_DAYS,
  CURVE_BPS,
  DEFAULT_RULES,
  DEFAULT_RULE_PRESET,
  EARLY_LOCK_CHOICES_SECS,
  EARLY_WINDOW_CHOICES_SECS,
  HOLDER_FEE_CHOICES_BPS,
  LAUNCH_PROTOCOL_SHARE_BPS,
  MAX_WALLET_CHOICES_BPS,
  MIN_ELIGIBLE,
  MIN_LAUNCH_SUPPLY,
  MIN_SHARE_LAMPORTS,
  MINIMUM_LIQUIDITY,
  NO_RULES,
  PROTOCOL_FEE_BPS,
  RULE_BOUNDS,
  RULE_CEILINGS,
  RULE_PATHS,
  RULE_PRESETS,
  SCALE,
  SHARE_STREAM_SECS,
  TOKEN_SUPPLY,
  buyGraduates,
  buyLockedUntil,
  checkLaunchRules,
  COMPANION_MAX_VEST_DAYS,
  LAUNCHER_SPLIT,
  companionPaysHolders,
  companionRequestSplit,
  companionSplitProblem,
  companionTakesFirstBuy,
  companionTemplateOf,
  isLauncherSplit,
  splitPaysHolders,
  splitTakesFirstBuy,
  compoundFeeBps,
  creatorAndHolderFees,
  curveImpactBps,
  curveMaxBuyIn,
  curveOutput,
  curveParams,
  decodeKitHookData,
  defaultCreatorFeeBps,
  devBuyMaxLamports,
  encodeKitHookData,
  feeAmount,
  graduationTopup,
  initialLp,
  isqrt,
  kitAddShare,
  kitClaim,
  kitMintFlags,
  kitModules,
  kitRelease,
  kitSettle,
  kitShare,
  kitSync,
  kitSynced,
  launchAfterSwap,
  launchBeforeSwap,
  launchRulesAt,
  launchSwapToReserve,
  lpForDeposit,
  maxBuyWithin,
  maxSwapIn,
  maxWalletCap,
  maxWalletLeft,
  minEligibleFor,
  openingMcap,
  presetNamed,
  presetOf,
  protocolShare,
  protocolShareBps,
  quoteLaunchSwap,
  quoteSwap,
  quoteValue,
  rewardTotals,
  rewardsClaimable,
  shareStartsAt,
  sideFeeBps,
  sniperLpFee,
  spotPriceWad,
  streamAt,
  streamReleased,
  swapAmounts,
  swapInForOut,
  swapOut,
  tradeBurn,
  virtualQuoteForMcap,
  withdrawForLp,
  type KitHookData,
  type KitRewards,
  type LaunchFeeParams,
  type RuleBounds,
} from './policy.ts';
import { FIXED_ADDRESSES, HALF_LIFE, HOOK_SIGNERS, LAUNCH_POOL_HOOK_FLAGS, LP_FEE_TO_PROTOCOL_FROM_SLOT, LP_FEE_TO_PROTOCOL_FROM_TIME, PROGRAM_IDS, PROTOCOL_LOOKUP_TABLE_ADDRESSES, TOKEN_HOOK_FLAGS, halfLifeFeePpm, lpFeeToProtocol } from './programs.ts';

// The same vectors as crates/bordrless-core/src/lib.rs, so the two implementations stay equal.
describe('policy mirrors bordrless-core', () => {
  it('isqrt is exact', () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 1n << 64n, (1n << 100n) + 12345n]) {
      const r = isqrt(n);
      expect(r * r <= n).toBe(true);
      expect((r + 1n) * (r + 1n) > n).toBe(true);
    }
  });

  it('derives the policy curve', () => {
    const p = curveParams(TOKEN_SUPPLY, CURVE_BPS, 28_125_000_000n)!;
    expect(p.curveTokens).toBe(750_000_000_000_000n);
    expect(p.reserveTokens).toBe(250_000_000_000_000n);
    expect(p.virtualBase).toBe(375_000_000_000_000n);
    expect(p.graduationQuote).toBe(56_250_000_000n);
    expect(openingMcap(TOKEN_SUPPLY, p)).toBe(25_000_000_000n);
    expect(virtualQuoteForMcap(TOKEN_SUPPLY, CURVE_BPS, 25_000_000_000n)).toBe(28_125_000_000n);
    const dx = maxSwapIn(0n, p.virtualQuote, p.curveTokens, p.virtualBase)!;
    expect(dx >= p.graduationQuote && dx - p.graduationQuote < 1_000n).toBe(true);
    const topup = graduationTopup({ baseReserve: 0n, quoteReserve: p.graduationQuote, virtualBase: p.virtualBase, virtualQuote: p.virtualQuote });
    expect(topup <= p.reserveTokens).toBe(true);
    const before = spotPriceWad({ baseReserve: 0n, quoteReserve: p.graduationQuote, virtualBase: p.virtualBase, virtualQuote: p.virtualQuote });
    const after = spotPriceWad({ baseReserve: topup, quoteReserve: p.graduationQuote, virtualBase: 0n, virtualQuote: 0n });
    const diff = before > after ? before - after : after - before;
    expect(diff * 1_000_000n <= before).toBe(true);
  });

  it('swaps keep k and respect the real reserve', () => {
    const out = swapOut(1_000_000_000n, 0n, 28_125_000_000n, 750_000_000_000_000n, 375_000_000_000_000n)!;
    expect(out > 0n && out < 750_000_000_000_000n).toBe(true);
    const k0 = (750_000_000_000_000n + 375_000_000_000_000n) * 28_125_000_000n;
    const k1 = (750_000_000_000_000n - out + 375_000_000_000_000n) * (29_125_000_000n);
    expect(k1 >= k0).toBe(true);
    expect(swapOut(10n ** 30n, 0n, 28_125_000_000n, 750_000_000_000_000n, 375_000_000_000_000n)).toBeNull();
    const q = quoteSwap({ baseReserve: 750_000_000_000_000n, quoteReserve: 0n, virtualBase: 375_000_000_000_000n, virtualQuote: 28_125_000_000n }, 'buy', 1_000_000_000n, 30, 100);
    expect(q.lpFee).toBe(3_000_000n);
    expect(q.protocolFee).toBe(10_000_000n);
    expect(q.amountOut).toBe(swapOut(987_000_000n, 0n, 28_125_000_000n, 750_000_000_000_000n, 375_000_000_000_000n));
  });

  // bordrless-core's swap_amounts tests (the v2 DEX order, docs/hooks-v2.md §3.1).
  const opening = { baseReserve: 750_000_000_000_000n, quoteReserve: 0n, virtualBase: 375_000_000_000_000n, virtualQuote: 28_125_000_000n };

  it('a buy pays the protocol fee from its input', () => {
    const received = 1_000_000_000n;
    const a = swapAmounts('buy', received, 30, 100, opening);
    const out = swapOut(received - 3_000_000n - 10_000_000n, 0n, opening.virtualQuote, opening.baseReserve, opening.virtualBase)!;
    expect(a).toEqual({ lpFee: 3_000_000n, protocolFee: 10_000_000n, netIn: 987_000_000n, outGross: out, amountOut: out, toReserveIn: received - 10_000_000n, failure: null });
    expect(quoteSwap(opening, 'buy', received, 30, 100)).toEqual({ lpFee: 3_000_000n, protocolFee: 10_000_000n, netIn: 987_000_000n, amountOut: out, outGross: out, toReserveIn: received - 10_000_000n, failure: null });
  });

  it('a sell pays the protocol fee from its output, in quote', () => {
    const buy = swapAmounts('buy', 1_000_000_000n, 30, 100, opening);
    if (buy.failure !== null) throw new Error('the buy fails');
    const r = { ...opening, baseReserve: opening.baseReserve - buy.outGross, quoteReserve: buy.toReserveIn };
    const received = buy.outGross / 2n;
    const lpFee = feeAmount(received, 30);
    const outGross = swapOut(received - lpFee, r.baseReserve, r.virtualBase, r.quoteReserve, r.virtualQuote)!;
    const protocolFee = feeAmount(outGross, 100);
    // The whole input stays in the pool: no protocol fee in the base token any more.
    expect(swapAmounts('sell', received, 30, 100, r)).toEqual({ lpFee, protocolFee, netIn: received - lpFee, outGross, amountOut: outGross - protocolFee, toReserveIn: received, failure: null });
    const q = quoteSwap(r, 'sell', received, 30, 100);
    expect([q.protocolFee, q.amountOut, q.outGross, q.toReserveIn]).toEqual([protocolFee, outGross - protocolFee, outGross, received]);
    expect(protocolFee > 0n).toBe(true);
  });

  it('swaps that deliver nothing are refused, each for its reason', () => {
    // One lamport in: the LP fee rounds up to all of it.
    expect(swapAmounts('buy', 1n, 30, 100, opening)).toEqual({ failure: 'fees_exceed_input' });
    expect(swapAmounts('sell', 1n, 30, 0, opening)).toEqual({ failure: 'fees_exceed_input' });
    // A fee rate that does not fit is more than the input.
    expect(swapAmounts('buy', (1n << 64n) - 1n, 65_535, 0, opening)).toEqual({ failure: 'fees_exceed_input' });
    // More than the real reserve, or nothing from the curve.
    expect(swapAmounts('buy', 1_000_000_000_000n, 30, 100, { ...opening, baseReserve: 10n })).toEqual({ failure: 'insufficient_liquidity' });
    expect(swapAmounts('sell', 1_000n, 0, 100, opening)).toEqual({ failure: 'insufficient_liquidity' });
    // A sell whose curve output is one lamport: the protocol fee (rounded up) takes it all.
    const flat = { baseReserve: 1_000_000n, quoteReserve: 1_000_000n, virtualBase: 0n, virtualQuote: 0n };
    expect(swapAmounts('sell', 2n, 0, 0, flat)).toMatchObject({ outGross: 1n, amountOut: 1n, protocolFee: 0n, failure: null });
    expect(swapAmounts('sell', 2n, 0, 100, flat)).toEqual({ failure: 'fee_exceeds_output' });
    expect(quoteSwap(flat, 'sell', 2n, 0, 100)).toEqual({ lpFee: 0n, protocolFee: 1n, netIn: 2n, amountOut: null, outGross: 1n, toReserveIn: 2n, failure: 'fee_exceeds_output' });
    // An output the curve can never give, without a virtual reserve beyond it: none, not a division by zero.
    expect(swapInForOut(1_000_000n, 1_000_000n, 0n, 1_000_000n, 0n)).toBeNull();
    expect(maxSwapIn(1_000_000n, 0n, 1_000_000n, 0n)).toBeNull();
  });

  it('lp math round trips', () => {
    const first = initialLp(1_000_000_000n, 4_000_000_000n)!;
    expect(first.total).toBe(2_000_000_000n);
    expect(first.toDepositor).toBe(first.total - MINIMUM_LIQUIDITY);
    const more = lpForDeposit(500_000_000n, 10_000_000_000n, 1_000_000_000n, 4_000_000_000n, first.total)!;
    expect([more.baseUsed, more.quoteUsed, more.lp]).toEqual([500_000_000n, 2_000_000_000n, 1_000_000_000n]);
    const out = withdrawForLp(more.lp, 1_500_000_000n, 6_000_000_000n, first.total + more.lp)!;
    expect([out.base, out.quote]).toEqual([500_000_000n, 2_000_000_000n]);
  });

  it('fees round up and the sniper fee falls to the base', () => {
    expect(feeAmount(10_000n, 30)).toBe(30n);
    expect(feeAmount(1n, 30)).toBe(1n);
    expect(feeAmount(0n, 30)).toBe(0n);
    expect(sniperLpFee(0, 0, 30, 8_000, 30)).toBe(8_000);
    expect(sniperLpFee(15, 0, 30, 8_000, 30)).toBe(8_000 - 3_985);
    expect(sniperLpFee(5, 0, 30, 8_000, 30)).toBe(6_672);
    expect(sniperLpFee(30, 0, 30, 8_000, 30)).toBe(30);
    expect(sniperLpFee(-5, 0, 30, 8_000, 30)).toBe(8_000);
  });
});

// v2 (docs/hooks-v2.md). vectors.test.ts runs every case the Rust reference renders into
// programs/tests/vectors/launch-fees.json; the tests here pin the rules and the corners by hand.

/** A curve pool as a launch opens it. */
const OPEN: { baseReserve: bigint; quoteReserve: bigint; virtualBase: bigint; virtualQuote: bigint } = { baseReserve: 750_000_000_000_000n, quoteReserve: 0n, virtualBase: 375_000_000_000_000n, virtualQuote: 28_125_000_000n };
const fees = (o: Partial<LaunchFeeParams> = {}): LaunchFeeParams => ({ creatorFeeBps: 50, holderFeeBuyBps: 100, holderFeeSellBps: 100, burnBuyBps: 0, burnSellBps: 0, eligible: MIN_ELIGIBLE, minEligible: MIN_ELIGIBLE, ...o });
const preset = (name: string): LaunchRulesInput => RULE_PRESETS.find((p) => p.name === name)!.rules as LaunchRulesInput;
/** The old "Holders first" rules (holder rewards 1%, max wallet 2%, creator wallet lock 30 days): a Custom set now, kept as the test's everyday rules. */
const HOLDERS: LaunchRulesInput = { ...NO_RULES, holderFeeBuyBps: 100, holderFeeSellBps: 100, maxWalletBps: 200, creatorLockDays: 30 };
/** The old "Fair start" rules: an early-buyer lock (60 s, until 1 h), max wallet 2%, holder rewards 0.5%, creator wallet lock 30 days. */
const FAIR: LaunchRulesInput = { ...NO_RULES, holderFeeBuyBps: 50, holderFeeSellBps: 50, maxWalletBps: 200, creatorLockDays: 30, earlyWindowSecs: 60, earlyLockSecs: 3_600 };

describe('v2 token rules: bounds, choices and presets', () => {
  it('holds the bounds and ceilings of §5.2', () => {
    expect(RULE_BOUNDS).toEqual({ maxHolderFeeBps: 200, maxBurnBps: 100, maxRulesFeeBps: 300, minMaxWalletBps: 100, maxMaxWalletBps: 500, maxCreatorLockSecs: 90 * 86_400, maxEarlyWindowSecs: 300, maxEarlyLockSecs: 7 * 86_400 });
    expect(RULE_CEILINGS).toEqual({ maxHolderFeeBps: 500, maxBurnBps: 500, maxRulesFeeBps: 1_000, minMaxWalletBps: 1, maxMaxWalletBps: 9_999, maxCreatorLockSecs: 365 * 86_400, maxEarlyWindowSecs: 3_600, maxEarlyLockSecs: 30 * 86_400 });
    for (const key of Object.keys(RULE_BOUNDS) as (keyof RuleBounds)[]) {
      if (key === 'minMaxWalletBps') expect(RULE_BOUNDS[key] >= RULE_CEILINGS[key]).toBe(true);
      else expect(RULE_BOUNDS[key] <= RULE_CEILINGS[key]).toBe(true);
    }
    expect(MIN_LAUNCH_SUPPLY).toBe(1_000n);
    expect(minEligibleFor(MIN_LAUNCH_SUPPLY)).toBe(1n);
    expect(MIN_ELIGIBLE).toBe(1_000_000_000_000n);
    expect(SCALE).toBe(1_000_000_000_000n);
    expect([MIN_SHARE_LAMPORTS, SHARE_STREAM_SECS, CLAIM_DUST_LAMPORTS]).toEqual([1_000_000n, 3_600, 500_000n]);
    expect(PROGRAM_IDS.kit).toBe('14RJQXPdJfkehit6ezktjd3xujamf8nVSKw2shKamaEH');
    expect(TOKEN_HOOK_FLAGS.WRITES_HOOK_DATA).toBe(128);
  });

  it('keeps the protocol constants in one place: hook signers, fixed addresses, the lookup table and the flags', () => {
    expect(HOOK_SIGNERS).toEqual({ tokenForKit: 'C2Y3B3hZTesJQqLYrZ7qoaZUoRmwYWh5Qh3MuFxruouE', tokenForTaxHook: '8v2CVajpJMVKXLpZePXQpqvq2nyn7r1so7DxgXu4CkAw', dexForLaunch: '6Ztfr97cUewdViXDXdZUsQq4pz7MYdygvK1WijALjZ5q' });
    // programs-summary §2.7: exactly these 22 (18, then 4 for companion launches), each once, the signers of v2 in place of v1's global ones.
    expect(PROTOCOL_LOOKUP_TABLE_ADDRESSES.length).toBe(22);
    expect(new Set(PROTOCOL_LOOKUP_TABLE_ADDRESSES).size).toBe(22);
    expect(PROTOCOL_LOOKUP_TABLE_ADDRESSES).toContain(PROGRAM_IDS.kit);
    expect(PROTOCOL_LOOKUP_TABLE_ADDRESSES).toContain(FIXED_ADDRESSES.kitHookAuthority);
    for (const v1 of ['BDDa1JTNkJSLAnwmUyqh43Pn4nsscKxmsYwUXdnN7gfb', '549imocCqvCEwCNR5XaVDqKghqct46eDkKcsGwDPf81R']) expect(PROTOCOL_LOOKUP_TABLE_ADDRESSES).not.toContain(v1);
    // A program a transaction invokes at top level stays a static key whatever the table holds (the v0 compiler keeps it so). The kit, the launch, the
    // swap and the token program are in it for the transactions that invoke them only inside another (a companion's, a launch's, a swap's); the bridge is not.
    for (const p of [PROGRAM_IDS.kit, PROGRAM_IDS.launch, PROGRAM_IDS.swap, PROGRAM_IDS.token]) expect(PROTOCOL_LOOKUP_TABLE_ADDRESSES).toContain(p);
    expect(PROTOCOL_LOOKUP_TABLE_ADDRESSES).not.toContain(PROGRAM_IDS.bridge);
    expect(LAUNCH_POOL_HOOK_FLAGS).toBe(1_985);
    // §4.2: a kit mint's flags for each module set.
    expect(kitMintFlags(0)).toBe(0);
    for (let m = 1; m <= 15; m++) expect(kitMintFlags(m)).toBe((m & 1) !== 0 || (m & 8) !== 0 ? 145 : 1);
  });

  it('offers the four presets of §7.1 (Plain first and default), each within the choices and the bounds, and the two paths beside them', () => {
    expect(RULE_PRESETS.map((p) => p.name)).toEqual(['Plain', 'Diamond hands', 'Burn', 'Paid to hold']);
    expect(RULE_PRESETS.map((p) => p.slug)).toEqual(['plain', 'diamond-hands', 'burn', 'paid-to-hold']);
    expect(new Set(RULE_PRESETS.map((p) => p.slug)).size).toBe(RULE_PRESETS.length);
    for (const p of RULE_PRESETS) expect(p.description.length).toBeGreaterThan(20);
    expect(DEFAULT_RULE_PRESET).toBe('Plain');
    expect(presetNamed('Plain').rules).toEqual(NO_RULES);
    const rules = (o: Partial<LaunchRulesInput>): LaunchRulesInput => ({ ...NO_RULES, ...o });
    expect(RULE_PRESETS.map((p) => [p.name, p.creatorFeeBps, p.rules])).toEqual([
      ['Plain', 100, NO_RULES],
      ['Diamond hands', 50, rules({ holderFeeBuyBps: 100, holderFeeSellBps: 100, maxWalletBps: 100, creatorLockDays: 90, earlyWindowSecs: 300, earlyLockSecs: 86_400 })],
      ['Burn', 50, rules({ holderFeeBuyBps: 50, holderFeeSellBps: 50, burnBuyBps: 50, burnSellBps: 50 })],
      ['Paid to hold', 50, rules({ holderFeeSellBps: 200, creatorLockDays: 30 })],
    ]);
    // Gone everywhere (2026-10-07).
    for (const gone of ['Holders first', 'Fair start', 'Scorched', 'Community', 'Custom']) expect(RULE_PRESETS.some((p) => (p.name as string) === gone)).toBe(false);
    // Half-Life, Custom and Build your own are paths, not presets: no rules of their own, slugs the launch page reads.
    expect(RULE_PATHS.map((p) => [p.name, p.slug])).toEqual([
      ['Half-Life', 'half-life'],
      ['Custom', 'custom'],
      ['Build your own', 'build-your-own'],
    ]);
    expect(new Set([...RULE_PRESETS, ...RULE_PATHS].map((p) => p.slug)).size).toBe(RULE_PRESETS.length + RULE_PATHS.length);
    for (const p of RULE_PRESETS) {
      expect(checkLaunchRules(p.rules, p.creatorFeeBps)).toBeNull();
      expect(CREATOR_FEE_CHOICES_BPS as readonly number[]).toContain(p.creatorFeeBps);
      for (const v of [p.rules.holderFeeBuyBps, p.rules.holderFeeSellBps]) expect(HOLDER_FEE_CHOICES_BPS as readonly number[]).toContain(v);
      for (const v of [p.rules.burnBuyBps, p.rules.burnSellBps]) expect(BURN_CHOICES_BPS as readonly number[]).toContain(v);
      expect(MAX_WALLET_CHOICES_BPS as readonly number[]).toContain(p.rules.maxWalletBps);
      expect(CREATOR_LOCK_CHOICES_DAYS as readonly number[]).toContain(p.rules.creatorLockDays);
      expect(EARLY_WINDOW_CHOICES_SECS as readonly number[]).toContain(p.rules.earlyWindowSecs);
      if (p.rules.earlyWindowSecs > 0) expect(EARLY_LOCK_CHOICES_SECS as readonly number[]).toContain(p.rules.earlyLockSecs);
    }
    // The §7.1 per-rule defaults (the old "Holders first" set) stay within the bounds; rewards on, so the creator fee defaults to 0.5%.
    expect(DEFAULT_RULES).toEqual(HOLDERS);
    expect(checkLaunchRules(DEFAULT_RULES, defaultCreatorFeeBps(DEFAULT_RULES))).toBeNull();
    expect(defaultCreatorFeeBps(DEFAULT_RULES)).toBe(50);
    expect(defaultCreatorFeeBps(NO_RULES)).toBe(100);
  });

  it('names the preset a launch matches (§8.1)', () => {
    for (const name of ['Paid to hold', 'Diamond hands', 'Burn']) expect(presetOf(preset(name), 50)).toBe(name);
    // Without rules there is no preset, whatever the creator fee (Plain included).
    expect(presetOf(NO_RULES, 100)).toBeNull();
    expect(presetOf(NO_RULES, 50)).toBeNull();
    // Anything else is custom: another creator fee, one field changed, or a set that was a preset once.
    expect(presetOf(preset('Burn'), 100)).toBe('custom');
    expect(presetOf({ ...preset('Burn'), burnSellBps: 25 }, 50)).toBe('custom');
    expect(presetOf({ ...NO_RULES, burnBuyBps: 50, burnSellBps: 50 }, 100)).toBe('custom');
    expect(presetOf(HOLDERS, 50)).toBe('custom');
    // A launch made from a config with a creator's own hook, whatever its rules.
    expect(presetOf(NO_RULES, 100, true)).toBe('custom-hook');
    expect(presetOf(preset('Burn'), 50, true)).toBe('custom-hook');
  });

  it('refuses what create_launch refuses, with the sentence the form shows', () => {
    const r = (o: Partial<LaunchRulesInput>): LaunchRulesInput => ({ ...NO_RULES, ...o });
    expect(checkLaunchRules(NO_RULES, 200)).toBeNull();
    expect(checkLaunchRules(r({ holderFeeBuyBps: 201 }), 0)).toBe('Holder rewards can be at most 2% per side.');
    expect(checkLaunchRules(r({ burnSellBps: 101 }), 0)).toBe('Burn can be at most 1% per side.');
    // Creator + holders + burn per side, at the limit and one step over.
    expect(checkLaunchRules(r({ holderFeeSellBps: 200, burnSellBps: 50 }), 50)).toBeNull();
    expect(checkLaunchRules(r({ holderFeeSellBps: 200, burnSellBps: 100 }), 50)).toBe('Creator fee, holder rewards and burn add up to 3.5% on sells; the most is 3%.');
    expect(checkLaunchRules(r({ holderFeeBuyBps: 200 }), 200)).toBe('Creator fee, holder rewards and burn add up to 4% on buys; the most is 3%.');
    expect(checkLaunchRules(r({ maxWalletBps: 99 }), 0)).toBe('Max wallet must be off or between 1% and 5%.');
    expect(checkLaunchRules(r({ maxWalletBps: 501 }), 0)).toBe('Max wallet must be off or between 1% and 5%.');
    expect(checkLaunchRules(r({ maxWalletBps: 500 }), 0)).toBeNull();
    expect(checkLaunchRules(r({ creatorLockDays: 91 }), 0)).toBe('The creator wallet lock can be at most 90 days.');
    expect(checkLaunchRules(r({ creatorLockDays: 90 }), 0)).toBeNull();
    expect(checkLaunchRules(r({ earlyLockSecs: 900 }), 0)).toBe('The early-buyer lock needs a window: choose how soon after the launch a buy is locked.');
    expect(checkLaunchRules(r({ earlyWindowSecs: 301, earlyLockSecs: 900 }), 0)).toBe('The early-buyer window can be at most 5 minutes.');
    expect(checkLaunchRules(r({ earlyWindowSecs: 60, earlyLockSecs: 60 }), 0)).toBe('Early buys must unlock after the early-buyer window ends.');
    expect(checkLaunchRules(r({ earlyWindowSecs: 60, earlyLockSecs: 7 * 86_400 + 1 }), 0)).toBe('Early buys must unlock within 7 days of the launch.');
    expect(checkLaunchRules(r({ earlyWindowSecs: 300, earlyLockSecs: 7 * 86_400 }), 0)).toBeNull();
    expect(checkLaunchRules(r({ burnBuyBps: -1 }), 0)).toBe('Token rules must be whole numbers, 0 or more.');
    expect(checkLaunchRules(r({ burnBuyBps: 0.5 }), 0)).toBe('Token rules must be whole numbers, 0 or more.');
    // A config may set other bounds, up to the ceilings.
    expect(checkLaunchRules(r({ holderFeeBuyBps: 500 }), 0, RULE_CEILINGS)).toBeNull();
    expect(checkLaunchRules(r({ holderFeeBuyBps: 500, burnBuyBps: 500, holderFeeSellBps: 1 }), 1, RULE_CEILINGS)).toBe('Creator fee, holder rewards and burn add up to 10.01% on buys; the most is 10%.');
  });

  it('installs the kit modules of §5.1 and dates the rules from the launch', () => {
    expect(kitModules(NO_RULES)).toBe(0);
    expect(kitModules({ ...NO_RULES, burnBuyBps: 50, burnSellBps: 50 })).toBe(0);
    expect(kitModules({ ...NO_RULES, holderFeeSellBps: 200 })).toBe(1);
    expect(kitModules(HOLDERS)).toBe(1 | 2 | 4);
    expect(kitModules(FAIR)).toBe(1 | 2 | 4 | 8);
    expect(kitModules(preset('Diamond hands'))).toBe(1 | 2 | 4 | 8);
    expect(launchRulesAt(FAIR, 1_000)).toEqual({ holderFeeBuyBps: 50, holderFeeSellBps: 50, burnBuyBps: 0, burnSellBps: 0, maxWalletBps: 200, creatorUnlockAt: 1_000 + 30 * 86_400, earlyWindowEndsAt: 1_060, earlyUnlockAt: 4_600, walletsOnly: true });
    expect(launchRulesAt(NO_RULES, 1_000)).toEqual({ holderFeeBuyBps: 0, holderFeeSellBps: 0, burnBuyBps: 0, burnSellBps: 0, maxWalletBps: 0, creatorUnlockAt: null, earlyWindowEndsAt: null, earlyUnlockAt: null, walletsOnly: false });
  });

  it('locks a buy in the early window until the early unlock', () => {
    const fair = launchRulesAt(FAIR, 1_000);
    expect(buyLockedUntil(fair, 1_000)).toBe(4_600);
    expect(buyLockedUntil(fair, 1_059)).toBe(4_600);
    expect(buyLockedUntil(fair, 1_060)).toBeNull();
    expect(buyLockedUntil(launchRulesAt(NO_RULES, 1_000), 1_000)).toBeNull();
  });
});

describe('v2 pool hook fees (§5.4) in the order of the v2 DEX (§3.1)', () => {
  it('rounds the creator and holder fees up and drops both at dust', () => {
    expect(creatorAndHolderFees(1_000_000_000n, 50, 100, 1n, 1n)).toEqual({ creatorFee: 5_000_000n, holderFee: 10_000_000n });
    expect(creatorAndHolderFees(10_001n, 50, 100, 1n, 1n)).toEqual({ creatorFee: 51n, holderFee: 101n });
    // creator + holder >= amount: neither is taken.
    expect(creatorAndHolderFees(0n, 50, 100, 1n, 1n)).toEqual({ creatorFee: 0n, holderFee: 0n });
    expect(creatorAndHolderFees(1n, 50, 0, 1n, 1n)).toEqual({ creatorFee: 0n, holderFee: 0n });
    expect(creatorAndHolderFees(2n, 50, 100, 1n, 1n)).toEqual({ creatorFee: 0n, holderFee: 0n });
    expect(creatorAndHolderFees(3n, 50, 100, 1n, 1n)).toEqual({ creatorFee: 1n, holderFee: 1n });
    // At the ceilings: 5% + 5% of 20 is 1 + 1, below 20; of 2 it is 1 + 1, not below 2.
    expect(creatorAndHolderFees(20n, 500, 500, 1n, 1n)).toEqual({ creatorFee: 1n, holderFee: 1n });
    expect(creatorAndHolderFees(2n, 500, 500, 1n, 1n)).toEqual({ creatorFee: 0n, holderFee: 0n });
  });

  it('takes the holder fee only from the eligible threshold up', () => {
    expect(creatorAndHolderFees(1_000_000_000n, 50, 100, MIN_ELIGIBLE - 1n, MIN_ELIGIBLE)).toEqual({ creatorFee: 5_000_000n, holderFee: 0n });
    expect(creatorAndHolderFees(1_000_000_000n, 50, 100, MIN_ELIGIBLE, MIN_ELIGIBLE)).toEqual({ creatorFee: 5_000_000n, holderFee: 10_000_000n });
    // Below the threshold the creator fee alone faces the guard.
    expect(creatorAndHolderFees(3n, 50, 100, 0n, MIN_ELIGIBLE)).toEqual({ creatorFee: 1n, holderFee: 0n });
  });

  it('rounds burns down and never burns the whole amount', () => {
    expect(tradeBurn(10_001n, 50)).toBe(50n);
    expect(tradeBurn(199n, 50)).toBe(0n);
    expect(tradeBurn(200n, 50)).toBe(1n);
    expect(tradeBurn(1n, 100)).toBe(0n);
    expect(tradeBurn(0n, 100)).toBe(0n);
    expect(tradeBurn(5n, 10_000)).toBe(0n);
  });

  it('takes each side at its own rate in its own callback', () => {
    const rates = fees({ holderFeeBuyBps: 0, holderFeeSellBps: 200, burnBuyBps: 25, burnSellBps: 100 });
    expect(launchBeforeSwap('buy', 1_000_000n, rates)).toEqual({ creatorFee: 5_000n, holderFee: 0n, burn: 0n });
    expect(launchAfterSwap('buy', 1_000_000n, rates)).toEqual({ creatorFee: 0n, holderFee: 0n, burn: 2_500n });
    expect(launchBeforeSwap('sell', 1_000_000n, rates)).toEqual({ creatorFee: 0n, holderFee: 0n, burn: 10_000n });
    expect(launchAfterSwap('sell', 1_000_000n, rates)).toEqual({ creatorFee: 5_000n, holderFee: 20_000n, burn: 0n });
  });

  it('takes Bordrless a quarter of the cuts, rounded up, never more than them, and nothing without them', () => {
    const share = LAUNCH_PROTOCOL_SHARE_BPS;
    expect(share).toBe(2_500);
    expect(protocolShare(0n, share)).toBe(0n);
    expect(protocolShare(1n, share)).toBe(1n);
    expect(protocolShare(3n, share)).toBe(1n);
    expect(protocolShare(4n, share)).toBe(1n);
    expect(protocolShare(5n, share)).toBe(2n);
    expect(protocolShare(10_000_000n, share)).toBe(2_500_000n);
    expect(protocolShare(7n, 10_000)).toBe(7n);
    expect(() => protocolShare(7n, 10_001)).toThrow(RangeError);
    for (const v of [1n, 2n, 3n, 999n, 12_345_678_901n]) expect(protocolShare(v, share) <= v).toBe(true);
    // A base-side cut valued at the swap's price, rounded up (a creator's own hook; the kit makes none).
    expect(quoteValue(1n, 1n, 3n)).toBe(1n);
    expect(quoteValue(0n, 1n, 0n)).toBe(0n);
    expect(quoteValue(1_000_000n, 2_000_000_000n, 500_000_000_000n)).toBe(4_000n);
    // As a rate of the trade: 1% of cuts pays 0.25%; 1.5% pays 0.375%; nothing pays nothing.
    expect(protocolShareBps(100)).toBe(25);
    expect(protocolShareBps(150)).toBe(37.5);
    expect(protocolShareBps(0)).toBe(0);
  });

  it('quotes a buy step by step: hook fees from the input, Bordrless’s share of them and the LP fee (Bordrless’s too) on the vault side, burn from the output', () => {
    const share = LAUNCH_PROTOCOL_SHARE_BPS;
    const all = fees({ burnBuyBps: 50, burnSellBps: 50 });
    const buy = quoteLaunchSwap(OPEN, 'buy', 1_000_000_000n, 30, share, all);
    expect([buy.creatorFee, buy.holderFee, buy.received]).toEqual([5_000_000n, 10_000_000n, 985_000_000n]);
    // A quarter of the 15,000,000 the rules collected: 0.375% of the trade.
    expect(buy.protocolFee).toBe(3_750_000n);
    expect(buy.lpFee).toBe(feeAmount(985_000_000n, 30));
    expect(buy.netIn).toBe(985_000_000n - buy.lpFee - 3_750_000n);
    expect(buy.amountOut).toBe(swapOut(buy.netIn, OPEN.quoteReserve, OPEN.virtualQuote, OPEN.baseReserve, OPEN.virtualBase));
    expect(buy.burn).toBe((buy.amountOut! * 50n) / 10_000n);
    expect(buy.delivered).toBe(buy.amountOut! - buy.burn);
    expect([buy.failure, buy.holderFeeOn]).toEqual([null, true]);
    // The reserve gains only what went into the curve: the LP fee and the share are both Bordrless's, nothing compounds.
    expect(launchSwapToReserve('buy', buy)).toBe(buy.netIn);
    // "On 1% it would be 0.25% to us": a Plain launch with a 1% creator fee pays 2,500,000 of a 1 SOL buy.
    const plain = fees({ creatorFeeBps: 100, holderFeeBuyBps: 0, holderFeeSellBps: 0, eligible: 0n, minEligible: 0n });
    const p = quoteLaunchSwap(OPEN, 'buy', 1_000_000_000n, 30, share, plain);
    expect([p.creatorFee, p.protocolFee]).toEqual([10_000_000n, 2_500_000n]);
    expect(p.protocolFee).toBe(1_000_000_000n / 400n);
    // A launch whose rules collect nothing pays Bordrless nothing: the buy is the curve less the LP fee alone.
    const none = fees({ creatorFeeBps: 0, holderFeeBuyBps: 0, holderFeeSellBps: 0, eligible: 0n, minEligible: 0n });
    const free = quoteLaunchSwap(OPEN, 'buy', 1_000_000_000n, 30, share, none);
    const bare = quoteSwap(OPEN, 'buy', 1_000_000_000n, 30, 0);
    expect([free.creatorFee, free.holderFee, free.protocolFee]).toEqual([0n, 0n, 0n]);
    expect([free.lpFee, free.netIn, free.amountOut, free.delivered]).toEqual([bare.lpFee, bare.netIn, bare.amountOut, bare.amountOut]);
    // ...but unlike an ordinary pool's, the LP fee leaves the reserve.
    expect([bare.toReserveIn, launchSwapToReserve('buy', free)]).toEqual([1_000_000_000n, 1_000_000_000n - free.lpFee]);
  });

  it('quotes a sell step by step: burn from the input, the curve, the LP fee (Bordrless’s) from its output, then the hook fees from the rest and Bordrless’s share of them held back', () => {
    const share = LAUNCH_PROTOCOL_SHARE_BPS;
    const all = fees({ burnBuyBps: 50, burnSellBps: 50 });
    const buy = quoteLaunchSwap(OPEN, 'buy', 1_000_000_000n, 30, share, all);
    // Sell what the buy delivered back into the pool it left.
    const after = { ...OPEN, baseReserve: OPEN.baseReserve - buy.amountOut!, quoteReserve: launchSwapToReserve('buy', buy) };
    const tokens = buy.delivered!;
    const sell = quoteLaunchSwap(after, 'sell', tokens, 30, share, { ...all, eligible: MIN_ELIGIBLE + tokens });
    const burn = (tokens * 50n) / 10_000n;
    const received = tokens - burn;
    const gross = swapOut(received, after.baseReserve, after.virtualBase, after.quoteReserve, after.virtualQuote)!;
    // The LP fee leaves the curve's output in SOL; the hook is told the rest, the fees come from it and Bordrless's quarter of them is held back from the delivery.
    const lpFee = feeAmount(gross, 30);
    const told = gross - lpFee;
    const creatorFee = feeAmount(told, 50);
    const holderFee = feeAmount(told, 100);
    const protocolFee = protocolShare(creatorFee + holderFee, share);
    expect([sell.burn, sell.received, sell.lpFee, sell.netIn, sell.amountOut]).toEqual([burn, received, lpFee, received, gross]);
    expect([sell.creatorFee, sell.holderFee, sell.protocolFee]).toEqual([creatorFee, holderFee, protocolFee]);
    expect(sell.delivered).toBe(told - creatorFee - holderFee - protocolFee);
    expect(curveOutput(after, 'sell', sell.netIn)).toBe(gross);
    expect(protocolFee * 4n >= creatorFee + holderFee && protocolFee * 4n < creatorFee + holderFee + 4n).toBe(true);
    // The reserve gains what reached the vault, whole: the LP fee and the share come out of the output.
    expect(launchSwapToReserve('sell', sell)).toBe(received);

    // A sell's input leaves the eligible count before after_swap reads it: no holder fee, and the share is of the creator fee alone.
    const below = quoteLaunchSwap(after, 'sell', tokens, 30, share, { ...all, eligible: MIN_ELIGIBLE + tokens - 1n });
    expect(below).toMatchObject({ holderFee: 0n, holderFeeOn: false, creatorFee, protocolFee: protocolShare(creatorFee, share) });
    // Without rules only the LP fee is held back.
    const none = fees({ creatorFeeBps: 0, holderFeeBuyBps: 0, holderFeeSellBps: 0, eligible: 0n, minEligible: 0n });
    const free = quoteLaunchSwap(after, 'sell', tokens, 30, share, none);
    expect([free.protocolFee, free.delivered]).toEqual([0n, free.amountOut! - free.lpFee]);
  });

  it('says why a swap fails', () => {
    const share = LAUNCH_PROTOCOL_SHARE_BPS;
    const all = fees({ burnBuyBps: 50, burnSellBps: 50 });
    expect(quoteLaunchSwap(OPEN, 'buy', 1n, 30, share, all).failure).toBe('fees_exceed_input');
    expect(quoteLaunchSwap(OPEN, 'buy', 1_000_000_000_000n, 30, share, all).failure).toBe('insufficient_liquidity');
    const traded = { ...OPEN, baseReserve: OPEN.baseReserve - 10_000_000_000n, quoteReserve: 1_000_000_000n };
    expect(quoteLaunchSwap(traded, 'sell', 1_000n, 30, share, all).failure).toBe('no_output');
    // The curve gives 1 lamport and the LP fee (rounded up) takes it: nothing would reach the wallet.
    const one = quoteLaunchSwap(traded, 'sell', 40_121n, 30, share, fees());
    expect(curveOutput(traded, 'sell', one.netIn)).toBe(1n);
    expect(one).toMatchObject({ netIn: 40_121n, lpFee: 1n, creatorFee: 0n, holderFee: 0n, protocolFee: 0n, amountOut: null, delivered: null, failure: 'no_output' });
    // The curve gives 3: the LP fee takes 1, the hook's fees on the other 2 (1 and 1) would take them all, so the guard drops both, nothing is shared, and 2 are delivered.
    const holders = fees({ eligible: 2n * MIN_ELIGIBLE });
    expect(quoteLaunchSwap(traded, 'sell', 120_362n, 30, share, holders)).toMatchObject({ amountOut: 3n, lpFee: 1n, creatorFee: 0n, holderFee: 0n, protocolFee: 0n, delivered: 2n, failure: null });
    // The curve gives 4: the LP fee takes 1, the fees round up to 1 and 1, the share of those 2 rounds up to 1, and together they take the 3 left.
    // On the failure the fields are those computed up to it, as the Rust reference reports them.
    const four = quoteLaunchSwap(traded, 'sell', 160_483n, 30, share, holders);
    expect(curveOutput(traded, 'sell', four.netIn)).toBe(4n);
    expect(four).toMatchObject({ netIn: 160_483n, lpFee: 1n, creatorFee: 1n, holderFee: 1n, protocolFee: 1n, amountOut: null, delivered: null, failure: 'no_output' });
    expect(quoteLaunchSwap(OPEN, 'sell', 1_000_000_000n, 30, share, all).failure).toBe('insufficient_liquidity');
    // The fees' guard: when creator + holders would take the whole of what the LP fee leaves, neither is taken, and nothing is shared.
    expect(quoteLaunchSwap(traded, 'sell', 400_000n, 30, share, fees({ creatorFeeBps: 5_000, holderFeeBuyBps: 5_000, holderFeeSellBps: 5_000, eligible: 2n * MIN_ELIGIBLE }))).toMatchObject({ amountOut: 10n, lpFee: 1n, creatorFee: 0n, holderFee: 0n, protocolFee: 0n, delivered: 9n, failure: null });
  });

  it('gives one fee figure per side by the formulas of §7.3, rounded up', () => {
    expect(compoundFeeBps([])).toBe(0);
    expect(compoundFeeBps([100])).toBe(100);
    expect(compoundFeeBps([30, 100, 100])).toBe(229); // 228.403
    expect(compoundFeeBps([10_000, 50])).toBe(10_000);
    expect(() => compoundFeeBps([10_001])).toThrow(RangeError);
    // An ordinary pool (the flat 1%) with a 1% creator fee.
    const v1 = { lpFeeBps: 30, protocolFeeBps: PROTOCOL_FEE_BPS, creatorFeeBps: 100, holderFeeBps: 0, burnBps: 0 };
    expect(sideFeeBps('buy', v1)).toBe(229); // 1 - 0.99 · 0.987 = 2.287%
    expect(sideFeeBps('sell', v1)).toBe(229); // 1 - 0.997 · 0.99 · 0.99 = 2.28403%
    // Plain, on a launch pool (Bordrless's quarter of the cuts): creator 1%, so 1.25% with the share.
    const share = LAUNCH_PROTOCOL_SHARE_BPS;
    const plain = { lpFeeBps: 30, protocolShareBps: share, creatorFeeBps: 100, holderFeeBps: 0, burnBps: 0 };
    expect(sideFeeBps('buy', plain)).toBe(155); // 1 - 0.9875 · 0.997 = 1.54375%
    expect(sideFeeBps('sell', plain)).toBe(155); // the same factors, the other way round
    // Diamond hands: holders 1%, creator 0.5%; 1.5% of cuts is 1.875% with the share: the "217 bps a side" of §7.3.
    const diamond = { lpFeeBps: 30, protocolShareBps: share, creatorFeeBps: 50, holderFeeBps: 100, burnBps: 0 };
    expect(sideFeeBps('buy', diamond)).toBe(217); // 1 - 0.98125 · 0.997 = 2.169375%
    expect(sideFeeBps('sell', diamond)).toBe(217);
    // Nothing collected, nothing shared: only the LP fee.
    expect(sideFeeBps('buy', { lpFeeBps: 30, protocolShareBps: share, creatorFeeBps: 0, holderFeeBps: 0, burnBps: 0 })).toBe(30);
    // Leaving both models out is the same as 0 of each.
    expect(sideFeeBps('buy', { lpFeeBps: 30, creatorFeeBps: 100, holderFeeBps: 0, burnBps: 0 })).toBe(compoundFeeBps([100, 30]));
    // The sniper fee at its start, with a burn, on a launch pool.
    const sniped = { lpFeeBps: 8_000, protocolShareBps: share, creatorFeeBps: 50, holderFeeBps: 100, burnBps: 50 };
    expect(sideFeeBps('buy', sniped)).toBe(8_048); // 1 - 0.98125 · 0.2 · 0.995 = 80.473125%
    expect(sideFeeBps('sell', sniped)).toBe(8_048); // 1 - 0.995 · 0.2 · 0.98125 = 80.473125%
    // A fractional share rounds the side up, never down: 0.5% of cuts is 62.5 bps with the share.
    expect(sideFeeBps('buy', { lpFeeBps: 0, protocolShareBps: share, creatorFeeBps: 50, holderFeeBps: 0, burnBps: 0 })).toBe(63);
    expect(() => sideFeeBps('buy', { lpFeeBps: 30, protocolShareBps: 10_001, creatorFeeBps: 50, holderFeeBps: 0, burnBps: 0 })).toThrow(RangeError);
    expect(() => sideFeeBps('buy', { lpFeeBps: 30, protocolShareBps: share, creatorFeeBps: 10_000, holderFeeBps: 0, burnBps: 0 })).toThrow(RangeError);
  });

  it('measures price impact on the curve alone', () => {
    // Buying with 1% of the quote side pays 1% over spot on the curve, whatever the fees.
    const netIn = (OPEN.quoteReserve + OPEN.virtualQuote) / 100n;
    const out = swapOut(netIn, OPEN.quoteReserve, OPEN.virtualQuote, OPEN.baseReserve, OPEN.virtualBase)!;
    expect(curveImpactBps(OPEN, 'buy', netIn, out)).toBe(100);
    // Selling 1/99 of the base side gets 1% under spot.
    const flat = { baseReserve: 99_000_000n, quoteReserve: 99_000_000n, virtualBase: 0n, virtualQuote: 0n };
    const got = swapOut(1_000_000n, flat.baseReserve, 0n, flat.quoteReserve, 0n)!;
    expect(got).toBe(990_000n);
    expect(curveImpactBps(flat, 'sell', 1_000_000n, got)).toBe(100);
    expect(curveImpactBps(OPEN, 'buy', 0n, 0n)).toBe(0);
  });
});

describe('v2 max wallet', () => {
  it('fixes the cap from the launch supply', () => {
    expect(maxWalletCap(TOKEN_SUPPLY, 200)).toBe(20_000_000_000_000n); // 20,000,000 tokens
    expect(maxWalletCap(TOKEN_SUPPLY, 0)).toBe(0n);
    expect(maxWalletCap(999n, 100)).toBe(9n);
    expect(maxWalletLeft(100n, 30n)).toBe(70n);
    expect(maxWalletLeft(100n, 100n)).toBe(0n);
    expect(maxWalletLeft(100n, 130n)).toBe(0n);
  });

  it('finds the largest buy that stays within the allowance', () => {
    const allowance = maxWalletCap(TOKEN_SUPPLY, 200);
    const rules = fees({ burnBuyBps: 50 });
    const best = maxBuyWithin(OPEN, 30, 100, rules, allowance);
    const at = quoteLaunchSwap(OPEN, 'buy', best, 30, 100, rules);
    expect(at.failure).toBeNull();
    expect(at.delivered! <= allowance).toBe(true);
    for (let k = 1n; k <= 100n; k++) {
      const q = quoteLaunchSwap(OPEN, 'buy', best + k, 30, 100, rules);
      expect(q.delivered === null || q.delivered > allowance).toBe(true);
    }
    expect(maxBuyWithin(OPEN, 30, 100, rules, 0n)).toBe(0n);
  });

  it('matches a brute-force search on a small pool, dust and all', () => {
    const small = { baseReserve: 50_000n, quoteReserve: 0n, virtualBase: 50_000n, virtualQuote: 10_000n };
    const rules = fees({ creatorFeeBps: 200, holderFeeBuyBps: 200, burnBuyBps: 100, eligible: 1n, minEligible: 1n });
    const quotes = Array.from({ length: 20_001 }, (_, a) => quoteLaunchSwap(small, 'buy', BigInt(a), 30, 100, rules));
    expect(quotes[20_000]!.failure).toBe('insufficient_liquidity');
    for (const allowance of [0n, 1n, 7n, 9n, 100n, 2_500n, 30_000n, 49_999n, 10n ** 9n]) {
      let brute = 0n;
      quotes.forEach((q, a) => {
        if (q.failure === null && q.delivered! <= allowance) brute = BigInt(a);
      });
      expect(maxBuyWithin(small, 30, 100, rules, allowance)).toBe(brute);
    }
  });

  it('finds the most a curve can still fill and whether a buy graduates (§8.2)', () => {
    const rules = fees({ burnBuyBps: 50 });
    const max = curveMaxBuyIn(OPEN, 30, 100, rules);
    expect(quoteLaunchSwap(OPEN, 'buy', max, 30, 100, rules).failure).toBeNull();
    expect(quoteLaunchSwap(OPEN, 'buy', max + 1n, 30, 100, rules).failure).toBe('insufficient_liquidity');
    const graduation = curveParams(TOKEN_SUPPLY, CURVE_BPS, OPEN.virtualQuote)!.graduationQuote;
    expect(buyGraduates(OPEN, quoteLaunchSwap(OPEN, 'buy', max, 30, 100, rules), graduation)).toBe(true);
    // The threshold exactly: the reserve gains what went into the curve, after the creator and holder fees, the LP fee and the protocol fee.
    const q = quoteLaunchSwap(OPEN, 'buy', 1_000_000_000n, 30, 100, rules);
    expect(launchSwapToReserve('buy', q)).toBe(q.received - q.lpFee - q.protocolFee);
    expect(buyGraduates(OPEN, q, graduation)).toBe(false);
    expect(buyGraduates(OPEN, q, q.netIn)).toBe(true);
    expect(buyGraduates(OPEN, q, q.netIn + 1n)).toBe(false);
    // A buy that takes every token left graduates whatever the reserve: nothing compounds, so the threshold may only be met at the sell-out.
    // (A pool where a lamport buys less than a token, so the curve's last token can be bought exactly.)
    const last = { baseReserve: 100n, quoteReserve: 0n, virtualBase: 100n, virtualQuote: 1_000_000n };
    const all = quoteLaunchSwap(last, 'buy', curveMaxBuyIn(last, 30, 100, rules), 30, 100, rules);
    expect(all.amountOut).toBe(last.baseReserve);
    expect(buyGraduates(last, all, 10n ** 18n)).toBe(true);
    expect(buyGraduates(last, quoteLaunchSwap(last, 'buy', 1_000_000n, 30, 100, rules), 10n ** 18n)).toBe(false);
    expect(buyGraduates(OPEN, quoteLaunchSwap(OPEN, 'buy', max + 1n, 30, 100, rules), 0n)).toBe(false);
  });

  it('caps the creator first buy with its own fees, no holder fee, at the opening reserves (§8.2)', () => {
    const curve = curveParams(TOKEN_SUPPLY, CURVE_BPS, 28_125_000_000n)!;
    const share = LAUNCH_PROTOCOL_SHARE_BPS;
    const rules = HOLDERS;
    const max = devBuyMaxLamports(curve, TOKEN_SUPPLY, rules, 50, 30, share)!;
    const firstBuy = fees({ creatorFeeBps: 50, holderFeeBuyBps: 0 });
    const cap = maxWalletCap(TOKEN_SUPPLY, 200);
    expect(quoteLaunchSwap(OPEN, 'buy', max, 30, share, firstBuy).delivered! <= cap).toBe(true);
    expect(quoteLaunchSwap(OPEN, 'buy', max + 1n, 30, share, firstBuy).delivered! > cap).toBe(true);
    // About 0.51 SOL buys 2% of the supply at the opening price.
    expect(max > 500_000_000n && max < 530_000_000n).toBe(true);
    // The holder fee is never counted; a buy burn lets a larger input through; no max wallet, no cap.
    expect(devBuyMaxLamports(curve, TOKEN_SUPPLY, { ...rules, holderFeeBuyBps: 200 }, 50, 30, share)).toBe(max);
    expect(devBuyMaxLamports(curve, TOKEN_SUPPLY, { ...rules, burnBuyBps: 100 }, 50, 30, share)! > max).toBe(true);
    expect(devBuyMaxLamports(curve, TOKEN_SUPPLY, NO_RULES, 100, 30, share)).toBeNull();
    // Diamond hands (max wallet 1%) caps the first buy at about half of that.
    const diamond = devBuyMaxLamports(curve, TOKEN_SUPPLY, preset('Diamond hands'), 50, 30, share)!;
    expect(diamond > 240_000_000n && diamond < 265_000_000n).toBe(true);
  });
});

describe('v2 holder rewards: the kit accounting and its mirror (§4.4, §4.7, §4.8, §4.10, §4.13, the review fixes)', () => {
  const ZERO: KitHookData = { snapshot: 0n, owed: 0n, earlyLocked: 0n };
  /** The time the kit's own unit tests start at. */
  const NOW = 1_800_000_000;
  const HOUR = SHARE_STREAM_SECS;
  const kit = (o: Partial<KitRewards> = {}): KitRewards => ({ eligible: 0n, minEligible: MIN_ELIGIBLE, accPerShare: 0n, rem: 0n, held: 0n, seen: 0n, streamRemaining: 0n, streamLast: 0, streamEnd: 0, streamNext: 0n, totalDistributed: 0n, totalClaimed: 0n, totalShared: 0n, ...o });
  /** The stream: what runs, what waits for it, the last release and the running stream's end. */
  const stream = (k: KitRewards): [bigint, bigint, number, number] => [k.streamRemaining, k.streamNext, k.streamLast, k.streamEnd];
  /** A share as the kit's unit tests make it (`share_at`): the sync, the lamports into the vault, then `add_share`; no minimum. */
  const shareAt = (k: KitRewards, vault: bigint, amount: bigint, now: number): { k: KitRewards; vault: bigint } => ({ k: kitAddShare(kitSync(k, vault, now)!, amount, now)!, vault: vault + amount });

  it('decodes the 64 bytes of hook data little-endian', () => {
    const data = { snapshot: (1n << 64n) + 5n, owed: 0x0102030405060708n, earlyLocked: 42n };
    const bytes = encodeKitHookData(data);
    expect(bytes.length).toBe(64);
    expect([...bytes.slice(0, 16)]).toEqual([5, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect([...bytes.slice(16, 24)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect([...bytes.slice(24, 32)]).toEqual([42, 0, 0, 0, 0, 0, 0, 0]);
    expect(bytes.slice(32).every((b) => b === 0)).toBe(true);
    expect(decodeKitHookData(bytes)).toEqual(data);
    // Read in place from a larger account buffer.
    const account = new Uint8Array(100);
    account.set(bytes, 20);
    expect(decodeKitHookData(account.subarray(20, 84))).toEqual(data);
    expect(decodeKitHookData(new Uint8Array(64))).toEqual(ZERO);
    expect(() => decodeKitHookData(new Uint8Array(63))).toThrow(RangeError);
    const max = { snapshot: (1n << 128n) - 1n, owed: (1n << 64n) - 1n, earlyLocked: (1n << 64n) - 1n };
    expect(decodeKitHookData(encodeKitHookData(max))).toEqual(max);
    expect(() => encodeKitHookData({ ...max, snapshot: 1n << 128n })).toThrow(RangeError);
    expect(() => encodeKitHookData({ ...max, owed: 1n << 64n })).toThrow(RangeError);
  });

  it('pays the economics hand example at most what came in', () => {
    // One holder of 1.5e12 base units, settled at 0; inflows of 2, 0, 1, 1, 1 lamports, a sync after each.
    const balance = 1_500_000_000_000n;
    let k = kit({ eligible: balance });
    let vault = 0n;
    const owed: bigint[] = [];
    for (const inflow of [2n, 0n, 1n, 1n, 1n]) {
      vault += inflow;
      k = kitSync(k, vault, 0)!;
      owed.push(rewardsClaimable(k, vault, 0, balance, ZERO)!.claimable);
    }
    expect(owed).toEqual([1n, 1n, 3n, 3n, 4n]);
    expect(owed.every((o) => o <= 5n)).toBe(true);
    expect([k.accPerShare, k.rem, k.totalDistributed]).toEqual([3n, 500_000_000_000n, 5n]);
    // The mirror reaches the same figure without the intermediate syncs.
    expect(rewardsClaimable(kit({ eligible: balance }), 5n, 0, balance, ZERO)).toEqual({ claimable: 4n, payable: 4n });
  });

  it('holds direct donations while nobody or too little is eligible, then distributes them', () => {
    let k = kitSync(kit({ eligible: MIN_ELIGIBLE - 1n }), 10n, 0)!;
    expect([k.held, k.seen, k.accPerShare, k.totalDistributed]).toEqual([10n, 10n, 0n, 0n]);
    expect(rewardTotals(k, 10n, 0)).toEqual({ distributed: 0n, claimed: 0n, shared: 0n, streaming: 0n, released: 0n, held: 10n });
    // A buy brings the eligible supply to 1.5e12; the buyer was settled at 0.
    k = { ...k, eligible: 1_500_000_000_000n };
    expect(rewardsClaimable(k, 10n, 0, 1_500_000_000_000n, ZERO)).toEqual({ claimable: 9n, payable: 9n });
    expect(rewardTotals(k, 10n, 0)).toEqual({ distributed: 10n, claimed: 0n, shared: 0n, streaming: 0n, released: 0n, held: 0n });
    // Nobody eligible at all holds too, rather than dividing by zero.
    expect(kitSync(kit({ eligible: 0n, minEligible: 0n }), 5n, 0)).toMatchObject({ held: 5n, accPerShare: 0n });
    // Without holder rewards nothing is ever claimable.
    expect(rewardsClaimable({ ...k, modules: 2 | 4 }, 10n, 0, 1_500_000_000_000n, ZERO)).toEqual({ claimable: 0n, payable: 0n });
  });

  it('streams a share over the hour to whoever holds as it is released', () => {
    const balance = 1_500_000_000_000n;
    const shared = kitShare(kit({ eligible: balance }), 0n, 3_600_000n, 0)!;
    let k = shared.state;
    const vault = shared.vault;
    expect([k.seen, k.streamRemaining, k.streamEnd, k.totalShared]).toEqual([3_600_000n, 3_600_000n, 3_600, 3_600_000n]);
    expect(streamReleased(k, 0)).toBe(0n);
    expect(streamReleased(k, 900)).toBe(900_000n);
    expect(streamReleased(k, 5_000)).toBe(3_600_000n);
    expect(rewardsClaimable(k, vault, 0, balance, ZERO)!.claimable).toBe(0n);
    expect(rewardsClaimable(k, vault, 1_800, balance, ZERO)!.claimable).toBe(1_800_000n);
    expect(rewardTotals(k, vault, 1_800)).toEqual({ distributed: 1_800_000n, claimed: 0n, shared: 3_600_000n, streaming: 1_800_000n, released: 1_800_000n, held: 0n });
    expect(rewardsClaimable(k, vault, 3_600, balance, ZERO)!.claimable).toBe(3_600_000n);
    expect(rewardsClaimable(k, vault, 99_999, balance, ZERO)!.claimable).toBe(3_600_000n);
    // Someone buys as much at 1,800 s: settled at that moment, so it shares only what is released after.
    k = kitSync(k, vault, 1_800)!;
    const buyer = kitSettle(ZERO, 0n, balance, k.accPerShare)!;
    k = { ...k, eligible: 2n * balance };
    expect(rewardsClaimable(k, vault, 3_600, balance, ZERO)!.claimable).toBe(2_700_000n);
    expect(rewardsClaimable(k, vault, 3_600, balance, buyer)!.claimable).toBe(900_000n);
    // A share is refused while nobody is eligible, below 0.001 SOL and without holder rewards.
    expect(kitShare(kit(), 0n, 3_600_000n, 0)).toBeNull();
    expect(kitShare(kit({ eligible: balance }), 0n, MIN_SHARE_LAMPORTS - 1n, 0)).toBeNull();
    expect(kitShare(kit({ eligible: balance, modules: 2 }), 0n, 3_600_000n, 0)).toBeNull();
    // A donation straight to the vault is distributed at once.
    expect(rewardsClaimable(kit({ eligible: MIN_ELIGIBLE }), 1_000n, 0, MIN_ELIGIBLE, ZERO)!.claimable).toBe(1_000n);
    // Over 1.5e12 eligible units the same 1,000 lamports pay 999: 1,000e12 / 1.5e12 floors to 666 per unit.
    expect(rewardsClaimable(kit({ eligible: balance }), 1_000n, 0, balance, ZERO)!.claimable).toBe(999n);
  });

  it('pauses the stream while nobody is eligible (the kit test the_stream_pauses_while_nobody_is_eligible)', () => {
    let c = kitAddShare(kit({ eligible: MIN_ELIGIBLE }), 3_600_000n, NOW)!;
    expect([c.streamLast, c.streamEnd]).toEqual([NOW, NOW + HOUR]);
    c = kitSync(c, 3_600_000n, NOW + 600)!;
    expect([c.streamRemaining, c.totalDistributed]).toEqual([3_000_000n, 600_000n]);
    // Below min_eligible: ten minutes, then an hour, release nothing; the end moves on with the clock.
    c = { ...c, eligible: MIN_ELIGIBLE - 1n };
    c = kitSync(c, 3_600_000n, NOW + 1_200)!;
    c = kitSync(c, 3_600_000n, NOW + 4_800)!;
    expect(c.streamRemaining).toBe(3_000_000n);
    expect([c.held, c.totalDistributed]).toEqual([0n, 600_000n]);
    expect([c.streamLast, c.streamEnd]).toEqual([NOW + 4_800, NOW + 4_800 + 3_000]);
    // The mirror agrees: nothing released while paused, and nothing is still streaming but the share.
    expect(streamReleased(c, NOW + 9_000)).toBe(0n);
    expect(rewardTotals(c, 3_600_000n, NOW + 9_000)).toMatchObject({ streaming: 3_000_000n, released: 0n, held: 0n });
    // Eligible again: the stream resumes at its rate.
    c = kitSync({ ...c, eligible: MIN_ELIGIBLE }, 3_600_000n, NOW + 4_800)!;
    expect(c.streamRemaining).toBe(3_000_000n);
    expect(streamReleased(c, NOW + 5_400)).toBe(600_000n);
    c = kitSync(c, 3_600_000n, NOW + 5_400)!;
    expect([c.streamRemaining, c.totalDistributed]).toEqual([2_400_000n, 1_200_000n]);
    c = kitSync(c, 3_600_000n, NOW + 4_800 + 3_000)!;
    expect([c.streamRemaining, c.totalDistributed]).toEqual([0n, 3_600_000n]);
  });

  it('lets a share wait for the running stream, then stream its own hour (a_share_waits_for_the_running_stream_then_streams_its_own_hour)', () => {
    let { k: c, vault } = shareAt(kit({ eligible: MIN_ELIGIBLE }), 0n, 3_600_000n, NOW);
    expect(stream(c)).toEqual([3_600_000n, 0n, NOW, NOW + HOUR]);
    expect(shareStartsAt(c, vault, NOW)).toBe(NOW);
    // Another in the same second joins it: the same hour, each at its own rate.
    ({ k: c, vault } = shareAt(c, vault, 1_800_000n, NOW));
    expect(stream(c)).toEqual([5_400_000n, 0n, NOW, NOW + HOUR]);
    // Half an hour on, a share waits for the running stream, which keeps its end and its rate.
    expect(shareStartsAt(c, vault, NOW + 1_800)).toBe(NOW + HOUR);
    ({ k: c, vault } = shareAt(c, vault, 7_200_000n, NOW + 1_800));
    expect(stream(c)).toEqual([2_700_000n, 7_200_000n, NOW + 1_800, NOW + HOUR]);
    // A later one waits with it, for the same hour.
    ({ k: c, vault } = shareAt(c, vault, 3_600_000n, NOW + 3_000));
    expect(stream(c)).toEqual([900_000n, 10_800_000n, NOW + 3_000, NOW + HOUR]);
    expect(c.totalDistributed).toBe(4_500_000n);
    // The running stream is out at its end; the waiting shares stream over the hour after it.
    expect(streamAt(c, NOW + HOUR - 1)).toEqual({ released: 898_500n, streamRemaining: 1_500n, streamNext: 10_800_000n });
    expect(streamAt(c, NOW + HOUR)).toEqual({ released: 900_000n, streamRemaining: 10_800_000n, streamNext: 0n });
    expect(streamAt(c, NOW + HOUR + 360)).toEqual({ released: 1_980_000n, streamRemaining: 9_720_000n, streamNext: 0n });
    expect(rewardTotals(c, vault, NOW + HOUR + 360)).toMatchObject({ released: 1_980_000n, streaming: 9_720_000n });
    // A share made then waits for that hour: it starts when the waiting shares' hour ends.
    expect(shareStartsAt(c, vault, NOW + HOUR + 360)).toBe(NOW + 2 * HOUR);
    c = kitSync(c, vault, NOW + HOUR + 360)!;
    expect(c.totalDistributed).toBe(4_500_000n + 1_980_000n);
    expect(stream(c)).toEqual([9_720_000n, 0n, NOW + HOUR + 360, NOW + 2 * HOUR]);
    ({ k: c, vault } = shareAt(c, vault, 360_000n, NOW + HOUR + 400));
    expect(stream(c)).toEqual([9_600_000n, 360_000n, NOW + HOUR + 400, NOW + 2 * HOUR]);
    c = kitSync(c, vault, NOW + 2 * HOUR + 1_800)!;
    expect(stream(c)).toEqual([180_000n, 0n, NOW + 2 * HOUR + 1_800, NOW + 3 * HOUR]);
    c = kitSync(c, vault, NOW + 3 * HOUR)!;
    expect([c.streamRemaining, c.streamNext]).toEqual([0n, 0n]);
    expect([c.totalDistributed, c.totalShared, c.seen]).toEqual([vault, vault, vault]);
    // A share without the sync at its time would wait behind a stream that may already be over: refused, as a bug.
    const d = kitAddShare(kit({ eligible: MIN_ELIGIBLE }), 3_600_000n, NOW)!;
    expect(kitAddShare(d, 1_000_000n, NOW + 10)).toBeNull();
    const synced = kitAddShare(kitSync(d, 3_600_000n, NOW + 10)!, 1_000_000n, NOW + 10)!;
    expect([synced.streamNext, synced.streamEnd]).toEqual([1_000_000n, NOW + HOUR]);
  });

  it('keeps a waiting share waiting through a pause (a_waiting_share_waits_through_a_pause)', () => {
    let { k: c, vault } = shareAt(kit({ eligible: MIN_ELIGIBLE }), 0n, 3_600_000n, NOW);
    ({ k: c, vault } = shareAt(c, vault, 1_800_000n, NOW + 600));
    expect(stream(c)).toEqual([3_000_000n, 1_800_000n, NOW + 600, NOW + HOUR]);
    // Nobody eligible for an hour and a half: nothing released; the running stream's end, and with it the waiting share's hour, moves on.
    c = { ...c, eligible: MIN_ELIGIBLE - 1n };
    c = kitSync(c, vault, NOW + 1_200)!;
    c = kitSync(c, vault, NOW + 6_000)!;
    expect(stream(c)).toEqual([3_000_000n, 1_800_000n, NOW + 6_000, NOW + 9_000]);
    expect(streamAt(c, NOW + 50_000)).toEqual({ released: 0n, streamRemaining: 3_000_000n, streamNext: 1_800_000n });
    expect([c.totalDistributed, c.held]).toEqual([600_000n, 0n]);
    expect(shareStartsAt(c, vault, NOW + 6_000)).toBeNull();
    // Eligible again: the running stream's 3,000 s, then the waiting share's hour.
    c = kitSync({ ...c, eligible: MIN_ELIGIBLE }, vault, NOW + 6_000)!;
    const end = NOW + 9_000;
    expect(streamAt(c, end)).toEqual({ released: 3_000_000n, streamRemaining: 1_800_000n, streamNext: 0n });
    expect(streamAt(c, end + 1_800)).toEqual({ released: 3_900_000n, streamRemaining: 900_000n, streamNext: 0n });
    c = kitSync(c, vault, end + 1_800)!;
    expect(stream(c)).toEqual([900_000n, 0n, end + 1_800, end + HOUR]);
    // Paused again half way through that hour: it keeps the half it had left.
    c = kitSync({ ...c, eligible: 0n }, vault, end + 10_000)!;
    expect(stream(c)).toEqual([900_000n, 0n, end + 10_000, end + 11_800]);
    c = kitSync({ ...c, eligible: MIN_ELIGIBLE }, vault, end + 10_000)!;
    c = kitSync(c, vault, end + 11_800)!;
    expect([c.streamRemaining, c.totalDistributed, c.held]).toEqual([0n, 5_400_000n, 0n]);
    // A share now (nothing streams or waits) starts at once.
    expect(shareStartsAt(c, vault, end + 11_900)).toBe(end + 11_900);
  });

  it('mirrors the sync on random states (the kit test the_mirror_matches_the_sync)', () => {
    const MASK = (1n << 64n) - 1n;
    let rng = 0x5deece66d1ce4e5bn;
    const next = (n: bigint): bigint => {
      rng ^= (rng << 13n) & MASK;
      rng ^= rng >> 7n;
      rng ^= (rng << 17n) & MASK;
      return rng % (n > 1n ? n : 1n);
    };
    let startedWaiting = 0;
    for (let i = 0; i < 20_000; i++) {
      const pick = next(4n);
      const eligible = pick === 0n ? 0n : pick === 1n ? MIN_ELIGIBLE - 1n - next(1_000n) : MIN_ELIGIBLE + next(1n << 50n);
      const accPerShare = next(1n << 40n);
      const rem = next(eligible > 1n ? eligible : 1n);
      const held = next(1n << 30n);
      const streamLast = NOW + Number(next(1_000n));
      const streamEnd = streamLast + 1 + Number(next(BigInt(HOUR)));
      const streamRemaining = next(6n) === 0n ? 0n : 1n + next(1n << 40n);
      const streamNext = next(3n) === 0n ? 0n : next(1n << 40n);
      const totalClaimed = next(1n << 40n);
      const seen = next(1n << 41n);
      const totalDistributed = next(1n << 42n);
      const c = kit({ eligible, accPerShare, rem, held, streamLast, streamEnd, streamRemaining, streamNext, totalClaimed, seen, totalDistributed });
      const vault = (seen > totalClaimed ? seen - totalClaimed : 0n) + next(1n << 30n);
      const now = streamLast - 100 + Number(next(BigInt(2 * HOUR + 4_000)));
      const m = kitSynced(c, vault, now)!;
      const s = kitSync(c, vault, now)!;
      expect([m.accPerShare, m.held, m.streamRemaining, m.streamNext, m.distributed]).toEqual([s.accPerShare, s.held, s.streamRemaining, s.streamNext, s.totalDistributed]);
      expect(m.released).toBe(c.streamRemaining + c.streamNext - s.streamRemaining - s.streamNext);
      expect(m.streaming).toBe(s.streamRemaining + s.streamNext);
      expect(kitRelease(c, now)!.released).toBe(m.released);
      if (c.streamNext > 0n && s.streamNext === 0n) startedWaiting += 1;
    }
    expect(startedWaiting > 1_000).toBe(true);
  });

  it('settles at the balance before a change, forgets an empty holding, gives the pool and the launch nothing, and caps a claim at the vault', () => {
    expect(kitSettle({ snapshot: 2n * SCALE, owed: 7n, earlyLocked: 3n }, 5n, 5n, 5n * SCALE)).toEqual({ snapshot: 5n * SCALE, owed: 22n, earlyLocked: 3n });
    // settle_rounds_down_and_forgets_an_empty_holding.
    const d = kitSettle({ snapshot: 10n, owed: 7n, earlyLocked: 3n }, 1_500_000_000_000n, 1n, 11n)!;
    expect([d.owed, d.snapshot, d.earlyLocked]).toEqual([8n, 11n, 3n]);
    expect(kitSettle(d, 5n, 0n, 1_000_000_000_011n)).toMatchObject({ owed: 13n, snapshot: 0n });
    // A snapshot above the accumulator is impossible: a bug, refused; the mirror cannot read it either.
    expect(kitSettle({ ...ZERO, snapshot: 5n }, 1n, 1n, 4n)).toBeNull();
    const k = kit({ eligible: 10n, minEligible: 1n, accPerShare: 3n * SCALE, seen: 4n });
    expect(rewardsClaimable(k, 4n, 0, 10n, { ...ZERO, snapshot: 4n * SCALE })).toBeNull();
    expect(rewardsClaimable(k, 4n, 0, 10n, ZERO)).toEqual({ claimable: 30n, payable: 4n });
    expect(rewardsClaimable(k, 4n, 0, 10n, ZERO, true)).toEqual({ claimable: 0n, payable: 0n });
    // A claim pays what the vault holds, keeps the rest owed and never touches the early-buyer bytes.
    const claim = kitClaim(k, 4n, 0, 10n, { ...ZERO, earlyLocked: 99n })!;
    expect([claim.pay, claim.vault, claim.data.owed, claim.data.earlyLocked, claim.state.totalClaimed]).toEqual([4n, 0n, 26n, 99n, 4n]);
    expect(kitClaim(k, 4n, 0, 10n, ZERO, true)).toBeNull();
    expect(kitClaim(kit({ eligible: 10n, minEligible: 1n }), 0n, 0, 10n, ZERO)).toBeNull();
    // A vault below what the accounting has seen is a shortfall the program reverts on.
    expect(rewardsClaimable(kit({ seen: 10n }), 5n, 0, 1n, ZERO)).toBeNull();
    expect(rewardTotals(kit({ seen: 10n }), 5n, 0)).toBeNull();
  });

  it('stays solvent through buys, sells, transfers, donations, shares and claims, each claim paying what the mirror said (seeded)', () => {
    let seed = 0x5eed;
    const rand = (n: number): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * n);
    };
    const supply = 1_000_000_000_000n;
    const holders = 5;
    const balances: bigint[] = Array.from({ length: holders }, () => 0n);
    const data: KitHookData[] = Array.from({ length: holders }, () => ZERO);
    let k = kit({ minEligible: minEligibleFor(supply) });
    let pool = supply;
    let vault = 0n;
    let now = 1_000;
    let inflows = 0n;
    let paid = 0n;
    let claims = 0;
    let shares = 0;
    let waited = 0;
    let below = 0;
    // A holder's settle at its balance before a change, to the balance after it.
    const settle = (i: number, after: bigint): void => {
      data[i] = kitSettle(data[i]!, balances[i]!, after, k.accPerShare)!;
      balances[i] = after;
    };
    for (let step = 0; step < 3_000; step++) {
      now += rand(600);
      const i = rand(holders);
      const j = rand(holders);
      // Most of every 1,000 steps trades freely; the last 300 only sell, receive inflows and claim, so
      // the eligible supply drains below the threshold, the stream pauses and the vault holds donations.
      const kind = step % 1_000 < 700 ? rand(6) : [1, 1, 3, 4][rand(4)]!;
      if (kind === 0) {
        // A buy: the pool (excluded) sends to holder i.
        const amount = BigInt(rand(1_000)) * 1_000_000n;
        if (amount > 0n && amount <= pool) {
          k = kitSync(k, vault, now)!;
          settle(i, balances[i]! + amount);
          pool -= amount;
          k = { ...k, eligible: k.eligible + amount };
        }
      } else if (kind === 1) {
        // A sell: holder i sends to the pool.
        const amount = balances[i]! / BigInt(1 + rand(4));
        if (amount > 0n) {
          k = kitSync(k, vault, now)!;
          settle(i, balances[i]! - amount);
          pool += amount;
          k = { ...k, eligible: k.eligible - amount };
        }
      } else if (kind === 2) {
        // Wallet to wallet: both sides settle, the eligible supply does not change.
        const amount = balances[i]! / BigInt(1 + rand(3));
        if (amount > 0n && i !== j) {
          k = kitSync(k, vault, now)!;
          settle(i, balances[i]! - amount);
          settle(j, balances[j]! + amount);
        }
      } else if (kind === 3) {
        // Holder fees or a direct donation reach the vault.
        const amount = BigInt(rand(100_000));
        vault += amount;
        inflows += amount;
      } else if (kind === 4) {
        // A claim pays exactly what the mirror said; with nothing to pay the kit refuses it.
        const expected = rewardsClaimable(k, vault, now, balances[i]!, data[i]!)!;
        const done = kitClaim(k, vault, now, balances[i]!, data[i]!);
        expect(done?.pay ?? 0n).toBe(expected.payable);
        if (done) {
          ({ state: k, vault } = done);
          data[i] = done.data;
          paid += done.pay;
          claims += 1;
        }
      } else {
        // A share: it streams now, or waits for the running stream.
        const amount = MIN_SHARE_LAMPORTS + BigInt(rand(2_000_000));
        const starts = shareStartsAt(k, vault, now);
        const done = kitShare(k, vault, amount, now);
        expect(done === null).toBe(starts === null);
        if (done) {
          if (done.state.streamNext > 0n) waited += 1;
          ({ state: k, vault } = done);
          inflows += amount;
          shares += 1;
        }
      }
      if (k.eligible < k.minEligible) below += 1;
      // The vault covers what every holder could claim, plus what is held and what is still streaming or waiting.
      const synced = kitSynced(k, vault, now)!;
      let claimable = 0n;
      for (let h = 0; h < holders; h++) claimable += rewardsClaimable(k, vault, now, balances[h]!, data[h]!)!.claimable;
      expect(claimable + synced.held + synced.streaming <= vault).toBe(true);
      expect(k.eligible).toBe(balances.reduce((a, b) => a + b, 0n));
      expect(vault + paid).toBe(inflows);
    }
    // The run went through claims, shares (some of them waiting) and stretches below the threshold.
    expect(claims > 50).toBe(true);
    expect(shares > 20).toBe(true);
    expect(waited > 5).toBe(true);
    expect(below > 50).toBe(true);
  });
});


describe('the LP fee of a launch pool (the DEX upgrade of 2026-10-08)', () => {
  it('goes to Bordrless on every launch pool from the upgrade on, whenever the pool was made; never on an ordinary pool', () => {
    expect(LP_FEE_TO_PROTOCOL_FROM_SLOT).toBe(454_439_142);
    expect(LP_FEE_TO_PROTOCOL_FROM_TIME).toBe(1_791_434_238);
    const t = LP_FEE_TO_PROTOCOL_FROM_TIME;
    expect(lpFeeToProtocol(true, t, 'mainnet')).toBe(true);
    expect(lpFeeToProtocol(true, t + 1, 'mainnet')).toBe(true);
    expect(lpFeeToProtocol(true, t - 1, 'mainnet')).toBe(true);
    expect(lpFeeToProtocol(true, 0, 'devnet')).toBe(true);
    expect(lpFeeToProtocol(true, 0, 'localnet')).toBe(true);
    // An ordinary pool's LP fee is its liquidity's, whenever it was made.
    expect(lpFeeToProtocol(false, t + 1, 'mainnet')).toBe(false);
    expect(lpFeeToProtocol(false, t + 1, 'localnet')).toBe(false);
  });
});

describe('Half-Life', () => {
  it('mirrors the program’s fee curve: 20% at 0, halved every six hours, 0 from 48 h', () => {
    const h = HALF_LIFE.halfLifeSecs;
    // The same points as programs/half_life's unit tests.
    expect(halfLifeFeePpm(-5)).toBe(200_000);
    expect(halfLifeFeePpm(0)).toBe(200_000);
    expect(halfLifeFeePpm(h / 2)).toBe(150_000);
    expect(halfLifeFeePpm(h)).toBe(100_000);
    expect(halfLifeFeePpm(2 * h)).toBe(50_000);
    expect(halfLifeFeePpm(3 * h)).toBe(25_000);
    expect(halfLifeFeePpm(4 * h)).toBe(12_500);
    expect(halfLifeFeePpm(7 * h)).toBe(1_562);
    expect(halfLifeFeePpm(8 * h - 1)).toBe(782);
    expect(halfLifeFeePpm(8 * h)).toBe(0);
    let last = Infinity;
    for (let age = 0; age < 9 * h; age += 97) {
      expect(halfLifeFeePpm(age)).toBeLessThanOrEqual(last);
      last = halfLifeFeePpm(age);
    }
  });

  it('names the deployed hook and its launch config, and is a path of the launch form', () => {
    expect(PROGRAM_IDS.halfLife).toBe('53SpmtkdPWQ63mWoDeXk8P9tuwiT4ed2Wx4fwfy5NSF8');
    expect(HALF_LIFE.program).toBe(PROGRAM_IDS.halfLife);
    expect(HALF_LIFE.flags).toBe(TOKEN_HOOK_FLAGS.BEFORE_TRANSFER | TOKEN_HOOK_FLAGS.TRANSFER_RETURNS_DELTA | TOKEN_HOOK_FLAGS.WRITES_HOOK_DATA);
    expect(RULE_PATHS.map((p) => p.name)).toContain('Half-Life');
  });
});

describe('companion templates', () => {
  it('split every creator fee claim in full, in the order the form offers them', () => {
    expect(COMPANION_TEMPLATE_LIST).toEqual(['buysItself', 'rugProofDev', 'buybackAndReward']);
    for (const t of COMPANION_TEMPLATE_LIST) {
      const s = COMPANION_SPLITS[t];
      expect(s.buybackBps + s.holdersBps + s.beneficiaryBps, t).toBe(10_000);
    }
    expect(COMPANION_TEMPLATE_LIST.filter(companionPaysHolders)).toEqual(['rugProofDev', 'buybackAndReward']);
    // The token that buys itself has no dev at all: no first buy.
    expect(COMPANION_TEMPLATE_LIST.filter(companionTakesFirstBuy)).toEqual(['rugProofDev', 'buybackAndReward']);
    expect(COMPANION_VEST_CHOICES_DAYS).toContain(COMPANION_DEFAULT_VEST_DAYS);
  });

  it('names the template of a split, and none for any other', () => {
    expect(companionTemplateOf({ buybackBps: 0, holdersBps: 5_000, beneficiaryBps: 5_000 })).toBe('rugProofDev');
    expect(companionTemplateOf({ buybackBps: 10_000, holdersBps: 0, beneficiaryBps: 0 })).toBe('buysItself');
    expect(companionTemplateOf({ buybackBps: 2_500, holdersBps: 2_500, beneficiaryBps: 5_000 })).toBeNull();
  });
});

describe('a custom split of the creator fee', () => {
  const rewards = { ...NO_RULES, holderFeeBuyBps: 50, holderFeeSellBps: 50 };
  const split = (buybackBps: number, holdersBps: number, beneficiaryBps: number) => ({ buybackBps, holdersBps, beneficiaryBps });

  it('reads a request’s split, or a template’s, and nothing malformed', () => {
    expect(companionRequestSplit({ split: split(5_000, 2_000, 3_000), vestDays: 7 })).toEqual(split(5_000, 2_000, 3_000));
    expect(companionRequestSplit({ template: 'buybackAndReward' })).toEqual(COMPANION_SPLITS.buybackAndReward);
    // A split wins over a template; a split with a bad share is not read as the template.
    expect(companionRequestSplit({ template: 'buysItself', split: split(0, 0, 10_000) })).toEqual(LAUNCHER_SPLIT);
    for (const bad of [null, 'buysItself', {}, { template: 'nope' }, { split: null }, { split: split(5_000.5, 0, 4_999.5) }, { split: split(-1, 0, 10_001) }, { split: { buybackBps: '5000', holdersBps: 0, beneficiaryBps: 5_000 } }, { split: split(20_000, 0, 0) }]) {
      expect(companionRequestSplit(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('refuses what the program refuses, in plain sentences, and takes every split that adds up', () => {
    expect(companionSplitProblem(split(5_000, 5_000, 0), rewards, 100)).toBeNull();
    expect(companionSplitProblem(split(7_000, 0, 3_000), NO_RULES, 50)).toBeNull();
    expect(companionSplitProblem(LAUNCHER_SPLIT, NO_RULES, 100)).toBeNull();
    expect(companionSplitProblem(split(5_000, 4_000, 0), rewards, 100)).toMatch(/add up to 100%/);
    expect(companionSplitProblem(split(5_000, 5_000, 1), rewards, 100)).toMatch(/add up to 100%/);
    expect(companionSplitProblem(split(5_000.5, 4_999.5, 0), rewards, 100)).toMatch(/whole number/);
    expect(companionSplitProblem(split(10_000, 0, 0), { ...NO_RULES, creatorLockDays: 30 }, 100)).toMatch(/creator wallet lock/);
    expect(companionSplitProblem(split(10_000, 0, 0), NO_RULES, 0)).toMatch(/no creator fee/);
    expect(companionSplitProblem(split(0, 10_000, 0), NO_RULES, 100)).toBe('A share of the creator fee for holders needs holder rewards on.');
    expect(companionSplitProblem(split(0, 10_000, 0), { ...NO_RULES, holderFeeSellBps: 100 }, 100)).toBeNull();
  });

  it('knows a split with a dev and one that pays holders', () => {
    expect([split(10_000, 0, 0), split(9_000, 0, 1_000), split(0, 10_000, 0)].map(splitTakesFirstBuy)).toEqual([false, true, true]);
    expect([split(10_000, 0, 0), split(9_000, 1_000, 0)].map(splitPaysHolders)).toEqual([false, true]);
    expect([LAUNCHER_SPLIT, split(0, 1, 9_999)].map(isLauncherSplit)).toEqual([true, false]);
    expect(COMPANION_DEFAULT_VEST_DAYS).toBeLessThanOrEqual(COMPANION_MAX_VEST_DAYS);
  });
});
