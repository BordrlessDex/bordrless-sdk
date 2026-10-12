/**
 * `bordrless mm`: the decision rules of the self-custodied market maker, apart from the chain
 * (cli/mmRun.ts reads the pool and the wallet, builds and sends the swaps; this module decides).
 *
 * A reference price starts at the pool's spot (quote reserve over base reserve, virtual reserves
 * included) and moves to the fill price after each trade, so the bot ladders: it keeps buying on
 * further drops and selling on further rises. Every evaluation: a price at or below the reference
 * less `step` buys `buy` percent of the wallet's SOL (bridged SOL first, plain SOL wrapped for the
 * rest, at most `max-sol`, a reserve kept back for fees); a price at or above the reference plus
 * `step` sells `sell` percent of the wallet's tokens (at most `max-tokens`); anything else waits.
 * A trade that would be dust (under [`DUST_LAMPORTS`] in or out) is not made. Prices are kept as
 * exact ratios of base units and compared by cross-multiplication, never as floats.
 */
import { BPS, mulDivFloor, type Reserves, type Side } from '@bordrless/shared';

/** A price as a ratio: `quote` base units of the quote per `base` base units of the token. */
export interface Price {
  quote: bigint;
  base: bigint;
}

/** The pool's spot price: its effective reserves (real plus virtual) as a ratio. */
export const spotPrice = (r: Reserves): Price => ({ quote: r.quoteReserve + r.virtualQuote, base: r.baseReserve + r.virtualBase });

/** `p` is at or below `ref` less `bps` basis points. */
export const belowReference = (p: Price, ref: Price, bps: number): boolean => p.quote * ref.base * BPS <= ref.quote * p.base * (BPS - BigInt(bps));

/** `p` is at or above `ref` plus `bps` basis points. */
export const aboveReference = (p: Price, ref: Price, bps: number): boolean => p.quote * ref.base * BPS >= ref.quote * p.base * (BPS + BigInt(bps));

/** The move from `ref` to `p` in basis points, signed, rounded toward zero (for display). */
export function moveBps(p: Price, ref: Price): number {
  if (ref.quote === 0n || p.base === 0n) return 0;
  return Number(((p.quote * ref.base - ref.quote * p.base) * BPS) / (ref.quote * p.base));
}

/** A price as a number of whole quote units per whole token (display only). */
export function priceNumber(p: Price, baseDecimals: number, quoteDecimals: number): number {
  if (p.base === 0n) return 0;
  return (Number(p.quote) / Number(p.base)) * 10 ** (baseDecimals - quoteDecimals);
}

/** A price typed as whole quote units per whole token (`--ref 0.00000018`), as an exact ratio. */
export function parsePrice(text: string, baseDecimals: number, quoteDecimals: number): Price {
  const scaled = parseDecimal(text, 18);
  if (scaled <= 0n) throw new Error('a reference price is positive');
  return { quote: scaled * 10n ** BigInt(quoteDecimals), base: 10n ** 18n * 10n ** BigInt(baseDecimals) };
}

// ---- amounts ---------------------------------------------------------------------------------------

/** `text` (`0.5`, `12`) in base units of `decimals`; more fraction digits than `decimals` are refused. */
export function parseDecimal(text: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (!m || text.trim() === '.') throw new Error(`not a number: ${text}`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`${text.trim()} has more than ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** `amount` base units of `decimals` as text, trailing zeros trimmed, at most `maxFraction` fraction digits. */
export function formatUnits(amount: bigint, decimals: number, maxFraction = decimals): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, '0').slice(0, Math.max(0, maxFraction)).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

/** `bps` as a percentage with two decimals (`125` is `1.25%`). */
export const formatBps = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/** A price for people: whole quote units per whole token, with enough digits for a small one. */
export function formatPrice(p: Price, baseDecimals: number, quoteDecimals: number): string {
  const n = priceNumber(p, baseDecimals, quoteDecimals);
  if (n === 0) return '0';
  const text = n >= 1 ? n.toFixed(6) : n.toFixed(12);
  return text.replace(/\.?0+$/, '');
}

// ---- rules -----------------------------------------------------------------------------------------

/** Kept back from the wallet's plain SOL for network fees and the holdings' rent: 0.02 SOL. */
export const SOL_RESERVE_LAMPORTS = 20_000_000n;
/** A trade moving less than this in or out is dust and is not made: 0.0001 SOL. */
export const DUST_LAMPORTS = 100_000n;

/** The flags' defaults, as typed on the command line. */
export const MM_DEFAULTS = { step: '1', buy: '1', sell: '1', interval: '20', maxSol: '0.5', slippage: '1' } as const;

export interface Rules {
  /** The move from the reference that triggers a trade, in basis points. */
  stepBps: number;
  /** The share of the wallet's SOL (plain above the reserve, plus bridged) one buy spends. */
  buyBps: number;
  /** The share of the wallet's tokens one sell spends. */
  sellBps: number;
  /** The most one buy spends. */
  maxSolLamports: bigint;
  /** The most one sell spends, in base units; null for no cap. */
  maxTokens: bigint | null;
  slippageBps: number;
  intervalSecs: number;
  reserveLamports: bigint;
}

/** A percentage flag (`1`, `0.5`, `2.25`) in basis points, within `bounds`; the default when the flag is absent. */
export function percentBps(flag: string | true | undefined, name: string, fallback: string, bounds: { min: number; max: number }): number {
  if (flag === true) throw new Error(`--${name} takes a percentage`);
  const text = flag ?? fallback;
  let bps: number;
  try {
    bps = Number(parseDecimal(text, 2));
  } catch {
    throw new Error(`--${name}: not a percentage: ${text}`);
  }
  if (bps < bounds.min || bps > bounds.max) throw new Error(`--${name} is between ${formatBps(bounds.min)} and ${formatBps(bounds.max)}`);
  return bps;
}

/** The rules from the command line (`tokenDecimals` turns `--max-tokens`, whole tokens, into base units). */
export function rulesOf(flags: Record<string, string | true>, tokenDecimals: number): Rules {
  const text = (name: string, fallback: string | null): string | null => {
    const f = flags[name];
    if (f === true) throw new Error(`--${name} takes a value`);
    return f ?? fallback;
  };
  const interval = Number(text('interval', MM_DEFAULTS.interval));
  if (!Number.isInteger(interval) || interval < 2) throw new Error('--interval is a whole number of seconds, at least 2');
  const maxTokensText = text('max-tokens', null);
  const maxSol = parseDecimal(text('max-sol', MM_DEFAULTS.maxSol)!, 9);
  if (maxSol <= 0n) throw new Error('--max-sol is positive');
  const maxTokens = maxTokensText === null ? null : parseDecimal(maxTokensText, tokenDecimals);
  if (maxTokens !== null && maxTokens <= 0n) throw new Error('--max-tokens is positive');
  return {
    stepBps: percentBps(flags.step, 'step', MM_DEFAULTS.step, { min: 1, max: 5_000 }),
    buyBps: percentBps(flags.buy, 'buy', MM_DEFAULTS.buy, { min: 1, max: 10_000 }),
    sellBps: percentBps(flags.sell, 'sell', MM_DEFAULTS.sell, { min: 1, max: 10_000 }),
    maxSolLamports: maxSol,
    maxTokens,
    slippageBps: percentBps(flags.slippage, 'slippage', MM_DEFAULTS.slippage, { min: 1, max: 5_000 }),
    intervalSecs: interval,
    reserveLamports: SOL_RESERVE_LAMPORTS,
  };
}

// ---- sizing ----------------------------------------------------------------------------------------

export interface Wallet {
  /** Plain SOL. */
  lamports: bigint;
  /** The bridged-SOL holding's balance. */
  bridgedSol: bigint;
  /** The token holding's balance, base units. */
  tokens: bigint;
}

const sol = (lamports: bigint): string => `${formatUnits(lamports, 9, 6)} SOL`;

/**
 * What one buy spends: `buy` percent of the wallet's SOL (bridged, plus plain above the reserve),
 * at most `max-sol`; `wrap` is the plain SOL wrapped on the way when the bridged balance does not
 * cover it. `none` says why there is no buy to make.
 */
export function buySize(w: Wallet, rules: Rules): { lamportsIn: bigint; wrap: bigint } | { none: string } {
  const plain = w.lamports > rules.reserveLamports ? w.lamports - rules.reserveLamports : 0n;
  const total = w.bridgedSol + plain;
  let want = mulDivFloor(total, BigInt(rules.buyBps), BPS);
  if (want > rules.maxSolLamports) want = rules.maxSolLamports;
  if (want < DUST_LAMPORTS) {
    if (total < DUST_LAMPORTS) return { none: `the wallet has no SOL to buy with (${sol(w.lamports)} plain, ${sol(rules.reserveLamports)} of it kept for fees; ${sol(w.bridgedSol)} bridged)` };
    return { none: `${formatBps(rules.buyBps)} of its ${sol(total)} is below dust (${sol(DUST_LAMPORTS)})` };
  }
  return { lamportsIn: want, wrap: want > w.bridgedSol ? want - w.bridgedSol : 0n };
}

/** What one sell spends: `sell` percent of the wallet's tokens, at most `max-tokens`. */
export function sellSize(w: Wallet, rules: Rules): { tokensIn: bigint } | { none: string } {
  let want = mulDivFloor(w.tokens, BigInt(rules.sellBps), BPS);
  if (rules.maxTokens !== null && want > rules.maxTokens) want = rules.maxTokens;
  if (want <= 0n) return { none: w.tokens === 0n ? 'the wallet holds none of the token' : `${formatBps(rules.sellBps)} of its holding rounds to nothing` };
  return { tokensIn: want };
}

// ---- the decision ----------------------------------------------------------------------------------

/** What the pool would deliver for `amountIn` on `side`, or why it would not. */
export type Quote = { amountOut: bigint } | { failure: string };
export type Quoter = (side: Side, amountIn: bigint) => Quote;

export type Decision =
  | { action: 'buy'; amountIn: bigint; wrap: bigint; expectedOut: bigint; minOut: bigint; move: number }
  | { action: 'sell'; amountIn: bigint; expectedOut: bigint; minOut: bigint; move: number }
  | { action: 'wait'; reason: string; move: number };

/** The least a trade may deliver under `slippageBps`. */
export const minOutOf = (amountOut: bigint, slippageBps: number): bigint => mulDivFloor(amountOut, BPS - BigInt(slippageBps), BPS);

const signed = (bps: number): string => `${bps > 0 ? '+' : bps < 0 ? '-' : ''}${formatBps(Math.abs(bps))}`;

/** One evaluation: the trade to make at `spot` against `ref`, with the wallet as it is, or why to wait. */
export function decide(spot: Price, ref: Price, rules: Rules, wallet: Wallet, quote: Quoter): Decision {
  const move = moveBps(spot, ref);
  const wait = (reason: string): Decision => ({ action: 'wait', reason, move });
  if (belowReference(spot, ref, rules.stepBps)) {
    const size = buySize(wallet, rules);
    if ('none' in size) return wait(`a buy is due (${signed(move)} from the reference) but ${size.none}`);
    const q = quote('buy', size.lamportsIn);
    if ('failure' in q) return wait(`a buy of ${sol(size.lamportsIn)} is due but the pool cannot fill it: ${q.failure}`);
    if (q.amountOut <= 0n) return wait(`a buy of ${sol(size.lamportsIn)} is due but would get no tokens back`);
    return { action: 'buy', amountIn: size.lamportsIn, wrap: size.wrap, expectedOut: q.amountOut, minOut: minOutOf(q.amountOut, rules.slippageBps), move };
  }
  if (aboveReference(spot, ref, rules.stepBps)) {
    const size = sellSize(wallet, rules);
    if ('none' in size) return wait(`a sell is due (${signed(move)} from the reference) but ${size.none}`);
    const q = quote('sell', size.tokensIn);
    if ('failure' in q) return wait(`a sell is due but the pool cannot fill it: ${q.failure}`);
    if (q.amountOut < DUST_LAMPORTS) return wait(`a sell is due but would bring back ${sol(q.amountOut)}, under dust (${sol(DUST_LAMPORTS)})`);
    return { action: 'sell', amountIn: size.tokensIn, expectedOut: q.amountOut, minOut: minOutOf(q.amountOut, rules.slippageBps), move };
  }
  return wait(`${signed(move)} from the reference, within ${formatBps(rules.stepBps)}`);
}

/** The price a trade filled at: quote spent over tokens received on a buy, quote received over tokens spent on a sell. */
export function fillPrice(side: Side, amountIn: bigint, amountOut: bigint): Price {
  return side === 'buy' ? { quote: amountIn, base: amountOut } : { quote: amountOut, base: amountIn };
}

/**
 * The reference after a trade: its fill price, unless the trade itself moved the pool a whole step
 * past that fill (a buy large against the pool leaves the spot a step above what it paid): the spot
 * right after it then, so the bot never trades straight back against its own fill, paying two sets
 * of fees for nothing.
 */
export function referenceAfter(side: Side, fill: Price, spotAfter: Price, stepBps: number): Price {
  if (fill.base === 0n || fill.quote === 0n) return spotAfter;
  if (side === 'buy' && aboveReference(spotAfter, fill, stepBps)) return spotAfter;
  if (side === 'sell' && belowReference(spotAfter, fill, stepBps)) return spotAfter;
  return fill;
}

// ---- the pool account's layout --------------------------------------------------------------------

/**
 * Byte offsets inside a DEX `Pool` account, for `getProgramAccounts` filters: the 8-byte
 * discriminator, then `version`, `bump` and `lp_mint_bump` (a byte each), then `base_mint` and
 * `quote_mint`. Pinned to the IDL in mm.test.ts.
 */
export const POOL_BASE_MINT_OFFSET = 11;
export const POOL_QUOTE_MINT_OFFSET = 43;
