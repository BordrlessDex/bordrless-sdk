/**
 * A token's latest trades, from its pool's transactions: every swap emits a `Swapped` event through
 * an event CPI (an inner instruction to the DEX's event authority), which `eventsOf` finds and
 * `typedEvent` types. The event carries the reserves after the trade, so each trade's price needs
 * no other read. Use the same decoding on a websocket or Geyser stream of the DEX's transactions.
 *
 *   RPC_URL=... node examples/recent-trades.ts <mint> [limit]
 */
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { SOL_DECIMALS } from '@bordrless/shared';
import { decodeLaunch, decodeMint, eventsOf, launchAddress, typedEvent, type RawInnerInstruction } from '@bordrless/sdk';
import { arg, connection, units } from './common.ts';

const mint = new PublicKey(arg(0, '<mint> [limit]'));
const limit = Number(process.argv[3] ?? 10);
const [mintInfo, launchInfo] = await connection.getMultipleAccountsInfo([mint, launchAddress(mint)]);
if (!mintInfo || !launchInfo) throw new Error('not a Bordrless launch');
const token = decodeMint(mintInfo.data);
const launch = decodeLaunch(launchInfo.data);

/** The account keys an inner instruction's indexes point into: static keys, then the lookup tables' writable and read-only addresses. */
function accountKeys(tx: VersionedTransactionResponse): string[] {
  const loaded = tx.meta?.loadedAddresses;
  return [...tx.transaction.message.staticAccountKeys.map(String), ...(loaded?.writable ?? []).map(String), ...(loaded?.readonly ?? []).map(String)];
}

const signatures = await connection.getSignaturesForAddress(launch.pool, { limit });
for (const sig of signatures) {
  if (sig.err) continue;
  const tx = await connection.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (!tx?.meta?.innerInstructions) continue;
  const inner: RawInnerInstruction[] = tx.meta.innerInstructions.flatMap((group) => group.instructions as RawInnerInstruction[]);
  for (const event of eventsOf(accountKeys(tx), inner, (data) => Buffer.from(bs58.decode(data)))) {
    const typed = typedEvent(event);
    if (typed?.kind !== 'swap.Swapped' || typed.pool !== launch.pool.toBase58()) continue;
    const buy = typed.direction === 1;
    // SOL spent or received, and tokens received or spent, as the trader's wallet saw them.
    const sol = buy ? typed.amountIn : typed.deliveredOut;
    const tokens = buy ? typed.deliveredOut : typed.amountIn;
    // The price after the trade, from the reserves the event carries (real plus virtual).
    const after = Number(typed.quoteReserve + typed.virtualQuote) / Number(typed.baseReserve + typed.virtualBase) * 10 ** (token.decimals - SOL_DECIMALS);
    // Units: the input side (amountIn, lpFee, cutsIn, burnIn) is the input token, SOL on a buy and
    // the token on a sell; the output side (amountOut, cutsOut, burnOut, deliveredOut) the other;
    // protocolFee is always SOL.
    const [inDec, outDec, inSym, outSym] = buy ? [SOL_DECIMALS, token.decimals, 'SOL', token.symbol] : [token.decimals, SOL_DECIMALS, token.symbol, 'SOL'];
    const fees = `lp ${units(typed.lpFee, inDec)} ${inSym}, protocol ${units(typed.protocolFee, SOL_DECIMALS)} SOL, hook cuts ${units(typed.cutsIn, inDec)} ${inSym} in + ${units(typed.cutsOut, outDec)} ${outSym} out, burned ${units(typed.burnIn, inDec)} ${inSym} + ${units(typed.burnOut, outDec)} ${outSym}`;
    console.log(`${new Date(typed.ts * 1000).toISOString()}  ${buy ? 'BUY ' : 'SELL'}  ${units(sol, SOL_DECIMALS)} SOL  ${units(tokens, token.decimals)} ${token.symbol}  by ${typed.trader}  price after ${after.toExponential(4)} SOL  ${fees}  ${sig.signature}`);
  }
}
