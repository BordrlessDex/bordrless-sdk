/**
 * Every launch on the Bordrless launchpad, newest first: one `getProgramAccounts` for the `Launch`
 * accounts (filtered by their discriminator), one batched read of their mints.
 *
 *   RPC_URL=... node examples/list-launches.ts
 */
import { CODERS, LAUNCH_PROGRAM, decodeLaunch, decodeMany, decodeMint } from '@bordrless/sdk';
import { connection } from './common.ts';

// The 8-byte discriminator of `Launch`, at offset 0 of every launch account.
const filter = CODERS.launch.accounts.memcmp('launch');
const accounts = await connection.getProgramAccounts(LAUNCH_PROGRAM, { filters: [{ memcmp: { offset: filter.offset ?? 0, bytes: filter.bytes! } }] });
const launches = accounts.map((a) => ({ address: a.pubkey, launch: decodeLaunch(a.account.data) })).sort((x, y) => y.launch.createdAt - x.launch.createdAt);
const mints = decodeMany(await connection.getMultipleAccountsInfo(launches.map((l) => l.launch.mint)), decodeMint);

console.log(`${launches.length} launches`);
launches.forEach(({ launch }, i) => {
  const mint = mints[i];
  const status = launch.status === 1 ? 'graduated' : 'on the curve';
  const hook = launch.customHook ? `custom hook ${launch.customHook.toBase58()}` : launch.modules ? `kit modules ${launch.modules}` : 'no token rules';
  console.log(`${launch.mint.toBase58()}  ${mint?.symbol ?? '?'}  ${status}  ${new Date(launch.createdAt * 1000).toISOString()}  ${hook}`);
});
