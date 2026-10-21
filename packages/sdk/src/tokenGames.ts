/**
 * Games, Lossback and scripts with a launcher's part on coins quoted in tokens (docs/token-quotes.md §7.6, §7.6.9 "Interface (as built)").
 *
 * - **A game in the legs' tokens** (a lottery, a jackpot, a streak; never a strategy) keeps its pot per leg in `CompanionLegs`
 *   (`LegPot.pendingPot`), marked by its token terms (`companion.setGameTokenTerms`, the mint signing before the launch: the least pot in
 *   basis points of the coin's opening value, `Game.minPotBps`); its launch is `companion.launchTokenGame`. Every step of such a game takes
 *   `tokenPotAccounts` among its remaining accounts (`apply_status` reads the pots at every step); the paying steps (`claim_prize`,
 *   `settle`, `claim_share`) `legPrizeAccounts` (each leg's quote mint, the creator address's, the winner's and the sender's accounts of
 *   it); a jackpot's `settle` and a streak's `close_epoch` `legFeeAccounts` (each leg's creator-fee account, `FeesUnclaimed`). The
 *   program finds them by key, so their order is free. A pot's size is `tokenPotBps`: each leg's pot over its opening value, summed.
 * - **With the SOL switch** a game takes no terms and plays as a SOL coin's: its pot's part of each leg is sold to SOL by
 *   `companion.swapBucketToSol(…, PART_POT, …)`.
 * - **A lottery in tokens** pays its oracle from a SOL float (`Companion.pendingPot`, booked from the launcher's `fund` at the launch;
 *   `LOTTERY_TOKEN_FLOAT_LAMPORTS`); SOL sent to the companion address later is booked at the next `draw`.
 * - **The hooks** learn the legs: `lotteryHook.prepareLegs`, `studioGameHook.prepareLegs` and `lossCoverHook.prepareLegs` (with the
 *   legs' pools), whose registries list the coin's `Legs`.
 * - **Lossback** keeps each holding's basis in the token of the leg it first bought on (`LossCoverRecord.leg`) and answers version 3
 *   (`PayoutAnswerLegs`); its step carries `lossCoverTokenStepHead`, then each paid holding and its owner's account of the record leg's
 *   token (`lossCoverTokenPayee`).
 */
import { PublicKey, type AccountMeta, type TransactionInstruction } from '@solana/web3.js';
import * as a from './addresses.ts';
import { companion, companionLegsAddress, GAME_LIMITS, gameDormantSecs, gameIdleSince, hookPotCap, type Game, type HookTerms, type LegPot } from './companion.ts';
import { legFeesAddress, legsAddress } from './legs.ts';
const { SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM } = a;

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });

// ---- constants (`constants.rs`) --------------------------------------------------------------------------

/** `swap_bucket_to_sol`'s part for a game's pot (with the SOL switch only; `NotSwitchedPart` for anything but a game). */
export const PART_POT = 2;
/** Lamports that stand for a coin's whole opening value when a game's SOL bounds are read on a coin quoted in tokens (`lamports_as_bps`). */
export const TOKEN_POT_SCALE = 50_000_000_000n;
/** A dormant game's least pot in tokens: 20 basis points of the opening value (`MIN_MIN_POT` read as `lamports_as_bps`). */
export const TOKEN_MIN_MIN_POT_BPS = 20;
/** The least pot the site sends for a game in tokens: 1% of the opening value ("1% of the opening value, about $50"). */
export const TOKEN_GAME_MIN_POT_BPS_DEFAULT = 100;
/** The SOL a lottery in tokens funds its oracle with at the launch (the launcher's `fund` adds it): about ten draws net. */
export const LOTTERY_TOKEN_FLOAT_LAMPORTS = 20_000_000n;
/** `LegPrizesFixed.kind` and `LegPrizePaid.kind`: a lottery draw's prize, a jackpot round's, a streak share. */
export const LEG_PRIZE_KINDS = ['draw', 'settle', 'share'] as const;
export type LegPrizeKind = (typeof LEG_PRIZE_KINDS)[number];
/** `LegPotToBuyback.reason`: an unaudited hook's cap, a blocked hook, a retired game. */
export const LEG_POT_REASONS = ['cap', 'blocked', 'retired'] as const;
export type LegPotReason = (typeof LEG_POT_REASONS)[number];

/** One leg's token for the builders: its quote mint and token program (SPL Token or Token-2022). */
export interface LegQuote {
  quoteMint: PublicKey;
  quoteProgram: PublicKey;
}

/** A `LegPot`'s token program by its index (0 SPL Token, 1 Token-2022). */
export const legPotProgram = (p: Pick<LegPot, 'quoteProgram'>): PublicKey => (p.quoteProgram === 1 ? SPL_TOKEN_2022_PROGRAM : SPL_TOKEN_PROGRAM);
/** The legs' tokens of a companion's `CompanionLegs`, in leg order. */
export const legQuotesOf = (legs: readonly Pick<LegPot, 'quoteMint' | 'quoteProgram'>[]): LegQuote[] => legs.map((l) => ({ quoteMint: l.quoteMint, quoteProgram: legPotProgram(l) }));

// ---- the accounts a game step on a pot in tokens adds (`bordrless_companion::client`) ------------------------

/** `token_pot_accounts`: the companion's legs (w) and the coin's `Legs`, which every step of a game in tokens reads. */
export const tokenPotAccounts = (mint: PublicKey): AccountMeta[] => [rw(companionLegsAddress(mint)), ro(legsAddress(mint))];

/**
 * `leg_prize_accounts`: `tokenPotAccounts`, then per leg (in leg order) its quote mint, the creator address's account of it (w), the
 * winner's (w; made when missing, the sender paying) and, with `bounty`, the sender's (w; the bounty is paid only into an account that
 * exists and can take it); then SPL Token, Token-2022, the associated token account program and the winner (w).
 */
export function legPrizeAccounts(mint: PublicKey, quotes: readonly LegQuote[], winner: PublicKey, cranker: PublicKey, bounty: boolean): AccountMeta[] {
  const creator = a.companionCreatorAddress(mint);
  const ata = (owner: PublicKey, q: LegQuote): PublicKey => a.associatedTokenAddress(owner, q.quoteMint, q.quoteProgram);
  return [
    ...tokenPotAccounts(mint),
    ...quotes.flatMap((q) => [ro(q.quoteMint), rw(ata(creator, q)), rw(ata(winner, q)), ...(bounty ? [rw(ata(cranker, q))] : [])]),
    ro(SPL_TOKEN_PROGRAM),
    ro(SPL_TOKEN_2022_PROGRAM),
    ro(a.ATA_PROGRAM),
    rw(winner),
  ];
}

/**
 * `leg_fee_accounts` (review 5, F3): per leg, its creator-fee account (the launchpad's `leg-fees`) and the creator address's account of its
 * token, which `settle`, `close_epoch` and a short pot's `retire` (a jackpot's or a streak's) read for what a claim would fund
 * (`FeesUnclaimed`; `MissingAccount` without them).
 */
export const legFeeAccounts = (mint: PublicKey, quotes: readonly LegQuote[]): AccountMeta[] => {
  const creator = a.companionCreatorAddress(mint);
  return quotes.flatMap((q) => [ro(legFeesAddress(mint, q.quoteMint)), ro(a.associatedTokenAddress(creator, q.quoteMint, q.quoteProgram))]);
};

/** `with_accounts`: `ix` with `extra` appended to its accounts, none already there twice. */
export function withAccounts(ix: TransactionInstruction, extra: readonly AccountMeta[]): TransactionInstruction {
  for (const m of extra) {
    const at = ix.keys.findIndex((k) => k.pubkey.equals(m.pubkey));
    if (at < 0) ix.keys.push({ ...m });
    else if (m.isWritable && !ix.keys[at]!.isWritable) ix.keys[at] = { ...ix.keys[at]!, isWritable: true };
  }
  return ix;
}

// ---- a pot in tokens: its size and its bounds ---------------------------------------------------------------

/** Whether a game's pot is kept per leg in the legs' tokens (`Game::in_tokens`: its token terms set and `launch_token` marked it so, review 5 F4). */
export const gameInTokens = (g: Pick<Game, 'minPotBps' | 'launchedInTokens'>): boolean => (g.minPotBps ?? 0) > 0 && g.launchedInTokens === true;

/** Lamports read as basis points of a coin's opening value (`lamports_as_bps`): 10 SOL is 2,000. */
export const lamportsAsBps = (lamports: bigint): bigint => (lamports * 10_000n) / TOKEN_POT_SCALE;

/**
 * A pot in tokens as a share of the coin's opening value (`TokenPots::pot_bps`): `Σ pendingPot_i × 10,000 / (virtualQuote_i × count)`,
 * rounded down per leg; `virtualQuotes` each leg's opening value in its token (the launchpad's `Legs`).
 */
export function tokenPotBps(pots: readonly Pick<LegPot, 'pendingPot'>[], virtualQuotes: readonly bigint[]): bigint {
  const n = BigInt(pots.length);
  let sum = 0n;
  pots.forEach((p, i) => {
    const vq = virtualQuotes[i] ?? 0n;
    if (vq > 0n && n > 0n) sum += (p.pendingPot * 10_000n) / (vq * n);
  });
  return sum;
}

/** An unaudited hook's cap read as basis points of the opening value (`HookTerms::cap_bps`); null for an audited hook. */
export function hookCapBps(t: HookTerms): bigint | null {
  const cap = hookPotCap(t);
  return cap === null ? null : lamportsAsBps(cap);
}

/** The least a draw (or a streak's close) needs of a pot in tokens (`draw_threshold_bps`): the minimum, or the cap when it is lower. */
export function tokenDrawThresholdBps(t: HookTerms, minPotBps: bigint): bigint {
  const cap = hookCapBps(t);
  return cap === null || minPotBps < cap ? minPotBps : cap;
}

/** A game's least pot in tokens at `now` (`Game::min_pot_bps_at`): its terms, or `TOKEN_MIN_MIN_POT_BPS` once it is dormant. */
export function gameMinPotBpsAt(g: Pick<Game, 'settledAt' | 'roundSecs' | 'minPotBps'>, now: number, launchedAt: number): bigint {
  const dormantAt = gameIdleSince(g, launchedAt) + gameDormantSecs(g);
  const min = BigInt(g.minPotBps ?? 0);
  return now >= dormantAt && min > BigInt(TOKEN_MIN_MIN_POT_BPS) ? BigInt(TOKEN_MIN_MIN_POT_BPS) : min;
}

/** Leg `i`'s share of a cap of `capBps` of the opening value, in its token (`TokenPots::leg_cap`). */
export const legCapOf = (capBps: bigint, virtualQuote: bigint): bigint => (capBps * virtualQuote) / 10_000n;

/** A leg's prize when a draw is requested or an epoch closed (`fix_prizes`): `prizeBps` of its pot. */
export const legPrizeOf = (pendingPot: bigint, prizeBps: number): bigint => (pendingPot * BigInt(prizeBps)) / 10_000n;

/** What a leg's prize still owes (`LegPot::prize_left`). */
export const legPrizeLeft = (p: Pick<LegPot, 'prize' | 'prizePaid'>): bigint => {
  const prize = p.prize ?? 0n;
  const paid = p.prizePaid ?? 0n;
  return prize > paid ? prize - paid : 0n;
};


/** `GAME_LIMITS` re-read for a pot in tokens: the default cap of an unaudited hook as basis points (2,000: 20% of the opening value). */
export const TOKEN_DEFAULT_CAP_BPS = lamportsAsBps(GAME_LIMITS.defaultPotCap);

// ---- Lossback on a coin quoted in tokens ----------------------------------------------------------------------

/** One leg as a Lossback step on a coin quoted in tokens reads it: its token and its pool. */
export interface LossCoverLeg extends LegQuote {
  pool: PublicKey;
}

/**
 * What a Lossback step on a coin quoted in tokens carries before its holdings (`loss_cover_script`'s token mode, the companion's
 * version-3 payouts): the payout accounts (`companion.payoutAccounts`), the companion's legs (w), the coin's `Legs`, every leg's pool,
 * every leg's quote mint and the creator address's account of it (w), and both token programs.
 */
export function lossCoverTokenStepHead(mint: PublicKey, hook: PublicKey, legs: readonly LossCoverLeg[]): AccountMeta[] {
  const creator = a.companionCreatorAddress(mint);
  return [
    ...companion.payoutAccounts(mint, hook),
    rw(companionLegsAddress(mint)),
    ro(legsAddress(mint)),
    ...legs.map((l) => ro(l.pool)),
    ...legs.flatMap((l) => [ro(l.quoteMint), rw(a.associatedTokenAddress(creator, l.quoteMint, l.quoteProgram))]),
    ro(SPL_TOKEN_PROGRAM),
    ro(SPL_TOKEN_2022_PROGRAM),
  ];
}

/**
 * What a Lossback step on a coin quoted in tokens carries at most: paid holdings (each with its owner’s account of its leg’s token) and
 * measured ones. The programs measured 3 legs with 2 payouts (257k to 287k units); a payout in tokens adds a `TransferChecked` to the
 * SOL payout’s trace, so fewer than a SOL coin’s step (`LOSS_COVER_BATCH`); the keeper still trims a step to what fits one transaction.
 */
export const LOSS_COVER_TOKEN_BATCH = { paying: 4, measuring: 10 } as const;

/** Where a Lossback payout on a coin quoted in tokens goes: the holding's owner's associated account of its record leg's token (it must exist). */
export const lossCoverTokenPayee = (owner: PublicKey, leg: LegQuote): PublicKey => a.associatedTokenAddress(owner, leg.quoteMint, leg.quoteProgram);

// ---- events -----------------------------------------------------------------------------------------------------

/** The companion's events of games in the legs' tokens (§7.6.9), typed from `eventsOf`'s shape. */
export type TokenGameEvent =
  | { kind: 'companion.GameTokenTermsSet'; game: string; mint: string; minPotBps: number }
  | { kind: 'companion.LegPrizesFixed'; game: string; mint: string; round: number; prizeKind: LegPrizeKind; prizes: bigint[]; potBps: bigint }
  | { kind: 'companion.LegPrizePaid'; companion: string; index: number; quoteMint: string; prizeKind: LegPrizeKind; owner: string; amount: bigint; bounty: bigint }
  | { kind: 'companion.LegPotToBuyback'; companion: string; index: number; amount: bigint; reason: LegPotReason; pendingPot: bigint }
  | { kind: 'companion.LegScriptPayout'; companion: string; index: number; holding: string; owner: string; amount: bigint; tag: number };

const evStr = (v: unknown): string => String(v);
const evBig = (v: unknown): bigint => BigInt(String(v));
const evNum = (v: unknown): number => Number(v);
const prizeKindOf = (v: unknown): LegPrizeKind => LEG_PRIZE_KINDS[evNum(v)] ?? 'draw';
const reasonOf = (v: unknown): LegPotReason => LEG_POT_REASONS[evNum(v)] ?? 'cap';

/** A decoded companion event as one of `TokenGameEvent`; null for any other. */
export function typedTokenGameEvent(ev: { program: string; name: string; data: Record<string, unknown> }): TokenGameEvent | null {
  if (ev.program !== 'companion') return null;
  const d = ev.data;
  switch (ev.name) {
    case 'gameTokenTermsSet':
      return { kind: 'companion.GameTokenTermsSet', game: evStr(d.game), mint: evStr(d.mint), minPotBps: evNum(d.minPotBps) };
    case 'legPrizesFixed':
      return { kind: 'companion.LegPrizesFixed', game: evStr(d.game), mint: evStr(d.mint), round: evNum(d.round), prizeKind: prizeKindOf(d.kind), prizes: ((d.prizes as unknown[]) ?? []).map(evBig), potBps: evBig(d.potBps) };
    case 'legPrizePaid':
      return { kind: 'companion.LegPrizePaid', companion: evStr(d.companion), index: evNum(d.index), quoteMint: evStr(d.quoteMint), prizeKind: prizeKindOf(d.kind), owner: evStr(d.owner), amount: evBig(d.amount), bounty: evBig(d.bounty) };
    case 'legPotToBuyback':
      return { kind: 'companion.LegPotToBuyback', companion: evStr(d.companion), index: evNum(d.index), amount: evBig(d.amount), reason: reasonOf(d.reason), pendingPot: evBig(d.pendingPot) };
    case 'legScriptPayout':
      return { kind: 'companion.LegScriptPayout', companion: evStr(d.companion), index: evNum(d.index), holding: evStr(d.holding), owner: evStr(d.owner), amount: evBig(d.amount), tag: evNum(d.tag) };
    default:
      return null;
  }
}
