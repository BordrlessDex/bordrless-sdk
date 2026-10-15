/**
 * The router (bordrless-programs `programs/bordrless_router`, `docs/router.md`): an app's integrator
 * fee on any Bordrless DEX swap, launch pools and ordinary pools alike. Build the swap as without
 * it (`launch.swap`, `swap.swap`), then wrap it with `router.swap`: a buy pays the fee from its
 * quote input before the DEX swaps the rest, a sell from what the DEX delivered; 20% of every fee to
 * the DEX config's treasury (its holding of the quote), the rest to the integrator's holding.
 */
import BN from 'bn.js';
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import * as a from './addresses.ts';
import { CODERS } from './coders.ts';

/** The most an integrator's fee may be: 1% of the trade's quote side. */
export const ROUTER_MAX_FEE_BPS = 100;
/** Bordrless's share of every integrator fee: 20% of it. */
export const ROUTER_BORDRLESS_SHARE_BPS = 2_000;

/** What a fee of `feeBps` on `amount` (lamports of the quote) comes to, as the router computes it: the fee and Bordrless's share of it, both rounded down; the integrator gets the rest. */
export function routerFeeSplit(amount: bigint, feeBps: number): { fee: bigint; bordrlessShare: bigint; integrator: bigint } {
  const fee = (amount * BigInt(feeBps)) / 10_000n;
  const bordrlessShare = (fee * BigInt(ROUTER_BORDRLESS_SHARE_BPS)) / 10_000n;
  return { fee, bordrlessShare, integrator: fee - bordrlessShare };
}

/** The DEX treasury's holding of `quoteMint` the router pays Bordrless's share to (`treasury` is the DEX config's, `decodeSwapConfig(...).treasury`). */
export const routerTreasuryQuote = (treasury: PublicKey, quoteMint: PublicKey): PublicKey => a.holdingAddress(quoteMint, treasury);

const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

export const router = {
  /**
   * `swap`: `dexSwap` (a DEX `swap` instruction for `trader`, as `launch.swap` or `swap.swap` build
   * it; a buy's `amountIn` is the trader's whole input, the fee included) routed with a fee of
   * `feeBps` (1 to 100) paid to `integratorQuote` (the integrator's holding of the pool's quote,
   * which must exist) and Bordrless's share to `treasuryQuote` (`routerTreasuryQuote`). A sell
   * must deliver to `trader`; `minQuoteAfterFee` is its floor on what the trader keeps.
   */
  swap(trader: PublicKey, integratorQuote: PublicKey, treasuryQuote: PublicKey, dexSwap: TransactionInstruction, feeBps: number, minQuoteAfterFee = 0n): TransactionInstruction {
    if (!dexSwap.programId.equals(a.SWAP_PROGRAM)) throw new Error('router.swap wraps a DEX swap instruction');
    if (!Number.isInteger(feeBps) || feeBps < 1 || feeBps > ROUTER_MAX_FEE_BPS) throw new Error(`an integrator fee is 1 to ${ROUTER_MAX_FEE_BPS} basis points`);
    const decoded = CODERS.swap.instruction.decode(dexSwap.data) as { name: string; data: { args: Record<string, unknown> } } | null;
    if (!decoded || decoded.name !== 'swap') throw new Error('not a DEX swap instruction');
    const data = CODERS.router.instruction.encode('swap', { args: { swap: decoded.data.args, feeBps, minQuoteAfterFee: new BN(minQuoteAfterFee.toString()) } });
    const keys: AccountMeta[] = [
      ro(trader, true),
      rw(integratorQuote),
      rw(treasuryQuote),
      ro(a.SWAP_PROGRAM),
      ro(a.TOKEN_PROGRAM),
      ro(a.eventAuthority(a.TOKEN_PROGRAM)),
      ro(a.eventAuthority(a.ROUTER_PROGRAM)),
      ro(a.ROUTER_PROGRAM),
      ...dexSwap.keys,
    ];
    return new TransactionInstruction({ programId: a.ROUTER_PROGRAM, keys, data: Buffer.from(data) });
  },
  /**
   * `swap_v2`: `dexSwapV2` (a DEX `swap_v2` for `trader` on a native pool, as `launch.swapV2` or `swap.swapV2` build it, its quote
   * account the trader's own wallet on a sell as on a buy) routed with a fee of `feeBps` paid in SOL to `integrator` (a wallet,
   * not the trader or the pool; it must end at or above rent) and Bordrless's share to `treasury` (the DEX config's treasury
   * wallet, `decodeSwapConfig(...).treasury`). A buy pays the fee from the trader's wallet before the DEX swaps the rest; a sell
   * pays it from the SOL delivered. `minQuoteAfterFee` is a sell's floor on what the trader keeps.
   */
  swapV2(trader: PublicKey, integrator: PublicKey, treasury: PublicKey, dexSwapV2: TransactionInstruction, feeBps: number, minQuoteAfterFee = 0n): TransactionInstruction {
    if (!dexSwapV2.programId.equals(a.SWAP_PROGRAM)) throw new Error('router.swapV2 wraps a DEX swap_v2 instruction');
    if (!Number.isInteger(feeBps) || feeBps < 1 || feeBps > ROUTER_MAX_FEE_BPS) throw new Error(`an integrator fee is 1 to ${ROUTER_MAX_FEE_BPS} basis points`);
    const decoded = CODERS.swap.instruction.decode(dexSwapV2.data) as { name: string; data: { args: Record<string, unknown> } } | null;
    if (!decoded || decoded.name !== 'swapV2') throw new Error('not a DEX swap_v2 instruction');
    const data = CODERS.router.instruction.encode('swapV2', { args: { swap: decoded.data.args, feeBps, minQuoteAfterFee: new BN(minQuoteAfterFee.toString()) } });
    const keys: AccountMeta[] = [
      { pubkey: trader, isSigner: true, isWritable: true },
      rw(integrator),
      rw(treasury),
      ro(a.SWAP_PROGRAM),
      ro(a.SYSTEM_PROGRAM),
      ro(a.eventAuthority(a.ROUTER_PROGRAM)),
      ro(a.ROUTER_PROGRAM),
      ...dexSwapV2.keys,
    ];
    return new TransactionInstruction({ programId: a.ROUTER_PROGRAM, keys, data: Buffer.from(data) });
  },
};
