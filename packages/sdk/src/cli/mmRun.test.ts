/** `bordrless mm`: the pool it picks, the swaps it builds (the API's order), the quotes it uses, apart from any RPC. */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { KIT_MODULES, quoteLaunchSwap, swapAmounts } from '@bordrless/shared';
import { FEE_MODEL_FLAT, FEE_MODEL_SHARE, NO_LAUNCH_RULES, type Launch, type Mint, type Pool } from '../accounts.ts';
import { BRIDGE_PROGRAM, BRIDGED_SOL_MINT, KIT_PROGRAM, LAUNCH_PROGRAM, SWAP_PROGRAM, TOKEN_PROGRAM, holdingAddress, launchPoolAddress, poolAddress } from '../addresses.ts';
import { CODERS } from '../coders.ts';
import { deepestPool, quoterOf, rpcUrlOf, tradeInstructions, type Market } from './mmRun.ts';

const key = (): PublicKey => Keypair.generate().publicKey;
const SOL = 1_000_000_000n;
const TOKEN = 1_000_000n;

const poolOf = (over: Partial<Pool>): Pool =>
  ({
    version: 2,
    bump: 0,
    lpMintBump: 0,
    baseMint: key(),
    quoteMint: BRIDGED_SOL_MINT,
    lpMint: key(),
    baseVault: key(),
    quoteVault: key(),
    hookProgram: null,
    hookFlags: 0,
    lpFeeBps: 100,
    protocolFeeBps: 100,
    baseReserve: 500_000_000n * TOKEN,
    quoteReserve: 50n * SOL,
    virtualBase: 0n,
    virtualQuote: 0n,
    lpSupply: 0n,
    protocolFeesQuote: 0n,
    curve: false,
    creator: key(),
    createdAt: 0,
    lastSwapAt: 0,
    swapCount: 0n,
    baseVolume: 0n,
    quoteVolume: 0n,
    hookSignerBump: 0,
    feeModel: FEE_MODEL_FLAT,
    protocolShareBps: 0,
    ...over,
  }) as Pool;

const mintOf = (hookProgram: PublicKey | null): Mint => ({ version: 2, decimals: 6, supply: 0n, maxSupply: 0n, mintAuthority: null, freezeAuthority: null, hookAuthority: null, metadataAuthority: null, hookProgram, hookFlags: 0, name: 'Test', symbol: 'TST', uri: '', createdAt: 0, creator: key(), hookSignerBump: 0 });

const decodeSwap = (data: Buffer): { direction: number; amountIn: bigint; minAmountOut: bigint; inHookAccounts: number; outHookAccounts: number } => {
  const d = CODERS.swap.instruction.decode(data) as { name: string; data: { args: { direction: number; amountIn: { toString(): string }; minAmountOut: { toString(): string }; inHookAccounts: number; outHookAccounts: number } } };
  expect(d.name).toBe('swap');
  const a = d.data.args;
  return { direction: a.direction, amountIn: BigInt(a.amountIn.toString()), minAmountOut: BigInt(a.minAmountOut.toString()), inHookAccounts: a.inHookAccounts, outHookAccounts: a.outHookAccounts };
};

describe('the pool the market maker trades', () => {
  it('is the deepest by quote reserve among those not on a curve', () => {
    const mint = key();
    const shallow = { poolKey: key(), pool: poolOf({ baseMint: mint, quoteReserve: 5n * SOL }) };
    const deep = { poolKey: key(), pool: poolOf({ baseMint: mint, quoteReserve: 60n * SOL }) };
    const curve = { poolKey: key(), pool: poolOf({ baseMint: mint, quoteReserve: 900n * SOL, curve: true, hookProgram: LAUNCH_PROGRAM }) };
    expect(deepestPool([shallow, curve, deep], mint)).toBe(deep);
    expect(() => deepestPool([curve], mint)).toThrow(/still on its curve/);
    expect(() => deepestPool([], mint)).toThrow(/no pool quoted in bridged SOL/);
  });

  it('takes the RPC from --rpc, --url, the env, in that order', () => {
    expect(rpcUrlOf({ rpc: 'http://a' }, { SOLANA_RPC_URL: 'http://env' })).toBe('http://a');
    expect(rpcUrlOf({ url: 'http://b' }, { SOLANA_RPC_URL: 'http://env' })).toBe('http://b');
    expect(rpcUrlOf({}, { BORDRLESS_RPC_URL: 'http://ours', SOLANA_RPC_URL: 'http://env' })).toBe('http://ours');
    expect(rpcUrlOf({}, { SOLANA_RPC_URL: 'http://env' })).toBe('http://env');
    expect(() => rpcUrlOf({ rpc: true }, {})).toThrow(/takes a URL/);
  });
});

describe('the swaps the market maker builds', () => {
  const owner = key();
  const mint = key();

  it('on an ordinary pool: the holdings, the wrap when plain SOL is needed, then the plain swap, as trade/pool.ts orders them', () => {
    const pool = poolOf({ baseMint: mint });
    const poolKey = poolAddress(mint, BRIDGED_SOL_MINT, pool.lpFeeBps, null);
    const market: Market = { mint, token: mintOf(null), poolKey, pool, launch: null, kit: null, customHook: null, baseHookList: null, poolHookList: null };
    const buy = tradeInstructions(market, owner, 'buy', 100_000_000n, 990_000n, 40_000_000n);
    expect(buy.map((ix) => ix.programId.toBase58())).toEqual([TOKEN_PROGRAM, BRIDGE_PROGRAM, TOKEN_PROGRAM, SWAP_PROGRAM].map(String));
    // The bridged-SOL holding is made before the wrap, the token holding before the swap.
    expect(buy[0]!.keys[3]!.pubkey.equals(holdingAddress(BRIDGED_SOL_MINT, owner))).toBe(true);
    expect(buy[2]!.keys[3]!.pubkey.equals(holdingAddress(mint, owner))).toBe(true);
    const wrapped = CODERS.bridge.instruction.decode(buy[1]!.data) as { name: string; data: { lamports: { toString(): string } } };
    expect([wrapped.name, wrapped.data.lamports.toString()]).toEqual(['wrapSol', '40000000']);
    const swap = buy[3]!;
    expect(decodeSwap(swap.data)).toEqual({ direction: 1, amountIn: 100_000_000n, minAmountOut: 990_000n, inHookAccounts: 0, outHookAccounts: 0 });
    expect(swap.keys[0]!.pubkey.equals(owner) && swap.keys[0]!.isSigner).toBe(true);
    expect(swap.keys[2]!.pubkey.equals(poolKey)).toBe(true);
    // Enough bridged SOL: no wrap, and no unwrap after a sell (the proceeds stay bridged for the next buy).
    expect(tradeInstructions(market, owner, 'buy', 100_000_000n, 1n, 0n).map((ix) => ix.programId.toBase58())).toEqual([TOKEN_PROGRAM, SWAP_PROGRAM].map(String));
    const sell = tradeInstructions(market, owner, 'sell', 5_000n * TOKEN, 123n, 0n);
    expect(sell.map((ix) => ix.programId.toBase58())).toEqual([TOKEN_PROGRAM, SWAP_PROGRAM].map(String));
    expect(decodeSwap(sell[1]!.data)).toEqual({ direction: 0, amountIn: 5_000n * TOKEN, minAmountOut: 123n, inHookAccounts: 0, outHookAccounts: 0 });
  });

  it('on a graduated launch pool: the launch program’s swap with the kit’s slice on the base side, the mint writable when it burns', () => {
    const rules = { ...NO_LAUNCH_RULES, burnBuyBps: 100, burnSellBps: 100, holderFeeBuyBps: 100, holderFeeSellBps: 100 };
    const launch = { mint, quoteMint: BRIDGED_SOL_MINT, lpFeeBps: 30, rules, customHook: null, modules: KIT_MODULES.HOLDER_REWARDS, creatorFeeBps: 100, createdAt: 0, sniperWindowSecs: 0, sniperStartBps: 0, status: 1 } as unknown as Launch;
    const poolKey = launchPoolAddress(mint, BRIDGED_SOL_MINT, 30);
    const pool = poolOf({ baseMint: mint, lpFeeBps: 30, hookProgram: LAUNCH_PROGRAM, feeModel: FEE_MODEL_SHARE, protocolShareBps: 2_500 });
    const market: Market = { mint, token: mintOf(KIT_PROGRAM), poolKey, pool, launch, kit: null, customHook: null, baseHookList: null, poolHookList: null };
    const buy = tradeInstructions(market, owner, 'buy', 100_000_000n, 1n, 100_000_000n);
    expect(buy.map((ix) => ix.programId.toBase58())).toEqual([TOKEN_PROGRAM, BRIDGE_PROGRAM, TOKEN_PROGRAM, SWAP_PROGRAM].map(String));
    const swap = buy[3]!;
    const args = decodeSwap(swap.data);
    expect([args.direction, args.inHookAccounts, args.outHookAccounts]).toEqual([1, 0, 4]);
    expect(swap.keys[2]!.pubkey.equals(poolKey)).toBe(true);
    expect(swap.keys[3]!.pubkey.equals(mint) && swap.keys[3]!.isWritable).toBe(true);
    expect(swap.keys[9]!.pubkey.equals(LAUNCH_PROGRAM)).toBe(true);
    const sell = tradeInstructions(market, owner, 'sell', 1_000n * TOKEN, 1n, 0n);
    expect(sell.map((ix) => ix.programId.toBase58())).toEqual([TOKEN_PROGRAM, SWAP_PROGRAM].map(String));
    expect(decodeSwap(sell[1]!.data).inHookAccounts).toBe(4);
  });
});

describe('the swaps the market maker builds on native SOL (audit O-4)', () => {
  const owner = key();
  const mint = key();
  const swapName = (data: Buffer): string => (CODERS.swap.instruction.decode(data) as { name: string }).name;

  it('a native launch: no wrap, no bridged-SOL holding, swap_v2 paid and delivered in SOL', () => {
    const launch = { mint, quoteMint: BRIDGED_SOL_MINT, lpFeeBps: 30, rules: NO_LAUNCH_RULES, customHook: null, modules: 0, creatorFeeBps: 100, createdAt: 0, sniperWindowSecs: 0, sniperStartBps: 0, status: 1, isNative: true } as unknown as Launch;
    const pool = poolOf({ baseMint: mint, lpFeeBps: 30, hookProgram: LAUNCH_PROGRAM, feeModel: FEE_MODEL_SHARE, quoteNative: true } as Partial<Pool>);
    const market: Market = { mint, token: mintOf(null), poolKey: launchPoolAddress(mint, BRIDGED_SOL_MINT, 30), pool, launch, kit: null, customHook: null, baseHookList: null, poolHookList: null };
    const buy = tradeInstructions(market, owner, 'buy', 100_000_000n, 1n, 100_000_000n);
    expect(buy.map((ix) => ix.programId.toBase58())).toEqual([TOKEN_PROGRAM, SWAP_PROGRAM].map(String));
    expect(swapName(buy[1]!.data)).toBe('swapV2');
    const sell = tradeInstructions(market, owner, 'sell', 1_000n * TOKEN, 1n, 0n);
    expect(sell.map((ix) => ix.programId.toBase58())).toEqual([SWAP_PROGRAM].map(String));
    expect(swapName(sell[0]!.data)).toBe('swapV2');
  });

  it('a native ordinary pool: swap_v2; a held coin (pool native, launch bridged): swap_v2 with the bridge (re-audit R-3)', () => {
    const pool = poolOf({ baseMint: mint, quoteNative: true } as Partial<Pool>);
    const market: Market = { mint, token: mintOf(null), poolKey: poolAddress(mint, BRIDGED_SOL_MINT, pool.lpFeeBps, null), pool, launch: null, kit: null, customHook: null, baseHookList: null, poolHookList: null };
    const sell = tradeInstructions(market, owner, 'sell', 1_000n * TOKEN, 1n, 0n);
    expect(sell.map((ix) => swapName(ix.data))).toEqual(['swapV2']);
    const held = { mint, quoteMint: BRIDGED_SOL_MINT, lpFeeBps: 30, rules: NO_LAUNCH_RULES, customHook: null, modules: 0, creatorFeeBps: 100, createdAt: 0, sniperWindowSecs: 0, sniperStartBps: 0, status: 1, isNative: false } as unknown as Launch;
    const heldMarket: Market = { ...market, launch: held, pool: poolOf({ baseMint: mint, lpFeeBps: 30, hookProgram: LAUNCH_PROGRAM, quoteNative: true } as Partial<Pool>) };
    const buy = tradeInstructions(heldMarket, owner, 'buy', 100_000_000n, 1n, 40_000_000n);
    expect(buy.map((ix) => ix.programId.toBase58())).toEqual([TOKEN_PROGRAM, SWAP_PROGRAM].map(String));
    expect(swapName(buy[1]!.data)).toBe('swapV2');
    const heldSell = tradeInstructions(heldMarket, owner, 'sell', 1_000n * TOKEN, 1n, 0n);
    expect(heldSell.map((ix) => swapName(ix.data))).toEqual(['swapV2']);
    // The bridge's accounts go along: the launchpad's cuts of a held coin are bridged holdings, wrapped from the pool's lamports.
    expect(heldSell[0]!.keys.some((m) => m.pubkey.equals(BRIDGE_PROGRAM))).toBe(true);
  });
});

describe('the quotes the market maker decides with', () => {
  const mint = key();
  const reserves = { baseReserve: 500_000_000n * TOKEN, quoteReserve: 50n * SOL, virtualBase: 0n, virtualQuote: 0n };

  it('are the flat math on an ordinary pool and the launch math on a launch pool', () => {
    const pool = poolOf({ baseMint: mint, lpFeeBps: 100, protocolFeeBps: 25 });
    const ordinary: Market = { mint, token: mintOf(null), poolKey: key(), pool, launch: null, kit: null, customHook: null, baseHookList: null, poolHookList: null };
    const flat = quoterOf(ordinary, pool, null, 1_000);
    const q = swapAmounts('buy', SOL, 100, 25, reserves);
    expect(flat('buy', SOL)).toEqual({ amountOut: q.failure === null ? q.amountOut : -1n });
    expect(flat('buy', 1n)).toEqual({ failure: 'fees_exceed_input' });

    const rules = { ...NO_LAUNCH_RULES, burnBuyBps: 100, holderFeeBuyBps: 100, holderFeeSellBps: 100 };
    const launch = { mint, quoteMint: BRIDGED_SOL_MINT, lpFeeBps: 30, rules, customHook: null, modules: KIT_MODULES.HOLDER_REWARDS, creatorFeeBps: 100, createdAt: 0, sniperWindowSecs: 0, sniperStartBps: 0, status: 1 } as unknown as Launch;
    const launchPool = poolOf({ baseMint: mint, lpFeeBps: 30, hookProgram: LAUNCH_PROGRAM, feeModel: FEE_MODEL_SHARE, protocolShareBps: 2_500 });
    const kit = { eligible: 900_000_000n * TOKEN, minEligible: 1_000_000n * TOKEN } as unknown as NonNullable<Market['kit']>;
    const market: Market = { mint, token: mintOf(KIT_PROGRAM), poolKey: key(), pool: launchPool, launch, kit, customHook: null, baseHookList: null, poolHookList: null };
    const quote = quoterOf(market, launchPool, kit, 1_000);
    const expected = quoteLaunchSwap(reserves, 'buy', SOL, 30, 2_500, { creatorFeeBps: 100, holderFeeBuyBps: 100, holderFeeSellBps: 100, burnBuyBps: 100, burnSellBps: 0, eligible: kit.eligible, minEligible: kit.minEligible });
    expect(quote('buy', SOL)).toEqual({ amountOut: expected.delivered });
    expect(expected.delivered).not.toBeNull();
    // The burn and the fees make it less than the flat pool would give for the same input.
    expect((quote('buy', SOL) as { amountOut: bigint }).amountOut).toBeLessThan((flat('buy', SOL) as { amountOut: bigint }).amountOut);
  });
});
