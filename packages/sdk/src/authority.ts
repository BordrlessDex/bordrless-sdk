/**
 * Who can change a program's code (phase 3a, bordrless-programs docs/phase3a.md §2), read from its
 * accounts as `bordrless_hook::authority` reads them on chain: immutable, timelocked (its upgrade
 * authority is its own `hook_timelock` account, a delay of at least 3 days), Bordrless-managed
 * (Studio's upgrade key or the protocol's) or upgradeable by its author. The launchpad takes the
 * first three for a custom hook; the companion takes them (with a Studio attestation, or a status)
 * for a game hook, and for a strategy. Also: the `Timelock` account, the loader's headers, and the
 * executable hash `solana-verify get-executable-hash` computes.
 */
import { createHash } from 'node:crypto';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { HOOK_UPGRADE_AUTHORITIES } from '@bordrless/shared';
import { BPF_LOADER_UPGRADEABLE, HOOK_TIMELOCK_PROGRAM, programDataAddress } from './addresses.ts';

export const BPF_LOADER_2 = new PublicKey('BPFLoader2111111111111111111111111111111111');
export const LOADER_V4 = new PublicKey('LoaderV411111111111111111111111111111111111');
/** The shortest timelock delay any reader accepts (and `hook_timelock` allows): 3 days. */
export const MIN_TIMELOCK_DELAY_SECS = 3 * 86_400;
/** The longest: 365 days. */
export const MAX_TIMELOCK_DELAY_SECS = 365 * 86_400;
/** `sha256("account:Timelock")[..8]`. */
export const TIMELOCK_DISCRIMINATOR = Buffer.from([0xbd, 0x21, 0x4e, 0x4b, 0xcd, 0x1f, 0x04, 0xb1]);
/** Where a `Timelock` keeps each field (`bordrless_hook::authority::timelock_offsets`). */
export const TIMELOCK_OFFSETS = {
  version: 8,
  bump: 9,
  program: 10,
  programdata: 42,
  author: 74,
  pendingAuthor: 106,
  delaySecs: 138,
  finalized: 142,
  pendingBuffer: 143,
  pendingHash: 175,
  pendingLen: 207,
  proposedAt: 211,
  eta: 219,
  upgrades: 227,
  createdAt: 231,
  lastUpgradedAt: 239,
  reserved: 247,
  len: 279,
} as const;
/** Bytes of a ProgramData's header (the code starts after it), a buffer's, a loader-v4 program's. */
export const PROGRAMDATA_HEADER_LEN = 45;
export const BUFFER_HEADER_LEN = 37;
export const LOADER_V4_HEADER_LEN = 48;

/** A program's `Timelock` (and its upgrade authority, once registered): `PDA(["timelock", program], hook_timelock)`. */
export const timelockAddress = (program: PublicKey): PublicKey => PublicKey.findProgramAddressSync([Buffer.from('timelock'), program.toBuffer()], HOOK_TIMELOCK_PROGRAM)[0];

export type AuthorityClass = { kind: 'immutable' } | { kind: 'timelocked'; delaySecs: number } | { kind: 'managed'; key: PublicKey } | { kind: 'author'; key: PublicKey | null };
export type ClassError = 'wrongProgramData' | 'timelockMissing' | 'timelockInvalid';

/** What a ProgramData header says (`[3u32, slot u64, Option<Pubkey>]`): null for bytes that are not one. */
export function parseProgramData(data: Buffer): { slot: bigint; authority: PublicKey | null } | null {
  if (data.length < 13 || data.readUInt32LE(0) !== 3) return null;
  const slot = data.readBigUInt64LE(4);
  if (data[12] === 0) return { slot, authority: null };
  if (data[12] !== 1 || data.length < 45) return null;
  return { slot, authority: new PublicKey(data.subarray(13, 45)) };
}

/** A buffer's authority (`[1u32, Option<Pubkey>]`): undefined for bytes that are not a buffer. */
export function parseBuffer(data: Buffer): PublicKey | null | undefined {
  if (data.length < 5 || data.readUInt32LE(0) !== 1) return undefined;
  if (data[4] === 0) return null;
  if (data[4] !== 1 || data.length < 37) return undefined;
  return new PublicKey(data.subarray(5, 37));
}

/** A `Timelock` account, read at its offsets. */
export interface TimelockView {
  bump: number;
  program: PublicKey;
  programdata: PublicKey;
  author: PublicKey;
  pendingAuthor: PublicKey | null;
  delaySecs: number;
  finalized: boolean;
  /** The proposal waiting: its buffer, its code's executable hash (hex), length, when proposed, when anyone may execute it. */
  pending: { buffer: PublicKey; hash: string; len: number; proposedAt: number; eta: number } | null;
  upgrades: number;
  createdAt: number;
  lastUpgradedAt: number;
}

/** Parses a `Timelock`'s data (discriminator and length checked; owner and address are the caller's). */
export function decodeTimelock(data: Buffer): TimelockView | null {
  const o = TIMELOCK_OFFSETS;
  if (data.length < o.len || !data.subarray(0, 8).equals(TIMELOCK_DISCRIMINATOR)) return null;
  const key = (at: number) => new PublicKey(data.subarray(at, at + 32));
  const buffer = key(o.pendingBuffer);
  const pendingAuthor = key(o.pendingAuthor);
  return {
    bump: data[o.bump] ?? 0,
    program: key(o.program),
    programdata: key(o.programdata),
    author: key(o.author),
    pendingAuthor: pendingAuthor.equals(PublicKey.default) ? null : pendingAuthor,
    delaySecs: data.readUInt32LE(o.delaySecs),
    finalized: data[o.finalized] !== 0,
    pending: buffer.equals(PublicKey.default)
      ? null
      : {
          buffer,
          hash: data.subarray(o.pendingHash, o.pendingHash + 32).toString('hex'),
          len: data.readUInt32LE(o.pendingLen),
          proposedAt: Number(data.readBigInt64LE(o.proposedAt)),
          eta: Number(data.readBigInt64LE(o.eta)),
        },
    upgrades: data.readUInt32LE(o.upgrades),
    createdAt: Number(data.readBigInt64LE(o.createdAt)),
    lastUpgradedAt: Number(data.readBigInt64LE(o.lastUpgradedAt)),
  };
}

type Raw = Pick<AccountInfo<Buffer>, 'owner' | 'data'> & { executable?: boolean };

/**
 * The class of the upgradeable-loader program `program` whose upgrade authority is `authority`
 * (`class_of_authority`): a Bordrless key is managed; the program's own timelock address is
 * timelocked when `timelock` is a valid `Timelock` for it (owner `hook_timelock`, its program and
 * ProgramData, at the address its bump gives, a delay of at least 3 days); any other key is the
 * author's.
 */
export function classOfAuthority(program: PublicKey, programdata: PublicKey, authority: PublicKey | null, timelock: { key: PublicKey; account: Raw } | null): AuthorityClass | ClassError {
  if (authority === null) return { kind: 'immutable' };
  if (HOOK_UPGRADE_AUTHORITIES.includes(authority.toBase58())) return { kind: 'managed', key: authority };
  // Only an account of `hook_timelock`'s is read as a timelock (any other account passed leaves an author's program the author's).
  if (timelock && timelock.key.equals(authority) && timelock.account.owner.equals(HOOK_TIMELOCK_PROGRAM)) {
    const view = decodeTimelock(timelock.account.data);
    if (!view) return 'timelockInvalid';
    let at: PublicKey;
    try {
      at = PublicKey.createProgramAddressSync([Buffer.from('timelock'), program.toBuffer(), Buffer.from([view.bump])], HOOK_TIMELOCK_PROGRAM);
    } catch {
      return 'timelockInvalid';
    }
    if (!at.equals(authority) || !view.program.equals(program) || !view.programdata.equals(programdata) || view.delaySecs < MIN_TIMELOCK_DELAY_SECS) return 'timelockInvalid';
    return { kind: 'timelocked', delaySecs: view.delaySecs };
  }
  if (timelockAddress(program).equals(authority)) return timelock ? 'timelockInvalid' : 'timelockMissing';
  return { kind: 'author', key: authority };
}

/**
 * `bordrless_hook::authority::classify`: the class of `programId` from its account, its ProgramData
 * (for an upgradeable-loader program) and its `Timelock` (when it has one), or why it can't be
 * classed. Loader 2: immutable; loader v4: immutable when finalized, else by its key; another owner:
 * the author's.
 */
export function classifyProgram(programId: PublicKey, program: Raw, programdata: Raw | null, timelock: Raw | null): AuthorityClass | ClassError {
  if (program.owner.equals(BPF_LOADER_2)) return { kind: 'immutable' };
  if (program.owner.equals(LOADER_V4)) {
    if (program.data.length < 48) return { kind: 'author', key: null };
    if (program.data.readBigUInt64LE(40) === 2n) return { kind: 'immutable' };
    const key = new PublicKey(program.data.subarray(8, 40));
    return HOOK_UPGRADE_AUTHORITIES.includes(key.toBase58()) ? { kind: 'managed', key } : { kind: 'author', key };
  }
  if (!program.owner.equals(BPF_LOADER_UPGRADEABLE)) return { kind: 'author', key: null };
  const pdKey = programDataAddress(programId);
  if (program.data.length < 36 || program.data.readUInt32LE(0) !== 2 || !program.data.subarray(4, 36).equals(pdKey.toBuffer())) return 'wrongProgramData';
  if (!programdata || !programdata.owner.equals(BPF_LOADER_UPGRADEABLE)) return 'wrongProgramData';
  if (programdata.data.length < 13 || programdata.data.readUInt32LE(0) !== 3) return 'wrongProgramData';
  const header = parseProgramData(programdata.data);
  if (!header) return { kind: 'author', key: null };
  return classOfAuthority(programId, pdKey, header.authority, timelock ? { key: timelockAddress(programId), account: timelock } : null);
}

/** Whether a class keeps code fixed without Bordrless or a public delay: what the launchpad takes. */
export const classBounded = (c: AuthorityClass | ClassError): boolean => typeof c !== 'string' && c.kind !== 'author';

/** The length of `code` without its trailing zero bytes. */
export function trimmedLength(code: Uint8Array): number {
  let end = code.length;
  while (end > 0 && code[end - 1] === 0) end -= 1;
  return end;
}

/** `solana-verify get-executable-hash` of a program's code (hex): sha256 without its trailing zeros. */
export const executableHash = (code: Uint8Array): string => createHash('sha256').update(code.subarray(0, trimmedLength(code))).digest('hex');

/** The code of an executable account's data for its loader (after the ProgramData's header, the loader-v4 header, or all of it): null for another owner. */
export function codeOf(owner: PublicKey, data: Buffer): Buffer | null {
  if (owner.equals(BPF_LOADER_UPGRADEABLE)) return data.subarray(PROGRAMDATA_HEADER_LEN);
  if (owner.equals(LOADER_V4)) return data.subarray(LOADER_V4_HEADER_LEN);
  if (owner.equals(BPF_LOADER_2)) return data;
  return null;
}
