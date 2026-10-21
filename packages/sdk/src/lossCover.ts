/**
 * Loss cover (docs/loss-cover.md; the site says Lossback): a pair Bordrless owns, paying SOL from a
 * companion's pot to the holders who are under water, in rounds.
 *
 * - **The hook** (`programs/loss_cover_hook`, `6KMdXC…`) keeps, in each holding's 64 bytes of hook
 *   data (`LossCoverRecord`), the average entry price, the tokens that basis covers, the cover paid
 *   and the round it was last recorded in; its state (`LossCoverState`, `["state", mint]`) the
 *   launch, the pool, the companion address and a slow reference price. `lossCoverHook.prepare` (the
 *   mint signing, before the launch) makes the state and the registry, whose extras are the state
 *   (w), the launch (r) and the pool (r): `lossCoverHook.accounts(mint, lpFeeBps)`. A buy's entry
 *   is what it paid the curve (`lossCoverTradePrice`), with no cap (since the hook's upgrade of
 *   2026-10-12; the reference bounds nothing); `lossCoverHook.setEntry`, signed by the hook's
 *   upgrade authority, repairs a record the first version wrote capped.
 * - **The script** (`programs/loss_cover_script`, `9mRXU9…`) is made with
 *   `companion.createScriptV2` (the terms as its init data, `encodeCoverTerms`; the companion's
 *   payout terms beside it). Its state (`CoverState`, the companion's `["script-state", mint]`)
 *   holds the terms and the rounds: `b` (the round's budget), `lPrev` (the uncovered loss the
 *   previous round measured), `lCur`, `roundPaid`. Every under-water holder is paid the same share
 *   `min(1, b / lPrev)` of its uncovered loss within a round (`lossCoverFraction`).
 * - **The payouts** are the companion's (`PayoutTerms`, `PayoutAnswer`, `ScriptPayout`): a step's
 *   `companion_step` answers up to 16 entries naming holdings among the step's remaining accounts;
 *   the companion checks each against the terms, pays the owner SOL and has the hook record it
 *   (`record_payout`, signed by `PAYOUT_AUTHORITY`).
 * - **The math** the keeper and the site mirror: `lossCoverSpot`, `lossCoverUncovered`,
 *   `lossCoverFraction`, `lossCoverOwed` (one holding's standing now), `payoutStepBudget` and
 *   `payoutBountyFor` (the companion's bounds), held to the programs by `vectors/loss-cover.json`
 *   and `vectors/payouts.json` (bordrless-programs' `loss_cover_vectors` and `payout_vectors`).
 *
 * Accounts and instruction data go through the IDL coders (`CODERS.lossCoverHook`,
 * `CODERS.lossCoverScript`, the companion's); the holding's record (raw hook data), the script's
 * terms (its init data) and the answer are hand-laid as the programs lay them out, and every
 * offset and discriminator is pinned by the vectors' bytes in `lossCover.test.ts`.
 */
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { LOSS_COVER_HOOK, LOSS_COVER_SCRIPT } from '@bordrless/shared';
import BN from 'bn.js';
import * as a from './addresses.ts';
import { CODERS } from './coders.ts';
import { companion, type CompanionSplit } from './companion.ts';
import { roundOf, roundEnd, roundStart } from './game.ts';
import type { CustomHookAccounts } from './hooks.ts';
import type { ScriptArgs } from './scripts.ts';
import { SCRIPT_LIMITS } from './scripts.ts';

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });

// ---- constants ---------------------------------------------------------------------------------------

/** The flags a `LaunchConfig` names for the Loss cover hook: `BEFORE_TRANSFER | BEFORE_BURN | WRITES_HOOK_DATA` (145). */
export const LOSS_COVER_HOOK_FLAGS = LOSS_COVER_HOOK.flags;
/** Prices are lamports per base unit times this (the companion's `PRICE_SCALE`): for a 6-decimal token, SOL per whole token is `price / 10^15`. */
export const LOSS_COVER_PRICE_SCALE = 1_000_000_000_000n;
/** A holding's record: the 64 bytes of hook data. */
export const LOSS_COVER_RECORD_LEN = 64;
/** The hook's state (274 bytes) and the script's (128, what `create_script_v2` asks for). */
export const LOSS_COVER_STATE_LEN = 274;
export const COVER_STATE_LEN = LOSS_COVER_SCRIPT.stateLen;
/** The Borsh of the script's terms (`companion_init`'s init data): 34 bytes. */
export const COVER_TERMS_LEN = 34;
/** `PayoutTerms`: 128 bytes. */
export const PAYOUT_TERMS_LEN = 128;
/** `Record.flags` bit 0: the holding sold or burned since its last buy. */
export const LOSS_COVER_FLAG_SOLD = 1;

/**
 * The programs' own bounds (`loss_cover_hook`, `loss_cover_script`): the reference moves at most
 * once per 10 minutes by at most 5% (it bounds nothing since the hook's upgrade of 2026-10-12;
 * `entryCapBps` is the first version's cap on a buy's basis, no longer applied); the cover share
 * 10% to 100%; a round a minute to a day; a wait after a buy of at most 30 days; a minimum pot of
 * at most 100 SOL.
 */
export const LOSS_COVER_LIMITS = {
  entryCapBps: 2_000,
  referenceSecs: 600,
  referenceStepBps: 500,
  minCoverBps: 1_000,
  maxCoverBps: 10_000,
  minRoundSecs: 60,
  maxRoundSecs: 86_400,
  maxMinAgeSecs: 30 * 86_400,
  maxMinPotLamports: 100_000_000_000n,
} as const;

/** What one step carries, within a packet and the runtime's instruction trace (`loss_cover_vectors`): 7 paid holdings (a holding and its owner each), 13 touched (a holding each). */
export const LOSS_COVER_BATCH = { paying: 7, measuring: 13 } as const;

/** The companion's payout bounds (`constants.rs`): the terms' and the answer's versions, the most entries an answer carries, the entries that earn the whole bounty, the window's bounds. */
export const PAYOUT_LIMITS = { termsVersion: 1, answerVersion: 1, maxPayoutsPerStep: 16, bountyFull: 8, minWindowSecs: 10, maxWindowSecs: 86_400 } as const;

/** The bump of `PAYOUT_AUTHORITY` (`PAYOUT_AUTHORITY_BUMP`). */
export const PAYOUT_AUTHORITY_BUMP = 251;

/** Anchor's discriminators, the first 8 bytes of `sha256("<kind>:<Name>")`, written from the vectors (checked against the hash in the tests). */
export const LOSS_COVER_DISCRIMINATORS = {
  /** `global:prepare` of the hook. */
  prepare: Buffer.from('799b9c5aa4fcdc6d', 'hex'),
  /** `global:record_payout` of the hook (`RECORD_PAYOUT_DISCRIMINATOR` in the companion). */
  recordPayout: Buffer.from('e3a4d53645ac1fd8', 'hex'),
  /** `global:set_entry` of the hook (its upgrade authority's repair of a record; the IDL's). */
  setEntry: Buffer.from('f057dd934db11852', 'hex'),
  /** `global:create_script_v2` of the companion. */
  createScriptV2: Buffer.from('7a06819e46bc4739', 'hex'),
  /** `account:LossCoverState`, `account:CoverState`, `account:PayoutTerms`. */
  lossCoverState: Buffer.from('d68f8042f062f31f', 'hex'),
  coverState: Buffer.from('6873a5f412db0801', 'hex'),
  payoutTerms: Buffer.from('fca4c3a22b268b07', 'hex'),
  /** `event:CoverRound` (the script's), `event:PayoutTermsSet` and `event:ScriptPayout` (the companion's). */
  coverRound: Buffer.from('90dd4233f2b16085', 'hex'),
  payoutTermsSet: Buffer.from('80244f11d752806a', 'hex'),
  scriptPayout: Buffer.from('525a19f79aed64cf', 'hex'),
} as const;

const u64 = (b: Buffer, at: number): bigint => b.readBigUInt64LE(at);
const i64 = (b: Buffer, at: number): number => Number(b.readBigInt64LE(at));
const u32 = (b: Buffer, at: number): number => b.readUInt32LE(at);
const u16 = (b: Buffer, at: number): number => b.readUInt16LE(at);
const key = (b: Buffer, at: number): PublicKey => new PublicKey(b.subarray(at, at + 32));
const wu64 = (b: Buffer, at: number, v: bigint): void => void b.writeBigUInt64LE(v, at);
const wi64 = (b: Buffer, at: number, v: number | bigint): void => void b.writeBigInt64LE(BigInt(v), at);
const wu32 = (b: Buffer, at: number, v: number): void => void b.writeUInt32LE(v, at);
const wu16 = (b: Buffer, at: number, v: number): void => void b.writeUInt16LE(v, at);
const wkey = (b: Buffer, at: number, k: PublicKey): void => void k.toBuffer().copy(b, at);

const big = (v: unknown): bigint => BigInt(String(v));
const num = (v: unknown): number => Number(String(v));

function expectDiscriminator(data: Buffer, disc: Buffer, what: string): void {
  if (data.length < 8 || !data.subarray(0, 8).equals(disc)) throw new Error(`not a ${what} account`);
}

// ---- the holding's record (the hook data) --------------------------------------------------------------

/** Where each field sits in a holding's 64 bytes of hook data (`record_offsets`). Integers are little-endian. */
export const LOSS_COVER_RECORD_OFFSETS = { version: 0, flags: 1, entry: 2, amount: 10, paid: 18, updatedSlot: 26, paidAt: 34, basisAt: 42, round: 50, reserved: 55 } as const;
/** `Record.leg` (§7.6.9): the leg of a holding’s first buy on a coin quoted in tokens, byte 54 (the programs’ vectors name the reserved bytes from 55). */
export const LOSS_COVER_RECORD_LEG_OFFSET = 54;

/** A holding's record as the hook keeps it. All zeros (never written, or cleared) is no record (`version` 0). */
export interface LossCoverRecord {
  /** 1; 0 means no record. */
  version: number;
  /** Bit 0 (`LOSS_COVER_FLAG_SOLD`): the holding sold or burned since its last buy. */
  flags: number;
  /** The average entry price: lamports per base unit times 10^12. */
  entry: bigint;
  /** The tokens the record covers (the balance as of the last write). */
  amount: bigint;
  /** Lamports of cover paid against this basis. */
  paid: bigint;
  /** The slot of the last write. */
  updatedSlot: bigint;
  /** When cover was last recorded (0: never). */
  paidAt: number;
  /** When a buy last blended the basis (0: none). */
  basisAt: number;
  /** The tag of the last `record_payout`: the round the script last measured or paid it in (0: none). */
  round: number;
  /**
   * On a coin quoted in tokens (docs/token-quotes.md §7.6.9): the leg of the holding's first buy, whose token its basis (`entry`, `paid`)
   * is kept in (byte 54, reserved before; 0 on every SOL coin's record). Absent reads as 0.
   */
  leg?: number;
}

/** No record. */
export const NO_LOSS_COVER_RECORD: Readonly<LossCoverRecord> = { version: 0, flags: 0, entry: 0n, amount: 0n, paid: 0n, updatedSlot: 0n, paidAt: 0, basisAt: 0, round: 0, leg: 0 };

/** A holding's hook data as a record (`Record::decode`). */
export function decodeLossCoverRecord(hookData: Uint8Array | readonly number[]): LossCoverRecord {
  const b = Buffer.from(hookData as ArrayLike<number>);
  if (b.length < LOSS_COVER_RECORD_LEN) throw new Error(`hook data is ${LOSS_COVER_RECORD_LEN} bytes`);
  const o = LOSS_COVER_RECORD_OFFSETS;
  return { version: b[o.version]!, flags: b[o.flags]!, entry: u64(b, o.entry), amount: u64(b, o.amount), paid: u64(b, o.paid), updatedSlot: u64(b, o.updatedSlot), paidAt: i64(b, o.paidAt), basisAt: i64(b, o.basisAt), round: u32(b, o.round), leg: b[LOSS_COVER_RECORD_LEG_OFFSET]! };
}

/** A record as hook data (`Record::encode`; the reserved bytes zero). */
export function encodeLossCoverRecord(r: LossCoverRecord): Buffer {
  const b = Buffer.alloc(LOSS_COVER_RECORD_LEN);
  const o = LOSS_COVER_RECORD_OFFSETS;
  b[o.version] = r.version;
  b[o.flags] = r.flags;
  wu64(b, o.entry, r.entry);
  wu64(b, o.amount, r.amount);
  wu64(b, o.paid, r.paid);
  wu64(b, o.updatedSlot, r.updatedSlot);
  wi64(b, o.paidAt, r.paidAt);
  wi64(b, o.basisAt, r.basisAt);
  wu32(b, o.round, r.round);
  b[LOSS_COVER_RECORD_LEG_OFFSET] = r.leg ?? 0;
  return b;
}

/** Whether the holding has a record (version 1). */
export const lossCoverRecordSet = (r: Pick<LossCoverRecord, 'version'>): boolean => r.version === 1;

// ---- the hook's state ----------------------------------------------------------------------------------

/** The hook's state for a mint (`LossCoverState` at `["state", mint]`, 274 bytes). */
export interface LossCoverState {
  version: number;
  bump: number;
  mint: PublicKey;
  /** The launch program's `["launch", mint]`: never holds a record. */
  launch: PublicKey;
  /** The launch pool, derived at `prepare` from the launchpad's config: never holds a record, and its sends are buys. */
  pool: PublicKey;
  /** The companion's `["creator", mint]`: never holds a record. */
  creator: PublicKey;
  /** A slow reference price (0 until set), and when it last moved. */
  reference: bigint;
  referenceAt: number;
  /** Lamports recorded by `record_payout`, and entries recorded (touches included). */
  paidTotal: bigint;
  records: bigint;
  preparedBy: PublicKey;
  preparedAt: number;
  /** On a coin quoted in tokens prepared with `prepare_legs` (§7.6.9): its legs, `reserved[0]` (byte 210); 0 on a SOL coin. `pool` is then leg 0's. */
  legCount?: number;
}

const S = { version: 8, bump: 9, mint: 10, launch: 42, pool: 74, creator: 106, reference: 138, referenceAt: 146, paidTotal: 154, records: 162, preparedBy: 170, preparedAt: 202, reserved: 210 } as const;

/** A `LossCoverState` account (its discriminator checked). */
export function decodeLossCoverState(data: Buffer): LossCoverState {
  expectDiscriminator(data, LOSS_COVER_DISCRIMINATORS.lossCoverState, 'LossCoverState');
  const r = CODERS.lossCoverHook.accounts.decode('lossCoverState', data) as Record<string, unknown>;
  return { version: num(r.version), bump: num(r.bump), mint: r.mint as PublicKey, launch: r.launch as PublicKey, pool: r.pool as PublicKey, creator: r.creator as PublicKey, reference: big(r.reference), referenceAt: num(r.referenceAt), paidTotal: big(r.paidTotal), records: big(r.records), preparedBy: r.preparedBy as PublicKey, preparedAt: num(r.preparedAt), legCount: data[S.reserved] ?? 0 };
}

/** A `LossCoverState` as the program serializes it (tests and fixtures). */
export function encodeLossCoverState(s: LossCoverState): Buffer {
  const b = Buffer.alloc(LOSS_COVER_STATE_LEN);
  LOSS_COVER_DISCRIMINATORS.lossCoverState.copy(b, 0);
  b[S.version] = s.version;
  b[S.bump] = s.bump;
  wkey(b, S.mint, s.mint);
  wkey(b, S.launch, s.launch);
  wkey(b, S.pool, s.pool);
  wkey(b, S.creator, s.creator);
  wu64(b, S.reference, s.reference);
  wi64(b, S.referenceAt, s.referenceAt);
  wu64(b, S.paidTotal, s.paidTotal);
  wu64(b, S.records, s.records);
  wkey(b, S.preparedBy, s.preparedBy);
  wi64(b, S.preparedAt, s.preparedAt);
  b[S.reserved] = s.legCount ?? 0;
  return b;
}

/** The owners that never hold a record, besides the default key and every address off the curve (`LossCoverState::excluded`). */
export const lossCoverExcluded = (s: Pick<LossCoverState, 'launch' | 'pool' | 'creator'>): PublicKey[] => [s.launch, s.pool, s.creator];

// ---- the script's terms and state ---------------------------------------------------------------------

/** The script's terms (`CoverTerms`, `companion_init`'s init data: Borsh, 34 bytes, in this order). */
export interface CoverTerms {
  /** The part of a loss the pot covers when it can, basis points (1,000 to 10,000). */
  coverBps: number;
  /** The least balance that counts, base units (at least 1). */
  minHolding: bigint;
  /** The least uncovered loss that counts, lamports (at least 1). */
  minLoss: bigint;
  /** How long after its last buy a holding waits before it counts, seconds (at most 30 days). */
  minAgeSecs: number;
  /** The round, seconds (a minute to a day): the companion's payout window must be the same. */
  roundSecs: number;
  /** The least the pot holds for a round to start, lamports (0: none; at most 100 SOL). */
  minPotLamports: bigint;
}

/** The terms as `companion_init` reads them. */
export function encodeCoverTerms(t: CoverTerms): Buffer {
  const b = Buffer.alloc(COVER_TERMS_LEN);
  wu16(b, 0, t.coverBps);
  wu64(b, 2, t.minHolding);
  wu64(b, 10, t.minLoss);
  wu32(b, 18, t.minAgeSecs);
  wu32(b, 22, t.roundSecs);
  wu64(b, 26, t.minPotLamports);
  return b;
}

export function decodeCoverTerms(data: Uint8Array): CoverTerms {
  const b = Buffer.from(data);
  if (b.length !== COVER_TERMS_LEN) throw new Error('the cover terms are 34 bytes');
  return { coverBps: u16(b, 0), minHolding: u64(b, 2), minLoss: u64(b, 10), minAgeSecs: u32(b, 18), roundSecs: u32(b, 22), minPotLamports: u64(b, 26) };
}

/** Whether the terms are within the script's bounds (`CoverTerms::valid`): `companion_init` refuses them otherwise (`BadTerms`). */
export function coverTermsValid(t: CoverTerms): boolean {
  const L = LOSS_COVER_LIMITS;
  return t.coverBps >= L.minCoverBps && t.coverBps <= L.maxCoverBps && t.minHolding >= 1n && t.minLoss >= 1n && t.minAgeSecs <= L.maxMinAgeSecs && t.roundSecs >= L.minRoundSecs && t.roundSecs <= L.maxRoundSecs && t.minPotLamports <= L.maxMinPotLamports;
}

/** Where each field sits in the script's state (`coverStateOffsets`). */
export const COVER_STATE_OFFSETS = { version: 8, mint: 9, coverBps: 41, minHolding: 43, minLoss: 51, minAgeSecs: 59, roundSecs: 63, minPotLamports: 67, round: 75, b: 79, lPrev: 87, lCur: 95, roundPaid: 103, measured: 111, rounds: 115, paidTotal: 119 } as const;

/** The script's state (`CoverState`, the companion's `["script-state", mint]`, 128 bytes): the terms, written once by `companion_init`, then the rounds. */
export interface CoverState extends CoverTerms {
  version: number;
  mint: PublicKey;
  /** The round of the last step (0 before the first). */
  round: number;
  /** The round's budget: the pot at its first step. */
  b: bigint;
  /** The uncovered loss measured over the previous round. */
  lPrev: bigint;
  /** Measured so far this round. */
  lCur: bigint;
  /** Paid so far this round. */
  roundPaid: bigint;
  /** Holdings measured this round. */
  measured: number;
  /** Rounds stepped so far. */
  rounds: number;
  /** Paid all time. */
  paidTotal: bigint;
}

/** A `CoverState` account (its discriminator checked). */
export function decodeCoverState(data: Buffer): CoverState {
  expectDiscriminator(data, LOSS_COVER_DISCRIMINATORS.coverState, 'CoverState');
  const r = CODERS.lossCoverScript.accounts.decode('coverState', data) as Record<string, unknown>;
  return { version: num(r.version), mint: r.mint as PublicKey, coverBps: num(r.coverBps), minHolding: big(r.minHolding), minLoss: big(r.minLoss), minAgeSecs: num(r.minAgeSecs), roundSecs: num(r.roundSecs), minPotLamports: big(r.minPotLamports), round: num(r.round), b: big(r.b), lPrev: big(r.lPrev), lCur: big(r.lCur), roundPaid: big(r.roundPaid), measured: num(r.measured), rounds: num(r.rounds), paidTotal: big(r.paidTotal) };
}

/** A `CoverState` as the program serializes it (tests and fixtures). */
export function encodeCoverState(s: CoverState): Buffer {
  const b = Buffer.alloc(COVER_STATE_LEN);
  LOSS_COVER_DISCRIMINATORS.coverState.copy(b, 0);
  const o = COVER_STATE_OFFSETS;
  b[o.version] = s.version;
  wkey(b, o.mint, s.mint);
  wu16(b, o.coverBps, s.coverBps);
  wu64(b, o.minHolding, s.minHolding);
  wu64(b, o.minLoss, s.minLoss);
  wu32(b, o.minAgeSecs, s.minAgeSecs);
  wu32(b, o.roundSecs, s.roundSecs);
  wu64(b, o.minPotLamports, s.minPotLamports);
  wu32(b, o.round, s.round);
  wu64(b, o.b, s.b);
  wu64(b, o.lPrev, s.lPrev);
  wu64(b, o.lCur, s.lCur);
  wu64(b, o.roundPaid, s.roundPaid);
  wu32(b, o.measured, s.measured);
  wu32(b, o.rounds, s.rounds);
  wu64(b, o.paidTotal, s.paidTotal);
  return b;
}

/** The terms a state holds (`CoverState::terms`). */
export const coverTermsOf = (s: CoverState): CoverTerms => ({ coverBps: s.coverBps, minHolding: s.minHolding, minLoss: s.minLoss, minAgeSecs: s.minAgeSecs, roundSecs: s.roundSecs, minPotLamports: s.minPotLamports });

// ---- the companion's payout terms ---------------------------------------------------------------------

/** `create_script_v2`'s payout terms: each share 1 to 10,000 basis points, the window 10 seconds to a day. */
export interface PayoutTermsArgs {
  /** The most one step pays, of the pot at the step's start. */
  stepBps: number;
  /** The most one holding gets of a step's budget. */
  holdingBps: number;
  /**
   * The most a window pays: `windowBps` of `max(windowPot, potAfterScript + windowPaid)` less
   * `windowPaid` (since the companion upgrade of 2026-10-15, `payoutStepBudget`; before it, of the
   * pot as it stood at the window's first step).
   */
  windowBps: number;
  /** The window: `floor(now / windowSecs)` (a round, or a day). */
  windowSecs: number;
}

/** Whether the terms are within the companion's bounds (`PayoutTermsArgs::valid`): `create_script_v2` refuses them otherwise (`BadPayoutTerms`). */
export function payoutTermsValid(t: PayoutTermsArgs): boolean {
  const share = (v: number): boolean => Number.isInteger(v) && v >= 1 && v <= 10_000;
  return share(t.stepBps) && share(t.holdingBps) && share(t.windowBps) && Number.isInteger(t.windowSecs) && t.windowSecs >= PAYOUT_LIMITS.minWindowSecs && t.windowSecs <= PAYOUT_LIMITS.maxWindowSecs;
}

/** The bounds a script companion's payouts keep within (`PayoutTerms`, `PDA(["payout-terms", mint])`, 128 bytes), with the companion's counters. */
export interface PayoutTerms extends PayoutTermsArgs {
  version: number;
  bump: number;
  mint: PublicKey;
  /** The window the counters are for (its first second), the pot at its first step after the script ran, and what it has paid. */
  windowStart: number;
  windowPot: bigint;
  windowPaid: bigint;
  /** Lamports paid to holders all time, entries recorded all time (touches included), when. */
  paidTotal: bigint;
  payouts: bigint;
  lastPaidAt: number;
  /** Whether the script may answer wallet payouts (`reserved[0]`, set before the launch by `companion.allowWalletPayouts`; false for every terms made before). */
  walletsAllowed: boolean;
}

/** `PayoutTerms.reserved[0]` once the launcher allowed wallet payouts (`WALLET_PAYOUTS_ALLOWED`). */
export const WALLET_PAYOUTS_ALLOWED = 1;

const T = { version: 8, bump: 9, mint: 10, stepBps: 42, holdingBps: 44, windowBps: 46, windowSecs: 48, windowStart: 52, windowPot: 60, windowPaid: 68, paidTotal: 76, payouts: 84, lastPaidAt: 92, reserved: 100 } as const;

/** A `PayoutTerms` account (its discriminator checked). */
export function decodePayoutTerms(data: Buffer): PayoutTerms {
  expectDiscriminator(data, LOSS_COVER_DISCRIMINATORS.payoutTerms, 'PayoutTerms');
  const r = CODERS.companion.accounts.decode('payoutTerms', data) as Record<string, unknown>;
  return { version: num(r.version), bump: num(r.bump), mint: r.mint as PublicKey, stepBps: num(r.stepBps), holdingBps: num(r.holdingBps), windowBps: num(r.windowBps), windowSecs: num(r.windowSecs), windowStart: num(r.windowStart), windowPot: big(r.windowPot), windowPaid: big(r.windowPaid), paidTotal: big(r.paidTotal), payouts: big(r.payouts), lastPaidAt: num(r.lastPaidAt), walletsAllowed: (r.reserved as number[])[0] === WALLET_PAYOUTS_ALLOWED };
}

/** A `PayoutTerms` as the program serializes it (tests and fixtures). */
export function encodePayoutTerms(t: PayoutTerms): Buffer {
  const b = Buffer.alloc(PAYOUT_TERMS_LEN);
  LOSS_COVER_DISCRIMINATORS.payoutTerms.copy(b, 0);
  b[T.version] = t.version;
  b[T.bump] = t.bump;
  wkey(b, T.mint, t.mint);
  wu16(b, T.stepBps, t.stepBps);
  wu16(b, T.holdingBps, t.holdingBps);
  wu16(b, T.windowBps, t.windowBps);
  wu32(b, T.windowSecs, t.windowSecs);
  wi64(b, T.windowStart, t.windowStart);
  wu64(b, T.windowPot, t.windowPot);
  wu64(b, T.windowPaid, t.windowPaid);
  wu64(b, T.paidTotal, t.paidTotal);
  wu64(b, T.payouts, t.payouts);
  wi64(b, T.lastPaidAt, t.lastPaidAt);
  b[T.reserved] = t.walletsAllowed ? WALLET_PAYOUTS_ALLOWED : 0;
  return b;
}

/** The first second of the window `now` falls in (`PayoutTerms::window_start_at`). */
export function payoutWindowStartAt(t: Pick<PayoutTerms, 'windowSecs'>, now: number): number {
  const secs = Math.max(1, t.windowSecs);
  return Math.floor(now / secs) * secs;
}

// ---- the answer -----------------------------------------------------------------------------------------

/** One entry of a script's payout answer: `account` an index into the step's remaining accounts (a holding of the launch's mint), `lamports` paid to its owner (0: a touch, recorded and not paid), `tag` the script's, passed to the hook untouched. */
export interface PayoutEntry {
  account: number;
  lamports: bigint;
  tag: number;
}

/** What a script's `companion_step` may return (`1 + 4 + 13 * n` bytes of Borsh, `n` at most `PAYOUT_LIMITS.maxPayoutsPerStep`). */
export interface PayoutAnswer {
  version: number;
  entries: PayoutEntry[];
}

/** The Borsh of an answer, as a script sets it in its return data. Throws over 16 entries. */
export function encodePayoutAnswer(answer: PayoutAnswer): Buffer {
  if (answer.entries.length > PAYOUT_LIMITS.maxPayoutsPerStep) throw new Error(`an answer carries at most ${PAYOUT_LIMITS.maxPayoutsPerStep} entries`);
  const b = Buffer.alloc(1 + 4 + 13 * answer.entries.length);
  b[0] = answer.version;
  wu32(b, 1, answer.entries.length);
  answer.entries.forEach((e, i) => {
    const at = 5 + 13 * i;
    b[at] = e.account;
    wu64(b, at + 1, e.lamports);
    wu32(b, at + 9, e.tag);
  });
  return b;
}

/** A script's wallet answer's version (2026-10-13): each entry names the account paid by its key. */
export const WALLET_PAYOUT_ANSWER_VERSION = 2;

/** One entry of a wallet answer: `to` the account paid (passed writable among the step's remaining accounts), `lamports`, `tag` (the script's, in the event). */
export interface WalletPayoutEntry {
  to: PublicKey;
  lamports: bigint;
  tag: number;
}

/**
 * The Borsh of a wallet answer (`1 + 4 + 44 * n` bytes), as a script sets it in its return data: the
 * companion pays each `to` SOL within the script's payout terms, when its launcher allowed wallet
 * payouts (`companion.allowWalletPayouts`). Throws over 16 entries.
 */
export function encodeWalletPayoutAnswer(entries: WalletPayoutEntry[]): Buffer {
  if (entries.length > PAYOUT_LIMITS.maxPayoutsPerStep) throw new Error(`an answer carries at most ${PAYOUT_LIMITS.maxPayoutsPerStep} entries`);
  const b = Buffer.alloc(1 + 4 + 44 * entries.length);
  b[0] = WALLET_PAYOUT_ANSWER_VERSION;
  wu32(b, 1, entries.length);
  entries.forEach((e, i) => {
    const at = 5 + 44 * i;
    e.to.toBuffer().copy(b, at);
    wu64(b, at + 32, e.lamports);
    wu32(b, at + 40, e.tag);
  });
  return b;
}

/** An answer from its Borsh, exactly as the companion reads it (`decode_answer`): version 1, at most 16 entries, not a byte short or over; throws otherwise (`BadPayoutAnswer`). */
export function decodePayoutAnswer(data: Uint8Array): PayoutAnswer {
  const b = Buffer.from(data);
  if (b.length < 5) throw new Error('BadPayoutAnswer');
  const n = u32(b, 1);
  if (b.length !== 5 + 13 * n || b[0] !== PAYOUT_LIMITS.answerVersion || n > PAYOUT_LIMITS.maxPayoutsPerStep) throw new Error('BadPayoutAnswer');
  const entries: PayoutEntry[] = [];
  for (let i = 0; i < n; i += 1) {
    const at = 5 + 13 * i;
    entries.push({ account: b[at]!, lamports: u64(b, at + 1), tag: u32(b, at + 9) });
  }
  return { version: b[0]!, entries };
}

/** A wallet answer (`WALLET_PAYOUT_ANSWER_VERSION`). */
export interface WalletPayoutAnswer {
  version: typeof WALLET_PAYOUT_ANSWER_VERSION;
  entries: WalletPayoutEntry[];
}

/** A wallet answer from its Borsh, exactly as the companion reads it: version 2, at most 16 entries, not a byte short or over; throws otherwise (`BadPayoutAnswer`). */
export function decodeWalletPayoutAnswer(data: Uint8Array): WalletPayoutAnswer {
  const b = Buffer.from(data);
  if (b.length < 5) throw new Error('BadPayoutAnswer');
  const n = u32(b, 1);
  if (b.length !== 5 + 44 * n || b[0] !== WALLET_PAYOUT_ANSWER_VERSION || n > PAYOUT_LIMITS.maxPayoutsPerStep) throw new Error('BadPayoutAnswer');
  const entries: WalletPayoutEntry[] = [];
  for (let i = 0; i < n; i += 1) {
    const at = 5 + 44 * i;
    entries.push({ to: new PublicKey(b.subarray(at, at + 32)), lamports: u64(b, at + 32), tag: u32(b, at + 40) });
  }
  return { version: WALLET_PAYOUT_ANSWER_VERSION, entries };
}

/** A script's answer by its first byte, as the companion reads it (`decode_script_answer`): a wallet answer (2), an answer in the legs' tokens (3, §7.6.9), else a holdings answer (1); throws otherwise (`BadPayoutAnswer`). */
export function decodeScriptAnswer(data: Uint8Array): PayoutAnswer | WalletPayoutAnswer | PayoutAnswerLegs {
  if (data[0] === PAYOUT_ANSWER_LEGS_VERSION) return decodePayoutAnswerLegs(data);
  return data[0] === WALLET_PAYOUT_ANSWER_VERSION ? decodeWalletPayoutAnswer(data) : decodePayoutAnswer(data);
}

// ---- coins quoted in tokens (docs/token-quotes.md §7.6.9) ----------------------------------------------------

/** `PayoutAnswer.version` of a script's payouts in the legs' tokens (`PAYOUT_ANSWER_LEGS_VERSION`): each entry names its leg. */
export const PAYOUT_ANSWER_LEGS_VERSION = 3;

/** One entry of an answer in the legs' tokens (`PayoutEntryLegs`, 14 bytes): `amount` raw units of leg `leg`'s token, paid to the holding's owner's associated token account of it. */
export interface PayoutEntryLegs {
  account: number;
  amount: bigint;
  tag: number;
  leg: number;
}

/** A script's payouts on a coin quoted in tokens (`PayoutAnswerLegs`, `1 + 4 + 14 * n` bytes of Borsh). */
export interface PayoutAnswerLegs {
  version: typeof PAYOUT_ANSWER_LEGS_VERSION;
  entries: PayoutEntryLegs[];
}

/** The Borsh of an answer in the legs' tokens, as `loss_cover_script` returns it (`CoverAnswer::Legs`). Throws over 16 entries. */
export function encodePayoutAnswerLegs(entries: readonly PayoutEntryLegs[]): Buffer {
  if (entries.length > PAYOUT_LIMITS.maxPayoutsPerStep) throw new Error(`an answer carries at most ${PAYOUT_LIMITS.maxPayoutsPerStep} entries`);
  const b = Buffer.alloc(1 + 4 + 14 * entries.length);
  b[0] = PAYOUT_ANSWER_LEGS_VERSION;
  wu32(b, 1, entries.length);
  entries.forEach((e, i) => {
    const at = 5 + 14 * i;
    b[at] = e.account;
    wu64(b, at + 1, e.amount);
    wu32(b, at + 9, e.tag);
    b[at + 13] = e.leg;
  });
  return b;
}

/** An answer in the legs' tokens from its Borsh: version 3, at most 16 entries, not a byte short or over; throws otherwise (`BadPayoutAnswer`). */
export function decodePayoutAnswerLegs(data: Uint8Array): PayoutAnswerLegs {
  const b = Buffer.from(data);
  if (b.length < 5) throw new Error('BadPayoutAnswer');
  const n = u32(b, 1);
  if (b.length !== 5 + 14 * n || b[0] !== PAYOUT_ANSWER_LEGS_VERSION || n > PAYOUT_LIMITS.maxPayoutsPerStep) throw new Error('BadPayoutAnswer');
  const entries: PayoutEntryLegs[] = [];
  for (let i = 0; i < n; i += 1) {
    const at = 5 + 14 * i;
    entries.push({ account: b[at]!, amount: u64(b, at + 1), tag: u32(b, at + 9), leg: b[at + 13]! });
  }
  return { version: PAYOUT_ANSWER_LEGS_VERSION, entries };
}

/** The script's state on a coin quoted in tokens (`STATE_LEN_LEGS`): the SOL state's 128 bytes, then a `LegRound` per leg at 128 + 36·i. */
export const COVER_STATE_LEN_LEGS = 384;
const LEG_ROUNDS_AT = 128;
const LEG_ROUND_LEN = 36;

/** One leg's round on a coin quoted in tokens (`LegRound`), raw units of the leg's token. */
export interface CoverLegRound {
  /** The leg's budget: its pot at the round's first step. */
  b: bigint;
  /** The uncovered loss measured on the leg over the round before. */
  lPrev: bigint;
  lCur: bigint;
  roundPaid: bigint;
  measured: number;
}

/** The first `count` legs' rounds from the script's state data (zeros past its end, as `LegRound::read`). */
export function decodeCoverLegRounds(data: Uint8Array, count: number): CoverLegRound[] {
  const b = Buffer.from(data);
  const at = (i: number, o: number, w: number): bigint | number => {
    const p = LEG_ROUNDS_AT + LEG_ROUND_LEN * i + o;
    if (p + w > b.length) return w === 8 ? 0n : 0;
    return w === 8 ? b.readBigUInt64LE(p) : b.readUInt32LE(p);
  };
  return Array.from({ length: Math.max(0, Math.min(count, 6)) }, (_, i) => ({ b: at(i, 0, 8) as bigint, lPrev: at(i, 8, 8) as bigint, lCur: at(i, 16, 8) as bigint, roundPaid: at(i, 24, 8) as bigint, measured: at(i, 32, 4) as number }));
}

/**
 * The legs' rounds as a step at `now` reads them (`step_legs`' roll): in a later round than the state's, each leg's `lPrev` is its
 * `lCur` (0 when a round was skipped), its budget `b` the leg's pot now (`pots`, the companion's `CompanionLegs` in leg order), the
 * rest 0; in the state's round, as stored.
 */
export function lossCoverLegRoundsAt(s: Pick<CoverState, 'round' | 'roundSecs'>, rounds: readonly CoverLegRound[], pots: readonly bigint[], now: number): CoverLegRound[] {
  const r = s.roundSecs > 0 ? Math.floor(now / s.roundSecs) : 0;
  if (r <= s.round) return rounds.map((lr) => ({ ...lr }));
  const consecutive = r === s.round + 1;
  return rounds.map((lr, i) => ({ b: pots[i] ?? 0n, lPrev: consecutive ? lr.lCur : 0n, lCur: 0n, roundPaid: 0n, measured: 0 }));
}

/** Whether a Lossback step on a coin quoted in tokens may pay now: a leg with a loss measured the round before and budget left. */
export const lossCoverLegsPaying = (rounds: readonly CoverLegRound[]): boolean => rounds.some((lr) => lr.lPrev > 0n && lr.b > lr.roundPaid);

/** The least uncovered loss that counts on a coin quoted in tokens (`min_loss_of_cost`): `minLossBps` (at most all) of the holding's cost `entry × balance / 10^12`, at least 1. */
export function lossCoverMinLossOfCost(entry: bigint, balance: bigint, minLossBps: bigint | number): bigint {
  const cost = (entry * balance) / LOSS_COVER_PRICE_SCALE;
  const bps = BigInt(minLossBps) > 10_000n ? 10_000n : BigInt(minLossBps);
  const min = (cost * bps) / 10_000n;
  return min > 0n ? min : 1n;
}

/** `CoverRoundLeg`: a leg's round rolled on a coin quoted in tokens (the script's event). */
export interface CoverRoundLegEvent {
  mint: PublicKey;
  round: number;
  leg: number;
  b: bigint;
  lPrev: bigint;
}

/** A `CoverRoundLeg` event's body (after its discriminator). */
export function decodeCoverRoundLegEvent(body: Buffer): CoverRoundLegEvent {
  if (body.length < 32 + 4 + 1 + 16) throw new Error('not a CoverRoundLeg event');
  return { mint: key(body, 0), round: u32(body, 32), leg: body[36]!, b: u64(body, 37), lPrev: u64(body, 45) };
}

/** The site's least loss on a coin quoted in tokens: 50 basis points of the holding's cost (§7.6.9). */
export const TOKEN_LOSS_COVER_MIN_LOSS_BPS = 50;

// ---- events ---------------------------------------------------------------------------------------------

/** `ScriptPayout`: one entry of an answer, paid and recorded. */
export interface ScriptPayoutEvent {
  companion: PublicKey;
  program: PublicKey;
  holding: PublicKey;
  owner: PublicKey;
  /** Paid to the holding's owner as SOL (0: a touch, recorded alone). */
  lamports: bigint;
  tag: number;
  /** What the window has paid so far, this entry included; what the terms have paid all time; the pot after the step. */
  windowPaid: bigint;
  paidTotal: bigint;
  potAfter: bigint;
}

/** `PayoutTermsSet`: `create_script_v2` wrote the terms, or `set_payout_terms` (2026-10-15) replaced them. */
export interface PayoutTermsSetEvent {
  companion: PublicKey;
  mint: PublicKey;
  terms: PublicKey;
  stepBps: number;
  holdingBps: number;
  windowBps: number;
  windowSecs: number;
}

/** `CoverRound`: the script rolled a round. */
export interface CoverRoundEvent {
  mint: PublicKey;
  round: number;
  b: bigint;
  lPrev: bigint;
}

/** A `ScriptPayout` event's body (after its discriminator). */
export function decodeScriptPayoutEvent(body: Buffer): ScriptPayoutEvent {
  if (body.length < 4 * 32 + 8 + 4 + 3 * 8) throw new Error('not a ScriptPayout event');
  return { companion: key(body, 0), program: key(body, 32), holding: key(body, 64), owner: key(body, 96), lamports: u64(body, 128), tag: u32(body, 136), windowPaid: u64(body, 140), paidTotal: u64(body, 148), potAfter: u64(body, 156) };
}

/** A `PayoutTermsSet` event's body. */
export function decodePayoutTermsSetEvent(body: Buffer): PayoutTermsSetEvent {
  if (body.length < 3 * 32 + 3 * 2 + 4) throw new Error('not a PayoutTermsSet event');
  return { companion: key(body, 0), mint: key(body, 32), terms: key(body, 64), stepBps: u16(body, 96), holdingBps: u16(body, 98), windowBps: u16(body, 100), windowSecs: u32(body, 102) };
}

/** A `CoverRound` event's body. */
export function decodeCoverRoundEvent(body: Buffer): CoverRoundEvent {
  if (body.length < 32 + 4 + 16) throw new Error('not a CoverRound event');
  return { mint: key(body, 0), round: u32(body, 32), b: u64(body, 36), lPrev: u64(body, 44) };
}

/**
 * The companion's payout events as `eventsOf` names and shapes them (`DecodedEvent.data`: pubkeys
 * as base58, 64-bit integers as decimal strings, smaller ones as numbers), read by discriminator
 * from a payload that starts with it; null for any other payload. The coder reads them first
 * (the companion's IDL carries them); this is the fallback for a coder built from an older IDL.
 */
export function decodeCompanionPayoutEvent(payload: Buffer): { name: 'scriptPayout' | 'payoutTermsSet'; data: Record<string, unknown> } | null {
  if (payload.length < 8) return null;
  const disc = payload.subarray(0, 8);
  const body = payload.subarray(8);
  try {
    if (disc.equals(LOSS_COVER_DISCRIMINATORS.scriptPayout)) {
      const e = decodeScriptPayoutEvent(body);
      return { name: 'scriptPayout', data: { companion: e.companion.toBase58(), program: e.program.toBase58(), holding: e.holding.toBase58(), owner: e.owner.toBase58(), lamports: e.lamports.toString(), tag: e.tag, windowPaid: e.windowPaid.toString(), paidTotal: e.paidTotal.toString(), potAfter: e.potAfter.toString() } };
    }
    if (disc.equals(LOSS_COVER_DISCRIMINATORS.payoutTermsSet)) {
      const e = decodePayoutTermsSetEvent(body);
      return { name: 'payoutTermsSet', data: { companion: e.companion.toBase58(), mint: e.mint.toBase58(), terms: e.terms.toBase58(), stepBps: e.stepBps, holdingBps: e.holdingBps, windowBps: e.windowBps, windowSecs: e.windowSecs } };
    }
  } catch {
    return null;
  }
  return null;
}

// ---- the math ------------------------------------------------------------------------------------------

/** A pool's reserves as the hook and the script read them. */
export interface LossCoverPool {
  baseReserve: bigint;
  quoteReserve: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
}

/** The pool's spot (`spot_of`): its quote side over its base side, real and virtual, times 10^12; null without a base side. */
export function lossCoverSpot(p: LossCoverPool): bigint | null {
  const base = p.baseReserve + p.virtualBase;
  if (base <= 0n) return null;
  return saturate64(((p.quoteReserve + p.virtualQuote) * LOSS_COVER_PRICE_SCALE) / base);
}

/** The curve price of a buy that delivered `amount`, read from the pool after the trade (`trade_price`): `Q' * 10^12 / (B' + a)`, fees aside. */
export function lossCoverTradePrice(p: LossCoverPool, amount: bigint): bigint | null {
  const base = p.baseReserve + p.virtualBase + amount;
  if (base <= 0n) return null;
  return saturate64(((p.quoteReserve + p.virtualQuote) * LOSS_COVER_PRICE_SCALE) / base);
}

const U64_MAX = (1n << 64n) - 1n;
const saturate64 = (v: bigint): bigint => (v > U64_MAX ? U64_MAX : v);

/** `price`, at most `entryCapBps` above `reference` when the reference is set (`capped`): the first version's rule for a buy's entry, no longer applied (a buy's entry is `lossCoverTradePrice`); kept for the records that version wrote. */
export function lossCoverCapped(price: bigint, reference: bigint): bigint {
  if (reference === 0n) return price;
  const cap = saturate64((reference * BigInt(10_000 + LOSS_COVER_LIMITS.entryCapBps)) / 10_000n);
  return price < cap ? price : cap;
}

/** `reference` moved toward `spot` by at most `referenceStepBps` of itself, all the way when unset (`step_toward`). */
export function lossCoverStepToward(reference: bigint, spot: bigint): bigint {
  if (reference === 0n) return spot;
  const step = (reference * BigInt(LOSS_COVER_LIMITS.referenceStepBps)) / 10_000n;
  if (spot > reference) {
    const up = saturate64(reference + step);
    return spot < up ? spot : up;
  }
  const down = reference - step;
  return spot > down ? spot : down;
}

/** `part` basis points of `amount`, rounded down (`bps_of`). */
export const bpsOf = (amount: bigint, bps: number | bigint): bigint => (amount * BigInt(bps)) / 10_000n;

/**
 * What a holding under water is owed, as a step computes it (`uncovered_loss`): `loss = (entry -
 * spot) * balance / 10^12` lamports, `covered = loss * coverBps / 10,000`, `uncovered = covered -
 * paid` (0 when nothing, or the holding is not under water).
 */
export function lossCoverUncovered(entry: bigint, spot: bigint, balance: bigint, coverBps: number, paid: bigint): bigint {
  if (entry <= spot) return 0n;
  const loss = ((entry - spot) * balance) / LOSS_COVER_PRICE_SCALE;
  const covered = (loss * BigInt(coverBps)) / 10_000n;
  return covered > paid ? saturate64(covered - paid) : 0n;
}

/** The loss and the covered part the same way, for the site's figures (`loss` is 0 above water). */
export function lossCoverLoss(entry: bigint, spot: bigint, balance: bigint, coverBps: number): { loss: bigint; covered: bigint } {
  if (entry <= spot) return { loss: 0n, covered: 0n };
  const loss = ((entry - spot) * balance) / LOSS_COVER_PRICE_SCALE;
  return { loss, covered: (loss * BigInt(coverBps)) / 10_000n };
}

/** What a holding owed `uncovered` is paid in a round of budget `b` that measured `lPrev` the round before (`fraction_of`): `min(uncovered * b / lPrev, uncovered)`, 0 in a round that measures only. */
export function lossCoverFraction(uncovered: bigint, b: bigint, lPrev: bigint): bigint {
  if (lPrev === 0n) return 0n;
  const pay = (uncovered * b) / lPrev;
  return pay < uncovered ? pay : uncovered;
}

/** The share of its uncovered loss each holder is paid this round, basis points: `min(10,000, b / lPrev)`; 0 in a measuring round. */
export function lossCoverRoundShareBps(b: bigint, lPrev: bigint): number {
  if (lPrev === 0n) return 0;
  const bps = (b * 10_000n) / lPrev;
  return bps > 10_000n ? 10_000 : Number(bps);
}

/** What a step earns its sender (`bounty_for`): the flat `SCRIPT_LIMITS.bounty` without an answer; with an answer of `n` entries, `bounty * min(n, 8) / 8`. */
export function payoutBountyFor(entries: number | null): bigint {
  if (entries === null) return SCRIPT_LIMITS.bounty;
  const n = BigInt(Math.min(entries, PAYOUT_LIMITS.bountyFull));
  return (SCRIPT_LIMITS.bounty * n) / BigInt(PAYOUT_LIMITS.bountyFull);
}

/**
 * The most a step may pay in all (`step_budget`): `stepBps` of the pot at the step's start, what
 * the window may still pay, and the pot after the script ran less the bounty. The holding cap is
 * `holdingBps` of it. Since the companion upgrade of 2026-10-15 the window is measured against the
 * pot as it stands (`potAfterScript + windowPaid`, the pot as if nothing had been paid this window,
 * so fees arriving mid-window count), never below the pot at the window's first step (`windowPot`).
 */
export function payoutStepBudget(potBefore: bigint, potAfterScript: bigint, bounty: bigint, windowPot: bigint, windowPaid: bigint, stepBps: number, windowBps: number): bigint {
  const live = potAfterScript + windowPaid;
  const window = bpsOf(live > windowPot ? live : windowPot, windowBps);
  const left = window > windowPaid ? window - windowPaid : 0n;
  const after = potAfterScript > bounty ? potAfterScript - bounty : 0n;
  const step = bpsOf(potBefore, stepBps);
  return [step, left, after].reduce((m, v) => (v < m ? v : m));
}

// ---- a round, and one holding's standing -------------------------------------------------------------

/** The round `now` falls in (`floor(now / roundSecs)`, the game standard's arithmetic). */
export const lossCoverRoundOf = (now: number, roundSecs: number): number => roundOf(now, roundSecs);

/** A round as the script sees it at a step: the state's, or the state as the step's first act would roll it. */
export interface LossCoverRoundView {
  round: number;
  b: bigint;
  lPrev: bigint;
  lCur: bigint;
  roundPaid: bigint;
  /** The step would roll the round (the clock's round is past the state's). */
  rolls: boolean;
  /** A round that measures only (`lPrev` 0): every entry is a touch. */
  measuring: boolean;
  /** The share each holder is paid of its uncovered loss, basis points. */
  shareBps: number;
  /** Whether the pot holds the least a round starts with (a step answers `NothingToDo` otherwise while the round is due to roll). */
  potEnough: boolean;
  /** When the current round began and ends. */
  startsAt: number;
  endsAt: number;
}

/**
 * The round a step at `now` works in (`companion_step`'s first act): the state's when the clock is
 * still in it; else rolled, `lPrev` the loss measured over the previous round only when that round
 * is the one just before, `b` the pot as the step reads it, nothing paid or measured yet.
 */
export function lossCoverRoundView(s: Pick<CoverState, 'round' | 'b' | 'lPrev' | 'lCur' | 'roundPaid' | 'roundSecs' | 'minPotLamports'>, now: number, pot: bigint): LossCoverRoundView {
  const r = roundOf(now, s.roundSecs);
  const rolls = r > s.round;
  const lPrev = rolls ? (r === s.round + 1 ? s.lCur : 0n) : s.lPrev;
  const b = rolls ? pot : s.b;
  const view = { round: r, b, lPrev, lCur: rolls ? 0n : s.lCur, roundPaid: rolls ? 0n : s.roundPaid, rolls, measuring: lPrev === 0n, shareBps: lossCoverRoundShareBps(b, lPrev), potEnough: !rolls || pot >= s.minPotLamports, startsAt: roundStart(r, s.roundSecs), endsAt: roundEnd(r, s.roundSecs) };
  return view;
}

/** Why a step would not take a holding now, in the script's order. */
export type LossCoverSkip = 'excluded' | 'noRecord' | 'recordStale' | 'recordedThisRound' | 'belowMinHolding' | 'tooYoung' | 'aboveWater' | 'belowMinLoss';

/** A holding as `lossCoverOwed` reads it: its owner, its balance and its record (the hook data decoded). */
export interface LossCoverHolding {
  owner: PublicKey;
  amount: bigint;
  record: LossCoverRecord;
}

/** One holding's standing at a step (`lossCoverOwed`). */
export interface LossCoverOwed {
  /** The round the step works in. */
  round: number;
  /** Lamports the holding is down (0 above water), the part the cover applies to, what it is still owed. */
  loss: bigint;
  covered: bigint;
  uncovered: bigint;
  /** What a step would pay it now: its share of its uncovered loss, within what the round's budget has left (the companion's step budget binds after). 0 in a measuring round. */
  pay: bigint;
  /** Whether a step would take it (measure it, and pay it when `pay` is above 0). */
  eligible: boolean;
  skip: LossCoverSkip | null;
}

/**
 * What a holding is owed and would be paid at a step now, as `companion_step` computes it (3.3 of
 * the design): the owner not excluded (the launch, the pool, the companion address, the beneficiary,
 * the default key, an address off the curve), a record of version 1 covering the whole balance,
 * not yet measured this round, above the least holding, old enough, under water by at least the
 * least loss; then `pay = min(uncovered * b / lPrev, uncovered, b - roundPaid)`. The round is
 * `lossCoverRoundView`'s (the state's, or as the step would roll it).
 */
export function lossCoverOwed(h: LossCoverHolding, spot: bigint, terms: CoverTerms, view: Pick<LossCoverRoundView, 'round' | 'b' | 'lPrev' | 'roundPaid'>, now: number, excluded: readonly PublicKey[] = []): LossCoverOwed {
  const { loss, covered } = lossCoverLoss(h.record.entry, spot, h.amount, terms.coverBps);
  const uncovered = lossCoverRecordSet(h.record) ? lossCoverUncovered(h.record.entry, spot, h.amount, terms.coverBps, h.record.paid) : 0n;
  const out = (skip: LossCoverSkip): LossCoverOwed => ({ round: view.round, loss, covered, uncovered, pay: 0n, eligible: false, skip });
  if (h.owner.equals(PublicKey.default) || !PublicKey.isOnCurve(h.owner.toBytes()) || excluded.some((k) => k.equals(h.owner))) return out('excluded');
  if (!lossCoverRecordSet(h.record)) return out('noRecord');
  if (h.record.amount !== h.amount) return out('recordStale');
  if (h.record.round === view.round) return out('recordedThisRound');
  if (h.amount < terms.minHolding) return out('belowMinHolding');
  if (now - h.record.basisAt < terms.minAgeSecs) return out('tooYoung');
  if (uncovered === 0n) return out('aboveWater');
  if (uncovered < terms.minLoss) return out('belowMinLoss');
  const left = view.b > view.roundPaid ? view.b - view.roundPaid : 0n;
  const fraction = lossCoverFraction(uncovered, view.b, view.lPrev);
  return { round: view.round, loss, covered, uncovered, pay: fraction < left ? fraction : left, eligible: true, skip: null };
}

// ---- builders -------------------------------------------------------------------------------------------

/** A coin quoted in tokens' `Legs` (the launchpad's `["legs", mint]`; `legsAddress` in legs.ts, kept here so this module needs no other). */
const lossCoverLegsAddress = (mint: PublicKey): PublicKey => PublicKey.findProgramAddressSync([Buffer.from('legs'), mint.toBuffer()], a.LAUNCH_PROGRAM)[0];

/** The launchpad's `["config"]`, read by `prepare` for the launch pools' LP fee. */
const LAUNCH_CONFIG_ADDRESS = a.LAUNCH_CONFIG;

/** The hook's ProgramData (`FndUwN…`), whose header names its upgrade authority: the one signer of `set_entry` (`PROGRAM_DATA`). */
export const LOSS_COVER_HOOK_PROGRAM_DATA = a.programDataAddress(a.LOSS_COVER_HOOK_PROGRAM);

export const lossCoverHook = {
  /**
   * `prepare` for `mint` (not created yet; its keypair signs), `payer` paying the rent: the state at
   * `["state", mint]` and the registry listing the state (w), the launch (r) and the pool (r; its
   * address follows from the launchpad's config's LP fee). Once per mint, before the launch.
   */
  prepare(payer: PublicKey, mint: PublicKey): TransactionInstruction {
    const keys = [rw(payer, true), ro(mint, true), rw(a.lossCoverStateAddress(mint)), rw(a.lossCoverRegistryAddress(mint)), ro(LAUNCH_CONFIG_ADDRESS), ro(a.SYSTEM_PROGRAM), ro(a.LOSS_COVER_EVENT_AUTHORITY), ro(a.LOSS_COVER_HOOK_PROGRAM)];
    return new TransactionInstruction({ programId: a.LOSS_COVER_HOOK_PROGRAM, keys, data: CODERS.lossCoverHook.instruction.encode('prepare', {}) });
  },
  /** The registry's extras for a prepared mint, in its order, without reading it (`loss_cover_hook::client::extras`): the state (w), the launch (r), the pool at `lpFeeBps` (r). */
  extras(mint: PublicKey, lpFeeBps: number): AccountMeta[] {
    return [rw(a.lossCoverStateAddress(mint)), ro(a.launchAddress(mint)), ro(a.launchPoolAddress(mint, a.BRIDGED_SOL_MINT, lpFeeBps))];
  },
  /** The hook's accounts for a prepared mint (`LaunchKeys.customHook`): the program with `extras`. */
  accounts(mint: PublicKey, lpFeeBps: number): CustomHookAccounts {
    return { program: a.LOSS_COVER_HOOK_PROGRAM, extras: lossCoverHook.extras(mint, lpFeeBps) };
  },
  /**
   * `prepare_legs()` for a coin quoted in tokens (docs/token-quotes.md §7.6.9; `loss_cover_hook::client::prepare_legs`): `prepare`'s
   * accounts (the mint signing), then the legs' pools in leg order (1 to 6; written, not read: they need not exist yet). The state's
   * `pool` is leg 0's, `reserved[0]` the count; the registry is `extrasLegs`.
   */
  prepareLegs(payer: PublicKey, mint: PublicKey, pools: readonly PublicKey[]): TransactionInstruction {
    if (pools.length < 1 || pools.length > 6) throw new Error('a coin quoted in tokens has 1 to 6 legs');
    const ix = lossCoverHook.prepare(payer, mint);
    ix.data = CODERS.lossCoverHook.instruction.encode('prepareLegs', {});
    ix.keys.push(...pools.map((p) => ro(p)));
    return ix;
  },
  /** The registry's extras of a coin prepared with `prepareLegs(pools)` (`extras_legs`): the state (w), the launch, leg 0's pool, the coin's `Legs`, the other legs' pools. */
  extrasLegs(mint: PublicKey, pools: readonly PublicKey[]): AccountMeta[] {
    if (pools.length < 1) throw new Error('a coin quoted in tokens has a leg at least');
    return [rw(a.lossCoverStateAddress(mint)), ro(a.launchAddress(mint)), ro(pools[0]!), ro(lossCoverLegsAddress(mint)), ...pools.slice(1).map((p) => ro(p))];
  },
  /** The hook's accounts for a coin quoted in tokens (`LaunchKeys.customHook`). */
  accountsLegs(mint: PublicKey, pools: readonly PublicKey[]): CustomHookAccounts {
    return { program: a.LOSS_COVER_HOOK_PROGRAM, extras: lossCoverHook.extrasLegs(mint, pools) };
  },
  /**
   * `record_payout(lamports, tag)` for `owner`'s holding of `mint`, exactly as the companion builds
   * and signs it inside `script_step` (the reference; never sent on its own: only the companion
   * signs for the payout authority).
   */
  recordPayout(mint: PublicKey, owner: PublicKey, lamports: bigint, tag: number): TransactionInstruction {
    const data = CODERS.lossCoverHook.instruction.encode('recordPayout', { lamports: new BN(lamports.toString()), tag });
    const keys = [ro(a.PAYOUT_AUTHORITY, true), ro(mint), rw(a.holdingAddress(mint, owner)), rw(a.lossCoverStateAddress(mint)), ro(a.LOSS_COVER_HOOK_AUTHORITY), ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY)];
    return new TransactionInstruction({ programId: a.LOSS_COVER_HOOK_PROGRAM, keys, data });
  },
  /**
   * `set_entry(entry)` for `owner`'s holding of `mint`, signed by `authority`: the hook's upgrade
   * authority as its ProgramData names it (anyone else is refused, `NotUpgradeAuthority`). Sets the
   * holding's recorded entry (lamports per base unit times `LOSS_COVER_PRICE_SCALE`, above 0) and
   * nothing else: the balance, the cover paid, the round and the basis time stay. The repair of a
   * record the first version wrote capped (`loss_cover_hook::client::set_entry`); the program
   * refuses a holding with no record or an owner that holds none.
   */
  setEntry(authority: PublicKey, mint: PublicKey, owner: PublicKey, entry: bigint): TransactionInstruction {
    if (entry <= 0n || entry > U64_MAX) throw new Error('an entry is a u64 above 0');
    const data = CODERS.lossCoverHook.instruction.encode('setEntry', { entry: new BN(entry.toString()) });
    const keys = [ro(authority, true), ro(LOSS_COVER_HOOK_PROGRAM_DATA), ro(mint), rw(a.holdingAddress(mint, owner)), ro(a.lossCoverStateAddress(mint)), ro(a.LOSS_COVER_HOOK_AUTHORITY), ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY)];
    return new TransactionInstruction({ programId: a.LOSS_COVER_HOOK_PROGRAM, keys, data });
  },
};

/** The terms of a Lossback coin as its setup sends them: the script's six and the companion's four, the step as the script's interval. */
export interface LossCoverSetupTerms extends CoverTerms {
  stepSecs: number;
  stepBps: number;
  holdingBps: number;
  roundBps: number;
}

/**
 * `create_script_v2`'s two arguments for a Lossback coin: the Loss cover script with the split and
 * the pot's part, stepping every `stepSecs`, a 128-byte state, the six terms as init data; the
 * payout terms with the round as the window.
 */
export function lossCoverScriptArgs(split: CompanionSplit, potBps: number, t: LossCoverSetupTerms): { args: ScriptArgs; payout: PayoutTermsArgs } {
  return {
    args: { split, potBps, program: a.LOSS_COVER_SCRIPT_PROGRAM, interval: t.stepSecs, stateLen: COVER_STATE_LEN, initData: Uint8Array.from(encodeCoverTerms(t)) },
    payout: { stepBps: t.stepBps, holdingBps: t.holdingBps, windowBps: t.roundBps, windowSecs: t.roundSecs },
  };
}

/** A candidate a step carries: its holding (writable: the hook records into it) and, when it may be paid, its owner (writable). */
export interface LossCoverCandidate {
  holding: PublicKey;
  owner: PublicKey | null;
}

/**
 * The accounts a Lossback step takes after the companion's six (3.3 of the design), as
 * `companion.scriptStep`'s `extra`: the payout accounts (the terms, the hook, the payout authority,
 * the hook's state and authority, the token program and its event authority), then the candidates.
 * No swap accounts: this script never trades. The SDK appends the holding and unwrap accounts.
 */
export function lossCoverStepExtras(mint: PublicKey, candidates: readonly LossCoverCandidate[]): AccountMeta[] {
  return [...companion.payoutAccounts(mint, a.LOSS_COVER_HOOK_PROGRAM), ...candidates.flatMap((c) => (c.owner ? [rw(c.holding), rw(c.owner)] : [rw(c.holding)]))];
}

/** Whether a script companion's program is the Loss cover script: the coin is a Lossback coin. */
export const isLossCoverScript = (program: PublicKey | string): boolean => (typeof program === 'string' ? program : program.toBase58()) === LOSS_COVER_SCRIPT.program;
