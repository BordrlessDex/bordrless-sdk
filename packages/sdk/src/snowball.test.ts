/**
 * Snowball's builders, decoder and bounds held to the program: `vectors/snowball.json`, which
 * bordrless-programs' `snowball_vectors.rs` renders from `bordrless_companion::client` and the
 * account layout.
 */
import { describe, expect, it } from 'vitest';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import vectors from '../vectors/snowball.json' with { type: 'json' };
import * as a from './addresses.ts';
import { CODERS } from './coders.ts';
import { companion, type Companion } from './companion.ts';
import type { LaunchKeys } from './instructions.ts';
import { SNOWBALL_LIMITS, decodeSnowball, snowballArgsProblem, snowballBand, snowballMove, type Snowball, type SnowballArgs } from './snowball.ts';

const key = (s: string): PublicKey => new PublicKey(s);
const K = { mint: key(vectors.keys.mint), payer: key(vectors.keys.payer), cranker: key(vectors.keys.cranker) };
const args: SnowballArgs = { split: { buybackBps: 0, holdersBps: 0, beneficiaryBps: 3_000 }, potBps: 7_000, buyStepBps: 200, sellStepBps: 300, buyBps: 2_500, sellBps: 5_000, interval: 30, maxTrade: 100_000_000_000n, poolBps: 200, flatTrades: true };
const keys = (modules: number, burns: boolean): LaunchKeys => ({ mint: K.mint, quoteMint: a.BRIDGED_SOL_MINT, lpFeeBps: 30, modules, burns });

const asVector = (name: string, ix: TransactionInstruction) => ({
  name,
  program: ix.programId.toBase58(),
  accounts: ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]),
  data: ix.data.toString('hex'),
});

describe('Snowball builders are the Rust client’s', () => {
  const ours: Record<string, TransactionInstruction> = {
    createSnowball: companion.createSnowball(K.payer, K.mint, args),
    snowballStepPlain: companion.snowballStep(K.cranker, keys(0, false)),
    snowballStepKit: companion.snowballStep(K.cranker, keys(1, true)),
  };
  it('covers every instruction the vectors hold', () => {
    expect(Object.keys(ours).sort()).toEqual(vectors.instructions.map((v) => v.name).sort());
  });
  for (const v of vectors.instructions) {
    it(`${v.name}: the same program, accounts and data`, () => {
      expect(asVector(v.name, ours[v.name]!)).toEqual(v);
    });
  }
  it('derives the market maker’s address as the program does', () => {
    expect(a.snowballAddress(K.mint).toBase58()).toBe(vectors.snowballAddress);
  });
});

describe('the account and the bounds', () => {
  it('decodes a Snowball as the program serializes it', () => {
    const data = Buffer.from(vectors.account.data, 'hex');
    expect(data.length).toBe(vectors.account.len);
    expect(CODERS.companion.accounts.size('snowball')).toBe(vectors.account.len);
    const s = decodeSnowball(data);
    expect(s).toMatchObject({ buyStepBps: 200, sellStepBps: 300, buyBps: 2_500, sellBps: 1_000, interval: 30, maxTrade: 100_000_000_000n, poolBps: 200, flatTrades: true, referencePrice: 123_456_789_012_345n, tokensHeld: 42_000_000_000n, buys: 3, sells: 2, bountiesTotal: 8_000_000n });
  });
  it('holds the program’s bounds', () => {
    const c = vectors.constants;
    const L = SNOWBALL_LIMITS;
    expect([L.minStepBps, L.maxStepBps, L.minSizeBps, L.maxSizeBps, L.minPoolBps, L.maxPoolBps, L.minInterval, L.maxInterval]).toEqual([c.minStepBps, c.maxStepBps, c.minSizeBps, c.maxSizeBps, c.minPoolBps, c.maxPoolBps, c.minInterval, c.maxInterval]);
    expect([L.minTrade.toString(), L.minMaxTrade.toString()]).toEqual([c.minTrade, c.minMaxTrade]);
  });
  it('refuses what the program refuses, in one sentence each', () => {
    expect(snowballArgsProblem(args)).toBeNull();
    expect(snowballArgsProblem({ ...args, potBps: 6_000 })).toMatch(/add up/);
    expect(snowballArgsProblem({ ...args, buyStepBps: 49 })).toMatch(/0.5% to 20%/);
    expect(snowballArgsProblem({ ...args, sellBps: 10_001 })).toMatch(/1% to 100%/);
    expect(snowballArgsProblem({ ...args, poolBps: 1_001 })).toMatch(/10% of the pool/);
    expect(snowballArgsProblem({ ...args, interval: 9 })).toMatch(/10 seconds/);
    expect(snowballArgsProblem({ ...args, maxTrade: 9_999_999n })).toMatch(/0.01 SOL/);
    expect(snowballArgsProblem({ ...args, buyBps: 10_000, sellBps: 10_000, poolBps: 1_000, interval: 10 })).toBeNull();
  });
});

describe('which way a step goes', () => {
  const R = 1_000_000_000_000n; // 1 lamport per base unit
  const s = { referencePrice: R, buyStepBps: 200, sellStepBps: 300, buyBps: 2_500, sellBps: 2_500, interval: 30, lastAt: 1_000, tokensHeld: 0n, flatTrades: false } as Snowball;
  const c = { launched: true, launchedAt: 0, referencePrice: 7n, pendingPot: 1_000_000_000n };
  it('buys at or below its buy step, sells at or above its sell step, else waits without flat trades', () => {
    const { buyBelow, sellAbove } = snowballBand(R, 200, 300);
    expect([buyBelow, sellAbove]).toEqual([980_000_000_000n, 1_030_000_000_000n]);
    expect(snowballMove(s, c, 0, buyBelow, 1_030)).toBe('buy');
    expect(snowballMove({ ...s, tokensHeld: 10_000_000n }, c, 0, sellAbove, 1_030)).toBe('sell');
    expect(snowballMove(s, c, 0, 1_010_000_000_000n, 1_030)).toBeNull();
  });
  it('with flat trades, trades every interval on the side that rebalances', () => {
    const flat = { ...s, flatTrades: true };
    expect(snowballMove(flat, c, 0, R, 1_030)).toBe('buy');
    // Tokens worth 2 SOL against 1 SOL in the pot: it sells.
    expect(snowballMove({ ...flat, tokensHeld: 2_000_000_000n }, c, 0, R, 1_030)).toBe('sell');
    // A rise with nothing to sell: it buys instead.
    expect(snowballMove(flat, c, 0, 2n * R, 1_030)).toBe('buy');
    // Nothing on either side: nothing due.
    expect(snowballMove(flat, { ...c, pendingPot: 0n }, 0, R, 1_030)).toBeNull();
  });
  it('waits its interval, the launch’s first minute and any early-buyer window', () => {
    expect(snowballMove(s, c, 0, 900_000_000_000n, 1_029)).toBeNull();
    expect(snowballMove({ ...s, lastAt: 0 }, c, 0, 900_000_000_000n, 59)).toBeNull();
    expect(snowballMove({ ...s, lastAt: 0 }, c, 300, 900_000_000_000n, 299)).toBeNull();
    expect(snowballMove({ ...s, lastAt: 0 }, c, 300, 900_000_000_000n, 300)).toBe('buy');
    expect(snowballMove(s, { ...c, launched: false } as Pick<Companion, 'launched' | 'launchedAt' | 'referencePrice' | 'pendingPot'>, 0, 900_000_000_000n, 9_999)).toBeNull();
  });
});
