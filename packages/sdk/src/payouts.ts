/**
 * Holder rewards in the quote token and the SOL switch on coins quoted in tokens (docs/token-quotes.md §7.5, as built in §7.5.5).
 * The builders mirror `bordrless_launch::client::{leg_swap_for, kit_vault_address, quote_reference_address, amm_v4_accounts,
 * cpmm_accounts, clmm_accounts, pump_accounts, via_usdc_accounts, register_quote_pool, pause_quote_reference, swap_to_sol_rest,
 * swap_to_sol, swap_creator_fees}` and `bordrless_kit::client::{token_rewards_hook_slice, claim_token, claim_token_for, share_token,
 * start_round, pay_round, swap_rewards_to_sol, claim_sol_legs, claim_sol_for_legs}` account for account; the data comes from the
 * IDL coders. `KitRounds` and `PayeesLegs` are read by hand (they are not in the IDLs' accounts), `QuoteReference` by the IDL.
 *
 * - **Holder rewards** (`TokenPayouts`, the kit's reward kind): a holder fee on a coin quoted in tokens is paid in the leg's token
 *   through the kit's accumulator on one leg (kind 1, `claim_token`), in every leg's token by rounds on several (kind 2,
 *   `start_round`/`pay_round`), or in SOL with the switch (kind 3, `swap_rewards_to_sol` then `claim_sol`). A leg trade of such a
 *   coin carries the kit's vault of the leg's token after the leg's four extras (`legSwapFor`); a one-leg coin's kit slice names
 *   the vault in place of the kit's id (`tokenRewardsHookSlice`).
 * - **The SOL switch** (`TokenPayouts.flags` bit 0): the paid parts are sold to SOL on the token's registered reference pool
 *   (`QuoteReference`, one of Raydium AMM v4, CPMM, CLMM or Pump AMM, against wrapped SOL or USDC) by the launchpad's `swap_to_sol`,
 *   which `swap_creator_fees`, the kit's `swap_rewards_to_sol` and the companion's `swap_bucket_to_sol` call. The venue readers
 *   below (`marketOf`) port `bordrless_launch::venues` to read a pool's side, price, fee and depth off chain, without the time-
 *   weighted price the program also takes on CPMM and CLMM.
 */
import BN from 'bn.js';
import { PublicKey, TransactionInstruction, type AccountInfo, type AccountMeta } from '@solana/web3.js';
import { kitModulesOf, rulesBurn, type LaunchRulesData } from './accounts.ts';
import * as a from './addresses.ts';
import { CODERS, type ProgramName } from './coders.ts';
import { kit } from './instructions.ts';
import { kitVaultAddress, legFeeAccount, legQuoteAccount, legsAddress, legsHookSlice, tokenLaunch, type LegKeys } from './legs.ts';

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const bn = (v: bigint | number): BN => new BN(v.toString());
const withEvents = (program: PublicKey, keys: AccountMeta[]): AccountMeta[] => [...keys, ro(a.eventAuthority(program)), ro(program)];
const enc = (s: string): Buffer => Buffer.from(s, 'utf8');
const pda = (seeds: Buffer[], program: PublicKey): PublicKey => PublicKey.findProgramAddressSync(seeds, program)[0];
function ix(program: PublicKey, coder: ProgramName, name: string, args: Record<string, unknown>, keys: AccountMeta[]): TransactionInstruction {
  return new TransactionInstruction({ programId: program, keys, data: CODERS[coder].instruction.encode(name, args) });
}

// ---- constants -------------------------------------------------------------------------------------------

/** The kit's reward kind of a coin quoted in tokens (`KitConfig.reserved[10]`, byte 386): 0 none or any coin made before. */
export const REWARD_KIND = { none: 0, token: 1, rounds: 2, sol: 3 } as const;
export type RewardKind = (typeof REWARD_KIND)[keyof typeof REWARD_KIND];
/** `TokenPayouts.flags` bit 0 (`Launch.reserved[19]`, byte 530): the SOL switch. */
export const PAYOUT_SOL = 1;
/** A rounds coin's round length (`holder_round_secs`): 0 means an hour; otherwise 600 to 86,400 s (`PayoutsInvalid`). */
export const HOLDER_ROUND_SECS = { default: 3_600, min: 600, max: 86_400 } as const;
/** `TokenPayouts` in Borsh: `flags: u8`, `holder_round_secs: u32`. */
export const TOKEN_PAYOUTS_BYTES = 5;

/** `QuoteReference.venue`. */
export const VENUE = { ammV4: 1, cpmm: 2, clmm: 3, pumpAmm: 4 } as const;
export type Venue = (typeof VENUE)[keyof typeof VENUE];
export const VENUE_NAMES: Record<Venue, string> = { 1: 'Raydium AMM v4', 2: 'Raydium CPMM', 3: 'Raydium CLMM', 4: 'Pump AMM' };
/** `QuoteReference.via`: the pool's other side. */
export const VIA = { sol: 0, usdc: 1 } as const;

export const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
export const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
export const RAYDIUM_CLMM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
export const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** USDC (SPL Token, 6 decimals): the other side a reference may have besides wrapped SOL. */
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
/** CPMM's `["vault_and_lp_mint_auth_seed"]`, the same for every pool. */
export const CPMM_AUTHORITY = new PublicKey('GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL');
export const PUMP_BONDING = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const PUMP_GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
export const PUMP_FEE_CONFIG = new PublicKey('5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx');
export const PUMP_EVENT_AUTHORITY = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
/** The venue programs by venue. */
export const VENUE_PROGRAMS: Record<Venue, PublicKey> = { 1: RAYDIUM_AMM_V4, 2: RAYDIUM_CPMM, 3: RAYDIUM_CLMM, 4: PUMP_AMM };

/** A reference pool's bounds (`register_quote_pool`): its fee 100 to 30,000 ppm, at least 100 SOL on its SOL side. */
export const QUOTE_REFERENCE_LIMITS = { minFeePpm: 100, maxFeePpm: 30_000, minDepthLamports: 100_000_000_000n, deeperBps: 12_500, replaceAfterSecs: 3_600 } as const;
/** A sale smaller than this many lamports is refused (`SwapTooSmall`), and a window with less room says `SwapWindowFull`. */
export const SWAP_TO_SOL_MIN_LAMPORTS = 10_000_000n;
/** Account sizes (`QuoteReference` by the IDL; the two read by hand). */
export const QUOTE_REFERENCE_LEN = 189;
export const KIT_ROUNDS_LEN = 191;
export const PAYEES_LEGS_LEN = 602;
/** The venues' account sizes (`bordrless_launch::venues`). */
export const VENUE_LENGTHS = { ammV4: 752, cpmmPool: 637, cpmmConfig: 236, cpmmObservation: 4_075, clmmPool: 1_544, clmmConfig: 117, clmmObservation: 4_483, clmmTickArray: 10_240, clmmBitmapExtension: 1_832 } as const;
/** `sha256("account:PoolState")[..8]` (CPMM's and CLMM's), `account:AmmConfig`, and Pump AMM's `account:Pool`, `account:GlobalConfig`, `account:FeeConfig`. */
export const RAYDIUM_POOL_STATE_DISCRIMINATOR = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]);
export const RAYDIUM_AMM_CONFIG_DISCRIMINATOR = Buffer.from([218, 244, 33, 104, 203, 203, 43, 111]);
export const PUMP_POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
export const PUMP_GLOBAL_CONFIG_DISCRIMINATOR = Buffer.from([0x95, 0x08, 0x9c, 0xca, 0xa0, 0xfc, 0xb0, 0xd9]);
export const PUMP_FEE_CONFIG_DISCRIMINATOR = Buffer.from([0x8f, 0x34, 0x92, 0xbb, 0xdb, 0x7b, 0x4c, 0x9b]);
export const KIT_ROUNDS_DISCRIMINATOR = Buffer.from([0x7e, 0x9e, 0xac, 0x24, 0x81, 0x1a, 0x1f, 0xba]);
export const PAYEES_LEGS_DISCRIMINATOR = Buffer.from([0x1c, 0x5e, 0xa4, 0x0c, 0xf8, 0xf7, 0x32, 0x59]);

// ---- TokenPayouts and the reward kind ----------------------------------------------------------------------

/** `create_token_launch`'s optional payouts (`TokenPayouts`): the SOL switch, and a rounds coin's round length (0: an hour). */
export interface TokenPayouts {
  /** Bit 0 the SOL switch (`PAYOUT_SOL`); every other bit 0. */
  flags: number;
  holderRoundSecs: number;
}

/** No payouts: what `create_token_launch` reads when its data ends before them. */
export const NO_TOKEN_PAYOUTS: TokenPayouts = { flags: 0, holderRoundSecs: 0 };
/** Whether payouts need anything written: either field above 0 (none is written otherwise, so a launch's bytes are as before). */
export const hasTokenPayouts = (p: TokenPayouts | null | undefined): p is TokenPayouts => p != null && (p.flags !== 0 || p.holderRoundSecs !== 0);
/** Why payouts are refused (`PayoutsInvalid`), or null: a flag other than bit 0, or a round outside 600..86,400 s (0 is an hour). */
export function tokenPayoutsProblem(p: TokenPayouts): string | null {
  if (!Number.isInteger(p.flags) || (p.flags & ~PAYOUT_SOL) !== 0) return 'flags takes only bit 0, the SOL switch';
  if (!Number.isInteger(p.holderRoundSecs) || (p.holderRoundSecs !== 0 && (p.holderRoundSecs < HOLDER_ROUND_SECS.min || p.holderRoundSecs > HOLDER_ROUND_SECS.max))) return `holderRoundSecs is 0 (an hour) or ${HOLDER_ROUND_SECS.min} to ${HOLDER_ROUND_SECS.max} seconds`;
  return null;
}

/** What a launch reads of its payouts (`Launch.reserved[18..20]` and its modules). */
export interface PayoutsOfLaunch {
  tokenQuoted?: boolean;
  modules: number;
  /** `Launch.reserved[19]`: 0 for every launch made before. */
  payouts?: number;
}

/** Whether a launch quoted in tokens has the SOL switch on (`Launch::sol_switch`). */
export const solSwitchOn = (l: PayoutsOfLaunch): boolean => l.tokenQuoted === true && ((l.payouts ?? 0) & PAYOUT_SOL) !== 0;

/** How a launch quoted in tokens pays its holder rewards (`Launch::reward_kind`): none without a holder fee; SOL with the switch; the token on one leg; rounds on several. */
export function rewardKindOf(l: PayoutsOfLaunch, legs: number): RewardKind {
  if (l.tokenQuoted !== true || (l.modules & 1) === 0) return REWARD_KIND.none;
  if (solSwitchOn(l)) return REWARD_KIND.sol;
  return legs === 1 ? REWARD_KIND.token : REWARD_KIND.rounds;
}

/** The same before the launch, from its rules and payouts (what `create_token_launch` installs). */
export const rewardKindForLaunch = (rules: LaunchRulesData | null | undefined, payouts: TokenPayouts | null | undefined, legs: number): RewardKind =>
  rewardKindOf({ tokenQuoted: true, modules: rules ? kitModulesOf(rules) : 0, payouts: payouts?.flags ?? 0 }, legs);

// ---- leg trades with holder rewards ------------------------------------------------------------------------

/** The three extras every callback of a one-leg coin paying holder rewards in its token (kind 1) takes: the config (w), the reward vault (r), the `Legs` (r). */
export const tokenRewardsHookExtras = (mint: PublicKey, rewardVault: PublicKey): AccountMeta[] => [rw(a.kitConfigAddress(mint)), ro(rewardVault), ro(legsAddress(mint))];
/** The kit's slice of a kind-1 coin (`bordrless_kit::client::token_rewards_hook_slice`): the vault in place of the kit's id. */
export const tokenRewardsHookSlice = (mint: PublicKey, rewardVault: PublicKey): AccountMeta[] => [ro(a.KIT_PROGRAM), ro(a.tokenHookSigner(a.KIT_PROGRAM)), ...tokenRewardsHookExtras(mint, rewardVault)];

/** What a leg trade reads of the launch: its rules (the burn, the kit's modules), whether it is quoted in tokens and its payouts byte. */
export interface LegTradeLaunch extends PayoutsOfLaunch {
  rules: LaunchRulesData;
}

/** The coin's token-hook slice on leg `keys`' trades (`leg_base_slice_for`): none without the kit; the kit's with its `Legs`, the vault in place of the kit's id on kind 1. */
export function legSliceFor(l: LegTradeLaunch, legs: number, keys: LegKeys): AccountMeta[] {
  if (l.modules === 0) return [];
  if (rewardKindOf(l, legs) === REWARD_KIND.token) return tokenRewardsHookSlice(keys.mint, kitVaultAddress(keys));
  return legsHookSlice(keys.mint);
}

/**
 * A swap on a leg (`bordrless_launch::client::leg_swap_for`): `trader` trades, `recipient` receives; the coin's slice (`legSliceFor`) on
 * its side, its mint writable when it burns, and with holder rewards the kit's vault of the leg after the leg's four extras (callback
 * index 9). Exactly `tokenLaunch.legSwap` for a coin without holder rewards.
 */
export function legSwapFor(l: LegTradeLaunch, legs: number, keys: LegKeys, trader: PublicKey, recipient: PublicKey, direction: 0 | 1, amountIn: bigint, minAmountOut: bigint): TransactionInstruction {
  const [traderBase, traderQuote] = direction === 1 ? [a.holdingAddress(keys.mint, recipient), legQuoteAccount(keys, trader)] : [a.holdingAddress(keys.mint, trader), legQuoteAccount(keys, recipient)];
  const swap = tokenLaunch.legSwapWithSlice(keys, trader, traderBase, traderQuote, direction, amountIn, minAmountOut, legSliceFor(l, legs, keys), rulesBurn(l.rules));
  if ((l.modules & 1) !== 0) swap.keys.push(rw(kitVaultAddress(keys)));
  return swap;
}

// ---- the kit ------------------------------------------------------------------------------------------------

const KIT = (): PublicKey => a.KIT_PROGRAM;
const kitVault = (mint: PublicKey, quoteMint: PublicKey, quoteProgram: PublicKey): PublicKey => a.associatedTokenAddress(a.kitConfigAddress(mint), quoteMint, quoteProgram);
/** A leg's token, as the round builders take them. */
export interface LegToken {
  quoteMint: PublicKey;
  quoteProgram: PublicKey;
}

/** `["kit-rounds", mint]` under the kit. */
export const kitRoundsAddress = (mint: PublicKey): PublicKey => pda([enc('kit-rounds'), mint.toBuffer()], a.KIT_PROGRAM);

export const kitPayouts = {
  /** `claim_sol` of a coin quoted in tokens (kind 3, SOL rewards): the coin's `Legs` appended, which the claim excludes every leg's pool by (`LegsMissing` otherwise). */
  claimSolLegs(owner: PublicKey, mint: PublicKey): TransactionInstruction {
    const out = kit.claimSol(owner, mint);
    out.keys.push(ro(legsAddress(mint)));
    return out;
  },
  /** `claim_sol_for` of a coin quoted in tokens: the coin's `Legs` appended. */
  claimSolForLegs(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
    const out = kit.claimSolFor(payer, owner, mint);
    out.keys.push(ro(legsAddress(mint)));
    return out;
  },
  /** `claim_token` (kind 1): `owner` claims into its associated account of the reward mint, made when missing (the owner paying). */
  claimToken(owner: PublicKey, mint: PublicKey, rewardMint: PublicKey, rewardProgram: PublicKey): TransactionInstruction {
    return ix(KIT(), 'kit', 'claimToken', {}, withEvents(KIT(), [
      rw(owner, true), rw(a.kitConfigAddress(mint)), ro(mint), rw(a.holdingAddress(mint, owner)), ro(rewardMint), rw(kitVault(mint, rewardMint, rewardProgram)),
      rw(a.associatedTokenAddress(owner, rewardMint, rewardProgram)), ro(legsAddress(mint)), ro(a.KIT_HOOK_AUTHORITY), ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY), ro(rewardProgram), ro(a.ATA_PROGRAM), ro(a.SYSTEM_PROGRAM),
    ]));
  },
  /** `claim_token_for` (kind 1): `owner`'s rewards pushed by `payer` into `destination` (its associated account by default), which must exist. */
  claimTokenFor(payer: PublicKey, owner: PublicKey, mint: PublicKey, rewardMint: PublicKey, rewardProgram: PublicKey, destination: PublicKey | null = null): TransactionInstruction {
    return ix(KIT(), 'kit', 'claimTokenFor', {}, withEvents(KIT(), [
      ro(payer, true), ro(owner), rw(a.kitConfigAddress(mint)), ro(mint), rw(a.holdingAddress(mint, owner)), ro(rewardMint), rw(kitVault(mint, rewardMint, rewardProgram)),
      rw(destination ?? a.associatedTokenAddress(owner, rewardMint, rewardProgram)), ro(legsAddress(mint)), ro(a.KIT_HOOK_AUTHORITY), ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY), ro(rewardProgram),
    ]));
  },
  /** `share_token(index, amount)`: `sharer` shares `amount` of leg `index`'s token from `source` (kind 1 streams it, kind 2 counts it at the next round). */
  shareToken(sharer: PublicKey, mint: PublicKey, index: number, quoteMint: PublicKey, quoteProgram: PublicKey, source: PublicKey, amount: bigint): TransactionInstruction {
    return ix(KIT(), 'kit', 'shareToken', { index, amount: bn(amount) }, withEvents(KIT(), [ro(sharer, true), rw(a.kitConfigAddress(mint)), ro(legsAddress(mint)), ro(quoteMint), rw(source), rw(kitVault(mint, quoteMint, quoteProgram)), ro(quoteProgram)]));
  },
  /** `start_round` (kind 2): every leg's vault in leg order after the named accounts; `payer` pays `KitRounds`' rent the first time. */
  startRound(payer: PublicKey, mint: PublicKey, legs: readonly LegToken[]): TransactionInstruction {
    return ix(KIT(), 'kit', 'startRound', {}, [
      ...withEvents(KIT(), [rw(payer, true), ro(a.kitConfigAddress(mint)), rw(kitRoundsAddress(mint)), ro(legsAddress(mint)), ro(a.SYSTEM_PROGRAM)]),
      ...legs.map((l) => ro(kitVault(mint, l.quoteMint, l.quoteProgram))),
    ]);
  },
  /**
   * `pay_round(create_missing)` (kind 2) of `owner`'s holding: per leg its vault (w), the quote mint and the owner's associated account (w),
   * then each token program the legs use once, and with `createMissing` the ATA program (the payer then makes a missing account).
   */
  payRound(payer: PublicKey, owner: PublicKey, mint: PublicKey, legs: readonly LegToken[], createMissing: boolean): TransactionInstruction {
    const programs: PublicKey[] = [];
    const perLeg = legs.flatMap((l) => {
      if (!programs.some((p) => p.equals(l.quoteProgram))) programs.push(l.quoteProgram);
      return [rw(kitVault(mint, l.quoteMint, l.quoteProgram)), ro(l.quoteMint), rw(a.associatedTokenAddress(owner, l.quoteMint, l.quoteProgram))];
    });
    return ix(KIT(), 'kit', 'payRound', { createMissing }, [
      ...withEvents(KIT(), [rw(payer, true), ro(a.kitConfigAddress(mint)), rw(kitRoundsAddress(mint)), ro(mint), rw(a.holdingAddress(mint, owner)), ro(owner), ro(legsAddress(mint)), ro(a.KIT_HOOK_AUTHORITY), ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY), ro(a.SYSTEM_PROGRAM)]),
      ...perLeg,
      ...programs.map((p) => ro(p)),
      ...(createMissing ? [ro(a.ATA_PROGRAM)] : []),
    ]);
  },
  /**
   * `swap_rewards_to_sol(index, amount_in)` (kind 3, anyone): the kit's vault of leg `index` sold to SOL for the holders; `swapRest` the
   * launchpad's `swap_to_sol` accounts from the launch on without its `Legs`, quote mint and source (`swapToSolRest(kit config, …)`).
   * `amountIn` 0 sells the whole vault (within the window's room).
   */
  swapRewardsToSol(crank: PublicKey, mint: PublicKey, index: number, quoteMint: PublicKey, quoteProgram: PublicKey, amountIn: bigint, swapRest: AccountMeta[]): TransactionInstruction {
    return ix(KIT(), 'kit', 'swapRewardsToSol', { index, amountIn: bn(amountIn) }, [
      ...withEvents(KIT(), [rw(crank, true), rw(a.kitConfigAddress(mint)), ro(legsAddress(mint)), ro(quoteMint), rw(kitVault(mint, quoteMint, quoteProgram)), ro(a.LAUNCH_PROGRAM)]),
      ...swapRest,
    ]);
  },
};

/** A holding's bytes 32..56 on a rounds kit (`RoundData`): the round of its last update, the last round paid, the least held in `mark` and in `mark − 1`. Zeros on every other kit. */
export interface RoundData {
  mark: number;
  paid: number;
  minCur: bigint;
  minPrev: bigint;
}

export function roundDataOf(hookData: Uint8Array): RoundData {
  const b = Buffer.from(hookData.subarray(32, 56));
  if (b.length < 24) return { mark: 0, paid: 0, minCur: 0n, minPrev: 0n };
  return { mark: b.readUInt32LE(0), paid: b.readUInt32LE(4), minCur: b.readBigUInt64LE(8), minPrev: b.readBigUInt64LE(16) };
}

/**
 * What a holding is paid in round `round` (`pay_round`'s rule): the least it held from the start of the round before until now (0 when
 * its record is older than that: a holding not touched since keeps its balance), and whether it was already paid this round.
 */
export function roundLeast(data: RoundData, balance: bigint, round: number): { least: bigint; paid: boolean } {
  if (data.paid === round && round !== 0) return { least: 0n, paid: true };
  let least: bigint;
  if (data.mark === round) least = data.minCur < data.minPrev ? data.minCur : data.minPrev;
  else if (data.mark === round - 1) least = data.minCur < balance ? data.minCur : balance;
  else least = balance;
  return { least: least < balance ? least : balance, paid: false };
}

/** A rounds kit's `KitRounds` (`["kit-rounds", mint]`, 191 B, read by hand): the round started, its time, the eligible supply then, and per leg its amount and what of it was paid. */
export interface KitRounds {
  version: number;
  mint: PublicKey;
  round: number;
  startedAt: number;
  supply: bigint;
  count: number;
  legs: { amount: bigint; paid: bigint }[];
}

export function decodeKitRounds(data: Buffer): KitRounds {
  if (data.length < KIT_ROUNDS_LEN || !data.subarray(0, 8).equals(KIT_ROUNDS_DISCRIMINATOR)) throw new Error('not a KitRounds account');
  const count = data[62]!;
  return {
    version: data[8]!,
    mint: new PublicKey(data.subarray(10, 42)),
    round: data.readUInt32LE(42),
    startedAt: Number(data.readBigInt64LE(46)),
    supply: data.readBigUInt64LE(54),
    count,
    legs: Array.from({ length: Math.min(count, 6) }, (_, i) => ({ amount: data.readBigUInt64LE(63 + 16 * i), paid: data.readBigUInt64LE(71 + 16 * i) })),
  };
}

/** The round a rounds kit is in at `now` (`⌊now / round_secs⌋`). */
export const currentRound = (now: number, roundSecs: number): number => (roundSecs > 0 ? Math.floor(now / roundSecs) : 0);

/** A companion's `PayeesLegs` (`["payees-legs", mint]`, 602 B, read by hand): per leg what each payee and the beneficiary are owed in its token. */
export interface PayeesLegs {
  version: number;
  mint: PublicKey;
  /** `owed[leg][payee]`. */
  owed: bigint[][];
  beneficiaryOwed: bigint[];
}

export function decodePayeesLegs(data: Buffer): PayeesLegs {
  if (data.length < PAYEES_LEGS_LEN || !data.subarray(0, 8).equals(PAYEES_LEGS_DISCRIMINATOR)) throw new Error('not a PayeesLegs account');
  return {
    version: data[8]!,
    mint: new PublicKey(data.subarray(10, 42)),
    owed: Array.from({ length: 6 }, (_, leg) => Array.from({ length: 10 }, (_, p) => data.readBigUInt64LE(42 + 80 * leg + 8 * p))),
    beneficiaryOwed: Array.from({ length: 6 }, (_, leg) => data.readBigUInt64LE(522 + 8 * leg)),
  };
}

// ---- the quote reference and the sale ---------------------------------------------------------------------------

/** A quote token's reference: `["quote-ref", quote_mint]` under the launchpad. */
export const quoteReferenceAddress = (quoteMint: PublicKey): PublicKey => pda([enc('quote-ref'), quoteMint.toBuffer()], a.LAUNCH_PROGRAM);

/** `QuoteReference` (189 B): the token's reference pool, its venue, the 8-slot window and what has been sold through it. */
export interface QuoteReference {
  quoteMint: PublicKey;
  venue: Venue;
  via: number;
  pool: PublicKey;
  registrant: PublicKey;
  registeredAt: number;
  depthAt: bigint;
  window: bigint;
  windowValue: bigint;
  paused: boolean;
  soldTotal: bigint;
  lamportsTotal: bigint;
}

export function decodeQuoteReference(data: Buffer): QuoteReference {
  const r = CODERS.launch.accounts.decode('quoteReference', data) as Record<string, unknown>;
  const big = (v: unknown): bigint => BigInt(String(v));
  return {
    quoteMint: r.quoteMint as PublicKey,
    venue: Number(r.venue) as Venue,
    via: Number(r.via),
    pool: r.pool as PublicKey,
    registrant: r.registrant as PublicKey,
    registeredAt: Number(String(r.registeredAt)),
    depthAt: big(r.depthAt),
    window: big(r.window),
    windowValue: big(r.windowValue),
    paused: Boolean(r.paused),
    soldTotal: big(r.soldTotal),
    lamportsTotal: big(r.lamportsTotal),
  };
}

/** A Raydium AMM v4 pool's venue accounts: [program, pool (w), `["amm authority", [nonce]]`, coin vault (w), pc vault (w)]. */
export function ammV4Accounts(pool: PublicKey, nonce: number, coinVault: PublicKey, pcVault: PublicKey): AccountMeta[] {
  const authority = PublicKey.createProgramAddressSync([enc('amm authority'), Buffer.from([nonce])], RAYDIUM_AMM_V4);
  return [ro(RAYDIUM_AMM_V4), rw(pool), ro(authority), rw(coinVault), rw(pcVault)];
}
/** A Raydium CPMM pool's venue accounts: [program, authority, amm config, pool (w), vault 0 (w), vault 1 (w), observation (w)]. */
export const cpmmAccounts = (ammConfig: PublicKey, pool: PublicKey, vault0: PublicKey, vault1: PublicKey, observation: PublicKey): AccountMeta[] => [ro(RAYDIUM_CPMM), ro(CPMM_AUTHORITY), ro(ammConfig), rw(pool), rw(vault0), rw(vault1), rw(observation)];
/** A Raydium CLMM pool's venue accounts: [program, amm config, pool (w), vault 0 (w), vault 1 (w), observation (w), Token-2022, memo, then `ticks` (w): the bitmap extension and the tick arrays the sale crosses, none for a registration]. */
export const clmmAccounts = (ammConfig: PublicKey, pool: PublicKey, vault0: PublicKey, vault1: PublicKey, observation: PublicKey, ticks: readonly PublicKey[] = []): AccountMeta[] => [
  ro(RAYDIUM_CLMM), ro(ammConfig), rw(pool), rw(vault0), rw(vault1), rw(observation), ro(a.SPL_TOKEN_2022_PROGRAM), ro(MEMO_PROGRAM), ...ticks.map((t) => rw(t)),
];
/**
 * A Pump AMM pool's venue accounts for a sale: [program, pool (w), global config, base vault (w), quote vault (w), a protocol fee recipient,
 * its quote account (w), event authority, the coin creator's vault account (w), its authority, fee config, fee program, (`pool_v2` when
 * the sale pays a creator fee), a buyback recipient, its quote account (w)].
 */
export function pumpAccounts(p: { pool: PublicKey; baseVault: PublicKey; quoteVault: PublicKey; protocolFeeRecipient: PublicKey; protocolFeeRecipientAta: PublicKey; coinCreatorVaultAta: PublicKey; coinCreatorVaultAuthority: PublicKey; poolV2: PublicKey | null; buybackWallet: PublicKey; buybackAta: PublicKey }): AccountMeta[] {
  return [
    ro(PUMP_AMM), rw(p.pool), ro(PUMP_GLOBAL_CONFIG), rw(p.baseVault), rw(p.quoteVault), ro(p.protocolFeeRecipient), rw(p.protocolFeeRecipientAta), ro(PUMP_EVENT_AUTHORITY),
    rw(p.coinCreatorVaultAta), ro(p.coinCreatorVaultAuthority), ro(PUMP_FEE_CONFIG), ro(PUMP_FEE_PROGRAM), ...(p.poolV2 ? [ro(p.poolV2)] : []), ro(p.buybackWallet), rw(p.buybackAta),
  ];
}
/** The venue accounts of a sale through USDC: USDC's mint, `seller`'s USDC account (w), USDC's reference (w), the token's pool's venue accounts, then USDC's pool's. */
export const viaUsdcAccounts = (seller: PublicKey, tokenVenue: AccountMeta[], usdcVenue: AccountMeta[]): AccountMeta[] => [
  ro(USDC_MINT), rw(a.associatedTokenAddress(seller, USDC_MINT, a.SPL_TOKEN_PROGRAM)), rw(quoteReferenceAddress(USDC_MINT)), ...tokenVenue, ...usdcVenue,
];

const LAUNCH = (): PublicKey => a.LAUNCH_PROGRAM;
const wsolAta = (owner: PublicKey): PublicKey => a.associatedTokenAddress(owner, a.NATIVE_MINT_KEY, a.SPL_TOKEN_PROGRAM);

export const quoteReference = {
  /**
   * `register_quote_pool` of `quoteMint` by `payer` (anyone, paying the rent the first time): `venue` the pool's venue accounts (a CLMM's
   * without tick arrays); `usdc` USDC's pool's venue accounts for a pool against USDC (or replacing a reference that is via USDC), after
   * USDC's reference and mint; `replaced` the registered pool's venue accounts when replacing it.
   */
  register(payer: PublicKey, quoteMint: PublicKey, venue: AccountMeta[], usdc: AccountMeta[] | null = null, replaced: AccountMeta[] | null = null): TransactionInstruction {
    return ix(LAUNCH(), 'launch', 'registerQuotePool', {}, [
      ...withEvents(LAUNCH(), [rw(payer, true), rw(quoteReferenceAddress(quoteMint)), ro(quoteMint), ro(a.SYSTEM_PROGRAM)]),
      ...venue,
      ...(usdc ? [ro(quoteReferenceAddress(USDC_MINT)), ro(USDC_MINT), ...usdc] : []),
      ...(replaced ?? []),
    ]);
  },
  /** `pause_quote_reference(paused)` by the launchpad's admin. */
  pause(admin: PublicKey, quoteMint: PublicKey, paused: boolean): TransactionInstruction {
    return ix(LAUNCH(), 'launch', 'pauseQuoteReference', { paused }, withEvents(LAUNCH(), [ro(admin, true), ro(a.LAUNCH_CONFIG), rw(quoteReferenceAddress(quoteMint))]));
  },
};

/**
 * `swap_to_sol`'s accounts after its first two (the crank, the seller) and without its fourth to sixth (the `Legs`, the quote mint, the
 * source), as the kit's and the companion's sales take them (`swap_to_sol_rest`): the launch, the reference (w), the seller's wrapped-SOL
 * account (w), wrapped SOL, the leg token's program, SPL Token, the ATA program, the system program, the event authority, the launchpad,
 * then `venue`.
 */
export function swapToSolRest(seller: PublicKey, mint: PublicKey, quoteMint: PublicKey, quoteProgram: PublicKey, venue: AccountMeta[]): AccountMeta[] {
  return [
    ro(a.launchAddress(mint)), rw(quoteReferenceAddress(quoteMint)), rw(wsolAta(seller)), ro(a.NATIVE_MINT_KEY), ro(quoteProgram), ro(a.SPL_TOKEN_PROGRAM), ro(a.ATA_PROGRAM), ro(a.SYSTEM_PROGRAM),
    ro(a.eventAuthority(LAUNCH())), ro(LAUNCH()), ...venue,
  ];
}

export const solSwitch = {
  /** `swap_to_sol(amount_in)` by `seller` (a custodian signing through its program, so only by CPI) of its `source` of leg `keys`' token. */
  swapToSol(crank: PublicKey, seller: PublicKey, keys: LegKeys, source: PublicKey, amountIn: bigint, venue: AccountMeta[]): TransactionInstruction {
    const rest = swapToSolRest(seller, keys.mint, keys.quoteMint, keys.quoteProgram, venue);
    return ix(LAUNCH(), 'launch', 'swapToSol', { amountIn: bn(amountIn) }, [rw(crank, true), rw(seller, true), rest[0]!, ro(legsAddress(keys.mint)), ro(keys.quoteMint), rw(source), ...rest.slice(1)]);
  },
  /** `swap_creator_fees(index, amount_in)` (anyone, a wallet creator's coin with the switch): leg `keys`' fee account sold to SOL onto the launch. */
  swapCreatorFees(crank: PublicKey, keys: LegKeys, index: number, amountIn: bigint, venue: AccountMeta[]): TransactionInstruction {
    const launch = a.launchAddress(keys.mint);
    return ix(LAUNCH(), 'launch', 'swapCreatorFees', { index, amountIn: bn(amountIn) }, [
      ...withEvents(LAUNCH(), [rw(crank, true), rw(launch), ro(legsAddress(keys.mint)), ro(keys.quoteMint), rw(legFeeAccount(keys)), rw(quoteReferenceAddress(keys.quoteMint)), rw(wsolAta(launch)), ro(a.NATIVE_MINT_KEY), ro(keys.quoteProgram), ro(a.SPL_TOKEN_PROGRAM), ro(a.ATA_PROGRAM), ro(a.SYSTEM_PROGRAM)]),
      ...venue,
    ]);
  },
};

// ---- the venues, read off chain ------------------------------------------------------------------------------

const Q64 = 1n << 64n;
const PPM = 1_000_000n;
const keyAt = (d: Buffer, at: number): PublicKey => new PublicKey(d.subarray(at, at + 32));
const u64At = (d: Buffer, at: number): bigint => d.readBigUInt64LE(at);
const u128At = (d: Buffer, at: number): bigint => d.readBigUInt64LE(at) | (d.readBigUInt64LE(at + 8) << 64n);
const i128At = (d: Buffer, at: number): bigint => BigInt.asIntN(128, u128At(d, at));
/** A token account's mint and amount (both programs), or null. */
const tokenAmount = (info: Pick<AccountInfo<Buffer>, 'data' | 'owner'> | null | undefined): { mint: PublicKey; amount: bigint } | null =>
  info && info.data.length >= 72 && (info.owner.equals(a.SPL_TOKEN_PROGRAM) || info.owner.equals(a.SPL_TOKEN_2022_PROGRAM)) ? { mint: keyAt(info.data, 0), amount: u64At(info.data, 64) } : null;

/** What a sale of a token reads of a pool (`bordrless_launch::venues::Market`, without the time-weighted price). */
export interface VenueMarket {
  venue: Venue;
  pool: PublicKey;
  /** The pool's other mint: wrapped SOL or USDC. */
  otherMint: PublicKey;
  /** The token is the pool's first side (AMM v4's coin, CPMM's and CLMM's token 0, Pump AMM's base). */
  tokenIs0: boolean;
  /** The other side's raw units per raw unit of the token now, Q64.64. */
  spot: bigint;
  /** The pool's fee on a sale, millionths. */
  feePpm: bigint;
  /** The other side's depth, raw units (a CLMM's virtual reserve at its price, at most its vault). */
  depth: bigint;
  /** Whether swaps are on now. */
  open: boolean;
  /** The venue accounts of a registration (a CLMM's without tick arrays); a sale on a CLMM adds `clmmTickAccounts`. */
  accounts: AccountMeta[];
  /** The token's program (a CPMM's or CLMM's side), when the pool names it. */
  tokenProgram: PublicKey | null;
  /** A CLMM's tick spacing and current tick (for its tick arrays); null on other venues. */
  clmm: { tickSpacing: number; tickCurrent: number } | null;
}

/** The venue of a pool owned by `program`, or null. */
export function venueOf(program: PublicKey): Venue | null {
  for (const [venue, p] of Object.entries(VENUE_PROGRAMS)) if (p.equals(program)) return Number(venue) as Venue;
  return null;
}

/** What `marketOf` needs fetched besides the pool (vaults, configs, observation, the mint, Pump's global and fee configs), from the pool's own data. */
export function venueReads(venue: Venue, pool: Buffer, token: PublicKey): PublicKey[] {
  switch (venue) {
    case VENUE.ammV4:
      return [keyAt(pool, 336), keyAt(pool, 368)];
    case VENUE.cpmm:
      return [keyAt(pool, 8), keyAt(pool, 72), keyAt(pool, 104)];
    case VENUE.clmm:
      return [keyAt(pool, 9), keyAt(pool, 137), keyAt(pool, 169)];
    case VENUE.pumpAmm:
      return [keyAt(pool, 139), keyAt(pool, 171), PUMP_GLOBAL_CONFIG, PUMP_FEE_CONFIG, token];
  }
}

const OTHER_OK = (m: PublicKey): boolean => m.equals(a.NATIVE_MINT_KEY) || m.equals(USDC_MINT);
function sidesOf(first: PublicKey, second: PublicKey, token: PublicKey): { tokenIs0: boolean; other: PublicKey } | null {
  if (first.equals(token) && OTHER_OK(second)) return { tokenIs0: true, other: second };
  if (second.equals(token) && OTHER_OK(first)) return { tokenIs0: false, other: first };
  return null;
}
const ratioQ64 = (other: bigint, token: bigint): bigint => (token === 0n ? 0n : (other << 64n) / token);

/**
 * A pool's market for a sale of `token` (`bordrless_launch::venues::read_market` without the history), from the pool's account and what
 * `venueReads` named (`get`); null when it is not one of the four venues' pools of `token` against wrapped SOL or USDC, or a read is
 * missing. `now` (unix seconds) is the clock swaps open by.
 */
export function marketOf(poolKey: PublicKey, poolInfo: Pick<AccountInfo<Buffer>, 'data' | 'owner'>, token: PublicKey, get: (key: PublicKey) => Pick<AccountInfo<Buffer>, 'data' | 'owner'> | null, now: number): VenueMarket | null {
  const venue = venueOf(poolInfo.owner);
  const d = poolInfo.data;
  if (venue === VENUE.ammV4) {
    if (d.length !== VENUE_LENGTHS.ammV4) return null;
    const status = u64At(d, 0);
    const open = status === 1n || status === 6n || (status === 7n && BigInt(now) >= u64At(d, 224));
    const nonce = Number(u64At(d, 8));
    const [feeNum, feeDen] = [u64At(d, 176), u64At(d, 184)];
    const s = sidesOf(keyAt(d, 400), keyAt(d, 432), token);
    const coinVault = tokenAmount(get(keyAt(d, 336)));
    const pcVault = tokenAmount(get(keyAt(d, 368)));
    if (!s || !coinVault || !pcVault || feeDen === 0n || nonce > 255) return null;
    const coin = coinVault.amount - u64At(d, 192);
    const pc = pcVault.amount - u64At(d, 200);
    if (coin < 0n || pc < 0n) return null;
    const [tokenSide, otherSide] = s.tokenIs0 ? [coin, pc] : [pc, coin];
    return { venue, pool: poolKey, otherMint: s.other, tokenIs0: s.tokenIs0, spot: ratioQ64(otherSide, tokenSide), feePpm: (feeNum * PPM) / feeDen, depth: otherSide, open, accounts: ammV4Accounts(poolKey, nonce, keyAt(d, 336), keyAt(d, 368)), tokenProgram: a.SPL_TOKEN_PROGRAM, clmm: null };
  }
  if (venue === VENUE.cpmm) {
    if (d.length !== VENUE_LENGTHS.cpmmPool || !d.subarray(0, 8).equals(RAYDIUM_POOL_STATE_DISCRIMINATOR)) return null;
    const open = (d[329]! & 0b100) === 0 && BigInt(now) >= u64At(d, 373);
    const [mint0, mint1] = [keyAt(d, 168), keyAt(d, 200)];
    const s = sidesOf(mint0, mint1, token);
    const config = get(keyAt(d, 8));
    const v0 = tokenAmount(get(keyAt(d, 72)));
    const v1 = tokenAmount(get(keyAt(d, 104)));
    if (!s || !config || config.data.length !== VENUE_LENGTHS.cpmmConfig || !v0 || !v1) return null;
    const fees0 = u64At(d, 341) + u64At(d, 357) + u64At(d, 397);
    const fees1 = u64At(d, 349) + u64At(d, 365) + u64At(d, 405);
    const [net0, net1] = [v0.amount - fees0, v1.amount - fees1];
    if (net0 < 0n || net1 < 0n) return null;
    let feePpm = u64At(config.data, 12);
    if (d[390] !== 0) feePpm += u64At(config.data, 108);
    const [tokenSide, otherSide] = s.tokenIs0 ? [net0, net1] : [net1, net0];
    return {
      venue, pool: poolKey, otherMint: s.other, tokenIs0: s.tokenIs0, spot: ratioQ64(otherSide, tokenSide), feePpm, depth: otherSide, open,
      accounts: cpmmAccounts(keyAt(d, 8), poolKey, keyAt(d, 72), keyAt(d, 104), keyAt(d, 296)), tokenProgram: s.tokenIs0 ? keyAt(d, 232) : keyAt(d, 264), clmm: null,
    };
  }
  if (venue === VENUE.clmm) {
    if (d.length !== VENUE_LENGTHS.clmmPool || !d.subarray(0, 8).equals(RAYDIUM_POOL_STATE_DISCRIMINATOR)) return null;
    const open = (d[389]! & 0b1_0000) === 0;
    const [mint0, mint1] = [keyAt(d, 73), keyAt(d, 105)];
    const s = sidesOf(mint0, mint1, token);
    const config = get(keyAt(d, 9));
    const v0 = tokenAmount(get(keyAt(d, 137)));
    const v1 = tokenAmount(get(keyAt(d, 169)));
    if (!s || !config || config.data.length !== VENUE_LENGTHS.clmmConfig || !v0 || !v1) return null;
    const liquidity = u128At(d, 237);
    const sqrtPrice = u128At(d, 253);
    if (sqrtPrice === 0n) return null;
    const feePpm = BigInt(config.data.readUInt32LE(47));
    const virtualOther = s.tokenIs0 ? (liquidity * sqrtPrice) / Q64 : (liquidity * Q64) / sqrtPrice;
    const vaultOther = s.tokenIs0 ? v1.amount : v0.amount;
    const depth = virtualOther < vaultOther ? virtualOther : vaultOther;
    const spot = s.tokenIs0 ? (sqrtPrice * sqrtPrice) / Q64 : (((1n << 128n) - 1n) / sqrtPrice) ** 2n / Q64;
    return {
      venue, pool: poolKey, otherMint: s.other, tokenIs0: s.tokenIs0, spot, feePpm, depth, open,
      accounts: clmmAccounts(keyAt(d, 9), poolKey, keyAt(d, 137), keyAt(d, 169), keyAt(d, 201)), tokenProgram: get(token)?.owner ?? null,
      clmm: { tickSpacing: d.readUInt16LE(235), tickCurrent: d.readInt32LE(269) },
    };
  }
  if (venue === VENUE.pumpAmm) return pumpMarketOf(poolKey, d, token, get);
  return null;
}

/** Pump AMM's fee rates of a sale, basis points of the quote it brings. */
interface PumpFees {
  lp: bigint;
  protocol: bigint;
  creator: bigint;
}
const pumpFeesAt = (d: Buffer, at: number): PumpFees | null => (d.length >= at + 24 ? { lp: u64At(d, at), protocol: u64At(d, at + 8), creator: u64At(d, at + 16) } : null);
function pumpTier(d: Buffer, at: number, mcap: bigint): { tier: PumpFees | null; end: number } | null {
  if (d.length < at + 4) return null;
  const n = d.readUInt32LE(at);
  const start = at + 4;
  const end = start + 40 * n;
  if (end > d.length) return null;
  if (n === 0) return { tier: null, end };
  const threshold = (i: number): bigint => u128At(d, start + 40 * i);
  let tier: PumpFees | null;
  if (mcap < threshold(0)) tier = pumpFeesAt(d, start + 16);
  else {
    let found = -1;
    for (let i = n - 1; i >= 0; i -= 1) if (mcap >= threshold(i)) { found = i; break; }
    tier = found >= 0 ? pumpFeesAt(d, start + 40 * found + 16) : null;
  }
  return { tier, end };
}
/** The fees Pump's `FeeConfig` sets a pool of `quote` (a canonical, graduated coin's when `canonical`) at market cap `mcap` (`pump::schedule_fees`). */
export function pumpScheduleFees(feeConfig: Buffer, canonical: boolean, quote: PublicKey, mcap: bigint): PumpFees | null {
  const flat = pumpFeesAt(feeConfig, 41);
  const tiers = pumpTier(feeConfig, 65, mcap);
  if (!flat || !tiers) return null;
  const stable = pumpTier(feeConfig, tiers.end, mcap);
  if (!stable) return null;
  const exotic = pumpFeesAt(feeConfig, stable.end) ?? { lp: 0n, protocol: 0n, creator: 0n };
  if (!canonical) return flat;
  if (quote.equals(a.NATIVE_MINT_KEY) || quote.equals(PublicKey.default)) return tiers.tier;
  if (quote.equals(USDC_MINT)) return stable.tier;
  return exotic.lp + exotic.protocol + exotic.creator > 0n ? exotic : flat;
}

/** A Pump AMM pool's market for a sale of its base (`pump::read`), and its sale's venue accounts (`pumpAccounts`); null when refused (cashback, sells off, not WSOL/USDC). */
function pumpMarketOf(poolKey: PublicKey, d: Buffer, token: PublicKey, get: (key: PublicKey) => Pick<AccountInfo<Buffer>, 'data' | 'owner'> | null): VenueMarket | null {
  if (d.length < 243 || !d.subarray(0, 8).equals(PUMP_POOL_DISCRIMINATOR)) return null;
  const [baseMint, quoteMint] = [keyAt(d, 43), keyAt(d, 75)];
  if (!baseMint.equals(token) || !OTHER_OK(quoteMint)) return null;
  const byte = (at: number): number => d[at] ?? 0;
  const tailU64 = (at: number): bigint => (d.length >= at + 8 ? u64At(d, at) : 0n);
  const [mayhem, cashback] = [byte(243) !== 0, byte(244) !== 0];
  if (cashback) return null;
  const virtualQuote = d.length >= 261 ? i128At(d, 245) : 0n;
  const poolCreatorFee = tailU64(261);
  const buckets = tailU64(271) + tailU64(279);
  const creator = keyAt(d, 11);
  const coinCreator = keyAt(d, 211);
  const base = tokenAmount(get(keyAt(d, 139)));
  const quote = tokenAmount(get(keyAt(d, 171)));
  const g = get(PUMP_GLOBAL_CONFIG);
  const f = get(PUMP_FEE_CONFIG);
  const mint = get(token);
  if (!base || !quote || base.amount === 0n || !g || g.data.length < 57 || !g.data.subarray(0, 8).equals(PUMP_GLOBAL_CONFIG_DISCRIMINATOR) || !f || !f.data.subarray(0, 8).equals(PUMP_FEE_CONFIG_DISCRIMINATOR)) return null;
  const open = (g.data[56]! & 0b1_0000) === 0;
  const configurable = (g.data[940] ?? 0) !== 0;
  const effective = quote.amount + virtualQuote;
  if (effective <= 0n) return null;
  const real = quote.amount > buckets ? quote.amount - buckets : 0n;
  const supply = mayhem ? 1_000_000_000_000_000n : mint && mint.data.length >= 44 ? u64At(mint.data, 36) : 0n;
  const mcap = (effective * supply) / base.amount;
  const canonical = creator.equals(pda([enc('pool-authority'), baseMint.toBuffer()], PUMP_BONDING));
  const fees = pumpScheduleFees(f.data, canonical, quoteMint, mcap);
  if (!fees) return null;
  if (configurable && poolCreatorFee !== 0n) fees.creator = poolCreatorFee;
  if (coinCreator.equals(PublicKey.default)) fees.creator = 0n;
  const feeBps = fees.lp + fees.protocol + fees.creator;
  const quoteProgram = a.SPL_TOKEN_PROGRAM;
  const ata = (owner: PublicKey): PublicKey => a.associatedTokenAddress(owner, quoteMint, quoteProgram);
  const recipient = keyAt(g.data, 57);
  const buyback = g.data.length >= 675 ? keyAt(g.data, 643) : recipient;
  const creatorVault = pda([enc('creator_vault'), coinCreator.toBuffer()], PUMP_AMM);
  const poolV2 = pda([enc('pool-v2'), baseMint.toBuffer()], PUMP_AMM);
  return {
    venue: VENUE.pumpAmm, pool: poolKey, otherMint: quoteMint, tokenIs0: true, spot: (effective << 64n) / base.amount, feePpm: feeBps * 100n, depth: effective < real ? effective : real, open,
    accounts: pumpAccounts({ pool: poolKey, baseVault: keyAt(d, 139), quoteVault: keyAt(d, 171), protocolFeeRecipient: recipient, protocolFeeRecipientAta: ata(recipient), coinCreatorVaultAta: ata(creatorVault), coinCreatorVaultAuthority: creatorVault, poolV2: fees.creator > 0n ? poolV2 : null, buybackWallet: buyback, buybackAta: ata(buyback) }),
    tokenProgram: mint?.owner ?? null, clmm: null,
  };
}

/** A CLMM tick array's address: `["tick_array", pool, start as i32 big-endian]`. */
export const clmmTickArrayAddress = (pool: PublicKey, start: number): PublicKey => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(start);
  return pda([enc('tick_array'), pool.toBuffer(), b], RAYDIUM_CLMM);
};
/** A CLMM pool's tick array bitmap extension: `["pool_tick_array_bitmap_extension", pool]`. */
export const clmmBitmapExtensionAddress = (pool: PublicKey): PublicKey => pda([enc('pool_tick_array_bitmap_extension'), pool.toBuffer()], RAYDIUM_CLMM);

/**
 * The bitmap extension and up to `n` tick arrays a CLMM sale of the token crosses, from the one holding the current tick in the sale's
 * direction (token 0 sold: the price falls, starts going down), skipping arrays not made and the extension when the pool has none
 * (`exists` answers whether an account was made: the program stops reading at the first that is neither). Addresses only, in order.
 */
export function clmmTickAccounts(m: Pick<VenueMarket, 'pool' | 'tokenIs0' | 'clmm'>, exists: (key: PublicKey) => boolean, n = 3, scan = 12): PublicKey[] {
  if (!m.clmm) return [];
  const span = 60 * m.clmm.tickSpacing;
  const current = Math.floor(m.clmm.tickCurrent / span) * span;
  const bitmap = clmmBitmapExtensionAddress(m.pool);
  const out: PublicKey[] = exists(bitmap) ? [bitmap] : [];
  const arrays: PublicKey[] = [];
  for (let i = 0; i < scan && arrays.length < n; i += 1) {
    const start = m.tokenIs0 ? current - i * span : current + i * span;
    const key = clmmTickArrayAddress(m.pool, start);
    if (exists(key)) arrays.push(key);
  }
  return [...out, ...arrays];
}

/** A Q64.64 price applied to a raw amount (`value_of`). */
export const valueAtQ64 = (amount: bigint, price: bigint): bigint => (amount * price) >> 64n;
/** The least a sale of `value` brings (`venues::math::min_out`): less the fee, the constant-product impact on `depth`, 1% slack. */
export function swapMinOut(value: bigint, feePpm: bigint, depth: bigint): bigint {
  const afterFee = (value * (PPM - (feePpm < PPM ? feePpm : PPM))) / PPM;
  const afterImpact = depth === 0n ? 0n : (afterFee * depth) / (depth + value);
  return (afterImpact * 9_900n) / 10_000n;
}
/** What a reference may sell per 8-slot window, lamports (`window_cap`): half its fee times its depth. */
export const swapWindowCap = (feePpm: bigint, depthLamports: bigint): bigint => (feePpm * depthLamports) / (2n * PPM);

// ---- events ------------------------------------------------------------------------------------------------

/** The typed views of §7.5's eleven events (`eventsOf`' flattened data). Amounts in raw units of the token named, lamports where said. */
export type PayoutEvent =
  | { kind: 'launch.TokenLaunchPayouts'; launch: string; mint: string; flags: number; rewardKind: number; holderRoundSecs: number; ts: number }
  | { kind: 'launch.QuotePoolRegistered'; quoteMint: string; reference: string; venue: number; via: number; pool: string; replaced: string | null; depthLamports: bigint; feePpm: number; registrant: string; ts: number }
  | { kind: 'launch.QuoteReferencePaused'; quoteMint: string; paused: boolean; ts: number }
  | { kind: 'launch.SwappedToSol'; launch: string; mint: string; quoteMint: string; authority: string; venue: number; via: number; amountIn: bigint; lamportsOut: bigint; minOut: bigint; price: bigint; windowValue: bigint; ts: number }
  | { kind: 'kit.LegsRewardsInstalled'; mint: string; rewardKind: number; roundSecs: number; rewardMint: string; rewardVault: string }
  | { kind: 'kit.RoundStarted'; mint: string; round: number; supply: bigint; amounts: bigint[]; ts: number }
  | { kind: 'kit.RoundPaid'; mint: string; round: number; owner: string; balance: bigint; amounts: bigint[] }
  | { kind: 'kit.RewardsSwappedToSol'; mint: string; index: number; quoteMint: string; amountIn: bigint; lamports: bigint; shared: boolean }
  | { kind: 'companion.LegSharedWithHolders'; companion: string; index: number; quoteMint: string; amount: bigint; bounty: bigint; cranker: string }
  | { kind: 'companion.LegSwappedToSol'; companion: string; index: number; quoteMint: string; part: number; amountIn: bigint; lamports: bigint; cranker: string }
  | { kind: 'companion.LegPayeePaid'; companion: string; index: number; payee: string; amount: bigint; owed: bigint };

const evStr = (v: unknown): string => String(v);
const evBig = (v: unknown): bigint => BigInt(String(v));
const evNum = (v: unknown): number => Number(v);
const evBool = (v: unknown): boolean => v === true || v === 'true';

/** The typed view of a §7.5 event; null for any other. */
export function typedPayoutEvent(ev: { program: string; name: string; data: Record<string, unknown> }): PayoutEvent | null {
  const d = ev.data;
  const key = `${ev.program}.${ev.name}`;
  switch (key) {
    case 'launch.tokenLaunchPayouts':
      return { kind: 'launch.TokenLaunchPayouts', launch: evStr(d.launch), mint: evStr(d.mint), flags: evNum(d.flags), rewardKind: evNum(d.rewardKind), holderRoundSecs: evNum(d.holderRoundSecs), ts: evNum(d.ts) };
    case 'launch.quotePoolRegistered':
      return { kind: 'launch.QuotePoolRegistered', quoteMint: evStr(d.quoteMint), reference: evStr(d.reference), venue: evNum(d.venue), via: evNum(d.via), pool: evStr(d.pool), replaced: d.replaced == null ? null : evStr(d.replaced), depthLamports: evBig(d.depthLamports), feePpm: evNum(d.feePpm), registrant: evStr(d.registrant), ts: evNum(d.ts) };
    case 'launch.quoteReferencePaused':
      return { kind: 'launch.QuoteReferencePaused', quoteMint: evStr(d.quoteMint), paused: evBool(d.paused), ts: evNum(d.ts) };
    case 'launch.swappedToSol':
      return { kind: 'launch.SwappedToSol', launch: evStr(d.launch), mint: evStr(d.mint), quoteMint: evStr(d.quoteMint), authority: evStr(d.authority), venue: evNum(d.venue), via: evNum(d.via), amountIn: evBig(d.amountIn), lamportsOut: evBig(d.lamportsOut), minOut: evBig(d.minOut), price: evBig(d.price), windowValue: evBig(d.windowValue), ts: evNum(d.ts) };
    case 'kit.legsRewardsInstalled':
      return { kind: 'kit.LegsRewardsInstalled', mint: evStr(d.mint), rewardKind: evNum(d.kind), roundSecs: evNum(d.roundSecs), rewardMint: evStr(d.rewardMint), rewardVault: evStr(d.rewardVault) };
    case 'kit.roundStarted':
      return { kind: 'kit.RoundStarted', mint: evStr(d.mint), round: evNum(d.round), supply: evBig(d.supply), amounts: ((d.amounts as unknown[]) ?? []).map(evBig), ts: evNum(d.ts) };
    case 'kit.roundPaid':
      return { kind: 'kit.RoundPaid', mint: evStr(d.mint), round: evNum(d.round), owner: evStr(d.owner), balance: evBig(d.balance), amounts: ((d.amounts as unknown[]) ?? []).map(evBig) };
    case 'kit.rewardsSwappedToSol':
      return { kind: 'kit.RewardsSwappedToSol', mint: evStr(d.mint), index: evNum(d.index), quoteMint: evStr(d.quoteMint), amountIn: evBig(d.amountIn), lamports: evBig(d.lamports), shared: evBool(d.shared) };
    case 'companion.legSharedWithHolders':
      return { kind: 'companion.LegSharedWithHolders', companion: evStr(d.companion), index: evNum(d.index), quoteMint: evStr(d.quoteMint), amount: evBig(d.amount), bounty: evBig(d.bounty), cranker: evStr(d.cranker) };
    case 'companion.legSwappedToSol':
      return { kind: 'companion.LegSwappedToSol', companion: evStr(d.companion), index: evNum(d.index), quoteMint: evStr(d.quoteMint), part: evNum(d.part), amountIn: evBig(d.amountIn), lamports: evBig(d.lamports), cranker: evStr(d.cranker) };
    case 'companion.legPayeePaid':
      return { kind: 'companion.LegPayeePaid', companion: evStr(d.companion), index: evNum(d.index), payee: evStr(d.payee), amount: evBig(d.amount), owed: evBig(d.owed) };
    default:
      return null;
  }
}
