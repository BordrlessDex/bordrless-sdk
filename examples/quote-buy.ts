/**
 * Quote and build a buy on a launch pool, then simulate it to read exactly what the wallet would
 * receive. Nothing is signed or sent: simulation needs no signature, only a wallet that holds the SOL.
 *
 * The transaction is what the Bordrless site sends for a buy with SOL: create the wallet's bridged-SOL
 * holding, wrap the SOL on the bridge, create its holding of the token, swap on the launch pool (with
 * the token's hook accounts), as a v0 transaction through the protocol lookup table. A sell is the
 * same with direction 0, the token amount in, and `bridge.unwrapSolAbove` after to turn the bridged
 * SOL back into SOL.
 *
 *   RPC_URL=... node examples/quote-buy.ts <mint> <SOL to spend> <wallet>
 */
import { PublicKey } from '@solana/web3.js';
import { BPS, KIT_MODULES, SOL_DECIMALS, mulDivFloor, quoteLaunchSwap, sniperLpFee } from '@bordrless/shared';
import {
  bridge,
  buildV0Transaction,
  decodeHolding,
  decodeKitConfig,
  decodeLaunch,
  decodeMint,
  decodePool,
  explainFailure,
  fetchCustomHookAccounts,
  holdingAddress,
  launch as launchIx,
  launchAddress,
  launchKeysOf,
  setComputeUnitLimit,
  token,
} from '@bordrless/sdk';
import { MAINNET_LOOKUP_TABLE, arg, connection, units } from './common.ts';

const mint = new PublicKey(arg(0, '<mint> <SOL> <wallet>'));
const lamports = BigInt(Math.round(Number(arg(1, '<mint> <SOL> <wallet>')) * 1e9));
const wallet = new PublicKey(arg(2, '<mint> <SOL> <wallet>'));
const slippageBps = 100n;

const [mintInfo, launchInfo] = await connection.getMultipleAccountsInfo([mint, launchAddress(mint)]);
if (!mintInfo || !launchInfo) throw new Error('not a Bordrless launch');
const tokenMint = decodeMint(mintInfo.data);
const launch = decodeLaunch(launchInfo.data);
const [poolInfo, kitInfo] = await connection.getMultipleAccountsInfo([launch.pool, launch.kitConfig]);
const pool = decodePool(poolInfo!.data);
const kit = (launch.modules & KIT_MODULES.HOLDER_REWARDS) !== 0 && kitInfo ? decodeKitConfig(kitInfo.data) : null;

// 1. The quote from the pool's state, as the program computes it. The LP fee is the sniper fee
//    falling over the window after launch (the creator's own first buy pays the base rate).
const now = Math.floor(Date.now() / 1000);
const lpFeeBps = sniperLpFee(now, launch.createdAt, launch.sniperWindowSecs, launch.sniperStartBps, launch.lpFeeBps);
const quote = quoteLaunchSwap(pool, 'buy', lamports, lpFeeBps, pool.protocolShareBps, {
  creatorFeeBps: launch.creatorFeeBps,
  holderFeeBuyBps: launch.rules.holderFeeBuyBps,
  holderFeeSellBps: launch.rules.holderFeeSellBps,
  burnBuyBps: launch.rules.burnBuyBps,
  burnSellBps: launch.rules.burnSellBps,
  eligible: kit?.eligible ?? 0n,
  minEligible: kit?.minEligible ?? 0n,
});
if (quote.failure || quote.delivered === null) throw new Error(`no quote: ${quote.failure}`);
const minOut = mulDivFloor(quote.delivered, BPS - slippageBps, BPS);

// 2. The transaction. A token with its creator's own hook (Half-Life, "Build your own") needs that
//    hook's accounts, read from its registry; the kit's are derived.
const customHook = launch.customHook ? await fetchCustomHookAccounts(connection, launch.customHook, mint) : null;
const keys = launchKeysOf(launch, customHook);
const ixs = [
  setComputeUnitLimit(400_000),
  token.createHolding(wallet, launch.quoteMint, wallet),
  bridge.wrapSol(wallet, lamports),
  token.createHolding(wallet, mint, wallet),
  launchIx.swap(keys, wallet, wallet, 1, lamports, minOut),
];
// A buy that takes the pool past `graduationQuote` should also carry `launch.graduate(...)` (see docs/integration/04-trading.md).
const table = (await connection.getAddressLookupTable(MAINNET_LOOKUP_TABLE)).value;
if (!table) throw new Error('the protocol lookup table is missing');
const { blockhash } = await connection.getLatestBlockhash('confirmed');
const tx = buildV0Transaction(wallet, ixs, blockhash, [table]);

// 3. The simulation: what the wallet's holding of the token holds afterwards.
const holding = holdingAddress(mint, wallet);
const before = await connection.getAccountInfo(holding);
const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: [holding.toBase58()] } });
if (sim.value.err) {
  const why = explainFailure(sim.value.logs ?? [], sim.value.err);
  throw new Error(`the buy would fail: ${why?.explanation ?? JSON.stringify(sim.value.err)}`);
}
const afterData = sim.value.accounts?.[0]?.data[0];
if (afterData === undefined) throw new Error('the simulation did not return the holding');
const received = decodeHolding(Buffer.from(afterData, 'base64')).amount - (before ? decodeHolding(before.data).amount : 0n);

console.log({
  spend: `${units(lamports, SOL_DECIMALS)} SOL`,
  quoted: `${units(quote.delivered, tokenMint.decimals)} ${tokenMint.symbol}`,
  simulated: `${units(received, tokenMint.decimals)} ${tokenMint.symbol}`,
  minOut: `${units(minOut, tokenMint.decimals)} ${tokenMint.symbol} (1% slippage)`,
  fees: { lpFeeBps, creatorFee: `${units(quote.creatorFee, SOL_DECIMALS)} SOL`, holderFee: `${units(quote.holderFee, SOL_DECIMALS)} SOL`, protocolFee: `${units(quote.protocolFee, SOL_DECIMALS)} SOL` },
  computeUnits: sim.value.unitsConsumed,
  transactionBytes: tx.serialize().length,
});
