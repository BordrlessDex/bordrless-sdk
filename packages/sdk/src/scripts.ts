/**
 * Approvals and script companions (2026-10-12; `programs/bordrless_companion/src/instructions/
 * approval.rs` and `script.rs`): a builder's own program, the script, decides what a companion's
 * pot does. The companion program runs a script whose code Bordrless approved on chain (the
 * Workshop lane), or, once the companion upgrade of 2026-10-12 evening is live on the cluster, a
 * script that is immutable, which needs no approval (the self-serve lane: nobody can change its
 * code, the rule the launchpad applies to a hook).
 *
 * - `companion.approve(authority, program, kind, codeHash, author)` (the companion program's
 *   upgrade authority, or the script approver): `program`'s code approved as a token hook the site
 *   offers beside a companion (`APPROVAL_KINDS.tokenHook`, read off chain) or as a companion script
 *   (`APPROVAL_KINDS.script`), bound to its executable hash, which the program recomputes from the
 *   ProgramData. Only a program nobody but Bordrless can change is approved (immutable,
 *   upgradeable only by Bordrless's keys, or behind a hook timelock), and an upgrade voids its
 *   approval until the new code is approved. `companion.revokeApproval` revokes one.
 * - `companion.createScript(payer, mint, args, scriptExtra)` (after `create`, before `launch`, the
 *   mint signing): the pot's part of every fee claim beside the split, the script and how often it
 *   may step (`Companion.mode` becomes `MODE_SCRIPT`). With `args.stateLen` above 0 the companion
 *   makes the script's state (`scriptStateAddress(mint)`: that many bytes, zeroed, owned by the
 *   script, the payer paying its rent). The script's `companion_init` then runs once with
 *   `[creator (signer, writable), mint, state (writable; the system program's id, read-only,
 *   without a state), system program]`, then `scriptExtra`.
 * - `companion.claimFeesScript(cranker, mint, author)`: a script companion's fee claim first pays
 *   the script's author `SCRIPT_LIMITS.authorShareBps` of what it took from the launch, as SOL
 *   (`scriptClaimAuthor` says whether the author's wallet goes along), then splits the rest, the
 *   pot's part to `Companion.pendingPot`. An immutable script has no author: no share.
 * - `companion.scriptStep(cranker, keys, scriptProgram, extra)` (anyone, from a minute after the
 *   launch, once an interval (`scriptDue`), while the approval holds for the code the script runs,
 *   or the script is immutable): the script's `companion_step` with `[creator (signer, writable),
 *   mint, launch, companion, pool, state (writable; the system program's id, read-only, without a
 *   state)]`, then `extra`. The companion then checks that the script spent at most the pot and
 *   left the dev bag, the creator address's lamports and its custody as they were, and pays the
 *   sender `SCRIPT_LIMITS.bounty` from the pot.
 * - No signature reaches a script but the creator address's: every account after those it is
 *   handed is forwarded with its writability and never as a signer, and the payer and the sender
 *   are never passed to it.
 * - `inspectScriptProgram(connection, program)` reads what the chain would say of a script before
 *   anything is signed: deployed, immutable or approved, which lane, and why not in one sentence.
 *
 * Held to the program's client by `vectors/scripts.json` (bordrless-programs' `script_vectors`).
 *
 * The payout path (docs/loss-cover.md §1, live with Lossback): a script made with
 * `companion.createScriptV2` (companion.ts; its terms at `payoutTermsAddress`, addresses.ts) may
 * answer a `PayoutAnswer` in its return data (up to 16 `{ account, lamports, tag }` entries naming
 * holdings among the step's extra accounts), which the companion pays from the pot within the terms
 * and records through the hook's `record_payout`, signed by `PAYOUT_AUTHORITY`. The encoders and
 * decoders (`encodePayoutAnswer`, `encodeWalletPayoutAnswer`, `decodePayoutTerms`, `PAYOUT_LIMITS`)
 * are lossCover.ts's, held to `vectors/payouts.json`; `companion.payoutAccounts` is what such a
 * step carries first.
 */
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { scriptInitDataLength } from '@bordrless/shared';
import { BPF_LOADER_UPGRADEABLE, COMPANION_PROGRAM, approvalAddress, programDataAddress } from './addresses.ts';
import { PROGRAMDATA_HEADER_LEN, executableHash, parseProgramData } from './authority.ts';
import { CODERS } from './coders.ts';
import type { Companion, CompanionSplit } from './companion.ts';
import { programUpgradeInfoOf, type ProgramUpgradeInfo } from './inspect.ts';

/** `Companion.mode` of a script companion (`MODE_SCRIPT`; a classic companion's is 0, a Snowball's 1). */
export const MODE_SCRIPT = 2;

/** What an approval is of (`Approval.kind`): a token hook the site offers beside a companion (read off chain only), or a companion script (`createScript`, `scriptStep`). */
export const APPROVAL_KINDS = { tokenHook: 0, script: 1 } as const;

/**
 * The program's script bounds (`constants.rs`): steps 10 seconds to a day apart, at most 512 bytes
 * handed to `companion_init`, at most 10,240 bytes of state (what one instruction may allocate),
 * the sender's bounty from the pot (lamports, paid when the pot holds it), no step in the launch's
 * first minute, and the author's share of what each fee claim takes from the launch (none when the
 * author is the launcher, or the script is immutable and has none).
 */
export const SCRIPT_LIMITS = {
  minInterval: 10,
  maxInterval: 86_400,
  maxInitLen: 512,
  maxStateLen: 10_240,
  bounty: 20_000n,
  afterLaunchSecs: 60,
  authorShareBps: 5_000,
} as const;

/** The script's two instructions as Anchor names them: the first 8 bytes of `sha256("global:companion_init")`, called once by `create_script` with `mint ‖ init_data` (Borsh `Vec<u8>`)… */
export const COMPANION_INIT_DISCRIMINATOR = Buffer.from([0x76, 0xa1, 0xbb, 0xb4, 0x57, 0x56, 0xdc, 0x88]);
/** …and of `sha256("global:companion_step")`, called by every `script_step` with `mint`. */
export const COMPANION_STEP_DISCRIMINATOR = Buffer.from([0x5e, 0x15, 0xaa, 0xa1, 0xf6, 0x6e, 0x15, 0x28]);

/** `create_script`'s arguments. */
export interface ScriptArgs {
  /** Every fee claim's split besides the pot: with `potBps` the four sum to 10,000. Replaces `create`'s. */
  split: CompanionSplit;
  /** The pot's part of every fee claim: what the script spends. */
  potBps: number;
  /** The script: a program with a current approval of kind `APPROVAL_KINDS.script`, or an immutable program, which needs none (once the companion upgrade of 2026-10-12 evening is live). */
  program: PublicKey;
  /** The least time between steps, seconds: 10 to a day. */
  interval: number;
  /** The size of the script's state the companion makes (`scriptStateAddress(mint)`, owned by the script, the payer paying its rent): 0 for none, at most `SCRIPT_LIMITS.maxStateLen` bytes. */
  stateLen: number;
  /** Handed to the script's `companion_init`: at most `SCRIPT_LIMITS.maxInitLen` bytes (`scriptInitDataBytes` reads the API's hex or base64 form). */
  initData: Uint8Array;
}

/**
 * Bordrless's approval of a program's code, `PDA(["approval", program])` (`Approval`), written only
 * by the companion program's upgrade authority or the script approver. It counts only while the
 * program runs the approved code: its ProgramData's slot unchanged since, or the code hashed again
 * to `codeHash`.
 */
export interface Approval {
  version: number;
  bump: number;
  program: PublicKey;
  /** `APPROVAL_KINDS.tokenHook` (0) or `APPROVAL_KINDS.script` (1). */
  kind: number;
  /** `solana-verify`'s executable hash of the approved code (hex). */
  codeHash: string;
  approvedAt: number;
  revoked: boolean;
  /** Who last wrote it: the upgrade authority or the approver that approved or revoked it. */
  updatedBy: PublicKey;
  /** The program's ProgramData slot when approved: while it is unchanged the code is the approved code. */
  programdataSlot: bigint;
  /** Who wrote the program (a script's author earns the author's share); null for none (the default key). */
  author: PublicKey | null;
}

/** A script companion's script, `PDA(["script", mint])` (`Script`), fixed at `createScript`. The pot itself is `Companion.pendingPot`. */
export interface Script {
  version: number;
  bump: number;
  mint: PublicKey;
  /** The script: an approved or immutable program, called with the creator address signing. */
  program: PublicKey;
  /** The least time between two steps, seconds. */
  interval: number;
  /** When it last stepped (0: never). */
  lastAt: number;
  /** Steps run so far. */
  steps: bigint;
  createdAt: number;
  /** The script's author, copied from its approval at `createScript`; null for none (the default key: an immutable script, or an approval naming nobody). */
  author: PublicKey | null;
  /** What the author has been paid so far, lamports. */
  authorPaid: bigint;
  /** The size of the script's state (`scriptStateAddress(mint)`), which every call hands the script; 0: no state, the system program's id in its place. */
  stateLen: number;
}

const big = (v: unknown): bigint => BigInt(String(v));
const num = (v: unknown): number => Number(String(v));
const hex = (v: unknown): string => Buffer.from(v as ArrayLike<number>).toString('hex');
const keyOrNull = (k: PublicKey): PublicKey | null => (k.equals(PublicKey.default) ? null : k);

/** An `Approval` account, by its IDL name `approval`. */
export function decodeApproval(data: Buffer): Approval {
  const r = CODERS.companion.accounts.decode('approval', data) as Record<string, unknown>;
  return {
    version: num(r.version),
    bump: num(r.bump),
    program: r.program as PublicKey,
    kind: num(r.kind),
    codeHash: hex(r.codeHash),
    approvedAt: num(r.approvedAt),
    revoked: Boolean(r.revoked),
    updatedBy: r.updatedBy as PublicKey,
    programdataSlot: big(r.programdataSlot),
    author: keyOrNull(r.author as PublicKey),
  };
}

/** A `Script` account, by its IDL name `script`. */
export function decodeScript(data: Buffer): Script {
  const r = CODERS.companion.accounts.decode('script', data) as Record<string, unknown>;
  return {
    version: num(r.version),
    bump: num(r.bump),
    mint: r.mint as PublicKey,
    program: r.program as PublicKey,
    interval: num(r.interval),
    lastAt: num(r.lastAt),
    steps: big(r.steps),
    createdAt: num(r.createdAt),
    author: keyOrNull(r.author as PublicKey),
    authorPaid: big(r.authorPaid),
    stateLen: num(r.stateLen),
  };
}

/**
 * The author's wallet a fee claim of this script companion must pass (`companion.claimFeesScript`):
 * the script's author, unless it has none or the author is the launch's beneficiary (who gets no
 * extra share); null then. A claim that leaves out a wallet it pays is refused (`MissingAccount`).
 */
export const scriptClaimAuthor = (script: Pick<Script, 'author'>, companion: Pick<Companion, 'beneficiary'>): PublicKey | null =>
  script.author && !script.author.equals(companion.beneficiary) ? script.author : null;

// ---- stepping ---------------------------------------------------------------------------------------

/** When a script may next step: a minute after the launch at the earliest (`SCRIPT_LIMITS.afterLaunchSecs`), then its interval after its last step (`ScriptNotDue` before that). */
export const scriptNextStepAt = (c: Pick<Companion, 'launchedAt'>, s: Pick<Script, 'lastAt' | 'interval'>): number => Math.max(c.launchedAt + SCRIPT_LIMITS.afterLaunchSecs, s.lastAt + s.interval);

/** Whether `scriptStep` would be taken at `now` (unix seconds): the companion launched and the script's next step is due. */
export const scriptDue = (c: Pick<Companion, 'launched' | 'launchedAt'>, s: Pick<Script, 'lastAt' | 'interval'>, now: number): boolean => c.launched && now >= scriptNextStepAt(c, s);

/**
 * A script's init data from the launch request's form (`ScriptRequest.initData`): hex (an even
 * number of hex digits, `0x` or not) or base64, the empty string for none; hex is tried first.
 * Throws for a text that is neither, or more than `SCRIPT_LIMITS.maxInitLen` bytes.
 */
export function scriptInitDataBytes(raw: string): Uint8Array {
  const expected = scriptInitDataLength(raw);
  if (expected === null) throw new Error('a script’s init data is hex or base64');
  if (raw === '') return new Uint8Array(0);
  const isHex = /^(?:0x)?(?:[0-9a-fA-F]{2})*$/.test(raw);
  const bytes = isHex ? Buffer.from(raw.startsWith('0x') ? raw.slice(2) : raw, 'hex') : Buffer.from(raw, 'base64');
  if (bytes.length !== expected) throw new Error('a script’s init data is hex or base64');
  if (bytes.length > SCRIPT_LIMITS.maxInitLen) throw new Error(`a script’s init data is at most ${SCRIPT_LIMITS.maxInitLen} bytes`);
  return Uint8Array.from(bytes);
}

// ---- what the chain says of a script program ------------------------------------------------------

/** What `scriptProgramStatusOf` and `inspectScriptProgram` found about a program a launch would run as its script. */
export interface ScriptProgramStatus {
  program: PublicKey;
  /** Deployed, and who can upgrade it (`programUpgradeInfoOf`). */
  info: ProgramUpgradeInfo;
  /** Its upgrade authority given up (an upgradeable-loader program with none): the companion runs it with no approval, once the companion upgrade of 2026-10-12 evening is live. */
  immutable: boolean;
  /** The companion program's approval of it, decoded; null for none (or an account that is not one). */
  approval: Approval | null;
  /** `solana-verify`'s executable hash of the code on chain (hex), when the whole ProgramData was read; null otherwise. */
  codeHash: string | null;
  /**
   * Whether the approval holds for the code the program runs now, as `create_script` and
   * `script_step` check it: of kind script, not revoked, its ProgramData slot unchanged since the
   * approval, or the code hashed again to the approved hash. Null when the slot moved and the code
   * was not read (`inspectScriptProgram` reads it then).
   */
  approvalHolds: boolean | null;
  /** The author the approval names (paid the author's share by every fee claim); null without one. */
  author: PublicKey | null;
  /** Which lane the program launches on: the Workshop's (approved), the self-serve lane (immutable, unreviewed), or none yet. */
  lane: 'workshop' | 'self-serve' | null;
  /** Why the companion would refuse it as a script, one sentence each; empty when it would not. */
  problems: string[];
}

/** The `Approval` an account holds for `program`, decoded; null for none, another owner's, another program's, or bytes that are not one. */
export function approvalOf(program: PublicKey, info: Pick<AccountInfo<Buffer>, 'owner' | 'data'> | null): Approval | null {
  if (!info || !info.owner.equals(COMPANION_PROGRAM)) return null;
  try {
    const a = decodeApproval(info.data);
    return a.program.equals(program) ? a : null;
  } catch {
    return null;
  }
}

/**
 * The pure part of `inspectScriptProgram`: from the program account, its ProgramData (the whole
 * account, or its first `PROGRAMDATA_HEADER_LEN` bytes when only the header was read) and the
 * account at `approvalAddress(program)`.
 */
export function scriptProgramStatusOf(program: PublicKey, programInfo: AccountInfo<Buffer> | null, programDataInfo: AccountInfo<Buffer> | null, approvalInfo: AccountInfo<Buffer> | null): ScriptProgramStatus {
  const info = programUpgradeInfoOf(programInfo, programDataInfo, program);
  const approval = approvalOf(program, approvalInfo);
  const header = programDataInfo && programDataInfo.owner.equals(BPF_LOADER_UPGRADEABLE) ? parseProgramData(programDataInfo.data) : null;
  const codeHash = header && programDataInfo && programDataInfo.data.length > PROGRAMDATA_HEADER_LEN ? executableHash(programDataInfo.data.subarray(PROGRAMDATA_HEADER_LEN)) : null;
  const out: ScriptProgramStatus = { program, info, immutable: false, approval, codeHash, approvalHolds: null, author: null, lane: null, problems: [] };
  if (!info.executable) {
    out.problems.push('The script program is not deployed on this cluster.');
    return out;
  }
  if (!header) {
    out.problems.push('The script program is not deployed through the upgradeable loader: the companion program reads its ProgramData.');
    return out;
  }
  if (header.authority === null) {
    out.immutable = true;
    out.lane = 'self-serve';
    return out;
  }
  if (!approval) {
    out.approvalHolds = false;
    out.problems.push(`Bordrless has not approved this script’s code: submit it to the Workshop, or make it immutable (solana program set-upgrade-authority ${program.toBase58()} --final) to launch with it unreviewed.`);
    return out;
  }
  if (approval.revoked) {
    out.approvalHolds = false;
    out.problems.push('Bordrless revoked this script’s approval: no launch takes it and its steps stop.');
    return out;
  }
  if (approval.kind !== APPROVAL_KINDS.script) {
    out.approvalHolds = false;
    out.problems.push('This program is approved as a token hook, not as a companion script.');
    return out;
  }
  if (header.slot === approval.programdataSlot) out.approvalHolds = true;
  else if (codeHash !== null) out.approvalHolds = codeHash === approval.codeHash;
  if (out.approvalHolds === false) out.problems.push('The script’s code changed since Bordrless approved it: the approval does not hold until the new code is approved.');
  if (out.approvalHolds) {
    out.author = approval.author;
    out.lane = 'workshop';
  }
  return out;
}

/**
 * What the chain says of `program` as a companion's script, before anything is signed: deployed,
 * immutable (the self-serve lane) or approved (the Workshop's), as `create_script` and
 * `script_step` check it (`script_approval`). Two round trips at most: the program, its ProgramData's
 * header and its approval; then the whole ProgramData, only when the approval's slot moved (an
 * upgrade, or anyone's `ExtendProgram`) and the code must be hashed again.
 */
export async function inspectScriptProgram(connection: Connection, program: PublicKey): Promise<ScriptProgramStatus> {
  const programData = programDataAddress(program);
  const [p, header, a] = await Promise.all([
    connection.getAccountInfo(program, 'confirmed'),
    connection.getAccountInfo(programData, { commitment: 'confirmed', dataSlice: { offset: 0, length: PROGRAMDATA_HEADER_LEN } }),
    connection.getAccountInfo(approvalAddress(program), 'confirmed'),
  ]);
  const first = scriptProgramStatusOf(program, p, header, a);
  if (first.approvalHolds !== null || !first.approval) return first;
  const whole = await connection.getAccountInfo(programData, 'confirmed');
  return scriptProgramStatusOf(program, p, whole, a);
}
