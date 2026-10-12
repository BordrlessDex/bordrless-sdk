/** `bordrless mm`: the market maker's decision rules (reference, thresholds, sizing, caps, reserve, dust). */
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { swapAmounts } from '@bordrless/shared';
import { CODERS } from '../coders.ts';
import {
  DUST_LAMPORTS,
  POOL_BASE_MINT_OFFSET,
  POOL_QUOTE_MINT_OFFSET,
  SOL_RESERVE_LAMPORTS,
  aboveReference,
  belowReference,
  buySize,
  decide,
  fillPrice,
  formatBps,
  formatPrice,
  formatUnits,
  minOutOf,
  moveBps,
  parseDecimal,
  parsePrice,
  percentBps,
  priceNumber,
  referenceAfter,
  rulesOf,
  sellSize,
  spotPrice,
  type Price,
  type Quoter,
  type Rules,
  type Wallet,
} from './mm.ts';

const SOL = 1_000_000_000n;
const TOKEN = 1_000_000n;
const rules: Rules = { stepBps: 100, buyBps: 100, sellBps: 100, maxSolLamports: SOL / 2n, maxTokens: null, slippageBps: 100, intervalSecs: 20, reserveLamports: SOL_RESERVE_LAMPORTS };
/** A pool of 50 SOL against 500M tokens (0.0000001 SOL a token). */
const reserves = { baseReserve: 500_000_000n * TOKEN, quoteReserve: 50n * SOL, virtualBase: 0n, virtualQuote: 0n };
const ref = spotPrice(reserves);
const scaled = (p: Price, bps: number): Price => ({ quote: p.quote * (10_000n + BigInt(bps)), base: p.base * 10_000n });
const funded: Wallet = { lamports: 10n * SOL, bridgedSol: 0n, tokens: 1_000_000n * TOKEN };
const flat: Quoter = (side, amountIn) => {
  const q = swapAmounts(side, amountIn, 30, 100, reserves);
  return q.failure === null ? { amountOut: q.amountOut } : { failure: q.failure };
};

describe('the market maker’s prices', () => {
  it('reads the spot from the effective reserves and compares exactly', () => {
    expect(ref).toEqual({ quote: 50n * SOL, base: 500_000_000n * TOKEN });
    expect(priceNumber(ref, 6, 9)).toBeCloseTo(1e-7, 12);
    expect(spotPrice({ ...reserves, virtualQuote: 50n * SOL }).quote).toBe(100n * SOL);
    expect(belowReference(scaled(ref, -100), ref, 100)).toBe(true);
    expect(belowReference(scaled(ref, -99), ref, 100)).toBe(false);
    expect(aboveReference(scaled(ref, 100), ref, 100)).toBe(true);
    expect(aboveReference(scaled(ref, 99), ref, 100)).toBe(false);
    expect(belowReference(ref, ref, 100)).toBe(false);
    expect(aboveReference(ref, ref, 100)).toBe(false);
    expect(moveBps(scaled(ref, -250), ref)).toBe(-250);
    expect(moveBps(scaled(ref, 37), ref)).toBe(37);
    expect(moveBps(ref, ref)).toBe(0);
  });

  it('takes a typed reference price as an exact ratio', () => {
    const typed = parsePrice('0.0000001', 6, 9);
    expect(moveBps(typed, ref)).toBe(0);
    expect(moveBps(parsePrice('0.000000105', 6, 9), ref)).toBe(500);
    expect(() => parsePrice('0', 6, 9)).toThrow(/positive/);
    expect(() => parsePrice('abc', 6, 9)).toThrow(/not a number/);
    expect(formatPrice(ref, 6, 9)).toBe('0.0000001');
    expect(formatPrice({ quote: 3n * SOL, base: 2n * TOKEN }, 6, 9)).toBe('1.5');
  });

  it('parses and formats amounts', () => {
    expect(parseDecimal('0.5', 9)).toBe(500_000_000n);
    expect(parseDecimal('12', 6)).toBe(12_000_000n);
    expect(parseDecimal('1.', 2)).toBe(100n);
    expect(() => parseDecimal('0.1234567891', 9)).toThrow(/more than 9 decimals/);
    expect(() => parseDecimal('-1', 9)).toThrow(/not a number/);
    expect(() => parseDecimal('1e3', 9)).toThrow(/not a number/);
    expect(formatUnits(1_234_567_890n, 9)).toBe('1.23456789');
    expect(formatUnits(1_234_567_890n, 9, 2)).toBe('1.23');
    expect(formatUnits(1_000_000_000_000n, 6)).toBe('1,000,000');
    expect(formatUnits(0n, 9)).toBe('0');
    expect(formatBps(125)).toBe('1.25%');
    expect(formatBps(100)).toBe('1%');
    expect(formatBps(50)).toBe('0.5%');
  });
});

describe('the market maker’s rules', () => {
  it('reads percentages in basis points, with defaults and bounds', () => {
    expect(percentBps(undefined, 'step', '1', { min: 1, max: 5_000 })).toBe(100);
    expect(percentBps('0.5', 'step', '1', { min: 1, max: 5_000 })).toBe(50);
    expect(percentBps('2.25', 'buy', '1', { min: 1, max: 10_000 })).toBe(225);
    expect(() => percentBps('0.001', 'step', '1', { min: 1, max: 5_000 })).toThrow(/not a percentage/);
    expect(() => percentBps('51', 'step', '1', { min: 1, max: 5_000 })).toThrow(/between 0.01% and 50%/);
    expect(() => percentBps(true, 'step', '1', { min: 1, max: 5_000 })).toThrow(/takes a percentage/);
  });

  it('builds the rules from the flags', () => {
    const r = rulesOf({}, 6);
    expect(r).toEqual({ stepBps: 100, buyBps: 100, sellBps: 100, maxSolLamports: 500_000_000n, maxTokens: null, slippageBps: 100, intervalSecs: 20, reserveLamports: 20_000_000n });
    const custom = rulesOf({ step: '0.5', buy: '2', sell: '3', 'max-sol': '0.25', 'max-tokens': '1500.5', slippage: '0.3', interval: '60' }, 6);
    expect(custom).toEqual({ stepBps: 50, buyBps: 200, sellBps: 300, maxSolLamports: 250_000_000n, maxTokens: 1_500_500_000n, slippageBps: 30, intervalSecs: 60, reserveLamports: 20_000_000n });
    expect(() => rulesOf({ interval: '1' }, 6)).toThrow(/at least 2/);
    expect(() => rulesOf({ interval: 'fast' }, 6)).toThrow(/whole number/);
    expect(() => rulesOf({ 'max-sol': '0' }, 6)).toThrow(/positive/);
    expect(() => rulesOf({ 'max-tokens': true }, 6)).toThrow(/takes a value/);
  });
});

describe('the market maker’s sizing', () => {
  it('spends a share of the wallet’s SOL, bridged first, plain SOL above the reserve wrapped, capped by max-sol', () => {
    // 10 SOL plain: 1% of (10 - 0.02) = 0.0998 SOL, all of it wrapped.
    expect(buySize(funded, rules)).toEqual({ lamportsIn: 99_800_000n, wrap: 99_800_000n });
    // Bridged SOL covers the buy: nothing wrapped.
    expect(buySize({ ...funded, bridgedSol: SOL }, rules)).toEqual({ lamportsIn: 109_800_000n, wrap: 0n });
    // Bridged SOL covers part: the rest wrapped.
    expect(buySize({ lamports: 10n * SOL, bridgedSol: 50_000_000n, tokens: 0n }, rules)).toEqual({ lamportsIn: 100_300_000n, wrap: 50_300_000n });
    // The cap.
    expect(buySize({ ...funded, lamports: 1_000n * SOL }, rules)).toEqual({ lamportsIn: SOL / 2n, wrap: SOL / 2n });
    // The reserve: a wallet at or under 0.02 SOL has nothing to buy with.
    const empty = buySize({ lamports: 0n, bridgedSol: 0n, tokens: 0n }, rules);
    expect('none' in empty && empty.none).toMatch(/no SOL to buy with/);
    const reserveOnly = buySize({ lamports: SOL_RESERVE_LAMPORTS, bridgedSol: 0n, tokens: 0n }, rules);
    expect('none' in reserveOnly && reserveOnly.none).toMatch(/no SOL to buy with/);
    // Dust: 1% of 0.005 SOL.
    const tiny = buySize({ lamports: SOL_RESERVE_LAMPORTS + 5_000_000n, bridgedSol: 0n, tokens: 0n }, rules);
    expect('none' in tiny && tiny.none).toMatch(/below dust/);
    expect(DUST_LAMPORTS).toBe(100_000n);
  });

  it('sells a share of the holding, capped by max-tokens', () => {
    expect(sellSize(funded, rules)).toEqual({ tokensIn: 10_000n * TOKEN });
    expect(sellSize(funded, { ...rules, maxTokens: 2_500n * TOKEN })).toEqual({ tokensIn: 2_500n * TOKEN });
    expect(sellSize(funded, { ...rules, sellBps: 10_000 })).toEqual({ tokensIn: funded.tokens });
    const none = sellSize({ ...funded, tokens: 0n }, rules);
    expect('none' in none && none.none).toMatch(/holds none/);
    const rounds = sellSize({ ...funded, tokens: 50n }, rules);
    expect('none' in rounds && rounds.none).toMatch(/rounds to nothing/);
  });
});

describe('the market maker’s decision', () => {
  it('waits inside the band, buys a step below, sells a step above', () => {
    const inside = decide(scaled(ref, -99), ref, rules, funded, flat);
    expect(inside.action).toBe('wait');
    expect(inside.action === 'wait' && inside.reason).toMatch(/within 1%/);

    const buy = decide(scaled(ref, -100), ref, rules, funded, flat);
    expect(buy.action).toBe('buy');
    if (buy.action === 'buy') {
      expect(buy.amountIn).toBe(99_800_000n);
      expect(buy.wrap).toBe(99_800_000n);
      const q = swapAmounts('buy', 99_800_000n, 30, 100, reserves);
      expect(q.failure === null && buy.expectedOut).toBe(q.failure === null ? q.amountOut : -1n);
      expect(buy.minOut).toBe(minOutOf(buy.expectedOut, 100));
      expect(buy.minOut).toBe((buy.expectedOut * 9_900n) / 10_000n);
      expect(buy.move).toBe(-100);
    }

    const sell = decide(scaled(ref, 150), ref, rules, funded, flat);
    expect(sell.action).toBe('sell');
    if (sell.action === 'sell') {
      expect(sell.amountIn).toBe(10_000n * TOKEN);
      expect(sell.expectedOut).toBeGreaterThan(0n);
      expect(sell.minOut).toBe(minOutOf(sell.expectedOut, 100));
      expect(sell.move).toBe(150);
    }
  });

  it('refuses to trade with nothing to trade, and says so', () => {
    const broke: Wallet = { lamports: 0n, bridgedSol: 0n, tokens: 0n };
    const buy = decide(scaled(ref, -500), ref, rules, broke, flat);
    expect(buy.action).toBe('wait');
    expect(buy.action === 'wait' && buy.reason).toMatch(/a buy is due \(-5% from the reference\) but the wallet has no SOL/);
    const sell = decide(scaled(ref, 500), ref, rules, broke, flat);
    expect(sell.action === 'wait' && sell.reason).toMatch(/a sell is due .* but the wallet holds none/);
  });

  it('does not sell for dust, and passes the pool’s refusal on', () => {
    // A hundred tokens at 0.0000001 SOL: 0.00001 SOL, under dust.
    const dust = decide(scaled(ref, 200), ref, rules, { ...funded, tokens: 10_000n * TOKEN }, flat);
    expect(dust.action === 'wait' && dust.reason).toMatch(/under dust/);
    const refused = decide(scaled(ref, -200), ref, rules, funded, () => ({ failure: 'insufficient_liquidity' }));
    expect(refused.action === 'wait' && refused.reason).toMatch(/cannot fill it: insufficient_liquidity/);
    const nothing = decide(scaled(ref, -200), ref, rules, funded, () => ({ amountOut: 0n }));
    expect(nothing.action === 'wait' && nothing.reason).toMatch(/no tokens back/);
  });

  it('ladders: the reference moves to each fill, so the next trade needs a further step', () => {
    let reference = ref;
    // The pool a step lower: 1% less SOL in it, and a quoter that prices against it.
    const lower = { ...reserves, quoteReserve: (reserves.quoteReserve * 9_900n) / 10_000n };
    const spot1 = spotPrice(lower);
    expect(moveBps(spot1, ref)).toBe(-100);
    const atLower: Quoter = (side, amountIn) => {
      const q = swapAmounts(side, amountIn, 30, 100, lower);
      return q.failure === null ? { amountOut: q.amountOut } : { failure: q.failure };
    };
    const first = decide(spot1, reference, rules, funded, atLower);
    expect(first.action).toBe('buy');
    if (first.action !== 'buy') return;
    const fill = fillPrice('buy', first.amountIn, first.expectedOut);
    // The fill sits above the spot by the fees (1.3%) and the impact (0.1 SOL into 49.5): a buy on a
    // 1% step pays more than the old reference, which is the cost of the strategy, not a bug.
    expect(moveBps(fill, spot1)).toBeGreaterThan(130);
    expect(moveBps(fill, spot1)).toBeLessThan(200);
    // The spot right after the buy is below the fill (the marginal price moved less than the fees): the reference is the fill.
    const afterBuy = spotPrice({ ...lower, quoteReserve: lower.quoteReserve + first.amountIn, baseReserve: lower.baseReserve - first.expectedOut });
    reference = referenceAfter('buy', fill, afterBuy, rules.stepBps);
    expect(reference).toEqual(fill);
    // Back at the old spot (1% above the fill, give or take) nothing happens: a sell needs a full step above the fill.
    expect(decide(scaled(fill, 99), reference, rules, funded, flat).action).toBe('wait');
    expect(decide(scaled(fill, 100), reference, rules, funded, flat).action).toBe('sell');
    // A further drop of a step from the fill buys again.
    expect(decide(scaled(fill, -99), reference, rules, funded, flat).action).toBe('wait');
    expect(decide(scaled(fill, -100), reference, rules, funded, flat).action).toBe('buy');
  });

  it('never trades straight back against its own fill', () => {
    // A buy so large against the pool that the spot after it is a step above what it paid.
    const fill: Price = { quote: 100n, base: 100n };
    const after: Price = { quote: 103n, base: 100n };
    expect(referenceAfter('buy', fill, after, 100)).toEqual(after);
    expect(referenceAfter('buy', fill, { quote: 100n, base: 100n }, 100)).toEqual(fill);
    expect(referenceAfter('sell', fill, { quote: 97n, base: 100n }, 100)).toEqual({ quote: 97n, base: 100n });
    expect(referenceAfter('sell', fill, { quote: 100n, base: 100n }, 100)).toEqual(fill);
    expect(referenceAfter('buy', { quote: 0n, base: 0n }, after, 100)).toEqual(after);
    expect(fillPrice('sell', 1_000n, 7n)).toEqual({ quote: 7n, base: 1_000n });
  });
});

describe('the pool account’s layout', () => {
  it('holds the base mint at byte 11 and the quote mint at byte 43', async () => {
    const baseMint = Keypair.generate().publicKey;
    const quoteMint = Keypair.generate().publicKey;
    const key = () => Keypair.generate().publicKey;
    const bn = (v: bigint | number) => new BN(v.toString());
    const bytes = await CODERS.swap.accounts.encode('pool', {
      version: 2,
      bump: 254,
      lpMintBump: 253,
      baseMint,
      quoteMint,
      lpMint: key(),
      baseVault: key(),
      quoteVault: key(),
      hookProgram: null,
      hookFlags: 0,
      lpFeeBps: 30,
      protocolFeeBps: 100,
      baseReserve: bn(1),
      quoteReserve: bn(2),
      virtualBase: bn(0),
      virtualQuote: bn(0),
      lpSupply: bn(3),
      protocolFeesQuote: bn(0),
      curve: false,
      creator: key(),
      createdAt: bn(0),
      lastSwapAt: bn(0),
      swapCount: bn(0),
      baseVolume: bn(0),
      quoteVolume: bn(0),
      hookSignerBump: 0,
      feeModel: 0,
      protocolShareBps: 0,
      reserved: Array(60).fill(0),
    });
    expect(new PublicKey(bytes.subarray(POOL_BASE_MINT_OFFSET, POOL_BASE_MINT_OFFSET + 32)).equals(baseMint)).toBe(true);
    expect(new PublicKey(bytes.subarray(POOL_QUOTE_MINT_OFFSET, POOL_QUOTE_MINT_OFFSET + 32)).equals(quoteMint)).toBe(true);
  });
});
