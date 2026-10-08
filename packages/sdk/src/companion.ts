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
 * `bordrless_companion::client` account for account.
 */
import { PublicKey, type AccountMeta, type TransactionInstruction, TransactionInstruction as Ix } from '@solana/web3.js';
import BN from 'bn.js';
import * as a from './addresses.ts';
import { CODERS } from './coders.ts';
import { kitTokenHook } from './hooks.ts';
import { bridge, kit, launch, token, type CreateLaunchArgs, type LaunchKeys } from './instructions.ts';

/** What every creator fee claim pays for, in basis points summing to 10,000. */
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
}

/** The templates Studio and the launch form offer. */
export const COMPANION_TEMPLATES = {
  /** No dev at all: every creator fee buys the token back and burns it. */
  buysItself: { buybackBps: 10_000, holdersBps: 0, beneficiaryBps: 0 },
  /** Half to holders through the kit, half to the dev; the dev's buy vests (holder rewards needed). */
  rugProofDev: { buybackBps: 0, holdersBps: 5_000, beneficiaryBps: 5_000 },
  /** Half bought back and burned, half to holders (holder rewards needed). */
  buybackAndReward: { buybackBps: 5_000, holdersBps: 5_000, beneficiaryBps: 0 },
} as const satisfies Record<string, CompanionSplit>;

/** The defaults Studio offers with a template: a 0.5% bounty, buybacks of at most 1 SOL a minute apart, a 30-day vest. */
export const COMPANION_DEFAULTS = { bountyBps: 50, maxBuyback: 1_000_000_000n, buybackInterval: 60, vestSecs: 30 * 86_400 } as const;

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const big = (v: unknown): bigint => BigInt(String(v));
const num = (v: unknown): number => Number(v);

/** An instruction's accounts and program as remaining accounts: nobody marked a signer but `keep`. */
function remaining(inner: TransactionInstruction, keep: PublicKey[] = []): AccountMeta[] {
  return [...inner.keys.map((m) => ({ pubkey: m.pubkey, isSigner: m.isSigner && keep.some((k) => k.equals(m.pubkey)), isWritable: m.isWritable })), ro(inner.programId)];
}

function build(name: string, args: Record<string, unknown>, named: AccountMeta[], extra: AccountMeta[]): TransactionInstruction {
  const keys = [...named, ro(a.COMPANION_EVENT_AUTHORITY), ro(a.COMPANION_PROGRAM), ...extra];
  return new Ix({ programId: a.COMPANION_PROGRAM, keys, data: CODERS.companion.instruction.encode(name, args) });
}

/** The launch's mint as token instructions take it: the kit with its extras with kit rules, none without. */
const mintHook = (keys: LaunchKeys, rewards: boolean) => (keys.modules === 0 ? null : kitTokenHook(keys.mint, rewards ? a.holderVaultAddress(keys.mint, keys.quoteMint) : null));

const step = (cranker: PublicKey, mint: PublicKey): AccountMeta[] => [rw(cranker, true), rw(a.companionAddress(mint)), rw(a.companionCreatorAddress(mint)), ro(a.launchAddress(mint)), ro(a.SYSTEM_PROGRAM)];
const unwrapAccounts = (creator: PublicKey): AccountMeta[] => remaining(bridge.unwrapSol(creator, 0n));

export const companion = {
  /** `create`: a companion for `mint` (a fresh keypair, which signs: nobody else can make its companion), `payer` paying its rent and `args.fund`. */
  create(payer: PublicKey, beneficiary: PublicKey, mint: PublicKey, args: CompanionArgs): TransactionInstruction {
    const creator = a.companionCreatorAddress(mint);
    const named = [rw(payer, true), ro(beneficiary), ro(mint, true), rw(a.companionAddress(mint)), rw(creator), ro(a.BRIDGED_SOL_MINT), rw(a.holdingAddress(a.BRIDGED_SOL_MINT, creator)), ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY), ro(a.SYSTEM_PROGRAM)];
    const data = { args: { split: args.split, bountyBps: args.bountyBps, maxBuyback: new BN(args.maxBuyback.toString()), buybackInterval: new BN(args.buybackInterval), vestSecs: new BN(args.vestSecs), fund: new BN(args.fund.toString()) } };
    return build('create', data, named, remaining(token.createHolding(payer, a.BRIDGED_SOL_MINT, creator)));
  },
  /** `launch`: `create_launch` through the companion, its creator address the creator. Build `createLaunch` with `companionCreatorAddress(mint)` as the creator; the mint signs. */
  launch(launcher: PublicKey, mint: PublicKey, createLaunch: TransactionInstruction, args: CreateLaunchArgs): TransactionInstruction {
    const named = [ro(launcher, true), rw(a.companionAddress(mint)), rw(a.companionCreatorAddress(mint)), ro(a.LAUNCH_PROGRAM)];
    const inner = createLaunch.keys.map((m) => ({ pubkey: m.pubkey, isSigner: m.isSigner && m.pubkey.equals(mint), isWritable: m.isWritable }));
    const data = { args: { ...args, virtualQuote: new BN(args.virtualQuote.toString()), rules: { ...args.rules } } };
    return build('launch', data, named, inner);
  },
  /** `dev_buy`: the beneficiary's buy, held by the companion and vesting to them. */
  devBuy(beneficiary: PublicKey, keys: LaunchKeys, lamports: bigint, minOut: bigint): TransactionInstruction {
    const creator = a.companionCreatorAddress(keys.mint);
    const extra = [...remaining(token.createHolding(beneficiary, keys.mint, creator)), ...remaining(bridge.wrapSol(creator, lamports)), ...remaining(launch.swap(keys, creator, creator, 1, lamports, minOut))];
    const named = [rw(beneficiary, true), rw(a.companionAddress(keys.mint)), rw(creator), ro(a.launchAddress(keys.mint)), ro(a.SYSTEM_PROGRAM)];
    return build('devBuy', { lamports: new BN(lamports.toString()), minOut: new BN(minOut.toString()) }, named, extra);
  },
  /** `claim_fees` (anyone): the launch's creator fees claimed, the bounty paid, the rest split (a companion launch never pays a config author). */
  claimFees(cranker: PublicKey, mint: PublicKey): TransactionInstruction {
    const creator = a.companionCreatorAddress(mint);
    return build('claimFees', {}, step(cranker, mint), [...remaining(launch.claimCreatorFees(creator, mint, a.BRIDGED_SOL_MINT)), ...unwrapAccounts(creator)]);
  },
  /**
   * `buyback` (anyone); `rewards`: the launch has holder rewards. It buys at most `maxBuyback` and 1%
   * of the pool's quote side; while the price is more than 3% above the companion's reference price
   * it waits instead (the reference moving toward the price, 5% an interval).
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
  /** `release` (anyone): the dev bag's vested tokens to the beneficiary. */
  release(cranker: PublicKey, keys: LaunchKeys, rewards: boolean, beneficiary: PublicKey): TransactionInstruction {
    const creator = a.companionCreatorAddress(keys.mint);
    const transfer = token.transfer(creator, a.holdingAddress(keys.mint, creator), a.holdingAddress(keys.mint, beneficiary), keys.mint, 0n, mintHook(keys, rewards));
    return build('release', {}, step(cranker, keys.mint), [...remaining(token.createHolding(cranker, keys.mint, beneficiary)), ...remaining(transfer)]);
  },
};

/** A `Companion` account, by its IDL name `companion`. */
export function decodeCompanion(data: Buffer): Companion {
  const r = CODERS.companion.accounts.decode('companion', data) as Record<string, unknown>;
  const s = r.split as Record<string, unknown>;
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
  };
}

/** Tokens of a companion's dev bag vested at `now` (the program's `Companion::vested`). */
export function companionVested(c: Pick<Companion, 'launched' | 'launchedAt' | 'vestSecs' | 'devTokens'>, now: number): bigint {
  if (!c.launched) return 0n;
  if (c.vestSecs <= 0) return c.devTokens;
  const elapsed = BigInt(Math.min(Math.max(now - c.launchedAt, 0), c.vestSecs));
  return (c.devTokens * elapsed) / BigInt(c.vestSecs);
}
