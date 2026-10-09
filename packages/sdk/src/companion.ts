/**
 * Companions (programs/bordrless_companion, docs/companions.md): a launch whose creator is a program.
 * The companion creates the launch with its creator address (`companionCreatorAddress`) as the
 * creator, so every creator fee lands with it, and its code alone decides what happens to it: bought
 * back and burned, streamed to holders through the kit, or paid to the launcher (the beneficiary),
 * by a split fixed at `create`. The launcher's own buy (`devBuy`) is held by the companion and vests
 * to them (`release`). Every step but `devBuy` is permissionless and pays its sender a bounty.
 *
 * Each step's remaining accounts are the accounts of the instructions it invokes, built with the
 * same builders the program uses on chain; the program looks them up by key. The creator address
 * signs only inside the program, so it is never marked a signer here. Mirrors
 * `bordrless_companion::client` account for account (held to it by
 * `packages/sdk/vectors/companion-games.json`, which the programs' `game_vectors` test renders).
 *
 * Games (v2, docs/companions.md "Games"): a companion may run a lottery (`createGame`, before the
 * launch), its tickets kept by the coin's token hook (the lottery hook, `lotteryHook.ts`, under the
 * game ticket standard, `game.ts`), its pot a fourth part of every fee claim, its draws verifiable
 * (ORAO VRF, `orao.ts`). The steps `draw` (which commits the seed and requests it) → `reveal` →
 * `claimPrize` (or `expire`), and `retire` and `burnStranded`, are permissionless; `setHookStatus` is the protocol
 * authority's. A game coin's token moves (`devBuy`, `buyback`, `release`) carry its custom hook:
 * pass `LaunchKeys` with `customHook` (`launchKeysOf(launch, lotteryHook.accounts(mint))`), and the
 * builders add the hook's slice and its registry, which the program resolves the extras from.
 */
import { PublicKey, type AccountMeta, type TransactionInstruction, TransactionInstruction as Ix } from '@solana/web3.js';
import BN from 'bn.js';
import { COMPANION_SPLITS, type CompanionTemplate } from '@bordrless/shared';
import * as a from './addresses.ts';
import { CODERS } from './coders.ts';
import { roundEnd, validRoundSecs } from './game.ts';
import { customHookTokenHook, kitTokenHook, type TokenHook } from './hooks.ts';
import { PROTOCOL_PROGRAMS } from './inspect.ts';
import { bridge, kit, launch, token, type CreateLaunchArgs, type LaunchKeys } from './instructions.ts';
import { drawSeed, oraoRequestV2, type SeedSlot } from './orao.ts';

/** What every creator fee claim pays for, in basis points summing to 10,000 (with a game's `potBps`). */
export interface CompanionSplit {
  buybackBps: number;
  holdersBps: number;
  beneficiaryBps: number;
}

/** `create`'s arguments. */
export interface CompanionArgs {
  split: CompanionSplit;
  /** What a step pays whoever sends it, of what it moves: at most 100 (1%). */
  bountyBps: number;
  /** The most one buyback spends, lamports. */
  maxBuyback: bigint;
  /** The least time between buybacks, seconds (at least 60). */
  buybackInterval: number;
  /** The dev bag vests over this many seconds from the launch (at most a year). */
  vestSecs: number;
  /** Lamports for the creator address: the launch's fee and rent, and its own rent-exempt minimum. */
  fund: bigint;
}

export interface Companion {
  mint: PublicKey;
  beneficiary: PublicKey;
  split: CompanionSplit;
  bountyBps: number;
  maxBuyback: bigint;
  buybackInterval: number;
  vestSecs: number;
  launched: boolean;
  launchedAt: number;
  devTokens: bigint;
  devReleased: bigint;
  pendingBuyback: bigint;
  pendingHolders: bigint;
  pendingBeneficiary: bigint;
  lastBuybackAt: number;
  claimedTotal: bigint;
  spentTotal: bigint;
  burnedTotal: bigint;
  sharedTotal: bigint;
  paidBeneficiaryTotal: bigint;
  bountiesTotal: bigint;
  /** The buyback's reference price (quote per base unit times 10^12) and when it last moved. */
  referencePrice: bigint;
  referenceAt: number;
  /** v2: the game's token hook (`createGame`); null for a companion without a game (every v1 companion reads null). */
  gameHook: PublicKey | null;
  /** v2: the pot's part of every fee claim, next to `split` (the four sum to 10,000); 0 without a game. */
  potBps: number;
  /** v2: bridged SOL held for the game's pot (in the creator's holding). */
  pendingPot: bigint;
  /** v2: the game's round length (its hook's header must state it); 0 without a game. */
  roundSecs: number;
  /** v2: when `burnStranded` last burned a blocked game's buyback, a blocked game's pot last moved into the buyback, or a blocked game's fee claim last credited the buyback at least what it held (0: never); the next burn waits its whole period from here. */
  strandedBurnedAt: number;
}

/**
 * The three preset splits (any split summing to 10,000 works; the launch form offers any in 10% steps): buysItself (every creator fee bought back and
 * burned, no dev at all), rugProofDev (half to holders through the kit, half to the dev, whose buy
 * vests; holder rewards needed), buybackAndReward (half bought back and burned, half to holders;
 * holder rewards needed). The list is `COMPANION_SPLITS` in @bordrless/shared, which the site reads.
 */
export const COMPANION_TEMPLATES: Readonly<Record<CompanionTemplate, Readonly<CompanionSplit>>> = COMPANION_SPLITS;

/** The defaults Studio offers with a template: a 0.5% bounty, buybacks of at most 1 SOL a minute apart, a 30-day vest. */
export const COMPANION_DEFAULTS = { bountyBps: 50, maxBuyback: 1_000_000_000n, buybackInterval: 60, vestSecs: 30 * 86_400 } as const;

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const big = (v: unknown): bigint => BigInt(String(v));
const num = (v: unknown): number => Number(String(v));
const bn = (v: bigint | number): BN => new BN(v.toString());

/** An instruction's accounts and program as remaining accounts: nobody marked a signer but `keep`. */
function remaining(inner: TransactionInstruction, keep: PublicKey[] = []): AccountMeta[] {
  return [...inner.keys.map((m) => ({ pubkey: m.pubkey, isSigner: m.isSigner && keep.some((k) => k.equals(m.pubkey)), isWritable: m.isWritable })), ro(inner.programId)];
}

function build(name: string, args: Record<string, unknown>, named: AccountMeta[], extra: AccountMeta[]): TransactionInstruction {
  const keys = [...named, ro(a.COMPANION_EVENT_AUTHORITY), ro(a.COMPANION_PROGRAM), ...extra];
  return new Ix({ programId: a.COMPANION_PROGRAM, keys, data: CODERS.companion.instruction.encode(name, args) });
}

/**
 * The launch's mint as token instructions take it: a game coin's custom hook (`keys.customHook`)
 * with its extras; else the kit with its extras with kit rules; else none (`steps.rs` `token_hook`).
 */
const mintHook = (keys: LaunchKeys, rewards: boolean): TokenHook | null => {
  if (keys.customHook) return customHookTokenHook(keys.customHook);
  return keys.modules === 0 ? null : kitTokenHook(keys.mint, rewards ? a.holderVaultAddress(keys.mint, keys.quoteMint) : null);
};
/** A custom hook's registry for the mint, appended to every step that moves the token: the program resolves the hook's extras from it. None for a kit (or hook-less) token. */
const hookRegistry = (keys: LaunchKeys): AccountMeta[] => (keys.customHook ? [ro(a.registryAddress(keys.customHook.program, keys.mint))] : []);

const step = (cranker: PublicKey, mint: PublicKey): AccountMeta[] => [rw(cranker, true), rw(a.companionAddress(mint)), rw(a.companionCreatorAddress(mint)), ro(a.launchAddress(mint)), ro(a.SYSTEM_PROGRAM)];
const unwrapAccounts = (creator: PublicKey): AccountMeta[] => remaining(bridge.unwrapSol(creator, 0n));

/** The named accounts of `draw`, `reveal`, `expire` and `retire` (`GameStep`). */
const gameStep = (cranker: PublicKey, mint: PublicKey, hook: PublicKey): AccountMeta[] => [
  rw(cranker, true),
  rw(a.companionAddress(mint)),
  rw(a.companionCreatorAddress(mint)),
  rw(a.gameAddress(mint)),
  ro(a.hookStatusAddress(hook)),
  rw(a.oraclePayerAddress(mint)),
  ro(a.SYSTEM_PROGRAM),
];

const ZERO_SEED = new Uint8Array(32);
const isZero = (seed: Uint8Array): boolean => seed.every((b) => b === 0);

// ---- games: settings -------------------------------------------------------------------------------

/** The kinds of game a companion runs (`GameKind`); phase 1 has the lottery. A kind added later is appended. */
export type GameKind = 'lottery';
/** Where a game's draw is (`DrawStatus`). `committed` is never set: `draw` commits its seed and requests it in one instruction (the variant keeps its number). */
export type DrawStatus = 'idle' | 'committed' | 'requested' | 'revealed';
/** Why a round paid no prize (`RolloverReason`, the `RolledOver` event's `reason`). */
export const ROLLOVER_REASONS = ['noTickets', 'roundForgotten', 'noClaim', 'oracleSilent', 'blocked', 'late', 'oracleUnreadable', 'oracleUnpaid'] as const;
export type RolloverReason = (typeof ROLLOVER_REASONS)[number];

/** `create_game`'s arguments. */
export interface GameArgs {
  kind: GameKind;
  /** The coin's token hook, prepared for the mint with `roundSecs` (the lottery hook, or one the protocol vetted); the launch's config must name it. */
  hook: PublicKey;
  /** Every fee claim's split with the pot's part: the four sum to 10,000; no holders' part (a game coin has no kit). Replaces `create`'s. */
  split: CompanionSplit;
  potBps: number;
  /** An hour to 30 days, as the hook's header says. */
  roundSecs: number;
  /** No draw while the pot holds less: 0.1 to 1,000 SOL. */
  minPot: bigint;
  /** The part of the pot one draw pays: 10% to 100%. */
  prizeBps: number;
  /** How long each claim attempt is open: 5 minutes to a day. */
  claimWindowSecs: number;
  /** Attempts per draw, 1 to 16, all within half a round. */
  maxAttempts: number;
}

/**
 * The program's game limits (`constants.rs`): the pot cap of a hook not audited (10 SOL, never
 * more; the protocol may set 0.1 to 10 SOL), the minimum pot's bounds, the least prize, the claim
 * window's bounds, the most attempts, the share of a round the attempts may take (half), what a
 * draw leaves the reveal before its last claim window (10 minutes), how old the slot a draw's seed
 * is made from may be (3 slots, `oracle::SEED_SLOTS`), dormancy (30 days or 4 rounds; retired
 * after 2 dormant periods), the most registry extras a game hook may list besides the launch, and
 * the stranded-buyback wait.
 */
export const GAME_LIMITS = {
  defaultPotCap: 10_000_000_000n,
  minPotCap: 100_000_000n,
  minMinPot: 100_000_000n,
  maxMinPot: 1_000_000_000_000n,
  minPrizeBps: 1_000,
  minClaimWindowSecs: 300,
  maxClaimWindowSecs: 86_400,
  maxAttempts: 16,
  claimsPerRound: 2,
  revealSecs: 600,
  seedSlots: 3,
  dormantSecs: 30 * 86_400,
  dormantRounds: 4,
  retireDormantPeriods: 2,
  maxGameHookExtras: 3,
  strandedSecs: 30 * 86_400,
  strandedIntervals: 4,
  maxBountyBps: 100,
} as const;

/** The lottery the launch page offers (spec example 1): 70% of fees to the pot, 30% bought back; 6-hour rounds; draws from 0.5 SOL paying the whole pot; 8 attempts of 10 minutes. */
export const LOTTERY_DEFAULTS = {
  split: { buybackBps: 3_000, holdersBps: 0, beneficiaryBps: 0 },
  potBps: 7_000,
  roundSecs: 21_600,
  minPot: 500_000_000n,
  prizeBps: 10_000,
  claimWindowSecs: 600,
  maxAttempts: 8,
} as const;

/**
 * Why `create_game` would refuse these settings for a companion with these buyback limits, in the
 * words the launch form and the backend can show; null when it would not (`process_create_game`'s
 * checks on its arguments; the hook's state, registry and status are checked on chain).
 */
export function gameArgsProblem(args: GameArgs, c: Pick<CompanionArgs, 'maxBuyback' | 'buybackInterval'>): string | null {
  const s = args.split;
  if (args.kind !== 'lottery') return 'Phase 1 runs lotteries only.';
  if (!(args.potBps > 0) || s.buybackBps + s.holdersBps + s.beneficiaryBps + args.potBps !== 10_000) return 'The pot’s part and the split must add up to 10,000 basis points, with a pot.';
  if (s.holdersBps !== 0) return 'A game coin runs its own hook, so it has no holder rewards: no holders’ part.';
  if (c.maxBuyback < 10_000_000n || c.buybackInterval < 60 || c.buybackInterval > 30 * 86_400) return 'A game needs buyback limits: a cap of at least 0.01 SOL and a minute to 30 days between buybacks.';
  if (!validRoundSecs(args.roundSecs)) return 'A round lasts an hour to 30 days.';
  if (args.minPot < GAME_LIMITS.minMinPot || args.minPot > GAME_LIMITS.maxMinPot) return 'The minimum pot is 0.1 to 1,000 SOL.';
  if (args.prizeBps < GAME_LIMITS.minPrizeBps || args.prizeBps > 10_000) return 'A draw pays 10% to 100% of the pot.';
  if (args.claimWindowSecs < GAME_LIMITS.minClaimWindowSecs || args.claimWindowSecs > GAME_LIMITS.maxClaimWindowSecs) return 'A claim window lasts 5 minutes to a day.';
  if (!(args.maxAttempts >= 1 && args.maxAttempts <= GAME_LIMITS.maxAttempts)) return 'A draw makes 1 to 16 attempts.';
  if (args.claimWindowSecs * args.maxAttempts * GAME_LIMITS.claimsPerRound > args.roundSecs) return 'A draw’s attempts must fit in half a round.';
  if ([...PROTOCOL_PROGRAMS, a.COMPANION_PROGRAM, a.ORAO_VRF_PROGRAM].some((p) => p.equals(args.hook))) return 'The game’s hook must be a token hook of its own, not one of Bordrless’s programs.';
  return null;
}

// ---- the builders ----------------------------------------------------------------------------------

export const companion = {
  /** `create`: a companion for `mint` (a fresh keypair, which signs: nobody else can make its companion), `payer` paying its rent and `args.fund`. */
  create(payer: PublicKey, beneficiary: PublicKey, mint: PublicKey, args: CompanionArgs): TransactionInstruction {
    const creator = a.companionCreatorAddress(mint);
    const named = [rw(payer, true), ro(beneficiary), ro(mint, true), rw(a.companionAddress(mint)), rw(creator), ro(a.BRIDGED_SOL_MINT), rw(a.holdingAddress(a.BRIDGED_SOL_MINT, creator)), ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY), ro(a.SYSTEM_PROGRAM)];
    const data = { args: { split: args.split, bountyBps: args.bountyBps, maxBuyback: bn(args.maxBuyback), buybackInterval: new BN(args.buybackInterval), vestSecs: new BN(args.vestSecs), fund: bn(args.fund) } };
    return build('create', data, named, remaining(token.createHolding(payer, a.BRIDGED_SOL_MINT, creator)));
  },
  /**
   * `launch`: `create_launch` through the companion, its creator address the creator. Build
   * `createLaunch` with `companionCreatorAddress(mint)` as the creator; the mint signs. A game
   * companion's launch comes from a `LaunchConfig` naming the game's hook with the lottery flags,
   * its custom hook passed to `createLaunch` (`lotteryHook.accounts(mint)`); its state is among
   * those accounts, so the companion checks it with no account of its own.
   */
  launch(launcher: PublicKey, mint: PublicKey, createLaunch: TransactionInstruction, args: CreateLaunchArgs): TransactionInstruction {
    const named = [ro(launcher, true), rw(a.companionAddress(mint)), rw(a.companionCreatorAddress(mint)), ro(a.LAUNCH_PROGRAM)];
    const inner = createLaunch.keys.map((m) => ({ pubkey: m.pubkey, isSigner: m.isSigner && m.pubkey.equals(mint), isWritable: m.isWritable }));
    const data = { args: { ...args, virtualQuote: bn(args.virtualQuote), rules: { ...args.rules } } };
    return build('launch', data, named, inner);
  },
  /** `dev_buy`: the beneficiary's buy, held by the companion and vesting to them. A game coin's (`keys.customHook`) carries the hook's slice and registry. */
  devBuy(beneficiary: PublicKey, keys: LaunchKeys, lamports: bigint, minOut: bigint): TransactionInstruction {
    const creator = a.companionCreatorAddress(keys.mint);
    const extra = [
      ...remaining(token.createHolding(beneficiary, keys.mint, creator)),
      ...remaining(bridge.wrapSol(creator, lamports)),
      ...remaining(launch.swap(keys, creator, creator, 1, lamports, minOut)),
      ...hookRegistry(keys),
    ];
    const named = [rw(beneficiary, true), rw(a.companionAddress(keys.mint)), rw(creator), ro(a.launchAddress(keys.mint)), ro(a.SYSTEM_PROGRAM)];
    return build('devBuy', { lamports: bn(lamports), minOut: bn(minOut) }, named, extra);
  },
  /**
   * `claim_fees` (anyone): the launch's creator fees claimed, the bounty paid, the rest split (a
   * companion launch never pays a config author). A game companion's claim (`gameHook`:
   * `Companion.gameHook`) passes its hook's status account, which the program requires whether or
   * not it exists, so leaving it out can never lift a cap or a block.
   */
  claimFees(cranker: PublicKey, mint: PublicKey, gameHook: PublicKey | null = null): TransactionInstruction {
    const creator = a.companionCreatorAddress(mint);
    const status = gameHook ? [ro(a.hookStatusAddress(gameHook))] : [];
    return build('claimFees', {}, step(cranker, mint), [...remaining(launch.claimCreatorFees(creator, mint, a.BRIDGED_SOL_MINT)), ...unwrapAccounts(creator), ...status]);
  },
  /**
   * `buyback` (anyone); `rewards`: the launch has holder rewards. It buys at most `maxBuyback` and 1%
   * of the pool's quote side; while the price is more than 3% above the companion's reference price
   * it waits instead (the reference moving toward the price, 5% an interval). A game coin's swap and
   * burn carry its custom hook (`keys.customHook`).
   */
  buyback(cranker: PublicKey, keys: LaunchKeys, rewards: boolean): TransactionInstruction {
    const creator = a.companionCreatorAddress(keys.mint);
    const holding = a.holdingAddress(keys.mint, creator);
    const extra = [
      ...remaining(launch.swap(keys, creator, creator, 1, 0n, 0n)),
      ro(a.poolAddress(keys.mint, keys.quoteMint, keys.lpFeeBps, a.LAUNCH_PROGRAM)),
      ...remaining(token.createHolding(cranker, keys.mint, creator)),
      ...remaining(token.burn(creator, holding, keys.mint, 0n, mintHook(keys, rewards))),
      ...unwrapAccounts(creator),
      ...hookRegistry(keys),
    ];
    return build('buyback', {}, step(cranker, keys.mint), extra);
  },
  /** `share` (anyone): the holders' part into the kit's reward pool. */
  share(cranker: PublicKey, mint: PublicKey): TransactionInstruction {
    const creator = a.companionCreatorAddress(mint);
    const source = a.holdingAddress(a.BRIDGED_SOL_MINT, creator);
    return build('share', {}, step(cranker, mint), [...remaining(kit.share(creator, mint, source, a.BRIDGED_SOL_MINT, 0n)), ...unwrapAccounts(creator)]);
  },
  /** `withdraw` (anyone): pays the companion's beneficiary their part as SOL. */
  withdraw(sender: PublicKey, mint: PublicKey, beneficiary: PublicKey): TransactionInstruction {
    const creator = a.companionCreatorAddress(mint);
    return build('withdraw', {}, [ro(sender, true), rw(a.companionAddress(mint)), rw(creator), rw(beneficiary), ro(a.SYSTEM_PROGRAM)], unwrapAccounts(creator));
  },
  /** `withdraw` before the launch, signed by the mint: the creator address's funding back to the beneficiary (a launch that never happened). */
  refund(sender: PublicKey, mint: PublicKey, beneficiary: PublicKey): TransactionInstruction {
    const ix = companion.withdraw(sender, mint, beneficiary);
    ix.keys.push(ro(mint, true));
    return ix;
  },
  /** `release` (anyone): the dev bag's vested tokens to the beneficiary; a game coin's transfer carries its custom hook (`keys.customHook`). */
  release(cranker: PublicKey, keys: LaunchKeys, rewards: boolean, beneficiary: PublicKey): TransactionInstruction {
    const creator = a.companionCreatorAddress(keys.mint);
    const transfer = token.transfer(creator, a.holdingAddress(keys.mint, creator), a.holdingAddress(keys.mint, beneficiary), keys.mint, 0n, mintHook(keys, rewards));
    return build('release', {}, step(cranker, keys.mint), [...remaining(token.createHolding(cranker, keys.mint, beneficiary)), ...remaining(transfer), ...hookRegistry(keys)]);
  },

  // ---- games (v2) ----

  /**
   * `create_game`: the companion of `mint` (whose keypair signs) gets its game, `payer` paying the
   * rent. The hook must be prepared for the mint first (`lotteryHook.prepare`, in the same setup
   * transaction, before this), and be the lottery hook or one the protocol vetted; its status
   * account is passed either way.
   */
  createGame(payer: PublicKey, mint: PublicKey, args: GameArgs): TransactionInstruction {
    const named = [rw(payer, true), ro(mint, true), rw(a.companionAddress(mint)), rw(a.gameAddress(mint)), ro(a.gameStateAddress(args.hook, mint)), ro(a.registryAddress(args.hook, mint)), ro(a.hookStatusAddress(args.hook)), ro(a.SYSTEM_PROGRAM)];
    const data = {
      args: { kind: { [args.kind]: {} }, hook: args.hook, split: args.split, potBps: args.potBps, roundSecs: args.roundSecs, minPot: bn(args.minPot), prizeBps: args.prizeBps, claimWindowSecs: args.claimWindowSecs, maxAttempts: args.maxAttempts },
    };
    return build('createGame', data, named, []);
  },
  /**
   * `draw(round, slot)` (anyone): the draw of `round` (the round that just ended), in one
   * instruction: its seed committed, made from `at` (`drawSeed(mint, round, 0, at.slot, at.hash)`),
   * and ORAO asked for it, the pot paying and the sender paid `bountyBps` of the top-up (or a
   * pending request ORAO already holds for the seed adopted for free). A seed is never on chain
   * without its request. Or the round rolls over: no tickets, too late (`gameLastDraw`), or the pot
   * unable to pay for ORAO's request now (the oracle's breaker, ORAO's fee above the cap or its
   * network state unreadable: `oracleUnpaid`, no seed committed).
   *
   * `at` is the newest entry of the slot hashes sysvar, read just before sending (`fetchSeedSlot`):
   * it must still be one of the last 3 slots when the draw lands, else the draw fails (`StaleSeed`,
   * as it does for a seed ORAO already answered) and is sent again from a newer slot. `treasury` is
   * ORAO's (`decodeOraoNetworkState`). While `Game.paidSeed` is not zeros, pass it: its request is
   * read (the oracle's breaker), and leaving it out is refused.
   */
  draw(cranker: PublicKey, mint: PublicKey, hook: PublicKey, round: number, at: SeedSlot, treasury: PublicKey, paidSeed: Uint8Array = ZERO_SEED): TransactionInstruction {
    const creator = a.companionCreatorAddress(mint);
    const seed = drawSeed(mint, round, 0, at.slot, at.hash);
    const extra = [ro(a.gameStateAddress(hook, mint)), ro(a.SLOT_HASHES_SYSVAR), ...remaining(oraoRequestV2(a.oraclePayerAddress(mint), treasury, seed)), ...unwrapAccounts(creator)];
    if (!isZero(paidSeed)) extra.push(ro(a.oraoRequestAddress(paidSeed)));
    return build('draw', { round, slot: bn(at.slot) }, gameStep(cranker, mint, hook), extra);
  },
  /** `reveal` (anyone): ORAO's answer at `request` (`Game.request`) stored; the claim windows start. */
  reveal(cranker: PublicKey, mint: PublicKey, hook: PublicKey, request: PublicKey): TransactionInstruction {
    return build('reveal', {}, gameStep(cranker, mint, hook), [ro(request)]);
  },
  /**
   * `claim_prize(attempt)` (anyone, for the winner): `winner`'s holding of `mint` holds attempt
   * `attempt`'s ticket (`findWinningHolding`); `winner` is paid the prize as SOL, the sender the
   * bounty. Only during the attempt's window: send it with a priority fee scaled to the bounty.
   */
  claimPrize(cranker: PublicKey, mint: PublicKey, hook: PublicKey, attempt: number, winner: PublicKey): TransactionInstruction {
    const creator = a.companionCreatorAddress(mint);
    const named = [rw(cranker, true), rw(a.companionAddress(mint)), rw(creator), rw(a.gameAddress(mint)), ro(a.hookStatusAddress(hook)), ro(a.launchAddress(mint)), ro(a.holdingAddress(mint, winner)), ro(a.SYSTEM_PROGRAM)];
    return build('claimPrize', { attempt }, named, [rw(winner), ...unwrapAccounts(creator)]);
  },
  /** `expire` (anyone): a draw that can't go on rolls over (no claim in any window, its claims ended, the oracle silent or unreadable). `request` is `Game.request`. */
  expire(cranker: PublicKey, mint: PublicKey, hook: PublicKey, request: PublicKey): TransactionInstruction {
    return build('expire', {}, gameStep(cranker, mint, hook), [ro(request)]);
  },
  /** `retire` (anyone): the pot of a game that has paid no prize for two dormant periods (`gameRetirableAt`) to the buyback, paying nobody. */
  retire(cranker: PublicKey, mint: PublicKey, hook: PublicKey): TransactionInstruction {
    return build('retire', {}, gameStep(cranker, mint, hook), []);
  },
  /**
   * `burn_stranded` (anyone, paid nothing): a blocked hook's buyback that no buyback has spent or
   * waited on for 30 days (or 4 buyback intervals), burned as SOL; each burn restarts the wait, as
   * does a fee claim that credits the buyback at least what it held (`companionStrandedAt`).
   */
  burnStranded(cranker: PublicKey, mint: PublicKey, hook: PublicKey): TransactionInstruction {
    const creator = a.companionCreatorAddress(mint);
    const named = [ro(cranker, true), rw(a.companionAddress(mint)), rw(creator), ro(a.hookStatusAddress(hook)), rw(a.INCINERATOR), ro(a.SYSTEM_PROGRAM)];
    return build('burnStranded', {}, named, unwrapAccounts(creator));
  },
  /**
   * `set_hook_status(hook, args)`, signed by the companion program's upgrade authority (the
   * protocol's): an audit (final; it lifts the cap and any block), the cap of a hook not audited
   * (0.1 to 10 SOL), or a block (only for a hook not audited; lifted only by an audit).
   */
  setHookStatus(authority: PublicKey, hook: PublicKey, args: HookStatusArgs): TransactionInstruction {
    const named = [rw(authority, true), ro(a.COMPANION_PROGRAM_DATA), rw(a.hookStatusAddress(hook)), ro(a.SYSTEM_PROGRAM)];
    return build('setHookStatus', { hook, args: { audited: args.audited, potCap: bn(args.potCap), blocked: args.blocked } }, named, []);
  },
};

// ---- decoders --------------------------------------------------------------------------------------

/** The variant name of a Borsh enum as the coder decodes it (`{ lottery: {} }` → `'lottery'`). */
const variant = (v: unknown): string => Object.keys(v as object)[0] ?? '';

/** A `Companion` account, by its IDL name `companion` (v2 fields read zero, so null and 0, for a v1 companion). */
export function decodeCompanion(data: Buffer): Companion {
  const r = CODERS.companion.accounts.decode('companion', data) as Record<string, unknown>;
  const s = r.split as Record<string, unknown>;
  const hook = r.gameHook as PublicKey;
  return {
    mint: r.mint as PublicKey,
    beneficiary: r.beneficiary as PublicKey,
    split: { buybackBps: num(s.buybackBps), holdersBps: num(s.holdersBps), beneficiaryBps: num(s.beneficiaryBps) },
    bountyBps: num(r.bountyBps),
    maxBuyback: big(r.maxBuyback),
    buybackInterval: num(r.buybackInterval),
    vestSecs: num(r.vestSecs),
    launched: Boolean(r.launched),
    launchedAt: num(r.launchedAt),
    devTokens: big(r.devTokens),
    devReleased: big(r.devReleased),
    pendingBuyback: big(r.pendingBuyback),
    pendingHolders: big(r.pendingHolders),
    pendingBeneficiary: big(r.pendingBeneficiary),
    lastBuybackAt: num(r.lastBuybackAt),
    claimedTotal: big(r.claimedTotal),
    spentTotal: big(r.spentTotal),
    burnedTotal: big(r.burnedTotal),
    sharedTotal: big(r.sharedTotal),
    paidBeneficiaryTotal: big(r.paidBeneficiaryTotal),
    bountiesTotal: big(r.bountiesTotal),
    referencePrice: big(r.referencePrice),
    referenceAt: num(r.referenceAt),
    gameHook: hook.equals(PublicKey.default) ? null : hook,
    potBps: num(r.potBps),
    pendingPot: big(r.pendingPot),
    roundSecs: num(r.roundSecs),
    strandedBurnedAt: num(r.strandedBurnedAt),
  };
}

/** A companion's game, `PDA(["game", mint])` (`Game`): its settings, fixed before the launch, and its draw. The pot itself is `Companion.pendingPot`. */
export interface Game {
  version: number;
  bump: number;
  kind: GameKind;
  mint: PublicKey;
  /** The coin's token hook, which keeps the tickets. */
  hook: PublicKey;
  stateBump: number;
  statusBump: number;
  oracleBump: number;
  roundSecs: number;
  minPot: bigint;
  prizeBps: number;
  claimWindowSecs: number;
  maxAttempts: number;
  createdAt: number;
  status: DrawStatus;
  /** The earliest round the next draw may be for. */
  nextRound: number;
  /** The round of the current (or last) draw, and its ticket total, read from the hook's header. */
  round: number;
  total: bigint;
  /** The seed's index in the round: always 0 (a round has one seed, which is final). */
  n: number;
  /** The draw's seed (committed at `committedAt`) and ORAO's request account for it. */
  seed: Uint8Array;
  request: PublicKey;
  committedAt: number;
  requestedAt: number;
  /** The revealed randomness (zeros until `revealedAt`). */
  randomness: Uint8Array;
  revealedAt: number;
  /** What this draw pays (fixed at the request), at most the pot when claimed. */
  prize: bigint;
  draws: bigint;
  prizesPaid: bigint;
  prizesTotal: bigint;
  rollovers: bigint;
  /** Lamports the pot has sent the oracle payer. */
  oracleTotal: bigint;
  lastWinner: PublicKey;
  /** When the pot last paid a prize or was retired (0: never; the launch counts). */
  settledAt: number;
  /** The oracle's breaker: the seed of the last request the pot paid for (zeros: none), its draw's round, and the paid requests since ORAO last answered one. */
  paidSeed: Uint8Array;
  paidRound: number;
  paidStreak: number;
}

/** A `Game` account, by its IDL name `game`. */
export function decodeGame(data: Buffer): Game {
  const r = CODERS.companion.accounts.decode('game', data) as Record<string, unknown>;
  const bytes = (v: unknown): Uint8Array => Uint8Array.from(v as ArrayLike<number>);
  return {
    version: num(r.version),
    bump: num(r.bump),
    kind: variant(r.kind) as GameKind,
    mint: r.mint as PublicKey,
    hook: r.hook as PublicKey,
    stateBump: num(r.stateBump),
    statusBump: num(r.statusBump),
    oracleBump: num(r.oracleBump),
    roundSecs: num(r.roundSecs),
    minPot: big(r.minPot),
    prizeBps: num(r.prizeBps),
    claimWindowSecs: num(r.claimWindowSecs),
    maxAttempts: num(r.maxAttempts),
    createdAt: num(r.createdAt),
    status: variant(r.status) as DrawStatus,
    nextRound: num(r.nextRound),
    round: num(r.round),
    total: big(r.total),
    n: num(r.n),
    seed: bytes(r.seed),
    request: r.request as PublicKey,
    committedAt: num(r.committedAt),
    requestedAt: num(r.requestedAt),
    randomness: bytes(r.randomness),
    revealedAt: num(r.revealedAt),
    prize: big(r.prize),
    draws: big(r.draws),
    prizesPaid: big(r.prizesPaid),
    prizesTotal: big(r.prizesTotal),
    rollovers: big(r.rollovers),
    oracleTotal: big(r.oracleTotal),
    lastWinner: r.lastWinner as PublicKey,
    settledAt: num(r.settledAt),
    paidSeed: bytes(r.paidSeed),
    paidRound: num(r.paidRound),
    paidStreak: num(r.paidStreak),
  };
}

/** `set_hook_status`'s arguments. */
export interface HookStatusArgs {
  /** Audited with the companion: its games' pots are not capped. Clears a block. Final. */
  audited: boolean;
  /** The most each of its games' pots holds while not audited: 0.1 to 10 SOL (lamports). */
  potCap: bigint;
  /** Its games' pot share and pots go to the buyback; no prize is paid. Only for a hook not audited. */
  blocked: boolean;
}

/** What the protocol says of a game hook, `PDA(["hook-status", hook])` (`HookStatus`). Without one a hook is not audited, capped at 10 SOL and not blocked (`HOOK_TERMS_DEFAULT`). */
export interface HookStatus extends HookStatusArgs {
  version: number;
  bump: number;
  hook: PublicKey;
  updatedAt: number;
  updatedBy: PublicKey;
}

/** A `HookStatus` account, by its IDL name `hookStatus`. */
export function decodeHookStatus(data: Buffer): HookStatus {
  const r = CODERS.companion.accounts.decode('hookStatus', data) as Record<string, unknown>;
  return {
    version: num(r.version),
    bump: num(r.bump),
    hook: r.hook as PublicKey,
    audited: Boolean(r.audited),
    potCap: big(r.potCap),
    blocked: Boolean(r.blocked),
    updatedAt: num(r.updatedAt),
    updatedBy: r.updatedBy as PublicKey,
  };
}

// ---- the game's clocks (`state.rs`), for keepers and the token page --------------------------------

/** A hook's status as the steps apply it (`HookTerms`). */
export type HookTerms = Pick<HookStatusArgs, 'audited' | 'potCap' | 'blocked'>;
/** A hook the protocol has said nothing of: not audited, capped at 10 SOL, not blocked. */
export const HOOK_TERMS_DEFAULT: Readonly<HookTerms> = { audited: false, potCap: GAME_LIMITS.defaultPotCap, blocked: false };

/** The terms a status account gives (`read_hook_terms`): the defaults when it does not exist. */
export const hookTermsOf = (status: HookStatus | null): HookTerms => (status ? { audited: status.audited, potCap: status.potCap, blocked: status.blocked } : { ...HOOK_TERMS_DEFAULT });
/** The most a pot may hold: none (null) for an audited hook, else the cap and never more than 10 SOL (`HookTerms::cap`). */
export const hookPotCap = (t: HookTerms): bigint | null => (t.audited ? null : t.potCap < GAME_LIMITS.defaultPotCap ? t.potCap : GAME_LIMITS.defaultPotCap);
/** The least a pot must hold to be drawn: the game's minimum, or the cap when lower (`HookTerms::draw_threshold`). */
export function hookDrawThreshold(t: HookTerms, minPot: bigint): bigint {
  const cap = hookPotCap(t);
  return cap === null || minPot < cap ? minPot : cap;
}

const I64_MAX = (1n << 63n) - 1n;
const sat = (v: bigint): bigint => (v > I64_MAX ? I64_MAX : v < -I64_MAX - 1n ? -I64_MAX - 1n : v);

/** When the claims of round `round`'s draw end: when the round after it ends (`state::claims_end`). */
export const gameClaimsEnd = (round: number, roundSecs: number): number => roundEnd(Math.min(round + 1, 0xffff_ffff), roundSecs);
/** The last moment a draw of `round` may be made: 10 minutes (`GAME_LIMITS.revealSecs`) for ORAO's answer and the reveal, then a whole claim window, before its claims end; later, the round rolls over (`Game::last_draw`). */
export const gameLastDraw = (g: Pick<Game, 'roundSecs' | 'claimWindowSecs'>, round: number): number =>
  Number(sat(BigInt(gameClaimsEnd(round, g.roundSecs)) - BigInt(g.claimWindowSecs) - BigInt(GAME_LIMITS.revealSecs)));
/** When attempt `attempt`'s claim opens: `revealedAt + attempt * window`; null on overflow (`Game::attempt_opens`). */
export function gameAttemptOpens(g: Pick<Game, 'revealedAt' | 'claimWindowSecs'>, attempt: number): number | null {
  const v = BigInt(g.revealedAt) + BigInt(g.claimWindowSecs) * BigInt(attempt);
  return v > I64_MAX ? null : Number(v);
}
/** When attempt `attempt`'s claim closes: a window after it opens, never after the draw's claims end; null on overflow (`Game::attempt_closes`). */
export function gameAttemptCloses(g: Pick<Game, 'revealedAt' | 'claimWindowSecs' | 'round' | 'roundSecs'>, attempt: number): number | null {
  const opens = gameAttemptOpens(g, attempt);
  if (opens === null) return null;
  const closes = BigInt(opens) + BigInt(g.claimWindowSecs);
  if (closes > I64_MAX) return null;
  return Math.min(Number(closes), gameClaimsEnd(g.round, g.roundSecs));
}
/** How long the pot may pay no prize before the game is dormant: 30 days, or 4 rounds when longer (`Game::dormant_secs`). */
export const gameDormantSecs = (g: Pick<Game, 'roundSecs'>): number => Math.max(GAME_LIMITS.dormantSecs, GAME_LIMITS.dormantRounds * g.roundSecs);
/** Since when the pot has paid nothing: its last prize or retirement, else the launch (`Game::idle_since`). */
export const gameIdleSince = (g: Pick<Game, 'settledAt'>, launchedAt: number): number => Math.max(g.settledAt, launchedAt);
/** The least a draw at `now` needs before any cap: `minPot`, or 0.1 SOL once the game is dormant (`Game::min_pot_at`). */
export function gameMinPotAt(g: Pick<Game, 'settledAt' | 'roundSecs' | 'minPot'>, now: number, launchedAt: number): bigint {
  const dormantAt = Number(sat(BigInt(gameIdleSince(g, launchedAt)) + BigInt(gameDormantSecs(g))));
  return now >= dormantAt ? (g.minPot < GAME_LIMITS.minMinPot ? g.minPot : GAME_LIMITS.minMinPot) : g.minPot;
}
/** When anyone may `retire` the pot to the buyback: two dormant periods with no prize (`Game::retirable_at`). */
export const gameRetirableAt = (g: Pick<Game, 'settledAt' | 'roundSecs'>, launchedAt: number): number =>
  Number(sat(BigInt(gameIdleSince(g, launchedAt)) + BigInt(gameDormantSecs(g)) * BigInt(GAME_LIMITS.retireDormantPeriods)));
/** While the pot's last paid request is unanswered, how many rounds after its round a draw must be for the pot to pay for another: 1, 2, 4… up to 30 days' worth (`Game::oracle_backoff_rounds`). */
export function gameOracleBackoffRounds(g: Pick<Game, 'paidStreak' | 'roundSecs'>): number {
  const doublings = Math.min(Math.max(g.paidStreak - 1, 0), 32);
  const most = Math.max(Math.floor(GAME_LIMITS.dormantSecs / Math.max(g.roundSecs, 1)), 1);
  return Math.min(2 ** doublings, most);
}
/** Whether the current draw is far enough after the last paid request for the pot to pay for a new one while that one is unanswered (`Game::oracle_backoff_over`). */
export const gameOracleBackoffOver = (g: Pick<Game, 'paidStreak' | 'roundSecs' | 'round' | 'paidRound'>): boolean => g.round >= g.paidRound + gameOracleBackoffRounds(g);
/** The request account of the last seed the pot paid for, which `draw` must be passed while there is one (`client::paid_request_address`). */
export const gamePaidRequestAddress = (paidSeed: Uint8Array): PublicKey | null => (isZero(paidSeed) ? null : a.oraoRequestAddress(paidSeed));

/**
 * When a blocked game's buyback may be burned as SOL (`burn_stranded`): the wait (30 days, or 4
 * buyback intervals when longer) from the latest of the launch, the last buyback, the reference
 * price's last move (a buyback that waited), the hook status's last write, and the last burn, move
 * of the game's pot into the buyback or fee claim that credited the buyback at least what it held
 * (`strandedBurnedAt`: whichever came last; `Companion::restart_stranded_wait`). Only under a
 * blocked hook (`HookStatus.blocked`). A pot no step has moved yet is not burned when due: the
 * burn's call moves it into the buyback instead and restarts the wait. Read it again after a fee
 * claim: the claim may have restarted the wait.
 */
export function companionStrandedAt(c: Pick<Companion, 'launchedAt' | 'lastBuybackAt' | 'referenceAt' | 'strandedBurnedAt' | 'buybackInterval'>, statusUpdatedAt: number): number {
  const since = Math.max(c.launchedAt, c.lastBuybackAt, c.referenceAt, statusUpdatedAt, c.strandedBurnedAt);
  const wait = Math.max(GAME_LIMITS.strandedSecs, GAME_LIMITS.strandedIntervals * c.buybackInterval);
  return Number(sat(BigInt(since) + BigInt(wait)));
}

/** Tokens of a companion's dev bag vested at `now` (the program's `Companion::vested`). */
export function companionVested(c: Pick<Companion, 'launched' | 'launchedAt' | 'vestSecs' | 'devTokens'>, now: number): bigint {
  if (!c.launched) return 0n;
  if (c.vestSecs <= 0) return c.devTokens;
  const elapsed = BigInt(Math.min(Math.max(now - c.launchedAt, 0), c.vestSecs));
  return (c.devTokens * elapsed) / BigInt(c.vestSecs);
}
