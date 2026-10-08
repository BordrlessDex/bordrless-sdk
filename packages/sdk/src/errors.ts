/**
 * Program errors in words a trader can act on, keyed by the program that failed. Custom codes 6000
 * and up overlap between programs (6006 is the kit's `CreatorLocked`, the DEX's `FeeTooHigh` and the
 * token program's `SameAccount`), and a failure inside a CPI surfaces on every program above it, so
 * an error is read from the logs: the first `Program <id> failed: custom program error: 0x…` line
 * names the program that raised it (the innermost; the lines after it are the callers unwinding).
 * Codes below 6000 are Anchor's own (`ConstraintSeeds` 2006, `AccountNotInitialized` 3012, …),
 * the same in every program.
 */
import anchor from '@anchor-lang/core';
import type { PublicKey } from '@solana/web3.js';
import * as a from './addresses.ts';
import { IDL, type ProgramName } from './coders.ts';
import { programNameOf } from './events.ts';

const { LangErrorCode, LangErrorMessage } = anchor;

export interface ProgramErrorEntry {
  /** The Rust variant (`MaxWalletExceeded`). */
  name: string;
  /** The program's own message. */
  message: string;
}

function table(idl: { errors?: { code: number; name: string; msg?: string }[] }): ReadonlyMap<number, ProgramErrorEntry> {
  return new Map((idl.errors ?? []).map((e) => [e.code, { name: e.name, message: e.msg ?? e.name }]));
}

/** Every custom error of each program, from its IDL (programs-summary §3). */
export const PROGRAM_ERRORS: Readonly<Record<ProgramName, ReadonlyMap<number, ProgramErrorEntry>>> = {
  token: table(IDL.token),
  swap: table(IDL.swap),
  bridge: table(IDL.bridge),
  launch: table(IDL.launch),
  kit: table(IDL.kit),
  taxHook: table(IDL.taxHook),
  halfLife: table(IDL.halfLife),
  companion: table(IDL.companion),
};

const ANCHOR_ERRORS: ReadonlyMap<number, ProgramErrorEntry> = new Map(
  Object.entries(LangErrorCode as Record<string, number>).map(([name, code]) => [code, { name, message: (LangErrorMessage as Map<number, string>).get(code) ?? name }]),
);

/** The sentences the site shows, per program and error; any other error shows the program's message. */
const EXPLANATIONS: Partial<Record<ProgramName, Readonly<Record<string, string>>>> = {
  token: {
    InsufficientFunds: 'Not enough balance for this.',
    InsufficientDelegation: 'The delegate may not move that much.',
    Frozen: 'This holding is frozen.',
    HoldingNotEmpty: 'Only an empty holding can be closed.',
    HookDataNotEmpty: 'This holding still keeps holder rewards owed to it: claim them before closing it.',
  },
  swap: {
    Slippage: 'The price moved more than your slippage allows. Try again or raise the slippage.',
    InsufficientLiquidity: 'The pool cannot fill this trade. Try a smaller amount.',
    FeeExceedsInput: 'The amount is too small for the fees. Try a larger amount.',
    FeeExceedsOutput: 'The amount is too small: the fees would take everything it gets back. Try a larger amount.',
    NothingReceived: 'Nothing reached the pool. Try a larger amount.',
    Paused: 'Trading is paused right now.',
    CurveLocked: 'Liquidity cannot be changed until the launch graduates.',
    LpBelowMinimum: 'The pool moved: this deposit would mint less LP than your minimum. Try again.',
    WithdrawalBelowMinimum: 'The pool moved: this withdrawal would return less than your minimum. Try again.',
    MintNotWritable: 'This trade was built without the token mint writable, which its burn needs. Refresh and try again.',
  },
  bridge: {
    Paused: 'The bridge is paused right now.',
    InsufficientVault: 'The bridge vault does not hold enough for this.',
    NothingReceived: 'Nothing reached the bridge vault. Try a larger amount.',
  },
  launch: {
    Paused: 'Launches are paused right now.',
    HookUpgradeable: 'This hook can be upgraded by someone other than Bordrless, so it could be swapped for other code after launch. Make it immutable, or deploy it with Bordrless Studio.',
    HookProgramDataMissing: 'The hook’s program data account is missing. Update the app or SDK and try again.',
    NotReady: 'The launch has not raised enough to graduate yet.',
    AlreadyGraduated: 'This launch has already graduated.',
    NothingToClaim: 'There are no creator fees to claim yet.',
    NotCreator: 'Only the creator can do this.',
    CreatorFeeTooHigh: 'The creator fee is above the maximum.',
    VirtualQuoteOutOfBounds: 'The opening price is out of bounds. Refresh and try again.',
    HolderFeeTooHigh: 'Holder rewards are above the maximum per side.',
    BurnTooHigh: 'The burn is above the maximum per side.',
    RulesFeeTooHigh: 'Creator fee, holder rewards and burn add up to more than the maximum on one side.',
    MaxWalletOutOfBounds: 'Max wallet must be off or within the bounds.',
    CreatorLockTooLong: 'The creator wallet lock is longer than the maximum.',
    InvalidEarlyLock: 'The early-buyer lock needs a window within the maximum and an unlock after it, within the maximum.',
    CustomHookWithKitRules: 'A config with a custom hook can’t have holder rewards, max wallet or the locks: one token hook per mint. Burn and the creator fee are fine.',
    InvalidCustomHook: 'The hook must be a deployed program of your own: not one of Bordrless’s, and not the system program.',
    InvalidCustomHookFlags: 'The hook’s flags must name at least one callback it runs on, with no unknown bit; 0 without a hook.',
    HookRegistryMissing: 'Prepare the hook for this mint first: its registry at ["bordrless-hook-accounts", mint] does not exist.',
    HookExtrasMismatch: 'The hook’s accounts passed do not match its registry for this mint. Refresh and try again.',
    CustomHookAccountsMissing: 'This config names a hook, so the launch needs the hook’s accounts. Refresh and try again.',
    UnexpectedCustomHookAccounts: 'This launch has no custom hook, but hook accounts were passed. Refresh and try again.',
    ConfigMismatch: 'The rules and creator fee sent do not match the config’s. Refresh the config and try again.',
    WrongHookSigner: 'The token program’s signer for this hook is wrong. Refresh and try again.',
    InvalidLabel: 'A config’s label is at most 32 bytes.',
  },
  kit: {
    MaxWalletExceeded: 'This would take the receiving wallet above max wallet. Buy less, or wait for graduation, when max wallet lifts.',
    CreatorLocked: "The creator's wallet is locked: it can't sell, send or add liquidity until the creator wallet lock ends.",
    EarlyLocked: "Tokens bought in the early window can't be sold, sent or burned until the early-buyer lock ends.",
    DestinationNotAllowed: "This token can't be sent to that address: with holder rewards on, no program can hold it.",
    NothingToClaim: 'Nothing to claim yet.',
    RewardsOff: 'This token has no holder rewards.',
    NotAHolder: 'The pool and the launch earn no holder rewards.',
    ShareTooSmall: 'A share must be at least 0.001 SOL.',
    NoEligibleHolders: 'Nobody is eligible for holder rewards yet, so nothing can be shared.',
  },
};

export interface ProgramErrorInfo {
  /** The SDK's name of the program that failed; null for a program that is not Bordrless's. */
  program: ProgramName | null;
  programId: string | null;
  /** The custom error code; null when the failure is not a custom error. */
  code: number | null;
  /** The error's name (`MaxWalletExceeded`, `ConstraintSeeds`); null when unknown. */
  name: string | null;
  /** The program's own message; null when unknown. */
  message: string | null;
  /** A sentence for the person who signed. */
  explanation: string;
}

const sentence = (text: string): string => {
  const t = text.trim();
  if (!t) return t;
  const capital = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

const PROGRAM_IDS_BY_NAME: Readonly<Record<ProgramName, PublicKey>> = { token: a.TOKEN_PROGRAM, swap: a.SWAP_PROGRAM, bridge: a.BRIDGE_PROGRAM, launch: a.LAUNCH_PROGRAM, kit: a.KIT_PROGRAM, taxHook: a.TAX_HOOK_PROGRAM, halfLife: a.HALF_LIFE_PROGRAM, companion: a.COMPANION_PROGRAM };

/** The error `code` of `program` (its SDK name or its id), explained. */
export function explainProgramError(program: ProgramName | string | PublicKey, code: number): ProgramErrorInfo {
  const byName = typeof program === 'string' && Object.hasOwn(PROGRAM_IDS_BY_NAME, program);
  const name: ProgramName | null = byName ? (program as ProgramName) : programNameOf(program);
  const programId = byName ? PROGRAM_IDS_BY_NAME[program as ProgramName].toBase58() : typeof program === 'string' ? program : program.toBase58();
  const entry = code >= 6000 ? (name ? PROGRAM_ERRORS[name].get(code) : undefined) : ANCHOR_ERRORS.get(code);
  if (!entry) return { program: name, programId, code, name: null, message: null, explanation: `The transaction failed with error ${code}${name ? ` in the ${name} program` : ''}.` };
  const explained = name && code >= 6000 ? EXPLANATIONS[name]?.[entry.name] : undefined;
  return { program: name, programId, code, name: entry.name, message: entry.message, explanation: explained ?? sentence(entry.message) };
}

/**
 * The program that failed and how, from a transaction's logs: the first `Program <id> failed: …`
 * line (the innermost failure). `code` is the custom error's code, null for any other failure
 * (`message` then holds what the runtime said). Null when no program failed.
 */
export function failedProgram(logs: readonly string[]): { programId: string; code: number | null; message: string } | null {
  for (const line of logs) {
    const m = /^Program (\w{32,44}) failed: (.+)$/.exec(line);
    if (!m) continue;
    const custom = /custom program error: 0x([0-9a-fA-F]+)/.exec(m[2]!);
    return { programId: m[1]!, code: custom ? parseInt(custom[1]!, 16) : null, message: m[2]! };
  }
  return null;
}

/**
 * A failed transaction explained from its logs. With no failing program in the logs it falls back
 * on `err` (`{ InstructionError: [index, { Custom: code }] }`), whose program cannot be told (a CPI
 * error surfaces on the top-level instruction): `program` is then null. Null when nothing failed.
 */
export function explainFailure(logs: readonly string[], err?: unknown): ProgramErrorInfo | null {
  if (logs.some((l) => /insufficient lamports/i.test(l))) return { program: null, programId: null, code: null, name: null, message: null, explanation: 'Not enough SOL to pay for this transaction.' };
  const failed = failedProgram(logs);
  if (failed) {
    if (failed.code !== null) return explainProgramError(failed.programId, failed.code);
    const program = programNameOf(failed.programId);
    return { program, programId: failed.programId, code: null, name: null, message: failed.message, explanation: sentence(failed.message) };
  }
  const custom = (err as { InstructionError?: [number, { Custom?: number } | string] } | null | undefined)?.InstructionError?.[1];
  if (custom && typeof custom === 'object' && typeof custom.Custom === 'number') {
    const code = custom.Custom;
    const anchorError = code < 6000 ? ANCHOR_ERRORS.get(code) : undefined;
    return { program: null, programId: null, code, name: anchorError?.name ?? null, message: anchorError?.message ?? null, explanation: anchorError ? sentence(anchorError.message) : `The transaction failed with error ${code}.` };
  }
  return err === undefined || err === null ? null : { program: null, programId: null, code: null, name: null, message: null, explanation: `The transaction failed: ${typeof err === 'string' ? err : JSON.stringify(err)}.` };
}
