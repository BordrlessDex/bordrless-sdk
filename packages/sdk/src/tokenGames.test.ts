/**
 * §7.6 (docs/token-quotes.md §7.6.9): games, Lossback and scripts with a launcher's part on coins quoted in tokens. Every builder against
 * the regenerated IDLs (the accounts' names, order and marks, the event accounts, the discriminator, the arguments), the remaining
 * accounts as the companion's client lays them (`token_pot_accounts`, `leg_prize_accounts`, `leg_fee_accounts`), the hand-read bytes
 * (`Game` 452, `LegPot` 187 and 195, `Record` 54, `LossCoverState` 210, the script's `LegRound`s, `PayoutAnswerLegs`), the thresholds'
 * arithmetic, and the five events typed through the IDL coder.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import * as a from './addresses.ts';
import { CODERS, IDL } from './coders.ts';
import { decodeEventPayload } from './events.ts';
import { companion, companionLegsAddress, decodeCompanionLegs, decodeGame, COMPANION_LEGS_LEN, HOOK_TERMS_DEFAULT } from './companion.ts';
import { legFeesAddress, legsAddress, tokenLaunch, type LegKeys } from './legs.ts';
import { lotteryHook } from './lotteryHook.ts';
import { studioGameHook } from './gameKinds.ts';
import {
  COVER_STATE_LEN_LEGS,
  LOSS_COVER_STATE_LEN,
  NO_LOSS_COVER_RECORD,
  PAYOUT_ANSWER_LEGS_VERSION,
  decodeCoverLegRounds,
  decodeCoverRoundLegEvent,
  decodeLossCoverRecord,
  decodeLossCoverState,
  decodePayoutAnswerLegs,
  decodeScriptAnswer,
  encodeLossCoverRecord,
  encodeLossCoverState,
  encodePayoutAnswerLegs,
  encodePayoutAnswer,
  lossCoverHook,
  lossCoverLegRoundsAt,
  lossCoverLegsPaying,
  lossCoverMinLossOfCost,
} from './lossCover.ts';
import {
  LOTTERY_TOKEN_FLOAT_LAMPORTS,
  PART_POT,
  TOKEN_DEFAULT_CAP_BPS,
  TOKEN_MIN_MIN_POT_BPS,
  gameInTokens,
  gameMinPotBpsAt,
  hookCapBps,
  lamportsAsBps,
  legCapOf,
  legFeeAccounts,
  legPrizeAccounts,
  legPrizeLeft,
  legPrizeOf,
  lossCoverTokenStepHead,
  tokenDrawThresholdBps,
  tokenPotAccounts,
  tokenPotBps,
  typedTokenGameEvent,
  withAccounts,
} from './tokenGames.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
type Program = 'companion' | 'lotteryHook' | 'lossCoverHook';
interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
}
const PROGRAM_OF: Record<Program, PublicKey> = { companion: a.COMPANION_PROGRAM, lotteryHook: a.LOTTERY_HOOK_PROGRAM, lossCoverHook: a.LOSS_COVER_HOOK_PROGRAM };
const instructionOf = (program: Program, name: string) => (IDL[program] as unknown as { instructions: { name: string; discriminator: number[]; accounts: IdlAccount[]; args: { name: string }[] }[] }).instructions.find((i) => i.name === name)!;

/** The builder's named accounts against the IDL's (order and marks, fixed addresses, the event accounts last, the discriminator); what follows them. */
function heldToIdl(ix: TransactionInstruction, program: Program, name: string): TransactionInstruction['keys'] {
  const idl = instructionOf(program, name);
  expect(ix.programId.equals(PROGRAM_OF[program]), name).toBe(true);
  expect(ix.keys.length).toBeGreaterThanOrEqual(idl.accounts.length);
  idl.accounts.forEach((acc, i) => {
    const meta = ix.keys[i]!;
    expect([meta.isWritable, meta.isSigner], `${name} #${i} ${acc.name}`).toEqual([acc.writable === true, acc.signer === true]);
    if (acc.address) expect(meta.pubkey.toBase58(), `${name} ${acc.name}`).toBe(acc.address);
  });
  expect(ix.keys[idl.accounts.length - 2]!.pubkey.equals(a.eventAuthority(ix.programId))).toBe(true);
  expect(ix.keys[idl.accounts.length - 1]!.pubkey.equals(ix.programId)).toBe(true);
  expect([...ix.data.subarray(0, 8)], name).toEqual(idl.discriminator);
  return ix.keys.slice(idl.accounts.length);
}
const keysOf = (metas: readonly { pubkey: PublicKey }[]): string[] => metas.map((m) => m.pubkey.toBase58());
const legKeys = (mint: PublicKey, over: Partial<LegKeys> = {}): LegKeys => ({ mint, quoteMint: k(), quoteProgram: a.SPL_TOKEN_PROGRAM, lpFeeBps: 30, ...over });

describe('§7.6.9 builders against the IDLs', () => {
  it('set_game_token_terms: the mint signs, the game writable, min_pot_bps a u16; out of bounds refused before anything is sent', () => {
    const mint = k();
    const ix = companion.setGameTokenTerms(mint, 100);
    expect(heldToIdl(ix, 'companion', 'set_game_token_terms')).toEqual([]);
    expect(keysOf(ix.keys.slice(0, 3))).toEqual(keysOf([{ pubkey: mint }, { pubkey: a.companionAddress(mint) }, { pubkey: a.gameAddress(mint) }]));
    expect(ix.data.readUInt16LE(8)).toBe(100);
    expect(ix.data.length).toBe(10);
    expect(() => companion.setGameTokenTerms(mint, 10_001)).toThrow();
    expect(companion.setGameTokenTerms(mint, 0).data.readUInt16LE(8)).toBe(0);
  });

  it('launch_token_game: launch_token with the game appended last, read-only', () => {
    const mint = k();
    const creator = a.companionCreatorAddress(mint);
    const args = { name: 'G', symbol: 'G', uri: 'u', creatorFeeBps: 100, virtualQuotes: [1_000_000n, 2_000_000n], rules: null, payouts: null };
    const create = tokenLaunch.createTokenLaunchWith(creator, mint, k(), args, [k(), k()], k(), { program: a.LOTTERY_HOOK_PROGRAM, extras: lotteryHook.accountsLegs(mint).extras }, { hookTimelocked: false });
    const plain = companion.launchToken(k(), mint, create, args);
    const game = companion.launchTokenGame(plain.keys[0]!.pubkey, mint, create, args);
    heldToIdl(game, 'companion', 'launch_token');
    expect(game.keys.length).toBe(plain.keys.length + 1);
    expect(game.keys.at(-1)).toEqual({ pubkey: a.gameAddress(mint), isSigner: false, isWritable: true });
    expect(game.data.equals(plain.data)).toBe(true);
  });

  it('the game steps take the pots, the prize accounts per leg in leg order, and the leg fee accounts, as the client lays them', () => {
    const mint = k();
    const winner = k();
    const cranker = k();
    const quotes = [{ quoteMint: k(), quoteProgram: a.SPL_TOKEN_PROGRAM }, { quoteMint: k(), quoteProgram: a.SPL_TOKEN_2022_PROGRAM }];
    expect(tokenPotAccounts(mint)).toEqual([{ pubkey: companionLegsAddress(mint), isSigner: false, isWritable: true }, { pubkey: legsAddress(mint), isSigner: false, isWritable: false }]);
    const creator = a.companionCreatorAddress(mint);
    const ata = (o: PublicKey, q: (typeof quotes)[number]) => a.associatedTokenAddress(o, q.quoteMint, q.quoteProgram).toBase58();
    const withBounty = legPrizeAccounts(mint, quotes, winner, cranker, true);
    expect(keysOf(withBounty)).toEqual([
      companionLegsAddress(mint).toBase58(),
      legsAddress(mint).toBase58(),
      ...quotes.flatMap((q) => [q.quoteMint.toBase58(), ata(creator, q), ata(winner, q), ata(cranker, q)]),
      a.SPL_TOKEN_PROGRAM.toBase58(),
      a.SPL_TOKEN_2022_PROGRAM.toBase58(),
      a.ATA_PROGRAM.toBase58(),
      winner.toBase58(),
    ]);
    expect(withBounty.map((m) => m.isWritable)).toEqual([true, false, false, true, true, true, false, true, true, true, false, false, false, true]);
    expect(withBounty.some((m) => m.isSigner)).toBe(false);
    expect(legPrizeAccounts(mint, quotes, winner, cranker, false).length).toBe(withBounty.length - quotes.length);
    // Review 5: two a leg, the leg's fee account and the creator address's account of its token, both read-only.
    expect(keysOf(legFeeAccounts(mint, quotes))).toEqual(quotes.flatMap((q) => [legFeesAddress(mint, q.quoteMint).toBase58(), ata(creator, q)]));
    expect(legFeeAccounts(mint, quotes).some((m) => m.isWritable || m.isSigner)).toBe(false);
    // A prize claim of a game in tokens: the lottery's `claim_prize` with them appended; nothing named twice, a writable mark kept.
    const base = companion.claimPrize(cranker, mint, a.LOTTERY_HOOK_PROGRAM, 0, winner);
    const fresh = withBounty.filter((m) => !base.keys.some((b) => b.pubkey.equals(m.pubkey))).length;
    const before = base.keys.length;
    const claim = withAccounts(base, legPrizeAccounts(mint, quotes, winner, cranker, true));
    heldToIdl(claim, 'companion', 'claim_prize');
    expect(claim.keys.length).toBe(before + fresh);
    expect(claim.keys.find((m) => m.pubkey.equals(companionLegsAddress(mint)))!.isWritable).toBe(true);
    // Every step of a game in tokens reads the pots: a draw with them.
    const draw = withAccounts(companion.draw(cranker, mint, a.LOTTERY_HOOK_PROGRAM, 7, { slot: 1n, hash: new Uint8Array(32) } as never, k()), tokenPotAccounts(mint));
    heldToIdl(draw, 'companion', 'draw');
    expect(draw.keys.some((m) => m.pubkey.equals(legsAddress(mint)))).toBe(true);
  });

  it('swap_bucket_to_sol part 2 (a game pot) encodes its part', () => {
    const mint = k();
    const ix = companion.swapBucketToSol(k(), legKeys(mint), 1, PART_POT, []);
    heldToIdl(ix, 'companion', 'swap_bucket_to_sol');
    expect([ix.data[8], ix.data[9]]).toEqual([1, 2]);
  });

  it('the hooks learn the legs: the lottery, Lossback and the Studio starters prepare_legs and their registries', () => {
    const mint = k();
    const payer = k();
    const lottery = lotteryHook.prepareLegs(payer, mint, 3_600);
    expect(heldToIdl(lottery, 'lotteryHook', 'prepare_legs')).toEqual([]);
    expect(lottery.data.readUInt32LE(8)).toBe(3_600);
    expect(keysOf(lotteryHook.accountsLegs(mint).extras)).toEqual(keysOf([...lotteryHook.accounts(mint).extras, { pubkey: legsAddress(mint) }]));
    const pools = [k(), k(), k()];
    const loss = lossCoverHook.prepareLegs(payer, mint, pools);
    expect(keysOf(heldToIdl(loss, 'lossCoverHook', 'prepare_legs'))).toEqual(pools.map((p) => p.toBase58()));
    expect(loss.keys.slice(-3).every((m) => !m.isWritable && !m.isSigner)).toBe(true);
    expect(() => lossCoverHook.prepareLegs(payer, mint, [])).toThrow();
    // The registry: the state (w), the launch, leg 0's pool, the Legs, the other legs' pools (`extras_legs`).
    const extras = lossCoverHook.extrasLegs(mint, pools);
    expect(keysOf(extras)).toEqual(keysOf([{ pubkey: a.lossCoverStateAddress(mint) }, { pubkey: a.launchAddress(mint) }, { pubkey: pools[0]! }, { pubkey: legsAddress(mint) }, { pubkey: pools[1]! }, { pubkey: pools[2]! }]));
    expect(extras.map((m) => m.isWritable)).toEqual([true, false, false, false, false, false]);
    // The starters: `prepare_legs` is sha256("global:prepare_legs")[..8], the same accounts as `prepare`.
    const hook = k();
    const starter = studioGameHook.prepareLegs(hook, payer, mint);
    expect([...starter.data]).toEqual([0x94, 0x76, 0x16, 0x5d, 0x1c, 0x53, 0xd4, 0x19]);
    expect(keysOf(starter.keys)).toEqual(keysOf(studioGameHook.prepare(hook, payer, mint).keys));
    expect(keysOf(studioGameHook.accountsLegs(hook, mint).extras)).toEqual(keysOf([...studioGameHook.accounts(hook, mint).extras, { pubkey: legsAddress(mint) }]));
  });
});

describe('§7.6.9 accounts read by hand', () => {
  /** A zeroed account of the companion's `type` with its discriminator. */
  const blank = (name: string): Buffer => {
    const coder = CODERS.companion.accounts as unknown as { size: (n: string) => number; accountLayouts: Map<string, { discriminator: number[] }> };
    const d = Buffer.alloc(coder.size(name));
    Buffer.from(coder.accountLayouts.get(name)!.discriminator).copy(d, 0);
    return d;
  };
  it('Game: min_pot_bps at byte 452 (reserved[0..2] of the 486-byte Game)', () => {
    const d = blank('game');
    expect(d.length).toBe(486);
    expect(decodeGame(d).minPotBps).toBe(0);
    d.writeUInt16LE(100, 452);
    // Terms alone (set before a SOL coin's launch) never count: only launch_token's mark at byte 454 does (review 5, F4).
    expect([decodeGame(d).minPotBps, gameInTokens(decodeGame(d))]).toEqual([100, false]);
    d[454] = 1;
    const g = decodeGame(d);
    expect([g.minPotBps, g.launchedInTokens]).toEqual([100, true]);
    expect(gameInTokens(g)).toBe(true);
  });
  it('LegPot: prize at 187 and prize_paid at 195 of each 203-byte leg; CompanionLegs stays 1,293 B', () => {
    expect(COMPANION_LEGS_LEN).toBe(1_293);
    const d = blank('companionLegs');
    const mint = k();
    mint.toBuffer().copy(d, 10);
    d[42] = 2;
    d.writeBigUInt64LE(5_000n, 43 + 203 + 187);
    d.writeBigUInt64LE(1_200n, 43 + 203 + 195);
    d.writeBigUInt64LE(9_999n, 43 + 203 + 59);
    const legs = decodeCompanionLegs(d);
    expect(legs.count).toBe(2);
    expect([legs.legs[1]!.prize, legs.legs[1]!.prizePaid, legs.legs[1]!.pendingPot]).toEqual([5_000n, 1_200n, 9_999n]);
    expect(legPrizeLeft(legs.legs[1]!)).toBe(3_800n);
    expect(legPrizeLeft(legs.legs[0]!)).toBe(0n);
  });
  it('Lossback: Record.leg at byte 54, LossCoverState legs at 210, the script\'s LegRounds at 128 + 36·i', () => {
    const rec = encodeLossCoverRecord({ ...NO_LOSS_COVER_RECORD, version: 1, entry: 7n, amount: 9n, leg: 4 });
    expect(rec[54]).toBe(4);
    expect(decodeLossCoverRecord(rec).leg).toBe(4);
    expect(decodeLossCoverRecord(encodeLossCoverRecord({ ...NO_LOSS_COVER_RECORD, version: 1 })).leg).toBe(0);
    const state = encodeLossCoverState({ version: 1, bump: 255, mint: k(), launch: k(), pool: k(), creator: k(), reference: 0n, referenceAt: 0, paidTotal: 0n, records: 0n, preparedBy: k(), preparedAt: 0, legCount: 3 });
    expect(state.length).toBe(LOSS_COVER_STATE_LEN);
    expect(state[210]).toBe(3);
    expect(decodeLossCoverState(state).legCount).toBe(3);
    const s = Buffer.alloc(COVER_STATE_LEN_LEGS);
    s.writeBigUInt64LE(100n, 128 + 36);
    s.writeBigUInt64LE(40n, 128 + 36 + 8);
    s.writeBigUInt64LE(30n, 128 + 36 + 16);
    s.writeBigUInt64LE(20n, 128 + 36 + 24);
    s.writeUInt32LE(6, 128 + 36 + 32);
    expect(decodeCoverLegRounds(s, 2)).toEqual([{ b: 0n, lPrev: 0n, lCur: 0n, roundPaid: 0n, measured: 0 }, { b: 100n, lPrev: 40n, lCur: 30n, roundPaid: 20n, measured: 6 }]);
    // As a step at a later round reads them (`step_legs`' roll): the loss carried when the round follows, the budget the leg's pot now.
    const stored = decodeCoverLegRounds(s, 2);
    expect(lossCoverLegRoundsAt({ round: 10, roundSecs: 60 }, stored, [7n, 9n], 10 * 60 + 5)).toEqual(stored);
    expect(lossCoverLegRoundsAt({ round: 10, roundSecs: 60 }, stored, [7n, 9n], 11 * 60)).toEqual([{ b: 7n, lPrev: 0n, lCur: 0n, roundPaid: 0n, measured: 0 }, { b: 9n, lPrev: 30n, lCur: 0n, roundPaid: 0n, measured: 0 }]);
    expect(lossCoverLegRoundsAt({ round: 10, roundSecs: 60 }, stored, [7n, 9n], 12 * 60)[1]!.lPrev).toBe(0n);
    expect([lossCoverLegsPaying(lossCoverLegRoundsAt({ round: 10, roundSecs: 60 }, stored, [7n, 9n], 11 * 60)), lossCoverLegsPaying(stored)]).toEqual([true, true]);
    expect(lossCoverLegsPaying([{ b: 0n, lPrev: 5n, lCur: 0n, roundPaid: 0n, measured: 0 }])).toBe(false);
    // A 128-byte state (a SOL coin's) reads zeros past its end, as `LegRound::read`.
    expect(decodeCoverLegRounds(Buffer.alloc(128), 1)).toEqual([{ b: 0n, lPrev: 0n, lCur: 0n, roundPaid: 0n, measured: 0 }]);
  });
  it('PayoutAnswerLegs: 1 + 4 + 14·n bytes, the leg last in each entry; decodeScriptAnswer reads the version byte', () => {
    const entries = [{ account: 3, amount: 1_000n, tag: 77, leg: 1 }, { account: 5, amount: 2n, tag: 77, leg: 0 }];
    const b = encodePayoutAnswerLegs(entries);
    expect(b.length).toBe(1 + 4 + 14 * 2);
    expect([b[0], b.readUInt32LE(1), b[5], b.readBigUInt64LE(6), b.readUInt32LE(14), b[18]]).toEqual([PAYOUT_ANSWER_LEGS_VERSION, 2, 3, 1_000n, 77, 1]);
    expect(decodePayoutAnswerLegs(b).entries).toEqual(entries);
    expect(decodeScriptAnswer(b)).toEqual({ version: 3, entries });
    expect(decodeScriptAnswer(encodePayoutAnswer({ version: 1, entries: [{ account: 1, lamports: 5n, tag: 2 }] })).version).toBe(1);
    expect(() => decodePayoutAnswerLegs(b.subarray(0, b.length - 1))).toThrow('BadPayoutAnswer');
  });
  it('CoverRoundLeg: the script\'s event (mint, round, leg, b, l_prev) by the IDL\'s layout', () => {
    const mint = k();
    const body = (CODERS.lossCoverScript.types as unknown as { encode: (n: string, v: unknown) => Buffer }).encode('coverRoundLeg', { mint, round: 9, leg: 2, b: new BN(500), lPrev: new BN(800) });
    expect(decodeCoverRoundLegEvent(body)).toEqual({ mint, round: 9, leg: 2, b: 500n, lPrev: 800n });
  });
});

describe('§7.6.9 thresholds: shares of the opening value, no price read', () => {
  it('the pot as a share of the opening value, summed over the legs', () => {
    // Two legs, each opening at 1,000,000 raw: 10,000 raw on one is 1% of that leg's half, 0.5% of the coin.
    expect(tokenPotBps([{ pendingPot: 10_000n }, { pendingPot: 0n }], [1_000_000n, 1_000_000n])).toBe(50n);
    expect(tokenPotBps([{ pendingPot: 10_000n }, { pendingPot: 20_000n }], [1_000_000n, 2_000_000n])).toBe(100n);
    expect(tokenPotBps([{ pendingPot: 5n }], [0n])).toBe(0n);
  });
  it('the cap: 10 SOL reads as 2,000 bps of a 50 SOL scale; each leg keeps its share of it', () => {
    expect(lamportsAsBps(10_000_000_000n)).toBe(2_000n);
    expect(lamportsAsBps(100_000_000n)).toBe(BigInt(TOKEN_MIN_MIN_POT_BPS));
    expect(TOKEN_DEFAULT_CAP_BPS).toBe(2_000n);
    expect(hookCapBps(HOOK_TERMS_DEFAULT)).toBe(2_000n);
    expect(hookCapBps({ ...HOOK_TERMS_DEFAULT, audited: true })).toBeNull();
    expect(legCapOf(2_000n, 1_000_000n)).toBe(200_000n);
    expect(tokenDrawThresholdBps(HOOK_TERMS_DEFAULT, 100n)).toBe(100n);
    expect(tokenDrawThresholdBps({ ...HOOK_TERMS_DEFAULT, potCap: 1_000_000_000n }, 500n)).toBe(200n);
  });
  it('a dormant game\'s floor is 20 bps; a prize is prize_bps of each leg\'s pot', () => {
    const g = { settledAt: 0, roundSecs: 3_600, minPotBps: 100 };
    expect(gameMinPotBpsAt(g, 1_000, 0)).toBe(100n);
    expect(gameMinPotBpsAt(g, 10 ** 9, 0)).toBe(20n);
    expect(gameMinPotBpsAt({ ...g, minPotBps: 10 }, 10 ** 9, 0)).toBe(10n);
    expect(legPrizeOf(1_000n, 5_000)).toBe(500n);
    expect(LOTTERY_TOKEN_FLOAT_LAMPORTS).toBe(20_000_000n);
  });
  it('Lossback\'s least loss on a coin quoted in tokens: basis points of the holding\'s cost, at least 1', () => {
    // entry 2 raw per base unit (×10^12), 1,000 coins of 9 decimals (10^12 base units): a cost of 2×10^12 raw; 50 bps of it 10^10.
    expect(lossCoverMinLossOfCost(2_000_000_000_000n, 1_000_000_000_000n, 50)).toBe(10_000_000_000n);
    expect(lossCoverMinLossOfCost(1n, 1n, 50)).toBe(1n);
    expect(lossCoverMinLossOfCost(10n ** 12n, 100n, 20_000)).toBe(100n);
  });
});

describe('§7.6.9 Lossback step accounts and events', () => {
  it('a step on a coin quoted in tokens carries the payout accounts, the legs, the pools, each leg\'s token and the creator address\'s account of it, both programs', () => {
    const mint = k();
    const legs = [{ quoteMint: k(), quoteProgram: a.SPL_TOKEN_PROGRAM, pool: k() }, { quoteMint: k(), quoteProgram: a.SPL_TOKEN_2022_PROGRAM, pool: k() }];
    const head = lossCoverTokenStepHead(mint, a.LOSS_COVER_HOOK_PROGRAM, legs);
    const payout = companion.payoutAccounts(mint, a.LOSS_COVER_HOOK_PROGRAM);
    const creator = a.companionCreatorAddress(mint);
    expect(keysOf(head)).toEqual([
      ...keysOf(payout),
      companionLegsAddress(mint).toBase58(),
      legsAddress(mint).toBase58(),
      ...legs.map((l) => l.pool.toBase58()),
      ...legs.flatMap((l) => [l.quoteMint.toBase58(), a.associatedTokenAddress(creator, l.quoteMint, l.quoteProgram).toBase58()]),
      a.SPL_TOKEN_PROGRAM.toBase58(),
      a.SPL_TOKEN_2022_PROGRAM.toBase58(),
    ]);
    expect(head.find((m) => m.pubkey.equals(companionLegsAddress(mint)))!.isWritable).toBe(true);
    expect(head.some((m) => m.isSigner)).toBe(false);
  });
  it('the five events typed through the companion IDL coder', () => {
    const idl = IDL.companion as unknown as { events: { name: string; discriminator: number[] }[] };
    const types = CODERS.companion.types as unknown as { encode: (n: string, v: unknown) => Buffer };
    const enc = (name: string, data: Record<string, unknown>): Buffer => Buffer.concat([Buffer.from(idl.events.find((e) => e.name === name)!.discriminator), types.encode(name.charAt(0).toLowerCase() + name.slice(1), data)]);
    const read = (name: string, data: Record<string, unknown>) => typedTokenGameEvent({ program: 'companion', ...decodeEventPayload('companion', enc(name, data))! } as never);
    const game = k();
    const mint = k();
    const c = k();
    const owner = k();
    expect(read('GameTokenTermsSet', { game, mint, minPotBps: 100 })).toEqual({ kind: 'companion.GameTokenTermsSet', game: game.toBase58(), mint: mint.toBase58(), minPotBps: 100 });
    expect(read('LegPrizesFixed', { game, mint, round: 4, kind: 2, prizes: [new BN(5), new BN(6)], potBps: new BN(150) })).toEqual({ kind: 'companion.LegPrizesFixed', game: game.toBase58(), mint: mint.toBase58(), round: 4, prizeKind: 'share', prizes: [5n, 6n], potBps: 150n });
    expect(read('LegPrizePaid', { companion: c, index: 1, quoteMint: mint, kind: 1, owner, amount: new BN(990), bounty: new BN(10) })).toEqual({ kind: 'companion.LegPrizePaid', companion: c.toBase58(), index: 1, quoteMint: mint.toBase58(), prizeKind: 'settle', owner: owner.toBase58(), amount: 990n, bounty: 10n });
    expect(read('LegPotToBuyback', { companion: c, index: 0, amount: new BN(7), reason: 1, pendingPot: new BN(0) })).toEqual({ kind: 'companion.LegPotToBuyback', companion: c.toBase58(), index: 0, amount: 7n, reason: 'blocked', pendingPot: 0n });
    expect(read('LegScriptPayout', { companion: c, index: 2, holding: game, owner, amount: new BN(33), tag: 12 })).toEqual({ kind: 'companion.LegScriptPayout', companion: c.toBase58(), index: 2, holding: game.toBase58(), owner: owner.toBase58(), amount: 33n, tag: 12 });
    expect(typedTokenGameEvent({ program: 'launch', name: 'legPrizePaid', data: {} })).toBeNull();
  });
});
