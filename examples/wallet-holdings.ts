/**
 * Every Bordrless token a wallet holds. Wallets don't list these (they aren't SPL accounts): a
 * holding is a `Holding` account of the token program at `["holding", mint, owner]`, 204 bytes,
 * with the mint at byte 10, the owner at byte 42 and the amount (u64, little-endian) at byte 74.
 * One `getProgramAccounts` with a size and an owner filter finds them all.
 *
 *   RPC_URL=... node examples/wallet-holdings.ts <owner>
 */
import { PublicKey } from '@solana/web3.js';
import { BRIDGED_SOL_MINT, HOLDING_SIZE, TOKEN_PROGRAM, decodeHolding, decodeMany, decodeMint, halfLifeSince } from '@bordrless/sdk';
import { HALF_LIFE, halfLifeFeePpm } from '@bordrless/shared';
import { arg, connection, units } from './common.ts';

const owner = new PublicKey(arg(0, '<owner>'));
const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM, { filters: [{ dataSize: HOLDING_SIZE }, { memcmp: { offset: 42, bytes: owner.toBase58() } }] });
const holdings = accounts.map((a) => ({ address: a.pubkey, holding: decodeHolding(a.account.data) })).filter((h) => h.holding.amount > 0n);
const mints = decodeMany(await connection.getMultipleAccountsInfo(holdings.map((h) => h.holding.mint)), decodeMint);
const now = Math.floor(Date.now() / 1000);

holdings.forEach(({ address, holding }, i) => {
  const mint = mints[i];
  if (!mint) return;
  const label = holding.mint.equals(BRIDGED_SOL_MINT) ? 'bridged SOL' : `${mint.symbol} (${mint.name})`;
  // A Half-Life token: what moving these tokens out would cost now, from the age in the holding.
  const since = mint.hookProgram?.toBase58() === HALF_LIFE.program ? halfLifeSince(holding.hookData) : null;
  const exitFee = since === null ? '' : `  Half-Life exit fee now ${(halfLifeFeePpm(now - since) / 10_000).toFixed(2)}%`;
  console.log(`${units(holding.amount, mint.decimals)} ${label}  mint ${holding.mint.toBase58()}  holding ${address.toBase58()}${holding.frozen ? '  FROZEN' : ''}${exitFee}`);
});
