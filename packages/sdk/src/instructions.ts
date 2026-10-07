/**
 * Instruction builders for the v2 programs. The account order of each is the program's `Accounts`
 * struct, exactly as programs-summary §3 lists it and each program's `src/client.rs` builds it (the
 * reference this file mirrors), with the event authority and the program appended as
 * `#[event_cpi]` does; the data comes from the IDL coder. Optional Anchor accounts are passed as the
 * program's own id when absent.
 *
 * Hook accounts (programs-summary §2.1 to §2.3): token instructions take a hooked mint's hook program
 * and the token program's signer for it in two slots and the hook's extras as remaining accounts
 * (`TokenHook`, from `hooks.ts`); DEX instructions take each hooked mint's slice `[hook program,
 * token signer for it, ...extras]` in their remaining accounts, and the pool hook's signer is the
 * DEX's for that hook. No instruction takes the v1 global hook signers any more.
 */
import BN from 'bn.js';
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import type { RuleBounds } from '@bordrless/shared';
import * as a from './addresses.ts';
import { kitModulesOf, rulesBurn, type Launch, type LaunchRulesData } from './accounts.ts';
import { CODERS, type ProgramName } from './coders.ts';
import { customHookLaunchAccounts, customHookSlice, kitHookSlice, tokenHookSlice, type CustomHookAccounts, type TokenHook } from './hooks.ts';

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const bn = (v: bigint | number): BN => new BN(v.toString());
/** An optional account: the key, or the program's own id for none. */
const opt = (program: PublicKey, key: PublicKey | null): AccountMeta => ro(key ?? program);

function ix(program: PublicKey, coder: ProgramName, name: string, args: Record<string, unknown>, keys: AccountMeta[]): TransactionInstruction {
  return new TransactionInstruction({ programId: program, keys, data: CODERS[coder].instruction.encode(name, args) });
}

const withEvents = (program: PublicKey, keys: AccountMeta[]): AccountMeta[] => [...keys, ro(a.eventAuthority(program)), ro(program)];
/** The token program and its event authority, as the DEX, the bridge, the launch and the kit take them (a mint's hook signer travels with its hook). */
const tokenFixed = (): AccountMeta[] => [ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY)];
/** The two hook slots of a token instruction: the hook program and the token program's signer for it, each the token program's id without a hook. */
const hookSlots = (hook: TokenHook | null): AccountMeta[] => [opt(a.TOKEN_PROGRAM, hook?.program ?? null), opt(a.TOKEN_PROGRAM, hook?.signer ?? null)];

// ---- compute budget --------------------------------------------------------------------------------

export function setComputeUnitLimit(units: number): TransactionInstruction {
  const data = Buffer.alloc(5);
  data[0] = 2;
  data.writeUInt32LE(units, 1);
  return new TransactionInstruction({ programId: a.COMPUTE_BUDGET_PROGRAM, keys: [], data });
}

export function setComputeUnitPrice(microLamports: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(microLamports, 1);
  return new TransactionInstruction({ programId: a.COMPUTE_BUDGET_PROGRAM, keys: [], data });
}

// ---- associated token accounts (SPL, for the bridge) ----------------------------------------------

/** ATA program CreateIdempotent: the associated token account of owner for an SPL mint. */
export function createAssociatedTokenAccountIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.ATA_PROGRAM,
    keys: [rw(payer, true), rw(a.associatedTokenAddress(owner, mint, tokenProgram)), ro(owner), ro(mint), ro(a.SYSTEM_PROGRAM), ro(tokenProgram)],
    data: Buffer.from([1]),
  });
}

// ---- token standard --------------------------------------------------------------------------------

export interface CreateMintArgs {
  decimals: number;
  name: string;
  symbol: string;
  uri: string;
  maxSupply: bigint;
  mintAuthority: PublicKey | null;
  freezeAuthority: PublicKey | null;
  hookProgram: PublicKey | null;
  hookFlags: number;
  hookAuthority: PublicKey | null;
  metadataAuthority: PublicKey | null;
}

/** `set_authority`'s kind. */
export type AuthorityKind = 'mint' | 'freeze' | 'hook' | 'metadata';

export const token = {
  createMint(payer: PublicKey, mint: PublicKey, args: CreateMintArgs): TransactionInstruction {
    return ix(a.TOKEN_PROGRAM, 'token', 'createMint', { args: { ...args, maxSupply: bn(args.maxSupply) } }, withEvents(a.TOKEN_PROGRAM, [rw(payer, true), rw(mint, true), ro(a.SYSTEM_PROGRAM)]));
  },
  /** Idempotent. */
  createHolding(payer: PublicKey, mint: PublicKey, owner: PublicKey): TransactionInstruction {
    return ix(a.TOKEN_PROGRAM, 'token', 'createHolding', {}, withEvents(a.TOKEN_PROGRAM, [rw(payer, true), ro(mint), ro(owner), rw(a.holdingAddress(mint, owner)), ro(a.SYSTEM_PROGRAM)]));
  },
  /**
   * `transfer`: 8 accounts, then the hook's extras. `hook` is the mint's (`kitTokenHook`,
   * `tokenHookOf` or `fetchTokenHook`, resolved for this transfer); null for a mint without one.
   * The mint stays read-only: no transfer write-locks a mint.
   */
  transfer(authority: PublicKey, source: PublicKey, destination: PublicKey, mint: PublicKey, amount: bigint, hook: TokenHook | null = null): TransactionInstruction {
    const keys = [...withEvents(a.TOKEN_PROGRAM, [ro(authority, true), rw(source), rw(destination), ro(mint), ...hookSlots(hook)]), ...(hook?.extras ?? [])];
    return ix(a.TOKEN_PROGRAM, 'token', 'transfer', { amount: bn(amount) }, keys);
  },
  /** `mint_to`: 7 accounts, then the hook's extras (resolved with the mint in the source slot). */
  mintTo(authority: PublicKey, mint: PublicKey, destination: PublicKey, amount: bigint, hook: TokenHook | null = null): TransactionInstruction {
    const keys = [...withEvents(a.TOKEN_PROGRAM, [ro(authority, true), rw(mint), rw(destination), ...hookSlots(hook)]), ...(hook?.extras ?? [])];
    return ix(a.TOKEN_PROGRAM, 'token', 'mintTo', { amount: bn(amount) }, keys);
  },
  /** `burn`: 7 accounts, then the hook's extras (resolved with the mint in the destination slot). */
  burn(authority: PublicKey, source: PublicKey, mint: PublicKey, amount: bigint, hook: TokenHook | null = null): TransactionInstruction {
    const keys = [...withEvents(a.TOKEN_PROGRAM, [ro(authority, true), rw(source), rw(mint), ...hookSlots(hook)]), ...(hook?.extras ?? [])];
    return ix(a.TOKEN_PROGRAM, 'token', 'burn', { amount: bn(amount) }, keys);
  },
  approve(owner: PublicKey, holding: PublicKey, delegate: PublicKey, amount: bigint): TransactionInstruction {
    return ix(a.TOKEN_PROGRAM, 'token', 'approve', { amount: bn(amount) }, withEvents(a.TOKEN_PROGRAM, [ro(owner, true), rw(holding), ro(delegate)]));
  },
  revoke(owner: PublicKey, holding: PublicKey): TransactionInstruction {
    return ix(a.TOKEN_PROGRAM, 'token', 'revoke', {}, withEvents(a.TOKEN_PROGRAM, [ro(owner, true), rw(holding)]));
  },
  /**
   * `close_holding` (v2: with the holding's mint): an empty holding back to rent. Refused
   * (`HookDataNotEmpty`) while the mint's hook writes hook data and the holding still keeps some.
   */
  closeHolding(owner: PublicKey, mint: PublicKey, holding: PublicKey, destination: PublicKey): TransactionInstruction {
    return ix(a.TOKEN_PROGRAM, 'token', 'closeHolding', {}, withEvents(a.TOKEN_PROGRAM, [ro(owner, true), ro(mint), rw(holding), rw(destination)]));
  },
  /**
   * `write_hook_data` (new): the mint's hook program replaces a holding's 64 bytes, signing with its
   * `["hook-authority"]` PDA, so only a CPI from that hook can send it (the kit's `claim` does).
   */
  writeHookData(hookSigner: PublicKey, mint: PublicKey, holding: PublicKey, data: Uint8Array): TransactionInstruction {
    if (data.length !== 64) throw new RangeError(`hook data is 64 bytes, not ${data.length}`);
    return ix(a.TOKEN_PROGRAM, 'token', 'writeHookData', { data: Array.from(data) }, withEvents(a.TOKEN_PROGRAM, [ro(hookSigner, true), ro(mint), rw(holding)]));
  },
  setFrozen(authority: PublicKey, mint: PublicKey, holding: PublicKey, frozen: boolean): TransactionInstruction {
    return ix(a.TOKEN_PROGRAM, 'token', 'setFrozen', { frozen }, withEvents(a.TOKEN_PROGRAM, [ro(authority, true), ro(mint), rw(holding)]));
  },
  setAuthority(authority: PublicKey, mint: PublicKey, kind: AuthorityKind, newAuthority: PublicKey | null): TransactionInstruction {
    return ix(a.TOKEN_PROGRAM, 'token', 'setAuthority', { kind: { [kind]: {} }, newAuthority }, withEvents(a.TOKEN_PROGRAM, [ro(authority, true), rw(mint)]));
  },
  setHook(authority: PublicKey, mint: PublicKey, hookProgram: PublicKey | null, hookFlags: number): TransactionInstruction {
    return ix(a.TOKEN_PROGRAM, 'token', 'setHook', { hookProgram, hookFlags }, withEvents(a.TOKEN_PROGRAM, [ro(authority, true), rw(mint)]));
  },
  updateMetadata(authority: PublicKey, mint: PublicKey, name: string | null, symbol: string | null, uri: string | null): TransactionInstruction {
    return ix(a.TOKEN_PROGRAM, 'token', 'updateMetadata', { name, symbol, uri }, withEvents(a.TOKEN_PROGRAM, [ro(authority, true), rw(mint)]));
  },
};

// ---- DEX -------------------------------------------------------------------------------------------

export interface SwapArgs {
  /** 1 buys base with quote, 0 sells base for quote. */
  direction: 0 | 1;
  amountIn: bigint;
  /** Checked against what the recipient's holding gained. */
  minAmountOut: bigint;
  /** Length of the input mint's token-hook slice at the start of the remaining accounts. */
  inHookAccounts: number;
  /** Length of the output mint's slice, after the input's. */
  outHookAccounts: number;
  hookData: Uint8Array;
}

export interface SwapKeys {
  trader: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  /** The trader's base holding, or on a buy any holding of the base mint to deliver to (its owner is the recipient). */
  traderBase: PublicKey;
  /** The trader's quote holding, or on a sell any holding of the quote mint to deliver to. */
  traderQuote: PublicKey;
  /** The pool's hook program; its signer is the DEX's for it. */
  hookProgram: PublicKey | null;
  /** Pass the base mint writable: only when the pool's hook may burn base (a launch with a burn rate); a burn without it is `MintNotWritable`. */
  baseMintWritable?: boolean;
  /** Pass the quote mint writable: only when the pool's hook may burn quote (never bridged SOL). */
  quoteMintWritable?: boolean;
}

export interface LiquidityKeys {
  provider: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  hookProgram: PublicKey | null;
}

export interface CreatePoolArgs {
  lpFeeBps: number;
  hookProgram: PublicKey | null;
  hookFlags: number;
  virtualBase: bigint;
  virtualQuote: bigint;
  baseAmount: bigint;
  quoteAmount: bigint;
  baseHookAccounts: number;
  quoteHookAccounts: number;
  hookData: Uint8Array;
}

export interface SwapConfigArgs {
  admin: PublicKey;
  /** Protocol fee of ordinary pools created from now on (anyone's pool). */
  protocolFeeBps: number;
  feeCollector: PublicKey;
  treasury: PublicKey;
  poolCreationFeeLamports: bigint;
  paused: boolean;
  /** Bordrless's share of what the hooks cut on launch pools created from now on (a curve a hook program creates; kept after graduation), in basis points: 2,500 is a quarter (§3.1). */
  launchProtocolShareBps: number;
}

/** The pool hook's `hook_signer?` slot: the DEX's signer for the pool's hook, or the DEX id without one. */
const poolHookSigner = (hookProgram: PublicKey | null): AccountMeta => opt(a.SWAP_PROGRAM, hookProgram ? a.dexHookSigner(hookProgram) : null);
const mintMeta = (mint: PublicKey, writable: boolean | undefined): AccountMeta => (writable ? rw(mint) : ro(mint));

export const swap = {
  initConfig(authority: PublicKey, args: SwapConfigArgs): TransactionInstruction {
    return ix(a.SWAP_PROGRAM, 'swap', 'initConfig', { args: { ...args, poolCreationFeeLamports: bn(args.poolCreationFeeLamports) } }, withEvents(a.SWAP_PROGRAM, [rw(authority, true), rw(a.SWAP_CONFIG), ro(a.programDataAddress(a.SWAP_PROGRAM)), ro(a.SYSTEM_PROGRAM)]));
  },
  setConfig(admin: PublicKey, args: SwapConfigArgs): TransactionInstruction {
    return ix(a.SWAP_PROGRAM, 'swap', 'setConfig', { args: { ...args, poolCreationFeeLamports: bn(args.poolCreationFeeLamports) } }, withEvents(a.SWAP_PROGRAM, [ro(admin, true), rw(a.SWAP_CONFIG)]));
  },
  /**
   * `create_pool`: 21 accounts, then the base mint's slice, the quote mint's slice and the pool
   * hook's extras (`args` gives the two slice lengths). `hookCaller` is the hook program's own
   * `["hook-authority"]` when the hook creates the pool (a curve), signing; absent, the DEX id.
   */
  createPool(payer: PublicKey, authority: PublicKey, treasury: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, args: CreatePoolArgs, extras: AccountMeta[] = [], hookCaller: PublicKey | null = null): TransactionInstruction {
    const pool = a.poolAddress(baseMint, quoteMint, args.lpFeeBps, args.hookProgram);
    const lpMint = a.lpMintAddress(pool);
    const keys = [
      rw(payer, true),
      ro(authority, true),
      rw(a.SWAP_CONFIG),
      rw(treasury),
      ro(baseMint),
      ro(quoteMint),
      rw(pool),
      rw(lpMint),
      rw(a.vaultAddress(pool, baseMint)),
      rw(a.vaultAddress(pool, quoteMint)),
      rw(a.holdingAddress(baseMint, authority)),
      rw(a.holdingAddress(quoteMint, authority)),
      rw(a.holdingAddress(lpMint, authority)),
      opt(a.SWAP_PROGRAM, args.hookProgram),
      hookCaller ? ro(hookCaller, true) : ro(a.SWAP_PROGRAM),
      poolHookSigner(args.hookProgram),
      ...tokenFixed(),
      ro(a.SYSTEM_PROGRAM),
    ];
    const data = { args: { ...args, hookProgram: args.hookProgram ?? PublicKey.default, virtualBase: bn(args.virtualBase), virtualQuote: bn(args.virtualQuote), baseAmount: bn(args.baseAmount), quoteAmount: bn(args.quoteAmount), hookData: Buffer.from(args.hookData) } };
    return ix(a.SWAP_PROGRAM, 'swap', 'createPool', data, [...withEvents(a.SWAP_PROGRAM, keys), ...extras]);
  },
  /**
   * `swap`, as `bordrless_swap::client::swap` builds it: 15 accounts, then `extras`: the input
   * mint's token-hook slice (`args.inHookAccounts` long), the output mint's
   * (`args.outHookAccounts`), then the pool hook's extras. A mint is passed writable only when asked.
   */
  swap(keys: SwapKeys, args: SwapArgs, extras: AccountMeta[] = []): TransactionInstruction {
    const metas = [
      ro(keys.trader, true),
      ro(a.SWAP_CONFIG),
      rw(keys.pool),
      mintMeta(keys.baseMint, keys.baseMintWritable),
      mintMeta(keys.quoteMint, keys.quoteMintWritable),
      rw(a.vaultAddress(keys.pool, keys.baseMint)),
      rw(a.vaultAddress(keys.pool, keys.quoteMint)),
      rw(keys.traderBase),
      rw(keys.traderQuote),
      opt(a.SWAP_PROGRAM, keys.hookProgram),
      poolHookSigner(keys.hookProgram),
      ...tokenFixed(),
    ];
    const data = { args: { ...args, amountIn: bn(args.amountIn), minAmountOut: bn(args.minAmountOut), hookData: Buffer.from(args.hookData) } };
    return ix(a.SWAP_PROGRAM, 'swap', 'swap', data, [...withEvents(a.SWAP_PROGRAM, metas), ...extras]);
  },
  /** `swap` with the slices given whole: each side's token hook (null without one) and the pool hook's extras; the counts follow. */
  swapWithHooks(keys: SwapKeys, args: { direction: 0 | 1; amountIn: bigint; minAmountOut: bigint; hookData?: Uint8Array }, hooks: { inHook?: TokenHook | null; outHook?: TokenHook | null; poolExtras?: AccountMeta[] } = {}): TransactionInstruction {
    const inSlice = tokenHookSlice(hooks.inHook ?? null);
    const outSlice = tokenHookSlice(hooks.outHook ?? null);
    return swap.swap(keys, { direction: args.direction, amountIn: args.amountIn, minAmountOut: args.minAmountOut, inHookAccounts: inSlice.length, outHookAccounts: outSlice.length, hookData: args.hookData ?? new Uint8Array() }, [...inSlice, ...outSlice, ...(hooks.poolExtras ?? [])]);
  },
  /** The 17 accounts of `add_liquidity` and `remove_liquidity`. */
  liquidityKeys(keys: LiquidityKeys): AccountMeta[] {
    const lpMint = a.lpMintAddress(keys.pool);
    return withEvents(a.SWAP_PROGRAM, [
      ro(keys.provider, true),
      ro(a.SWAP_CONFIG),
      rw(keys.pool),
      ro(keys.baseMint),
      ro(keys.quoteMint),
      rw(lpMint),
      rw(a.vaultAddress(keys.pool, keys.baseMint)),
      rw(a.vaultAddress(keys.pool, keys.quoteMint)),
      rw(a.holdingAddress(keys.baseMint, keys.provider)),
      rw(a.holdingAddress(keys.quoteMint, keys.provider)),
      rw(a.holdingAddress(lpMint, keys.provider)),
      opt(a.SWAP_PROGRAM, keys.hookProgram),
      poolHookSigner(keys.hookProgram),
      ...tokenFixed(),
    ]);
  },
  /** `add_liquidity`; `extras` are the base slice, the quote slice (lengths in `args`), then the pool hook's extras. */
  addLiquidity(keys: LiquidityKeys, args: { baseDesired: bigint; quoteDesired: bigint; minLp: bigint; baseHookAccounts: number; quoteHookAccounts: number; hookData: Uint8Array }, extras: AccountMeta[] = []): TransactionInstruction {
    const data = { args: { ...args, baseDesired: bn(args.baseDesired), quoteDesired: bn(args.quoteDesired), minLp: bn(args.minLp), hookData: Buffer.from(args.hookData) } };
    return ix(a.SWAP_PROGRAM, 'swap', 'addLiquidity', data, [...swap.liquidityKeys(keys), ...extras]);
  },
  /** `remove_liquidity`; `extras` as for `addLiquidity`. */
  removeLiquidity(keys: LiquidityKeys, args: { lpAmount: bigint; minBase: bigint; minQuote: bigint; baseHookAccounts: number; quoteHookAccounts: number; hookData: Uint8Array }, extras: AccountMeta[] = []): TransactionInstruction {
    const data = { args: { ...args, lpAmount: bn(args.lpAmount), minBase: bn(args.minBase), minQuote: bn(args.minQuote), hookData: Buffer.from(args.hookData) } };
    return ix(a.SWAP_PROGRAM, 'swap', 'removeLiquidity', data, [...swap.liquidityKeys(keys), ...extras]);
  },
  /** Liquidity with the slices given whole: each mint's token hook and the pool hook's extras; the counts follow. */
  liquiditySlices(hooks: { baseHook?: TokenHook | null; quoteHook?: TokenHook | null; poolExtras?: AccountMeta[] }): { baseHookAccounts: number; quoteHookAccounts: number; extras: AccountMeta[] } {
    const base = tokenHookSlice(hooks.baseHook ?? null);
    const quote = tokenHookSlice(hooks.quoteHook ?? null);
    return { baseHookAccounts: base.length, quoteHookAccounts: quote.length, extras: [...base, ...quote, ...(hooks.poolExtras ?? [])] };
  },
  /**
   * `collect_protocol_fees(quote_hook_accounts)`: the admin moves the pool's protocol fees (always in
   * its quote token) to the fee collector's holding of the quote. The remaining accounts are exactly
   * the quote mint's slice (empty for bridged SOL), else `AccountCounts`.
   */
  collectProtocolFees(admin: PublicKey, pool: PublicKey, quoteMint: PublicKey, feeCollector: PublicKey, quoteHook: TokenHook | null = null): TransactionInstruction {
    const slice = tokenHookSlice(quoteHook);
    const keys = [ro(admin, true), ro(a.SWAP_CONFIG), rw(pool), ro(quoteMint), rw(a.vaultAddress(pool, quoteMint)), rw(a.holdingAddress(quoteMint, feeCollector)), ...tokenFixed()];
    return ix(a.SWAP_PROGRAM, 'swap', 'collectProtocolFees', { quoteHookAccounts: slice.length }, [...withEvents(a.SWAP_PROGRAM, keys), ...slice]);
  },
  /** `finalize_curve`: only a pool's hook calls it (by CPI, its `["hook-authority"]` signing). */
  finalizeCurve(hookCaller: PublicKey, hookCallerBump: number, pool: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, lpRecipient: PublicKey): TransactionInstruction {
    const keys = [ro(hookCaller, true), rw(pool), ro(a.vaultAddress(pool, baseMint)), ro(a.vaultAddress(pool, quoteMint)), rw(a.lpMintAddress(pool)), rw(lpRecipient), ...tokenFixed()];
    return ix(a.SWAP_PROGRAM, 'swap', 'finalizeCurve', { hookCallerBump }, withEvents(a.SWAP_PROGRAM, keys));
  },
};

// ---- bridge ----------------------------------------------------------------------------------------

export const bridge = {
  initConfig(authority: PublicKey, admin: PublicKey, paused: boolean): TransactionInstruction {
    return ix(a.BRIDGE_PROGRAM, 'bridge', 'initConfig', { args: { admin, paused } }, withEvents(a.BRIDGE_PROGRAM, [rw(authority, true), rw(a.BRIDGE_CONFIG), ro(a.programDataAddress(a.BRIDGE_PROGRAM)), ro(a.SYSTEM_PROGRAM)]));
  },
  setConfig(admin: PublicKey, newAdmin: PublicKey, paused: boolean): TransactionInstruction {
    return ix(a.BRIDGE_PROGRAM, 'bridge', 'setConfig', { args: { admin: newAdmin, paused } }, withEvents(a.BRIDGE_PROGRAM, [ro(admin, true), rw(a.BRIDGE_CONFIG)]));
  },
  register(payer: PublicKey, underlying: PublicKey, underlyingProgram: PublicKey, args: { name: string; symbol: string; uri: string }): TransactionInstruction {
    const keys = [
      rw(payer, true),
      rw(a.BRIDGE_CONFIG),
      ro(underlying),
      rw(a.wrapperAddress(underlying)),
      rw(a.wrappedMintAddress(underlying)),
      rw(a.bridgeVaultAddress(underlying, underlyingProgram)),
      ro(underlyingProgram),
      ro(a.ATA_PROGRAM),
      ...tokenFixed(),
      ro(a.SYSTEM_PROGRAM),
    ];
    return ix(a.BRIDGE_PROGRAM, 'bridge', 'register', { args }, withEvents(a.BRIDGE_PROGRAM, keys));
  },
  registerSol(payer: PublicKey): TransactionInstruction {
    const keys = [rw(payer, true), rw(a.BRIDGE_CONFIG), rw(a.SOL_WRAPPER), rw(a.BRIDGED_SOL_MINT), rw(a.SOL_VAULT), ...tokenFixed(), ro(a.SYSTEM_PROGRAM)];
    return ix(a.BRIDGE_PROGRAM, 'bridge', 'registerSol', {}, withEvents(a.BRIDGE_PROGRAM, keys));
  },
  /** The 13 accounts of `wrap` and `unwrap` (v2: no token hook signer; a wrapped mint has no hook). */
  wrapKeys(user: PublicKey, underlying: PublicKey, underlyingProgram: PublicKey, userUnderlying: PublicKey): AccountMeta[] {
    const wrapped = a.wrappedMintAddress(underlying);
    return withEvents(a.BRIDGE_PROGRAM, [
      ro(user, true),
      ro(a.BRIDGE_CONFIG),
      rw(a.wrapperAddress(underlying)),
      ro(underlying),
      rw(userUnderlying),
      rw(a.bridgeVaultAddress(underlying, underlyingProgram)),
      rw(wrapped),
      rw(a.holdingAddress(wrapped, user)),
      ro(underlyingProgram),
      ...tokenFixed(),
    ]);
  },
  wrap(user: PublicKey, underlying: PublicKey, underlyingProgram: PublicKey, userUnderlying: PublicKey, amount: bigint): TransactionInstruction {
    return ix(a.BRIDGE_PROGRAM, 'bridge', 'wrap', { amount: bn(amount) }, bridge.wrapKeys(user, underlying, underlyingProgram, userUnderlying));
  },
  unwrap(user: PublicKey, underlying: PublicKey, underlyingProgram: PublicKey, userUnderlying: PublicKey, amount: bigint): TransactionInstruction {
    return ix(a.BRIDGE_PROGRAM, 'bridge', 'unwrap', { amount: bn(amount) }, bridge.wrapKeys(user, underlying, underlyingProgram, userUnderlying));
  },
  /** The 11 accounts of `wrap_sol`, `unwrap_sol` and `unwrap_sol_above` (v2: no token hook signer). */
  wrapSolKeys(user: PublicKey): AccountMeta[] {
    return withEvents(a.BRIDGE_PROGRAM, [rw(user, true), ro(a.BRIDGE_CONFIG), rw(a.SOL_WRAPPER), rw(a.SOL_VAULT), rw(a.BRIDGED_SOL_MINT), rw(a.holdingAddress(a.BRIDGED_SOL_MINT, user)), ...tokenFixed(), ro(a.SYSTEM_PROGRAM)]);
  },
  wrapSol(user: PublicKey, lamports: bigint): TransactionInstruction {
    return ix(a.BRIDGE_PROGRAM, 'bridge', 'wrapSol', { lamports: bn(lamports) }, bridge.wrapSolKeys(user));
  },
  /** `amount` of 2^64 - 1 unwraps the whole holding. */
  unwrapSol(user: PublicKey, amount: bigint): TransactionInstruction {
    return ix(a.BRIDGE_PROGRAM, 'bridge', 'unwrapSol', { amount: bn(amount) }, bridge.wrapSolKeys(user));
  },
  /** Unwraps everything above `keep`: what a trade or a claim just delivered, leaving what was held before. */
  unwrapSolAbove(user: PublicKey, keep: bigint): TransactionInstruction {
    return ix(a.BRIDGE_PROGRAM, 'bridge', 'unwrapSolAbove', { keep: bn(keep) }, bridge.wrapSolKeys(user));
  },
};

export const UNWRAP_ALL = (1n << 64n) - 1n;

// ---- launchpad -------------------------------------------------------------------------------------

export interface LaunchConfigArgs {
  admin: PublicKey;
  treasury: PublicKey;
  quoteMint: PublicKey;
  launchFeeLamports: bigint;
  lpFeeBps: number;
  maxCreatorFeeBps: number;
  sniperWindowSecs: number;
  sniperStartBps: number;
  curveBps: number;
  supply: bigint;
  decimals: number;
  minVirtualQuote: bigint;
  maxVirtualQuote: bigint;
  paused: boolean;
  /** v2: the bounds `create_launch` holds token rules to (§5.2); the policy's are `RULE_BOUNDS`. Each within the hard ceilings, else `InvalidConfig`. */
  ruleBounds: RuleBounds;
}

function launchConfigData(args: LaunchConfigArgs): Record<string, unknown> {
  return { args: { ...args, launchFeeLamports: bn(args.launchFeeLamports), sniperWindowSecs: bn(args.sniperWindowSecs), supply: bn(args.supply), minVirtualQuote: bn(args.minVirtualQuote), maxVirtualQuote: bn(args.maxVirtualQuote), ruleBounds: { ...args.ruleBounds } } };
}

export interface CreateLaunchArgs {
  name: string;
  symbol: string;
  uri: string;
  creatorFeeBps: number;
  virtualQuote: bigint;
  /** v2: the token rules (`launchRulesFromInput` turns a request's into these); `NO_LAUNCH_RULES` for none. */
  rules: LaunchRulesData;
}

/** `create_config`'s arguments (§5.7): the rules and creator fee a launch made from the config gets, the creator's own hook (§5.8) with its flags, and a label of at most 32 bytes. */
export interface CreateConfigArgs {
  rules: LaunchRulesData;
  creatorFeeBps: number;
  /** The creator's own token hook program; then no kit rule may be on (burn and the creator fee may). */
  customHook: PublicKey | null;
  /** Its token flags (`TOKEN_HOOK_FLAGS`): at least one callback, no unknown bit; 0 without a hook. */
  customHookFlags: number;
  label: string;
}

/** What `create_launch` may take beyond its inline arguments: the `LaunchConfig` to launch from (§5.7) and, for a config naming a hook, the hook's accounts resolved for the mint (§5.8). */
export interface CreateLaunchOptions {
  /** The `LaunchConfig` key; `args.rules` and `args.creatorFeeBps` must equal the config's (`ConfigMismatch`). */
  launchConfig?: PublicKey | null;
  /** The custom hook's accounts (`fetchCustomHookAccounts`), exactly when the config names one. */
  customHook?: CustomHookAccounts | null;
}

/** What a client needs of a launch to build its swaps and its graduation (`bordrless_launch::client::LaunchKeys`). */
export interface LaunchKeys {
  mint: PublicKey;
  quoteMint: PublicKey;
  /** The pool's LP fee (part of its address). */
  lpFeeBps: number;
  /** The kit modules (`Launch.modules`): 0 means no kit and no token hook. */
  modules: number;
  /** The pool hook burns on either side: the base mint is then passed writable. */
  burns: boolean;
  /** The creator's own token hook with its extras (§5.8), the base side's slice on every swap and the graduation; null for the kit or no hook. */
  customHook?: CustomHookAccounts | null;
}

/** The keys of a launch of `mint` with `rules`. */
export const launchKeys = (mint: PublicKey, quoteMint: PublicKey, lpFeeBps: number, rules: LaunchRulesData, customHook: CustomHookAccounts | null = null): LaunchKeys => ({ mint, quoteMint, lpFeeBps, modules: kitModulesOf(rules), burns: rulesBurn(rules), customHook });
/**
 * The keys of a decoded `Launch`. A launch with a custom hook needs the hook's accounts
 * (`fetchCustomHookAccounts(connection, launch.customHook, launch.mint)`): without them the swap
 * would be built without the token's hook and refused on chain, so this throws.
 */
export function launchKeysOf(l: Pick<Launch, 'mint' | 'quoteMint' | 'lpFeeBps' | 'rules' | 'customHook'>, customHook: CustomHookAccounts | null = null): LaunchKeys {
  if (l.customHook && !customHook) throw new Error(`the launch's token runs the hook ${l.customHook.toBase58()}: resolve its accounts for the mint first`);
  if (l.customHook && customHook && !customHook.program.equals(l.customHook)) throw new Error('the hook accounts given are another program’s');
  return launchKeys(l.mint, l.quoteMint, l.lpFeeBps, l.rules, l.customHook ? customHook : null);
}

const HOLDER_REWARDS = 1;

/** The kit's reward vault of a launch, or null without holder rewards. */
const rewardVaultOf = (mint: PublicKey, quoteMint: PublicKey, modules: number): PublicKey | null => ((modules & HOLDER_REWARDS) !== 0 ? a.holderVaultAddress(mint, quoteMint) : null);

export const launch = {
  initConfig(authority: PublicKey, args: LaunchConfigArgs): TransactionInstruction {
    return ix(a.LAUNCH_PROGRAM, 'launch', 'initConfig', launchConfigData(args), withEvents(a.LAUNCH_PROGRAM, [rw(authority, true), rw(a.LAUNCH_CONFIG), ro(a.programDataAddress(a.LAUNCH_PROGRAM)), ro(a.SYSTEM_PROGRAM)]));
  },
  setConfig(admin: PublicKey, args: LaunchConfigArgs): TransactionInstruction {
    return ix(a.LAUNCH_PROGRAM, 'launch', 'setConfig', launchConfigData(args), withEvents(a.LAUNCH_PROGRAM, [ro(admin, true), rw(a.LAUNCH_CONFIG)]));
  },
  /**
   * The six kit accounts of `create_launch` (indices 23 to 28): the kit, its config (w), its
   * registry (w), the reward vault (w, holder rewards only), the kit-caller PDA and the kit's event
   * authority; each absent (the launch id) without kit modules.
   */
  createLaunchKitAccounts(mint: PublicKey, quoteMint: PublicKey, modules: number): AccountMeta[] {
    if (modules === 0) return Array.from({ length: 6 }, () => ro(a.LAUNCH_PROGRAM));
    const vault = rewardVaultOf(mint, quoteMint, modules);
    return [ro(a.KIT_PROGRAM), rw(a.kitConfigAddress(mint)), rw(a.kitRegistryAddress(mint)), vault ? rw(vault) : ro(a.LAUNCH_PROGRAM), ro(a.kitCallerAddress(mint)), ro(a.KIT_EVENT_AUTHORITY)];
  },
  /**
   * `create_config` (§5.7): 7 accounts. `launchConfig` is a fresh keypair that signs once, here; its
   * public key is what a creator shares and pastes into the launch form (`buildCreateConfig` makes
   * the keypair). The hook program is passed exactly when `args.customHook` names one (the program
   * checks it is executable and none of the protocol's).
   */
  createConfig(creator: PublicKey, launchConfig: PublicKey, args: CreateConfigArgs): TransactionInstruction {
    const keys = [rw(creator, true), ro(a.LAUNCH_CONFIG), rw(launchConfig, true), opt(a.LAUNCH_PROGRAM, args.customHook), ro(a.SYSTEM_PROGRAM)];
    return ix(a.LAUNCH_PROGRAM, 'launch', 'createConfig', { args: { ...args, rules: { ...args.rules } } }, withEvents(a.LAUNCH_PROGRAM, keys));
  },
  /**
   * `create_launch`: 32 accounts, then, with a custom hook, its accounts as remaining accounts
   * (`customHookLaunchAccounts`). The mint is a fresh keypair that signs (make one per attempt and
   * never re-sign a broadcast one). `treasury`, `quoteMint` and `lpFeeBps` are the config's. With
   * kit rules or a custom hook the transaction needs the protocol lookup table to fit. Launching from
   * a `LaunchConfig` (§5.7) passes its key in the optional slot after the kit accounts, with
   * `args.rules` and `args.creatorFeeBps` copied from it (the program refuses a mismatch); a config
   * naming a hook needs the hook's accounts, resolved for this mint (§5.8), and no kit accounts.
   */
  createLaunch(creator: PublicKey, mint: PublicKey, treasury: PublicKey, quoteMint: PublicKey, lpFeeBps: number, args: CreateLaunchArgs, options: CreateLaunchOptions = {}): TransactionInstruction {
    const hook = options.customHook ?? null;
    if (hook && kitModulesOf(args.rules) !== 0) throw new Error('a custom hook and kit rules cannot share a mint: one token hook per mint');
    const launchKey = a.launchAddress(mint);
    const pool = a.launchPoolAddress(mint, quoteMint, lpFeeBps);
    const lpMint = a.lpMintAddress(pool);
    const keys = [
      rw(creator, true),
      rw(a.LAUNCH_CONFIG),
      rw(treasury),
      rw(mint, true),
      rw(launchKey),
      rw(a.holdingAddress(mint, launchKey)),
      rw(a.holdingAddress(quoteMint, launchKey)),
      ro(quoteMint),
      rw(a.launchRegistryAddress(pool)),
      rw(a.SWAP_CONFIG),
      rw(pool),
      rw(lpMint),
      rw(a.vaultAddress(pool, mint)),
      rw(a.vaultAddress(pool, quoteMint)),
      rw(a.holdingAddress(lpMint, launchKey)),
      ro(a.LAUNCH_HOOK_AUTHORITY),
      ro(a.DEX_HOOK_SIGNER_LAUNCH),
      ro(a.SWAP_EVENT_AUTHORITY),
      ro(a.SWAP_PROGRAM),
      ro(a.TOKEN_PROGRAM),
      ro(a.TOKEN_HOOK_SIGNER_KIT),
      ro(a.TOKEN_EVENT_AUTHORITY),
      ro(a.SYSTEM_PROGRAM),
      ...launch.createLaunchKitAccounts(mint, quoteMint, kitModulesOf(args.rules)),
      opt(a.LAUNCH_PROGRAM, options.launchConfig ?? null),
    ];
    const remaining = hook ? customHookLaunchAccounts(hook, mint) : [];
    return ix(a.LAUNCH_PROGRAM, 'launch', 'createLaunch', { args: { ...args, virtualQuote: bn(args.virtualQuote), rules: { ...args.rules } } }, [...withEvents(a.LAUNCH_PROGRAM, keys), ...remaining]);
  },
  /**
   * The five kit accounts of `graduate` (indices 16 to 20), required exactly for a launch with kit
   * modules: the kit, its config (w), the holder vault with holder rewards or the kit's id without,
   * the kit-caller PDA, the kit's event authority; each the launch id without a kit.
   */
  graduateKitAccounts(mint: PublicKey, quoteMint: PublicKey, modules: number): AccountMeta[] {
    if (modules === 0) return Array.from({ length: 5 }, () => ro(a.LAUNCH_PROGRAM));
    const vault = rewardVaultOf(mint, quoteMint, modules);
    return [ro(a.KIT_PROGRAM), rw(a.kitConfigAddress(mint)), ro(vault ?? a.KIT_PROGRAM), ro(a.kitCallerAddress(mint)), ro(a.KIT_EVENT_AUTHORITY)];
  },
  /**
   * `graduate` (permissionless): 23 accounts; `modules` is the launch's (`Launch.modules`). The
   * launch calls the kit's `graduate`, which lifts max wallet. For a launch with a custom hook (§5.8)
   * the hook's slice `[program, signer, ...extras]` follows as remaining accounts, for the reserve's
   * top-up and burn.
   */
  graduate(cranker: PublicKey, mint: PublicKey, quoteMint: PublicKey, lpFeeBps: number, modules: number, customHook: CustomHookAccounts | null = null): TransactionInstruction {
    const launchKey = a.launchAddress(mint);
    const pool = a.launchPoolAddress(mint, quoteMint, lpFeeBps);
    const lpMint = a.lpMintAddress(pool);
    const keys = [
      ro(cranker, true),
      rw(launchKey),
      rw(mint),
      ro(quoteMint),
      rw(pool),
      rw(a.holdingAddress(mint, launchKey)),
      rw(a.vaultAddress(pool, mint)),
      ro(a.vaultAddress(pool, quoteMint)),
      rw(lpMint),
      rw(a.holdingAddress(lpMint, launchKey)),
      ro(a.LAUNCH_HOOK_AUTHORITY),
      ro(a.SWAP_PROGRAM),
      ro(a.SWAP_EVENT_AUTHORITY),
      ro(a.TOKEN_PROGRAM),
      ro(a.TOKEN_HOOK_SIGNER_KIT),
      ro(a.TOKEN_EVENT_AUTHORITY),
      ...launch.graduateKitAccounts(mint, quoteMint, modules),
    ];
    return ix(a.LAUNCH_PROGRAM, 'launch', 'graduate', {}, [...withEvents(a.LAUNCH_PROGRAM, keys), ...(customHook ? customHookSlice(customHook) : [])]);
  },
  /** `claim_creator_fees`: 9 accounts (v2: no token hook signer; bridged SOL has no hook). The creator's quote holding must exist. */
  claimCreatorFees(creator: PublicKey, mint: PublicKey, quoteMint: PublicKey): TransactionInstruction {
    const launchKey = a.launchAddress(mint);
    const keys = [ro(creator, true), rw(launchKey), ro(quoteMint), rw(a.holdingAddress(quoteMint, launchKey)), rw(a.holdingAddress(quoteMint, creator)), ...tokenFixed()];
    return ix(a.LAUNCH_PROGRAM, 'launch', 'claimCreatorFees', {}, withEvents(a.LAUNCH_PROGRAM, keys));
  },
  /** The base mint's token-hook slice of a launch for a DEX instruction: the kit's 4 accounts, or none without kit modules. */
  baseHookSlice(mint: PublicKey, quoteMint: PublicKey, modules: number): AccountMeta[] {
    return modules === 0 ? [] : kitHookSlice(mint, rewardVaultOf(mint, quoteMint, modules));
  },
  /** The base mint's slice of a launch, whichever hook its token runs: the creator's own (`custom_hook_slice`), the kit's, or none. */
  baseHookSliceOf(keys: LaunchKeys): AccountMeta[] {
    return keys.customHook ? customHookSlice(keys.customHook) : launch.baseHookSlice(keys.mint, keys.quoteMint, keys.modules);
  },
  /**
   * A swap on a launch pool (programs-summary §2.6, `bordrless_launch::client::swap` and
   * `swap_with_base_slice`) by `trader`, delivered to `recipient`'s holding: direction 1 buys the
   * token with the quote, 0 sells it. The base mint is writable exactly when the launch burns (never
   * the quote); the token's hook slice (the kit's, or a custom hook's) goes on the base side (a
   * buy's output, a sell's input); the pool hook gets its four extras whatever the rules.
   * `minAmountOut` is checked against what the recipient's holding gains.
   */
  swap(keys: LaunchKeys, trader: PublicKey, recipient: PublicKey, direction: 0 | 1, amountIn: bigint, minAmountOut: bigint): TransactionInstruction {
    const buy = direction === 1;
    const traderBase = a.holdingAddress(keys.mint, buy ? recipient : trader);
    const traderQuote = a.holdingAddress(keys.quoteMint, buy ? trader : recipient);
    const slice = launch.baseHookSliceOf(keys);
    return swap.swap(
      { trader, pool: a.launchPoolAddress(keys.mint, keys.quoteMint, keys.lpFeeBps), baseMint: keys.mint, quoteMint: keys.quoteMint, traderBase, traderQuote, hookProgram: a.LAUNCH_PROGRAM, baseMintWritable: keys.burns, quoteMintWritable: false },
      { direction, amountIn, minAmountOut, inHookAccounts: buy ? 0 : slice.length, outHookAccounts: buy ? slice.length : 0, hookData: new Uint8Array() },
      [...slice, ...a.launchHookExtras(keys.mint, keys.quoteMint)],
    );
  },
};

// ---- the kit ---------------------------------------------------------------------------------------

/** `init`'s arguments (`KitInitArgs`); the launch passes them inside `create_launch`. Times are unix seconds, 0 when the module is off. */
export interface KitInitArgs {
  launch: PublicKey;
  pool: PublicKey;
  creator: PublicKey;
  rewardMint: PublicKey;
  modules: number;
  maxWalletBps: number;
  creatorUnlockAt: number;
  earlyWindowEnd: number;
  earlyUnlockAt: number;
  kitCallerBump: number;
}

export const kit = {
  /**
   * `init`: 13 accounts. Only the launch's kit-caller PDA can sign it, so only `create_launch` sends
   * it (by CPI); built here for completeness and the tests. The reward vault is passed (and created)
   * with holder rewards, else the kit's id.
   */
  init(kitCaller: PublicKey, payer: PublicKey, mint: PublicKey, args: KitInitArgs): TransactionInstruction {
    const vault = (args.modules & HOLDER_REWARDS) !== 0 ? rw(a.rewardVaultAddress(mint, args.rewardMint)) : ro(a.KIT_PROGRAM);
    const keys = [ro(kitCaller, true), rw(payer, true), ro(mint), ro(a.holdingAddress(mint, args.launch)), rw(a.kitConfigAddress(mint)), rw(a.kitRegistryAddress(mint)), ro(args.rewardMint), vault, ...tokenFixed(), ro(a.SYSTEM_PROGRAM)];
    const data = { args: { ...args, creatorUnlockAt: bn(args.creatorUnlockAt), earlyWindowEnd: bn(args.earlyWindowEnd), earlyUnlockAt: bn(args.earlyUnlockAt) } };
    return ix(a.KIT_PROGRAM, 'kit', 'init', data, withEvents(a.KIT_PROGRAM, keys));
  },
  /** `graduate`: the launch's kit-caller PDA signs it inside the launch's `graduate`. */
  graduate(kitCaller: PublicKey, mint: PublicKey): TransactionInstruction {
    return ix(a.KIT_PROGRAM, 'kit', 'graduate', {}, withEvents(a.KIT_PROGRAM, [ro(kitCaller, true), rw(a.kitConfigAddress(mint))]));
  },
  /**
   * `claim`: 12 accounts. `owner` (neither the pool nor the launch) claims its holder rewards on
   * `mint`, paid in `rewardMint` (bridged SOL) into its own holding of it, which must exist (create
   * it first, idempotently). A claim of nothing reverts (`NothingToClaim`): check the mirror first.
   */
  claim(owner: PublicKey, mint: PublicKey, rewardMint: PublicKey): TransactionInstruction {
    const keys = [
      ro(owner, true),
      rw(a.kitConfigAddress(mint)),
      ro(mint),
      rw(a.holdingAddress(mint, owner)),
      ro(rewardMint),
      rw(a.rewardVaultAddress(mint, rewardMint)),
      rw(a.holdingAddress(rewardMint, owner)),
      ro(a.KIT_HOOK_AUTHORITY),
      ...tokenFixed(),
    ];
    return ix(a.KIT_PROGRAM, 'kit', 'claim', {}, withEvents(a.KIT_PROGRAM, keys));
  },
  /**
   * `share(amount)`: 9 accounts. `sharer` sends `amount` of `rewardMint` from `source` (a holding it
   * may spend) to the holders of `mint`, released over one hour (or the hour after a share still
   * streaming). At least 0.001 SOL, and only while someone is eligible.
   */
  share(sharer: PublicKey, mint: PublicKey, source: PublicKey, rewardMint: PublicKey, amount: bigint): TransactionInstruction {
    const keys = [ro(sharer, true), rw(a.kitConfigAddress(mint)), rw(source), ro(rewardMint), rw(a.rewardVaultAddress(mint, rewardMint)), ...tokenFixed()];
    return ix(a.KIT_PROGRAM, 'kit', 'share', { amount: bn(amount) }, withEvents(a.KIT_PROGRAM, keys));
  },
};

// ---- the example hook (`programs/tax_hook`) ---------------------------------------------------------

/** `tax_hook`'s token flags: it runs before transfers and takes a cut of them (`tax_hook::FLAGS`). */
export const TAX_HOOK_FLAGS = 1 | (1 << 6);

/** The tax hook has no event CPI: its instructions end at the programs. */
export const taxHook = {
  /**
   * `prepare(fee_bps, max_wallet_bps)`: the worked example of preparing a hook for a mint that does
   * not exist yet (§5.8), so a launch can create the mint with the hook. Writes the hook's config at
   * `["tax", mint]` and its registry at `["bordrless-hook-accounts", mint]`, listing the tax config
   * (w) and the collector's holding of the mint (w). The fee is 0 until that holding exists, so the
   * launch's own deposit is free. `collector` is the wallet that receives the cut.
   */
  prepare(authority: PublicKey, mint: PublicKey, collector: PublicKey, feeBps: number, maxWalletBps: number): TransactionInstruction {
    const keys = [rw(authority, true), ro(mint), ro(collector), rw(a.taxConfigAddress(mint)), rw(a.registryAddress(a.TAX_HOOK_PROGRAM, mint)), ro(a.SYSTEM_PROGRAM)];
    return ix(a.TAX_HOOK_PROGRAM, 'taxHook', 'prepare', { feeBps, maxWalletBps }, keys);
  },
  /** `install(fee_bps, max_wallet_bps)` on a mint that exists and whose hook authority signs: the config, the registry and the hook on the mint in one go. */
  install(authority: PublicKey, mint: PublicKey, collectorHolding: PublicKey, feeBps: number, maxWalletBps: number): TransactionInstruction {
    const keys = [rw(authority, true), rw(mint), rw(a.taxConfigAddress(mint)), ro(collectorHolding), rw(a.registryAddress(a.TAX_HOOK_PROGRAM, mint)), ...tokenFixed(), ro(a.SYSTEM_PROGRAM)];
    return ix(a.TAX_HOOK_PROGRAM, 'taxHook', 'install', { feeBps, maxWalletBps }, keys);
  },
  /** The hook's accounts for a prepared mint, without reading the registry: the tax config (w) and the collector's holding (w). */
  accounts(mint: PublicKey, collector: PublicKey): CustomHookAccounts {
    return { program: a.TAX_HOOK_PROGRAM, extras: [rw(a.taxConfigAddress(mint)), rw(a.holdingAddress(mint, collector))] };
  },
};
