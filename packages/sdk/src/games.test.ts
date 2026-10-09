/**
 * Companion v2 games held to the Rust reference, byte for byte: `vectors/companion-games.json` is
 * rendered by bordrless-programs' `programs/tests/tests/game_vectors.rs` from the Rust clients
 * (`bordrless_companion::client`, `lottery_hook::client`), the programs' own account types, the
 * game ticket standard (`crates/bordrless-game`), the game's clocks (`state.rs`) and the oracle
 * module (`oracle.rs`); that test rewrites the file and fails when the Rust side changes, and the
 * file is copied here next to the IDLs. Every builder below must produce the very accounts, flags
 * and data the Rust client does, and every decoder must read the very bytes the programs write.
 */
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { PublicKey, type Connection, type TransactionInstruction } from '@solana/web3.js';
import vectors from '../vectors/companion-games.json' with { type: 'json' };
import * as a from './addresses.ts';
import { NO_LAUNCH_RULES, type LaunchRulesData } from './accounts.ts';
import { CODERS } from './coders.ts';
import {
  GAME_LIMITS,
  HOOK_TERMS_DEFAULT,
  LOTTERY_DEFAULTS,
  companion,
  companionStrandedAt,
  decodeCompanion,
  decodeGame,
  decodeHookStatus,
  gameArgsProblem,
  gameAttemptCloses,
  gameAttemptOpens,
  gameClaimsEnd,
  gameDormantSecs,
  gameIdleSince,
  gameLastDraw,
  gameMinPotAt,
  gameOracleBackoffOver,
  gameOracleBackoffRounds,
  gamePaidRequestAddress,
  gameRetirableAt,
  hookDrawThreshold,
  hookPotCap,
  hookTermsOf,
  type Game,
  type GameArgs,
} from './companion.ts';
import {
  GAME_HEADER_LEN,
  GameHeaderError,
  MAX_ROUND_SECS,
  MIN_ROUND_SECS,
  decodeTicketSlots,
  drawIndex,
  encodeGameHeader,
  encodeTicketSlots,
  findWinningHolding,
  gameTotalOf,
  parseGameHeader,
  rangeIn,
  readGameHeader,
  roundEnd,
  roundOf,
  roundStart,
  ticketEligible,
  ticketWins,
  validRoundSecs,
  winningHoldingAmong,
  type HoldingView,
  type TicketRange,
} from './game.ts';
import { encodeHookAccountList, resolveCustomHookAccounts, decodeHookAccountList } from './hooks.ts';
import { launch, launchKeys, type LaunchKeys } from './instructions.ts';
import { LOTTERY_HOOK_FLAGS, decodeLotteryState, lotteryHook } from './lotteryHook.ts';
import { ORAO_FULFILLED_LEN, ORAO_MAX_REQUEST_FEE, ORAO_PENDING_LEN, ORAO_V1_LEN, decodeOraoNetworkState, decodeSeedSlot, drawSeed, fetchSeedSlot, oraoRequestV2, readOraoRequest } from './orao.ts';

type V = typeof vectors;
type IxVector = V['instructions'][number];

const key = (s: string): PublicKey => new PublicKey(s);
const hex = (s: string): Buffer => Buffer.from(s, 'hex');
/** The fixed key the Rust vectors use: 32 bytes of `n`. */
const fixed = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));
const SOL = a.BRIDGED_SOL_MINT;
const DAY = 86_400;
const EVERY_RULE: LaunchRulesData = { holderFeeBuyBps: 100, holderFeeSellBps: 100, burnBuyBps: 50, burnSellBps: 50, maxWalletBps: 500, creatorLockSecs: 30 * DAY, earlyWindowSecs: 60, earlyLockSecs: 3_600 };

const K = {
  mint: key(vectors.keys.mint),
  payer: key(vectors.keys.payer),
  cranker: key(vectors.keys.cranker),
  beneficiary: key(vectors.keys.beneficiary),
  winner: key(vectors.keys.winner),
  authority: key(vectors.keys.authority),
  treasury: key(vectors.keys.treasury),
  seed: hex(vectors.keys.seed),
  paidSeed: hex(vectors.keys.paidSeed),
  /** The slot the vectors' draw names for its seed, and its hash. */
  at: { slot: BigInt(vectors.keys.seedSlot), hash: hex(vectors.keys.slotHash) },
};

const asVector = (name: string, ix: TransactionInstruction): IxVector => ({
  name,
  program: ix.programId.toBase58(),
  accounts: ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]) as IxVector['accounts'],
  data: ix.data.toString('hex'),
});

/** The inputs of `game_vectors.rs`, as the TypeScript builders take them. */
const HOOK = a.LOTTERY_HOOK_PROGRAM;
const createArgs = { split: { buybackBps: 10_000, holdersBps: 0, beneficiaryBps: 0 }, bountyBps: 50, maxBuyback: 1_000_000_000n, buybackInterval: 60, vestSecs: 30 * DAY, fund: 500_000_000n };
const gameArgs: GameArgs = { kind: 'lottery', hook: HOOK, split: { buybackBps: 3_000, holdersBps: 0, beneficiaryBps: 0 }, potBps: 7_000, roundSecs: 21_600, minPot: 500_000_000n, prizeBps: 10_000, claimWindowSecs: 600, maxAttempts: 8 };
const launchArgs = { name: 'Lottery coin', symbol: 'LOTTO', uri: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', creatorFeeBps: 200, virtualQuote: 28_125_000_000n, rules: NO_LAUNCH_RULES };
const gameKeys = (burns: boolean): LaunchKeys => ({ ...launchKeys(K.mint, SOL, 30, NO_LAUNCH_RULES, lotteryHook.accounts(K.mint)), burns });

function built(): Record<string, TransactionInstruction> {
  const { mint, payer, cranker, beneficiary, winner, authority, treasury, seed, paidSeed, at } = K;
  const request = a.oraoRequestAddress(seed);
  const kitKeys = launchKeys(mint, SOL, 30, EVERY_RULE);
  const createLaunch = launch.createLaunch(a.companionCreatorAddress(mint), mint, fixed(10), SOL, 30, launchArgs, { launchConfig: fixed(9), customHook: lotteryHook.accounts(mint) });
  return {
    create: companion.create(payer, beneficiary, mint, createArgs),
    lotteryPrepare: lotteryHook.prepare(payer, mint, gameArgs.roundSecs),
    createGame: companion.createGame(payer, mint, gameArgs),
    launch: companion.launch(payer, mint, createLaunch, launchArgs),
    devBuyGame: companion.devBuy(beneficiary, gameKeys(false), 1_000_000_000n, 7n),
    buybackGame: companion.buyback(cranker, gameKeys(false), false),
    buybackGameBurns: companion.buyback(cranker, gameKeys(true), false),
    releaseGame: companion.release(cranker, gameKeys(false), false, beneficiary),
    claimFeesGame: companion.claimFees(cranker, mint, HOOK),
    draw: companion.draw(cranker, mint, HOOK, 81_234, at, treasury),
    drawAfter: companion.draw(cranker, mint, HOOK, 81_234, at, treasury, paidSeed),
    reveal: companion.reveal(cranker, mint, HOOK, request),
    claimPrize: companion.claimPrize(cranker, mint, HOOK, 3, winner),
    expire: companion.expire(cranker, mint, HOOK, request),
    retire: companion.retire(cranker, mint, HOOK),
    burnStranded: companion.burnStranded(cranker, mint, HOOK),
    setHookStatus: companion.setHookStatus(authority, fixed(11), { audited: false, potCap: 5_000_000_000n, blocked: true }),
    lotteryEnter: lotteryHook.enter(mint, winner),
    devBuyKit: companion.devBuy(beneficiary, kitKeys, 1_000_000_000n, 7n),
    buybackKit: companion.buyback(cranker, kitKeys, true),
    releaseKit: companion.release(cranker, kitKeys, true, beneficiary),
    claimFeesKit: companion.claimFees(cranker, mint),
  };
}

describe('the builders are the Rust clients’ (bordrless_companion::client, lottery_hook::client)', () => {
  const ours = built();

  it('covers every instruction the vectors hold', () => {
    expect(Object.keys(ours).sort()).toEqual(vectors.instructions.map((v) => v.name).sort());
  });

  for (const v of vectors.instructions) {
    it(`${v.name}: the same program, accounts (signer, writable) and data`, () => {
      const ix = ours[v.name];
      expect(ix, v.name).toBeDefined();
      expect(asVector(v.name, ix!)).toEqual(v);
    });
  }

  it('ORAO’s request_v2 as the companion builds it', () => {
    const v = vectors.oracle.requestIx;
    expect(asVector('requestV2', oraoRequestV2(fixed(14), K.treasury, new Uint8Array(32).fill(7)))).toEqual(v);
  });
});

describe('the addresses and limits are the programs’', () => {
  const c = vectors.constants;
  it('derives every address the vectors name', () => {
    expect([a.COMPANION_PROGRAM, a.LOTTERY_HOOK_PROGRAM, a.TOKEN_HOOK_SIGNER_LOTTERY, a.LOTTERY_HOOK_AUTHORITY, a.LOTTERY_EVENT_AUTHORITY, a.COMPANION_PROGRAM_DATA, a.INCINERATOR].map(String)).toEqual([
      c.companionProgram,
      c.lotteryHook,
      c.lotteryTokenHookSigner,
      c.lotteryHookAuthority,
      c.lotteryEventAuthority,
      c.companionProgramData,
      c.incinerator,
    ]);
    expect([a.gameAddress(K.mint), a.hookStatusAddress(HOOK), a.oraclePayerAddress(K.mint), a.lotteryRegistryAddress(K.mint), a.lotteryStateAddress(K.mint)].map(String)).toEqual([c.gameAddress, c.hookStatusAddress, c.oraclePayerAddress, c.lotteryRegistry, vectors.standard.stateAddress]);
    expect([a.launchAddress(K.mint), a.companionCreatorAddress(K.mint)].map(String)).toEqual([vectors.standard.launch, vectors.standard.companionCreator]);
    expect([a.ORAO_VRF_PROGRAM, a.ORAO_NETWORK_STATE, a.SLOT_HASHES_SYSVAR].map(String)).toEqual([vectors.oracle.program, vectors.oracle.networkState, vectors.oracle.slotHashes]);
    expect(vectors.oracle.networkStateDerived).toBe(vectors.oracle.networkState);
  });

  it('holds the game limits to constants.rs', () => {
    expect(LOTTERY_HOOK_FLAGS).toBe(c.lotteryHookFlags);
    expect([GAME_LIMITS.defaultPotCap, GAME_LIMITS.minPotCap, GAME_LIMITS.minMinPot, GAME_LIMITS.maxMinPot].map(String)).toEqual([c.defaultPotCap, c.minPotCap, c.minMinPot, c.maxMinPot]);
    expect([GAME_LIMITS.minPrizeBps, GAME_LIMITS.minClaimWindowSecs, GAME_LIMITS.maxClaimWindowSecs, GAME_LIMITS.maxAttempts, GAME_LIMITS.claimsPerRound, GAME_LIMITS.maxGameHookExtras, GAME_LIMITS.maxBountyBps]).toEqual([
      c.minPrizeBps,
      c.minClaimWindow,
      c.maxClaimWindow,
      c.maxAttempts,
      c.claimsPerRound,
      c.maxGameHookExtras,
      c.maxBountyBps,
    ]);
    expect([GAME_LIMITS.revealSecs, GAME_LIMITS.seedSlots, GAME_LIMITS.dormantSecs, GAME_LIMITS.dormantRounds, GAME_LIMITS.retireDormantPeriods, GAME_LIMITS.strandedSecs, GAME_LIMITS.strandedIntervals].map(String)).toEqual([
      c.revealSecs,
      c.seedSlots,
      c.dormantSecs,
      c.dormantRounds,
      c.retireDormantPeriods,
      c.strandedSecs,
      c.strandedIntervals,
    ]);
    expect([MIN_ROUND_SECS, MAX_ROUND_SECS]).toEqual([c.minRoundSecs, c.maxRoundSecs]);
    expect([ORAO_PENDING_LEN, ORAO_FULFILLED_LEN, ORAO_V1_LEN, String(ORAO_MAX_REQUEST_FEE)]).toEqual([vectors.oracle.pendingLen, vectors.oracle.fulfilledLen, vectors.oracle.v1Len, vectors.oracle.maxRequestFee]);
  });
});

describe('the accounts as the programs serialize them', () => {
  const acc = vectors.accounts;

  it('a Game: every field of the sample, at the account’s size', () => {
    const data = hex(acc.game);
    expect(data.length).toBe(acc.gameLen);
    expect(CODERS.companion.accounts.size('game')).toBe(acc.gameLen);
    const g = decodeGame(data);
    expect([g.version, g.bump, g.kind, g.mint.equals(fixed(1)), g.hook.equals(HOOK), g.stateBump, g.statusBump, g.oracleBump]).toEqual([1, 253, 'lottery', true, true, 254, 252, 251]);
    expect([g.roundSecs, g.minPot, g.prizeBps, g.claimWindowSecs, g.maxAttempts, g.createdAt, g.status]).toEqual([21_600, 500_000_000n, 5_000, 600, 8, 1_790_000_000, 'revealed']);
    expect([g.nextRound, g.round, g.total, g.n, Buffer.from(g.seed).equals(Buffer.alloc(32, 7)), g.request.equals(a.oraoRequestAddress(Buffer.alloc(32, 7)))]).toEqual([82_871, 82_870, 987_654_321_012_345n, 0, true, true]);
    expect([g.committedAt, g.requestedAt, Buffer.from(g.randomness).equals(Buffer.from(Array.from({ length: 64 }, (_, i) => i))), g.revealedAt, g.prize]).toEqual([1_790_000_100, 1_790_000_101, true, 1_790_000_160, 1_234_567_890n]);
    expect([g.draws, g.prizesPaid, g.prizesTotal, g.rollovers, g.oracleTotal, g.lastWinner.equals(fixed(5)), g.settledAt]).toEqual([41n, 37n, 98_765_432_100n, 4n, 76_543_210n, true, 1_789_999_000]);
    expect([Buffer.from(g.paidSeed).equals(Buffer.alloc(32, 8)), g.paidRound, g.paidStreak]).toEqual([true, 82_866, 3]);
  });

  it('a HookStatus, and the terms it gives (the defaults without one)', () => {
    const data = hex(acc.hookStatus);
    expect(data.length).toBe(acc.hookStatusLen);
    const s = decodeHookStatus(data);
    expect([s.version, s.bump, s.hook.equals(fixed(11)), s.audited, s.potCap, s.blocked, s.updatedAt, s.updatedBy.equals(fixed(6))]).toEqual([1, 250, true, false, 5_000_000_000n, true, 1_790_000_500, true]);
    expect(hookTermsOf(s)).toEqual({ audited: false, potCap: 5_000_000_000n, blocked: true });
    expect(hookTermsOf(null)).toEqual(HOOK_TERMS_DEFAULT);
  });

  it('a Companion with its v2 fields in what was reserved, and a v1 companion as one without a game', () => {
    const data = hex(acc.companion);
    expect(data.length).toBe(acc.companionLen);
    const c = decodeCompanion(data);
    expect([c.gameHook?.equals(HOOK), c.potBps, c.pendingPot, c.roundSecs, c.strandedBurnedAt, c.split, c.referencePrice]).toEqual([true, 7_000, 9_876_543_210n, 21_600, 1_792_600_000, { buybackBps: 3_000, holdersBps: 0, beneficiaryBps: 0 }, 340_282_366_920_938_463_463n]);
    // v1 wrote its last 64 bytes as zeros: no game, no pot, no burn.
    const v1 = Buffer.concat([data.subarray(0, data.length - 64), Buffer.alloc(64)]);
    const old = decodeCompanion(v1);
    expect([old.gameHook, old.potBps, old.pendingPot, old.roundSecs, old.strandedBurnedAt, old.pendingBuyback]).toEqual([null, 0, 0n, 0, 0, 13n]);
  });

  it('a LotteryState: the standard’s header first, then the hook’s fields', () => {
    const data = hex(acc.lotteryState);
    expect(data.length).toBe(acc.lotteryStateLen);
    const s = decodeLotteryState(data);
    expect([s.version, s.bump, s.launch.toBase58(), s.pool.equals(fixed(13)), s.creator.toBase58(), s.preparedBy.equals(fixed(2)), s.preparedAt]).toEqual([1, 249, vectors.standard.launch, true, vectors.standard.companionCreator, true, 1_789_990_000]);
    expect(s.header.round).toBe(vectors.standard.header.round);
  });
});

describe('the game ticket standard (crates/bordrless-game)', () => {
  const st = vectors.standard;
  const rangeOf = (r: { round: number; start: string; weight: string }): TicketRange => ({ round: r.round, start: BigInt(r.start), weight: BigInt(r.weight) });

  it('reads the header at its offsets and writes it back to the same bytes', () => {
    const state = hex(st.state);
    const h = readGameHeader(state, K.mint);
    const want = st.header;
    expect([h.mint.toBase58(), h.roundSecs, h.round, String(h.total), h.prevRound, String(h.prevTotal), h.lastBuyer.toBase58(), String(h.lastAmount), String(h.lastBuyAt)]).toEqual([
      want.mint,
      want.roundSecs,
      want.round,
      want.total,
      want.prevRound,
      want.prevTotal,
      want.lastBuyer,
      want.lastAmount,
      want.lastBuyAt,
    ]);
    expect(encodeGameHeader(h).toString('hex')).toBe(st.headerBytes);
    expect(state.subarray(8, 8 + GAME_HEADER_LEN).toString('hex')).toBe(st.headerBytes);
    // Length, magic and mint checked.
    expect(() => parseGameHeader(state.subarray(0, 119))).toThrow(GameHeaderError);
    const bad = Buffer.from(state);
    bad[8] = 0;
    expect(() => parseGameHeader(bad)).toThrow(/BadMagic/);
    expect(() => readGameHeader(state, fixed(2))).toThrow(/WrongMint/);
  });

  it('answers a finished round’s total, or null once forgotten', () => {
    const h = readGameHeader(hex(st.state), K.mint);
    for (const [round, total] of st.totalOf) expect(gameTotalOf(h, round as number), `round ${round}`).toBe(total === null ? null : BigInt(total as string));
  });

  it('decodes slots as the crate does (empty ranges keep only their round) and encodes them back', () => {
    for (const v of st.slots) {
      const s = decodeTicketSlots(hex(v.data));
      expect({ current: s.current, previous: s.previous, since: s.since, free: Buffer.from(s.free).toString('hex') }).toEqual({ current: rangeOf(v.slots.current), previous: rangeOf(v.slots.previous), since: BigInt(v.slots.since), free: v.slots.free });
      expect(encodeTicketSlots(s).toString('hex')).toBe(v.encoded);
      const rounds = [82_871, 82_870, 0, 0xffff_ffff, 0xffff_fffe];
      rounds.forEach((r, i) => {
        const want = v.rangeIn[i];
        expect(rangeIn(s, r), `range in ${r}`).toEqual(want ? rangeOf(want) : null);
      });
    }
  });

  it('tells a winning holding as `wins` does', () => {
    for (const [i, round, x, balance, won] of st.wins) expect(ticketWins(hex(st.slots[i as number]!.data), round as number, BigInt(x as string), BigInt(balance as string)), `${i} ${round} ${x} ${balance}`).toBe(won);
  });

  it('draws the same ticket as `draw_index` for every randomness, attempt and total, the crate’s own vectors among them', () => {
    const r = st.randomness as Record<string, string>;
    for (const [name, k, total, x] of st.drawIndex) expect(drawIndex(hex(r[name as string]!), k as number, BigInt(total as string)), `${name} ${k} ${total}`).toBe(x === null ? null : BigInt(x as string));
    // The crate's unit-test vectors (from Python's hashlib).
    expect(drawIndex(new Uint8Array(64), 0, (1n << 64n) - 1n)).toBe(12_976_294_286_951_469_335n);
    expect(drawIndex(Uint8Array.from({ length: 64 }, (_, i) => i), 7, 1_000_003n)).toBe(359_196n);
    expect(() => drawIndex(new Uint8Array(64), -1, 7n)).toThrow(RangeError);
  });

  it('does the round arithmetic as the crate does', () => {
    for (const [now, secs, round] of st.roundOf) expect(roundOf(BigInt(now as string), secs as number), `${now} / ${secs}`).toBe(round);
    for (const [round, secs, start, end, claims] of st.roundEnds) {
      expect([roundStart(round as number, secs as number), roundEnd(round as number, secs as number), gameClaimsEnd(round as number, secs as number)]).toEqual([Number(start), Number(end), Number(claims)]);
    }
    for (const [secs, ok] of st.validRoundSecs) expect(validRoundSecs(secs as number)).toBe(ok);
  });

  it('lets only wallets outside the launch hold tickets', () => {
    for (const [owner, excluded, ok] of st.eligible) expect(ticketEligible(key(owner as string), (excluded as string[]).map(key)), `${owner}`).toBe(ok);
  });
});

describe('the game’s clocks (state.rs), as a keeper reads them', () => {
  const cl = vectors.clocks;
  const g: Game = decodeGame(hex(vectors.accounts.game));
  const launchedAt = Number(cl.launchedAt);

  it('ends a draw’s claims with the round after it, and cuts the attempts there', () => {
    expect([gameClaimsEnd(g.round, g.roundSecs), gameLastDraw(g, g.round)]).toEqual([Number(cl.claimsEnd), Number(cl.lastDraw)]);
    for (const [attempt, opens, closes] of cl.attempts) expect([gameAttemptOpens(g, attempt as number), gameAttemptCloses(g, attempt as number)]).toEqual([Number(opens), Number(closes)]);
    const late = { ...g, revealedAt: Number(cl.lateRevealedAt) };
    for (const [attempt, opens, closes] of cl.lateAttempts) expect([gameAttemptOpens(late, attempt as number), gameAttemptCloses(late, attempt as number)]).toEqual([Number(opens), Number(closes)]);
    // Past i64 there is none, as `checked_add` answers (2^63 - 1,024 is exact as a number; two windows more overflow).
    expect(gameAttemptOpens({ revealedAt: 2 ** 63 - 1_024, claimWindowSecs: 600 }, 2)).toBeNull();
  });

  it('goes dormant, then retirable, after the prizes stop', () => {
    expect([gameDormantSecs(g), gameIdleSince(g, launchedAt), gameRetirableAt(g, launchedAt)]).toEqual([Number(cl.dormantSecs), Number(cl.idleSince), Number(cl.retirableAt)]);
    for (const [now, minPot] of cl.minPotAt) expect(gameMinPotAt(g, Number(now), launchedAt)).toBe(BigInt(minPot as string));
    const long = { ...g, roundSecs: 30 * DAY, settledAt: 0 };
    expect([gameDormantSecs(long), gameRetirableAt(long, launchedAt)]).toEqual([Number(cl.longDormantSecs), Number(cl.longRetirableAt)]);
  });

  it('backs the oracle off 1, 2, 4… rounds while the pot’s last paid request is unanswered', () => {
    for (const [streak, rounds, over] of cl.backoff) {
      const b = { ...g, paidStreak: streak as number };
      expect([gameOracleBackoffRounds(b), gameOracleBackoffOver(b)], `streak ${streak}`).toEqual([Number(rounds), over]);
    }
    expect(gamePaidRequestAddress(g.paidSeed)?.equals(a.oraoRequestAddress(g.paidSeed))).toBe(true);
    expect(gamePaidRequestAddress(new Uint8Array(32))).toBeNull();
  });

  it('burns a blocked game’s buyback only once nothing has bought or waited for 30 days (or 4 intervals)', () => {
    const c = decodeCompanion(hex(vectors.accounts.companion));
    for (const [interval, updatedAt, since, at] of cl.stranded) {
      const ci = { ...c, buybackInterval: Number(interval) };
      expect(companionStrandedAt(ci, Number(updatedAt)), `interval ${interval}, status ${updatedAt}`).toBe(Number(at));
      expect(Number(since) + Math.max(GAME_LIMITS.strandedSecs, GAME_LIMITS.strandedIntervals * Number(interval))).toBe(Number(at));
    }
  });

  it('caps a pot under a hook not audited, and draws a pot full at its cap', () => {
    for (const [audited, potCap, blocked, cap, low, high, mid] of cl.terms) {
      const t = { audited: audited as boolean, potCap: BigInt(potCap as string), blocked: blocked as boolean };
      expect(hookPotCap(t)).toBe(cap === null ? null : BigInt(cap as string));
      expect([hookDrawThreshold(t, GAME_LIMITS.minMinPot), hookDrawThreshold(t, GAME_LIMITS.maxMinPot), hookDrawThreshold(t, 3_000_000_000n)]).toEqual([BigInt(low as string), BigInt(high as string), BigInt(mid as string)]);
    }
  });
});

describe('ORAO, read as the companion reads it (oracle.rs)', () => {
  const o = vectors.oracle;

  it('makes a draw’s seed from the slot it names and that slot’s hash, and its request address', () => {
    for (const [mint, round, n, slot, slotHash, seed, request] of o.drawSeeds) {
      const s = drawSeed(key(mint as string), round as number, n as number, BigInt(slot as string), hex(slotHash as string));
      expect(s.toString('hex')).toBe(seed);
      expect(a.oraoRequestAddress(s).toBase58()).toBe(request);
    }
    // The draw passes that seed's request, writable, for ORAO to make in the same instruction.
    const draw = companion.draw(K.cranker, K.mint, HOOK, 81_234, K.at, K.treasury);
    const request = a.oraoRequestAddress(drawSeed(K.mint, 81_234, 0, K.at.slot, K.at.hash));
    expect(draw.keys.find((m) => m.pubkey.equals(request))?.isWritable).toBe(true);
  });

  it('reads the slot a draw names: the slot hashes sysvar’s newest entry', async () => {
    const data = Buffer.alloc(8 + 2 * 40);
    data.writeBigUInt64LE(2n, 0);
    data.writeBigUInt64LE(454_000_123n, 8);
    Buffer.alloc(32, 9).copy(data, 16);
    data.writeBigUInt64LE(454_000_122n, 48);
    const at = decodeSeedSlot(data);
    expect([at.slot, Buffer.from(at.hash).equals(Buffer.alloc(32, 9))]).toEqual([454_000_123n, true]);
    expect(() => decodeSeedSlot(Buffer.alloc(48))).toThrow('no entry');
    let asked: unknown = null;
    const connection = {
      getAccountInfo: async (address: PublicKey, config: unknown) => {
        asked = [address.toBase58(), config];
        return { data: data.subarray(0, 48), owner: a.SYSTEM_PROGRAM, lamports: 1, executable: false };
      },
    } as unknown as Connection;
    expect((await fetchSeedSlot(connection)).slot).toBe(454_000_123n);
    expect(asked).toEqual([a.SLOT_HASHES_SYSVAR.toBase58(), { commitment: 'processed', dataSlice: { offset: 0, length: 48 } }]);
  });

  it('reads the fee and the treasury from ORAO’s network state (the mainnet fixture: 0.0005 SOL)', () => {
    const ns = decodeOraoNetworkState(hex(o.networkStateData));
    expect([ns.fee, ns.treasury.toBase58(), ns.fulfillmentAuthorities.length]).toEqual([500_000n, K.treasury.toBase58(), 3]);
    expect(() => decodeOraoNetworkState(Buffer.alloc(100))).toThrow();
  });

  it('tells a pending request, an answer, a v1 request and what it must refuse', () => {
    const seed = Buffer.alloc(32, 7);
    const at = a.oraoRequestAddress(seed);
    const owner = a.ORAO_VRF_PROGRAM;
    const v2 = (variant: number, len: number, r: Buffer = Buffer.alloc(64, 9)): Buffer => {
      const d = Buffer.alloc(len);
      Buffer.from([139, 239, 184, 215, 227, 86, 191, 226]).copy(d, 0);
      d[8] = variant;
      fixed(3).toBuffer().copy(d, 9);
      seed.copy(d, 41);
      if (variant === 1) r.copy(d, 73);
      return d;
    };
    const v1 = (r: Buffer): Buffer => {
      const d = Buffer.alloc(780);
      Buffer.from([188, 96, 216, 248, 93, 94, 49, 112]).copy(d, 0);
      seed.copy(d, 8);
      r.copy(d, 40);
      return d;
    };
    expect(readOraoRequest(at, null, seed)).toEqual({ kind: 'none' });
    expect(readOraoRequest(at, { owner: a.SYSTEM_PROGRAM, data: Buffer.alloc(0) }, seed)).toEqual({ kind: 'none' });
    expect(readOraoRequest(at, { owner, data: v2(0, 749) }, seed)).toEqual({ kind: 'pending', version: 2 });
    const answered = readOraoRequest(at, { owner, data: v2(1, 137) }, seed);
    expect(answered.kind === 'answered' && Buffer.from(answered.randomness).equals(Buffer.alloc(64, 9))).toBe(true);
    expect(readOraoRequest(at, { owner, data: v1(Buffer.alloc(64)) }, seed)).toEqual({ kind: 'pending', version: 1 });
    expect(readOraoRequest(at, { owner, data: v1(Buffer.alloc(64, 5)) }, seed).kind).toBe('answered');
    // Refused: another owner, another seed's address, a length the companion does not know, zeros.
    expect(readOraoRequest(at, { owner: fixed(1), data: v2(0, 749) }, seed).kind).toBe('unreadable');
    expect(readOraoRequest(a.oraoRequestAddress(Buffer.alloc(32, 8)), { owner, data: v2(0, 749) }, seed).kind).toBe('unreadable');
    expect(readOraoRequest(at, { owner, data: v2(0, 750) }, seed).kind).toBe('unreadable');
    expect(readOraoRequest(at, { owner, data: v2(1, 138) }, seed).kind).toBe('unreadable');
    expect(readOraoRequest(at, { owner, data: v2(1, 137, Buffer.alloc(64)) }, seed).kind).toBe('unreadable');
    expect(readOraoRequest(at, { owner, data: v2(2, 137) }, seed).kind).toBe('unreadable');
  });
});

describe('the winner search (findWinningHolding)', () => {
  // Three wallets of the same mint, their ranges for round 100: A [0, 60), B [60, 100), C forgot it (written in 101 and 102).
  const mint = K.mint;
  const wallet = (): PublicKey => {
    for (;;) {
      const k = PublicKey.unique();
      if (PublicKey.isOnCurve(k.toBytes())) return k;
    }
  };
  const slots = (current: TicketRange, previous: TicketRange = { round: 0, start: 0n, weight: 0n }): Uint8Array => encodeTicketSlots({ current, previous, since: 1n, free: new Uint8Array(16) });
  const [A, B, C] = [K.treasury, wallet(), wallet()];
  const holdings: HoldingView[] = [
    { address: a.holdingAddress(mint, A), mint, owner: A, amount: 60n, hookData: slots({ round: 100, start: 0n, weight: 60n }) },
    { address: a.holdingAddress(mint, B), mint, owner: B, amount: 40n, hookData: slots({ round: 101, start: 0n, weight: 0n }, { round: 100, start: 60n, weight: 40n }) },
    { address: a.holdingAddress(mint, C), mint, owner: C, amount: 500n, hookData: slots({ round: 102, start: 0n, weight: 500n }, { round: 101, start: 0n, weight: 500n }) },
  ];
  const total = 100n;
  /** The first attempt of `randomness` that lands below 60 (A) and the first at 60 or above (B). */
  const randomness = new Uint8Array(64).fill(42);
  const ticket = (k: number): bigint => drawIndex(randomness, k, total)!;

  it('finds the holding whose range for the round holds the ticket, and only an eligible one at its own address', () => {
    for (let k = 0; k < 8; k++) {
      const won = winningHoldingAmong(holdings, mint, randomness, k, total, 100);
      const x = ticket(k);
      expect(won?.owner.toBase58(), `attempt ${k}, ticket ${x}`).toBe((x < 60n ? A : B).toBase58());
      expect(won?.ticket).toBe(x);
    }
    // Round 101 has no ticket in A or B; C's 101 range is [0, 500).
    expect(winningHoldingAmong(holdings, mint, randomness, 0, 500n, 101)?.owner.toBase58()).toBe(C.toBase58());
    // A holding that sold below its range no longer wins; one at another address, of another mint, or excluded never does.
    const sold = holdings.map((h) => ({ ...h, amount: h.amount - 1n }));
    expect(winningHoldingAmong(sold, mint, randomness, 0, total, 100)).toBeNull();
    const moved = holdings.map((h) => ({ ...h, address: fixed(20) }));
    expect(winningHoldingAmong(moved, mint, randomness, 0, total, 100)).toBeNull();
    expect(winningHoldingAmong(holdings, mint, randomness, 0, total, 100, [A, B])).toBeNull();
    expect(winningHoldingAmong(holdings, mint, randomness, 0, 0n, 100)).toBeNull();
  });

  it('reads the mint’s holdings with one getProgramAccounts on the token program, filtered by size, discriminator and mint', async () => {
    const asked: unknown[] = [];
    const accounts = await Promise.all(
      holdings.map(async (h) => {
        const encoded = await CODERS.token.accounts.encode('holding', { version: 1, bump: 255, mint: h.mint, owner: h.owner, amount: new BN(h.amount.toString()), delegate: null, delegatedAmount: new BN(0), frozen: false, hookData: Array.from(h.hookData), reserved: Array(16).fill(0) });
        // A holding is 204 bytes whatever its delegate: zero padding after the Borsh fields.
        return { pubkey: h.address, account: { owner: a.TOKEN_PROGRAM, lamports: 1, executable: false, data: Buffer.concat([encoded, Buffer.alloc(204 - encoded.length)]) } };
      }),
    );
    const connection = {
      getProgramAccounts: async (program: PublicKey, config: unknown) => {
        asked.push([program.toBase58(), config]);
        return accounts;
      },
    } as unknown as Connection;
    const won = await findWinningHolding(connection, mint, randomness, 0, total, 100);
    expect(won?.owner.toBase58()).toBe((ticket(0) < 60n ? A : B).toBase58());
    const [[program, config]] = asked as [[string, { filters: unknown[] }]];
    expect(program).toBe(a.TOKEN_PROGRAM.toBase58());
    expect(config.filters).toEqual([{ dataSize: 204 }, { memcmp: { offset: 0, bytes: expect.any(String) } }, { memcmp: { offset: 10, bytes: mint.toBase58() } }]);
    // No tickets in the round: nothing is read.
    expect(await findWinningHolding(connection, mint, randomness, 0, 0n, 100)).toBeNull();
    expect(asked).toHaveLength(1);
  });
});

describe('create_game’s bounds (gameArgsProblem)', () => {
  const limits = { maxBuyback: 1_000_000_000n, buybackInterval: 60 };
  const ok: GameArgs = { kind: 'lottery', hook: HOOK, ...LOTTERY_DEFAULTS };

  it('passes the launch page’s lottery and refuses what the program refuses', () => {
    expect(gameArgsProblem(ok, limits)).toBeNull();
    expect(gameArgsProblem(gameArgs, limits)).toBeNull();
    const bad: [Partial<GameArgs>, RegExp][] = [
      [{ potBps: 0, split: { buybackBps: 10_000, holdersBps: 0, beneficiaryBps: 0 } }, /add up/],
      [{ potBps: 6_000 }, /add up/],
      [{ potBps: 6_000, split: { buybackBps: 3_000, holdersBps: 1_000, beneficiaryBps: 0 } }, /holder rewards/],
      [{ roundSecs: 3_599 }, /hour to 30 days/],
      [{ minPot: 99_999_999n }, /0\.1 to 1,000 SOL/],
      [{ prizeBps: 999 }, /10% to 100%/],
      [{ claimWindowSecs: 299 }, /5 minutes to a day/],
      [{ maxAttempts: 17 }, /1 to 16/],
      [{ maxAttempts: 0 }, /1 to 16/],
      // 8 windows of 1,800 s take 4 h: more than half a 6-hour round.
      [{ claimWindowSecs: 1_800 }, /half a round/],
      [{ hook: a.TOKEN_PROGRAM }, /token hook of its own/],
      [{ hook: a.COMPANION_PROGRAM }, /token hook of its own/],
    ];
    for (const [change, why] of bad) expect(gameArgsProblem({ ...ok, ...change }, limits), JSON.stringify(change, (_, v) => (typeof v === 'bigint' ? String(v) : v))).toMatch(why);
    expect(gameArgsProblem(ok, { maxBuyback: 9_999_999n, buybackInterval: 60 })).toMatch(/buyback limits/);
  });

  it('a lottery hook registry resolves for a launch (its seeds name only the mint) to `lotteryHook.accounts`', () => {
    const literal = (t: string) => ({ kind: 'literal' as const, bytes: Buffer.from(t) });
    const list = {
      version: 1,
      accounts: [
        { writable: true, source: { kind: 'pda' as const, program: HOOK, seeds: [literal('state'), { kind: 'account' as const, index: 1 }] } },
        { writable: false, source: { kind: 'pda' as const, program: a.LAUNCH_PROGRAM, seeds: [literal('launch'), { kind: 'account' as const, index: 1 }] } },
      ],
    };
    const decoded = decodeHookAccountList(encodeHookAccountList(list))!;
    expect(resolveCustomHookAccounts(HOOK, decoded, K.mint)).toEqual(lotteryHook.accounts(K.mint));
  });
});
