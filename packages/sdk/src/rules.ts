/**
 * The rules lane from a terminal (docs/rules-lane.md §4): a custom hook composed as data, bound to
 * a launch config and run by Bordrless's one rules engine (`rules_hook`), read back word for word
 * by the site with no review, no build and no trading test.
 *
 * - `rules`: the typed builder (`rules.compose({ keeps, destination }).rule({ on, when, then }).build()`
 *   throws the engine's own refusal by code), the value helpers (`rules.gain.gt(0)`), the actions
 *   (`rules.cut(500)`, `rules.refuse('cooling')`), and the shared coders and reading
 *   (`rules.encode`, `rules.decode`, `rules.render`, `rules.flagsFor`, `rules.toStarter`).
 * - `rulesHook.bind` and `rulesHook.prepare`: the engine's two instructions (§2.1, §2.2), their wire
 *   format in one block (`bindData`, `bindKeys`, `prepareData`, `prepareKeys`) held to the engine's
 *   IDL (`idl/rules_hook.json`); `rulesHookExtras`, the four registry extras; `buildCreateComposedConfig`:
 *   `create_config` (or `create_listed_config`) and `bind` in one transaction, so no one else can
 *   bind the config. A listed one goes on the Workshop's shelves with `workshop.registerComposed`
 *   (workshop.ts).
 * - `decodeRuleSetAccount`, `decodeRulesState`, `decodeRulesHolding`: the engine's three layouts
 *   (§2.1, §2.2, §2.3), the holding's shared with the Loss cover hook's script.
 *
 * The engine is BUILT, NOT DEPLOYED YET: the SDK builds for its id (`RULES_HOOK_PROGRAM_ID_MAINNET`),
 * so a config built here cannot be sent until the deploy lands; the API's lane stays closed until
 * `RULES_HOOK_PROGRAM` is set to that id.
 */
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import {
  AUTHOR_SHARE_BPS,
  HOOK_DATA_LEN,
  NO_RULES,
  RULES_HOOK,
  RULES_LIMITS,
  RULE_DESTINATION_IDS,
  RulesError,
  assertRules,
  checkRulesBytes,
  decodeRules,
  encodeRules,
  renderRules,
  rulesFlagsOf,
  rulesHookReading,
  rulesToHex,
  validateRules,
  type Action,
  type Atom,
  type CountWhat,
  type RefuseReason,
  type Rule,
  type RuleDestination,
  type RuleKeep,
  type RuleOpName,
  type RuleSet,
  type RuleSide,
  type RuleValueName,
} from '@bordrless/shared';
import { BRIDGED_SOL_MINT, LAUNCH_PROGRAM, RULES_ENGINE_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, holdingAddress, launchAddress, launchPoolAddress, registryAddress } from './addresses.ts';
import { launchRulesFromInput } from './accounts.ts';
import type { BuiltConfig } from './inspect.ts';
import { launch as launchIx, type CreateConfigArgs } from './instructions.ts';
import { PREPARE_DISCRIMINATOR, hookStateAddress } from './template.ts';

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });

// ---- the engine's addresses ---------------------------------------------------------------------------------

/**
 * The engine's program id as a key: `RULES_HOOK_PROGRAM_ID_MAINNET` (`RULES_ENGINE_PROGRAM`), what
 * the SDK builds `bind` and `prepare` for. Built, not deployed yet: the API's lane opens when
 * `RULES_HOOK_PROGRAM` (`RULES_HOOK.deployed`) is set to it after the deploy.
 */
export const RULES_HOOK_KEY = RULES_ENGINE_PROGRAM;

/** `RuleSet` at `PDA(["rules", launch_config])` under the engine (§2.1). */
export const ruleSetAddress = (launchConfig: PublicKey, engine: PublicKey = RULES_HOOK_KEY): PublicKey => PublicKey.findProgramAddressSync([Buffer.from(RULES_HOOK.ruleSetSeed, 'utf8'), launchConfig.toBuffer()], engine)[0];

/** The engine's state for a mint, `PDA(["state", mint])` (§2.2), the template's address. */
export const rulesStateAddress = (mint: PublicKey, engine: PublicKey = RULES_HOOK_KEY): PublicKey => hookStateAddress(engine, mint);

// ---- the engine's wire format ----------------------------------------------------------------------------------
// The one place `bind` and `prepare` are spelled out (discriminators, argument bytes, account order),
// held to `idl/rules_hook.json` (the engine's IDL) and its coder by the tests. `rulesHook` below only
// fills them in.

/** `sha256("global:bind")[..8]`: Anchor's discriminator for the engine's `bind`. */
export const BIND_DISCRIMINATOR: Buffer = createHash('sha256').update('global:bind').digest().subarray(0, 8);

/**
 * `bind(rules: Vec<u8>, destination: u8, wallet: Pubkey)`'s data: the discriminator, the bytes
 * behind a u32 length, the destination (the header's) and the named wallet (zeros otherwise).
 */
export function bindData(bytes: Uint8Array, destination: number, wallet: PublicKey): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([BIND_DISCRIMINATOR, len, Buffer.from(bytes), Buffer.from([destination]), wallet.toBuffer()]);
}

/** `bind`'s accounts, in order: `payer` (signer, writable), `launch_config` (read-only), the `RuleSet` (init, writable), the system program. */
export const bindKeys = (payer: PublicKey, launchConfig: PublicKey, engine: PublicKey = RULES_HOOK_KEY): AccountMeta[] => [rw(payer, true), ro(launchConfig), rw(ruleSetAddress(launchConfig, engine)), ro(SYSTEM_PROGRAM)];

/** `prepare`'s data: the template's discriminator (`sha256("global:prepare")[..8]`), no arguments (the config comes from the set). */
export const prepareData = (): Buffer => Buffer.from(PREPARE_DISCRIMINATOR);

/** `prepare`'s accounts, in order: the template's five (payer, mint, state, registry, the system program) and the config's `RuleSet`, read-only. */
export const prepareKeys = (payer: PublicKey, mint: PublicKey, launchConfig: PublicKey, engine: PublicKey = RULES_HOOK_KEY): AccountMeta[] => [rw(payer, true), ro(mint), rw(rulesStateAddress(mint, engine)), rw(registryAddress(engine, mint)), ro(SYSTEM_PROGRAM), ro(ruleSetAddress(launchConfig, engine))];

// ---- the instructions ------------------------------------------------------------------------------------------

/** The named wallet a set is bound with: required on the curve and not the default key for a named destination; the default key otherwise (`destination_wallet`). */
export function destinationWalletFor(set: Pick<RuleSet, 'destination'>, wallet: PublicKey | null | undefined): PublicKey {
  if (set.destination !== 'named') return PublicKey.default;
  if (!wallet || wallet.equals(PublicKey.default) || !PublicKey.isOnCurve(wallet.toBytes())) throw new RulesError('destination_wallet');
  return wallet;
}

export const rulesHook = {
  /**
   * The engine's `bind` (§2.1): `payer` (signer, writable), `launch_config` (read-only), the
   * `RuleSet` (init, writable), the system program. The set is checked first (`assertRules`), so a
   * refused set never becomes a transaction. Send it in the same transaction as the config's
   * `create_config` (`buildCreateComposedConfig`). `payer` must be the config's creator (the engine refuses anyone else: `config_creator`).
   */
  bind(payer: PublicKey, launchConfig: PublicKey, set: RuleSet, destinationWallet: PublicKey | null = null, engine: PublicKey = RULES_HOOK_KEY): TransactionInstruction {
    assertRules(set);
    const wallet = destinationWalletFor(set, destinationWallet);
    return new TransactionInstruction({ programId: engine, keys: bindKeys(payer, launchConfig, engine), data: bindData(encodeRules(set), RULE_DESTINATION_IDS[set.destination], wallet) });
  },

  /**
   * The engine's `prepare` (§2.2): the template's five accounts (payer, mint, state, registry, the
   * system program) plus the `RuleSet` of the config the mint will launch from, read-only; no
   * arguments (the config comes from the set). The launch sends it for a new mint as it does for any
   * Workshop hook; a builder may send it ahead for a mint of their own.
   */
  prepare(payer: PublicKey, mint: PublicKey, launchConfig: PublicKey, engine: PublicKey = RULES_HOOK_KEY): TransactionInstruction {
    return new TransactionInstruction({ programId: engine, keys: prepareKeys(payer, mint, launchConfig, engine), data: prepareData() });
  },
};

/** What a composed config carries beside its rules: the pool rules that combine with any hook (§2.5) and whether it is listed. */
export interface ComposedConfigArgs {
  /** At most 32 bytes. */
  label: string;
  creatorFeeBps: number;
  burnBuyBps?: number;
  burnSellBps?: number;
  /** `create_listed_config` with `authorShareBps` (the Workshop's `AUTHOR_SHARE_BPS` unless given): half the creator fee of every launch someone else makes from it. */
  listed?: boolean;
  /** The named destination's wallet (`destination: 'named'`); ignored otherwise. */
  destinationWallet?: PublicKey | null;
}

export interface BuiltComposedConfig extends BuiltConfig {
  /** `create_config` or `create_listed_config`, then `bind`: one transaction, signed by the creator and the config's keypair. */
  instructions: [TransactionInstruction, TransactionInstruction];
  bind: TransactionInstruction;
  set: RuleSet;
  /** The config's `custom_hook_flags`, which `bind` checks against the set (`config_flags`). */
  flags: number;
  /** The set's bytes, hex. */
  bytes: string;
  /** The `RuleSet` address. */
  ruleSet: PublicKey;
}

/**
 * A composed config to create (§4): a fresh keypair for the `LaunchConfig`, `create_config` (or
 * `create_listed_config` when `listed`) naming the engine with the set's flags, no kit rules, the
 * burn rows and the creator fee, then `bind` of the set to it. Send both in one transaction signed by
 * `creator` and `keypair`; `address` is the key to paste under "Custom config" or to list
 * (`POST /v1/workshop/register`). Throws the engine's refusal by code for a set it would refuse.
 */
export function buildCreateComposedConfig(creator: PublicKey, args: ComposedConfigArgs, set: RuleSet, authorShareBps: number | null = null, keypair: Keypair = Keypair.generate(), engine: PublicKey = RULES_HOOK_KEY): BuiltComposedConfig {
  assertRules(set);
  const flags = rulesFlagsOf(set);
  const configArgs: CreateConfigArgs = {
    rules: launchRulesFromInput({ ...NO_RULES, burnBuyBps: args.burnBuyBps ?? 0, burnSellBps: args.burnSellBps ?? 0 }),
    creatorFeeBps: args.creatorFeeBps,
    customHook: engine,
    customHookFlags: flags,
    label: args.label,
  };
  const listed = args.listed === true || (authorShareBps !== null && authorShareBps > 0);
  const instruction = listed ? launchIx.createListedConfig(creator, keypair.publicKey, configArgs, authorShareBps ?? AUTHOR_SHARE_BPS) : launchIx.createConfig(creator, keypair.publicKey, configArgs);
  const bind = rulesHook.bind(creator, keypair.publicKey, set, args.destinationWallet ?? null, engine);
  return { keypair, address: keypair.publicKey, instruction, bind, instructions: [instruction, bind], set, flags, bytes: rulesToHex(encodeRules(set)), ruleSet: ruleSetAddress(keypair.publicKey, engine) };
}

// ---- the accounts ---------------------------------------------------------------------------------------------

/** `RuleSet` (§2.1): the discriminator, then its fields at these offsets; 447 bytes in all (the doc's "8 + 437" counts 437 for what its own offsets make 439). */
export const RULE_SET_LAYOUT = { version: 8, bump: 9, config: 10, author: 42, boundAt: 74, destination: 82, destinationWallet: 83, flags: 115, hash: 117, len: 149, rules: 151, size: 151 + RULES_LIMITS.bytes } as const;

export interface RuleSetAccount {
  version: number;
  bump: number;
  /** The `LaunchConfig` it is bound to. */
  config: PublicKey;
  /** Who bound it. */
  author: PublicKey;
  /** Unix seconds. */
  boundAt: number;
  destination: RuleDestination;
  /** The named wallet; null for burn, the creator or none. */
  destinationWallet: PublicKey | null;
  /** `flags_for(rules)`. */
  flags: number;
  /** sha256 of the bytes, hex. */
  hash: string;
  /** The set's bytes (`len` of the 296). */
  bytes: Uint8Array;
  /** The set, decoded; null when the bytes do not decode (never for a set the engine bound). */
  set: RuleSet | null;
}

const DESTINATION_BY_ID = new Map(Object.entries(RULE_DESTINATION_IDS).map(([k, v]) => [v, k as RuleDestination]));

export function decodeRuleSetAccount(data: Buffer | Uint8Array): RuleSetAccount {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < RULE_SET_LAYOUT.size) throw new Error(`a RuleSet is ${RULE_SET_LAYOUT.size} bytes, not ${b.length}`);
  const L = RULE_SET_LAYOUT;
  const len = b.readUInt16LE(L.len);
  const bytes = new Uint8Array(b.subarray(L.rules, L.rules + Math.min(len, RULES_LIMITS.bytes)));
  const walletKey = new PublicKey(b.subarray(L.destinationWallet, L.destinationWallet + 32));
  let set: RuleSet | null;
  try {
    set = decodeRules(bytes);
  } catch {
    set = null;
  }
  return {
    version: b[L.version]!,
    bump: b[L.bump]!,
    config: new PublicKey(b.subarray(L.config, L.config + 32)),
    author: new PublicKey(b.subarray(L.author, L.author + 32)),
    boundAt: Number(b.readBigInt64LE(L.boundAt)),
    destination: DESTINATION_BY_ID.get(b[L.destination]!) ?? 'none',
    destinationWallet: walletKey.equals(PublicKey.default) ? null : walletKey,
    flags: b.readUInt16LE(L.flags),
    hash: b.subarray(L.hash, L.hash + 32).toString('hex'),
    bytes,
    set,
  };
}

/** The per-mint state (§2.2): 628 bytes in all. */
export const RULES_STATE_LAYOUT = { version: 8, bump: 9, mint: 10, launch: 42, pool: 74, config: 106, ruleSet: 138, destinationHolding: 170, destinationOwner: 202, preparedBy: 234, preparedAt: 266, reference: 274, referenceAt: 282, paidTotal: 290, records: 298, flags: 306, rulesLen: 308, rules: 310, creatorBump: 606, reserved: 607, size: 628 } as const;

export interface RulesState {
  version: number;
  bump: number;
  mint: PublicKey;
  launch: PublicKey;
  pool: PublicKey;
  config: PublicKey;
  ruleSet: PublicKey;
  /** Where cuts go. */
  destinationHolding: PublicKey;
  /** Exempt from every rule. */
  destinationOwner: PublicKey;
  preparedBy: PublicKey;
  preparedAt: number;
  /** Kept in the layout, always 0: the engine caps no entry against a reference price. */
  reference: bigint;
  referenceAt: number;
  /** What `record_payout` recorded: lamports in all, and how many records. */
  paidTotal: bigint;
  records: bigint;
  flags: number;
  /** The bump of the companion address for the mint (`["creator", mint]`), exempt from every rule. */
  creatorBump: number;
  bytes: Uint8Array;
  set: RuleSet | null;
}

export function decodeRulesState(data: Buffer | Uint8Array): RulesState {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < RULES_STATE_LAYOUT.size) throw new Error(`the engine's state is ${RULES_STATE_LAYOUT.size} bytes, not ${b.length}`);
  const L = RULES_STATE_LAYOUT;
  const key = (at: number): PublicKey => new PublicKey(b.subarray(at, at + 32));
  const len = b.readUInt16LE(L.rulesLen);
  const bytes = new Uint8Array(b.subarray(L.rules, L.rules + Math.min(len, RULES_LIMITS.bytes)));
  let set: RuleSet | null;
  try {
    set = decodeRules(bytes);
  } catch {
    set = null;
  }
  return {
    version: b[L.version]!,
    bump: b[L.bump]!,
    mint: key(L.mint),
    launch: key(L.launch),
    pool: key(L.pool),
    config: key(L.config),
    ruleSet: key(L.ruleSet),
    destinationHolding: key(L.destinationHolding),
    destinationOwner: key(L.destinationOwner),
    preparedBy: key(L.preparedBy),
    preparedAt: Number(b.readBigInt64LE(L.preparedAt)),
    reference: b.readBigUInt64LE(L.reference),
    referenceAt: Number(b.readBigInt64LE(L.referenceAt)),
    paidTotal: b.readBigUInt64LE(L.paidTotal),
    records: b.readBigUInt64LE(L.records),
    flags: b.readUInt16LE(L.flags),
    creatorBump: b[L.creatorBump]!,
    bytes,
    set,
  };
}

/** The holding's 64 bytes (§2.3): the Loss cover hook's fields at its offsets, so a Lossback script reads a composed hook's holding unchanged. */
export const RULES_HOLDING_LAYOUT = { version: 0, flags: 1, entry: 2, amount: 10, paid: 18, sentAt: 26, paidAt: 34, receivedAt: 42, round: 50, counter: 54, firstAt: 58, reserved: 62 } as const;

export interface RulesHolding {
  version: number;
  /** Bit 0: sold or burned since the last buy. */
  sold: boolean;
  /** Bit 1: `firstAt` is set. */
  firstSet: boolean;
  /** Bits 4..7: the rule set's flags 0..3. */
  marks: [boolean, boolean, boolean, boolean];
  /** Average entry price, lamports per base unit times 10^12; 0 none. */
  entry: bigint;
  /** The balance as of the last write. */
  amount: bigint;
  /** Lamports recorded by `record_payout`. */
  paid: bigint;
  /** Unix seconds; 0 never. */
  sentAt: number;
  paidAt: number;
  receivedAt: number;
  /** The tag of the last `record_payout`. */
  round: number;
  counter: number;
  /** Seconds from the state's `preparedAt` to the first receive. */
  firstAt: number;
}

/** The record a holding keeps, or null when it has none (`version` 0: never written, or cleared). */
export function decodeRulesHolding(data: Buffer | Uint8Array): RulesHolding | null {
  if (data.length !== HOOK_DATA_LEN) throw new Error(`hook data is ${HOOK_DATA_LEN} bytes, not ${data.length}`);
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const L = RULES_HOLDING_LAYOUT;
  if (b[L.version] === 0) return null;
  const flags = b[L.flags]!;
  return {
    version: b[L.version]!,
    sold: (flags & 1) !== 0,
    firstSet: (flags & 2) !== 0,
    marks: [(flags & 16) !== 0, (flags & 32) !== 0, (flags & 64) !== 0, (flags & 128) !== 0],
    entry: b.readBigUInt64LE(L.entry),
    amount: b.readBigUInt64LE(L.amount),
    paid: b.readBigUInt64LE(L.paid),
    sentAt: Number(b.readBigInt64LE(L.sentAt)),
    paidAt: Number(b.readBigInt64LE(L.paidAt)),
    receivedAt: Number(b.readBigInt64LE(L.receivedAt)),
    round: b.readUInt32LE(L.round),
    counter: b.readUInt32LE(L.counter),
    firstAt: b.readUInt32LE(L.firstAt),
  };
}

/** Where a set's cuts go for a mint (§2.2): the launch's reserve holding (burn), the preparer's (the creator), or the named wallet's. */
export function rulesDestinationHolding(set: Pick<RuleSet, 'destination'>, mint: PublicKey, preparer: PublicKey, wallet: PublicKey | null = null): PublicKey | null {
  switch (set.destination) {
    case 'burn':
      return holdingAddress(mint, launchAddress(mint));
    case 'creator':
      return holdingAddress(mint, preparer);
    case 'named':
      return wallet ? holdingAddress(mint, wallet) : null;
    default:
      return null;
  }
}

/** The launch pools' LP fee, a seed of their address: the engine derives the pool at `prepare` with it. */
export const RULES_LAUNCH_LP_FEE_BPS = 30;

/**
 * The four extras the engine's `prepare` registers for `mint` (§2.4), in order, as a token
 * instruction passes them: the state and the launch (read-only), the launch pool (read-only, a
 * fixed key at the launchpad's LP fee), and the destination holding (writable), or the default
 * key read-only for a set with no destination (it can take no cut). For a transaction that
 * prepares and launches in one go, before the registry exists to be read.
 */
export function rulesHookExtras(set: Pick<RuleSet, 'destination'>, mint: PublicKey, preparer: PublicKey, wallet: PublicKey | null = null, engine: PublicKey = RULES_HOOK_KEY, quoteMint: PublicKey = BRIDGED_SOL_MINT): AccountMeta[] {
  const destination = rulesDestinationHolding(set, mint, preparer, wallet);
  return [ro(rulesStateAddress(mint, engine)), ro(launchAddress(mint)), ro(launchPoolAddress(mint, quoteMint, RULES_LAUNCH_LP_FEE_BPS)), destination ? rw(destination) : ro(PublicKey.default)];
}

// ---- the builder ----------------------------------------------------------------------------------------------

type Literal = bigint | number;
const lit = (x: Literal): bigint => (typeof x === 'bigint' ? x : BigInt(x));

/** `rules.gain.gt(0)`: one value's six comparisons. */
export interface ValueOps {
  lt: (x: Literal) => Atom;
  le: (x: Literal) => Atom;
  gt: (x: Literal) => Atom;
  ge: (x: Literal) => Atom;
  eq: (x: Literal) => Atom;
  ne: (x: Literal) => Atom;
}

const ops = (value: RuleValueName): ValueOps => {
  const make = (op: RuleOpName) => (x: Literal): Atom => ({ value, op, literal: lit(x) });
  return { lt: make('lt'), le: make('le'), gt: make('gt'), ge: make('ge'), eq: make('eq'), ne: make('ne') };
};

export interface ComposeOptions {
  /** What the engine keeps for the set (§2.3); every atom that reads it needs its bit. */
  keeps?: RuleKeep[];
  destination?: RuleDestination;
  /** With `keeps: ['entry']`: the header's `entry_cap_bps` (0, or 1 to 5,000), checked by `bind` and applied nowhere: the engine records a buy's entry at the trade's own price, uncapped. */
  entryCapBps?: number;
}

export interface RuleSpec {
  on: RuleSide[];
  when?: Atom[];
  unless?: Atom | null;
  then: Action;
  stop?: boolean;
}

/** A set in the making: `rule` adds one, `build` checks the whole and throws the engine's refusal by code. */
export class Composer {
  private readonly keeps: Set<RuleKeep>;
  private readonly destination: RuleDestination;
  private readonly entryCapBps: number;
  private readonly rules: Rule[] = [];

  constructor(opts: ComposeOptions = {}) {
    this.keeps = new Set(opts.keeps ?? []);
    this.destination = opts.destination ?? 'none';
    this.entryCapBps = opts.entryCapBps ?? 0;
  }

  rule(spec: RuleSpec): this {
    this.rules.push({ on: [...spec.on], when: [...(spec.when ?? [])], unless: spec.unless ?? null, then: { ...spec.then }, stop: spec.stop ?? false });
    return this;
  }

  /** The set as it stands, unchecked. */
  set(): RuleSet {
    return { version: 1, keeps: { entry: this.keeps.has('entry'), times: this.keeps.has('times'), count: this.keeps.has('count') }, entryCapBps: this.entryCapBps, destination: this.destination, rules: this.rules.map((r) => ({ ...r, on: [...r.on], when: [...r.when] })) };
  }

  /** The set, checked as `bind` checks it; throws `RulesError` (`code`, `rule`) for what the engine would refuse. */
  build(): RuleSet {
    return assertRules(this.set());
  }
}

export const rules = {
  compose: (opts: ComposeOptions = {}): Composer => new Composer(opts),

  // The values (§1.1).
  amount: ops('amount'),
  amountShare: ops('amountShare'),
  balanceBefore: ops('balanceBefore'),
  balanceAfter: ops('balanceAfter'),
  shareAfter: ops('shareAfter'),
  tradePrice: ops('tradePrice'),
  spotPrice: ops('spotPrice'),
  gain: ops('gain'),
  loss: ops('loss'),
  valueBefore: ops('valueBefore'),
  valueAfter: ops('valueAfter'),
  sinceReceived: ops('sinceReceived'),
  sinceSent: ops('sinceSent'),
  age: ops('age'),
  firstAfterLaunch: ops('firstAfterLaunch'),
  sinceLaunch: ops('sinceLaunch'),
  counter: ops('counter'),
  /** The holding's flag `k` (0 to 3) as a value: `rules.flag(0).eq(1)`, or `rules.marked(0)`. */
  flag: (k: 0 | 1 | 2 | 3): ValueOps => ops(`flag${k}` as RuleValueName),
  marked: (k: 0 | 1 | 2 | 3 = 0): Atom => ({ value: `flag${k}` as RuleValueName, op: 'eq', literal: 1n }),
  graduated: { value: 'graduated', op: 'eq', literal: 1n } as Atom,
  notGraduated: { value: 'graduated', op: 'eq', literal: 0n } as Atom,
  hasEntry: { value: 'hasEntry', op: 'eq', literal: 1n } as Atom,
  noEntry: { value: 'hasEntry', op: 'eq', literal: 0n } as Atom,

  // The actions (§1.2).
  cut: (bps: number): Action => ({ kind: 'cut', bps }),
  refuse: (reason: RefuseReason = 'rule'): Action => ({ kind: 'refuse', reason }),
  count: (what: CountWhat = 'add'): Action => ({ kind: 'count', what }),
  mark: (flag: 0 | 1 | 2 | 3 = 0, set = true): Action => ({ kind: 'flag', flag, set }),

  // The shared coders and the reading, the same the site and the API run.
  encode: encodeRules,
  decode: decodeRules,
  validate: validateRules,
  check: checkRulesBytes,
  render: renderRules,
  reading: rulesHookReading,
  flagsFor: rulesFlagsOf,
  toHex: rulesToHex,
  /** The template's `src/lib.rs` with the same rules spelled out in Rust (§1.4, §5): the start of the code lane. */
  toStarter: (set: RuleSet, opts: { destinationWallet?: PublicKey | null } = {}): string => toStarter(set, opts),
  limits: RULES_LIMITS,
};

// ---- the escape hatch: the same rules as a template hook ---------------------------------------------------

const RUST_VALUE: Record<RuleValueName, string> = {
  amount: 'v.amount',
  amountShare: 'v.amount_share',
  balanceBefore: 'v.balance_before',
  balanceAfter: 'v.balance_after',
  shareAfter: 'v.share_after',
  tradePrice: 'v.trade_price',
  spotPrice: 'v.spot_price',
  gain: 'v.gain',
  loss: 'v.loss',
  valueBefore: 'v.value_before',
  valueAfter: 'v.value_after',
  sinceReceived: 'v.since_received',
  sinceSent: 'v.since_sent',
  age: 'v.age',
  firstAfterLaunch: 'v.first_after_launch',
  sinceLaunch: 'v.since_launch',
  counter: 'v.counter',
  graduated: 'v.graduated',
  hasEntry: 'v.has_entry',
  flag0: 'v.flags[0]',
  flag1: 'v.flags[1]',
  flag2: 'v.flags[2]',
  flag3: 'v.flags[3]',
};
/** Values that may be absent (no price, no entry, never received): `Option<u64>` in the starter, an atom on them false when absent (§1.1). */
const RUST_OPTIONAL: readonly RuleValueName[] = ['tradePrice', 'spotPrice', 'gain', 'loss', 'valueBefore', 'valueAfter', 'sinceReceived', 'sinceSent', 'age', 'firstAfterLaunch'];
const RUST_BOOL: readonly RuleValueName[] = ['graduated', 'hasEntry', 'flag0', 'flag1', 'flag2', 'flag3'];
const RUST_OP: Record<RuleOpName, string> = { lt: '<', le: '<=', gt: '>', ge: '>=', eq: '==', ne: '!=' };
const RUST_SIDE: Record<RuleSide, string> = { sell: 'SELL', buy: 'BUY', send: 'SEND', receive: 'RECEIVE', burn: 'BURN' };
const RUST_REASON: Record<RefuseReason, string> = { cooling: 'HookError::CoolingDown', cap: 'HookError::OverCap', locked: 'HookError::Locked', rule: 'HookError::Refused' };

const rustLiteral = (x: bigint): string => {
  const s = x.toString();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += '_';
    out += s[i];
  }
  return out;
};

/** One atom as a Rust expression over `v: &Values`. */
export function rustAtom(a: Atom): string {
  const field = RUST_VALUE[a.value];
  if (RUST_BOOL.includes(a.value)) {
    const want = a.literal === 0n ? 'false' : 'true';
    return a.op === 'eq' ? (want === 'true' ? field : `!${field}`) : a.op === 'ne' ? (want === 'true' ? `!${field}` : field) : `(${field} as u64) ${RUST_OP[a.op]} ${rustLiteral(a.literal)}`;
  }
  if (RUST_OPTIONAL.includes(a.value)) return `${field}.map_or(false, |x| x ${RUST_OP[a.op]} ${rustLiteral(a.literal)})`;
  return `${field} ${RUST_OP[a.op]} ${rustLiteral(a.literal)}`;
}

/** One rule as Rust in `decide`. */
export function rustRule(r: Rule, index: number): string {
  const sides = r.on.map((s) => RUST_SIDE[s]).join(' | ');
  const conds = [`side & (${sides}) != 0`, ...r.when.map(rustAtom), ...(r.unless ? [`!(${rustAtom(r.unless)})`] : [])];
  const body: string[] = [];
  switch (r.then.kind) {
    case 'cut':
      body.push(`d.cut_bps += ${r.then.bps};`);
      break;
    case 'refuse':
      body.push(`d.refuse = Some(${RUST_REASON[r.then.reason]});`, 'return d;');
      break;
    case 'count':
      body.push(r.then.what === 'add' ? 'd.count_add = true;' : 'd.count_reset = true;');
      break;
    case 'flag':
      body.push(`d.marks[${r.then.flag}] = Some(${r.then.set ? 'true' : 'false'});`);
      break;
  }
  if (r.stop && r.then.kind !== 'refuse') body.push('return d;');
  return [`    // rule ${index + 1}`, `    if ${conds.join('\n        && ')}`, '    {', ...body.map((l) => `        ${l}`), '    }'].join('\n');
}

/**
 * The template's `src/lib.rs` with this set spelled out in Rust: the standard `prepare` and
 * callbacks of the Workshop template, the engine's holding layout (§2.3) read and written here,
 * and a `rules` module with `decide(side, &Values) -> Decision` on plain numbers, the rules in
 * order. A builder who needs what the lane cannot say (§1.4) starts from this file and the review
 * reads a familiar shape. `values_for` leaves the pool's price to the builder (`pool_price`),
 * so a rule on a price, a gain, a loss or a value does not fire until it is filled in.
 */
export function toStarter(set: RuleSet, opts: { destinationWallet?: PublicKey | null } = {}): string {
  const words = renderRules(set, { destinationWallet: opts.destinationWallet?.toBase58() ?? null });
  const flags = rulesFlagsOf(set);
  const anyCut = set.rules.some((r) => r.then.kind === 'cut');
  // The launch's reserve holding (`["holding", mint, launch]` under the token program: the launch is extra account 6), or the cut wallet's holding.
  const destination =
    set.destination === 'burn'
      ? `AccountSource::Pda { program: TOKEN_PROGRAM, seeds: vec![Seed::Literal(b"holding".to_vec()), Seed::Account(1), Seed::Account(6)] }`
      : `AccountSource::Pda { program: TOKEN_PROGRAM, seeds: vec![Seed::Literal(b"holding".to_vec()), Seed::Account(1), Seed::Literal(CUT_WALLET.to_bytes().to_vec())] }`;
  const header = words.sentences.map((s) => `//! ${s}`).join('\n');
  return `//! A Bordrless token hook, made with the SDK from a rule set (docs/rules-lane.md §1.4): the same
//! rules a composed hook runs, spelled out in Rust on the Workshop template, so a builder who needs
//! what the lane cannot say starts here and the review reads a familiar shape.
//!
${header}
//!
//! The most it takes: ${words.mostTakes.text}
//! Flags for its config: ${flags} (BEFORE_TRANSFER${(flags & 64) !== 0 ? ' | TRANSFER_RETURNS_DELTA' : ''}${(flags & 16) !== 0 ? ' | BEFORE_BURN | WRITES_HOOK_DATA' : ''}).
//!
//! \`rules::decide\` is the whole rule set on plain numbers; \`values_for\` fills the numbers from the
//! callback, the holding's record (the engine's 64-byte layout, docs/rules-lane.md §2.3) and the
//! clock. \`pool_price\` is left to fill in: a rule on a price, a gain, a loss or a value does not
//! fire until it reads the launch pool (the Loss cover hook's \`trade_price\`, docs/loss-cover.md §2.2).

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use bordrless_hook::{
    hook_accounts_address, hook_signer, write_registry, AccountSource, Delta, ExtraAccount,
    HookAccountList, HookReturn, Seed, TokenHookArgs, TokenOp, HOOK_DATA_LEN,
};

declare_id!("STUDIO_PROGRAM_ID");

/// The Bordrless token program: the only caller of the callbacks.
pub const TOKEN_PROGRAM: Pubkey =
    Pubkey::from_str_const("${TOKEN_PROGRAM.toBase58()}");
/// The Bordrless launchpad.
pub const LAUNCH_PROGRAM: Pubkey =
    Pubkey::from_str_const("${LAUNCH_PROGRAM.toBase58()}");
/// The wallet the cuts go to when the destination is the creator or a named wallet: its holding of
/// the mint is the third extra account.${set.destination === 'creator' || (set.destination === 'named' && !opts.destinationWallet) ? ' REPLACE with your own wallet before building.' : ''}
pub const CUT_WALLET: Pubkey =
    Pubkey::from_str_const("${(opts.destinationWallet ?? PublicKey.default).toBase58()}");
/// \`["state", mint]\`: this hook's state for a mint (the standard \`prepare\` creates it).
pub const STATE_SEED: &[u8] = b"state";
/// The launchpad's \`["launch", mint]\` seed.
pub const LAUNCH_SEED: &[u8] = b"launch";
/// Index of the destination holding among the callback's accounts (five prefix, then the extras: state, launch, destination).
pub const DESTINATION_INDEX: u8 = 7;

/// The rules, on plain numbers. \`side\` is one of the bits; the values are the subject holding's.
pub mod rules {
    use super::HookError;

    pub const SELL: u8 = 1;
    pub const BUY: u8 = 2;
    pub const SEND: u8 = 4;
    pub const RECEIVE: u8 = 8;
    pub const BURN: u8 = 16;

    /// What a rule can see (docs/rules-lane.md §1.1). \`None\`: not computable, so any condition on it is false.
    #[derive(Clone, Debug, Default)]
    pub struct Values {
        pub amount: u64,
        pub amount_share: u64,
        pub balance_before: u64,
        pub balance_after: u64,
        pub share_after: u64,
        pub trade_price: Option<u64>,
        pub spot_price: Option<u64>,
        pub gain: Option<u64>,
        pub loss: Option<u64>,
        pub value_before: Option<u64>,
        pub value_after: Option<u64>,
        pub since_received: Option<u64>,
        pub since_sent: Option<u64>,
        pub age: Option<u64>,
        pub first_after_launch: Option<u64>,
        pub since_launch: u64,
        pub counter: u64,
        pub graduated: bool,
        pub has_entry: bool,
        pub flags: [bool; 4],
    }

    /// What the rules decided: the cuts added up, a refusal (which ends the walk), a count, marks.
    #[derive(Clone, Debug, Default)]
    pub struct Decision {
        pub cut_bps: u16,
        pub refuse: Option<HookError>,
        pub count_add: bool,
        pub count_reset: bool,
        pub marks: [Option<bool>; 4],
    }

    /// The rule set, in order: every rule that matches fires; a refusal wins; a stop ends the walk.
    pub fn decide(side: u8, v: &Values) -> Decision {
        let mut d = Decision::default();
${set.rules.map(rustRule).join('\n')}
        d
    }
}

/// The holding's record, the engine's 64-byte layout (docs/rules-lane.md §2.3), shared with the Loss cover script.
#[derive(Clone, Copy, Debug, Default)]
pub struct Record {
    pub version: u8,
    pub flags: u8,
    pub entry: u64,
    pub amount: u64,
    pub paid: u64,
    pub sent_at: i64,
    pub paid_at: i64,
    pub received_at: i64,
    pub round: u32,
    pub counter: u32,
    pub first_at: u32,
}

impl Record {
    pub fn read(data: &[u8; HOOK_DATA_LEN]) -> Option<Record> {
        if data[0] == 0 {
            return None;
        }
        let u64_at = |at: usize| u64::from_le_bytes(data[at..at + 8].try_into().unwrap_or_default());
        let i64_at = |at: usize| i64::from_le_bytes(data[at..at + 8].try_into().unwrap_or_default());
        let u32_at = |at: usize| u32::from_le_bytes(data[at..at + 4].try_into().unwrap_or_default());
        Some(Record { version: data[0], flags: data[1], entry: u64_at(2), amount: u64_at(10), paid: u64_at(18), sent_at: i64_at(26), paid_at: i64_at(34), received_at: i64_at(42), round: u32_at(50), counter: u32_at(54), first_at: u32_at(58) })
    }

    pub fn write(&self) -> [u8; HOOK_DATA_LEN] {
        let mut data = [0u8; HOOK_DATA_LEN];
        data[0] = 1;
        data[1] = self.flags;
        data[2..10].copy_from_slice(&self.entry.to_le_bytes());
        data[10..18].copy_from_slice(&self.amount.to_le_bytes());
        data[18..26].copy_from_slice(&self.paid.to_le_bytes());
        data[26..34].copy_from_slice(&self.sent_at.to_le_bytes());
        data[34..42].copy_from_slice(&self.paid_at.to_le_bytes());
        data[42..50].copy_from_slice(&self.received_at.to_le_bytes());
        data[50..54].copy_from_slice(&self.round.to_le_bytes());
        data[54..58].copy_from_slice(&self.counter.to_le_bytes());
        data[58..62].copy_from_slice(&self.first_at.to_le_bytes());
        data
    }
}

/// The launch pool of \`mint\`, read from its launch account: \`None\` until the launch exists.
pub fn launch_pool(launch: &AccountInfo, mint: &Pubkey) -> Option<Pubkey> {
    if *launch.owner != LAUNCH_PROGRAM {
        return None;
    }
    let data = launch.try_borrow_data().ok()?;
    let at = |offset: usize| -> Option<Pubkey> { Some(Pubkey::new_from_array(data.get(offset..offset + 32)?.try_into().ok()?)) };
    (at(10)? == *mint).then_some(at(74)?).filter(|pool| *pool != Pubkey::default())
}

/// The trade's curve price, lamports per base unit times 10^12, from the pool as it reads in the
/// callback (docs/loss-cover.md §2.2). Left to fill in: \`None\` makes every price rule pass.
pub fn pool_price(_pool: Option<&AccountInfo>, _amount: u64) -> Option<u64> {
    None
}

/// The callbacks' extra accounts, in order after the token program's five (hook signer, mint,
/// source, destination, authority): this hook's state, the mint's launch, the destination holding.
pub fn extra_accounts() -> HookAccountList {
    HookAccountList::new(vec![
        ExtraAccount { writable: false, source: AccountSource::Pda { program: crate::ID, seeds: vec![Seed::Literal(STATE_SEED.to_vec()), Seed::Account(1)] } },
        ExtraAccount { writable: false, source: AccountSource::Pda { program: LAUNCH_PROGRAM, seeds: vec![Seed::Literal(LAUNCH_SEED.to_vec()), Seed::Account(1)] } },
        ExtraAccount { writable: ${anyCut ? 'true' : 'false'}, source: ${destination} },
    ])
}

/// The values of one holding for one operation.
pub fn values_for(args: &TokenHookArgs, record: Option<&Record>, balance_before: u64, balance_after: u64, now: i64, launched_at: i64, prepared_at: i64, graduated: bool) -> rules::Values {
    let share = |x: u64| if args.supply == 0 { 0 } else { ((x as u128) * 10_000 / args.supply as u128) as u64 };
    let since = |at: i64| (at > 0).then(|| now.saturating_sub(at).max(0) as u64);
    let price = pool_price(None, args.amount);
    let entry = record.map(|r| r.entry).filter(|e| *e > 0);
    let bps_of = |num: u64, den: u64| ((num as u128) * 10_000 / den as u128) as u64;
    rules::Values {
        amount: args.amount,
        amount_share: share(args.amount),
        balance_before,
        balance_after,
        share_after: share(balance_after),
        trade_price: price,
        spot_price: price,
        gain: match (price, entry) { (Some(p), Some(e)) if p > e => Some(bps_of(p - e, e)), (Some(_), Some(_)) => Some(0), _ => None },
        loss: match (price, entry) { (Some(p), Some(e)) if p < e => Some(bps_of(e - p, e)), (Some(_), Some(_)) => Some(0), _ => None },
        value_before: price.map(|p| ((balance_before as u128) * p as u128 / 1_000_000_000_000) as u64),
        value_after: price.map(|p| ((balance_after as u128) * p as u128 / 1_000_000_000_000) as u64),
        since_received: record.and_then(|r| since(r.received_at)),
        since_sent: record.and_then(|r| since(r.sent_at)),
        age: record.filter(|r| r.flags & 2 != 0).map(|r| now.saturating_sub(prepared_at + r.first_at as i64).max(0) as u64),
        first_after_launch: record.filter(|r| r.flags & 2 != 0).map(|r| (prepared_at + r.first_at as i64 - launched_at).max(0) as u64),
        since_launch: now.saturating_sub(launched_at).max(0) as u64,
        counter: record.map_or(0, |r| r.counter as u64),
        graduated,
        has_entry: entry.is_some(),
        flags: [record.map_or(false, |r| r.flags & 16 != 0), record.map_or(false, |r| r.flags & 32 != 0), record.map_or(false, |r| r.flags & 64 != 0), record.map_or(false, |r| r.flags & 128 != 0)],
    }
}

#[program]
pub mod studio_hook {
    use super::*;

    /// The standard \`prepare\`: this hook's state for \`mint\` and its registry.
    pub fn prepare(ctx: Context<Prepare>) -> Result<()> {
        let mint = ctx.accounts.mint.key();
        let state = &mut ctx.accounts.state;
        state.version = 1;
        state.bump = ctx.bumps.state;
        state.mint = mint;
        state.launch = Pubkey::find_program_address(&[LAUNCH_SEED, mint.as_ref()], &LAUNCH_PROGRAM).0;
        state.prepared_by = ctx.accounts.payer.key();
        state.prepared_at = Clock::get()?.unix_timestamp;
        let (registry, bump) = hook_accounts_address(&crate::ID, &mint);
        require_keys_eq!(ctx.accounts.registry.key(), registry, HookError::WrongAccount);
        write_registry(
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.registry.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &crate::ID,
            &mint,
            bump,
            &extra_accounts(),
        )
    }

    /// Before every transfer: the sides from the owners, the rules on the sender and the receiver,
    /// one cut to the destination, the records written.
    pub fn before_transfer(ctx: Context<Callback>, args: TokenHookArgs) -> Result<HookReturn> {
        check_call(&ctx, &args)?;
        require!(args.op == TokenOp::Transfer, HookError::WrongAccount);
        let state = &ctx.accounts.state;
        let pool = launch_pool(&ctx.accounts.launch, &state.mint);
        let exempt = |owner: &Pubkey| *owner == state.launch || Some(*owner) == pool || *owner == Pubkey::default();
        let now = Clock::get()?.unix_timestamp;
        let graduated = false; // read the pool's curve flag once pool_price reads the pool
        let launched_at = state.prepared_at;
        let (source_side, destination_side) = match (Some(args.source_owner) == pool, Some(args.destination_owner) == pool) {
            (true, _) => (0, rules::BUY),
            (_, true) => (rules::SELL, 0),
            _ => (rules::SEND, rules::RECEIVE),
        };
        let mut out = HookReturn::default();
        let mut cut: u64 = 0;
        if !exempt(&args.source_owner) {
            let record = Record::read(&args.source_hook_data);
            let v = values_for(&args, record.as_ref(), args.source_balance, args.source_balance.saturating_sub(args.amount), now, launched_at, state.prepared_at, graduated);
            let d = rules::decide(source_side, &v);
            if let Some(e) = d.refuse {
                return Err(e.into());
            }
            cut = cut.saturating_add((args.amount as u128 * d.cut_bps as u128 / 10_000) as u64);
            let mut r = record.unwrap_or_default();
            r.amount = args.source_balance.saturating_sub(args.amount);
            r.sent_at = now;
            r.flags |= 1;
            apply_marks(&mut r, &d);
            out.source_hook_data = Some(if r.amount == 0 { [0u8; HOOK_DATA_LEN] } else { r.write() });
        }
        if !exempt(&args.destination_owner) {
            let record = Record::read(&args.destination_hook_data);
            let received = args.amount.saturating_sub(cut);
            let v = values_for(&args, record.as_ref(), args.destination_balance, args.destination_balance.saturating_add(received), now, launched_at, state.prepared_at, graduated);
            let d = rules::decide(destination_side, &v);
            if let Some(e) = d.refuse {
                return Err(e.into());
            }
            cut = cut.saturating_add((args.amount as u128 * d.cut_bps as u128 / 10_000) as u64);
            let mut r = record.unwrap_or_default();
            r.amount = args.destination_balance.saturating_add(received);
            r.received_at = now;
            if r.flags & 2 == 0 {
                r.flags |= 2;
                r.first_at = now.saturating_sub(state.prepared_at).max(0) as u32;
            }
            apply_marks(&mut r, &d);
            out.destination_hook_data = Some(r.write());
        }
        if cut > 0 {
            out.deltas.push(Delta { amount: cut, account: DESTINATION_INDEX });
        }
        Ok(out)
    }

    /// After every transfer: the balances are the new ones. Answers nothing.
    pub fn after_transfer(ctx: Context<Callback>, args: TokenHookArgs) -> Result<()> {
        check_call(&ctx, &args)
    }

    /// Before the supply is minted (once, at launch).
    pub fn before_mint(ctx: Context<Callback>, args: TokenHookArgs) -> Result<HookReturn> {
        check_call(&ctx, &args)?;
        Ok(HookReturn::default())
    }

    /// After the supply is minted.
    pub fn after_mint(ctx: Context<Callback>, args: TokenHookArgs) -> Result<()> {
        check_call(&ctx, &args)
    }

    /// Before a burn: the rules on the sender alone, no cuts (a cut on a burn is refused at composition).
    pub fn before_burn(ctx: Context<Callback>, args: TokenHookArgs) -> Result<HookReturn> {
        check_call(&ctx, &args)?;
        let state = &ctx.accounts.state;
        if args.source_owner == state.launch || args.source_owner == Pubkey::default() {
            return Ok(HookReturn::default());
        }
        let now = Clock::get()?.unix_timestamp;
        let record = Record::read(&args.source_hook_data);
        let v = values_for(&args, record.as_ref(), args.source_balance, args.source_balance.saturating_sub(args.amount), now, state.prepared_at, state.prepared_at, false);
        let d = rules::decide(rules::BURN, &v);
        if let Some(e) = d.refuse {
            return Err(e.into());
        }
        let mut r = record.unwrap_or_default();
        r.amount = args.source_balance.saturating_sub(args.amount);
        r.sent_at = now;
        r.flags |= 1;
        apply_marks(&mut r, &d);
        Ok(HookReturn { source_hook_data: Some(if r.amount == 0 { [0u8; HOOK_DATA_LEN] } else { r.write() }), ..HookReturn::default() })
    }

    /// After a burn.
    pub fn after_burn(ctx: Context<Callback>, args: TokenHookArgs) -> Result<()> {
        check_call(&ctx, &args)
    }
}

/// A decision's count and marks, into the record.
fn apply_marks(r: &mut Record, d: &rules::Decision) {
    if d.count_reset {
        r.counter = 0;
    }
    if d.count_add {
        r.counter = r.counter.saturating_add(1);
    }
    for (k, mark) in d.marks.iter().enumerate() {
        match mark {
            Some(true) => r.flags |= 16 << k,
            Some(false) => r.flags &= !(16 << k),
            None => {}
        }
    }
}

/// Every callback: signed by the token program's signer for this hook, about the mint this state was prepared for.
fn check_call(ctx: &Context<Callback>, args: &TokenHookArgs) -> Result<()> {
    let signer = &ctx.accounts.hook_signer;
    require!(signer.is_signer, HookError::BadHookSigner);
    require_keys_eq!(signer.key(), hook_signer(&TOKEN_PROGRAM, &crate::ID).0, HookError::BadHookSigner);
    require_keys_eq!(args.mint, ctx.accounts.state.mint, HookError::WrongAccount);
    Ok(())
}

/// This hook's state for one mint, at \`["state", mint]\`.
#[account]
#[derive(InitSpace)]
pub struct HookState {
    pub version: u8,
    pub bump: u8,
    pub mint: Pubkey,
    pub launch: Pubkey,
    pub prepared_by: Pubkey,
    pub prepared_at: i64,
    pub reserved: [u8; 56],
}

#[derive(Accounts)]
pub struct Prepare<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the mint need not exist yet.
    pub mint: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + HookState::INIT_SPACE, seeds = [STATE_SEED, mint.key().as_ref()], bump)]
    pub state: Account<'info, HookState>,
    /// CHECK: written by \`write_registry\`.
    #[account(mut)]
    pub registry: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Callback<'info> {
    /// CHECK: the token program's signer for this hook.
    pub hook_signer: UncheckedAccount<'info>,
    /// CHECK: the mint.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the source holding.
    pub source: UncheckedAccount<'info>,
    /// CHECK: the destination holding.
    pub destination: UncheckedAccount<'info>,
    /// CHECK: who signed.
    pub authority: UncheckedAccount<'info>,
    pub state: Account<'info, HookState>,
    /// CHECK: the launchpad's launch account, read by hand.
    pub launch: UncheckedAccount<'info>,
    /// CHECK: the destination holding of the cuts.
    pub cut_destination: UncheckedAccount<'info>,
}

#[error_code]
pub enum HookError {
    #[msg("wrong account")]
    WrongAccount,
    #[msg("bad hook signer")]
    BadHookSigner,
    #[msg("cooling down")]
    CoolingDown,
    #[msg("over the cap")]
    OverCap,
    #[msg("locked")]
    Locked,
    #[msg("refused by a rule")]
    Refused,
}
`;
}
