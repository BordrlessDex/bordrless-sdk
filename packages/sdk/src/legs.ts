/**
 * Coins quoted in tokens (docs/token-quotes.md §2.4): a coin launched against one to six real SPL Token
 * or Token-2022 mints, each its own DEX pool (a leg) of kind 2. The builders mirror
 * `bordrless_swap::client::{create_spl_pool, swap_spl, collect_protocol_fees_spl}` and
 * `bordrless_launch::client::{create_token_launch, open_leg, claim_creator_fees_token, leg_swap,
 * leg_swap_with, leg_hook_extras, LegKeys}` account for account; the data comes from the IDL coders.
 * The events' typed views (`SplPoolCreated`, `TokenLaunchCreated`, `LegOpened`,
 * `LegCreatorFeesClaimed`) and a leg swap's creator fee (`legSwapCutsOf`) are here too.
 */
import BN from 'bn.js';
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import * as a from './addresses.ts';
import { CODERS, type ProgramName } from './coders.ts';
import type { DecodedEvent, SwappedEvent } from './events.ts';
import type { CreatePoolArgs, SwapArgs } from './instructions.ts';

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const bn = (v: bigint | number): BN => new BN(v.toString());
const withEvents = (program: PublicKey, keys: AccountMeta[]): AccountMeta[] => [...keys, ro(a.eventAuthority(program)), ro(program)];
const tokenFixed = (): AccountMeta[] => [ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY)];
const enc = (s: string): Buffer => Buffer.from(s, 'utf8');
const pda = (seeds: Buffer[], program: PublicKey): PublicKey => PublicKey.findProgramAddressSync(seeds, program)[0];

function ix(program: PublicKey, coder: ProgramName, name: string, args: Record<string, unknown>, keys: AccountMeta[]): TransactionInstruction {
  return new TransactionInstruction({ programId: program, keys, data: CODERS[coder].instruction.encode(name, args) });
}

/** `LEG_HOOK_FLAGS`: a leg pool's hook flags (the launch pool's without `BEFORE_SWAP_OVERRIDES_FEE`). */
export const LEG_HOOK_FLAGS = 0x3c1;
/** The accounts of a leg's `swap_spl`: 16, then the leg's four hook extras. */
export const LEG_SWAP_ACCOUNTS = 20;

// ---- addresses ---------------------------------------------------------------------------------------

/** The `Legs` of a launch quoted in tokens: `["legs", mint]` under the launchpad. */
export const legsAddress = (mint: PublicKey): PublicKey => pda([enc('legs'), mint.toBuffer()], a.LAUNCH_PROGRAM);
/** A leg's creator-fee token account: `["leg-fees", mint, quote_mint]` under the launchpad (owned by the launch). */
export const legFeesAddress = (mint: PublicKey, quoteMint: PublicKey): PublicKey => pda([enc('leg-fees'), mint.toBuffer(), quoteMint.toBuffer()], a.LAUNCH_PROGRAM);
/** The quote vault of a pool quoted in an SPL token: the pool's associated token account of the quote under its program. */
export const splVaultAddress = (pool: PublicKey, quoteMint: PublicKey, quoteProgram: PublicKey): PublicKey => a.associatedTokenAddress(pool, quoteMint, quoteProgram);

/** What a client needs of one leg to open it, trade it and claim it (`bordrless_launch::client::LegKeys`). */
export interface LegKeys {
  /** The coin. */
  mint: PublicKey;
  /** The leg's quote mint. */
  quoteMint: PublicKey;
  /** Its program (SPL Token or Token-2022). */
  quoteProgram: PublicKey;
  /** The launch's LP fee (`Launch.lp_fee_bps`, part of the pool's address). */
  lpFeeBps: number;
}

/** A leg's pool: `["pool", mint, quote_mint, lp_fee_bps, LAUNCHPAD]` under the DEX. */
export const legPoolAddress = (keys: Pick<LegKeys, 'mint' | 'quoteMint' | 'lpFeeBps'>): PublicKey => a.launchPoolAddress(keys.mint, keys.quoteMint, keys.lpFeeBps);
/** A leg pool's quote vault. */
export const legQuoteVault = (keys: LegKeys): PublicKey => splVaultAddress(legPoolAddress(keys), keys.quoteMint, keys.quoteProgram);
/** `owner`'s associated token account of a leg's quote. */
export const legQuoteAccount = (keys: Pick<LegKeys, 'quoteMint' | 'quoteProgram'>, owner: PublicKey): PublicKey => a.associatedTokenAddress(owner, keys.quoteMint, keys.quoteProgram);
/** A leg's creator-fee account. */
export const legFeeAccount = (keys: Pick<LegKeys, 'mint' | 'quoteMint'>): PublicKey => legFeesAddress(keys.mint, keys.quoteMint);

/** The extra accounts of a leg pool's callbacks, as its registry resolves them: the launch (w), the leg's fee account (w), the `Legs` (w), the kit config (r). */
export const legHookExtras = (mint: PublicKey, quoteMint: PublicKey): AccountMeta[] => [rw(a.launchAddress(mint)), rw(legFeesAddress(mint, quoteMint)), rw(legsAddress(mint)), ro(a.kitConfigAddress(mint))];

// ---- the DEX -------------------------------------------------------------------------------------------

export interface CreateSplPoolKeys {
  payer: PublicKey;
  /** Owns the base deposit's holding. */
  authority: PublicKey;
  /** The DEX config's treasury. */
  treasury: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  quoteProgram: PublicKey;
  /** The hook program's `["hook-authority"]`, which signs. */
  hookCaller: PublicKey;
}

export interface SwapSplKeys {
  trader: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  quoteProgram: PublicKey;
  /** The trader's base holding (or, on a buy, any holding of the base mint to deliver to). */
  traderBase: PublicKey;
  /** A token account of the quote: on a buy the trader's (it pays), on a sell any to deliver to. */
  traderQuote: PublicKey;
  hookProgram: PublicKey | null;
  /** Pass the base mint writable (a hook may burn base; never a leg). */
  baseMintWritable?: boolean;
}

export const splPool = {
  /** `create_spl_pool`: 18 accounts, then exactly the base mint's token-hook slice (`args.baseHookAccounts` long; none for a leg). */
  createSplPool(keys: CreateSplPoolKeys, args: CreatePoolArgs, baseSlice: AccountMeta[] = []): TransactionInstruction {
    const pool = a.poolAddress(keys.baseMint, keys.quoteMint, args.lpFeeBps, args.hookProgram);
    const metas = [
      rw(keys.payer, true),
      ro(keys.authority, true),
      rw(a.SWAP_CONFIG),
      rw(keys.treasury),
      ro(keys.baseMint),
      ro(keys.quoteMint),
      rw(pool),
      rw(a.vaultAddress(pool, keys.baseMint)),
      rw(splVaultAddress(pool, keys.quoteMint, keys.quoteProgram)),
      rw(a.holdingAddress(keys.baseMint, keys.authority)),
      ro(keys.hookCaller, true),
      ...tokenFixed(),
      ro(keys.quoteProgram),
      ro(a.ATA_PROGRAM),
      ro(a.SYSTEM_PROGRAM),
    ];
    const data = { args: { ...args, hookProgram: args.hookProgram ?? PublicKey.default, virtualBase: bn(args.virtualBase), virtualQuote: bn(args.virtualQuote), baseAmount: bn(args.baseAmount), quoteAmount: bn(args.quoteAmount), hookData: Buffer.from(args.hookData) } };
    return ix(a.SWAP_PROGRAM, 'swap', 'createSplPool', data, [...withEvents(a.SWAP_PROGRAM, metas), ...baseSlice]);
  },
  /** `swap_spl`: 16 accounts, then `extras` (the in and out token-hook slices, the pool hook's extras; the quote side's slice is empty). */
  swapSpl(keys: SwapSplKeys, args: SwapArgs, extras: AccountMeta[] = []): TransactionInstruction {
    const metas = [
      ro(keys.trader, true),
      ro(a.SWAP_CONFIG),
      rw(keys.pool),
      keys.baseMintWritable ? rw(keys.baseMint) : ro(keys.baseMint),
      ro(keys.quoteMint),
      rw(a.vaultAddress(keys.pool, keys.baseMint)),
      rw(splVaultAddress(keys.pool, keys.quoteMint, keys.quoteProgram)),
      rw(keys.traderBase),
      rw(keys.traderQuote),
      ro(keys.hookProgram ?? a.SWAP_PROGRAM),
      ro(keys.hookProgram ? a.dexHookSigner(keys.hookProgram) : a.SWAP_PROGRAM),
      ...tokenFixed(),
      ro(keys.quoteProgram),
    ];
    const data = { args: { ...args, amountIn: bn(args.amountIn), minAmountOut: bn(args.minAmountOut), hookData: Buffer.from(args.hookData) } };
    return ix(a.SWAP_PROGRAM, 'swap', 'swapSpl', data, [...withEvents(a.SWAP_PROGRAM, metas), ...extras]);
  },
  /** `collect_protocol_fees_spl`: anyone (`payer`, who pays the collector's token account if it must be made) moves a pool's protocol fees to `feeCollector`'s (the config's) associated token account of the quote. */
  collectProtocolFeesSpl(payer: PublicKey, pool: PublicKey, quoteMint: PublicKey, quoteProgram: PublicKey, feeCollector: PublicKey): TransactionInstruction {
    return ix(
      a.SWAP_PROGRAM,
      'swap',
      'collectProtocolFeesSpl',
      {},
      withEvents(a.SWAP_PROGRAM, [rw(payer, true), ro(a.SWAP_CONFIG), rw(pool), ro(quoteMint), rw(splVaultAddress(pool, quoteMint, quoteProgram)), ro(feeCollector), rw(a.associatedTokenAddress(feeCollector, quoteMint, quoteProgram)), ro(quoteProgram), ro(a.ATA_PROGRAM), ro(a.SYSTEM_PROGRAM)]),
    );
  },
};

// ---- the launchpad -----------------------------------------------------------------------------------

export interface CreateTokenLaunchArgs {
  name: string;
  symbol: string;
  uri: string;
  creatorFeeBps: number;
  /** One per quote mint, in the same order (raw units of each). */
  virtualQuotes: bigint[];
}

export const tokenLaunch = {
  /** `create_token_launch`: `mint` a fresh keypair that signs, `treasury` the launch config's treasury, `quoteMints` the legs' quote mints in order (the remaining accounts). */
  createTokenLaunch(creator: PublicKey, mint: PublicKey, treasury: PublicKey, args: CreateTokenLaunchArgs, quoteMints: PublicKey[]): TransactionInstruction {
    const launch = a.launchAddress(mint);
    const metas = withEvents(a.LAUNCH_PROGRAM, [rw(creator, true), rw(a.LAUNCH_CONFIG), rw(treasury), rw(mint, true), rw(launch), rw(legsAddress(mint)), rw(a.holdingAddress(mint, launch)), ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY), ro(a.SYSTEM_PROGRAM)]);
    return ix(a.LAUNCH_PROGRAM, 'launch', 'createTokenLaunch', { args: { ...args, virtualQuotes: args.virtualQuotes.map(bn) } }, [...metas, ...quoteMints.map((q) => ro(q))]);
  },
  /** `open_leg(index)`, `payer` paying the rent; `dexTreasury` the DEX config's treasury. */
  openLeg(payer: PublicKey, dexTreasury: PublicKey, keys: LegKeys, index: number): TransactionInstruction {
    const launch = a.launchAddress(keys.mint);
    const pool = legPoolAddress(keys);
    return ix(
      a.LAUNCH_PROGRAM,
      'launch',
      'openLeg',
      { index },
      withEvents(a.LAUNCH_PROGRAM, [
        rw(payer, true),
        ro(launch),
        rw(legsAddress(keys.mint)),
        ro(keys.mint),
        ro(keys.quoteMint),
        rw(legFeeAccount(keys)),
        rw(a.holdingAddress(keys.mint, launch)),
        rw(a.launchRegistryAddress(pool)),
        rw(a.SWAP_CONFIG),
        rw(dexTreasury),
        rw(pool),
        rw(a.vaultAddress(pool, keys.mint)),
        rw(legQuoteVault(keys)),
        ro(a.LAUNCH_HOOK_AUTHORITY),
        ro(a.SWAP_EVENT_AUTHORITY),
        ro(a.SWAP_PROGRAM),
        ro(a.TOKEN_PROGRAM),
        ro(a.TOKEN_EVENT_AUTHORITY),
        ro(keys.quoteProgram),
        ro(a.ATA_PROGRAM),
        ro(a.SYSTEM_PROGRAM),
      ]),
    );
  },
  /** `claim_creator_fees_token(index)` of the launch's `creator`, sent by `payer` (anyone; the creator's associated token account of the quote is made if missing, at the payer's cost). */
  claimCreatorFeesToken(payer: PublicKey, creator: PublicKey, keys: LegKeys, index: number): TransactionInstruction {
    return ix(
      a.LAUNCH_PROGRAM,
      'launch',
      'claimCreatorFeesToken',
      { index },
      withEvents(a.LAUNCH_PROGRAM, [rw(payer, true), ro(a.launchAddress(keys.mint)), rw(legsAddress(keys.mint)), ro(keys.quoteMint), rw(legFeeAccount(keys)), ro(creator), rw(legQuoteAccount(keys, creator)), ro(keys.quoteProgram), ro(a.ATA_PROGRAM), ro(a.SYSTEM_PROGRAM)]),
    );
  },
  /** A `swap_spl` on a leg with the given token accounts: `traderBase` the coin holding (the trader's on a sell, the recipient's on a buy), `traderQuote` the quote's token account (the trader's on a buy, the recipient's on a sell). 20 accounts. */
  legSwapWith(keys: LegKeys, trader: PublicKey, traderBase: PublicKey, traderQuote: PublicKey, direction: 0 | 1, amountIn: bigint, minAmountOut: bigint): TransactionInstruction {
    return splPool.swapSpl(
      { trader, pool: legPoolAddress(keys), baseMint: keys.mint, quoteMint: keys.quoteMint, quoteProgram: keys.quoteProgram, traderBase, traderQuote, hookProgram: a.LAUNCH_PROGRAM, baseMintWritable: false },
      { direction, amountIn, minAmountOut, inHookAccounts: 0, outHookAccounts: 0, hookData: new Uint8Array() },
      legHookExtras(keys.mint, keys.quoteMint),
    );
  },
  /** A `swap_spl` on a leg by `trader`, delivered to `recipient`: a buy pays from the trader's associated token account of the quote into the recipient's holding of the coin; a sell delivers to the recipient's associated token account of the quote. */
  legSwap(keys: LegKeys, trader: PublicKey, recipient: PublicKey, direction: 0 | 1, amountIn: bigint, minAmountOut: bigint): TransactionInstruction {
    const [traderBase, traderQuote] = direction === 1 ? [a.holdingAddress(keys.mint, recipient), legQuoteAccount(keys, trader)] : [a.holdingAddress(keys.mint, trader), legQuoteAccount(keys, recipient)];
    return tokenLaunch.legSwapWith(keys, trader, traderBase, traderQuote, direction, amountIn, minAmountOut);
  },
};

// ---- events ------------------------------------------------------------------------------------------

const str = (v: unknown): string => String(v);
const big = (v: unknown): bigint => BigInt(String(v));
const num = (v: unknown): number => Number(v);

/** The DEX's `SplPoolCreated`: right after a kind-2 pool's `PoolCreated`. */
export interface SplPoolCreatedEvent {
  kind: 'swap.SplPoolCreated';
  pool: string;
  quoteMint: string;
  quoteProgram: string;
  quoteDecimals: number;
  quoteVault: string;
}

/** One leg's terms in `TokenLaunchCreated`. */
export interface LegTermsEvent {
  quoteMint: string;
  quoteProgram: string;
  decimals: number;
  virtualQuote: bigint;
  share: bigint;
  pool: string;
  feeAccount: string;
}

/** The launchpad's `TokenLaunchCreated` (no `LaunchCreated` for such a launch). */
export interface TokenLaunchCreatedEvent {
  kind: 'launch.TokenLaunchCreated';
  launch: string;
  mint: string;
  creator: string;
  legsAccount: string;
  name: string;
  symbol: string;
  uri: string;
  supply: bigint;
  decimals: number;
  creatorFeeBps: number;
  lpFeeBps: number;
  launchFeeLamports: bigint;
  legs: LegTermsEvent[];
  slot: bigint;
  ts: number;
}

/** The launchpad's `LegOpened`: the leg's pool exists (the DEX's `PoolCreated` and `SplPoolCreated` come before it in the same transaction). */
export interface LegOpenedEvent {
  kind: 'launch.LegOpened';
  launch: string;
  mint: string;
  index: number;
  quoteMint: string;
  pool: string;
  feeAccount: string;
  virtualQuote: bigint;
  share: bigint;
  /** Legs open now, this one included; trading starts when it equals `count`. */
  opened: number;
  count: number;
  payer: string;
  slot: bigint;
  ts: number;
}

/** The launchpad's `LegCreatorFeesClaimed`. */
export interface LegCreatorFeesClaimedEvent {
  kind: 'launch.LegCreatorFeesClaimed';
  launch: string;
  mint: string;
  index: number;
  quoteMint: string;
  creator: string;
  destination: string;
  amount: bigint;
  claimedTotal: bigint;
  slot: bigint;
  ts: number;
}

export type LegEvent = SplPoolCreatedEvent | TokenLaunchCreatedEvent | LegOpenedEvent | LegCreatorFeesClaimedEvent;

/** The typed view of a quote-token event (`eventsOf`'s flattened data); null for any other event. */
export function typedLegEvent(ev: Pick<DecodedEvent, 'program' | 'name' | 'data'>): LegEvent | null {
  const d = ev.data;
  if (ev.program === 'swap' && ev.name === 'splPoolCreated') return { kind: 'swap.SplPoolCreated', pool: str(d.pool), quoteMint: str(d.quoteMint), quoteProgram: str(d.quoteProgram), quoteDecimals: num(d.quoteDecimals), quoteVault: str(d.quoteVault) };
  if (ev.program !== 'launch') return null;
  if (ev.name === 'tokenLaunchCreated') {
    const legs = (d.legs as Record<string, unknown>[]).map((l) => ({ quoteMint: str(l.quoteMint), quoteProgram: str(l.quoteProgram), decimals: num(l.decimals), virtualQuote: big(l.virtualQuote), share: big(l.share), pool: str(l.pool), feeAccount: str(l.feeAccount) }));
    return { kind: 'launch.TokenLaunchCreated', launch: str(d.launch), mint: str(d.mint), creator: str(d.creator), legsAccount: str(d.legsAccount), name: str(d.name), symbol: str(d.symbol), uri: str(d.uri), supply: big(d.supply), decimals: num(d.decimals), creatorFeeBps: num(d.creatorFeeBps), lpFeeBps: num(d.lpFeeBps), launchFeeLamports: big(d.launchFeeLamports), legs, slot: big(d.slot), ts: num(d.ts) };
  }
  if (ev.name === 'legOpened') return { kind: 'launch.LegOpened', launch: str(d.launch), mint: str(d.mint), index: num(d.index), quoteMint: str(d.quoteMint), pool: str(d.pool), feeAccount: str(d.feeAccount), virtualQuote: big(d.virtualQuote), share: big(d.share), opened: num(d.opened), count: num(d.count), payer: str(d.payer), slot: big(d.slot), ts: num(d.ts) };
  if (ev.name === 'legCreatorFeesClaimed') return { kind: 'launch.LegCreatorFeesClaimed', launch: str(d.launch), mint: str(d.mint), index: num(d.index), quoteMint: str(d.quoteMint), creator: str(d.creator), destination: str(d.destination), amount: big(d.amount), claimedTotal: big(d.claimedTotal), slot: big(d.slot), ts: num(d.ts) };
  return null;
}

/**
 * The creator fee a leg's `Swapped` paid (§2.4: the launchpad's answer is the creator fee alone, a
 * quote-side delta to the leg's fee account, from a buy's input or a sell's output), raw quote units.
 */
export function legSwapCutsOf(ev: Pick<SwappedEvent, 'deltasIn' | 'deltasOut'>, mint: PublicKey, quoteMint: PublicKey): { creatorFee: bigint } {
  const fees = legFeesAddress(mint, quoteMint).toBase58();
  const sum = [...ev.deltasIn, ...ev.deltasOut].filter((d) => d.holding === fees).reduce((t, d) => t + d.amount, 0n);
  return { creatorFee: sum };
}
