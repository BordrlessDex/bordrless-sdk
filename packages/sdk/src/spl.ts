/**
 * SPL Token and Token-2022 helpers (docs/token-quotes.md): a coin may launch against real SPL Token
 * or Token-2022 mints, so the SDK reads those mints and token accounts and builds their transfers
 * itself, without `@solana/spl-token`.
 *
 * - `splProgramOf`: the token program of an account by its owner (SPL Token or Token-2022), null for
 *   any other owner.
 * - `readTokenAccount`: a token account (165 bytes, both programs; a Token-2022 account may carry
 *   extensions past them), null for anything else.
 * - `readSplMintAccount` and `readMintExtensions`: a mint's base layout (82 bytes) and, on
 *   Token-2022, its extensions. A Token-2022 mint with extensions is padded to 165 bytes, its account
 *   type at byte 165 (1 a mint, 2 a token account), then TLV entries from byte 166: the extension's
 *   number (u16 LE), its length (u16 LE), its bytes. A zero number with a zero length is padding:
 *   the list ends there.
 * - `quoteMintPolicy`: the DEX's quote mint policy (docs/token-quotes.md §2.3, mirrored in
 *   `TOKEN_2022_MINT_EXTENSIONS`): why a mint can't be a leg's quote, and the issuer's powers the
 *   site labels it with.
 * - `transferChecked`: the `TransferChecked` instruction of either program.
 */
import { PublicKey, TransactionInstruction, type AccountInfo, type AccountMeta } from '@solana/web3.js';
import { TOKEN_2022_MINT_EXTENSIONS, type QuoteTokenProgram, type QuoteTokenRefusal, type QuoteTokenRisk } from '@bordrless/shared';
import { SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM } from './addresses.ts';

/** A mint's base layout, both programs. */
export const SPL_MINT_LENGTH = 82;
/** A token account's base layout, both programs; also where a Token-2022 mint's padding ends. */
export const SPL_TOKEN_ACCOUNT_LENGTH = 165;
/** Token-2022's account type byte (at 165, after the padding): 1 a mint, 2 a token account. */
export const TOKEN_2022_ACCOUNT_TYPE = { mint: 1, account: 2 } as const;

/** Token-2022 mint extensions this module reads by number (spl-token-2022 `ExtensionType`). */
export const TOKEN_2022_EXTENSION = {
  transferFeeConfig: 1,
  mintCloseAuthority: 3,
  confidentialTransferMint: 4,
  defaultAccountState: 6,
  nonTransferable: 9,
  interestBearingConfig: 10,
  permanentDelegate: 12,
  transferHook: 14,
  confidentialTransferFeeConfig: 16,
  confidentialMintBurn: 24,
  scaledUiAmount: 25,
  pausable: 26,
  /** Not in the DEX's list: refused as unknown (`QuoteMintUnknownExtension`). */
  permissionedBurn: 28,
} as const;

/** Token-2022 token-account extensions the leg trades read (spl-token-2022 `ExtensionType`). */
export const TOKEN_2022_ACCOUNT_EXTENSION = {
  /** `MemoTransfer`: incoming transfers need a memo before them (a sell paid into it by the DEX fails). */
  memoTransfer: 8,
  /** `CpiGuard`: the owner's signature does not carry into a CPI (a buy the DEX pays from it fails). */
  cpiGuard: 11,
} as const;

/** The token program of an account by its owner: SPL Token or Token-2022; null for any other owner. */
export function splProgramOf(owner: PublicKey | string): PublicKey | null {
  const key = typeof owner === 'string' ? owner : owner.toBase58();
  if (key === SPL_TOKEN_PROGRAM.toBase58()) return SPL_TOKEN_PROGRAM;
  if (key === SPL_TOKEN_2022_PROGRAM.toBase58()) return SPL_TOKEN_2022_PROGRAM;
  return null;
}

/** The API's name of a token program ('spl-token' | 'token-2022'); null for any other program. */
export function splProgramName(program: PublicKey | string): QuoteTokenProgram | null {
  const key = typeof program === 'string' ? program : program.toBase58();
  return key === SPL_TOKEN_PROGRAM.toBase58() ? 'spl-token' : key === SPL_TOKEN_2022_PROGRAM.toBase58() ? 'token-2022' : null;
}

/** 32 bytes as a key; null when they are all zero (an `OptionalNonZeroPubkey` that is none). */
function optionalKey(data: Buffer, at: number): PublicKey | null {
  const bytes = data.subarray(at, at + 32);
  if (bytes.length < 32 || bytes.every((b) => b === 0)) return null;
  return new PublicKey(bytes);
}

/** A `COption<Pubkey>` (4-byte tag, then 32 bytes): the key when the tag is 1, null otherwise. */
function coptionKey(data: Buffer, at: number): PublicKey | null {
  return data.readUInt32LE(at) === 1 ? new PublicKey(data.subarray(at + 4, at + 36)) : null;
}

// ---- token accounts -------------------------------------------------------------------------------

export interface SplTokenAccount {
  /** The token program that owns the account. */
  program: PublicKey;
  mint: PublicKey;
  /** Whose tokens these are (the account's `owner` field, not the account's program). */
  owner: PublicKey;
  amount: bigint;
  delegate: PublicKey | null;
  state: 'initialized' | 'frozen';
  /** Wrapped SOL's rent-exempt reserve when the account is native; null otherwise. */
  isNative: bigint | null;
  delegatedAmount: bigint;
  closeAuthority: PublicKey | null;
  /** A Token-2022 account's extensions (after its 165 bytes and type byte), in the order stored; empty under SPL Token. */
  extensions: MintExtension[];
}

/**
 * A token account of either program, as read: null when the account is missing, owned by any other
 * program, shorter than 165 bytes, not initialized, or a Token-2022 account whose type byte says it
 * is not a token account (a mint with extensions).
 */
export function readTokenAccount(info: Pick<AccountInfo<Buffer>, 'owner' | 'data'> | null): SplTokenAccount | null {
  if (!info) return null;
  const program = splProgramOf(info.owner);
  if (!program) return null;
  const data = info.data;
  if (data.length < SPL_TOKEN_ACCOUNT_LENGTH) return null;
  if (data.length > SPL_TOKEN_ACCOUNT_LENGTH && data[SPL_TOKEN_ACCOUNT_LENGTH] !== TOKEN_2022_ACCOUNT_TYPE.account) return null;
  const state = data[108];
  if (state !== 1 && state !== 2) return null;
  return {
    program,
    mint: new PublicKey(data.subarray(0, 32)),
    owner: new PublicKey(data.subarray(32, 64)),
    amount: data.readBigUInt64LE(64),
    delegate: coptionKey(data, 72),
    state: state === 2 ? 'frozen' : 'initialized',
    isNative: data.readUInt32LE(109) === 1 ? data.readBigUInt64LE(113) : null,
    delegatedAmount: data.readBigUInt64LE(121),
    closeAuthority: coptionKey(data, 129),
    extensions: accountExtensions(data),
  };
}

/** A token account's extensions; none when they can't be read (the balance stays readable). */
function accountExtensions(data: Buffer): MintExtension[] {
  try {
    return readExtensions(data, TOKEN_2022_ACCOUNT_TYPE.account);
  } catch {
    return [];
  }
}

/** Whether a token account's `CpiGuard` is on: its owner can't move its tokens through another program, so the DEX can't take a buy's input from it. */
export const cpiGuardLocked = (account: Pick<SplTokenAccount, 'extensions'>): boolean => account.extensions.some((e) => e.type === TOKEN_2022_ACCOUNT_EXTENSION.cpiGuard && (e.data[0] ?? 0) !== 0);
/** Whether a token account requires a memo on incoming transfers (`MemoTransfer`): the DEX's payment of a sell into it fails. */
export const memoTransferRequired = (account: Pick<SplTokenAccount, 'extensions'>): boolean => account.extensions.some((e) => e.type === TOKEN_2022_ACCOUNT_EXTENSION.memoTransfer && (e.data[0] ?? 0) !== 0);

// ---- mints ----------------------------------------------------------------------------------------

/** One Token-2022 extension as stored (a mint's or a token account's): its number and its bytes. */
export interface MintExtension {
  type: number;
  data: Buffer;
}

/** An account's Token-2022 extensions when its type byte (at 165) is `accountType`; empty otherwise. Throws `RangeError` when an entry runs past the end. */
function readExtensions(data: Buffer, accountType: number): MintExtension[] {
  if (data.length <= SPL_TOKEN_ACCOUNT_LENGTH || data[SPL_TOKEN_ACCOUNT_LENGTH] !== accountType) return [];
  const out: MintExtension[] = [];
  let at = SPL_TOKEN_ACCOUNT_LENGTH + 1;
  while (at + 4 <= data.length) {
    const type = data.readUInt16LE(at);
    const length = data.readUInt16LE(at + 2);
    // Zeroed space after the last entry (an account sized for an extension not written yet).
    if (type === 0 && length === 0) break;
    const end = at + 4 + length;
    if (end > data.length) throw new RangeError(`a Token-2022 extension (${type}) runs past the end of the account`);
    out.push({ type, data: data.subarray(at + 4, end) });
    at = end;
  }
  return out;
}

/**
 * A Token-2022 mint's extensions in the order stored; empty for a mint without any (82 bytes) and for
 * every SPL Token mint. Throws `RangeError` when an entry runs past the end of the account.
 */
export function readMintExtensions(data: Buffer): MintExtension[] {
  return readExtensions(data, TOKEN_2022_ACCOUNT_TYPE.mint);
}

/** An SPL Token or Token-2022 mint as read. */
export interface SplMintAccount {
  programId: PublicKey;
  program: QuoteTokenProgram;
  mintAuthority: PublicKey | null;
  supply: bigint;
  decimals: number;
  freezeAuthority: PublicKey | null;
  /** Token-2022's extensions; empty for SPL Token. */
  extensions: MintExtension[];
}

/**
 * A mint of either program: null when the account is missing, owned by any other program, not
 * initialized, or not a mint (a token account: 165 bytes, or a Token-2022 account whose type byte
 * is not 1). Throws `RangeError` on malformed Token-2022 extensions.
 */
export function readSplMintAccount(info: Pick<AccountInfo<Buffer>, 'owner' | 'data'> | null): SplMintAccount | null {
  if (!info) return null;
  const programId = splProgramOf(info.owner);
  if (!programId) return null;
  const data = info.data;
  const isMint = data.length === SPL_MINT_LENGTH || (programId.equals(SPL_TOKEN_2022_PROGRAM) && data.length > SPL_TOKEN_ACCOUNT_LENGTH && data[SPL_TOKEN_ACCOUNT_LENGTH] === TOKEN_2022_ACCOUNT_TYPE.mint);
  if (!isMint || data[45] !== 1) return null;
  return {
    programId,
    program: splProgramName(programId)!,
    mintAuthority: coptionKey(data, 0),
    supply: data.readBigUInt64LE(36),
    decimals: data[44]!,
    freezeAuthority: coptionKey(data, 46),
    extensions: readMintExtensions(data),
  };
}

/** `DefaultAccountState`: the state new accounts start in (0 uninitialized, 1 initialized, 2 frozen). */
export const defaultAccountStateOf = (ext: MintExtension): number => ext.data[0] ?? 0;
/** `TransferHook`: who may set the hook program, and the program set (null: none). */
export const transferHookOf = (ext: MintExtension): { authority: PublicKey | null; program: PublicKey | null } => ({ authority: optionalKey(ext.data, 0), program: optionalKey(ext.data, 32) });
/** `Pausable`: who may pause, and whether transfers are paused now. */
export const pausableOf = (ext: MintExtension): { authority: PublicKey | null; paused: boolean } => ({ authority: optionalKey(ext.data, 0), paused: (ext.data[32] ?? 0) !== 0 });
/**
 * `ScaledUiAmount` (56 bytes: authority, multiplier f64, the new multiplier's effective time i64,
 * the new multiplier f64): the multiplier in force at `now` (unix seconds), the new one from its
 * effective time on. A mint's whole tokens as wallets and Jupiter count them are
 * `raw × multiplier / 10^decimals`. 1 for a mint without the extension, or one that holds no usable
 * multiplier.
 */
export function scaledUiMultiplierOf(mint: Pick<SplMintAccount, 'extensions'>, now: number = Math.floor(Date.now() / 1000)): number {
  const ext = mint.extensions.find((e) => e.type === TOKEN_2022_EXTENSION.scaledUiAmount);
  if (!ext || ext.data.length < 56) return 1;
  const current = ext.data.readDoubleLE(32);
  const effectiveAt = Number(ext.data.readBigInt64LE(40));
  const next = ext.data.readDoubleLE(48);
  const value = effectiveAt > 0 && now >= effectiveAt ? next : current;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** `PermanentDelegate`, `MintCloseAuthority`: the key the extension names (null: none). */
export const extensionKeyOf = (ext: MintExtension): PublicKey | null => optionalKey(ext.data, 0);

// ---- the quote mint policy (docs/token-quotes.md §2.3) -------------------------------------------

/** What `quoteMintPolicy` says of a mint. */
export interface QuoteMintVerdict {
  /** Why the DEX would refuse it as a leg's quote; null when it takes it. */
  refusal: QuoteTokenRefusal | null;
  /** The issuer's powers the site labels it with (never a reason to refuse it), in `QuoteTokenRisk` order. */
  risks: QuoteTokenRisk[];
  /** Its Token-2022 extensions by name, in the order stored (`#<n>` for a number the policy does not know). */
  extensions: string[];
}

/** Which refusal is named when a mint has several: the first of these it has. */
const REFUSAL_ORDER: readonly QuoteTokenRefusal[] = ['non_transferable', 'transfer_fee', 'transfer_hook', 'confidential', 'frozen_by_default', 'unknown_extension', 'paused'];
/** Risks in the order `QuoteTokenRisk` lists them (the API's two labels last; they are the server's to add). */
const RISK_ORDER: readonly QuoteTokenRisk[] = ['freeze', 'mintAuthority', 'permanentDelegate', 'pausable', 'hookAuthority', 'closeAuthority', 'scaledAmount', 'unverified', 'thinLiquidity'];

/** The refusal of an extension the policy refuses outright. */
const REFUSED_AS: Record<number, QuoteTokenRefusal> = {
  [TOKEN_2022_EXTENSION.transferFeeConfig]: 'transfer_fee',
  [TOKEN_2022_EXTENSION.confidentialTransferFeeConfig]: 'transfer_fee',
  [TOKEN_2022_EXTENSION.nonTransferable]: 'non_transferable',
  [TOKEN_2022_EXTENSION.confidentialMintBurn]: 'confidential',
};

/**
 * The DEX's quote mint policy (docs/token-quotes.md §2.3; `TOKEN_2022_MINT_EXTENSIONS`): an SPL Token
 * mint is always taken; a Token-2022 mint is refused for a transfer fee, a transfer hook with a
 * program set, non-transferability, confidential-only minting, new accounts frozen by default,
 * transfers paused now, or an extension number the policy does not list. What the issuer can do is
 * labelled: freeze (a freeze authority), mint more (a mint authority), a permanent delegate, pause (a pause authority), add a hook
 * later (a hook authority with no program yet), close the mint, or scale how balances read.
 */
export function quoteMintPolicy(mint: Pick<SplMintAccount, 'freezeAuthority' | 'extensions'> & Partial<Pick<SplMintAccount, 'mintAuthority'>>): QuoteMintVerdict {
  const refusals = new Set<QuoteTokenRefusal>();
  const risks = new Set<QuoteTokenRisk>();
  const names: string[] = [];
  if (mint.freezeAuthority) risks.add('freeze');
  // Its issuer can mint more (the base layout's mint authority, a COption at 0).
  if (mint.mintAuthority) risks.add('mintAuthority');
  for (const ext of mint.extensions) {
    const known = TOKEN_2022_MINT_EXTENSIONS[ext.type];
    names.push(known?.name ?? `#${ext.type}`);
    if (!known) {
      refusals.add('unknown_extension');
      continue;
    }
    if (known.policy === 'refuse') {
      refusals.add(REFUSED_AS[ext.type] ?? 'unknown_extension');
      continue;
    }
    switch (ext.type) {
      case TOKEN_2022_EXTENSION.defaultAccountState:
        // Only `Initialized` (1): a pool's vault and every trader's account must start usable.
        if (defaultAccountStateOf(ext) !== 1) refusals.add('frozen_by_default');
        break;
      case TOKEN_2022_EXTENSION.transferHook: {
        const hook = transferHookOf(ext);
        if (hook.program) refusals.add('transfer_hook');
        if (hook.authority) risks.add('hookAuthority');
        break;
      }
      case TOKEN_2022_EXTENSION.pausable: {
        const pause = pausableOf(ext);
        if (pause.paused) refusals.add('paused');
        if (pause.authority) risks.add('pausable');
        break;
      }
      case TOKEN_2022_EXTENSION.permanentDelegate:
        if (extensionKeyOf(ext)) risks.add('permanentDelegate');
        break;
      case TOKEN_2022_EXTENSION.mintCloseAuthority:
        if (extensionKeyOf(ext)) risks.add('closeAuthority');
        break;
      default:
        // InterestBearingConfig and ScaledUiAmount always change how a balance reads; the rest carry no label.
        if (known.risk === 'scaledAmount') risks.add('scaledAmount');
    }
  }
  return { refusal: REFUSAL_ORDER.find((r) => refusals.has(r)) ?? null, risks: RISK_ORDER.filter((r) => risks.has(r)), extensions: names };
}

// ---- instructions ---------------------------------------------------------------------------------

/**
 * `TransferChecked` (instruction 12 of both programs: the amount as u64 LE, then the decimals):
 * `amount` raw units from `source` to `destination`, both token accounts of `mint`, signed by
 * `authority` (the source's owner or its delegate). A Token-2022 mint with a transfer hook needs the
 * hook's extra accounts after these four, which this does not resolve (a leg's quote never has one).
 */
export function transferChecked(source: PublicKey, mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint, decimals: number, tokenProgram: PublicKey = SPL_TOKEN_PROGRAM): TransactionInstruction {
  if (!splProgramOf(tokenProgram)) throw new Error(`${tokenProgram.toBase58()} is not a token program`);
  if (amount < 0n || amount > 0xffff_ffff_ffff_ffffn) throw new RangeError('amount must fit a u64');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError('decimals must fit a u8');
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  const keys: AccountMeta[] = [
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ];
  return new TransactionInstruction({ programId: tokenProgram, keys, data });
}
