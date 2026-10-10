/**
 * The launch policy and the pool math, mirroring `crates/bordrless-core` bit for bit (integer
 * math in bigint), and the kit's reward accounting with its off-chain mirror, mirroring
 * `bordrless_kit::math` and `bordrless_kit::mirror`. The numbers the site shows and the numbers
 * the backend builds transactions from come from here. `vectors.test.ts` runs every case of
 * `programs/tests/vectors/launch-fees.json`, which the Rust tests render from the reference the
 * programs are held to, and requires exact equality.
 */
import type { CompanionSplitBps, CompanionTemplate, GameKindName, GameRequest, GameRolloverReason, JackpotRequest, LaunchRules, LaunchRulesInput, LotteryRequest, Side, StreakRequest } from './api.ts';
import type { StudioGameSettings } from './studio.ts';
import { HOOK_DATA_LEN, TOKEN_HOOK_FLAGS } from './programs.ts';

export const BPS = 10_000n;
export const WAD = 10n ** 18n;
/** The largest u64, where the programs' checked arithmetic stops. */
export const U64_MAX = (1n << 64n) - 1n;
/** The largest u128 (the kit's `acc_per_share` and `rem`). */
export const U128_MAX = (1n << 128n) - 1n;

/** Decimals of a launched token. */
export const TOKEN_DECIMALS = 6;
/** Supply of a launched token, base units: one billion whole tokens. */
export const TOKEN_SUPPLY = 1_000_000_000n * 1_000_000n;
/** Share of the supply sold on the curve; the rest is reserved for graduation. */
export const CURVE_BPS = 7_500n;
/** LP fee of a launch pool, which stays in the pool for ever. */
export const LP_FEE_BPS = 30;
/** Protocol fee of an ordinary DEX pool (anyone's pool), in basis points of the quote side: the flat model (§3.1). */
export const PROTOCOL_FEE_BPS = 100;
/**
 * Bordrless's take on a launch pool (its curve and the same pool after graduation), the share
 * model of §3.1 (2026-10-07: "we earn 25% of their total fees, not 0.25%"): a quarter of what the
 * launch's rules collect on each swap (the creator fee, holder rewards and any cut a creator's own
 * hook takes), in SOL, rounded up, never more than the cuts. Burns and the pool's LP fee are not
 * collected by anyone and are not shared. A launch whose rules collect nothing pays Bordrless
 * nothing. Every launch-side figure uses this one; the flat rate above is for ordinary pools.
 */
export const LAUNCH_PROTOCOL_SHARE_BPS = 2_500;
/** The largest share the DEX config may set (`MAX_PROTOCOL_SHARE_BPS`): all of the cuts. */
export const MAX_PROTOCOL_SHARE_BPS = 10_000;
/** Largest creator fee a launch may choose. */
export const MAX_CREATOR_FEE_BPS = 200;
/** The creator fee choices offered on the launch form. */
export const CREATOR_FEE_CHOICES_BPS = [0, 50, 100, 200] as const;
/** Seconds after creation during which the LP fee is elevated against snipers. */
export const SNIPER_WINDOW_SECS = 30;
/** LP fee at the first second of the sniper window, falling linearly to LP_FEE_BPS. */
export const SNIPER_START_BPS = 8_000;
/** Paid by the creator to the treasury at launch. */
export const LAUNCH_FEE_LAMPORTS = 10_000_000n;
/** Bounds of the virtual quote reserve a launch may open with (bridged SOL, 9 decimals). */
export const MIN_VIRTUAL_QUOTE = 1_000_000_000n;
export const MAX_VIRTUAL_QUOTE = 10_000_000_000_000n;
/** LP units the pool keeps on the first deposit. */
export const MINIMUM_LIQUIDITY = 1_000n;
/** Decimals of an LP mint. */
export const LP_DECIMALS = 9;
/** Decimals of bridged SOL. */
export const SOL_DECIMALS = 9;
/** The dollar market cap a launch opens at; the backend sets the virtual quote to hit it. */
export const OPENING_MCAP_USD = 5_000;
/** Candle resolutions the API serves, in seconds. */
export const CANDLE_RESOLUTIONS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3_600, '4h': 14_400, '1d': 86_400 } as const;
export type CandleResolution = keyof typeof CANDLE_RESOLUTIONS;

export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  return (a * b) / d;
}

export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  const p = a * b;
  return p % d === 0n ? p / d : p / d + 1n;
}

/** A fee of `bps` on `amount`, rounded up. */
export function feeAmount(amount: bigint, bps: number | bigint): bigint {
  return mulDivCeil(amount, BigInt(bps), BPS);
}

/**
 * Bordrless's share of `value`, the quote value of what a launch pool's hooks cut from one side of
 * a swap (`bordrless_core::protocol_share`): `shareBps` of it, rounded up, never more than `value`
 * (a share is at most 10,000). Pure: 0 in gives 0 out, so a launch whose rules collect nothing pays
 * nothing.
 */
export function protocolShare(value: bigint, shareBps: number): bigint {
  if (!Number.isInteger(shareBps) || shareBps < 0 || shareBps > MAX_PROTOCOL_SHARE_BPS) throw new RangeError('a share is between 0 and 10,000 bps');
  return feeAmount(value, shareBps);
}

/**
 * The quote value of a base-side cut at the swap's own price (`bordrless_core::quote_value`):
 * `ceil(cut * quoteLeg / baseLeg)` over the quote and base the curve exchanged; 0 for no cut.
 * Only a creator's own token hook makes base-side cuts (the kit takes none); the launch quote math
 * here does not model them.
 */
export function quoteValue(base: bigint, quoteLeg: bigint, baseLeg: bigint): bigint {
  if (base === 0n) return 0n;
  return mulDivCeil(base, quoteLeg, baseLeg);
}

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('negative');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) / 2n;
    if (y >= x) return x;
    x = y;
  }
}

/** The reserves of a pool as the math sees them. */
export interface Reserves {
  baseReserve: bigint;
  quoteReserve: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
}

/** Constant-product output of `amountIn` (after fees), or null when nothing comes out or the output would exceed the real reserve. */
export function swapOut(amountIn: bigint, reserveIn: bigint, virtualIn: bigint, reserveOut: bigint, virtualOut: bigint): bigint | null {
  if (amountIn <= 0n) return null;
  const x = reserveIn + virtualIn;
  const y = reserveOut + virtualOut;
  const out = mulDivFloor(amountIn, y, x + amountIn);
  if (out <= 0n || out > reserveOut) return null;
  return out;
}

/**
 * The input (after fees) that buys exactly `amountOut`, rounded up; null when `amountOut` is above
 * the real reserve, when the curve can never give it (no virtual output reserve left beyond it), or
 * when the input would not fit a u64 (`bordrless_core::swap_in_for_out`).
 */
export function swapInForOut(amountOut: bigint, reserveIn: bigint, virtualIn: bigint, reserveOut: bigint, virtualOut: bigint): bigint | null {
  if (amountOut <= 0n || amountOut > reserveOut) return null;
  const x = reserveIn + virtualIn;
  const y = reserveOut + virtualOut;
  if (y - amountOut <= 0n) return null;
  const dx = mulDivCeil(amountOut, x, y - amountOut);
  return dx > U64_MAX ? null : dx;
}

/** The largest input (after fees) before the real output reserve is exhausted. */
export function maxSwapIn(reserveIn: bigint, virtualIn: bigint, reserveOut: bigint, virtualOut: bigint): bigint | null {
  return swapInForOut(reserveOut, reserveIn, virtualIn, reserveOut, virtualOut);
}

/** Spot price in quote base units per base base unit, times WAD. */
export function spotPriceWad(r: Reserves): bigint {
  return mulDivFloor(r.quoteReserve + r.virtualQuote, WAD, r.baseReserve + r.virtualBase);
}

/** Spot price as a number: quote whole units per base whole unit. */
export function spotPrice(r: Reserves, baseDecimals: number, quoteDecimals: number): number {
  const wad = spotPriceWad(r);
  return (Number(wad) / 1e18) * 10 ** (baseDecimals - quoteDecimals);
}

/**
 * The fees and the curve of one swap in the order of the v2 DEX (docs/hooks-v2.md §3.1),
 * `bordrless_core::SwapAmounts`. The LP fee is on the input in both directions and stays in the
 * pool; the protocol fee is always in the quote token, kept apart from the reserves: a buy's from
 * what reached the vault, before the curve, a sell's from the curve's output.
 */
export interface SwapAmounts {
  /** In the input token: `feeAmount(received, lpFeeBps)`. */
  lpFee: bigint;
  /** In the quote token: `feeAmount(received, protocolFeeBps)` on a buy, `feeAmount(outGross, protocolFeeBps)` on a sell. */
  protocolFee: bigint;
  /** What goes into the curve: what reached the vault less the LP fee and, on a buy, the protocol fee. */
  netIn: bigint;
  /** What the curve gives: it leaves the output reserve. */
  outGross: bigint;
  /** What the output side hands on: `outGross`, less a sell's protocol fee. A pool hook's `after_swap` is told this; without a hook it is delivered. */
  amountOut: bigint;
  /** What enters the input reserve: what reached the vault, less a buy's protocol fee. */
  toReserveIn: bigint;
}

/** Why the DEX refuses a swap (`bordrless_core::SwapFailure`): `FeeExceedsInput`, `InsufficientLiquidity`, `FeeExceedsOutput`. */
export type SwapFailure = 'fees_exceed_input' | 'insufficient_liquidity' | 'fee_exceeds_output';

/**
 * `bordrless_core::swap_amounts`: the amounts of a swap whose input vault received `received`
 * (after any `before_swap` cut), or why the DEX refuses it. A fee that does not fit a u64 is larger
 * than the amount it is taken from.
 */
export function swapAmounts(side: Side, received: bigint, lpFeeBps: number, protocolFeeBps: number, r: Reserves): (SwapAmounts & { failure: null }) | { failure: SwapFailure } {
  const buy = side === 'buy';
  const lpFee = feeAmount(received, lpFeeBps);
  const protocolIn = buy ? feeAmount(received, protocolFeeBps) : 0n;
  if (lpFee > U64_MAX || protocolIn > U64_MAX) return { failure: 'fees_exceed_input' };
  const netIn = received - lpFee - protocolIn;
  if (netIn <= 0n) return { failure: 'fees_exceed_input' };
  const outGross = buy ? swapOut(netIn, r.quoteReserve, r.virtualQuote, r.baseReserve, r.virtualBase) : swapOut(netIn, r.baseReserve, r.virtualBase, r.quoteReserve, r.virtualQuote);
  if (outGross === null) return { failure: 'insufficient_liquidity' };
  if (buy) return { lpFee, protocolFee: protocolIn, netIn, outGross, amountOut: outGross, toReserveIn: received - protocolIn, failure: null };
  const protocolFee = feeAmount(outGross, protocolFeeBps);
  if (protocolFee > U64_MAX || outGross - protocolFee <= 0n) return { failure: 'fee_exceeds_output' };
  return { lpFee, protocolFee, netIn, outGross, amountOut: outGross - protocolFee, toReserveIn: received, failure: null };
}

/**
 * A swap on a pool as the v2 DEX runs it (§3.1), `received` being what reached the input vault
 * (the caller applies a hook's `before_swap` cut first, and its `after_swap` cut to `amountOut`).
 * The protocol fee is in the quote token on both sides: a buy's from what reached the vault, a
 * sell's from the curve's output, so a sell's `amountOut` is the curve's output less it. On a
 * failure the fields are those computed up to it and `amountOut` is null.
 */
export function quoteSwap(
  r: Reserves,
  direction: Side,
  amountIn: bigint,
  lpFeeBps: number,
  protocolFeeBps: number,
): { lpFee: bigint; protocolFee: bigint; netIn: bigint; amountOut: bigint | null; outGross: bigint | null; toReserveIn: bigint; failure: SwapFailure | null } {
  const a = swapAmounts(direction, amountIn, lpFeeBps, protocolFeeBps, r);
  if (a.failure === null) return { lpFee: a.lpFee, protocolFee: a.protocolFee, netIn: a.netIn, amountOut: a.amountOut, outGross: a.outGross, toReserveIn: a.toReserveIn, failure: null };
  // What was computed up to the failure.
  const lpFee = feeAmount(amountIn, lpFeeBps);
  const protocolIn = direction === 'buy' ? feeAmount(amountIn, protocolFeeBps) : 0n;
  const netIn = amountIn - lpFee - protocolIn;
  const outGross = a.failure === 'fee_exceeds_output' ? curveOutput(r, direction, netIn) : null;
  const protocolFee = outGross === null ? protocolIn : feeAmount(outGross, protocolFeeBps);
  return { lpFee, protocolFee, netIn, amountOut: null, outGross, toReserveIn: amountIn - protocolIn, failure: a.failure };
}

/** First LP: sqrt(base · quote), of which MINIMUM_LIQUIDITY stays with the pool. */
export function initialLp(base: bigint, quote: bigint): { toDepositor: bigint; total: bigint } | null {
  const total = isqrt(base * quote);
  const toDepositor = total - MINIMUM_LIQUIDITY;
  if (toDepositor <= 0n) return null;
  return { toDepositor, total };
}

/** A later deposit: what is taken at the pool's ratio and the LP minted. */
export function lpForDeposit(baseDesired: bigint, quoteDesired: bigint, baseReserve: bigint, quoteReserve: bigint, lpSupply: bigint): { baseUsed: bigint; quoteUsed: bigint; lp: bigint } | null {
  if (baseDesired <= 0n || quoteDesired <= 0n || baseReserve <= 0n || quoteReserve <= 0n || lpSupply <= 0n) return null;
  const quoteForBase = mulDivCeil(baseDesired, quoteReserve, baseReserve);
  let baseUsed: bigint;
  let quoteUsed: bigint;
  if (quoteForBase <= quoteDesired) {
    baseUsed = baseDesired;
    quoteUsed = quoteForBase;
  } else {
    baseUsed = mulDivCeil(quoteDesired, baseReserve, quoteReserve);
    quoteUsed = quoteDesired;
  }
  if (baseUsed > baseDesired) return null;
  const lp = mulDivFloor(baseUsed, lpSupply, baseReserve) < mulDivFloor(quoteUsed, lpSupply, quoteReserve) ? mulDivFloor(baseUsed, lpSupply, baseReserve) : mulDivFloor(quoteUsed, lpSupply, quoteReserve);
  if (lp <= 0n) return null;
  return { baseUsed, quoteUsed, lp };
}

/** What `lp` shares withdraw. */
export function withdrawForLp(lp: bigint, baseReserve: bigint, quoteReserve: bigint, lpSupply: bigint): { base: bigint; quote: bigint } | null {
  if (lp <= 0n || lp > lpSupply) return null;
  return { base: mulDivFloor(lp, baseReserve, lpSupply), quote: mulDivFloor(lp, quoteReserve, lpSupply) };
}

export interface CurveParams {
  curveTokens: bigint;
  reserveTokens: bigint;
  virtualQuote: bigint;
  virtualBase: bigint;
  graduationQuote: bigint;
}

/** The curve of a launch from the supply, the curve share and the virtual quote it opens with. */
export function curveParams(supply: bigint, curveBps: bigint, virtualQuote: bigint): CurveParams | null {
  if (curveBps > BPS || virtualQuote <= 0n) return null;
  const c = mulDivFloor(supply, curveBps, BPS);
  const r = supply - c;
  if (c <= r || r <= 0n) return null;
  const diff = c - r;
  return { curveTokens: c, reserveTokens: r, virtualQuote, virtualBase: mulDivFloor(c, r, diff), graduationQuote: mulDivFloor(virtualQuote, diff, r) };
}

/** The market cap a curve opens at, in quote base units. */
export function openingMcap(supply: bigint, p: CurveParams): bigint {
  return mulDivFloor(supply, p.virtualQuote, p.curveTokens + p.virtualBase);
}

/** The virtual quote that opens a curve at `mcap` quote base units (the inverse of openingMcap, rounded up). */
export function virtualQuoteForMcap(supply: bigint, curveBps: bigint, mcap: bigint): bigint | null {
  const shape = curveParams(supply, curveBps, 1n);
  if (!shape) return null;
  return mulDivCeil(mcap, shape.curveTokens + shape.virtualBase, supply);
}

/** Base to add at graduation so the price is continuous without the virtual offsets. */
export function graduationTopup(r: Reserves): bigint {
  const target = mulDivFloor(r.quoteReserve, r.baseReserve + r.virtualBase, r.quoteReserve + r.virtualQuote);
  return target > r.baseReserve ? target - r.baseReserve : 0n;
}

/** The LP fee during the sniper window. */
export function sniperLpFee(now: number, createdAt: number, windowSecs: number, startBps: number, baseBps: number): number {
  if (windowSecs <= 0 || now >= createdAt + windowSecs || startBps <= baseBps) return baseBps;
  const elapsed = Math.max(0, now - createdAt);
  const span = startBps - baseBps;
  const fallen = Math.floor((span * elapsed) / windowSecs);
  return startBps - Math.min(span, fallen);
}

/** The virtual quote for a launch opening at OPENING_MCAP_USD given the quote's dollar price, clamped to the bounds. */
export function virtualQuoteForUsd(quoteUsd: number, quoteDecimals = SOL_DECIMALS, mcapUsd = OPENING_MCAP_USD): bigint {
  if (!(quoteUsd > 0)) throw new RangeError('the quote has no price');
  const mcapQuote = BigInt(Math.round((mcapUsd / quoteUsd) * 10 ** quoteDecimals));
  const vq = virtualQuoteForMcap(TOKEN_SUPPLY, CURVE_BPS, mcapQuote);
  if (vq === null) throw new RangeError('no curve');
  return vq < MIN_VIRTUAL_QUOTE ? MIN_VIRTUAL_QUOTE : vq > MAX_VIRTUAL_QUOTE ? MAX_VIRTUAL_QUOTE : vq;
}

// ---- v2: token rules (docs/hooks-v2.md §4, §5, §7) ---------------------------------------------------
//
// The launch pool hook's fee math and the kit's reward accounting, kept to the same discipline:
// integer math in bigint, each rounding as the programs round. The Rust tests publish vectors at
// programs/tests/vectors/launch-fees.json, and vectors.test.ts feeds every case to the functions
// here (each takes plain numbers so it can).

const DAY_SECS = 86_400;

/** Bounds of token rules as the launch `Config` keeps them (§5.2); `create_launch` refuses anything outside them. */
export interface RuleBounds {
  maxHolderFeeBps: number;
  maxBurnBps: number;
  /** Creator + holders + burn on one side. */
  maxRulesFeeBps: number;
  minMaxWalletBps: number;
  maxMaxWalletBps: number;
  maxCreatorLockSecs: number;
  maxEarlyWindowSecs: number;
  maxEarlyLockSecs: number;
}

/** The policy every launch config is set to. */
export const RULE_BOUNDS: Readonly<RuleBounds> = {
  maxHolderFeeBps: 200,
  maxBurnBps: 100,
  maxRulesFeeBps: 300,
  minMaxWalletBps: 100,
  maxMaxWalletBps: 500,
  maxCreatorLockSecs: 90 * DAY_SECS,
  maxEarlyWindowSecs: 300,
  maxEarlyLockSecs: 7 * DAY_SECS,
};

/** Ceilings `init_config` and `set_config` enforce, which no config can raise (max wallet stays below 10,000; 1 is the kit's own floor). */
export const RULE_CEILINGS: Readonly<RuleBounds> = {
  maxHolderFeeBps: 500,
  maxBurnBps: 500,
  maxRulesFeeBps: 1_000,
  minMaxWalletBps: 1,
  maxMaxWalletBps: 9_999,
  maxCreatorLockSecs: 365 * DAY_SECS,
  maxEarlyWindowSecs: 3_600,
  maxEarlyLockSecs: 30 * DAY_SECS,
};

/** The smallest launch supply a config may set (a ceiling of §5.2), so `min_eligible` is at least 1. */
export const MIN_LAUNCH_SUPPLY = 1_000n;
/** The largest launch supply a config may set: the kit installs on no larger supply (§4.11). */
export const MAX_LAUNCH_SUPPLY = 10_000_000_000_000_000n;

/** Holder rewards offered on the launch form, per side (§7.1). */
export const HOLDER_FEE_CHOICES_BPS = [0, 50, 100, 200] as const;
/** Burn offered on the launch form, per side. */
export const BURN_CHOICES_BPS = [0, 25, 50, 100] as const;
/** Max wallet offered on the launch form, as a share of supply until graduation. */
export const MAX_WALLET_CHOICES_BPS = [0, 100, 200, 300, 500] as const;
/** Creator wallet lock offered on the launch form, in days. */
export const CREATOR_LOCK_CHOICES_DAYS = [0, 7, 30, 90] as const;
/** Early-buyer lock: buys this many seconds after the launch or sooner are locked. */
export const EARLY_WINDOW_CHOICES_SECS = [0, 30, 60, 300] as const;
/** Early-buyer lock: seconds after the launch when those tokens unlock (15 min, 1 h, 24 h). */
export const EARLY_LOCK_CHOICES_SECS = [900, 3_600, 86_400] as const;

/** No token rules. */
export const NO_RULES: Readonly<LaunchRulesInput> = { holderFeeBuyBps: 0, holderFeeSellBps: 0, burnBuyBps: 0, burnSellBps: 0, maxWalletBps: 0, creatorLockDays: 0, earlyWindowSecs: 0, earlyLockSecs: 0 };

/** The §7.1 per-rule defaults the Custom path starts from when a rule is switched on: holder rewards 1% both sides, max wallet 2%, creator wallet lock 30 days, no burn, no early-buyer lock. (The preset the form starts on is Plain.) */
export const DEFAULT_RULES: Readonly<LaunchRulesInput> = { ...NO_RULES, holderFeeBuyBps: 100, holderFeeSellBps: 100, maxWalletBps: 200, creatorLockDays: 30 };

/** Holder rewards are on when either side takes a holder fee. */
export const rewardsOn = (r: Pick<LaunchRulesInput, 'holderFeeBuyBps' | 'holderFeeSellBps'>): boolean => r.holderFeeBuyBps > 0 || r.holderFeeSellBps > 0;

/** The default creator fee: 0.5% with holder rewards on, else 1%. */
export const defaultCreatorFeeBps = (r: LaunchRulesInput): number => (rewardsOn(r) ? 50 : 100);

/** The four presets of §7.1 (2026-10-07: Holders first, Fair start, Scorched and Community are gone). */
export type RulePresetName = 'Plain' | 'Diamond hands' | 'Burn' | 'Paid to hold';

/**
 * The ways beside the presets (§7.1): Half-Life launches from Bordrless's own `LaunchConfig` with
 * the Half-Life hook (programs/half_life), prepared and lit for the mint by the launch itself;
 * Custom mixes the rules by hand with the form's controls; Build your own launches from a
 * `LaunchConfig` a creator made with the SDK (§5.7).
 */
export type RulePathName = 'Half-Life' | 'Custom' | 'Build your own';

/** What the launch form's rules row can be set to: a preset, or one of the paths. */
export type RuleModeName = RulePresetName | RulePathName;

export interface RulePreset {
  name: RulePresetName;
  /** How links name it: `/launch?preset=<slug>`. */
  slug: string;
  /** One line: what it sets. */
  description: string;
  /** The creator fee it sets. */
  creatorFeeBps: number;
  /** The rules it sets. */
  rules: Readonly<LaunchRulesInput>;
}

export interface RulePath {
  name: RulePathName;
  /** How links name it: `/launch?preset=<slug>`. */
  slug: string;
  /** One line: what it is. */
  description: string;
}

/**
 * The presets of the launch form, in order (§7.1), the one list the launch page, the home page and
 * the docs read; `bordrless_core::policy::presets::ALL` is the same list, and the fee vectors pin
 * this one to it. Each stays within the §5.2 bounds and the 3%-per-side cap (the policy test checks
 * every one). Holder rewards set "both sides" take the same rate on buys and sells.
 */
export const RULE_PRESETS: readonly RulePreset[] = [
  { name: 'Plain', slug: 'plain', description: 'No token rules; the creator fee and the sniper fee every launch has.', creatorFeeBps: 100, rules: NO_RULES },
  {
    name: 'Diamond hands',
    slug: 'diamond-hands',
    description: 'Early-buyer lock (the first 5 min, until 24 h after launch), max wallet 1%, creator wallet lock 90 d, holder rewards 1%, creator fee 0.5%.',
    creatorFeeBps: 50,
    rules: { ...NO_RULES, holderFeeBuyBps: 100, holderFeeSellBps: 100, maxWalletBps: 100, creatorLockDays: 90, earlyWindowSecs: 300, earlyLockSecs: 86_400 },
  },
  { name: 'Burn', slug: 'burn', description: 'Burn 0.5% on buys and sells, holder rewards 0.5%, creator fee 0.5%.', creatorFeeBps: 50, rules: { ...NO_RULES, holderFeeBuyBps: 50, holderFeeSellBps: 50, burnBuyBps: 50, burnSellBps: 50 } },
  { name: 'Paid to hold', slug: 'paid-to-hold', description: 'Holder rewards 2% on sells only, creator wallet lock 30 d, creator fee 0.5%.', creatorFeeBps: 50, rules: { ...NO_RULES, holderFeeSellBps: 200, creatorLockDays: 30 } },
];

/** The paths beside the presets, in order, with the words the home console and the launch form print. */
export const RULE_PATHS: readonly RulePath[] = [
  { name: 'Half-Life', slug: 'half-life', description: 'An exit fee that halves every 6 hours held: 20% to sell at once, 0% after 2 days, burned. Buys are free.' },
  { name: 'Custom', slug: 'custom', description: 'Mix the rules by hand; holder rewards and burn can differ on buys and sells.' },
  { name: 'Build your own', slug: 'build-your-own', description: 'Write a hook with the SDK, make a launch config, paste its key.' },
];

/** The preset the launch form starts on. */
export const DEFAULT_RULE_PRESET: RulePresetName = 'Plain';

/** The preset of this name. */
export function presetNamed(name: RulePresetName): RulePreset {
  return RULE_PRESETS.find((p) => p.name === name) ?? RULE_PRESETS[0]!;
}

// ---- companions (docs/companions.md) -----------------------------------------------------------------

/**
 * The companion templates' splits of every creator fee claim: the one list the launch form, the
 * token page and the backend read (`COMPANION_TEMPLATES` in the SDK is this object).
 */
export const COMPANION_SPLITS: Readonly<Record<CompanionTemplate, Readonly<CompanionSplitBps>>> = {
  /** No dev at all: every creator fee buys the token back and burns it. */
  buysItself: { buybackBps: 10_000, holdersBps: 0, beneficiaryBps: 0 },
  /** Half to holders through the kit, half to the launcher, whose first buy vests (holder rewards needed). */
  rugProofDev: { buybackBps: 0, holdersBps: 5_000, beneficiaryBps: 5_000 },
  /** Half bought back and burned, half to holders (holder rewards needed). */
  buybackAndReward: { buybackBps: 5_000, holdersBps: 5_000, beneficiaryBps: 0 },
};

/** The templates in the order the launch form offers them. */
export const COMPANION_TEMPLATE_LIST: readonly CompanionTemplate[] = ['buysItself', 'rugProofDev', 'buybackAndReward'];

/** How long the launcher's first buy vests over, as the launch form offers it (days), and the default (the backend's too). */
export const COMPANION_VEST_CHOICES_DAYS = [7, 30, 90] as const;
export const COMPANION_DEFAULT_VEST_DAYS = 30;

/** The longest a first buy may vest over, days (the program's limit is a year). */
export const COMPANION_MAX_VEST_DAYS = 365;

/** The whole creator fee to the launcher: an ordinary launch, with no companion. */
export const LAUNCHER_SPLIT: Readonly<CompanionSplitBps> = { buybackBps: 0, holdersBps: 0, beneficiaryBps: 10_000 };

// ---- lottery coins (docs/games.md) -----------------------------------------------------------------

/**
 * The companion program's game limits (`constants.rs`; `GAME_LIMITS` in the SDK, the same numbers):
 * a round's length, the minimum pot, the prize's least share, a claim window's bounds, the most
 * attempts, and the half of a round the attempts may take. The launch form holds its choices to
 * them and the backend refuses anything outside them (`lotteryProblem`).
 */
export const LOTTERY_LIMITS = {
  minRoundSecs: 3_600,
  maxRoundSecs: 30 * DAY_SECS,
  minMinPotLamports: 100_000_000n,
  maxMinPotLamports: 1_000_000_000_000n,
  minPrizeBps: 1_000,
  minClaimWindowSecs: 300,
  maxClaimWindowSecs: DAY_SECS,
  maxAttempts: 16,
  claimsPerRound: 2,
  /** The most a pot holds while its hook is not audited: 10 SOL, the rest of the pot's share bought back. */
  potCapLamports: 10_000_000_000n,
  /** Lamports the setup pays for the hook's state and registry and the game's account (mainnet rent, 2026-10-08). */
  rentLamports: 3_515_360n + 3_119_120n,
} as const;

/** The lottery the launch form starts with (docs/games.md, spec example 1): 6-hour rounds, 70% of the fee to the pot, 30% bought back, draws from 0.5 SOL paying the whole pot, 8 claim attempts of 10 minutes. */
export const LOTTERY_DEFAULTS: Readonly<LotteryRequest> = { kind: 'lottery', roundSecs: 21_600, potBps: 7_000, minPotLamports: '500000000', prizeBps: 10_000, claimWindowSecs: 600, maxAttempts: 8 };

/** The round lengths the form offers (seconds), each with its label. */
export const LOTTERY_ROUND_CHOICES: readonly { secs: number; label: string }[] = [
  { secs: 3_600, label: '1 hour' },
  { secs: 21_600, label: '6 hours' },
  { secs: DAY_SECS, label: '1 day' },
  { secs: 7 * DAY_SECS, label: '7 days' },
];
/** The least a pot holds before a round is drawn, as the form offers it (lamports). */
export const LOTTERY_MIN_POT_CHOICES: readonly { lamports: string; label: string }[] = [
  { lamports: '100000000', label: '0.1 SOL' },
  { lamports: '500000000', label: '0.5 SOL' },
  { lamports: '1000000000', label: '1 SOL' },
  { lamports: '5000000000', label: '5 SOL' },
];
/** What one draw pays of the pot, as the form offers it. */
export const LOTTERY_PRIZE_CHOICES_BPS = [10_000, 5_000, 2_500] as const;
/** The pot's share moves in steps of 10%, like the Split control's. */
export const LOTTERY_POT_STEP_BPS = 1_000;

/**
 * The claim windows and attempts the form fixes for a round length: 8 attempts of 10 minutes for a
 * round of 6 hours or more, 6 of 5 minutes for an hour (the attempts must fit in half a round).
 */
export function lotteryClaimsFor(roundSecs: number): { claimWindowSecs: number; maxAttempts: number } {
  return roundSecs >= 21_600 ? { claimWindowSecs: 600, maxAttempts: 8 } : { claimWindowSecs: 300, maxAttempts: 6 };
}

const isWhole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** The lottery a launch request's `companion.game` names, each field a whole number; null when it is malformed (bounds are `lotteryProblem`'s). */
export function lotteryRequestOf(raw: unknown): LotteryRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'lottery') return null;
  if (!isWhole(r.roundSecs, 0, 2 ** 32 - 1) || !isWhole(r.potBps, 0, 10_000) || !isWhole(r.prizeBps, 0, 10_000) || !isWhole(r.claimWindowSecs, 0, 2 ** 32 - 1) || !isWhole(r.maxAttempts, 0, 255)) return null;
  if (typeof r.minPotLamports !== 'string' || !/^\d{1,20}$/.test(r.minPotLamports)) return null;
  return { kind: 'lottery', roundSecs: r.roundSecs, potBps: r.potBps, minPotLamports: r.minPotLamports, prizeBps: r.prizeBps, claimWindowSecs: r.claimWindowSecs, maxAttempts: r.maxAttempts };
}

/**
 * Why `create_game` would refuse this lottery with this split on these rules, in the words the
 * launch form and the backend use (`companion_rules`); null when it would not. The program's own
 * checks (`gameArgsProblem` in the SDK, the same sentences), and what a lottery coin's launch
 * needs besides: a creator fee, no token rules (it launches from Bordrless's lottery config, which
 * has none, and runs its own hook in the kit's place), and no holders' share.
 */
export function lotteryProblem(game: LotteryRequest, split: CompanionSplitBps, rules: LaunchRulesInput, creatorFeeBps: number): string | null {
  const L = LOTTERY_LIMITS;
  if (creatorFeeBps === 0) return 'There is no creator fee to fill the pot with: set one.';
  if ((Object.keys(NO_RULES) as (keyof LaunchRulesInput)[]).some((k) => rules[k] !== 0)) return 'A lottery coin has no other token rules: its hook keeps the tickets.';
  if (split.holdersBps !== 0) return 'A game coin runs its own hook, so it has no holder rewards: no holders’ part.';
  if (!(game.potBps > 0) || split.buybackBps + split.holdersBps + split.beneficiaryBps + game.potBps !== 10_000) return 'The pot’s part and the split must add up to 10,000 basis points, with a pot.';
  if (game.roundSecs < L.minRoundSecs || game.roundSecs > L.maxRoundSecs) return 'A round lasts an hour to 30 days.';
  const minPot = BigInt(game.minPotLamports);
  if (minPot < L.minMinPotLamports || minPot > L.maxMinPotLamports) return 'The minimum pot is 0.1 to 1,000 SOL.';
  if (game.prizeBps < L.minPrizeBps || game.prizeBps > 10_000) return 'A draw pays 10% to 100% of the pot.';
  if (game.claimWindowSecs < L.minClaimWindowSecs || game.claimWindowSecs > L.maxClaimWindowSecs) return 'A claim window lasts 5 minutes to a day.';
  if (!(game.maxAttempts >= 1 && game.maxAttempts <= L.maxAttempts)) return 'A draw makes 1 to 16 attempts.';
  if (game.claimWindowSecs * game.maxAttempts * L.claimsPerRound > game.roundSecs) return 'A draw’s attempts must fit in half a round.';
  return null;
}

/** The copy rules of a lottery coin (docs/games.md): said on the launch form, the review step and the token page, never "provably fair", "guaranteed" or "audited". */
export const LOTTERY_COPY = {
  held: 'The pot is held by the companion program and paid out by code. Randomness by ORAO VRF.',
  odds: 'Your odds = your tokens in the round. Sell before the payout and you forfeit.',
  stop: 'Bordrless can stop this game: its pot would be bought back and burned. Nobody is paid.',
  cap: 'Pot capped at 10 SOL until the game’s hook is audited.',
  oracle: 'Randomness by ORAO VRF: ORAO’s three signers produce it. They could withhold or bias a draw; Bordrless can’t.',
} as const;

// ---- jackpot and streak coins (docs/games.md "Phase 2"), on game hooks made in Studio -----------------

/** The jackpot's timer and the streak's minimum streak: the companion's bounds (`GAME_LIMITS` in the SDK). */
export const GAME_KIND_LIMITS = { minTimerSecs: 300, maxTimerSecs: 30 * DAY_SECS, maxMinStreakSecs: 365 * DAY_SECS } as const;

/** A jackpot as the launch form starts it (spec example 2, `JACKPOT_DEFAULTS` in the SDK): 70% of the fee to the pot, 30% bought back, half the pot to the last buyer from 0.5 SOL. */
export const JACKPOT_REQUEST_DEFAULTS: Readonly<JackpotRequest> = { kind: 'jackpot', potBps: 7_000, minPotLamports: '500000000', prizeBps: 5_000 };
/** A streak as the launch form starts it (spec example 3, `STREAK_DEFAULTS` in the SDK): 70% of the fee to the pot, 30% bought back, the whole pot shared each epoch from 0.1 SOL, an hour at least for claims. */
export const STREAK_REQUEST_DEFAULTS: Readonly<StreakRequest> = { kind: 'streak', potBps: 7_000, minPotLamports: '100000000', prizeBps: 10_000, claimWindowSecs: 3_600 };
/** The least a streak's close leaves for claims, as the form offers it (seconds); each must fit half the hook's epoch. */
export const STREAK_CLAIM_WINDOW_CHOICES: readonly { secs: number; label: string }[] = [
  { secs: 1_800, label: '30 min' },
  { secs: 3_600, label: '1 hour' },
  { secs: 21_600, label: '6 hours' },
  { secs: DAY_SECS, label: '1 day' },
];

/** The game a launch request's `companion.game` names, of any kind, each field a whole number; null when malformed (bounds are `gameProblem`'s). */
export function gameRequestOf(raw: unknown): GameRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'lottery') return lotteryRequestOf(raw);
  if (r.kind !== 'jackpot' && r.kind !== 'streak') return null;
  if (!isWhole(r.potBps, 0, 10_000) || !isWhole(r.prizeBps, 0, 10_000)) return null;
  if (typeof r.minPotLamports !== 'string' || !/^\d{1,20}$/.test(r.minPotLamports)) return null;
  if (r.kind === 'jackpot') return { kind: 'jackpot', potBps: r.potBps, minPotLamports: r.minPotLamports, prizeBps: r.prizeBps };
  if (!isWhole(r.claimWindowSecs, 0, 2 ** 32 - 1)) return null;
  return { kind: 'streak', potBps: r.potBps, minPotLamports: r.minPotLamports, prizeBps: r.prizeBps, claimWindowSecs: r.claimWindowSecs };
}

/**
 * Why `create_game_v2` (or the launch) would refuse this game with this split on these rules at
 * this fee, with `hook` the Studio game hook the config names (`ConfigInspection.game`; null: the
 * config names none), in one sentence; null when it would not. A lottery is `lotteryProblem`'s.
 * The program's own checks (`gameArgsProblem` in the SDK, the same sentences) and what a game
 * coin's launch needs besides: a creator fee, no token rules, no holders' share, and a hook of the
 * game's kind.
 */
export function gameProblem(game: GameRequest, split: CompanionSplitBps, rules: LaunchRulesInput, creatorFeeBps: number, hook: StudioGameSettings | null = null): string | null {
  if (game.kind === 'lottery') return lotteryProblem(game, split, rules, creatorFeeBps);
  const L = LOTTERY_LIMITS;
  const word = GAME_KIND_NAMES[game.kind];
  if (!hook) return `A ${word} coin launches from a game hook made in Studio: open your ${word} project there and press Launch with it.`;
  if (hook.kind !== game.kind) return `This config’s hook keeps a ${GAME_KIND_NAMES[hook.kind]}’s score, not a ${word}’s.`;
  if (creatorFeeBps === 0) return 'There is no creator fee to fill the pot with: set one.';
  if ((Object.keys(NO_RULES) as (keyof LaunchRulesInput)[]).some((k) => rules[k] !== 0)) return `A ${word} coin has no other token rules: its hook keeps the score.`;
  if (split.holdersBps !== 0) return 'A game coin runs its own hook, so it has no holder rewards: no holders’ part.';
  if (!(game.potBps > 0) || split.buybackBps + split.holdersBps + split.beneficiaryBps + game.potBps !== 10_000) return 'The pot’s part and the split must add up to 10,000 basis points, with a pot.';
  const minPot = BigInt(game.minPotLamports);
  if (minPot < L.minMinPotLamports || minPot > L.maxMinPotLamports) return 'The minimum pot is 0.1 to 1,000 SOL.';
  if (game.prizeBps < L.minPrizeBps || game.prizeBps > 10_000) return 'A game pays 10% to 100% of the pot at a time.';
  if (game.kind === 'jackpot') {
    if (hook.timerSecs < GAME_KIND_LIMITS.minTimerSecs || hook.timerSecs > GAME_KIND_LIMITS.maxTimerSecs) return 'A jackpot’s timer lasts 5 minutes to 30 days.';
    if (BigInt(hook.minTokens) < 1n) return 'A qualifying buy is at least one base unit.';
    return null;
  }
  if (hook.roundSecs < L.minRoundSecs || hook.roundSecs > L.maxRoundSecs) return 'An epoch lasts an hour to 30 days.';
  if (game.claimWindowSecs < L.minClaimWindowSecs || game.claimWindowSecs > L.maxClaimWindowSecs || game.claimWindowSecs * L.claimsPerRound > hook.roundSecs) return 'A streak leaves claims 5 minutes to a day, at most half an epoch.';
  if (hook.minStreakSecs > GAME_KIND_LIMITS.maxMinStreakSecs) return 'A streak asks at most a year without sending.';
  if (BigInt(hook.minWeight) < 1n) return 'The least weight that shares is at least one base unit.';
  return null;
}

/** Each game kind in a word: "jackpot". */
export const GAME_KIND_NAMES: Readonly<Record<GameKindName, string>> = { lottery: 'lottery', jackpot: 'jackpot', streak: 'streak', strategy: 'strategy' };

/**
 * The copy rules of a jackpot and a streak coin (docs/games.md "Phase 2", "Site"): said on the
 * launch form, the review step and the token page. The pot is held by the companion and paid by
 * code (no randomness in either kind), the 10 SOL cap until the hook is audited, "Bordrless can
 * stop this game"; never "provably fair", "guaranteed" or "audited".
 */
export const JACKPOT_COPY = {
  held: 'The pot is held by the companion program and paid out by code. No randomness: the last buyer wins.',
  rule: 'The last buyer wins if they keep every token they bought: any sale or transfer forfeits.',
  unfunded: 'If the pot is below its minimum when a round is settled, the round pays nothing and the pot carries on.',
  curve: 'Buys count while the coin is on its curve: the jackpot ends at graduation (the round under way is still paid).',
  cap: LOTTERY_COPY.cap,
  stop: LOTTERY_COPY.stop,
} as const;

export const STREAK_COPY = {
  held: 'The pot is held by the companion program and paid out by code. No randomness: holders share in proportion to what they held.',
  rule: 'Send anything, to anyone, and you lose this epoch’s and last epoch’s share. Claim before you sell.',
  weight: 'Your weight is what you held since the epoch began: tokens that arrive during an epoch count from the next.',
  claims: 'Shares are claimed during the next epoch; the keeper claims for everyone whose share covers the fee, the rest claim here. What is not claimed rolls over.',
  cap: LOTTERY_COPY.cap,
  stop: LOTTERY_COPY.stop,
} as const;

/** Why a round paid no prize, in a few words each (`GameRolloverReason`). */
export const ROLLOVER_WORDS: Readonly<Record<GameRolloverReason, string>> = {
  noTickets: 'Nobody held tickets',
  roundForgotten: 'The round was forgotten',
  noClaim: 'No winner claimed in time',
  oracleSilent: 'ORAO never answered',
  blocked: 'Stopped by Bordrless',
  late: 'Drawn too late',
  oracleUnreadable: 'ORAO’s answer unreadable',
  oracleUnpaid: 'The pot could not pay ORAO',
};

/** Whether a split is the whole fee to the launcher (no companion needed). */
export const isLauncherSplit = (s: CompanionSplitBps): boolean => s.buybackBps === 0 && s.holdersBps === 0 && s.beneficiaryBps === 10_000;

/** A split with a share for holders needs holder rewards on. */
export const splitPaysHolders = (s: CompanionSplitBps): boolean => s.holdersBps > 0;

/** Whether a split takes a first buy: every fee bought back and burned means no dev at all. */
export const splitTakesFirstBuy = (s: CompanionSplitBps): boolean => s.buybackBps < 10_000;

/** A template that pays holders needs holder rewards on. */
export const companionPaysHolders = (template: CompanionTemplate): boolean => splitPaysHolders(COMPANION_SPLITS[template]);

/** Whether a template takes a first buy: the token that buys itself has no dev at all. */
export const companionTakesFirstBuy = (template: CompanionTemplate): boolean => splitTakesFirstBuy(COMPANION_SPLITS[template]);

const isShare = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000;

/**
 * The split a launch request's `companion` names: its own `split` (each share a whole number of
 * basis points, 0 to 10,000; their sum is checked by `companionSplitProblem`), or a template's;
 * `null` when it names neither (a malformed request).
 */
export function companionRequestSplit(raw: unknown): CompanionSplitBps | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.split !== undefined) {
    if (typeof r.split !== 'object' || r.split === null) return null;
    const s = r.split as Record<string, unknown>;
    if (!isShare(s.buybackBps) || !isShare(s.holdersBps) || !isShare(s.beneficiaryBps)) return null;
    return { buybackBps: s.buybackBps, holdersBps: s.holdersBps, beneficiaryBps: s.beneficiaryBps };
  }
  if (typeof r.template === 'string' && Object.hasOwn(COMPANION_SPLITS, r.template)) return { ...COMPANION_SPLITS[r.template as CompanionTemplate] };
  return null;
}

/**
 * Why a companion with this split can't run these rules, in the words the launch form and the
 * backend use (`companion_rules`); null when it can. The program's own checks (`BadSplit`,
 * `CreatorLockUnsupported`, `HolderRewardsOff`), and a creator fee for it to run.
 */
export function companionSplitProblem(split: CompanionSplitBps, rules: Pick<LaunchRulesInput, 'holderFeeBuyBps' | 'holderFeeSellBps' | 'creatorLockDays'>, creatorFeeBps: number): string | null {
  if (![split.buybackBps, split.holdersBps, split.beneficiaryBps].every(isShare)) return 'Each share of the creator fee is a whole number of basis points, 0 to 10,000.';
  if (split.buybackBps + split.holdersBps + split.beneficiaryBps !== 10_000) return 'The creator fee’s shares must add up to 100% (10,000 basis points).';
  if (rules.creatorLockDays > 0) return 'A creator fee run by a program can’t come with the creator wallet lock: the program vests your first buy instead.';
  if (creatorFeeBps === 0) return 'There is no creator fee for a program to run: set one.';
  if (splitPaysHolders(split) && !rewardsOn(rules)) return 'A share of the creator fee for holders needs holder rewards on.';
  return null;
}

/** The template whose split this is, or null for any other split. */
export function companionTemplateOf(split: CompanionSplitBps): CompanionTemplate | null {
  return COMPANION_TEMPLATE_LIST.find((t) => {
    const s = COMPANION_SPLITS[t];
    return s.buybackBps === split.buybackBps && s.holdersBps === split.holdersBps && s.beneficiaryBps === split.beneficiaryBps;
  }) ?? null;
}

/** Kit module bits (§4.2). */
export const KIT_MODULES = { HOLDER_REWARDS: 1, MAX_WALLET: 2, CREATOR_LOCK: 4, EARLY_LOCK: 8 } as const;

/** The kit modules a launch with these rules installs (§5.1); 0 means no hook at all (a burn alone runs in the pool hook). */
export function kitModules(r: LaunchRulesInput): number {
  return (rewardsOn(r) ? KIT_MODULES.HOLDER_REWARDS : 0) | (r.maxWalletBps > 0 ? KIT_MODULES.MAX_WALLET : 0) | (r.creatorLockDays > 0 ? KIT_MODULES.CREATOR_LOCK : 0) | (r.earlyWindowSecs > 0 ? KIT_MODULES.EARLY_LOCK : 0);
}

/**
 * The token hook flags a kit mint carries for `modules` (§4.2, `bordrless_kit::mint_flags`):
 * `BEFORE_TRANSFER`, plus `BEFORE_BURN | WRITES_HOOK_DATA` with holder rewards or the early-buyer
 * lock; 0 (no hook at all) without modules. So 1 for modules 2, 4 or 6, and 145 whenever 1 or 8 is
 * among them. A mint naming the kit with other flags is not a kit token (§4.15).
 */
export function kitMintFlags(modules: number): number {
  if (modules === 0) return 0;
  const data = (modules & (KIT_MODULES.HOLDER_REWARDS | KIT_MODULES.EARLY_LOCK)) !== 0;
  return TOKEN_HOOK_FLAGS.BEFORE_TRANSFER | (data ? TOKEN_HOOK_FLAGS.BEFORE_BURN | TOKEN_HOOK_FLAGS.WRITES_HOOK_DATA : 0);
}

/** The rules a launch made at `launchedAt` (unix seconds) carries, as the API shows them. */
export function launchRulesAt(r: LaunchRulesInput, launchedAt: number): LaunchRules {
  return {
    holderFeeBuyBps: r.holderFeeBuyBps,
    holderFeeSellBps: r.holderFeeSellBps,
    burnBuyBps: r.burnBuyBps,
    burnSellBps: r.burnSellBps,
    maxWalletBps: r.maxWalletBps,
    creatorUnlockAt: r.creatorLockDays > 0 ? launchedAt + r.creatorLockDays * DAY_SECS : null,
    earlyWindowEndsAt: r.earlyWindowSecs > 0 ? launchedAt + r.earlyWindowSecs : null,
    earlyUnlockAt: r.earlyWindowSecs > 0 ? launchedAt + r.earlyLockSecs : null,
    walletsOnly: rewardsOn(r),
  };
}

const percent = (bps: number): string => `${bps / 100}%`;

function duration(secs: number): string {
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (secs % DAY_SECS === 0) return unit(secs / DAY_SECS, 'day');
  if (secs % 3_600 === 0) return unit(secs / 3_600, 'hour');
  if (secs % 60 === 0) return unit(secs / 60, 'minute');
  return unit(secs, 'second');
}

/**
 * Why `create_launch` would refuse these rules with this creator fee under `bounds`, as the sentence
 * the launch form shows; null when it would take them. An early-buyer lock needs its window, and its
 * tokens must unlock after the window ends.
 */
export function checkLaunchRules(r: LaunchRulesInput, creatorFeeBps: number, bounds: Readonly<RuleBounds> = RULE_BOUNDS): string | null {
  const values = [creatorFeeBps, r.holderFeeBuyBps, r.holderFeeSellBps, r.burnBuyBps, r.burnSellBps, r.maxWalletBps, r.creatorLockDays, r.earlyWindowSecs, r.earlyLockSecs];
  if (!values.every((v) => Number.isSafeInteger(v) && v >= 0)) return 'Token rules must be whole numbers, 0 or more.';
  if (r.holderFeeBuyBps > bounds.maxHolderFeeBps || r.holderFeeSellBps > bounds.maxHolderFeeBps) return `Holder rewards can be at most ${percent(bounds.maxHolderFeeBps)} per side.`;
  if (r.burnBuyBps > bounds.maxBurnBps || r.burnSellBps > bounds.maxBurnBps) return `Burn can be at most ${percent(bounds.maxBurnBps)} per side.`;
  for (const [side, holder, burn] of [['buys', r.holderFeeBuyBps, r.burnBuyBps], ['sells', r.holderFeeSellBps, r.burnSellBps]] as const) {
    const total = creatorFeeBps + holder + burn;
    if (total > bounds.maxRulesFeeBps) return `Creator fee, holder rewards and burn add up to ${percent(total)} on ${side}; the most is ${percent(bounds.maxRulesFeeBps)}.`;
  }
  if (r.maxWalletBps !== 0 && (r.maxWalletBps < bounds.minMaxWalletBps || r.maxWalletBps > bounds.maxMaxWalletBps)) return `Max wallet must be off or between ${percent(bounds.minMaxWalletBps)} and ${percent(bounds.maxMaxWalletBps)}.`;
  if (r.creatorLockDays * DAY_SECS > bounds.maxCreatorLockSecs) return `The creator wallet lock can be at most ${duration(bounds.maxCreatorLockSecs)}.`;
  if (r.earlyWindowSecs === 0) {
    if (r.earlyLockSecs !== 0) return 'The early-buyer lock needs a window: choose how soon after the launch a buy is locked.';
  } else {
    if (r.earlyWindowSecs > bounds.maxEarlyWindowSecs) return `The early-buyer window can be at most ${duration(bounds.maxEarlyWindowSecs)}.`;
    if (r.earlyLockSecs <= r.earlyWindowSecs) return 'Early buys must unlock after the early-buyer window ends.';
    if (r.earlyLockSecs > bounds.maxEarlyLockSecs) return `Early buys must unlock within ${duration(bounds.maxEarlyLockSecs)} of the launch.`;
  }
  return null;
}

/**
 * §8.1 `preset`: the §7.1 preset whose rules and creator fee a launch matches exactly, 'custom' for
 * other rules (and for a config without a custom hook), 'custom-hook' for a launch made from a
 * config with a creator's own hook, null for a launch without rules and without a hook.
 */
export function presetOf(r: LaunchRulesInput, creatorFeeBps: number, customHook = false): string | null {
  if (customHook) return 'custom-hook';
  const keys = Object.keys(NO_RULES) as (keyof LaunchRulesInput)[];
  if (keys.every((key) => r[key] === 0)) return null;
  const match = RULE_PRESETS.find((p) => p.creatorFeeBps === creatorFeeBps && keys.every((key) => p.rules[key] === r[key]));
  return match ? match.name : 'custom';
}

/** §4.9: a buy from the launch pool landing at `now` inside the early window is locked until the early unlock; null when it is not. */
export function buyLockedUntil(rules: Pick<LaunchRules, 'earlyWindowEndsAt' | 'earlyUnlockAt'>, now: number): number | null {
  return rules.earlyWindowEndsAt !== null && rules.earlyUnlockAt !== null && now < rules.earlyWindowEndsAt && now < rules.earlyUnlockAt ? rules.earlyUnlockAt : null;
}

// ---- the launch pool hook's fees (§5.4) and the DEX's order (§3.1) ----------------------------------

/** A launch's fee rates and the holder-fee threshold, as its pool hook reads them. */
export interface LaunchFeeParams {
  creatorFeeBps: number;
  holderFeeBuyBps: number;
  holderFeeSellBps: number;
  burnBuyBps: number;
  burnSellBps: number;
  /** `KitConfig.eligible` before the trade; 0 without holder rewards. */
  eligible: bigint;
  /** `KitConfig.min_eligible` (the supply / 1,000); 0 without holder rewards. */
  minEligible: bigint;
}

/** What the launch hook takes in one callback: creator and holder fees in bridged SOL, the burn in tokens. */
export interface HookCut {
  creatorFee: bigint;
  holderFee: bigint;
  burn: bigint;
}

/**
 * The creator and holder fees from `amount` of bridged SOL (a buy's input, a sell's output): each
 * rounded up, the holder fee only while `eligible >= minEligible`, and neither when together they are
 * not below the amount.
 */
export function creatorAndHolderFees(amount: bigint, creatorFeeBps: number, holderFeeBps: number, eligible: bigint, minEligible: bigint): { creatorFee: bigint; holderFee: bigint } {
  const creatorFee = feeAmount(amount, creatorFeeBps);
  const holderFee = holderFeeBps > 0 && eligible >= minEligible ? feeAmount(amount, holderFeeBps) : 0n;
  if (creatorFee + holderFee >= amount) return { creatorFee: 0n, holderFee: 0n };
  return { creatorFee, holderFee };
}

/** The burn from `amount` of tokens (a buy's output, a sell's input): rounded down, and none when it is not below the amount. */
export function tradeBurn(amount: bigint, burnBps: number): bigint {
  const burn = mulDivFloor(amount, BigInt(burnBps), BPS);
  return burn < amount ? burn : 0n;
}

/** The hook's `before_swap` cut from the input: a buy's creator and holder fees, a sell's burn. `p.eligible` is the count before the trade. */
export function launchBeforeSwap(side: Side, amountIn: bigint, p: LaunchFeeParams): HookCut {
  if (side === 'buy') return { ...creatorAndHolderFees(amountIn, p.creatorFeeBps, p.holderFeeBuyBps, p.eligible, p.minEligible), burn: 0n };
  return { creatorFee: 0n, holderFee: 0n, burn: tradeBurn(amountIn, p.burnSellBps) };
}

/** The hook's `after_swap` cut from the output: a buy's burn, a sell's creator and holder fees. For a sell, `p.eligible` is the count once the input has left the seller. */
export function launchAfterSwap(side: Side, amountOut: bigint, p: LaunchFeeParams): HookCut {
  if (side === 'buy') return { creatorFee: 0n, holderFee: 0n, burn: tradeBurn(amountOut, p.burnBuyBps) };
  return { ...creatorAndHolderFees(amountOut, p.creatorFeeBps, p.holderFeeSellBps, p.eligible, p.minEligible), burn: 0n };
}

/** A swap on a launch pool, step by step. */
export interface LaunchSwap {
  /** Bridged SOL to the creator: from a buy's input, or from a sell's output after the LP fee. */
  creatorFee: bigint;
  /** Bridged SOL to holders, likewise. */
  holderFee: bigint;
  /** Tokens burned: from a buy's output, or a sell's input. */
  burn: bigint;
  /** The holder-fee threshold was met when the hook took this side's fees. */
  holderFeeOn: boolean;
  /** What reached the input vault. */
  received: bigint;
  /** The LP fee, Bordrless's in bridged SOL (it never stays in a launch pool): on a buy from what reached the vault, on a sell from the curve's output. The DEX's event reports it inside `protocol_fee` with `lp_fee` 0. */
  lpFee: bigint;
  /** Bordrless's share of the creator and holder fees (`LAUNCH_PROTOCOL_SHARE_BPS` of them, rounded up; 0 when they are 0), always in bridged SOL: on a buy from what reached the vault, before the curve; on a sell held back from the delivery. */
  protocolFee: bigint;
  /** What went into the curve: on a buy `received` less the LP fee and the protocol fee (negative when they take more than arrived); on a sell `received`. */
  netIn: bigint;
  /** What the curve gave (on a sell, before the LP fee, the creator and holder fees and the protocol fee); null when the swap fails. */
  amountOut: bigint | null;
  /** What reaches the recipient; null when the swap fails. */
  delivered: bigint | null;
  /** Why the swap fails: the fees take the whole input, nothing would reach the wallet, or the pool cannot fill it; null when it lands. */
  failure: 'fees_exceed_input' | 'no_output' | 'insufficient_liquidity' | null;
}

/** The constant-product output for `netIn` going into the curve, rounded down, before the check against the real reserve. */
export function curveOutput(r: Reserves, side: Side, netIn: bigint): bigint {
  if (netIn <= 0n) return 0n;
  return side === 'buy' ? mulDivFloor(netIn, r.baseReserve + r.virtualBase, r.quoteReserve + r.virtualQuote + netIn) : mulDivFloor(netIn, r.quoteReserve + r.virtualQuote, r.baseReserve + r.virtualBase + netIn);
}

/**
 * A swap on a launch pool as the v2 DEX runs it with the launch hook under the share model (§3.1,
 * §5.4; the Rust reference is `bordrless_program_tests::launch::quote_launch_swap`): Bordrless
 * takes `protocolShareBps` of the creator and holder fees (the hooks' cuts; the kit takes none of
 * its own, so the cuts are exactly those fees), in bridged SOL, and nothing when they are nothing.
 * A buy: the creator and holder fees from the input, Bordrless's share of them and the LP fee (both
 * Bordrless's, in SOL) on what reached the vault, the curve, the burn from the output. A sell: the
 * burn from the input, the curve on all the rest, the LP fee (Bordrless's) from the curve's output,
 * then the creator and holder fees from what is left and Bordrless's share of them held back from the
 * delivery. A launch pool's LP fee never stays in the pool (its LP is locked for ever). A sell takes
 * its input out of the kit's eligible count before `after_swap` reads it (every seller is a holder:
 * the pool and the launch never sell). An ordinary pool's flat rate is `quoteSwap`.
 */
export function quoteLaunchSwap(r: Reserves, side: Side, amountIn: bigint, lpFeeBps: number, protocolShareBps: number, p: LaunchFeeParams): LaunchSwap {
  const before = launchBeforeSwap(side, amountIn, p);
  const received = amountIn - before.creatorFee - before.holderFee - before.burn;
  const eligibleAtFees = side === 'sell' ? (p.eligible > amountIn ? p.eligible - amountIn : 0n) : p.eligible;
  const holderFeeOn = (side === 'buy' ? p.holderFeeBuyBps : p.holderFeeSellBps) > 0 && eligibleAtFees >= p.minEligible;
  // A buy's LP fee is on the SOL that reached the vault; a sell's on the curve's output.
  const buyLpFee = side === 'buy' ? feeAmount(received, lpFeeBps) : 0n;
  // A buy's cuts are the hook's quote fees; a sell's input side cuts nothing (the burn is not a cut), so its share is taken from the output.
  const inputProtocolFee = side === 'buy' ? protocolShare(before.creatorFee + before.holderFee, protocolShareBps) : 0n;
  const netIn = received - buyLpFee - inputProtocolFee;
  const failed = (failure: 'fees_exceed_input' | 'no_output' | 'insufficient_liquidity', protocolFee = inputProtocolFee, carried: Partial<LaunchSwap> = {}): LaunchSwap => ({ ...before, holderFeeOn, received, lpFee: buyLpFee, protocolFee, netIn, amountOut: null, delivered: null, failure, ...carried });
  if (received <= 0n || netIn <= 0n) return failed('fees_exceed_input');
  const out = curveOutput(r, side, netIn);
  if (out <= 0n) return failed('no_output');
  if (out > (side === 'buy' ? r.baseReserve : r.quoteReserve)) return failed('insufficient_liquidity');
  if (side === 'buy') {
    const after = launchAfterSwap('buy', out, p);
    return { ...before, burn: after.burn, holderFeeOn, received, lpFee: buyLpFee, protocolFee: inputProtocolFee, netIn, amountOut: out, delivered: out - after.burn, failure: null };
  }
  // A sell: the LP fee leaves the curve's output before the hook is told the rest.
  const lpFee = feeAmount(out, lpFeeBps);
  if (lpFee >= out) return failed('no_output', 0n, { lpFee });
  const told = out - lpFee;
  const after = launchAfterSwap('sell', told, { ...p, eligible: eligibleAtFees });
  const protocolFee = protocolShare(after.creatorFee + after.holderFee, protocolShareBps);
  if (after.creatorFee + after.holderFee + protocolFee >= told) return failed('no_output', protocolFee, { creatorFee: after.creatorFee, holderFee: after.holderFee, lpFee });
  return { creatorFee: after.creatorFee, holderFee: after.holderFee, burn: before.burn, holderFeeOn, received, lpFee, protocolFee, netIn, amountOut: out, delivered: told - after.creatorFee - after.holderFee - protocolFee, failure: null };
}

/**
 * What a launch-pool swap adds to its input reserve (the Rust reference's `to_reserve_in`): on a buy
 * what goes into the curve (what reached the vault less the LP fee and the share, both Bordrless's;
 * 0 when they take it all), on a sell what reached the vault.
 */
export const launchSwapToReserve = (side: Side, q: Pick<LaunchSwap, 'received' | 'netIn'>): bigint => (side === 'buy' ? (q.netIn > 0n ? q.netIn : 0n) : q.received);

/**
 * Whether a buy that lands leaves the launch ready to graduate, so `graduate` can follow it in the
 * same transaction: the pool's quote reserve at or above the graduation threshold, or the curve sold
 * out (the buy takes every token it has left). The LP fee does not compound, so the two come
 * together, and a hook's cut on buys can keep the reserve just short of the threshold.
 */
export function buyGraduates(r: Reserves, q: LaunchSwap, graduationQuote: bigint): boolean {
  return q.failure === null && (r.quoteReserve + launchSwapToReserve('buy', q) >= graduationQuote || q.amountOut === r.baseReserve);
}

/**
 * §8.2 `maxAmountIn` on a curve pool: the largest buy the curve can still fill with these fees (one
 * lamport more and the DEX refuses it, `InsufficientLiquidity`), found with the quote itself rather
 * than by dividing out the fees, so the rounding is the programs'. Only meaningful on a curve: a pool
 * without virtual reserves can always fill a buy.
 */
export function curveMaxBuyIn(r: Reserves, lpFeeBps: number, protocolShareBps: number, p: LaunchFeeParams): bigint {
  return maxBuyWithin(r, lpFeeBps, protocolShareBps, p, U64_MAX);
}

/** `1 - Π(1 - fee_i)` in basis points, rounded up so the figure never understates. */
export function compoundFeeBps(feesBps: readonly number[]): number {
  let kept = 1n;
  let scale = 1n;
  for (const fee of feesBps) {
    if (!Number.isInteger(fee) || fee < 0 || fee > 10_000) throw new RangeError('a fee is between 0 and 10,000 bps');
    kept *= BPS - BigInt(fee);
    scale *= BPS;
  }
  return Number(mulDivCeil(scale - kept, BPS, scale));
}

/**
 * One side's fee rates. `holderFeeBps` is 0 while nobody is eligible; `lpFeeBps` is the current LP
 * fee (the sniper fee while elevated), or the base rate for a launch's standing figure. How
 * Bordrless is paid follows the pool's model (§3.1): `protocolShareBps` of the creator and holder
 * fees on a launch pool (the share model; `LAUNCH_PROTOCOL_SHARE_BPS`), or a flat `protocolFeeBps`
 * of the quote on an ordinary pool. Either left out counts as 0.
 */
export interface SideFees {
  lpFeeBps: number;
  creatorFeeBps: number;
  holderFeeBps: number;
  burnBps: number;
  /** The share model: Bordrless's share of the cuts, in basis points. */
  protocolShareBps?: number;
  /** The flat model: a rate of the quote, in basis points. */
  protocolFeeBps?: number;
}

/** What Bordrless's share comes to as a rate of the trade, in basis points (may be fractional: 150 bps of cuts at a quarter is 37.5). 0 when the rules collect nothing. */
export function protocolShareBps(cutsBps: number, shareBps: number = LAUNCH_PROTOCOL_SHARE_BPS): number {
  return (cutsBps * shareBps) / 10_000;
}

/**
 * The total fee of one side as one figure (§7.3), in the order the v2 DEX charges it, rounded up to
 * a basis point so the figure never understates. With `s` Bordrless's share of the cuts and `flat`
 * an ordinary pool's rate (one of them 0):
 * a buy `1 - (1 - (creator + holders)(1 + s))(1 - lp - flat)(1 - burn)`,
 * a sell `1 - (1 - burn)(1 - lp)(1 - flat)(1 - (creator + holders)(1 + s))`.
 * Plain on a launch pool (creator 1%, LP 0.3%, s = 0.25): 1 - 0.9875 · 0.997 = 1.5437%, 155 bps;
 * Diamond hands (holders 1%, creator 0.5%): 1 - 0.98125 · 0.997 = 2.1694%, 217 bps a side.
 */
export function sideFeeBps(side: Side, f: SideFees): number {
  const share = f.protocolShareBps ?? 0;
  const flat = f.protocolFeeBps ?? 0;
  for (const v of [f.lpFeeBps, f.creatorFeeBps, f.holderFeeBps, f.burnBps, flat]) if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new RangeError('a fee is between 0 and 10,000 bps');
  if (!Number.isInteger(share) || share < 0 || share > MAX_PROTOCOL_SHARE_BPS) throw new RangeError('a share is between 0 and 10,000 bps');
  const cuts = BigInt(f.creatorFeeBps + f.holderFeeBps);
  // The cuts with Bordrless's share on top, over BPS²: (creator + holders)(1 + s).
  const cutsScaled = cuts * (BPS + BigInt(share));
  if (cutsScaled > BPS * BPS) throw new RangeError('the cuts and their share pass 100%');
  const factors: [bigint, bigint][] = side === 'buy' ? [[BPS * BPS - cutsScaled, BPS * BPS], [BPS - BigInt(f.lpFeeBps + flat), BPS], [BPS - BigInt(f.burnBps), BPS]] : [[BPS - BigInt(f.burnBps), BPS], [BPS - BigInt(f.lpFeeBps), BPS], [BPS - BigInt(flat), BPS], [BPS * BPS - cutsScaled, BPS * BPS]];
  let kept = 1n;
  let scale = 1n;
  for (const [num, den] of factors) {
    if (num < 0n) throw new RangeError('a fee is between 0 and 10,000 bps');
    kept *= num;
    scale *= den;
  }
  return Number(mulDivCeil(scale - kept, BPS, scale));
}

/** How far a swap's price on the curve (fees excluded) is from the spot price before it, in basis points, rounded to nearest. */
export function curveImpactBps(r: Reserves, side: Side, netIn: bigint, amountOut: bigint): number {
  const quote = r.quoteReserve + r.virtualQuote;
  const base = r.baseReserve + r.virtualBase;
  if (netIn <= 0n || amountOut <= 0n || quote <= 0n || base <= 0n) return 0;
  // A buy pays netIn / amountOut and a sell gets amountOut / netIn, against the spot quote / base.
  const den = side === 'buy' ? amountOut * quote : netIn * quote;
  const num = side === 'buy' ? netIn * base - den : den - amountOut * base;
  if (num <= 0n) return 0;
  return Number((num * BPS * 2n + den) / (den * 2n));
}

// ---- max wallet (§4.3, §4.9) ------------------------------------------------------------------------

/** The max-wallet cap, fixed at launch (`bordrless_core::max_wallet_cap`): the launch supply times the bps, rounded down; 0 when off. */
export function maxWalletCap(supplyAtLaunch: bigint, maxWalletBps: number): bigint {
  if (maxWalletBps <= 0) return 0n;
  const cap = mulDivFloor(supplyAtLaunch, BigInt(maxWalletBps), BPS);
  return cap > U64_MAX ? U64_MAX : cap;
}

/** What a wallet holding `balance` can still receive: the kit refuses a transfer that would take it above `cap`. */
export function maxWalletLeft(cap: bigint, balance: bigint): bigint {
  return cap > balance ? cap - balance : 0n;
}

/**
 * The largest buy the pool can fill whose delivery stays within `allowance` tokens; 0 when no buy
 * does. Fees rounding up make the boundary ragged by a few base units, so this bisects on the exact
 * quote and then looks a little past the boundary.
 */
export function maxBuyWithin(r: Reserves, lpFeeBps: number, protocolShareBps: number, p: LaunchFeeParams, allowance: bigint): bigint {
  if (allowance <= 0n) return 0n;
  const quote = (amountIn: bigint): LaunchSwap => quoteLaunchSwap(r, 'buy', amountIn, lpFeeBps, protocolShareBps, p);
  const fits = (amountIn: bigint): boolean => {
    const q = quote(amountIn);
    return q.failure !== 'insufficient_liquidity' && (q.delivered === null || q.delivered <= allowance);
  };
  let lo = 0n;
  let hi = 1n;
  while (fits(hi)) {
    lo = hi;
    if (hi === U64_MAX) return U64_MAX;
    hi = hi * 2n > U64_MAX ? U64_MAX : hi * 2n;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  const top = lo + 64n < U64_MAX ? lo + 64n : U64_MAX;
  for (let a = lo + 1n; a <= top; a++) if (fits(a)) lo = a;
  // An input too small to buy anything is not a buy.
  return quote(lo).delivered === null ? 0n : lo;
}

/**
 * §8.2 `devBuyMaxLamports`: the largest first buy, in lamports, whose tokens after the buy burn stay
 * within max wallet at the opening reserves, with the fees of the creator's own first buy (the normal
 * LP fee, the creator fee and Bordrless's share of it; no holder fee, as nobody is eligible yet).
 * Null without max wallet. A bot that buys first only makes the creator receive less.
 */
export function devBuyMaxLamports(curve: CurveParams, supply: bigint, rules: LaunchRulesInput, creatorFeeBps: number, lpFeeBps: number, protocolShareBps: number): bigint | null {
  if (rules.maxWalletBps <= 0) return null;
  const opening: Reserves = { baseReserve: curve.curveTokens, quoteReserve: 0n, virtualBase: curve.virtualBase, virtualQuote: curve.virtualQuote };
  const fees: LaunchFeeParams = { creatorFeeBps, holderFeeBuyBps: 0, holderFeeSellBps: 0, burnBuyBps: rules.burnBuyBps, burnSellBps: rules.burnSellBps, eligible: 0n, minEligible: 0n };
  return maxBuyWithin(opening, lpFeeBps, protocolShareBps, fees, maxWalletCap(supply, rules.maxWalletBps));
}

// ---- holder rewards: the kit's accounting and its off-chain mirror (§4.3, §4.7, §4.8, §4.13) -------

/** Scale of the reward accounting: `acc_per_share` is lamports per eligible base unit times SCALE. */
export const SCALE = 10n ** 12n;
/** `min_eligible` is the supply / 1,000, set at init: holder fees wait until holders hold that much. */
export const MIN_ELIGIBLE_DIVISOR = 1_000n;
export const minEligibleFor = (supply: bigint): bigint => supply / MIN_ELIGIBLE_DIVISOR;
/** `min_eligible` at the policy supply: 1,000,000 whole tokens. */
export const MIN_ELIGIBLE = minEligibleFor(TOKEN_SUPPLY);
/** The least "Share with holders" takes: 0.001 SOL. */
export const MIN_SHARE_LAMPORTS = 1_000_000n;
/** A share streams to holders over this many seconds of eligible holding: from when it is made, or from when the share streaming then ends (§4.10, the review fixes). */
export const SHARE_STREAM_SECS = 3_600;
/** Claims below 0.0005 SOL (about 100 times a claim's network fee) are hidden by default (§7.3). */
export const CLAIM_DUST_LAMPORTS = 500_000n;
/**
 * The reward accounting `KitConfig` keeps (§4.3, with the review fixes); times are unix seconds.
 * The SDK's `kitRewardsOf` reads it from a decoded `KitConfig`.
 */
export interface KitRewards {
  /** Balances of every holding whose owner is not excluded (the pool and the launch are). */
  eligible: bigint;
  minEligible: bigint;
  /** Lamports per eligible base unit, times SCALE. */
  accPerShare: bigint;
  /** Scaled remainder of the last division, below the eligible supply it was divided by. */
  rem: bigint;
  /** Lamports waiting while nobody or too little is eligible (direct donations only: the stream pauses then). */
  held: bigint;
  /** `reward_vault.amount + total_claimed` at the last sync, counting shares as seen when they arrive. */
  seen: bigint;
  /** The running stream's lamports not yet released to holders. */
  streamRemaining: bigint;
  /** The running stream's last release. */
  streamLast: number;
  /** The running stream's end. While nobody is eligible it moves on with the clock. */
  streamEnd: number;
  /** Lamports shared while the stream runs, waiting for it: they stream over the hour after `streamEnd`. */
  streamNext: bigint;
  totalDistributed: bigint;
  totalClaimed: bigint;
  totalShared: bigint;
  /** `KitConfig.modules`: without holder rewards (bit 1) nothing is ever claimable. Absent counts as holder rewards on. */
  modules?: number;
}

/** A holding's hook data under the kit (§4.4). */
export interface KitHookData {
  /** `acc_per_share` at the holder's last settle. */
  snapshot: bigint;
  /** Rewards earned and not claimed, lamports. */
  owed: bigint;
  /** Tokens bought in the early window. */
  earlyLocked: bigint;
}

/** 64 bytes of hook data: snapshot u128, owed u64, early_locked u64, little-endian, then 32 reserved bytes. */
export function decodeKitHookData(data: Uint8Array): KitHookData {
  if (data.length !== HOOK_DATA_LEN) throw new RangeError(`hook data is ${HOOK_DATA_LEN} bytes, not ${data.length}`);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { snapshot: v.getBigUint64(0, true) | (v.getBigUint64(8, true) << 64n), owed: v.getBigUint64(16, true), earlyLocked: v.getBigUint64(24, true) };
}

/** The inverse of decodeKitHookData, reserved bytes zero. */
export function encodeKitHookData(d: KitHookData): Uint8Array {
  if (d.snapshot < 0n || d.snapshot >> 128n !== 0n || d.owed < 0n || d.owed > U64_MAX || d.earlyLocked < 0n || d.earlyLocked > U64_MAX) throw new RangeError('hook data out of range');
  const out = new Uint8Array(HOOK_DATA_LEN);
  const v = new DataView(out.buffer);
  v.setBigUint64(0, d.snapshot & U64_MAX, true);
  v.setBigUint64(8, d.snapshot >> 64n, true);
  v.setBigUint64(16, d.owed, true);
  v.setBigUint64(24, d.earlyLocked, true);
  return out;
}

// The share stream, as the review fixes left it (docs/hooks-v2.md, "Review fixes" note 2 and
// "Review fixes, second round" note 1). The running stream releases `streamRemaining` linearly over
// `[streamLast, streamEnd]`. A share made while it runs waits in `streamNext` and streams over the
// hour after it, `[streamEnd, streamEnd + 3,600]`. While holders hold less than `minEligible` the
// whole stream pauses: nothing is released and its end (with the waiting shares' hour) moves on
// with the clock. Every function below is a pure function of the account state; the program side
// (`kitRelease`, `kitSync`, `kitAddShare`, `kitSettle`, `kitShare`, `kitClaim`) mirrors
// `bordrless_kit::math` and the `share` and `claim` handlers, the mirror side (`streamAt`,
// `kitSynced`, `rewardsClaimable`, `rewardTotals`) mirrors `bordrless_kit::mirror`. Arithmetic is
// checked as the program checks it: what would overflow a u64 (a u128 for `accPerShare`) or go
// below zero is null, a state the program cannot reach.

/** Whether a sync divides among holders: `eligible > 0` and `eligible >= min_eligible` (`KitConfig::divides`). */
export const kitDivides = (k: Pick<KitRewards, 'eligible' | 'minEligible'>): boolean => k.eligible > 0n && k.eligible >= k.minEligible;

/** Whether holder rewards are on for this kit state (module 1; a state without `modules` counts as on). */
const kitRewardsOn = (k: Pick<KitRewards, 'modules'>): boolean => k.modules === undefined || (k.modules & KIT_MODULES.HOLDER_REWARDS) !== 0;

/**
 * What a linear stream of `amount` over `[from, to]` releases at `now`, rounded down: all of it at or
 * after `to`, nothing at or before `from` (`bordrless_kit::math::stream_release`, `mirror::linear`).
 */
export function linearRelease(amount: bigint, from: number, to: number, now: number): bigint {
  if (amount <= 0n) return 0n;
  if (now >= to) return amount;
  if (now <= from) return 0n;
  return (amount * BigInt(now - from)) / BigInt(to - from);
}

/** The stream at a moment: what it releases, and what is left running and waiting after it. */
export interface KitStream {
  released: bigint;
  streamRemaining: bigint;
  streamNext: bigint;
}

/**
 * The shared stream at `now` (`bordrless_kit::mirror::stream_at`): the running stream's linear
 * release; once it is out (`now >= streamEnd`), the waiting shares' release over the hour after its
 * end. Nothing while holders hold less than `minEligible`. Null on an overflow.
 */
export function streamAt(k: Pick<KitRewards, 'eligible' | 'minEligible' | 'streamRemaining' | 'streamLast' | 'streamEnd' | 'streamNext'>, now: number): KitStream | null {
  const running = k.streamRemaining;
  const waiting = k.streamNext;
  if (!kitDivides(k) || (running === 0n && waiting === 0n)) return { released: 0n, streamRemaining: running, streamNext: waiting };
  const first = linearRelease(running, k.streamLast, k.streamEnd, now);
  const left = running - first;
  if (left > 0n || waiting === 0n || now < k.streamEnd) return { released: first, streamRemaining: left, streamNext: waiting };
  const second = linearRelease(waiting, k.streamEnd, k.streamEnd + SHARE_STREAM_SECS, now);
  const released = first + second;
  if (released > U64_MAX) return null;
  return { released, streamRemaining: waiting - second, streamNext: 0n };
}

/** What the shared stream releases at `now`, rounded down (`mirror::released_at`): 0 while nobody is eligible. */
export function streamReleased(k: Pick<KitRewards, 'eligible' | 'minEligible' | 'streamRemaining' | 'streamLast' | 'streamEnd' | 'streamNext'>, now: number): bigint | null {
  return streamAt(k, now)?.released ?? null;
}

/** The state a sync at `now` would leave, without writing anything (`bordrless_kit::mirror::Synced`). */
export interface KitSynced {
  /** What the shared stream releases at `now`. */
  released: bigint;
  /** What arrived since the last sync (`vault + total_claimed - seen`), plus `released`. */
  pending: bigint;
  /** Whether this sync divides: holders hold at least `minEligible`, and there is something to divide. */
  divides: boolean;
  accPerShare: bigint;
  held: bigint;
  /** The running stream's lamports not yet released, after the sync. */
  streamRemaining: bigint;
  /** Shares waiting for the running stream, after the sync. */
  streamNext: bigint;
  /** `total_distributed` after the sync. */
  distributed: bigint;
  /** Shared lamports not yet released: `streamRemaining + streamNext` (saturating), i.e. `stream_remaining + stream_next - released`. */
  streaming: bigint;
}

/** The mirror's sync at `now` with the reward vault holding `vaultAmount` (`bordrless_kit::mirror::synced`). Null when the state is impossible. */
export function kitSynced(k: KitRewards, vaultAmount: bigint, now: number): KitSynced | null {
  const stream = streamAt(k, now);
  if (!stream) return null;
  const total = vaultAmount + k.totalClaimed;
  if (total > U64_MAX || total < k.seen) return null;
  const pending = total - k.seen + stream.released;
  const pot = pending + k.held;
  if (pending > U64_MAX || pot > U64_MAX) return null;
  const eligible = kitDivides(k);
  const divides = eligible && pot > 0n;
  let accPerShare = k.accPerShare;
  if (divides) {
    const scaled = pot * SCALE + k.rem;
    if (scaled > U128_MAX) return null;
    accPerShare += scaled / k.eligible;
    if (accPerShare > U128_MAX) return null;
  }
  const distributed = divides ? k.totalDistributed + pot : k.totalDistributed;
  if (distributed > U64_MAX) return null;
  const streaming = stream.streamRemaining + stream.streamNext;
  return {
    released: stream.released,
    pending,
    divides,
    accPerShare,
    held: eligible ? 0n : pot,
    streamRemaining: stream.streamRemaining,
    streamNext: stream.streamNext,
    distributed,
    streaming: streaming > U64_MAX ? U64_MAX : streaming,
  };
}

/**
 * The off-chain mirror (§4.13) at `now` (`bordrless_kit::mirror::claimable`): what a holder could
 * claim, from `KitConfig`, the reward vault's balance, the holding's balance and its hook data, and
 * what a claim would pay (no more than the vault holds). 0 for the pool and the launch (`excluded`)
 * and for a token without holder rewards. Null when the kit's state cannot be synced.
 */
export function rewardsClaimable(k: KitRewards, vaultAmount: bigint, now: number, balance: bigint, data: KitHookData, excluded = false): { claimable: bigint; payable: bigint } | null {
  if (excluded || !kitRewardsOn(k)) return { claimable: 0n, payable: 0n };
  const after = kitSynced(k, vaultAmount, now);
  if (!after || data.snapshot > after.accPerShare) return null;
  const product = balance * (after.accPerShare - data.snapshot);
  if (product > U128_MAX) return null;
  const earned = product / SCALE;
  const claimable = data.owed + earned;
  if (earned > U64_MAX || claimable > U64_MAX) return null;
  return { claimable, payable: claimable < vaultAmount ? claimable : vaultAmount };
}

/**
 * §4.13 totals at `now`, lamports: distributed (with what the next sync would distribute), claimed,
 * shared, and shared but still streaming (`rewardsStreaming`: `stream_remaining + stream_next -
 * released`); also what the stream releases now and what waits in `held`. Null when the state
 * cannot be synced.
 */
export function rewardTotals(k: KitRewards, vaultAmount: bigint, now: number): { distributed: bigint; claimed: bigint; shared: bigint; streaming: bigint; released: bigint; held: bigint } | null {
  const s = kitSynced(k, vaultAmount, now);
  return s ? { distributed: s.distributed, claimed: k.totalClaimed, shared: k.totalShared, streaming: s.streaming, released: s.released, held: s.held } : null;
}

/**
 * `KitConfig::release` at `now`, as the program runs it: the running stream releases linearly; once
 * it is out the waiting shares become the running stream over the hour after its end, and the part
 * of that hour already past is released with it. While nobody is eligible nothing is released and
 * the end moves on by the time that passed. Null on an overflow.
 */
export function kitRelease(k: KitRewards, now: number): { state: KitRewards; released: bigint } | null {
  if (k.streamRemaining === 0n && k.streamNext === 0n) return { state: k, released: 0n };
  if (!kitDivides(k)) {
    if (now > k.streamLast) return { state: { ...k, streamEnd: k.streamEnd + (now - k.streamLast), streamLast: now }, released: 0n };
    return { state: k, released: 0n };
  }
  let released = linearRelease(k.streamRemaining, k.streamLast, k.streamEnd, now);
  let state: KitRewards = { ...k, streamRemaining: k.streamRemaining - released, streamLast: Math.max(k.streamLast, now) };
  if (state.streamRemaining === 0n && state.streamNext > 0n && now >= state.streamEnd) {
    // The waiting shares' hour began when the running stream ended.
    const start = state.streamEnd;
    const end = start + SHARE_STREAM_SECS;
    const part = linearRelease(state.streamNext, start, end, now);
    state = { ...state, streamRemaining: state.streamNext - part, streamNext: 0n, streamEnd: end };
    released += part;
    if (released > U64_MAX) return null;
  }
  return { state, released };
}

/**
 * The kit's sync at `now` as the program runs it (`KitConfig::sync`, §4.7 with the review fixes):
 * the stream releases (`kitRelease`), then what reached the reward vault since the last sync plus
 * what was released is spread over the eligible supply with the exact scaled remainder kept, or held
 * while nobody or too little is eligible. Null when the vault and the claims fall short of what the
 * accounting has seen, or on an overflow, which the program reverts on.
 */
export function kitSync(k: KitRewards, vaultAmount: bigint, now: number): KitRewards | null {
  const release = kitRelease(k, now);
  if (!release) return null;
  const s = release.state;
  const total = vaultAmount + s.totalClaimed;
  if (total > U64_MAX || total < s.seen) return null;
  const fresh = total - s.seen + release.released;
  if (fresh > U64_MAX) return null;
  if (!kitDivides(s)) {
    const held = s.held + fresh;
    return held > U64_MAX ? null : { ...s, seen: total, held };
  }
  const pot = fresh + s.held;
  if (pot > U64_MAX) return null;
  if (pot === 0n) return { ...s, seen: total, held: 0n };
  const scaled = pot * SCALE + s.rem;
  const inc = scaled / s.eligible;
  const accPerShare = s.accPerShare + inc;
  const totalDistributed = s.totalDistributed + pot;
  if (scaled > U128_MAX || accPerShare > U128_MAX || totalDistributed > U64_MAX) return null;
  return { ...s, seen: total, held: 0n, rem: scaled - inc * s.eligible, accPerShare, totalDistributed };
}

/**
 * `KitConfig::add_share`: a share of `received` lamports made at `now`, right after the sync at
 * `now`, counted as seen and streamed over one hour at its own rate: at once when nothing streams or
 * waits; joining the running stream when that stream's whole hour is still ahead; otherwise waiting
 * with any shares already waiting, for the hour after the running stream. Null (the program's
 * `MathOverflow`, a bug) when the stream was not synced at `now`, or on an overflow.
 */
export function kitAddShare(k: KitRewards, received: bigint, now: number): KitRewards | null {
  const at = Math.max(now, k.streamLast);
  let s: KitRewards;
  if (k.streamRemaining === 0n && k.streamNext === 0n) {
    s = { ...k, streamRemaining: received, streamLast: at, streamEnd: at + SHARE_STREAM_SECS };
  } else {
    const left = k.streamEnd - at;
    if (k.streamLast !== at || left <= 0) return null;
    s = k.streamRemaining > 0n && left === SHARE_STREAM_SECS ? { ...k, streamRemaining: k.streamRemaining + received } : { ...k, streamNext: k.streamNext + received };
  }
  s = { ...s, seen: s.seen + received, totalShared: s.totalShared + received };
  if (s.streamRemaining > U64_MAX || s.streamNext > U64_MAX || s.seen > U64_MAX || s.totalShared > U64_MAX) return null;
  return s;
}

/**
 * The kit's settle (§4.8, `bordrless_kit::math::settle`) of a holder at its balance before the
 * operation: `owed += balance * (accPerShare - snapshot) / SCALE` (floor), then `snapshot =
 * accPerShare`, or 0 when the balance after the operation is 0. Null when the snapshot is above the
 * accumulator or on an overflow (the program's `MathOverflow`).
 */
export function kitSettle(d: KitHookData, balance: bigint, balanceAfter: bigint, accPerShare: bigint): KitHookData | null {
  if (d.snapshot > accPerShare) return null;
  const product = balance * (accPerShare - d.snapshot);
  if (product > U128_MAX) return null;
  const earned = product / SCALE;
  const owed = d.owed + earned;
  if (earned > U64_MAX || owed > U64_MAX) return null;
  return { ...d, owed, snapshot: balanceAfter === 0n ? 0n : accPerShare };
}

/**
 * The kit's `share(amount)` at `now` with the reward vault holding `vaultAmount`: refused (null) below
 * MIN_SHARE_LAMPORTS, while nobody is eligible or without holder rewards; else the sync, the
 * transfer into the vault (bridged SOL has no hook, so all of it arrives) and `kitAddShare`.
 */
export function kitShare(k: KitRewards, vaultAmount: bigint, amount: bigint, now: number): { state: KitRewards; vault: bigint } | null {
  if (amount < MIN_SHARE_LAMPORTS || !kitRewardsOn(k) || !kitDivides(k)) return null;
  const synced = kitSync(k, vaultAmount, now);
  if (!synced) return null;
  const vault = vaultAmount + amount;
  const state = kitAddShare(synced, amount, now);
  return state && vault <= U64_MAX ? { state, vault } : null;
}

/**
 * The kit's `claim` at `now` by a holder with `balance` and hook data `data`: the sync, the settle at
 * the balance, then `min(owed, vault)` paid. Null when the kit refuses it: the pool or the launch
 * (`excluded`), no holder rewards, nothing to pay, or a state it cannot sync. The early-buyer bytes
 * of the hook data are kept as they are.
 */
export function kitClaim(k: KitRewards, vaultAmount: bigint, now: number, balance: bigint, data: KitHookData, excluded = false): { state: KitRewards; vault: bigint; data: KitHookData; pay: bigint } | null {
  if (excluded || !kitRewardsOn(k)) return null;
  const synced = kitSync(k, vaultAmount, now);
  if (!synced) return null;
  const settled = kitSettle(data, balance, balance, synced.accPerShare);
  if (!settled) return null;
  const pay = settled.owed < vaultAmount ? settled.owed : vaultAmount;
  if (pay === 0n || synced.totalClaimed + pay > U64_MAX) return null;
  return { state: { ...synced, totalClaimed: synced.totalClaimed + pay }, vault: vaultAmount - pay, data: { ...settled, owed: settled.owed - pay }, pay };
}

/**
 * When a share made at `now` starts streaming, unix seconds (§7.3's share copy, as the second round
 * of review fixes words it): `now` when nothing streams or waits, or when the running stream's whole
 * hour is still ahead (the share joins it); otherwise when the running stream ends, after the sync
 * the share makes first. Null while nobody is eligible (the kit refuses a share then) or when the
 * state cannot be synced.
 */
export function shareStartsAt(k: KitRewards, vaultAmount: bigint, now: number): number | null {
  if (!kitRewardsOn(k) || !kitDivides(k)) return null;
  const s = kitSync(k, vaultAmount, now);
  if (!s) return null;
  const at = Math.max(now, s.streamLast);
  if (s.streamRemaining === 0n && s.streamNext === 0n) return at;
  if (s.streamRemaining > 0n && s.streamEnd - at === SHARE_STREAM_SECS) return at;
  return s.streamEnd;
}
