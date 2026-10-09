/**
 * The game ticket standard's phase-2 kinds (`crates/bordrless-game` `jackpot`, `streak`, `launch`;
 * docs/games.md "The jackpot" and "The streak"), read byte for byte, and Studio's game hooks'
 * standard instructions. Held to the crate by `packages/sdk/vectors/companion-games.json`
 * (its `phase2` section), which the programs' `game_vectors` test renders.
 *
 * - **The kind headers** sit right after the base header (offset 120), each with its own magic:
 *   the jackpot's (`BRJ1`: its timer and minimum buy, the count of qualifying buys, and the last
 *   `JACKPOT_ENDED_ROUNDS` (8) rounds that ended, newest first) and the streak's (`BRS1`: its minimum streak and weight). The companion reads
 *   them only for a game of their kind.
 * - **The jackpot.** A qualifying buy (`qualifyingBuy`) is a transfer out of the launch's own pool,
 *   while the launch is on its curve, of at least `minTokens`, to a wallet. Each restarts the timer;
 *   a buy after the timer ran out moves the round that ended to the `ended*` fields first (the
 *   older ones shifting down `earlier`), so it is still one `settle` pays, oldest first
 *   (`settleRound`), for at least 8 timers after it ended. A holding's
 *   mark (the first 8 of its free bytes) is the number of its first qualifying buy since it last
 *   sent; the round's buyer wins if its mark is that round's buy or earlier (`jackpotWinnerHolds`).
 * - **The streak.** Epochs are the base header's rounds. A holding's weight for an epoch is what
 *   it held since the epoch began, registered at its first write that epoch if it qualifies
 *   (`streakQualifies`: by the epoch's end it will have sent nothing for `minStreakSecs`; at least
 *   `minWeight`); any send forfeits it (and the epoch before's). Once the epoch is over, its pot is
 *   shared `pot * weight / total` (`shareOf`).
 */
import { createHash } from 'node:crypto';
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import * as a from './addresses.ts';
import { decodeTicketSlots, rangeIn, roundEnd, ticketEligible, type GameHeader, type HoldingView } from './game.ts';
import type { CustomHookAccounts } from './hooks.ts';

const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);
const sat = (v: bigint): bigint => (v > I64_MAX ? I64_MAX : v < I64_MIN ? I64_MIN : v);

// ---- the kind headers -------------------------------------------------------------------------------

export const JACKPOT_MAGIC: Readonly<Uint8Array> = Uint8Array.from(Buffer.from('BRJ1', 'utf8'));
export const STREAK_MAGIC: Readonly<Uint8Array> = Uint8Array.from(Buffer.from('BRS1', 'utf8'));
/** Where each jackpot header field sits in a jackpot hook's state (absolute offsets, after the base header). */
export const JACKPOT_HEADER_OFFSETS = { magic: 120, timerSecs: 124, minTokens: 128, buys: 136, endedBuyer: 144, endedAmount: 176, endedAt: 184, endedBuys: 192, earlier: 200, end: 592 } as const;
/** How many ended rounds a jackpot hook remembers: the newest in the `ended*` fields, the 7 before it in `earlier` (newest first). */
export const JACKPOT_ENDED_ROUNDS = 8;
/** Bytes of one remembered ended round in `earlier`: buyer 32, amount 8, at 8, number 8. */
export const JACKPOT_ENDED_ROUND_LEN = 56;
/** Where each streak header field sits in a streak hook's state (absolute offsets, after the base header). */
export const STREAK_HEADER_OFFSETS = { magic: 120, minStreakSecs: 124, minWeight: 128, end: 136 } as const;
/** Where a jackpot hook keeps a holding's mark: the first 8 of its hook data's free bytes. */
export const JACKPOT_MARK_OFFSET = 48;
/** A jackpot's timer: 5 minutes to 30 days. */
export const MIN_TIMER_SECS = 300;
export const MAX_TIMER_SECS = 30 * 86_400;
/** The longest streak a game may require: a year. */
export const MAX_MIN_STREAK_SECS = 365 * 86_400;

export interface JackpotHeader {
  timerSecs: number;
  minTokens: bigint;
  /** Qualifying buys so far: the current round's number (0: none yet). */
  buys: bigint;
  /** The round that ended last: its buyer (the default key: none), what they bought, when, its number (0: none). */
  endedBuyer: PublicKey;
  endedAmount: bigint;
  endedAt: bigint;
  endedBuys: bigint;
  /** The ended rounds before it, newest first (`JACKPOT_ENDED_ROUNDS - 1` of them; number 0: none). */
  earlier: EndedRound[];
}

/** A round that ended, as a jackpot hook remembers it. */
export interface EndedRound {
  buyer: PublicKey;
  amount: bigint;
  at: bigint;
  /** Its number (0: none). */
  number: bigint;
}

export interface StreakHeader {
  minStreakSecs: number;
  minWeight: bigint;
}

const bufOf = (data: Uint8Array): Buffer => Buffer.from(data.buffer, data.byteOffset, data.length);

/** A jackpot hook's jackpot header from its state's data (length and magic checked); null otherwise. */
export function parseJackpotHeader(data: Uint8Array): JackpotHeader | null {
  const o = JACKPOT_HEADER_OFFSETS;
  if (data.length < o.end) return null;
  const b = bufOf(data);
  if (!b.subarray(o.magic, o.magic + 4).equals(JACKPOT_MAGIC)) return null;
  return {
    timerSecs: b.readUInt32LE(o.timerSecs),
    minTokens: b.readBigUInt64LE(o.minTokens),
    buys: b.readBigUInt64LE(o.buys),
    endedBuyer: new PublicKey(b.subarray(o.endedBuyer, o.endedBuyer + 32)),
    endedAmount: b.readBigUInt64LE(o.endedAmount),
    endedAt: b.readBigInt64LE(o.endedAt),
    endedBuys: b.readBigUInt64LE(o.endedBuys),
    earlier: Array.from({ length: JACKPOT_ENDED_ROUNDS - 1 }, (_, i) => {
      const at = o.earlier + i * JACKPOT_ENDED_ROUND_LEN;
      return { buyer: new PublicKey(b.subarray(at, at + 32)), amount: b.readBigUInt64LE(at + 32), at: b.readBigInt64LE(at + 40), number: b.readBigUInt64LE(at + 48) };
    }),
  };
}

/** The `i`-th newest ended round a jackpot header remembers (0: the `ended*` fields); null past the end. */
export function endedRound(j: JackpotHeader, i: number): EndedRound | null {
  if (i === 0) return { buyer: j.endedBuyer, amount: j.endedAmount, at: j.endedAt, number: j.endedBuys };
  return j.earlier[i - 1] ?? null;
}

/** The jackpot header's 472 bytes as they sit at offset 120 (`JackpotHeader::encode`); `earlier` missing or short is zeros. */
export function encodeJackpotHeader(j: JackpotHeader): Buffer {
  const o = JACKPOT_HEADER_OFFSETS;
  const out = Buffer.alloc(o.end - o.magic);
  const at = (offset: number): number => offset - o.magic;
  Buffer.from(JACKPOT_MAGIC).copy(out, 0);
  out.writeUInt32LE(j.timerSecs, at(o.timerSecs));
  out.writeBigUInt64LE(j.minTokens, at(o.minTokens));
  out.writeBigUInt64LE(j.buys, at(o.buys));
  j.endedBuyer.toBuffer().copy(out, at(o.endedBuyer));
  out.writeBigUInt64LE(j.endedAmount, at(o.endedAmount));
  out.writeBigInt64LE(j.endedAt, at(o.endedAt));
  out.writeBigUInt64LE(j.endedBuys, at(o.endedBuys));
  for (const [i, r] of (j.earlier ?? []).slice(0, JACKPOT_ENDED_ROUNDS - 1).entries()) {
    const start = at(o.earlier + i * JACKPOT_ENDED_ROUND_LEN);
    r.buyer.toBuffer().copy(out, start);
    out.writeBigUInt64LE(r.amount, start + 32);
    out.writeBigInt64LE(r.at, start + 40);
    out.writeBigUInt64LE(r.number, start + 48);
  }
  return out;
}

/** A streak hook's streak header from its state's data (length and magic checked); null otherwise. */
export function parseStreakHeader(data: Uint8Array): StreakHeader | null {
  const o = STREAK_HEADER_OFFSETS;
  if (data.length < o.end) return null;
  const b = bufOf(data);
  if (!b.subarray(o.magic, o.magic + 4).equals(STREAK_MAGIC)) return null;
  return { minStreakSecs: b.readUInt32LE(o.minStreakSecs), minWeight: b.readBigUInt64LE(o.minWeight) };
}

/** The streak header's 16 bytes as they sit at offset 120 (`StreakHeader::encode`). */
export function encodeStreakHeader(s: StreakHeader): Buffer {
  const out = Buffer.alloc(16);
  Buffer.from(STREAK_MAGIC).copy(out, 0);
  out.writeUInt32LE(s.minStreakSecs, 4);
  out.writeBigUInt64LE(s.minWeight, 8);
  return out;
}

// ---- the jackpot ----------------------------------------------------------------------------------

/** A launch as a jackpot hook reads it: its pool, and whether it is still on its curve (no liquidity can be added or removed). */
export interface LaunchView {
  pool: PublicKey;
  onCurve: boolean;
}

/** Whether a round whose last qualifying buy was at `at` is over at `now` (`timer_over`). */
export const timerOver = (at: bigint, timerSecs: number, now: bigint): boolean => now >= sat(at + BigInt(timerSecs));

/** A holding's jackpot mark: the number of its first qualifying buy since it last sent; 0 for none. */
export const jackpotMark = (hookData: Uint8Array): bigint => bufOf(hookData).readBigUInt64LE(JACKPOT_MARK_OFFSET);

/** Whether a transfer is a qualifying buy (`qualifying_buy`): out of the launch's pool, on the curve, of at least `minTokens` (and 1), to a wallet that is none of `excluded`. */
export function qualifyingBuy(launch: LaunchView | null, sourceOwner: PublicKey, destinationOwner: PublicKey, amount: bigint, minTokens: bigint, excluded: readonly PublicKey[] = []): boolean {
  if (!launch) return false;
  const floor = minTokens > 1n ? minTokens : 1n;
  return launch.onCurve && !launch.pool.equals(PublicKey.default) && sourceOwner.equals(launch.pool) && amount >= floor && !destinationOwner.equals(launch.pool) && ticketEligible(destinationOwner, excluded);
}

/** A jackpot round `settle` may close: its number, buyer, amount and the time of its last buy. */
export interface JackpotRound {
  number: bigint;
  buyer: PublicKey;
  amount: bigint;
  at: bigint;
}

/**
 * How many remembered ended rounds, newest first, form the chain a hook under the standard leaves
 * (`ended_chain`): each numbered (not 0) below the round after it and over by the timer before that
 * round's last buy; the rounds past the first that is not are ignored.
 */
function endedChain(header: Pick<GameHeader, 'lastBuyAt'>, jackpot: JackpotHeader, timerSecs: number): number {
  let nextNumber = jackpot.buys;
  let nextAt = header.lastBuyAt;
  let n = 0;
  for (let r = endedRound(jackpot, 0); r; r = endedRound(jackpot, n)) {
    if (r.number === 0n || r.number >= nextNumber || !timerOver(r.at, timerSecs, nextAt)) break;
    nextNumber = r.number;
    nextAt = r.at;
    n += 1;
  }
  return n;
}

/**
 * The oldest jackpot round that is over and not settled (`settle_round`), `paid` being
 * `Game.paidBuys` and `timerSecs` `Game.timerSecs`: the oldest remembered ended round later than
 * `paid`, else the current round once its timer has run out at `now`; null for none. `settle`
 * closes it (pays its buyer if they hold, else forfeits it); pass `settle` that round's buyer, and
 * call again with the round's number as `paid` for the next one.
 */
export function settleRound(header: Pick<GameHeader, 'lastBuyer' | 'lastAmount' | 'lastBuyAt'>, jackpot: JackpotHeader, paid: bigint, timerSecs: number, now: bigint | number): JackpotRound | null {
  const t = BigInt(now);
  for (let i = endedChain(header, jackpot, timerSecs) - 1; i >= 0; i -= 1) {
    const r = endedRound(jackpot, i)!;
    if (r.number > paid) return { number: r.number, buyer: r.buyer, amount: r.amount, at: r.at };
  }
  if (jackpot.buys > paid && timerOver(header.lastBuyAt, timerSecs, t)) return { number: jackpot.buys, buyer: header.lastBuyer, amount: header.lastAmount, at: header.lastBuyAt };
  return null;
}

/** Whether a holding with `hookData` and `balance` still holds what `round` bought (`jackpot_winner_holds`): its mark is that buy or earlier, and its balance at least the amount. */
export function jackpotWinnerHolds(hookData: Uint8Array, round: JackpotRound, balance: bigint): boolean {
  const mark = jackpotMark(hookData);
  return mark !== 0n && mark <= round.number && balance >= round.amount && round.amount > 0n;
}

// ---- the streak -----------------------------------------------------------------------------------

/** Whether a holding that last sent (or first received) at `since` qualifies for `epoch`: by the epoch's end it will have sent nothing for `minStreakSecs` (`streak_qualifies`). */
export function streakQualifies(since: bigint, epoch: number, epochSecs: number, minStreakSecs: number): boolean {
  return since > 0n && since <= sat(BigInt(roundEnd(epoch, epochSecs)) - BigInt(minStreakSecs));
}

/** The weight a holding with `hookData` and `balance` claims for `epoch` (`streak_weight`): its live weight that epoch, at least `minWeight`, at most its balance, still qualifying; 0 otherwise. */
export function streakWeight(hookData: Uint8Array, epoch: number, epochSecs: number, minStreakSecs: number, minWeight: bigint, balance: bigint): bigint {
  const slots = decodeTicketSlots(hookData);
  const r = rangeIn(slots, epoch);
  const floor = minWeight > 1n ? minWeight : 1n;
  if (!r || r.weight < floor || r.weight > balance || !streakQualifies(slots.since, epoch, epochSecs, minStreakSecs)) return 0n;
  return r.weight;
}

/** A holding's share of an epoch's pot: `pot * weight / total` rounded down, never above the pot; 0 for a total of 0 (`share_of`). */
export function shareOf(pot: bigint, weight: bigint, total: bigint): bigint {
  if (total === 0n) return 0n;
  return (pot * (weight < total ? weight : total)) / total;
}

/** A holding's claimable share of the claim epoch. */
export interface StreakClaim {
  owner: PublicKey;
  holding: PublicKey;
  weight: bigint;
  /** Before the sender's bounty. */
  share: bigint;
}

/**
 * The holdings among `holdings` with a share of epoch `epoch` to claim (`claim_share`'s checks):
 * of `mint`, at their owner's address, a wallet outside `excluded`, a weight `streakWeight` counts
 * and a share above 0 (`pot`, `total`: `Game.prize`, `Game.total`). Receipts already made are the
 * caller's to skip (`receiptAddress`).
 */
export function streakClaims(holdings: readonly HoldingView[], mint: PublicKey, epoch: number, g: { roundSecs: number; minStreakSecs: number; minWeight: bigint; prize: bigint; total: bigint }, excluded: readonly PublicKey[] = [a.launchAddress(mint), a.companionCreatorAddress(mint)]): StreakClaim[] {
  const out: StreakClaim[] = [];
  for (const h of holdings) {
    if (!h.mint.equals(mint) || !h.address.equals(a.holdingAddress(mint, h.owner)) || !ticketEligible(h.owner, excluded)) continue;
    const weight = streakWeight(h.hookData, epoch, g.roundSecs, g.minStreakSecs, g.minWeight, h.amount);
    const share = weight > 0n ? shareOf(g.prize, weight, g.total) : 0n;
    if (share > 0n) out.push({ owner: h.owner, holding: h.address, weight, share });
  }
  return out;
}

/** The holdings a streak hook's `enter` would register now (`streak_on_enter`): not written in `epoch` yet, a balance of at least the floor, still qualifying. */
export function streakHoldingsToEnter(holdings: readonly HoldingView[], mint: PublicKey, epoch: number, epochSecs: number, streak: StreakHeader, excluded: readonly PublicKey[] = [a.launchAddress(mint), a.companionCreatorAddress(mint)]): HoldingView[] {
  const floor = streak.minWeight > 1n ? streak.minWeight : 1n;
  return holdings.filter((h) => {
    if (!h.mint.equals(mint) || h.amount < floor || !ticketEligible(h.owner, excluded)) return false;
    const slots = decodeTicketSlots(h.hookData);
    return slots.current.round !== epoch && streakQualifies(slots.since, epoch, epochSecs, streak.minStreakSecs);
  });
}

// ---- Studio game hooks ------------------------------------------------------------------------------

const discriminator = (name: string): Buffer => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });

/**
 * A Studio game hook's standard instructions (the starters in bordrless-programs'
 * `programs/tests/fixtures/starters`, which a Studio game project keeps): `prepare` (Studio's
 * standard: anyone, once per mint; the game's settings are the hook's constants), `enter` (anyone,
 * for any holding: registers it for the round or epoch, through `write_own_hook_data`), and the
 * hook's accounts for a launch (its registry's order: the state, writable; the launch).
 */
export const studioGameHook = {
  prepare(hook: PublicKey, payer: PublicKey, mint: PublicKey): TransactionInstruction {
    return new TransactionInstruction({ programId: hook, keys: [rw(payer, true), ro(mint), rw(a.gameStateAddress(hook, mint)), rw(a.registryAddress(hook, mint)), ro(a.SYSTEM_PROGRAM)], data: discriminator('prepare') });
  },
  enter(hook: PublicKey, mint: PublicKey, owner: PublicKey): TransactionInstruction {
    return new TransactionInstruction({
      programId: hook,
      keys: [rw(a.gameStateAddress(hook, mint)), ro(mint), rw(a.holdingAddress(mint, owner)), ro(a.hookAuthority(hook)), ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY)],
      data: discriminator('enter'),
    });
  },
  accounts(hook: PublicKey, mint: PublicKey): CustomHookAccounts {
    return { program: hook, extras: [rw(a.gameStateAddress(hook, mint)), ro(a.launchAddress(mint))] };
  },
};
