/**
 * Risk labels for terminals (phase 3a, bordrless-programs docs/phase3a.md §7): one label of "who can
 * change this hook's code, and what Bordrless says of it", the same words on every surface.
 *
 * `hookRiskLabel(connection, program)` reads, in two `getMultipleAccounts`: its `Timelock`, the
 * companion's `HookStatus` and `HookAttestation` of it in full, and the headers (48 bytes) of the
 * program, its ProgramData and `hook_timelock`'s own ProgramData. The executable hash (a download of
 * the code) is computed only when an audit or an attestation needs comparing and the slot moved
 * (`hash: 'auto'`), and cached by deploy slot. `riskLabelOf`
 * is the pure part, held to `vectors/risk-labels.json`, which bordrless-programs renders from its
 * Rust reference (`programs/tests/src/risk.rs`, over `bordrless_hook::authority`).
 *
 * Provenance comes only from Studio's attestation, never from the upgrade key alone: anyone can hand
 * a program to Studio's key.
 *
 * Callees (independent audit X5): a hook's behaviour is also that of any program it can call. Given
 * the mint (`opts.mint`), `hookRiskLabel` reads the hook's registry for it and classes every
 * executable account the registry names by key, other than the hook itself and Bordrless's own
 * programs (`calleeExempt`). The label's class is then the weakest of the hook's and its callees'
 * (author < timelocked < managed < immutable: who can change what runs, and how fast), and its
 * words name the weakest callee. This part has no Rust vector: the Rust reference labels one
 * program; `riskLabelOf(..., callees)` is unit-tested here.
 */
import { PublicKey, type Connection } from '@solana/web3.js';
import { PROGRAM_IDS } from '@bordrless/shared';
import { BPF_LOADER_UPGRADEABLE, COMPANION_PROGRAM, HOOK_TIMELOCK_PROGRAM, HALF_LIFE_PROGRAM, KIT_PROGRAM, LOTTERY_HOOK_PROGRAM, TAX_HOOK_PROGRAM, hookStatusAddress, programDataAddress, registryAddress } from './addresses.ts';
import { BPF_LOADER_2, LOADER_V4, classifyProgram, codeOf, decodeTimelock, executableHash, parseProgramData, timelockAddress, type AuthorityClass } from './authority.ts';
import { attestationAddress } from './companion.ts';
import { decodeHookAccountList } from './hooks.ts';

/** An account as read (null: it does not exist). */
export interface RawAccount {
  owner: PublicKey;
  data: Buffer;
  executable: boolean;
}

/** What a label is computed from. */
export interface RiskAccounts {
  programId: PublicKey;
  program: RawAccount | null;
  programdata: RawAccount | null;
  timelock: RawAccount | null;
  /** `hook_timelock`'s own ProgramData: whether the timelock itself can still be changed by Bordrless. */
  timelockProgramdata: RawAccount | null;
  /** The companion's `HookStatus` of the program. */
  status: RawAccount | null;
  /** The companion's `HookAttestation` of the program. */
  attestation: RawAccount | null;
}

export interface HookRiskLabel {
  program: PublicKey;
  class: 'immutable' | 'timelocked' | 'managed' | 'author' | 'missing';
  /** Timelocked: the delay, and the author (who may propose new code). */
  delaySecs: number | null;
  author: PublicKey | null;
  /** A proposal waiting: its code's hash (hex), when it can be executed, its buffer. */
  pending: { hash: string; eta: number; buffer: PublicKey } | null;
  /** Timelocked: whether `hook_timelock` itself can still be upgraded by Bordrless (until its audit). */
  timelockProgramUpgradeable: boolean | null;
  /** `HookStatus.audited`, tied to the code: current while its recorded hash is the code's. */
  audited: 'current' | 'stale' | false;
  /** `HookStatus.blocked` (a companion game's kill switch). */
  blocked: boolean;
  /** The companion's pot cap for this program's games and strategies; null: audited, uncapped. */
  potCap: bigint | null;
  provenance: 'protocol' | 'studio' | 'unattested' | 'none';
  /** Studio's attestation, when there is one. */
  studio: { buildHash: string; simPass: boolean; cutMaxBps: number; current: boolean } | null;
  severity: 'low' | 'medium' | 'high';
  /** One sentence. */
  words: string;
  /** The programs this hook can call (its registry's executable fixed keys, Bordrless's own left out), each classed; empty when not read. */
  callees: RiskCallee[];
}

/** A program a hook can call, as its registry names it, and who can change that program. */
export interface RiskCallee {
  program: PublicKey;
  class: HookRiskLabel['class'];
}

/** Who can change what runs, weakest first: an owner at any time, an author after a public delay, Bordrless, nobody. */
const CLASS_RANK: Record<HookRiskLabel['class'], number> = { missing: -1, author: 0, timelocked: 1, managed: 2, immutable: 3 };
/** How a callee's class reads in a label. */
const CALLEE_WORDS: Record<Exclude<HookRiskLabel['class'], 'missing'>, string> = {
  author: 'whose owner can change it at any time',
  timelocked: 'whose author can change it after a public delay',
  managed: 'which Bordrless can change',
  immutable: 'which nobody can change',
};
const SEVERITY_RANK = { low: 0, medium: 1, high: 2 } as const;

/** Programs a registry may name without lowering a label: the hook itself, Bordrless's programs, and the runtime's (native and SPL). */
export function calleeExempt(hook: PublicKey, program: PublicKey): boolean {
  if (program.equals(hook)) return true;
  const k = program.toBase58();
  return (Object.values(PROGRAM_IDS) as string[]).includes(k) || RUNTIME_PROGRAMS.has(k);
}
const RUNTIME_PROGRAMS = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'ComputeBudget111111111111111111111111111111',
  'AddressLookupTab1e1111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
  'LoaderV411111111111111111111111111111111111',
  'NativeLoader1111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'KeccakSecp256k11111111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111',
]);

/** Bordrless's own hook programs: their provenance is the protocol. */
export const BORDRLESS_HOOKS: readonly PublicKey[] = [LOTTERY_HOOK_PROGRAM, TAX_HOOK_PROGRAM, HALF_LIFE_PROGRAM, KIT_PROGRAM];
/** The companion's pot cap of a program it has said nothing of (10 SOL). */
export const DEFAULT_POT_CAP = 10_000_000_000n;

/** `HookStatus` offsets: audited, pot cap, blocked, the audited hash (phase 3a, in what was `reserved`). */
const STATUS = { audited: 42, potCap: 43, blocked: 51, auditedHash: 92, len: 124 } as const;
/** `HookAttestation` offsets. */
const ATTEST = { buildHash: 42, simPass: 128, cutMaxBps: 129, programdataSlot: 135, revoked: 183, len: 224 } as const;

/** `secs` since the epoch as `YYYY-MM-DDTHH:MM:SSZ`. */
export const isoUtc = (secs: number): string => `${new Date(secs * 1000).toISOString().slice(0, 19)}Z`;
/** "N days" (or hours, for a delay that is not a whole number of days). */
export function delayWords(secs: number): string {
  if (secs % 86_400 === 0) {
    const d = secs / 86_400;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  const h = Math.floor(secs / 3_600);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/**
 * The label of `a.programId` at `now` (unix seconds), `executableHash` its code's hash (hex) when the
 * caller computed it (`executableHash(codeOf(...))`): needed to tell an audit current, and an
 * attestation current once the ProgramData's slot has moved.
 */
export function riskLabelOf(a: RiskAccounts, now: number, executableHashHex?: string | null, callees: readonly RiskCallee[] = []): HookRiskLabel {
  const label: HookRiskLabel = {
    program: a.programId,
    class: 'missing',
    delaySecs: null,
    author: null,
    pending: null,
    timelockProgramUpgradeable: null,
    audited: false,
    blocked: false,
    potCap: DEFAULT_POT_CAP,
    provenance: 'none',
    studio: null,
    severity: 'high',
    words: '',
    callees: [...callees],
  };
  const hash = executableHashHex ?? null;
  let auditedHash: string | null = null;
  const st = a.status && a.status.data.length >= STATUS.len ? a.status.data : null;
  if (st) {
    const audited = st[STATUS.audited] !== 0;
    label.blocked = st[STATUS.blocked] !== 0;
    if (audited) {
      label.potCap = null;
      auditedHash = st.subarray(STATUS.auditedHash, STATUS.auditedHash + 32).toString('hex');
    } else {
      const cap = st.readBigUInt64LE(STATUS.potCap);
      label.potCap = cap < DEFAULT_POT_CAP ? cap : DEFAULT_POT_CAP;
    }
  }
  // Gone, or an upgradeable-loader program whose ProgramData was closed: it can't run and nobody can change it.
  if (!a.program || !a.program.executable || (a.program.owner.equals(BPF_LOADER_UPGRADEABLE) && !a.programdata)) {
    label.words = "This hook's program is gone: every transfer fails.";
    return label;
  }
  const c = classifyProgram(a.programId, a.program, a.programdata, a.timelock);
  // Handed to its timelock's address with no `Timelock` there: nobody can sign for it today, but the
  // launchpad (`HookTimelockInvalid`) and the companion refuse it (independent audit, finding 8):
  // class `author`, with its own words.
  const frozen = (c === 'timelockMissing' || c === 'timelockInvalid') && (!a.timelock || !a.timelock.owner.equals(HOOK_TIMELOCK_PROGRAM));
  // A ProgramData that is not the program's, or a forged or missing timelock: nobody vouches for who upgrades it.
  const cls: AuthorityClass = typeof c === 'string' ? { kind: 'author', key: null } : c;
  label.class = cls.kind;
  if (cls.kind === 'timelocked') {
    label.delaySecs = cls.delaySecs;
    const view = a.timelock ? decodeTimelock(a.timelock.data) : null;
    if (view) {
      label.author = view.author;
      label.pending = view.pending ? { hash: view.pending.hash, eta: view.pending.eta, buffer: view.pending.buffer } : null;
    }
    const pd = a.timelockProgramdata && a.timelockProgramdata.owner.equals(BPF_LOADER_UPGRADEABLE) ? parseProgramData(a.timelockProgramdata.data) : null;
    label.timelockProgramUpgradeable = pd === null ? true : pd.authority !== null;
  }
  // As the companion counts it: only of code that can't change behind it (immutable, or Bordrless's to change).
  const fixed = cls.kind === 'immutable' || cls.kind === 'managed';
  if (auditedHash !== null) label.audited = fixed && auditedHash !== '00'.repeat(32) && hash === auditedHash ? 'current' : 'stale';
  const pdSlot = a.programdata && a.programdata.owner.equals(BPF_LOADER_UPGRADEABLE) ? parseProgramData(a.programdata.data)?.slot ?? null : null;
  let attested = false;
  const at = a.attestation && a.attestation.data.length >= ATTEST.len ? a.attestation.data : null;
  if (at) {
    const build = at.subarray(ATTEST.buildHash, ATTEST.buildHash + 32).toString('hex');
    const simPass = at[ATTEST.simPass] !== 0;
    const cut = at.readUInt16LE(ATTEST.cutMaxBps);
    const slot = at.readBigUInt64LE(ATTEST.programdataSlot);
    const revoked = at[ATTEST.revoked] !== 0;
    // As the companion reads it: other code proposed in its timelock makes it not current.
    const otherCodePending = label.pending !== null && label.pending.hash !== build;
    const current = !revoked && simPass && !otherCodePending && (pdSlot === slot || hash === build);
    attested = current;
    label.studio = { buildHash: build, simPass, cutMaxBps: cut, current };
  }
  label.provenance = attested ? 'studio' : BORDRLESS_HOOKS.some((p) => p.equals(a.programId)) ? 'protocol' : cls.kind === 'managed' ? 'unattested' : 'none';
  const [severity, words] = ((): [HookRiskLabel['severity'], string] => {
    if (label.blocked) return ['high', "Bordrless blocked this game's code: its pot goes to buyback and burn."];
    if (frozen) return ['high', 'Bordrless refuses this hook: its upgrade key was handed to a timelock address that was never set up.'];
    if (label.class === 'author') return ['high', 'Its owner can change this code at any time.'];
    if (label.class === 'timelocked' && label.pending) {
      const when = now >= label.pending.eta ? 'executable now' : `live from ${isoUtc(label.pending.eta)}`;
      return ['high', `Its author has proposed new code (hash ${label.pending.hash.slice(0, 8)}…), ${when}.`];
    }
    if (label.audited === 'current') return ['low', 'Audited.'];
    if (label.class === 'timelocked') {
      // Independent audit X5: a notice period says nothing of what the code does, so the words say whether anyone checked it.
      const w = `Its author can change this code with ${delayWords(label.delaySecs ?? 0)} of public notice. ${attested ? 'Checked automatically by Studio, not audited.' : "Bordrless hasn't checked it."}`;
      return ['medium', label.timelockProgramUpgradeable ? `${w} The timelock itself can still be changed by Bordrless.` : w];
    }
    if (label.class === 'managed') {
      if (label.provenance === 'studio') return ['medium', 'Built and checked automatically by Bordrless Studio, not audited. Bordrless can change it.'];
      if (label.provenance === 'protocol') return ['medium', "Bordrless's own code, not audited here. Bordrless can change it."];
      return ['medium', 'Upgradeable by a Bordrless key; not built by Studio.'];
    }
    if (attested) return ['medium', 'Nobody can change this code. Checked automatically by Studio, not audited.'];
    return ['medium', "Nobody can change this code. Bordrless hasn't checked it."];
  })();
  label.severity = severity;
  label.words = words;
  // The weakest program it can call (a gone callee can't change: it only fails the calls).
  const weakest = callees.filter((x) => x.class !== 'missing').sort((x, y) => CLASS_RANK[x.class] - CLASS_RANK[y.class])[0];
  if (weakest && weakest.class !== 'immutable' && weakest.class !== 'missing') {
    if (CLASS_RANK[weakest.class] < CLASS_RANK[label.class]) label.class = weakest.class;
    const calleeSeverity: HookRiskLabel['severity'] = weakest.class === 'author' ? 'high' : 'medium';
    if (SEVERITY_RANK[calleeSeverity] > SEVERITY_RANK[label.severity]) label.severity = calleeSeverity;
    const short = weakest.program.toBase58().slice(0, 8);
    label.words = `${label.words} It can call ${short}…, ${CALLEE_WORDS[weakest.class]}.`;
  }
  return label;
}

/** The class of a callee from its accounts, as a hook's (a frozen one, refused by Bordrless, reads `author`). */
export function calleeClassOf(program: PublicKey, account: RawAccount | null, programdata: RawAccount | null, timelock: RawAccount | null): HookRiskLabel['class'] {
  if (!account || !account.executable || (account.owner.equals(BPF_LOADER_UPGRADEABLE) && !programdata)) return 'missing';
  const c = classifyProgram(program, account, programdata, timelock);
  return typeof c === 'string' ? 'author' : c.kind;
}

/**
 * The programs `hook` can call through its registry for `mint`: every fixed key (`AccountSource`
 * `key`; a PDA is never a program) that is an executable account and not exempt (`calleeExempt`),
 * classed. Two `getMultipleAccounts` (headers only) after the registry's.
 */
export async function hookCallees(connection: Connection, hook: PublicKey, mint: PublicKey): Promise<RiskCallee[]> {
  const reg = await connection.getAccountInfo(registryAddress(hook, mint), 'confirmed');
  if (!reg || !reg.owner.equals(hook)) return [];
  const list = decodeHookAccountList(Buffer.from(reg.data));
  if (!list) return [];
  const keys: PublicKey[] = [];
  for (const e of list.accounts) if (e.source.kind === 'key' && !calleeExempt(hook, e.source.key) && !keys.some((k) => k.equals((e.source as { key: PublicKey }).key))) keys.push(e.source.key);
  if (keys.length === 0) return [];
  const raw = (x: { owner: PublicKey; data: Buffer | Uint8Array; executable: boolean } | null | undefined): RawAccount | null => (x ? { owner: x.owner, data: Buffer.from(x.data), executable: x.executable } : null);
  const heads = await connection.getMultipleAccountsInfo(keys, { commitment: 'confirmed', dataSlice: HEADER_SLICE });
  const programs = keys.filter((_, i) => heads[i]?.executable === true);
  if (programs.length === 0) return [];
  const second = await Promise.all([
    connection.getMultipleAccountsInfo(programs.map((p) => programDataAddress(p)), { commitment: 'confirmed', dataSlice: HEADER_SLICE }),
    connection.getMultipleAccountsInfo(programs.map((p) => timelockAddress(p)), 'confirmed'),
  ]);
  return programs.map((p, i) => ({ program: p, class: calleeClassOf(p, raw(heads[keys.indexOf(p)]), raw(second[0][i]), raw(second[1][i])) }));
}

/** The code hashes computed already, by program and the slot its code was deployed at (one download per deploy). */
const HASHES = new Map<string, string>();
/** Bytes of every loader header a label reads (v3 program 36, ProgramData 45, loader v4 48). */
const HEADER_SLICE = { offset: 0, length: 48 } as const;

/**
 * The label of `program` read from the chain: two `getMultipleAccounts` (the small accounts in full,
 * then the program, its ProgramData and `hook_timelock`'s ProgramData as their first 48 bytes), plus
 * a download of the code only when a hash must be compared: `hash: 'auto'` only when an audit or an
 * attestation needs it and the slot moved (cached by program and deploy slot, for loader v3 and v4),
 * `'always'`, or `'never'`.
 */
export async function hookRiskLabel(connection: Connection, program: PublicKey, opts: { hash?: 'auto' | 'always' | 'never'; now?: number; mint?: PublicKey } = {}): Promise<HookRiskLabel> {
  const small = [timelockAddress(program), hookStatusAddress(program), attestationAddress(program)];
  const headers = [program, programDataAddress(program), programDataAddress(HOOK_TIMELOCK_PROGRAM)];
  const [full, sliced] = await Promise.all([
    connection.getMultipleAccountsInfo(small, 'confirmed'),
    connection.getMultipleAccountsInfo(headers, { commitment: 'confirmed', dataSlice: HEADER_SLICE }),
  ]);
  const raw = (x: { owner: PublicKey; data: Buffer | Uint8Array; executable: boolean } | null | undefined): RawAccount | null =>
    x ? { owner: x.owner, data: Buffer.from(x.data), executable: x.executable } : null;
  const accounts: RiskAccounts = {
    programId: program,
    program: raw(sliced[0]),
    programdata: raw(sliced[1]),
    timelock: raw(full[0]),
    timelockProgramdata: raw(sliced[2]),
    status: raw(full[1]),
    attestation: raw(full[2]),
  };
  if (accounts.status && !accounts.status.owner.equals(COMPANION_PROGRAM)) accounts.status = null;
  if (accounts.attestation && !accounts.attestation.owner.equals(COMPANION_PROGRAM)) accounts.attestation = null;
  const mode = opts.hash ?? 'auto';
  let hash: string | null = null;
  const v3 = accounts.program?.owner.equals(BPF_LOADER_UPGRADEABLE) ?? false;
  const codeKey = v3 ? programDataAddress(program) : program;
  const codeHeader = v3 ? accounts.programdata : accounts.program;
  // The slot the code was deployed at: the ProgramData's (v3) or the loader-v4 header's; loader 2 never changes.
  const deploySlot = ((): string | null => {
    if (!codeHeader) return null;
    if (v3) return parseProgramData(codeHeader.data)?.slot.toString() ?? null;
    if (codeHeader.owner.equals(LOADER_V4) && codeHeader.data.length >= 8) return `v4:${codeHeader.data.readBigUInt64LE(0)}`;
    if (codeHeader.owner.equals(BPF_LOADER_2)) return 'loader2';
    return null;
  })();
  const needs = (() => {
    if (mode === 'never' || !codeHeader) return false;
    if (mode === 'always') return true;
    const st = accounts.status?.data;
    if (st && st.length >= STATUS.len && st[STATUS.audited] !== 0) return true;
    const at = accounts.attestation?.data;
    if (!at || at.length < ATTEST.len) return false;
    const slot = accounts.programdata ? parseProgramData(accounts.programdata.data)?.slot : undefined;
    return slot !== at.readBigUInt64LE(ATTEST.programdataSlot);
  })();
  if (needs && codeHeader) {
    const cacheKey = deploySlot === null ? null : `${program.toBase58()}:${deploySlot}`;
    const cached = cacheKey ? HASHES.get(cacheKey) : undefined;
    if (cached) hash = cached;
    else {
      const info = await connection.getAccountInfo(codeKey, 'confirmed');
      const code = info ? codeOf(info.owner, Buffer.from(info.data)) : null;
      if (code) {
        hash = executableHash(code);
        if (cacheKey) HASHES.set(cacheKey, hash);
      }
    }
  }
  const callees = opts.mint ? await hookCallees(connection, program, opts.mint) : [];
  return riskLabelOf(accounts, opts.now ?? Math.floor(Date.now() / 1000), hash, callees);
}
