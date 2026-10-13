/**
 * Loss cover (Lossback) held to the programs: `vectors/loss-cover.json` (bordrless-programs'
 * `loss_cover_vectors.rs`: the hook's and the script's addresses, constants, layouts, `prepare`,
 * `record_payout`, the registry's extras, the arithmetic) and `vectors/payouts.json`
 * (`payout_vectors.rs`: the companion's payout terms, the answer, the budget, the bounty,
 * `create_script_v2`, a step with payouts, the record the companion builds).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PublicKey, type AccountMeta, type TransactionInstruction } from '@solana/web3.js';
import { FIXED_ADDRESSES, LOSS_COVER_HOOK, LOSS_COVER_SCRIPT } from '@bordrless/shared';
import hookIdl from '../idl/loss_cover_hook.json' with { type: 'json' };
import payouts from '../vectors/payouts.json' with { type: 'json' };
import vectors from '../vectors/loss-cover.json' with { type: 'json' };
import * as a from './addresses.ts';
import { companion } from './companion.ts';
import { EVENT_IX_TAG, GAME_EVENT_PROGRAMS, INDEXED_EVENT_PROGRAMS, eventsOf } from './events.ts';
import type { LaunchKeys } from './instructions.ts';
import {
  COVER_STATE_LEN,
  COVER_STATE_OFFSETS,
  COVER_TERMS_LEN,
  LOSS_COVER_BATCH,
  LOSS_COVER_DISCRIMINATORS,
  LOSS_COVER_FLAG_SOLD,
  LOSS_COVER_HOOK_FLAGS,
  LOSS_COVER_HOOK_PROGRAM_DATA,
  LOSS_COVER_LIMITS,
  LOSS_COVER_PRICE_SCALE,
  LOSS_COVER_RECORD_OFFSETS,
  LOSS_COVER_STATE_LEN,
  NO_LOSS_COVER_RECORD,
  PAYOUT_AUTHORITY_BUMP,
  PAYOUT_LIMITS,
  PAYOUT_TERMS_LEN,
  coverTermsOf,
  coverTermsValid,
  decodeCompanionPayoutEvent,
  decodeCoverRoundEvent,
  decodeCoverState,
  decodeCoverTerms,
  decodeLossCoverRecord,
  decodeLossCoverState,
  decodePayoutAnswer,
  decodePayoutTerms,
  decodeScriptPayoutEvent,
  encodeCoverState,
  encodeCoverTerms,
  encodeLossCoverRecord,
  encodeLossCoverState,
  encodePayoutAnswer,
  encodePayoutTerms,
  isLossCoverScript,
  lossCoverCapped,
  lossCoverFraction,
  lossCoverHook,
  lossCoverOwed,
  lossCoverRoundShareBps,
  lossCoverRoundView,
  lossCoverScriptArgs,
  lossCoverSpot,
  lossCoverStepExtras,
  lossCoverStepToward,
  lossCoverTradePrice,
  lossCoverUncovered,
  payoutBountyFor,
  payoutStepBudget,
  payoutTermsValid,
  payoutWindowStartAt,
  type CoverState,
  type LossCoverRecord,
  type LossCoverState,
  type PayoutTerms,
} from './lossCover.ts';
import { SCRIPT_LIMITS } from './scripts.ts';

/** The Rust vectors' `key(n)`: 32 bytes of `n`. */
const key = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
const KEYS = new Map<string, number>(Array.from({ length: 64 }, (_, n) => [key(n).toBase58(), n] as const));
/** Which `key(n)` a vector's address is. */
const n = (address: string): number => {
  const found = KEYS.get(address);
  if (found === undefined) throw new Error(`${address} is no key(n)`);
  return found;
};
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
type Row = [string, boolean, boolean];
const asVector = (name: string, ix: TransactionInstruction) => ({ name, program: ix.programId.toBase58(), accounts: ix.keys.map((m): Row => [m.pubkey.toBase58(), m.isSigner, m.isWritable]), data: ix.data.toString('hex') });
const disc = (text: string): string => createHash('sha256').update(text).digest().subarray(0, 8).toString('hex');
const plain = (o: object): Record<string, unknown> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v instanceof PublicKey ? v.toBase58() : v]));

const mint = key(n(vectors.keys.mint));
const payer = key(n(vectors.keys.payer));
const owner = key(n(vectors.keys.owner));

describe('the programs and their addresses', () => {
  it('are the keypairs’ public keys and the vectors’', () => {
    expect(a.LOSS_COVER_HOOK_PROGRAM.toBase58()).toBe(vectors.programs.hook);
    expect(a.LOSS_COVER_SCRIPT_PROGRAM.toBase58()).toBe(vectors.programs.script);
    expect(LOSS_COVER_HOOK.program).toBe(vectors.programs.hook);
    expect(LOSS_COVER_SCRIPT.program).toBe(vectors.programs.script);
    expect(isLossCoverScript(a.LOSS_COVER_SCRIPT_PROGRAM)).toBe(true);
    expect(isLossCoverScript(a.LOTTERY_HOOK_PROGRAM)).toBe(false);
  });

  it('derives the state, the registry, the launch, the pool, the authorities and the signers as the hook does', () => {
    const v = vectors.addresses;
    expect(a.lossCoverStateAddress(mint).toBase58()).toBe(v.state);
    expect(a.lossCoverRegistryAddress(mint).toBase58()).toBe(v.registry);
    expect(a.launchAddress(mint).toBase58()).toBe(v.launch);
    expect(a.launchPoolAddress(mint, a.BRIDGED_SOL_MINT, 30).toBase58()).toBe(v.pool30);
    expect(a.LOSS_COVER_HOOK_AUTHORITY.toBase58()).toBe(v.hookAuthority);
    expect(PublicKey.findProgramAddressSync([Buffer.from('hook-authority')], a.LOSS_COVER_HOOK_PROGRAM)[1]).toBe(v.hookAuthorityBump);
    expect(a.TOKEN_HOOK_SIGNER_LOSS_COVER.toBase58()).toBe(v.tokenHookSigner);
    expect(a.PAYOUT_AUTHORITY.toBase58()).toBe(v.payoutAuthority);
    expect(a.LOSS_COVER_EVENT_AUTHORITY.toBase58()).toBe(v.eventAuthority);
    expect(LOSS_COVER_HOOK.hookAuthority).toBe(v.hookAuthority);
    expect(LOSS_COVER_HOOK.hookAuthorityBump).toBe(v.hookAuthorityBump);
    expect(LOSS_COVER_HOOK.tokenHookSigner).toBe(v.tokenHookSigner);
    expect(FIXED_ADDRESSES.companionPayoutAuthority).toBe(v.payoutAuthority);
  });

  it('derives the payout terms and the payout authority as the companion does', () => {
    expect(a.payoutTermsAddress(mint).toBase58()).toBe(payouts.payoutTermsAddress);
    expect(a.PAYOUT_AUTHORITY.toBase58()).toBe(payouts.payoutAuthority);
    expect(PublicKey.findProgramAddressSync([Buffer.from(payouts.constants.authoritySeed)], a.COMPANION_PROGRAM)).toEqual([a.PAYOUT_AUTHORITY, payouts.payoutAuthorityBump]);
    expect(PAYOUT_AUTHORITY_BUMP).toBe(payouts.payoutAuthorityBump);
    expect(PublicKey.findProgramAddressSync([Buffer.from(payouts.constants.termsSeed), mint.toBuffer()], a.COMPANION_PROGRAM)[0].toBase58()).toBe(payouts.payoutTermsAddress);
    const hook = new PublicKey(payouts.keys.hook);
    expect(a.gameStateAddress(hook, mint).toBase58()).toBe(payouts.hookStateAddress);
    expect(a.hookAuthority(hook).toBase58()).toBe(payouts.hookAuthority);
  });
});

describe('the constants and the discriminators', () => {
  it('are the programs’', () => {
    const c = vectors.constants;
    expect(LOSS_COVER_HOOK_FLAGS).toBe(c.flags);
    expect(LOSS_COVER_PRICE_SCALE.toString()).toBe(c.priceScale);
    expect(LOSS_COVER_LIMITS).toMatchObject({ entryCapBps: c.entryCapBps, referenceSecs: c.referenceSecs, referenceStepBps: c.referenceStepBps, minCoverBps: c.minCoverBps, maxCoverBps: c.maxCoverBps, minRoundSecs: c.minRoundSecs, maxRoundSecs: c.maxRoundSecs, maxMinAgeSecs: c.maxMinAgeSecs });
    expect(LOSS_COVER_LIMITS.maxMinPotLamports.toString()).toBe(c.maxMinPotLamports);
    expect(LOSS_COVER_FLAG_SOLD).toBe(c.flagSold);
    expect([LOSS_COVER_STATE_LEN, COVER_STATE_LEN, COVER_TERMS_LEN]).toEqual([c.stateLen, c.coverStateLen, c.coverTermsLen]);
    expect(LOSS_COVER_BATCH).toEqual({ paying: c.batchPaying, measuring: c.batchMeasuring });
    expect(LOSS_COVER_RECORD_OFFSETS).toEqual(vectors.recordOffsets);
    expect(COVER_STATE_OFFSETS).toEqual(vectors.coverStateOffsets);
    const p = payouts.constants;
    expect(PAYOUT_LIMITS).toEqual({ termsVersion: p.termsVersion, answerVersion: p.answerVersion, maxPayoutsPerStep: p.maxPayoutsPerStep, bountyFull: p.bountyFull, minWindowSecs: p.minWindowSecs, maxWindowSecs: p.maxWindowSecs });
    expect(SCRIPT_LIMITS.bounty.toString()).toBe(p.scriptBounty);
    expect(LOSS_COVER_DISCRIMINATORS.recordPayout.toString('hex')).toBe(p.recordPayoutDiscriminator);
  });

  it('are Anchor’s hashes', () => {
    const d = LOSS_COVER_DISCRIMINATORS;
    expect(d.prepare.toString('hex')).toBe(disc('global:prepare'));
    expect(d.recordPayout.toString('hex')).toBe(disc('global:record_payout'));
    expect(d.createScriptV2.toString('hex')).toBe(disc('global:create_script_v2'));
    expect(d.lossCoverState.toString('hex')).toBe(disc('account:LossCoverState'));
    expect(d.coverState.toString('hex')).toBe(disc('account:CoverState'));
    expect(d.payoutTerms.toString('hex')).toBe(disc('account:PayoutTerms'));
    expect(d.coverRound.toString('hex')).toBe(vectors.events.CoverRound);
    expect(d.coverRound.toString('hex')).toBe(disc('event:CoverRound'));
    expect(d.payoutTermsSet.toString('hex')).toBe(payouts.events.PayoutTermsSet);
    expect(d.scriptPayout.toString('hex')).toBe(payouts.events.ScriptPayout);
    expect(d.scriptPayout.toString('hex')).toBe(disc('event:ScriptPayout'));
  });
});

describe('the layouts', () => {
  /** `loss_cover_vectors.rs` `record()`. */
  const record: LossCoverRecord = { version: 1, flags: LOSS_COVER_FLAG_SOLD, entry: 40_166_666n, amount: 100_000_000_000n, paid: 1_000_000n, updatedSlot: 400_000_123n, paidAt: 1_800_000_100, basisAt: 1_799_999_000, round: 6_000_000 };
  /** `state()`. */
  const state: LossCoverState = { version: 1, bump: 254, mint, launch: key(3), pool: key(4), creator: key(5), reference: 40_166_666n, referenceAt: 1_800_000_000, paidTotal: 123_456_789n, records: 42n, preparedBy: key(1), preparedAt: 1_799_990_000 };
  /** `cover_state()`. */
  const coverState: CoverState = { version: 1, mint, coverBps: 10_000, minHolding: 100_000_000_000n, minLoss: 1_000_000n, minAgeSecs: 1_800, roundSecs: 300, minPotLamports: 1_000_000_000n, round: 6_000_002, b: 500_000_000n, lPrev: 5_000_000_000n, lCur: 1_234_567_890n, roundPaid: 450_000_000n, measured: 12, rounds: 3, paidTotal: 2_000_000_000n };
  /** `payout_vectors.rs`'s terms. */
  const terms: PayoutTerms = { version: 1, bump: 251, mint, stepBps: 10_000, holdingBps: 10_000, windowBps: 10_000, windowSecs: 300, windowStart: 1_800_000_000, windowPot: 5_000_000_000, windowPaid: 123_456_789, paidTotal: 9_876_543_210, payouts: 42, lastPaidAt: 1_800_000_123 } as unknown as PayoutTerms;

  it('reads and writes a holding’s record at its offsets', () => {
    const data = Buffer.from(vectors.record.data, 'hex');
    expect(data).toHaveLength(64);
    expect(decodeLossCoverRecord(data)).toEqual(record);
    expect(encodeLossCoverRecord(record).toString('hex')).toBe(vectors.record.data);
    expect(decodeLossCoverRecord(new Uint8Array(64))).toEqual(NO_LOSS_COVER_RECORD);
    expect(encodeLossCoverRecord(NO_LOSS_COVER_RECORD)).toEqual(Buffer.alloc(64));
  });

  it('reads and writes the hook’s state', () => {
    const v = vectors.accounts.lossCoverState;
    const data = Buffer.from(v.data, 'hex');
    expect([data.length, v.len]).toEqual([LOSS_COVER_STATE_LEN, LOSS_COVER_STATE_LEN]);
    expect(data.subarray(0, 8).toString('hex')).toBe(v.discriminator);
    expect(plain(decodeLossCoverState(data))).toEqual(plain(state));
    expect(encodeLossCoverState(state).toString('hex')).toBe(v.data);
    expect(() => decodeLossCoverState(Buffer.from(vectors.accounts.coverState.data, 'hex'))).toThrow(/LossCoverState/);
  });

  it('reads and writes the script’s terms and state', () => {
    expect(encodeCoverTerms(coverTermsOf(coverState)).toString('hex')).toBe(vectors.coverTerms.data);
    expect(decodeCoverTerms(Buffer.from(vectors.coverTerms.data, 'hex'))).toEqual(coverTermsOf(coverState));
    expect(coverTermsValid(coverTermsOf(coverState))).toBe(true);
    for (const bad of [{ coverBps: 999 }, { coverBps: 10_001 }, { minHolding: 0n }, { minLoss: 0n }, { minAgeSecs: 30 * 86_400 + 1 }, { roundSecs: 59 }, { roundSecs: 86_401 }, { minPotLamports: 100_000_000_001n }]) {
      expect(coverTermsValid({ ...coverTermsOf(coverState), ...bad }), JSON.stringify(bad, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(false);
    }
    const v = vectors.accounts.coverState;
    const data = Buffer.from(v.data, 'hex');
    expect([data.length, v.len]).toEqual([COVER_STATE_LEN, COVER_STATE_LEN]);
    expect(data.subarray(0, 8).toString('hex')).toBe(v.discriminator);
    expect(plain(decodeCoverState(data))).toEqual(plain(coverState));
    expect(encodeCoverState(coverState).toString('hex')).toBe(v.data);
  });

  it('reads and writes the companion’s payout terms, and their window', () => {
    const v = payouts.accounts.payoutTerms;
    const data = Buffer.from(v.data, 'hex');
    expect([data.length, v.len]).toEqual([PAYOUT_TERMS_LEN, PAYOUT_TERMS_LEN]);
    expect(data.subarray(0, 8).toString('hex')).toBe(v.discriminator);
    const decoded = decodePayoutTerms(data);
    expect(decoded.mint.equals(mint)).toBe(true);
    expect({ ...decoded, mint: undefined }).toMatchObject({ version: 1, stepBps: 10_000, holdingBps: 10_000, windowBps: 10_000, windowSecs: 300 });
    // Written back byte for byte.
    expect(encodePayoutTerms(decoded).toString('hex')).toBe(v.data);
    expect(encodePayoutTerms({ ...decoded, windowPot: 5n, windowPaid: 6n, paidTotal: 7n, payouts: 8n, lastPaidAt: 9, windowStart: 1_800_000_000 }).subarray(52, 100)).toEqual(Buffer.concat([le64(1_800_000_000n), le64(5n), le64(6n), le64(7n), le64(8n), le64(9n)]));
    expect(payoutWindowStartAt(terms, 1_800_000_299)).toBe(1_800_000_000);
    expect(payoutWindowStartAt(terms, 1_800_000_300)).toBe(1_800_000_300);
    expect(payoutWindowStartAt(terms, 0)).toBe(0);
    expect(payoutTermsValid({ stepBps: 10_000, holdingBps: 10_000, windowBps: 10_000, windowSecs: 300 })).toBe(true);
    for (const bad of [{ stepBps: 0 }, { holdingBps: 10_001 }, { windowBps: 0 }, { windowSecs: 9 }, { windowSecs: 86_401 }]) expect(payoutTermsValid({ stepBps: 10_000, holdingBps: 10_000, windowBps: 10_000, windowSecs: 300, ...bad })).toBe(false);
  });

  it('reads the events', () => {
    const round = decodeCoverRoundEvent(Buffer.from(vectors.coverRound.data, 'hex'));
    expect(plain(round)).toEqual({ mint: mint.toBase58(), round: 6_000_002, b: 500_000_000n, lPrev: 5_000_000_000n });
  });
});

const le64 = (v: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
};

describe('the answer', () => {
  it('is its Borsh exactly: 1 + 4 + 13 * n bytes, 16 entries at most', () => {
    const v = payouts.answer;
    const answer = { version: 1, entries: [{ account: 7, lamports: 1_000_000n, tag: 6_000_001 }, { account: 9, lamports: 0n, tag: 6_000_001 }] };
    expect(encodePayoutAnswer(answer).toString('hex')).toBe(v.data);
    expect(encodePayoutAnswer(answer)).toHaveLength(v.len);
    expect(decodePayoutAnswer(Buffer.from(v.data, 'hex'))).toEqual(answer);
    expect(encodePayoutAnswer({ version: 1, entries: [] })).toHaveLength(5);
    const sixteen = { version: 1, entries: Array.from({ length: 16 }, () => ({ account: 1, lamports: 2n, tag: 3 })) };
    expect(encodePayoutAnswer(sixteen)).toHaveLength(213);
    expect(decodePayoutAnswer(encodePayoutAnswer(sixteen)).entries).toHaveLength(16);
    expect(() => encodePayoutAnswer({ version: 1, entries: Array.from({ length: 17 }, () => ({ account: 1, lamports: 2n, tag: 3 })) })).toThrow(/16/);
    const one = encodePayoutAnswer({ version: 1, entries: [{ account: 7, lamports: (1n << 64n) - 1n, tag: 0xffff_ffff }] });
    expect(one).toHaveLength(18);
    const badVersion = Buffer.from(one);
    badVersion[0] = 2;
    expect(() => decodePayoutAnswer(badVersion)).toThrow(/BadPayoutAnswer/);
    expect(() => decodePayoutAnswer(one.subarray(0, one.length - 1))).toThrow(/BadPayoutAnswer/);
    expect(() => decodePayoutAnswer(Buffer.concat([one, Buffer.from([0])]))).toThrow(/BadPayoutAnswer/);
    expect(() => decodePayoutAnswer(Buffer.from([9, 9, 9]))).toThrow(/BadPayoutAnswer/);
    expect(() => decodePayoutAnswer(Buffer.alloc(0))).toThrow(/BadPayoutAnswer/);
  });
});

describe('the builders are the programs’ clients', () => {
  it('prepare, the record and the registry’s extras (the hook)', () => {
    const byName = (name: string) => vectors.instructions.find((v) => v.name === name)!;
    expect(asVector('prepare', lossCoverHook.prepare(payer, mint))).toEqual(byName('prepare'));
    expect(asVector('recordPayout', lossCoverHook.recordPayout(mint, owner, 1_000_000n, 6_000_001))).toEqual(byName('recordPayout'));
    expect(lossCoverHook.extras(mint, 30).map((m): Row => [m.pubkey.toBase58(), m.isSigner, m.isWritable])).toEqual(vectors.extras);
    expect(lossCoverHook.accounts(mint, 30)).toEqual({ program: a.LOSS_COVER_HOOK_PROGRAM, extras: lossCoverHook.extras(mint, 30) });
  });

  it('set_entry, the upgrade authority’s repair of a record, is the IDL’s instruction', () => {
    type IdlAccount = { name: string; signer?: boolean; writable?: boolean; address?: string };
    const ix = (hookIdl as { instructions: { name: string; discriminator: number[]; accounts: IdlAccount[]; args: { name: string; type: string }[] }[] }).instructions.find((i) => i.name === 'set_entry')!;
    expect(Buffer.from(ix.discriminator).toString('hex')).toBe(LOSS_COVER_DISCRIMINATORS.setEntry.toString('hex'));
    expect(LOSS_COVER_DISCRIMINATORS.setEntry.toString('hex')).toBe(disc('global:set_entry'));
    expect(ix.args).toEqual([{ name: 'entry', type: 'u64' }]);
    const authority = key(9);
    const built = lossCoverHook.setEntry(authority, mint, owner, 56_140_000n);
    expect(built.programId.equals(a.LOSS_COVER_HOOK_PROGRAM)).toBe(true);
    // The accounts in the IDL's order, with its signer and writable flags and its fixed addresses.
    expect(built.keys.map((m) => [m.isSigner, m.isWritable])).toEqual(ix.accounts.map((acc) => [acc.signer === true, acc.writable === true]));
    for (const [i, acc] of ix.accounts.entries()) if (acc.address) expect(built.keys[i]!.pubkey.toBase58()).toBe(acc.address);
    expect(built.keys.map((m) => m.pubkey.toBase58())).toEqual([authority, LOSS_COVER_HOOK_PROGRAM_DATA, mint, a.holdingAddress(mint, owner), a.lossCoverStateAddress(mint), a.LOSS_COVER_HOOK_AUTHORITY, a.TOKEN_PROGRAM, a.TOKEN_EVENT_AUTHORITY].map((k) => k.toBase58()));
    expect(LOSS_COVER_HOOK_PROGRAM_DATA.toBase58()).toBe('FndUwNW68djMCYWemsEsGWj3xfdZM4qfzwf2HdrYRgkG');
    // The data: the discriminator and the entry as a little-endian u64.
    const entry = Buffer.alloc(8);
    entry.writeBigUInt64LE(56_140_000n);
    expect(built.data.toString('hex')).toBe(LOSS_COVER_DISCRIMINATORS.setEntry.toString('hex') + entry.toString('hex'));
    expect(lossCoverHook.setEntry(authority, mint, owner, 0xffff_ffff_ffff_ffffn).data.subarray(8).toString('hex')).toBe('ffffffffffffffff');
    // The program refuses 0 (`ZeroEntry`); the builder refuses it, and what is no u64, first.
    expect(() => lossCoverHook.setEntry(authority, mint, owner, 0n)).toThrow(/above 0/);
    expect(() => lossCoverHook.setEntry(authority, mint, owner, 1n << 64n)).toThrow(/u64/);
    const errors = (hookIdl as { errors: { code: number; name: string }[] }).errors;
    expect(errors.slice(-2)).toEqual([expect.objectContaining({ code: 6007, name: 'NotUpgradeAuthority' }), expect.objectContaining({ code: 6008, name: 'ZeroEntry' })]);
  });

  it('create_script_v2, the payout accounts, a step with payouts and the record the companion builds', () => {
    const byName = (name: string) => payouts.instructions.find((v) => v.name === name)!;
    const program = new PublicKey(payouts.keys.program);
    const hook = new PublicKey(payouts.keys.hook);
    const cranker = new PublicKey(payouts.keys.cranker);
    // The vector's arguments: an empty split, the whole fee to the pot, 15-second steps, a 128-byte state, three bytes of init data, every share whole, a 5-minute window.
    const args = { split: { buybackBps: 0, holdersBps: 0, beneficiaryBps: 0 }, potBps: 10_000, program, interval: 15, stateLen: 128, initData: Uint8Array.from([1, 2, 3]) };
    const payout = { stepBps: 10_000, holdingBps: 10_000, windowBps: 10_000, windowSecs: 300 };
    expect(asVector('createScriptV2', companion.createScriptV2(new PublicKey(payouts.keys.payer), mint, args, payout))).toEqual(byName('createScriptV2'));
    expect(companion.payoutAccounts(mint, hook).map((m): Row => [m.pubkey.toBase58(), m.isSigner, m.isWritable])).toEqual(payouts.payoutAccounts);
    const keys: LaunchKeys = { mint, quoteMint: a.BRIDGED_SOL_MINT, lpFeeBps: 30, modules: 0, burns: false, customHook: null };
    const extra = [...companion.payoutAccounts(mint, hook), rw(new PublicKey(payouts.keys.holdingA)), rw(new PublicKey(payouts.keys.ownerA)), rw(new PublicKey(payouts.keys.holdingB))];
    expect(asVector('scriptStepPayouts', companion.scriptStep(cranker, keys, program, extra))).toEqual(byName('scriptStepPayouts'));
    // A Lossback step's extras are the same shape with the Loss cover hook.
    const ours = lossCoverStepExtras(mint, [{ holding: new PublicKey(payouts.keys.holdingA), owner: new PublicKey(payouts.keys.ownerA) }, { holding: new PublicKey(payouts.keys.holdingB), owner: null }]);
    expect(ours.map((m) => m.pubkey.toBase58())).toEqual([...companion.payoutAccounts(mint, a.LOSS_COVER_HOOK_PROGRAM).map((m) => m.pubkey.toBase58()), payouts.keys.holdingA, payouts.keys.ownerA, payouts.keys.holdingB]);
    expect(ours.slice(7).every((m) => m.isWritable && !m.isSigner)).toBe(true);
    // The record the companion builds for another hook: the same data, the hook's own state and authority.
    const record = byName('recordPayout');
    expect(record.data).toBe(lossCoverHook.recordPayout(mint, owner, 1_000_000n, 6_000_001).data.toString('hex'));
    expect(record.accounts.map((r) => r[0])).toEqual([a.PAYOUT_AUTHORITY.toBase58(), mint.toBase58(), payouts.keys.holdingA, payouts.hookStateAddress, payouts.hookAuthority, a.TOKEN_PROGRAM.toBase58(), a.TOKEN_EVENT_AUTHORITY.toBase58()]);
  });

  it('a Lossback coin’s create_script_v2 arguments carry the six terms as init data and the round as the window', () => {
    const { args, payout } = lossCoverScriptArgs({ buybackBps: 0, holdersBps: 0, beneficiaryBps: 0 }, 10_000, { coverBps: 10_000, minHolding: 100_000_000_000n, minLoss: 1_000_000n, minAgeSecs: 1_800, roundSecs: 300, minPotLamports: 1_000_000_000n, stepSecs: 15, stepBps: 10_000, holdingBps: 10_000, roundBps: 10_000 });
    expect(args).toMatchObject({ program: a.LOSS_COVER_SCRIPT_PROGRAM, interval: 15, stateLen: 128, potBps: 10_000 });
    expect(Buffer.from(args.initData).toString('hex')).toBe(vectors.coverTerms.data);
    expect(payout).toEqual({ stepBps: 10_000, holdingBps: 10_000, windowBps: 10_000, windowSecs: 300 });
    expect(payoutTermsValid(payout)).toBe(true);
    expect(companion.createScriptV2(payer, mint, args, payout).data.subarray(0, 8)).toEqual(LOSS_COVER_DISCRIMINATORS.createScriptV2);
  });
});

describe('the math is the programs’', () => {
  const m = vectors.math;
  const pool = { baseReserve: BigInt(m.pool.baseReserve), quoteReserve: BigInt(m.pool.quoteReserve), virtualBase: BigInt(m.pool.virtualBase), virtualQuote: BigInt(m.pool.virtualQuote) };

  it('the spot, a buy’s entry, the cap and the reference', () => {
    expect(lossCoverSpot(pool)).toBe(BigInt(m.spot));
    expect(lossCoverTradePrice(pool, BigInt(m.delivered))).toBe(BigInt(m.entry));
    expect(lossCoverSpot({ ...pool, baseReserve: 0n, virtualBase: 0n })).toBeNull();
    expect(lossCoverTradePrice({ ...pool, baseReserve: 0n, virtualBase: 0n }, 0n)).toBeNull();
    expect(lossCoverTradePrice({ ...pool, baseReserve: 0n, virtualBase: 0n }, 1n)).toBe((1n << 64n) - 1n);
    for (const c of m.capped) expect(lossCoverCapped(BigInt(c.price), BigInt(c.reference))).toBe(BigInt(c.out));
    expect(lossCoverCapped(1_000n, 900n)).toBe(1_000n);
    for (const s of m.stepToward) expect(lossCoverStepToward(BigInt(s.reference), BigInt(s.spot))).toBe(BigInt(s.out));
    expect(lossCoverStepToward(1_000n, 1_020n)).toBe(1_020n);
    expect(lossCoverStepToward(1_000n, 960n)).toBe(960n);
  });

  it('what a holding is owed and what a round pays it', () => {
    for (const o of m.owed) expect(lossCoverUncovered(BigInt(o.entry), BigInt(o.spot), BigInt(o.balance), o.coverBps, BigInt(o.paid))).toBe(BigInt(o.out));
    expect(lossCoverUncovered(20_000_000n, 10_000_000n, 1_000_000_000_000n, 10_000, 20_000_000n)).toBe(0n);
    expect(lossCoverUncovered(9n, 10n, 1n, 10_000, 0n)).toBe(0n);
    expect(lossCoverUncovered((1n << 64n) - 1n, 0n, (1n << 64n) - 1n, 10_000, 0n)).toBe((1n << 64n) - 1n);
    for (const f of m.fraction) expect(lossCoverFraction(BigInt(f.uncovered), BigInt(f.b), BigInt(f.lPrev))).toBe(BigInt(f.out));
    expect(lossCoverFraction(1_000n, 0n, 1_000n)).toBe(0n);
    expect(lossCoverFraction(300n, 100n, 1_000n)).toBe(30n);
    expect(lossCoverRoundShareBps(100n, 1_000n)).toBe(1_000);
    expect(lossCoverRoundShareBps(3_000n, 1_000n)).toBe(10_000);
    expect(lossCoverRoundShareBps(500n, 0n)).toBe(0);
  });

  it('the companion’s budget and bounty', () => {
    for (const b of payouts.budget) expect(payoutStepBudget(BigInt(b.potBefore), BigInt(b.potAfterScript), BigInt(b.bounty), BigInt(b.windowPot), BigInt(b.windowPaid), b.stepBps, b.windowBps).toString()).toBe(b.budget);
    expect(payoutStepBudget(1_000n, 1_000n, 20n, 1_000n, 0n, 10_000, 10_000)).toBe(980n);
    expect(payoutStepBudget(1_000n, 1_000n, 0n, 1_000n, 2_000n, 10_000, 10_000)).toBe(0n);
    expect(payoutStepBudget(10n, 10n, 20n, 10n, 0n, 10_000, 10_000)).toBe(0n);
    expect(payoutBountyFor(null).toString()).toBe(payouts.bounty.none);
    for (const [entries, out] of Object.entries(payouts.bounty)) if (entries !== 'none') expect(payoutBountyFor(Number(entries)).toString(), entries).toBe(out);
  });
});

describe('a round and a holding’s standing (companion_step’s checks)', () => {
  const terms = { coverBps: 10_000, minHolding: 100_000_000_000n, minLoss: 1_000_000n, minAgeSecs: 1_800, roundSecs: 300, minPotLamports: 1_000_000_000n };
  const state: CoverState = { version: 1, mint, ...terms, round: 6_000_000, b: 500_000_000n, lPrev: 5_000_000_000n, lCur: 2_000_000_000n, roundPaid: 100_000_000n, measured: 3, rounds: 2, paidTotal: 1_000_000_000n };
  const holder = key(40);
  const record: LossCoverRecord = { version: 1, flags: 0, entry: 20_000_000n, amount: 1_000_000_000_000n, paid: 0n, updatedSlot: 1n, paidAt: 0, basisAt: 6_000_000 * 300 - 7_200, round: 5_999_999 };
  const spot = 10_000_000n;

  it('keeps the state’s round while the clock is in it, and rolls it as the step would', () => {
    const now = 6_000_000 * 300 + 10;
    expect(lossCoverRoundView(state, now, 9_000_000_000n)).toMatchObject({ round: 6_000_000, b: 500_000_000n, lPrev: 5_000_000_000n, lCur: 2_000_000_000n, roundPaid: 100_000_000n, rolls: false, measuring: false, shareBps: 1_000, potEnough: true, startsAt: 6_000_000 * 300, endsAt: 6_000_001 * 300 });
    // The next round: the loss measured this round becomes lPrev, the pot the budget.
    expect(lossCoverRoundView(state, now + 300, 9_000_000_000n)).toMatchObject({ round: 6_000_001, b: 9_000_000_000n, lPrev: 2_000_000_000n, lCur: 0n, roundPaid: 0n, rolls: true, measuring: false, shareBps: 10_000, potEnough: true });
    // A gap: nothing carried over; the round measures only.
    expect(lossCoverRoundView(state, now + 600, 9_000_000_000n)).toMatchObject({ round: 6_000_002, lPrev: 0n, measuring: true, shareBps: 0, rolls: true });
    // Below the minimum pot the round does not start.
    expect(lossCoverRoundView(state, now + 300, 999_999_999n).potEnough).toBe(false);
    expect(lossCoverRoundView(state, now, 1n).potEnough).toBe(true);
  });

  it('pays the same share of the uncovered loss, within what the round has left', () => {
    const now = 6_000_000 * 300 + 10;
    const view = lossCoverRoundView(state, now, 9_000_000_000n);
    // Entry 2e7, spot 1e7, 1e12 base units: 1e7 lamports lost, all of it covered, none paid: a tenth of it this round (b / lPrev).
    const owed = lossCoverOwed({ owner: holder, amount: record.amount, record }, spot, terms, view, now);
    expect(owed).toEqual({ round: 6_000_000, loss: 10_000_000n, covered: 10_000_000n, uncovered: 10_000_000n, pay: 1_000_000n, eligible: true, skip: null });
    // Paid before: less is owed.
    expect(lossCoverOwed({ owner: holder, amount: record.amount, record: { ...record, paid: 4_000_000n } }, spot, terms, view, now)).toMatchObject({ uncovered: 6_000_000n, pay: 600_000n });
    // Half covered.
    expect(lossCoverOwed({ owner: holder, amount: record.amount, record }, spot, { ...terms, coverBps: 5_000 }, view, now)).toMatchObject({ covered: 5_000_000n, uncovered: 5_000_000n, pay: 500_000n });
    // The round's budget nearly out: what is left.
    expect(lossCoverOwed({ owner: holder, amount: record.amount, record }, spot, terms, { ...view, roundPaid: 499_999_000n }, now).pay).toBe(1_000n);
    expect(lossCoverOwed({ owner: holder, amount: record.amount, record }, spot, terms, { ...view, roundPaid: 500_000_000n }, now)).toMatchObject({ pay: 0n, eligible: true });
    // A measuring round: a touch.
    expect(lossCoverOwed({ owner: holder, amount: record.amount, record }, spot, terms, { ...view, lPrev: 0n }, now)).toMatchObject({ pay: 0n, eligible: true, uncovered: 10_000_000n });
  });

  it('skips what the script skips, in its order', () => {
    const now = 6_000_000 * 300 + 10;
    const view = lossCoverRoundView(state, now, 9_000_000_000n);
    const h = { owner: holder, amount: record.amount, record };
    const skip = (over: Partial<typeof h>, t = terms, at = now, excluded: PublicKey[] = []) => lossCoverOwed({ ...h, ...over }, spot, t, view, at, excluded).skip;
    expect(skip({}, terms, now, [holder])).toBe('excluded');
    expect(skip({ owner: PublicKey.default })).toBe('excluded');
    expect(skip({ owner: a.lossCoverStateAddress(mint) })).toBe('excluded');
    expect(skip({ record: NO_LOSS_COVER_RECORD })).toBe('noRecord');
    expect(skip({ amount: record.amount + 1n })).toBe('recordStale');
    expect(skip({ record: { ...record, round: 6_000_000 } })).toBe('recordedThisRound');
    expect(skip({ amount: 1_000n, record: { ...record, amount: 1_000n } })).toBe('belowMinHolding');
    expect(skip({ record: { ...record, basisAt: now - 1_799 } })).toBe('tooYoung');
    expect(skip({ record: { ...record, basisAt: now - 1_800 } })).toBeNull();
    expect(skip({ record: { ...record, entry: spot } })).toBe('aboveWater');
    expect(skip({ record: { ...record, paid: 10_000_000n } })).toBe('aboveWater');
    expect(skip({ record: { ...record, paid: 9_500_000n } })).toBe('belowMinLoss');
    expect(skip({ record: { ...record, paid: 9_000_000n } })).toBeNull();
    // Measured this round already: not counted twice.
    expect(lossCoverOwed({ ...h, record: { ...record, round: view.round } }, spot, terms, view, now).eligible).toBe(false);
  });
});

describe('the companion’s payout events through eventsOf', () => {
  it('decodes ScriptPayout through the coder, and by discriminator as the fallback, to one shape', () => {
    const c = key(30);
    const body = Buffer.concat([c.toBuffer(), key(31).toBuffer(), key(32).toBuffer(), key(33).toBuffer(), le64(1_000_000n), Buffer.from([0x81, 0x8d, 0x5b, 0x00]), le64(7n), le64(8n), le64(9n)]);
    const payload = Buffer.concat([LOSS_COVER_DISCRIMINATORS.scriptPayout, body]);
    const e = decodeScriptPayoutEvent(body);
    expect(plain(e)).toEqual({ companion: c.toBase58(), program: key(31).toBase58(), holding: key(32).toBase58(), owner: key(33).toBase58(), lamports: 1_000_000n, tag: 6_000_001, windowPaid: 7n, paidTotal: 8n, potAfter: 9n });
    const keys = [a.COMPANION_PROGRAM.toBase58(), a.COMPANION_EVENT_AUTHORITY.toBase58()];
    const inner = [{ programIdIndex: 0, accounts: [1], data: Buffer.concat([EVENT_IX_TAG, payload]).toString('hex') }];
    const events = eventsOf(keys, inner, (d) => Buffer.from(d, 'hex'), [...INDEXED_EVENT_PROGRAMS, ...GAME_EVENT_PROGRAMS]);
    expect(events).toHaveLength(1);
    const data = { companion: c.toBase58(), program: key(31).toBase58(), holding: key(32).toBase58(), owner: key(33).toBase58(), lamports: '1000000', tag: 6_000_001, windowPaid: '7', paidTotal: '8', potAfter: '9' };
    expect(events[0]).toMatchObject({ program: 'companion', name: 'scriptPayout', data });
    // The fallback by discriminator (a coder built from an older IDL) gives the same shape.
    expect(decodeCompanionPayoutEvent(payload)).toEqual({ name: 'scriptPayout', data });
    expect(decodeCompanionPayoutEvent(Buffer.concat([Buffer.alloc(8, 1), body]))).toBeNull();
    // Not read when the companion's events are not asked for; an unknown discriminator stays unread.
    expect(eventsOf(keys, inner, (d) => Buffer.from(d, 'hex'))).toEqual([]);
    const unknown = [{ programIdIndex: 0, accounts: [1], data: Buffer.concat([EVENT_IX_TAG, Buffer.alloc(8, 1), body]).toString('hex') }];
    expect(eventsOf(keys, unknown, (d) => Buffer.from(d, 'hex'), [...INDEXED_EVENT_PROGRAMS, ...GAME_EVENT_PROGRAMS])).toEqual([]);
  });
});
