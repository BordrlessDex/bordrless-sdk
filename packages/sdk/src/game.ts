/**
 * Game ticket standard v1 (`crates/bordrless-game` in bordrless-programs; docs/companions.md
 * "Games"), read byte for byte: how a game coin's token hook records who holds tickets, and how
 * the companion, which holds the pot, reads them. The hook writes; the companion and this module
 * only read. Held to the crate by `packages/sdk/vectors/companion-games.json`, which the programs'
 * `game_vectors` test renders from the Rust reference.
 *
 * - **The header**, after Anchor's 8-byte discriminator at the start of the hook's state
 *   `PDA(["state", mint], hook)` (`gameStateAddress`): magic `BRG1`, the mint, `roundSecs`, the
 *   current `round` and its ticket `total`, the round before (`prevRound`, `prevTotal`), and the
 *   last qualifying buy (jackpot games). `gameTotalOf` answers a finished round's total, or null
 *   once the header has forgotten it.
 * - **The slots**, a holding's 64 bytes of hook data: the round it was last written in with its
 *   range `[start, start + weight)` of that round's ticket space, the previous round's range (so a
 *   winner who trades in the next round can still claim), `since`, and 16 bytes for the hook.
 * - **Rounds** are `floor(unix_time / roundSecs)`; a round's tickets are the tokens held since it
 *   began, registered at the holding's first write that round (a transfer, a burn, or anyone's
 *   `enter`). Ranges only shrink. A draw of round `r` is decided before round `r + 2` begins.
 * - **A draw** picks ticket `drawIndex(R, k, total)` for attempt `k`: the first 8 bytes of
 *   `sha256(R ‖ u32_le(k))` as a little-endian u64, modulo the round's total. The holding whose
 *   range for the round contains it wins, if the range is no larger than its balance and its owner
 *   is a wallet (`ticketEligible`). `findWinningHolding` finds it among the mint's holdings.
 *
 * Amounts and ticket numbers are bigint (u64); `since` and `lastBuyAt` are bigint too (i64, kept
 * exact so a decoded slot encodes back to the same bytes); rounds and lengths are numbers (u32).
 */
import { createHash } from 'node:crypto';
import { PublicKey, type Connection } from '@solana/web3.js';
import { HOLDING_SIZE, decodeHolding } from './accounts.ts';
import { TOKEN_PROGRAM, companionCreatorAddress, holdingAddress, launchAddress } from './addresses.ts';
import { CODERS } from './coders.ts';

/** The first four bytes of a game hook's header: `BRG1`, the standard's layout version 1. */
export const GAME_MAGIC: Readonly<Uint8Array> = Uint8Array.from(Buffer.from('BRG1', 'utf8'));
/** Bytes of the header (after the discriminator). */
export const GAME_HEADER_LEN = 112;
/** Bytes of hook data per holding. */
export const TICKET_SLOTS_LEN = 64;
/** The shortest round (an hour) and the longest (30 days). */
export const MIN_ROUND_SECS = 3_600;
export const MAX_ROUND_SECS = 30 * 86_400;

/** Where each header field sits in a game hook's state account (absolute offsets, the discriminator first; integers little-endian). */
export const GAME_HEADER_OFFSETS = { magic: 8, mint: 12, roundSecs: 44, round: 48, total: 52, prevRound: 60, prevTotal: 64, lastBuyer: 72, lastAmount: 104, lastBuyAt: 112, end: 120 } as const;
/** Where each field sits in a holding's 64 bytes of hook data (integers little-endian). */
export const TICKET_SLOT_OFFSETS = { round: 0, start: 4, weight: 12, prevRound: 20, prevStart: 24, prevWeight: 32, since: 40, free: 48, freeLen: 16 } as const;

const U32_MAX = 0xffff_ffff;
const I64_MAX = (1n << 63n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

/** Why a game hook's state was not read as a header. */
export type GameHeaderProblem = 'TooShort' | 'BadMagic' | 'WrongMint';

export class GameHeaderError extends Error {
  readonly problem: GameHeaderProblem;
  constructor(problem: GameHeaderProblem) {
    super(`not a game header: ${problem}`);
    this.problem = problem;
  }
}

// ---- rounds ----------------------------------------------------------------------------------------

/** The round `now` falls in: `floor(now / roundSecs)`; 0 before 1970 or for a `roundSecs` of 0, and at most 2^32 - 1. */
export function roundOf(now: number | bigint, roundSecs: number): number {
  const t = BigInt(now);
  if (roundSecs === 0 || t <= 0n) return 0;
  const round = t / BigInt(roundSecs);
  return round > BigInt(U32_MAX) ? U32_MAX : Number(round);
}

const saturate = (v: bigint): bigint => (v > I64_MAX ? I64_MAX : v);

/** When `round` starts: `round * roundSecs` (unix seconds, saturating at i64's maximum; exact below 2^53). */
export const roundStart = (round: number, roundSecs: number): number => Number(saturate(BigInt(round) * BigInt(roundSecs)));
/** When `round` ends, the next round's start: its tickets are final from then on. */
export const roundEnd = (round: number, roundSecs: number): number => Number(saturate(saturate(BigInt(round) * BigInt(roundSecs)) + BigInt(roundSecs)));
/** Whether a round length is within the standard's bounds (an hour to 30 days). */
export const validRoundSecs = (roundSecs: number): boolean => roundSecs >= MIN_ROUND_SECS && roundSecs <= MAX_ROUND_SECS;

// ---- the header ------------------------------------------------------------------------------------

export interface GameHeader {
  mint: PublicKey;
  roundSecs: number;
  /** The round of the last write, and its ticket total (every range of the round lies in `[0, total)`). */
  round: number;
  total: bigint;
  /** The round the header held before its last roll, and its total; 0 until the first roll. */
  prevRound: number;
  prevTotal: bigint;
  /** The last qualifying buy (jackpot games; the default key, 0 and 0 when unused). */
  lastBuyer: PublicKey;
  lastAmount: bigint;
  lastBuyAt: bigint;
}

/** The header of a game hook's state account (the discriminator first, which is the hook's own and not checked): its length and magic checked. */
export function parseGameHeader(data: Uint8Array): GameHeader {
  const o = GAME_HEADER_OFFSETS;
  if (data.length < o.end) throw new GameHeaderError('TooShort');
  const b = Buffer.from(data.buffer, data.byteOffset, data.length);
  if (!b.subarray(o.magic, o.magic + 4).equals(GAME_MAGIC)) throw new GameHeaderError('BadMagic');
  return {
    mint: new PublicKey(b.subarray(o.mint, o.mint + 32)),
    roundSecs: b.readUInt32LE(o.roundSecs),
    round: b.readUInt32LE(o.round),
    total: b.readBigUInt64LE(o.total),
    prevRound: b.readUInt32LE(o.prevRound),
    prevTotal: b.readBigUInt64LE(o.prevTotal),
    lastBuyer: new PublicKey(b.subarray(o.lastBuyer, o.lastBuyer + 32)),
    lastAmount: b.readBigUInt64LE(o.lastAmount),
    lastBuyAt: b.readBigInt64LE(o.lastBuyAt),
  };
}

/** `parseGameHeader`, and the header is for `mint` (what the companion reads, after checking the account's owner and address). */
export function readGameHeader(data: Uint8Array, mint: PublicKey): GameHeader {
  const header = parseGameHeader(data);
  if (!header.mint.equals(mint)) throw new GameHeaderError('WrongMint');
  return header;
}

/** The header's 112 bytes as they sit after the discriminator (what Borsh writes for it). */
export function encodeGameHeader(h: GameHeader): Buffer {
  const out = Buffer.alloc(GAME_HEADER_LEN);
  const o = GAME_HEADER_OFFSETS;
  const at = (offset: number): number => offset - 8;
  Buffer.from(GAME_MAGIC).copy(out, at(o.magic));
  h.mint.toBuffer().copy(out, at(o.mint));
  out.writeUInt32LE(h.roundSecs, at(o.roundSecs));
  out.writeUInt32LE(h.round, at(o.round));
  out.writeBigUInt64LE(h.total, at(o.total));
  out.writeUInt32LE(h.prevRound, at(o.prevRound));
  out.writeBigUInt64LE(h.prevTotal, at(o.prevTotal));
  h.lastBuyer.toBuffer().copy(out, at(o.lastBuyer));
  out.writeBigUInt64LE(h.lastAmount, at(o.lastAmount));
  out.writeBigInt64LE(h.lastBuyAt, at(o.lastBuyAt));
  return out;
}

/**
 * Round `round`'s ticket total as the header knows it, for a round that has ended: the header's
 * own round its `total`, `prevRound` its `prevTotal`, a round with no write at all 0, a round
 * before `prevRound` null (forgotten: that round rolls over). `GameHeader::total_of`.
 */
export function gameTotalOf(h: Pick<GameHeader, 'round' | 'total' | 'prevRound' | 'prevTotal'>, round: number): bigint | null {
  if (round === h.round) return h.total;
  if (round > h.round) return 0n;
  if (round === h.prevRound) return h.prevTotal;
  if (round > h.prevRound) return 0n;
  return null;
}

// ---- the slots -------------------------------------------------------------------------------------

/** A holding's tickets in one round: `[start, start + weight)`; none when `weight` is 0. */
export interface TicketRange {
  round: number;
  start: bigint;
  weight: bigint;
}

/** A holding's 64 bytes of hook data under the standard. */
export interface TicketSlots {
  /** The round the holding was last written in, and its range that round (weight 0: it held nothing through the round so far). */
  current: TicketRange;
  /** An earlier round's range, kept so its winner can still claim after trading again; all zeros without tickets. */
  previous: TicketRange;
  /** When the holding last sent (or burned) anything, or first received; 0 for none. */
  since: bigint;
  /** Bytes 48..64, the hook's own. */
  free: Uint8Array;
}

const EMPTY: TicketRange = { round: 0, start: 0n, weight: 0n };
const noneIn = (round: number): TicketRange => ({ round, start: 0n, weight: 0n });

function decodeRange(b: Buffer, at: number): TicketRange {
  const range = { round: b.readUInt32LE(at), start: b.readBigUInt64LE(at + 4), weight: b.readBigUInt64LE(at + 12) };
  return range.weight === 0n ? noneIn(range.round) : range;
}

function encodeRange(r: TicketRange, out: Buffer, at: number): void {
  const written = r.weight === 0n ? noneIn(r.round) : r;
  out.writeUInt32LE(written.round, at);
  out.writeBigUInt64LE(written.start, at + 4);
  out.writeBigUInt64LE(written.weight, at + 12);
}

/** Reads a holding's hook data (`Slots::decode`). All zeros (never written) is no tickets. */
export function decodeTicketSlots(hookData: Uint8Array): TicketSlots {
  if (hookData.length !== TICKET_SLOTS_LEN) throw new RangeError(`hook data is 64 bytes, not ${hookData.length}`);
  const b = Buffer.from(hookData.buffer, hookData.byteOffset, hookData.length);
  const o = TICKET_SLOT_OFFSETS;
  const previous = decodeRange(b, o.prevRound);
  return { current: decodeRange(b, o.round), previous: previous.weight > 0n ? previous : { ...EMPTY }, since: b.readBigInt64LE(o.since), free: Uint8Array.from(b.subarray(o.free, o.free + o.freeLen)) };
}

/** The hook data a hook writes for `slots` (`Slots::encode`): a current slot without tickets as its round alone, a previous slot without tickets as zeros. */
export function encodeTicketSlots(slots: TicketSlots): Buffer {
  const out = Buffer.alloc(TICKET_SLOTS_LEN);
  const o = TICKET_SLOT_OFFSETS;
  encodeRange(slots.current, out, o.round);
  if (slots.previous.weight > 0n) encodeRange(slots.previous, out, o.prevRound);
  out.writeBigInt64LE(slots.since, o.since);
  Buffer.from(slots.free).copy(out, o.free, 0, o.freeLen);
  return out;
}

/** The holding's live range in `round`: the current slot's, else the previous slot's; null for none. */
export function rangeIn(slots: TicketSlots, round: number): TicketRange | null {
  return [slots.current, slots.previous].find((r) => r.weight > 0n && r.round === round) ?? null;
}

/** Whether ticket `x` is in `range`. */
export const rangeContains = (range: TicketRange, x: bigint): boolean => range.weight > 0n && x >= range.start && x - range.start < range.weight;

/** Whether a holding with `hookData` and `balance` holds ticket `x` of `round`: its range for that round contains `x` and is no larger than the balance (`bordrless_game::wins`). */
export function ticketWins(hookData: Uint8Array, round: number, x: bigint, balance: bigint): boolean {
  const range = rangeIn(decodeTicketSlots(hookData), round);
  return range !== null && range.weight <= balance && rangeContains(range, x);
}

/** Whether `owner` may hold tickets: none of `excluded`, not the default key, and on the ed25519 curve (a wallet; no program's account ever holds tickets). */
export function ticketEligible(owner: PublicKey, excluded: readonly PublicKey[] = []): boolean {
  return !owner.equals(PublicKey.default) && !excluded.some((e) => e.equals(owner)) && PublicKey.isOnCurve(owner.toBytes());
}

// ---- draws -----------------------------------------------------------------------------------------

/**
 * The ticket attempt `k` of a draw with `randomness` picks in a round of `total` tickets:
 * `u64_le(sha256(randomness ‖ u32_le(k))[..8]) % total`; null for a round with no tickets
 * (`bordrless_game::draw_index`).
 */
export function drawIndex(randomness: Uint8Array, k: number, total: bigint): bigint | null {
  if (total === 0n) return null;
  if (!Number.isInteger(k) || k < 0 || k > U32_MAX) throw new RangeError(`attempt ${k} is not a u32`);
  if (total < 0n || total > U64_MAX) throw new RangeError(`total ${total} is not a u64`);
  const kb = Buffer.alloc(4);
  kb.writeUInt32LE(k);
  const hash = createHash('sha256').update(randomness).update(kb).digest();
  return hash.readBigUInt64LE(0) % total;
}

/** Where a holding's mint sits: after the discriminator, `version` and `bump`. */
export const HOLDING_MINT_OFFSET = 10;

/** The owners a game passes as never holding tickets besides off-curve keys: the launch and the companion's creator address (the pool is off the curve). */
const defaultExcluded = (mint: PublicKey): PublicKey[] => [launchAddress(mint), companionCreatorAddress(mint)];

/** A holding found to hold a draw's ticket. */
export interface WinningHolding {
  /** The ticket attempt `k` picks. */
  ticket: bigint;
  holding: PublicKey;
  owner: PublicKey;
  amount: bigint;
  /** Its range for the drawn round. */
  range: TicketRange;
}

/** The parts of a holding the winner search reads. */
export interface HoldingView {
  address: PublicKey;
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  hookData: Uint8Array;
}

/**
 * The holding among `holdings` that wins attempt `attempt` of a draw of round `round` (`total`
 * tickets, `randomness` revealed), as `claim_prize` checks it: of `mint`, at its owner's holding
 * address, its owner eligible (a wallet, not one of `excluded`), its range for the round holding
 * the ticket and no larger than its balance. Null when nobody holds it (a dead ticket: the next
 * attempt opens after the claim window). Ranges of a round never overlap, so at most one wins.
 */
export function winningHoldingAmong(holdings: readonly HoldingView[], mint: PublicKey, randomness: Uint8Array, attempt: number, total: bigint, round: number, excluded: readonly PublicKey[] = defaultExcluded(mint)): WinningHolding | null {
  const ticket = drawIndex(randomness, attempt, total);
  if (ticket === null) return null;
  for (const h of holdings) {
    if (!h.mint.equals(mint) || !h.address.equals(holdingAddress(mint, h.owner)) || !ticketEligible(h.owner, excluded)) continue;
    const range = rangeIn(decodeTicketSlots(h.hookData), round);
    if (range && range.weight <= h.amount && rangeContains(range, ticket)) return { ticket, holding: h.address, owner: h.owner, amount: h.amount, range };
  }
  return null;
}

/**
 * The winning holding of attempt `attempt` of the draw of round `round` (`Game.round`, `Game.total`,
 * `Game.randomness`), read from every holding of `mint` (`getProgramAccounts` on the token program,
 * filtered by size, discriminator and mint). The round is needed: every round's ticket space starts
 * at 0. A keeper caches the holdings per round (ranges only shrink after the round ends) and sends
 * `companion.claimPrize` for the winner during the attempt's window.
 */
export async function findWinningHolding(connection: Connection, mint: PublicKey, randomness: Uint8Array, attempt: number, total: bigint, round: number, excluded: readonly PublicKey[] = defaultExcluded(mint)): Promise<WinningHolding | null> {
  if (total === 0n) return null;
  const holdings = await fetchHoldingViews(connection, mint);
  return winningHoldingAmong(holdings, mint, randomness, attempt, total, round, excluded);
}

/** Every holding of `mint` (`getProgramAccounts` on the token program: 204 bytes, the `Holding` discriminator, the mint at byte 10). */
export async function fetchHoldingViews(connection: Connection, mint: PublicKey): Promise<HoldingView[]> {
  const disc = CODERS.token.accounts.memcmp('holding');
  const found = await connection.getProgramAccounts(TOKEN_PROGRAM, {
    commitment: 'confirmed',
    filters: [{ dataSize: HOLDING_SIZE }, { memcmp: { offset: disc.offset ?? 0, bytes: disc.bytes! } }, { memcmp: { offset: HOLDING_MINT_OFFSET, bytes: mint.toBase58() } }],
  });
  return found.flatMap(({ pubkey, account }) => {
    try {
      const h = decodeHolding(account.data);
      return [{ address: pubkey, mint: h.mint, owner: h.owner, amount: h.amount, hookData: h.hookData }];
    } catch {
      return [];
    }
  });
}
