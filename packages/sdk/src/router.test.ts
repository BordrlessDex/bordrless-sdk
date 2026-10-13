/** The router's builder against its IDL and the programs' Rust client: the accounts, the args. */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as a from './addresses.ts';
import { CODERS } from './coders.ts';
import { NO_LAUNCH_RULES } from './accounts.ts';
import { launch, launchKeys } from './instructions.ts';
import { ROUTER_MAX_FEE_BPS, router, routerFeeSplit, routerTreasuryQuote } from './router.ts';

const k = (): PublicKey => Keypair.generate().publicKey;

describe('the router', () => {
  it('wraps a DEX swap: its own accounts, then the swap’s, the swap’s args with the fee', () => {
    const trader = k();
    const mint = k();
    const dex = launch.swap(launchKeys(mint, a.BRIDGED_SOL_MINT, 30, NO_LAUNCH_RULES), trader, trader, 1, 1_000_000_000n, 5n);
    const integrator = a.holdingAddress(a.BRIDGED_SOL_MINT, k());
    const treasury = routerTreasuryQuote(k(), a.BRIDGED_SOL_MINT);
    const ix = router.swap(trader, integrator, treasury, dex, 100, 7n);
    expect(ix.programId.equals(a.ROUTER_PROGRAM)).toBe(true);
    expect(ix.keys.slice(0, 8).map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable])).toEqual([
      [trader.toBase58(), true, false],
      [integrator.toBase58(), false, true],
      [treasury.toBase58(), false, true],
      [a.SWAP_PROGRAM.toBase58(), false, false],
      [a.TOKEN_PROGRAM.toBase58(), false, false],
      [a.eventAuthority(a.TOKEN_PROGRAM).toBase58(), false, false],
      [a.eventAuthority(a.ROUTER_PROGRAM).toBase58(), false, false],
      [a.ROUTER_PROGRAM.toBase58(), false, false],
    ]);
    expect(ix.keys.slice(8)).toEqual(dex.keys);
    const decoded = CODERS.router.instruction.decode(ix.data) as { name: string; data: { args: { feeBps: number; minQuoteAfterFee: { toString(): string }; swap: { direction: number; amountIn: { toString(): string }; minAmountOut: { toString(): string } } } } };
    expect(decoded.name).toBe('swap');
    expect(decoded.data.args.feeBps).toBe(100);
    expect(decoded.data.args.minQuoteAfterFee.toString()).toBe('7');
    expect([decoded.data.args.swap.direction, decoded.data.args.swap.amountIn.toString(), decoded.data.args.swap.minAmountOut.toString()]).toEqual([1, '1000000000', '5']);
  });

  it('refuses a fee out of range or another program’s instruction', () => {
    const trader = k();
    const dex = launch.swap(launchKeys(k(), a.BRIDGED_SOL_MINT, 30, NO_LAUNCH_RULES), trader, trader, 1, 1_000n, 0n);
    for (const fee of [0, ROUTER_MAX_FEE_BPS + 1, 1.5]) expect(() => router.swap(trader, k(), k(), dex, fee)).toThrow();
    const other = launch.claimCreatorFees(trader, k(), a.BRIDGED_SOL_MINT);
    expect(() => router.swap(trader, k(), k(), other, 50)).toThrow();
  });

  it('splits a fee as the program does: rounded down, a fifth to Bordrless', () => {
    expect(routerFeeSplit(1_000_000_000n, 100)).toEqual({ fee: 10_000_000n, bordrlessShare: 2_000_000n, integrator: 8_000_000n });
    expect(routerFeeSplit(99n, 100)).toEqual({ fee: 0n, bordrlessShare: 0n, integrator: 0n });
    expect(routerFeeSplit(100n, 100)).toEqual({ fee: 1n, bordrlessShare: 0n, integrator: 1n });
  });
});
