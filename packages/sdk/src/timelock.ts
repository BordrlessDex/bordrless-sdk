/**
 * `hook_timelock` (phase 3a, bordrless-programs docs/phase3a.md §3): a hook's (or a strategy's)
 * upgrade authority behind a public delay. Its author proposes new code from a loader buffer whose
 * authority is already the timelock (`loader.setAuthority`, then `timelock.propose`); anyone
 * executes it from its eta for 30 days; the author can cancel, lengthen the delay (never shorten
 * it), hand the role over, or make the program immutable (`finalize`). Mirrors
 * `hook_timelock::client` account for account (held to it by `vectors/timelock.json`).
 */
import { PublicKey, type AccountMeta, type TransactionInstruction, TransactionInstruction as Ix } from '@solana/web3.js';
import * as a from './addresses.ts';
import { timelockAddress } from './authority.ts';
import { CODERS } from './coders.ts';

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });

export const RENT_SYSVAR = new PublicKey('SysvarRent111111111111111111111111111111111');
export const CLOCK_SYSVAR = new PublicKey('SysvarC1ock11111111111111111111111111111111');
export const HOOK_TIMELOCK_EVENT_AUTHORITY = a.eventAuthority(a.HOOK_TIMELOCK_PROGRAM);
/** How long a proposal stays executable after its eta, and the largest code it may carry. */
export const TIMELOCK_LIMITS = { executeWindowSecs: 30 * 86_400, maxCodeLen: 2 * 1024 * 1024, minDelaySecs: 3 * 86_400, maxDelaySecs: 365 * 86_400 } as const;

function build(name: string, args: Record<string, unknown>, named: AccountMeta[]): TransactionInstruction {
  const keys = [...named, ro(HOOK_TIMELOCK_EVENT_AUTHORITY), ro(a.HOOK_TIMELOCK_PROGRAM)];
  return new Ix({ programId: a.HOOK_TIMELOCK_PROGRAM, keys, data: CODERS.hookTimelock.instruction.encode(name, args) });
}

const closeProposal = (sender: PublicKey, program: PublicKey, buffer: PublicKey, author: PublicKey): AccountMeta[] => [ro(sender, true), rw(timelockAddress(program)), rw(buffer), rw(author), ro(a.BPF_LOADER_UPGRADEABLE)];
const authorOnly = (author: PublicKey, program: PublicKey): AccountMeta[] => [ro(author, true), rw(timelockAddress(program))];

export const timelock = {
  /** `register(delaySecs, author)`: `authority` (the program's current upgrade authority) hands `program` to its new timelock, `payer` paying its rent. Studio's key can hand a program straight to its creator's timelock (`author` = the creator). */
  register(payer: PublicKey, authority: PublicKey, program: PublicKey, delaySecs: number, author: PublicKey): TransactionInstruction {
    return build('register', { delaySecs, author }, [rw(payer, true), ro(authority, true), ro(program), rw(a.programDataAddress(program)), rw(timelockAddress(program)), ro(a.BPF_LOADER_UPGRADEABLE), ro(a.SYSTEM_PROGRAM)]);
  },
  /** `propose(len)`: the code in `buffer` (its authority already the timelock), `len` its length without trailing zeros (`trimmedLength`). */
  propose(author: PublicKey, program: PublicKey, buffer: PublicKey, len: number): TransactionInstruction {
    return build('propose', { len }, [ro(author, true), rw(timelockAddress(program)), ro(buffer)]);
  },
  /** `cancel`: the author closes the proposal's buffer to themselves. */
  cancel(author: PublicKey, program: PublicKey, buffer: PublicKey): TransactionInstruction {
    return build('cancel', {}, closeProposal(author, program, buffer, author));
  },
  /** `expire` (anyone, after the 30-day window): the buffer closed to the author. */
  expire(sender: PublicKey, program: PublicKey, buffer: PublicKey, author: PublicKey): TransactionInstruction {
    return build('expire', {}, closeProposal(sender, program, buffer, author));
  },
  /** `execute` (anyone, from the eta): the program takes the proposed code; the buffer's lamports go to the author. Send the loader's `ExtendProgram` first when the code is larger than the ProgramData. */
  execute(sender: PublicKey, program: PublicKey, buffer: PublicKey, author: PublicKey): TransactionInstruction {
    return build('execute', {}, [ro(sender, true), rw(timelockAddress(program)), rw(program), rw(a.programDataAddress(program)), rw(buffer), rw(author), ro(RENT_SYSVAR), ro(CLOCK_SYSVAR), ro(a.BPF_LOADER_UPGRADEABLE)]);
  },
  /** `reclaim_buffer`: the author closes a stray buffer whose authority is the timelock. */
  reclaimBuffer(author: PublicKey, program: PublicKey, buffer: PublicKey): TransactionInstruction {
    return build('reclaimBuffer', {}, [rw(author, true), ro(timelockAddress(program)), rw(buffer), ro(a.BPF_LOADER_UPGRADEABLE)]);
  },
  /** `lengthen(delaySecs)`: never shorter; a pending eta moves with it. */
  lengthen(author: PublicKey, program: PublicKey, delaySecs: number): TransactionInstruction {
    return build('lengthen', { delaySecs }, authorOnly(author, program));
  },
  /** `propose_author(newAuthor)` (the default key clears it). */
  proposeAuthor(author: PublicKey, program: PublicKey, newAuthor: PublicKey): TransactionInstruction {
    return build('proposeAuthor', { newAuthor }, authorOnly(author, program));
  },
  /** `accept_author`, signed by the author named. */
  acceptAuthor(newAuthor: PublicKey, program: PublicKey): TransactionInstruction {
    return build('acceptAuthor', {}, [ro(newAuthor, true), rw(timelockAddress(program))]);
  },
  /** `finalize`: the program made immutable, at once (no proposal pending). */
  finalize(author: PublicKey, program: PublicKey): TransactionInstruction {
    return build('finalize', {}, [ro(author, true), rw(timelockAddress(program)), rw(a.programDataAddress(program)), ro(a.BPF_LOADER_UPGRADEABLE)]);
  },
};

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/** The upgradeable loader's instructions around a timelock (bincode: a u32 tag). */
export const loader = {
  /** `SetAuthority`: `account`'s authority from `current` (signing) to `next` (null: a program becomes immutable). How an author hands a buffer to the timelock before `propose`. */
  setAuthority(account: PublicKey, current: PublicKey, next: PublicKey | null): TransactionInstruction {
    const keys = [rw(account), ro(current, true), ...(next ? [ro(next)] : [])];
    return new Ix({ programId: a.BPF_LOADER_UPGRADEABLE, keys, data: u32(4) });
  },
  /** `ExtendProgram` (permissionless, at least 10,240 bytes): the ProgramData grows, `payer` paying the rent. */
  extendProgram(programdata: PublicKey, program: PublicKey, payer: PublicKey, additionalBytes: number): TransactionInstruction {
    return new Ix({ programId: a.BPF_LOADER_UPGRADEABLE, keys: [rw(programdata), rw(program), ro(a.SYSTEM_PROGRAM), rw(payer, true)], data: Buffer.concat([u32(6), u32(additionalBytes)]) });
  },
};

/** `TimelockRegistered`, `UpgradeProposed`, `Upgraded`, … as the IDL names them. */
export const TIMELOCK_EVENTS = ['timelockRegistered', 'upgradeProposed', 'upgradeCancelled', 'upgradeExpired', 'upgraded', 'bufferReclaimed', 'delayLengthened', 'authorProposed', 'authorAccepted', 'finalized'] as const;

