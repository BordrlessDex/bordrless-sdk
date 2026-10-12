/**
 * Snowball (2026-10-12): a companion whose pot makes volume in its own token
 * (`programs/bordrless_companion/src/instructions/snowball.rs`). `companion.createSnowball` (after
 * `create`, before `launch`) sets the pot's part of every fee claim and the market maker's terms;
 * every fee claim adds that part to the pot (`Companion.pendingPot`), and `companion.snowballStep`
 * (anyone, paid a bounty) trades on the token's own pool once an interval: a buy of `buyBps` of the
 * pot when the price drops `buyStepBps` below the reference, a sell of `sellBps` of its tokens when
 * it rises `sellStepBps` above, the reference moving to the price each trade leaves. With
 * `flatTrades` it trades every interval even when the price has not moved, on the side that
 * rebalances what it holds, so the pot keeps cycling; without, the reference follows the price when
 * the side it calls for has nothing to trade. A trade moves at most `maxTrade` and `poolBps` of the
 * pool's SOL side.
 *
 * Held to the program's client by `vectors/snowball.json` (bordrless-programs' `snowball_vectors`).
 */
import type { PublicKey } from '@solana/web3.js';
import { CODERS } from './coders.ts';
import type { Companion, CompanionSplit } from './companion.ts';

/** `create_snowball`'s arguments. */
export interface SnowballArgs {
  /** Every fee claim's split besides the pot: with `potBps` the four sum to 10,000. Replaces `create`'s. */
  split: CompanionSplit;
  /** The pot's part of every fee claim: what the market maker trades with. */
  potBps: number;
  /** The drop that triggers a buy and the rise that triggers a sell: 50 to 2,000 each (0.5% to 20%). */
  buyStepBps: number;
  sellStepBps: number;
  /** The share of the pot a buy spends, and of its tokens a sell sells: 100 to 10,000 each. */
  buyBps: number;
  sellBps: number;
  /** The least time between trades, seconds: 10 to a day. */
  interval: number;
  /** The most one trade moves, lamports (at least 0.01 SOL). */
  maxTrade: bigint;
  /** The most one trade moves as a share of the pool's SOL side: 25 to 1,000 (0.25% to 10%). */
  poolBps: number;
  /** Trade every interval even when the price has not moved a step. */
  flatTrades: boolean;
}

/** The program's bounds (`constants.rs`), and the least a trade is worth. */
export const SNOWBALL_LIMITS = {
  minStepBps: 50,
  maxStepBps: 2_000,
  minSizeBps: 100,
  maxSizeBps: 10_000,
  minPoolBps: 25,
  maxPoolBps: 1_000,
  minInterval: 10,
  maxInterval: 86_400,
  minTrade: 1_000_000n,
  minMaxTrade: 10_000_000n,
  /** No trade in a launch's first minute (the buyback's rule), nor before its early-buyer window ends. */
  afterLaunchSecs: 60,
} as const;

/** The absolute cap on one trade the site launches with: 100 SOL (the pool share binds first). */
export const SNOWBALL_MAX_TRADE = 100_000_000_000n;

/** Why `create_snowball` would refuse these terms, in one sentence; null when it would not. */
export function snowballArgsProblem(args: SnowballArgs): string | null {
  const L = SNOWBALL_LIMITS;
  const s = args.split;
  const within = (v: number, lo: number, hi: number): boolean => Number.isInteger(v) && v >= lo && v <= hi;
  if (!(args.potBps > 0) || s.buybackBps + s.holdersBps + s.beneficiaryBps + args.potBps !== 10_000) return 'The market maker’s part and the split must add up to 10,000 basis points, with a part for the market maker.';
  if (!within(args.buyStepBps, L.minStepBps, L.maxStepBps) || !within(args.sellStepBps, L.minStepBps, L.maxStepBps)) return 'A buy and a sell trigger on a move of 0.5% to 20%.';
  if (!within(args.buyBps, L.minSizeBps, L.maxSizeBps) || !within(args.sellBps, L.minSizeBps, L.maxSizeBps)) return 'A trade moves 1% to 100% of the pot or of the tokens held.';
  if (!within(args.poolBps, L.minPoolBps, L.maxPoolBps)) return 'A trade moves at most 0.25% to 10% of the pool.';
  if (!within(args.interval, L.minInterval, L.maxInterval)) return 'Trades are 10 seconds to a day apart.';
  if (args.maxTrade < L.minMaxTrade) return 'A trade may move at least 0.01 SOL.';
  return null;
}

/** A Snowball's market maker, `PDA(["snowball", mint])`. Its SOL is `Companion.pendingPot`. */
export interface Snowball {
  mint: PublicKey;
  buyStepBps: number;
  sellStepBps: number;
  buyBps: number;
  sellBps: number;
  interval: number;
  maxTrade: bigint;
  poolBps: number;
  flatTrades: boolean;
  /** Quote per base unit times 10^12; 0 until the first step (the companion's opening reference stands in). */
  referencePrice: bigint;
  lastAt: number;
  /** Tokens it holds (bought, not sold yet); any dev bag beside them is the companion's. */
  tokensHeld: bigint;
  buys: number;
  sells: number;
  solSpent: bigint;
  solReceived: bigint;
  tokensBought: bigint;
  tokensSold: bigint;
  bountiesTotal: bigint;
  createdAt: number;
}

const big = (v: unknown): bigint => BigInt(String(v));
const num = (v: unknown): number => Number(String(v));

export function decodeSnowball(data: Buffer): Snowball {
  const r = CODERS.companion.accounts.decode('snowball', data) as Record<string, unknown>;
  return {
    mint: r.mint as PublicKey,
    buyStepBps: num(r.buyStepBps),
    sellStepBps: num(r.sellStepBps),
    buyBps: num(r.buyBps),
    sellBps: num(r.sellBps),
    interval: num(r.interval),
    maxTrade: big(r.maxTrade),
    poolBps: num(r.poolBps),
    flatTrades: Boolean(r.flatTrades),
    referencePrice: big(r.referencePrice),
    lastAt: num(r.lastAt),
    tokensHeld: big(r.tokensHeld),
    buys: num(r.buys),
    sells: num(r.sells),
    solSpent: big(r.solSpent),
    solReceived: big(r.solReceived),
    tokensBought: big(r.tokensBought),
    tokensSold: big(r.tokensSold),
    bountiesTotal: big(r.bountiesTotal),
    createdAt: num(r.createdAt),
  };
}

/** Prices are quote per base unit times this (`PRICE_SCALE`). */
export const SNOWBALL_PRICE_SCALE = 1_000_000_000_000n;

/** The pool's price as the companion reads it: its quote side over its base side, real and virtual, times 10^12; null for an empty pool. */
export function companionSpotPrice(pool: { quoteReserve: bigint; virtualQuote: bigint; baseReserve: bigint; virtualBase: bigint }): bigint | null {
  const base = pool.baseReserve + pool.virtualBase;
  return base > 0n ? ((pool.quoteReserve + pool.virtualQuote) * SNOWBALL_PRICE_SCALE) / base : null;
}

/** The reference a step measures from: the Snowball's, or the companion's opening reference before the first step. */
export const snowballReference = (s: Pick<Snowball, 'referencePrice'>, c: Pick<Companion, 'referencePrice'>): bigint => (s.referencePrice === 0n ? c.referencePrice : s.referencePrice);

/** The prices that trigger a buy (at or below) and a sell (at or above). */
export function snowballBand(reference: bigint, buyStepBps: number, sellStepBps: number): { buyBelow: bigint; sellAbove: bigint } {
  return { buyBelow: (reference * BigInt(10_000 - buyStepBps)) / 10_000n, sellAbove: (reference * BigInt(10_000 + sellStepBps)) / 10_000n };
}

/**
 * Whether a step is due now, and which way it would most likely go (the program decides from the
 * exact sizes): the side a step calls for; with flat trades, otherwise the side that rebalances what
 * it holds; null when nothing is due (too soon; or no step and no flat trades). `earlyWindowEnd` is
 * the launch's (0 when off). What the keeper sends and the token page shows.
 */
export function snowballMove(s: Snowball, c: Pick<Companion, 'launched' | 'launchedAt' | 'referencePrice' | 'pendingPot'>, earlyWindowEnd: number, spot: bigint, now: number): 'buy' | 'sell' | null {
  if (!c.launched) return null;
  const opens = Math.max(c.launchedAt + SNOWBALL_LIMITS.afterLaunchSecs, earlyWindowEnd);
  if (now < opens || now < s.lastAt + s.interval) return null;
  const { buyBelow, sellAbove } = snowballBand(snowballReference(s, c), s.buyStepBps, s.sellStepBps);
  const canBuy = (c.pendingPot * BigInt(s.buyBps)) / 10_000n >= SNOWBALL_LIMITS.minTrade;
  const canSell = (((s.tokensHeld * BigInt(s.sellBps)) / 10_000n) * spot) / SNOWBALL_PRICE_SCALE >= SNOWBALL_LIMITS.minTrade;
  if (spot <= buyBelow && (canBuy || !s.flatTrades)) return 'buy';
  if (spot >= sellAbove && (canSell || !s.flatTrades)) return 'sell';
  if (!s.flatTrades) return null;
  const tokensValue = (s.tokensHeld * spot) / SNOWBALL_PRICE_SCALE;
  const preferSell = tokensValue > c.pendingPot;
  if (preferSell && canSell) return 'sell';
  if (!preferSell && canBuy) return 'buy';
  if (canSell) return 'sell';
  if (canBuy) return 'buy';
  return null;
}
