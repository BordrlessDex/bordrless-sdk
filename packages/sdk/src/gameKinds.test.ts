/**
 * Phase 2 (the jackpot, the streak, Studio game hooks) held to the Rust reference, byte for byte:
 * the `phase2` section of `vectors/companion-games.json`, which bordrless-programs'
 * `game_vectors.rs` renders from `bordrless_companion::client`, the companion's accounts, the
 * starters' states and the crate's rules.
 */
import { describe, expect, it } from 'vitest';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import vectors from '../vectors/companion-games.json' with { type: 'json' };
import * as a from './addresses.ts';
import { CODERS } from './coders.ts';
import { GAME_HOOK_UPGRADE_AUTHORITIES, GAME_LIMITS, SHARE_RECEIPT_LEN, SHARE_RECEIPT_OFFSETS, JACKPOT_DEFAULTS, NO_KIND_ARGS, STREAK_DEFAULTS, companion, decodeCompanion, decodeGame, decodeShareReceipt, gameArgsProblem, gameHookExtras, gameRegistryProblem, receiptAddress, streakLastClose, type GameArgs, type GameKindArgs } from './companion.ts';
import { decodeTicketSlots, encodeGameHeader, parseGameHeader, type HoldingView } from './game.ts';
import {
  JACKPOT_ENDED_ROUNDS,
  JACKPOT_ENDED_ROUND_LEN,
  JACKPOT_HEADER_OFFSETS,
  JACKPOT_MARK_OFFSET,
  encodeJackpotHeader,
  endedRound,
  encodeStreakHeader,
  jackpotMark,
  jackpotWinnerHolds,
  parseJackpotHeader,
  parseStreakHeader,
  qualifyingBuy,
  settleRound,
  shareOf,
  streakClaims,
  streakHoldingsToEnter,
  streakQualifies,
  streakWeight,
  studioGameHook,
  type JackpotHeader,
} from './gameKinds.ts';

const p2 = vectors.phase2;
const key = (s: string): PublicKey => new PublicKey(s);
const hex = (s: string): Buffer => Buffer.from(s, 'hex');
const fixed = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
const K = { mint: key(vectors.keys.mint), payer: key(vectors.keys.payer), cranker: key(vectors.keys.cranker), winner: key(vectors.keys.winner) };
const JACKPOT = key(p2.constants.jackpotStarter);
const STREAK = key(p2.constants.streakStarter);
const split = { buybackBps: 3_000, holdersBps: 0, beneficiaryBps: 0 };
const lotteryArgs: GameArgs = { kind: 'lottery', hook: a.LOTTERY_HOOK_PROGRAM, split, potBps: 7_000, roundSecs: 21_600, minPot: 500_000_000n, prizeBps: 10_000, claimWindowSecs: 600, maxAttempts: 8 };
const jackpotArgs: GameArgs = { ...lotteryArgs, kind: 'jackpot', hook: JACKPOT, roundSecs: 0, claimWindowSecs: 0, maxAttempts: 0, prizeBps: 5_000 };
const jackpotKind: GameKindArgs = { ...NO_KIND_ARGS, timerSecs: 600, minTokens: 1_000_000_000_000n };
const streakArgs: GameArgs = { ...lotteryArgs, kind: 'streak', hook: STREAK, roundSecs: 604_800, claimWindowSecs: 3_600, maxAttempts: 0 };
const streakKind: GameKindArgs = { ...NO_KIND_ARGS, minStreakSecs: 604_800, minWeight: 100_000_000_000n };

const asVector = (name: string, ix: TransactionInstruction) => ({
  name,
  program: ix.programId.toBase58(),
  accounts: ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]),
  data: ix.data.toString('hex'),
});

describe('phase 2 builders are the Rust clients’', () => {
  const { mint, payer, cranker, winner } = K;
  const ours: Record<string, TransactionInstruction> = {
    createGameV2Jackpot: companion.createGameV2(payer, mint, jackpotArgs, jackpotKind),
    createGameV2Streak: companion.createGameV2(payer, mint, streakArgs, streakKind),
    createGameWithProgramData: companion.createGameWithProgramData(payer, mint, lotteryArgs),
    settle: companion.settle(cranker, mint, JACKPOT, winner),
    retireGame: companion.retireGame(cranker, mint, STREAK),
    closeEpoch: companion.closeEpoch(cranker, mint, STREAK, 2_960),
    claimShare: companion.claimShare(cranker, mint, STREAK, 2_960, winner),
    closeReceipt: companion.closeReceipt(mint, 2_960, winner, cranker),
    claimFeesStreak: companion.claimFees(cranker, mint, STREAK),
    studioPrepare: studioGameHook.prepare(STREAK, payer, mint),
    studioEnter: studioGameHook.enter(STREAK, mint, winner),
  };
  it('covers every instruction the vectors hold', () => {
    expect(Object.keys(ours).sort()).toEqual(p2.instructions.map((v) => v.name).sort());
  });
  for (const v of p2.instructions) {
    it(`${v.name}: the same program, accounts and data`, () => {
      expect(asVector(v.name, ours[v.name]!)).toEqual(v);
    });
  }
  it('derives the receipt, a ProgramData and a hook authority as the programs do', () => {
    expect(receiptAddress(mint, 2_960, winner).toBase58()).toBe(p2.constants.receiptAddress);
    expect(a.programDataAddress(JACKPOT).toBase58()).toBe(p2.constants.jackpotProgramData);
    expect(a.hookAuthority(STREAK).toBase58()).toBe(p2.constants.streakHookAuthority);
    expect(GAME_HOOK_UPGRADE_AUTHORITIES.map(String)).toEqual(p2.constants.hookUpgradeAuthorities);
    expect([GAME_LIMITS.minTimerSecs, GAME_LIMITS.maxTimerSecs, GAME_LIMITS.maxMinStreakSecs]).toEqual([p2.constants.minTimerSecs, p2.constants.maxTimerSecs, p2.constants.maxMinStreakSecs]);
  });
});

describe('phase 2 accounts as the programs serialize them', () => {
  const acc = p2.accounts;
  it('a jackpot Game and a streak Game: their kind fields from what was reserved', () => {
    const j = decodeGame(hex(acc.gameJackpot));
    expect([j.kind, j.roundSecs, j.timerSecs, j.minTokens, j.paidBuys, j.minStreakSecs, j.minWeight, j.epochPaid]).toEqual(['jackpot', 0, 600, 1_000_000_000_000n, 41n, 0, 0n, 0n]);
    const s = decodeGame(hex(acc.gameStreak));
    expect([s.kind, s.status, s.round, s.nextRound, s.roundSecs, s.minStreakSecs, s.minWeight, s.epochPaid, s.timerSecs]).toEqual(['streak', 'revealed', 2_960, 2_961, 604_800, 604_800, 100_000_000_000n, 123_456_789n, 0]);
    // The phase-1 sample (a lottery) reads its kind fields as zeros.
    const l = decodeGame(hex(vectors.accounts.game));
    expect([l.kind, l.timerSecs, l.minTokens, l.paidBuys, l.minStreakSecs, l.minWeight, l.epochPaid]).toEqual(['lottery', 0, 0n, 0n, 0, 0n, 0n]);
  });
  it('a Companion: its kind and its locked pot in what was reserved; every earlier companion a lottery with nothing locked', () => {
    const c = decodeCompanion(hex(acc.companionStreak));
    expect([c.gameKind, c.potLocked, c.roundSecs]).toEqual(['streak', 1_111_111_111n, 604_800]);
    const old = decodeCompanion(hex(vectors.accounts.companion));
    expect([old.gameKind, old.potLocked]).toEqual(['lottery', 0n]);
  });
  it('a ShareReceipt', () => {
    const data = hex(acc.shareReceipt);
    expect(data.length).toBe(acc.shareReceiptLen);
    expect(CODERS.companion.accounts.size('shareReceipt')).toBe(acc.shareReceiptLen);
    expect(data.length).toBe(SHARE_RECEIPT_LEN);
    expect(new PublicKey(data.subarray(SHARE_RECEIPT_OFFSETS.game, SHARE_RECEIPT_OFFSETS.game + 32)).equals(a.gameAddress(K.mint))).toBe(true);
    expect(new PublicKey(data.subarray(SHARE_RECEIPT_OFFSETS.payer, SHARE_RECEIPT_OFFSETS.payer + 32)).equals(fixed(3))).toBe(true);
    const r = decodeShareReceipt(data);
    expect([r.version, r.bump, r.game.equals(a.gameAddress(K.mint)), r.epoch, r.owner.equals(fixed(5)), r.payer.equals(fixed(3)), r.amount, r.claimedAt]).toEqual([1, 248, true, 2_960, true, true, 987_654_321n, 1_790_000_777]);
  });
  it('the starters’ states: the base header, then the kind header, at the standard’s offsets', () => {
    const js = hex(acc.jackpotState);
    const h = parseGameHeader(js);
    expect([h.roundSecs, h.round, h.lastBuyer.equals(fixed(12))]).toEqual([0, 0, true]);
    const j = parseJackpotHeader(js)!;
    expect([j.timerSecs, j.minTokens, j.buys, j.endedBuyer.equals(fixed(15)), j.endedAmount, j.endedAt, j.endedBuys]).toEqual([600, 1_000_000_000_000n, 42n, true, 2_000_000_000_000n, 1_790_000_000n, 41n]);
    // The earlier ended rounds, after the first 80 bytes: round 39 remembered, the rest empty.
    expect(j.earlier.length).toBe(JACKPOT_ENDED_ROUNDS - 1);
    expect([j.earlier[0]!.buyer.equals(fixed(16)), j.earlier[0]!.amount, j.earlier[0]!.at, j.earlier[0]!.number]).toEqual([true, 3_000_000_000_000n, 1_789_990_000n, 39n]);
    expect(j.earlier.slice(1).every((r) => r.number === 0n && r.buyer.equals(PublicKey.default))).toBe(true);
    expect(endedRound(j, 1)).toEqual(j.earlier[0]);
    expect(endedRound(j, JACKPOT_ENDED_ROUNDS)).toBeNull();
    expect(JACKPOT_HEADER_OFFSETS.end - JACKPOT_HEADER_OFFSETS.magic).toBe(80 + 7 * JACKPOT_ENDED_ROUND_LEN);
    expect(encodeJackpotHeader(j).equals(js.subarray(120, JACKPOT_HEADER_OFFSETS.end))).toBe(true);
    expect(parseJackpotHeader(js.subarray(0, JACKPOT_HEADER_OFFSETS.end - 1))).toBeNull();
    expect(parseStreakHeader(js)).toBeNull();
    const ss = hex(acc.streakState);
    expect(parseStreakHeader(ss)).toEqual({ minStreakSecs: 604_800, minWeight: 100_000_000_000n });
    expect(encodeStreakHeader(parseStreakHeader(ss)!).equals(ss.subarray(120, 136))).toBe(true);
    expect(parseJackpotHeader(ss)).toBeNull();
    // A lottery hook's own fields, which start at the same offset, read as neither.
    const lottery = hex(vectors.accounts.lotteryState);
    expect([parseJackpotHeader(lottery), parseStreakHeader(lottery)]).toEqual([null, null]);
  });
});

describe('the kinds’ rules (crates/bordrless-game jackpot and streak)', () => {
  const r = p2.rules;
  const t = 1_790_000_000n;
  const base = { ...parseGameHeader(Buffer.concat([Buffer.alloc(8), hex(r.jackpotBase)])) };
  const jackpot = parseJackpotHeader(Buffer.concat([Buffer.alloc(120), hex(r.jackpotHeader)]))!;
  it('reads the vectors’ headers back to the same bytes', () => {
    expect(encodeGameHeader(base).toString('hex')).toBe(r.jackpotBase);
    expect(encodeJackpotHeader(jackpot).toString('hex')).toBe(r.jackpotHeader);
    expect([base.lastBuyAt, jackpot.buys, jackpot.endedBuys, jackpot.earlier[0]!.number, jackpot.earlier[1]!.number]).toEqual([t, 42n, 41n, 40n, 38n]);
    expect(encodeStreakHeader({ minStreakSecs: 604_800, minWeight: 100_000_000_000n }).toString('hex')).toBe(r.streakHeader);
  });
  it('settles the oldest round that is over, as `settle_round` does (oldest remembered first)', () => {
    for (const [paid, now, want] of r.settleRound as [string, string, { number: string; buyer: string; amount: string; at: string } | null][]) {
      const got = settleRound(base, jackpot, BigInt(paid), 600, BigInt(now));
      expect(got && { number: String(got.number), buyer: got.buyer.toBase58(), amount: String(got.amount), at: String(got.at) }, `${paid} ${now}`).toEqual(want);
    }
  });
  it('tells a winner who still holds, as `jackpot_winner_holds` does', () => {
    const round = { number: 41n, buyer: fixed(15), amount: 7_000n, at: t - 1_000n };
    for (const [data, balance, want] of r.winnerHolds as [string, string, boolean][]) {
      expect(jackpotWinnerHolds(hex(data), round, BigInt(balance))).toBe(want);
      expect(jackpotMark(hex(data))).toBe(hex(data).readBigUInt64LE(JACKPOT_MARK_OFFSET));
    }
  });
  it('tells a qualifying buy, as `qualifying_buy` does', () => {
    for (const [launch, from, to, amount, min, want] of r.qualifyingBuy as [{ pool: string; onCurve: boolean } | null, string, string, string, string, boolean][]) {
      const view = launch && { pool: key(launch.pool), onCurve: launch.onCurve };
      expect(qualifyingBuy(view, key(from), key(to), BigInt(amount), BigInt(min))).toBe(want);
    }
  });
  it('weighs a streak holding and its share, as `streak_weight`, `streak_qualifies` and `share_of` do', () => {
    for (const [data, epoch, minStreak, minWeight, balance, want] of r.streakWeight as [string, number, number, string, string, string][]) {
      expect(String(streakWeight(hex(data), epoch, 604_800, minStreak, BigInt(minWeight), BigInt(balance))), `${epoch} ${minStreak} ${minWeight} ${balance}`).toBe(want);
    }
    for (const [since, epoch, min, want] of r.streakQualifies as [string, number, number, boolean][]) expect(streakQualifies(BigInt(since), epoch, 604_800, min)).toBe(want);
    for (const [pot, w, total, want] of r.shareOf as string[][]) expect(String(shareOf(BigInt(pot!), BigInt(w!), BigInt(total!)))).toBe(want);
  });
  it('finds the holders to enter and to claim for, as the program would take them', () => {
    const [weight500] = r.streakWeight as [string, number, number, string, string, string][];
    const data = hex(weight500![0]);
    const mint = K.mint;
    const owner = key(vectors.keys.onCurve);
    const holding = (hookData: Uint8Array, amount: bigint, who = owner): HoldingView => ({ address: a.holdingAddress(mint, who), mint, owner: who, amount, hookData });
    const g = { roundSecs: 604_800, minStreakSecs: 0, minWeight: 1n, prize: 1_000n, total: 2_000n };
    expect(streakClaims([holding(data, 500n)], mint, 2_960, g)).toEqual([{ owner, holding: a.holdingAddress(mint, owner), weight: 500n, share: 250n }]);
    expect(streakClaims([holding(data, 499n), holding(data, 500n, a.launchAddress(mint))], mint, 2_960, g)).toEqual([]);
    const slots = decodeTicketSlots(data);
    expect(slots.current.round).toBe(2_960);
    const streak = { minStreakSecs: 0, minWeight: 1n };
    expect(streakHoldingsToEnter([holding(data, 500n)], mint, 2_960, 604_800, streak)).toEqual([]);
    expect(streakHoldingsToEnter([holding(data, 500n)], mint, 2_961, 604_800, streak).length).toBe(1);
  });
});

describe('create_game_v2’s bounds (gameArgsProblem with kind settings)', () => {
  const limits = { maxBuyback: 1_000_000_000n, buybackInterval: 60 };
  it('passes the launch page’s jackpot and streak, and refuses what `check_game_args` refuses', () => {
    const jackpot: GameArgs = { kind: 'jackpot', hook: JACKPOT, ...JACKPOT_DEFAULTS };
    const jk: GameKindArgs = { ...NO_KIND_ARGS, timerSecs: JACKPOT_DEFAULTS.timerSecs, minTokens: 1n };
    expect(gameArgsProblem(jackpot, limits, jk)).toBeNull();
    const streak: GameArgs = { kind: 'streak', hook: STREAK, ...STREAK_DEFAULTS };
    const sk: GameKindArgs = { ...NO_KIND_ARGS, minStreakSecs: STREAK_DEFAULTS.minStreakSecs, minWeight: 1n };
    expect(gameArgsProblem(streak, limits, sk)).toBeNull();
    expect(gameArgsProblem(jackpot, limits, { ...jk, timerSecs: 299 })).toMatch(/5 minutes to 30 days/);
    expect(gameArgsProblem(jackpot, limits, { ...jk, minTokens: 0n })).toMatch(/one base unit/);
    expect(gameArgsProblem({ ...jackpot, roundSecs: 3_600 }, limits, jk)).toMatch(/no rounds/);
    expect(gameArgsProblem(jackpot, limits, { ...jk, minWeight: 1n })).toMatch(/no streak settings/);
    expect(gameArgsProblem(streak, limits, { ...sk, minWeight: 0n })).toMatch(/least weight/);
    expect(gameArgsProblem({ ...streak, maxAttempts: 1 }, limits, sk)).toMatch(/no attempts/);
    expect(gameArgsProblem({ ...streak, claimWindowSecs: 604_800 }, limits, sk)).toMatch(/half an epoch/);
    expect(gameArgsProblem(streak, limits, { ...sk, minStreakSecs: 366 * 86_400 })).toMatch(/a year/);
    expect(gameArgsProblem(lotteryArgs, limits, jk)).toMatch(/no jackpot or streak/);
    expect(gameArgsProblem({ ...lotteryArgs }, limits)).toBeNull();
  });
  it('limits a game hook’s registry to 2 extras besides the launch for create_game_v2 (3 for phase 1’s create_game)', () => {
    const pda = (program: PublicKey, tag: string) => ({ writable: false, source: { kind: 'pda' as const, program, seeds: [{ kind: 'literal' as const, bytes: Buffer.from(tag) }, { kind: 'account' as const, index: 1 }] } });
    const launchEntry = pda(a.LAUNCH_PROGRAM, 'launch');
    const two = { version: 1, accounts: [pda(JACKPOT, 'state'), launchEntry, pda(JACKPOT, 'extra')] };
    const three = { version: 1, accounts: [...two.accounts, { writable: false, source: { kind: 'key' as const, key: fixed(9) } }] };
    expect([gameHookExtras(two, K.mint), gameHookExtras(three, K.mint)]).toEqual([2, 3]);
    expect(gameRegistryProblem(two, K.mint)).toBeNull();
    expect(gameRegistryProblem(three, K.mint)).toMatch(/at most 2/);
    expect(gameRegistryProblem(three, K.mint, false)).toBeNull();
    // The launch counts for nothing, by key as well as by seeds.
    const byKey = { version: 1, accounts: [...two.accounts, { writable: false, source: { kind: 'key' as const, key: a.launchAddress(K.mint) } }] };
    expect(gameHookExtras(byKey, K.mint)).toBe(2);
    expect(GAME_LIMITS.maxGameHookExtrasV2).toBe(p2.constants.maxGameHookExtrasV2);
    expect(JACKPOT_ENDED_ROUNDS).toBe(p2.constants.jackpotEndedRounds);
  });
  it('closes an epoch no later than a claim window before its claims end', () => {
    expect(streakLastClose({ roundSecs: 604_800, claimWindowSecs: 3_600 }, 2_960)).toBe(2_962 * 604_800 - 3_600);
  });
  it('builds a Studio game hook’s standard prepare and enter, and its accounts', () => {
    const prep = studioGameHook.prepare(STREAK, K.payer, K.mint);
    expect(prep.data.toString('hex')).toBe('799b9c5aa4fcdc6d');
    expect(prep.keys.map((k) => k.pubkey.toBase58())).toEqual([K.payer, K.mint, a.gameStateAddress(STREAK, K.mint), a.registryAddress(STREAK, K.mint), a.SYSTEM_PROGRAM].map(String));
    const enter = studioGameHook.enter(STREAK, K.mint, K.winner);
    expect(enter.keys.map((k) => [k.pubkey.toBase58(), k.isWritable])).toEqual([
      [a.gameStateAddress(STREAK, K.mint).toBase58(), true],
      [K.mint.toBase58(), false],
      [a.holdingAddress(K.mint, K.winner).toBase58(), true],
      [p2.constants.streakHookAuthority, false],
      [a.TOKEN_PROGRAM.toBase58(), false],
      [a.TOKEN_EVENT_AUTHORITY.toBase58(), false],
    ]);
    expect(studioGameHook.accounts(JACKPOT, K.mint).extras.map((m) => [m.pubkey.toBase58(), m.isWritable])).toEqual([
      [a.gameStateAddress(JACKPOT, K.mint).toBase58(), true],
      [a.launchAddress(K.mint).toBase58(), false],
    ]);
  });
});

// Unused in the vectors but exported: keep the type in use.
export type { JackpotHeader };
