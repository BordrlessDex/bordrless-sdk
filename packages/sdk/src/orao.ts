/**
 * ORAO VRF, the games' randomness (`bordrless_companion::oracle`; docs/companions.md "Games"), read
 * the way the companion reads it. ORAO's crate pins another Anchor, so the companion builds the
 * request by hand and reads ORAO's accounts at fixed offsets; this module does the same.
 *
 * - `request_v2(seed)` makes the request account `PDA(["orao-vrf-randomness-request", seed])`
 *   (749 bytes, pending) with the payer's lamports and sends the fee to ORAO's treasury. The
 *   companion's payer is `PDA(["oracle", mint])` (`oraclePayerAddress`), topped up from the pot.
 * - ORAO's three fulfilment authorities sign the seed and the randomness is the XOR of their
 *   signatures; the account shrinks to 137 bytes and the 612 freed bytes' rent goes back to the
 *   payer. Nothing closes a request account: the 137 bytes' rent stays with it. On mainnet the last
 *   signature came 7 to 319 slots (about 3 s to 2 minutes) after the request in 8 requests measured
 *   on 2026-10-09; a devnet preview, 7 to 17 slots after its request in 8 (docs/games.md, "Response
 *   times, measured"). Reveal when it lands: a draw leaves it 10 minutes (`GAME_LIMITS.revealSecs`).
 * - Anyone may request any seed, with v2 or with the deprecated v1 `request` (a 780-byte account at
 *   the same address); the companion adopts whatever request ORAO holds for its seed.
 * - Mainnet, read 2026-10-08 (slot 454,671,549): fee 500,000 lamports (`NetworkState` bytes 72..80),
 *   treasury `9ZTHWW…`; rent of 749 bytes 4,455,160, of 137 bytes 1,346,200. A request costs
 *   4,955,160 lamports up front and 1,846,200 net once answered (0.00185 SOL). The companion refuses
 *   a fee above `ORAO_MAX_REQUEST_FEE` (0.005 SOL).
 */
import { createHash } from 'node:crypto';
import { PublicKey, TransactionInstruction, type AccountInfo, type AccountMeta, type Connection } from '@solana/web3.js';
import { ORAO_NETWORK_STATE, ORAO_VRF_PROGRAM, SLOT_HASHES_SYSVAR, SYSTEM_PROGRAM, oraoRequestAddress } from './addresses.ts';

/** A pending v2 request: 8 + 1 + 32 + 32 + 4 + 7 * (32 + 64) bytes. */
export const ORAO_PENDING_LEN = 749;
/** A fulfilled v2 request: 8 + 1 + 32 + 32 + 64 bytes. */
export const ORAO_FULFILLED_LEN = 137;
/** A legacy v1 request, pending or answered: 8 + 32 + 64 + 4 + 7 * (32 + 64) bytes. */
export const ORAO_V1_LEN = 780;
/** The most one request may cost in fees, whatever ORAO's configuration says (`oracle::MAX_REQUEST_FEE`): above it, draws wait. */
export const ORAO_MAX_REQUEST_FEE = 5_000_000n;

const REQUEST_V2 = Buffer.from([38, 151, 209, 6, 195, 102, 28, 217]);
const NETWORK_STATE_DISCRIMINATOR = Buffer.from([212, 237, 148, 56, 97, 245, 51, 169]);
const RANDOMNESS_V2_DISCRIMINATOR = Buffer.from([139, 239, 184, 215, 227, 86, 191, 226]);
const RANDOMNESS_V1_DISCRIMINATOR = Buffer.from([188, 96, 216, 248, 93, 94, 49, 112]);

/** What ORAO charges now, from its network state. */
export interface OraoNetworkState {
  /** ORAO's configuration authority. */
  authority: PublicKey;
  /** Where the fee goes; a request naming another is refused. */
  treasury: PublicKey;
  /** Lamports per request. */
  fee: bigint;
  /** The keys whose signatures make the randomness (all of them today). */
  fulfillmentAuthorities: PublicKey[];
}

/** ORAO's network state (`ORAO_NETWORK_STATE`), its discriminator checked. */
export function decodeOraoNetworkState(data: Uint8Array): OraoNetworkState {
  const b = Buffer.from(data.buffer, data.byteOffset, data.length);
  if (b.length < 84 || !b.subarray(0, 8).equals(NETWORK_STATE_DISCRIMINATOR)) throw new Error('not ORAO’s network state');
  const n = b.readUInt32LE(80);
  if (b.length < 84 + 32 * n) throw new Error('ORAO’s network state is truncated');
  const fulfillmentAuthorities = Array.from({ length: n }, (_, i) => new PublicKey(b.subarray(84 + 32 * i, 116 + 32 * i)));
  return { authority: new PublicKey(b.subarray(8, 40)), treasury: new PublicKey(b.subarray(40, 72)), fee: b.readBigUInt64LE(72), fulfillmentAuthorities };
}

/** The lamports a request takes from its payer up front: the fee and the pending account's rent (`oracle::Terms::cost`); `rent(749)` from `getMinimumBalanceForRentExemption`. */
export const oraoRequestCost = (fee: bigint, pendingRent: bigint): bigint => fee + pendingRent;

/** What ORAO holds for a seed, as the companion reads it (`oracle::randomness`). */
export type OraoRequest =
  /** No account at the request's address, or one with no data (only lamports someone sent): the seed is free to request. */
  | { kind: 'none' }
  /** ORAO's request for the seed, not answered yet. */
  | { kind: 'pending'; version: 1 | 2 }
  /** ORAO's answer: 64 bytes, never all zeros. */
  | { kind: 'answered'; version: 1 | 2; randomness: Uint8Array }
  /** An account the companion refuses to read (another owner, address, seed, layout or length): its draw rolls over (`OracleUnreadable`). */
  | { kind: 'unreadable'; reason: string };

/**
 * What ORAO holds at `address` for `seed`, from that account (`null`: none). Each layout is bound
 * by its exact length as well as its discriminator, as the companion binds it: a pending v2 request
 * 749 bytes, a fulfilled one 137, a v1 one 780.
 */
export function readOraoRequest(address: PublicKey, info: Pick<AccountInfo<Buffer>, 'owner' | 'data'> | null, seed: Uint8Array): OraoRequest {
  if (!info || info.data.length === 0) return { kind: 'none' };
  if (!address.equals(oraoRequestAddress(seed))) return { kind: 'unreadable', reason: 'not the request address of this seed' };
  if (!info.owner.equals(ORAO_VRF_PROGRAM)) return { kind: 'unreadable', reason: 'not owned by ORAO' };
  const d = info.data;
  const sameSeed = (at: number): boolean => d.length >= at + 32 && d.subarray(at, at + 32).equals(Buffer.from(seed));
  if (d.length >= 8 && d.subarray(0, 8).equals(RANDOMNESS_V1_DISCRIMINATOR)) {
    if (d.length !== ORAO_V1_LEN) return { kind: 'unreadable', reason: 'a v1 request of another length' };
    if (!sameSeed(8)) return { kind: 'unreadable', reason: 'another seed' };
    const r = Uint8Array.from(d.subarray(40, 104));
    return r.every((x) => x === 0) ? { kind: 'pending', version: 1 } : { kind: 'answered', version: 1, randomness: r };
  }
  if (d.length < 9 || !d.subarray(0, 8).equals(RANDOMNESS_V2_DISCRIMINATOR)) return { kind: 'unreadable', reason: 'not a randomness request' };
  if (!sameSeed(41)) return { kind: 'unreadable', reason: 'another seed' };
  if (d[8] === 0) return d.length === ORAO_PENDING_LEN ? { kind: 'pending', version: 2 } : { kind: 'unreadable', reason: 'a pending request of another length' };
  if (d[8] === 1) {
    if (d.length !== ORAO_FULFILLED_LEN) return { kind: 'unreadable', reason: 'a fulfilled request of another length' };
    const r = Uint8Array.from(d.subarray(73, 137));
    return r.every((x) => x === 0) ? { kind: 'unreadable', reason: 'fulfilled with zeros' } : { kind: 'answered', version: 2, randomness: r };
  }
  return { kind: 'unreadable', reason: `unknown variant ${d[8]}` };
}

/**
 * A draw's seed (`oracle::draw_seed`): `sha256("bordrless-draw", mint, u32_le round, u32_le n,
 * u64_le slot, slot hash)`, from the slot the draw names and its hash, which nobody knows before the
 * slot is done. `draw` commits it and requests it in one instruction (`Game.seed`); the builder
 * computes it to pass the request's account.
 */
export function drawSeed(mint: PublicKey, round: number, n: number, slot: bigint, slotHash: Uint8Array): Buffer {
  if (slotHash.length !== 32) throw new RangeError(`a slot hash is 32 bytes, not ${slotHash.length}`);
  const u32 = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const u64 = Buffer.alloc(8);
  u64.writeBigUInt64LE(slot);
  return createHash('sha256').update('bordrless-draw').update(mint.toBuffer()).update(u32(round)).update(u32(n)).update(u64).update(slotHash).digest();
}

/** ORAO's `request_v2(seed)`, `payer` paying (`oracle::request_ix`): the payer (signs), the network state, `treasury`, the request account, the system program. */
export function oraoRequestV2(payer: PublicKey, treasury: PublicKey, seed: Uint8Array): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: ORAO_NETWORK_STATE, isSigner: false, isWritable: true },
    { pubkey: treasury, isSigner: false, isWritable: true },
    { pubkey: oraoRequestAddress(seed), isSigner: false, isWritable: true },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: ORAO_VRF_PROGRAM, keys, data: Buffer.concat([REQUEST_V2, Buffer.from(seed)]) });
}

/** The slot a draw's seed is made from, and its hash: an entry of the slot hashes sysvar, as `draw` names it (`client::SeedSlot`). */
export interface SeedSlot {
  slot: bigint;
  hash: Uint8Array;
}

/**
 * The newest entry of the slot hashes sysvar's data (bincode: the number of entries, then each
 * entry's slot and bank hash, the newest first): the slot a keeper's draw names. A slice of the
 * account's first 48 bytes is enough.
 */
export function decodeSeedSlot(data: Uint8Array): SeedSlot {
  const b = Buffer.from(data.buffer, data.byteOffset, data.length);
  if (b.length < 48 || b.readBigUInt64LE(0) === 0n) throw new Error('the slot hashes sysvar holds no entry');
  return { slot: b.readBigUInt64LE(8), hash: Uint8Array.from(b.subarray(16, 48)) };
}

/**
 * The slot a draw names now: the newest entry of the slot hashes sysvar, read at `processed` (the
 * freshest commitment; its first 48 bytes only). That entry is already a slot old, and the draw
 * must land within 3 slots of it (`GAME_LIMITS.seedSlots`), else it fails with `StaleSeed` and is
 * sent again from a newer one. So fetch the blockhash (and any lookup table) first, call this
 * last, and build and send the draw at once, without preflight.
 */
export async function fetchSeedSlot(connection: Pick<Connection, 'getAccountInfo'>): Promise<SeedSlot> {
  const info = await connection.getAccountInfo(SLOT_HASHES_SYSVAR, { commitment: 'processed', dataSlice: { offset: 0, length: 48 } });
  if (!info) throw new Error('the slot hashes sysvar could not be read');
  return decodeSeedSlot(info.data);
}
