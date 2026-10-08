/**
 * One token as a terminal's token page shows it: metadata, price, market cap, liquidity, how far
 * along its curve it is, the fees on a trade right now, its rules and its hook. Three reads.
 *
 *   RPC_URL=... node examples/read-launch.ts <mint>
 */
import { PublicKey } from '@solana/web3.js';
import { HALF_LIFE, SOL_DECIMALS, sniperLpFee, spotPrice } from '@bordrless/shared';
import { decodeLaunch, decodeMint, decodePool, launchAddress } from '@bordrless/sdk';
import { arg, connection, units } from './common.ts';

const mint = new PublicKey(arg(0, '<mint>'));
const [mintInfo, launchInfo] = await connection.getMultipleAccountsInfo([mint, launchAddress(mint)]);
if (!mintInfo || !launchInfo) throw new Error('not a Bordrless launch: no mint or no launch account');
const token = decodeMint(mintInfo.data);
const launch = decodeLaunch(launchInfo.data);
const poolInfo = await connection.getAccountInfo(launch.pool);
if (!poolInfo) throw new Error('the launch has no pool');
const pool = decodePool(poolInfo.data);

// Price: the pool's constant product over real plus virtual reserves, in SOL per whole token.
const price = spotPrice(pool, token.decimals, SOL_DECIMALS);
const supply = Number(units(token.supply, token.decimals));
const now = Math.floor(Date.now() / 1000);
// The LP fee falls from `sniperStartBps` to `lpFeeBps` over the sniper window after launch.
const lpFeeNow = sniperLpFee(now, launch.createdAt, launch.sniperWindowSecs, launch.sniperStartBps, launch.lpFeeBps);
const hook = launch.customHook === null ? (launch.modules ? 'the kit (Bordrless launch rules)' : 'none') : launch.customHook.toBase58() === HALF_LIFE.program ? 'Half-Life (exit fee halving every 6 h held)' : `custom, unverified: ${launch.customHook.toBase58()}`;

console.log({
  name: token.name,
  symbol: token.symbol,
  uri: token.uri,
  decimals: token.decimals,
  supply: units(token.supply, token.decimals),
  creator: launch.creator.toBase58(),
  pool: launch.pool.toBase58(),
  status: launch.status === 1 ? 'graduated' : 'on the curve',
  priceSol: price,
  marketCapSol: price * supply,
  liquiditySol: units(pool.quoteReserve, SOL_DECIMALS),
  // Graduation happens when the pool's real SOL reaches `graduationQuote` (or the curve sells out).
  curveProgress: launch.status === 1 ? 1 : Number(pool.quoteReserve) / Number(launch.graduationQuote),
  lpFeeBpsNow: lpFeeNow,
  creatorFeeBps: launch.creatorFeeBps,
  protocolShareBps: pool.protocolShareBps,
  rules: launch.rules,
  tokenHook: hook,
  trades: pool.swapCount.toString(),
});
