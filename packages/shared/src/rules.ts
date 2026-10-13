/**
 * The rules lane (docs/rules-lane.md): a custom hook composed as data and run by Bordrless's one
 * rules engine (`rules_hook`). A rule set is a header and 1 to 6 rules of 48 bytes, little-endian,
 * every field fixed-width (§1). This module is the lane's one reading of the bytes, shared by the
 * SDK, the site, the API and the engine's own tests (`vectors/rules.json`):
 *
 * - the types and the enums as the doc numbers them (`RULE_VALUE_IDS`, `RULE_OP_IDS`, ...);
 * - `encodeRules` / `decodeRules`, the exact byte layout of §1.2;
 * - `validateRules`, every bound of §1 and §2.6 as a code and a plain sentence: the same codes the
 *   engine's `bind` refuses with (`RULES_ERROR_TEXT` lists them);
 * - `renderRules`, the pure reading of §3: the sentences, "the most it takes" per side (summed from
 *   the rules, never measured), the flags and the generated watch lines;
 * - `rulesFlagsOf`, the token hook flags a set needs; `rulesHookReading`, the synthetic reading in
 *   the shape of `HookReading` (`lane: 'rules'`, `verdict: 'rules'`) every surface already shows.
 *
 * Wording follows the site's: numbers only, the site's units, no reassurance. Nothing here touches
 * a chain: the SDK builds the instructions, the API reads the accounts.
 */
import type { HookReading } from './api.ts';
import { TOKEN_DECIMALS, TOKEN_SUPPLY } from './policy.ts';
import { TOKEN_HOOK_FLAGS } from './programs.ts';
import type { WorkshopReading } from './workshop.ts';

// ---- the language ----------------------------------------------------------------------------------

export const RULES_VERSION = 1;
/** The header, then each rule, then each atom slot (§1.2). */
export const RULES_HEADER_BYTES = 8;
export const RULE_BYTES = 48;
export const ATOM_BYTES = 10;
export const RULE_ATOM_SLOTS = 4;

export const RULES_LIMITS = {
  /** Rules in a set. */
  rules: 6,
  /** `when` atoms a rule may have; `unless` atoms. */
  when: 3,
  unless: 1,
  /** A cut, basis points of the amount; the cuts of one side summed. */
  cutBps: 1_500,
  sideCutBps: 1_500,
  /** `entry_cap_bps` (§1.2): checked by `bind`, applied nowhere (a buy's entry is what it paid). */
  entryCapBps: 5_000,
  /** A set's bytes: `8 + 48 * 6`. */
  bytes: 296,
  /** Composed hooks one wallet may list in a day (the Workshop's allowance). */
  perDay: 6,
  /** Literals, by unit (§1.2). A price is any u64. */
  literal: {
    bps: 10_000n,
    seconds: 31_536_000n,
    lamports: 10_000_000_000_000n,
    baseUnits: TOKEN_SUPPLY,
    count: 65_535n,
    flag: 1n,
    price: (1n << 64n) - 1n,
  },
} as const;

export type RuleSide = 'sell' | 'buy' | 'send' | 'receive' | 'burn';
export const RULE_SIDES: readonly RuleSide[] = ['sell', 'buy', 'send', 'receive', 'burn'];
/** `on`'s bits. */
export const RULE_SIDE_BITS: Record<RuleSide, number> = { sell: 1, buy: 2, send: 4, receive: 8, burn: 16 };

export type RuleValueName =
  | 'amount'
  | 'amountShare'
  | 'balanceBefore'
  | 'balanceAfter'
  | 'shareAfter'
  | 'tradePrice'
  | 'spotPrice'
  | 'gain'
  | 'loss'
  | 'valueBefore'
  | 'valueAfter'
  | 'sinceReceived'
  | 'sinceSent'
  | 'age'
  | 'firstAfterLaunch'
  | 'sinceLaunch'
  | 'counter'
  | 'graduated'
  | 'hasEntry'
  | 'flag0'
  | 'flag1'
  | 'flag2'
  | 'flag3';

/** The values a rule can see (§1.1), by id. */
export const RULE_VALUE_IDS: Record<RuleValueName, number> = {
  amount: 1,
  amountShare: 2,
  balanceBefore: 3,
  balanceAfter: 4,
  shareAfter: 5,
  tradePrice: 6,
  spotPrice: 7,
  gain: 8,
  loss: 9,
  valueBefore: 10,
  valueAfter: 11,
  sinceReceived: 12,
  sinceSent: 13,
  age: 14,
  firstAfterLaunch: 15,
  sinceLaunch: 16,
  counter: 17,
  graduated: 18,
  hasEntry: 19,
  flag0: 32,
  flag1: 33,
  flag2: 34,
  flag3: 35,
};

export type RuleUnit = 'baseUnits' | 'bps' | 'price' | 'lamports' | 'seconds' | 'count' | 'flag';

/** Each value's unit, which bounds its literal. */
export const RULE_VALUE_UNITS: Record<RuleValueName, RuleUnit> = {
  amount: 'baseUnits',
  amountShare: 'bps',
  balanceBefore: 'baseUnits',
  balanceAfter: 'baseUnits',
  shareAfter: 'bps',
  tradePrice: 'price',
  spotPrice: 'price',
  gain: 'bps',
  loss: 'bps',
  valueBefore: 'lamports',
  valueAfter: 'lamports',
  sinceReceived: 'seconds',
  sinceSent: 'seconds',
  age: 'seconds',
  firstAfterLaunch: 'seconds',
  sinceLaunch: 'seconds',
  counter: 'count',
  graduated: 'flag',
  hasEntry: 'flag',
  flag0: 'flag',
  flag1: 'flag',
  flag2: 'flag',
  flag3: 'flag',
};

export type RuleKeep = 'entry' | 'times' | 'count';
/** The header's `keeps` bits. */
export const RULE_KEEP_BITS: Record<RuleKeep, number> = { entry: 1, times: 2, count: 4 };

/** What each value needs the engine to keep (§2.3); null for one computed from the operation, the pool or the clock alone. */
export const RULE_VALUE_KEEPS: Record<RuleValueName, RuleKeep | null> = {
  amount: null,
  amountShare: null,
  balanceBefore: null,
  balanceAfter: null,
  shareAfter: null,
  tradePrice: null,
  spotPrice: null,
  gain: 'entry',
  loss: 'entry',
  valueBefore: null,
  valueAfter: null,
  sinceReceived: 'times',
  sinceSent: 'times',
  age: 'times',
  firstAfterLaunch: 'times',
  sinceLaunch: null,
  counter: 'count',
  graduated: null,
  hasEntry: 'entry',
  flag0: 'count',
  flag1: 'count',
  flag2: 'count',
  flag3: 'count',
};

export type RuleOpName = 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne';
export const RULE_OP_IDS: Record<RuleOpName, number> = { lt: 1, le: 2, gt: 3, ge: 4, eq: 5, ne: 6 };

export type RuleActionKind = 'cut' | 'refuse' | 'count' | 'flag';
export const RULE_ACTION_IDS: Record<RuleActionKind, number> = { cut: 1, refuse: 2, count: 3, flag: 4 };

export type RefuseReason = 'cooling' | 'cap' | 'locked' | 'rule';
export const REFUSE_REASON_IDS: Record<RefuseReason, number> = { cooling: 1, cap: 2, locked: 3, rule: 4 };

export type CountWhat = 'add' | 'reset';
export const COUNT_ARG_IDS: Record<CountWhat, number> = { add: 1, reset: 2 };
/** A FLAG's `arg`: bits 0..1 which flag, bit 4 set (1) or clear (0). */
export const FLAG_SET_BIT = 16;

export type RuleDestination = 'none' | 'burn' | 'creator' | 'named';
export const RULE_DESTINATION_IDS: Record<RuleDestination, number> = { none: 0, burn: 1, creator: 2, named: 3 };

export interface Atom {
  value: RuleValueName;
  op: RuleOpName;
  /** Unsigned 64-bit, in the value's unit. */
  literal: bigint;
}

export type Action = { kind: 'cut'; bps: number } | { kind: 'refuse'; reason: RefuseReason } | { kind: 'count'; what: CountWhat } | { kind: 'flag'; flag: 0 | 1 | 2 | 3; set: boolean };

export interface Rule {
  on: RuleSide[];
  when: Atom[];
  unless: Atom | null;
  then: Action;
  /** Ends the walk when this rule fires. */
  stop: boolean;
}

export interface RuleKeeps {
  entry: boolean;
  times: boolean;
  count: boolean;
}

export interface RuleSet {
  version: number;
  keeps: RuleKeeps;
  /** 0, or 1 to 5,000 with an entry kept: checked by `bind` and kept in the bytes, applied nowhere (the engine records a buy's entry at the trade's own price, uncapped). */
  entryCapBps: number;
  destination: RuleDestination;
  rules: Rule[];
}

const byId = <K extends string>(table: Record<K, number>): Map<number, K> => new Map(Object.entries(table).map(([k, v]) => [v as number, k as K]));
const VALUE_BY_ID = byId(RULE_VALUE_IDS);
const OP_BY_ID = byId(RULE_OP_IDS);
const ACTION_BY_ID = byId(RULE_ACTION_IDS);
const REASON_BY_ID = byId(REFUSE_REASON_IDS);
const COUNT_BY_ID = byId(COUNT_ARG_IDS);
const DESTINATION_BY_ID = byId(RULE_DESTINATION_IDS);
const SIDE_MASK_ALL = 31;
const KEEPS_MASK_ALL = 7;

// ---- the refusals --------------------------------------------------------------------------------------

/** Every refusal of the engine's `bind` (§2.6), by code; `RULES_ERROR_TEXT` says each in a sentence. */
export type RulesErrorCode =
  | 'length'
  | 'version'
  | 'rule_count'
  | 'keeps'
  | 'destination'
  | 'side'
  | 'value'
  | 'op'
  | 'action'
  | 'arg'
  | 'when_count'
  | 'unless_count'
  | 'slot'
  | 'literal'
  | 'cut_bps'
  | 'cut_on_burn'
  | 'cut_destination'
  | 'side_total'
  | 'keeps_entry'
  | 'keeps_times'
  | 'keeps_count'
  | 'entry_cap'
  | 'refuse_when'
  | 'refuse_marks'
  | 'destination_wallet'
  | 'config_hook'
  | 'config_flags'
  | 'config_kit_rules'
  | 'config_creator';

export const RULES_ERROR_TEXT: Record<RulesErrorCode, string> = {
  length: 'A rule set is 8 bytes and then 48 for each rule.',
  version: 'The rule set’s version is not 1.',
  rule_count: 'A rule set has 1 to 6 rules.',
  keeps: 'The header’s keeps bits are entry, times and count only.',
  destination: 'The destination is none, burn, the creator or a named wallet.',
  side: 'A rule’s sides are some of sell, buy, send, receive and burn, at least one.',
  value: 'A condition reads one of the values the engine computes.',
  op: 'A condition compares with one of lt, le, gt, ge, eq and ne.',
  action: 'A rule’s action is a cut, a refusal, a count or a mark.',
  arg: 'A refusal’s reason is cooling, cap, locked or rule; a count adds or resets; a mark names a flag 0 to 3.',
  when_count: 'A rule has at most 3 conditions.',
  unless_count: 'A rule has at most one unless.',
  slot: 'A rule’s atom slots hold its conditions and its unless, in order, and nothing else.',
  literal: 'A threshold is within its unit’s bound: at most 10,000 basis points, 365 days, 10,000 SOL, the supply, or a count of 65,535.',
  cut_bps: 'A cut is 1 to 1,500 basis points; other actions carry none.',
  cut_on_burn: 'A cut cannot be taken on a burn.',
  cut_destination: 'A cut needs a destination: burn, the creator or a named wallet.',
  side_total: 'The cuts on one side add up to at most 1,500 basis points.',
  keeps_entry: 'A condition on gain, loss or the entry price needs the set to keep an entry price.',
  keeps_times: 'A condition on a time since receiving, sending, the first tokens or the holding’s age needs the set to keep times.',
  keeps_count: 'A count, a mark or a condition on one needs the set to keep a counter.',
  entry_cap: 'The entry cap is 1 to 5,000 basis points and needs the set to keep an entry price.',
  refuse_when: 'A refusal needs at least one condition.',
  refuse_marks: 'A refusal of a sell, a send or a burn must turn on time, amount, balance, share, price or value, not on a mark or the count alone.',
  destination_wallet: 'A named destination is a wallet on the curve, not the default key.',
  config_hook: 'The config does not name the rules engine as its custom hook.',
  config_flags: 'The config’s hook flags are not the ones the rules need.',
  config_kit_rules: 'A composed config carries no kit rules.',
  config_creator: 'Only the config’s creator binds rules to it.',
};

export const RULES_ERROR_CODES: readonly RulesErrorCode[] = Object.keys(RULES_ERROR_TEXT) as RulesErrorCode[];

/** One refusal: its code, the rule it is about (0-based; null for the set), and the sentence. */
export interface RulesProblem {
  code: RulesErrorCode;
  rule: number | null;
  text: string;
}

export class RulesError extends Error {
  readonly code: RulesErrorCode;
  readonly rule: number | null;
  constructor(code: RulesErrorCode, rule: number | null = null) {
    super(rule === null ? RULES_ERROR_TEXT[code] : `Rule ${rule + 1}: ${RULES_ERROR_TEXT[code]}`);
    this.name = 'RulesError';
    this.code = code;
    this.rule = rule;
  }
}

const problem = (code: RulesErrorCode, rule: number | null = null): RulesProblem => ({ code, rule, text: rule === null ? RULES_ERROR_TEXT[code] : `Rule ${rule + 1}: ${RULES_ERROR_TEXT[code]}` });

// ---- the bytes ------------------------------------------------------------------------------------------

export const rulesBytesLength = (ruleCount: number): number => RULES_HEADER_BYTES + RULE_BYTES * ruleCount;

/** `on` as its mask. */
export const sideMask = (on: readonly RuleSide[]): number => on.reduce((m, s) => m | (RULE_SIDE_BITS[s] ?? 0), 0);

/** A mask as its sides, in the doc's order; unknown bits are dropped (the validator refuses them). */
export const sidesOf = (mask: number): RuleSide[] => RULE_SIDES.filter((s) => (mask & RULE_SIDE_BITS[s]) !== 0);

export const keepsMask = (k: RuleKeeps): number => (k.entry ? RULE_KEEP_BITS.entry : 0) | (k.times ? RULE_KEEP_BITS.times : 0) | (k.count ? RULE_KEEP_BITS.count : 0);

/** An action's `(action, arg, bps)` bytes. */
export function actionBytes(a: Action): { action: number; arg: number; bps: number } {
  switch (a.kind) {
    case 'cut':
      return { action: RULE_ACTION_IDS.cut, arg: 0, bps: a.bps };
    case 'refuse':
      return { action: RULE_ACTION_IDS.refuse, arg: REFUSE_REASON_IDS[a.reason] ?? 0, bps: 0 };
    case 'count':
      return { action: RULE_ACTION_IDS.count, arg: COUNT_ARG_IDS[a.what] ?? 0, bps: 0 };
    case 'flag':
      return { action: RULE_ACTION_IDS.flag, arg: (a.flag & 3) | (a.set ? FLAG_SET_BIT : 0), bps: 0 };
  }
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * The set's bytes (§1.2): the header, then each rule, its `when` atoms in the first slots and its
 * `unless` in the next, the rest zero. Encodes what it is given; `validateRules` says whether the
 * engine will take it. Throws `RulesError` only for what has no encoding (more atoms than slots, a
 * literal past u64, more than 255 rules).
 */
export function encodeRules(set: RuleSet): Uint8Array {
  if (set.rules.length > 255) throw new RulesError('rule_count');
  const out = new Uint8Array(rulesBytesLength(set.rules.length));
  const view = new DataView(out.buffer);
  out[0] = set.version & 255;
  out[1] = keepsMask(set.keeps);
  view.setUint16(2, set.entryCapBps & 0xffff, true);
  out[4] = set.rules.length;
  out[5] = RULE_DESTINATION_IDS[set.destination] ?? 0;
  view.setUint16(6, 0, true);
  set.rules.forEach((r, i) => {
    const at = RULES_HEADER_BYTES + RULE_BYTES * i;
    const atoms = [...r.when, ...(r.unless ? [r.unless] : [])];
    if (atoms.length > RULE_ATOM_SLOTS) throw new RulesError('slot', i);
    out[at] = sideMask(r.on);
    out[at + 1] = r.when.length;
    out[at + 2] = r.unless ? 1 : 0;
    out[at + 3] = r.stop ? 1 : 0;
    const a = actionBytes(r.then);
    out[at + 4] = a.action;
    out[at + 5] = a.arg;
    view.setUint16(at + 6, a.bps & 0xffff, true);
    atoms.forEach((atom, j) => {
      const slot = at + 8 + ATOM_BYTES * j;
      if (atom.literal < 0n || atom.literal > U64_MAX) throw new RulesError('literal', i);
      out[slot] = RULE_VALUE_IDS[atom.value] ?? 0;
      out[slot + 1] = RULE_OP_IDS[atom.op] ?? 0;
      view.setBigUint64(slot + 2, atom.literal, true);
    });
  });
  return out;
}

/**
 * A set from its bytes, refusing with the engine's own code what the layout cannot hold: the
 * length, the version, the count, unknown keeps bits, an unknown destination, side, value, op,
 * action or arg, counts past 3 and 1, a filled slot beyond them, a `bps` on an action that is not a
 * cut. The bounds that need the whole set (`validateRules`) are checked after; `checkRulesBytes`
 * does both.
 */
export function decodeRules(bytes: Uint8Array): RuleSet {
  if (bytes.length < RULES_HEADER_BYTES) throw new RulesError('length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[0]!;
  if (version !== RULES_VERSION) throw new RulesError('version');
  const keeps = bytes[1]!;
  if ((keeps & ~KEEPS_MASK_ALL) !== 0) throw new RulesError('keeps');
  const entryCapBps = view.getUint16(2, true);
  const count = bytes[4]!;
  if (count < 1 || count > RULES_LIMITS.rules) throw new RulesError('rule_count');
  const destination = DESTINATION_BY_ID.get(bytes[5]!);
  if (destination === undefined) throw new RulesError('destination');
  if (bytes.length !== rulesBytesLength(count)) throw new RulesError('length');
  const rules: Rule[] = [];
  for (let i = 0; i < count; i++) {
    const at = RULES_HEADER_BYTES + RULE_BYTES * i;
    const mask = bytes[at]!;
    if (mask === 0 || (mask & ~SIDE_MASK_ALL) !== 0) throw new RulesError('side', i);
    const whenN = bytes[at + 1]!;
    const unlessN = bytes[at + 2]!;
    if (whenN > RULES_LIMITS.when) throw new RulesError('when_count', i);
    if (unlessN > RULES_LIMITS.unless) throw new RulesError('unless_count', i);
    const stop = bytes[at + 3]! !== 0;
    const actionKind = ACTION_BY_ID.get(bytes[at + 4]!);
    if (actionKind === undefined) throw new RulesError('action', i);
    const arg = bytes[at + 5]!;
    const bps = view.getUint16(at + 6, true);
    let then: Action;
    if (actionKind === 'cut') {
      if (arg !== 0) throw new RulesError('arg', i);
      then = { kind: 'cut', bps };
    } else {
      if (bps !== 0) throw new RulesError('cut_bps', i);
      if (actionKind === 'refuse') {
        const reason = REASON_BY_ID.get(arg);
        if (reason === undefined) throw new RulesError('arg', i);
        then = { kind: 'refuse', reason };
      } else if (actionKind === 'count') {
        const what = COUNT_BY_ID.get(arg);
        if (what === undefined) throw new RulesError('arg', i);
        then = { kind: 'count', what };
      } else {
        if ((arg & ~(3 | FLAG_SET_BIT)) !== 0) throw new RulesError('arg', i);
        then = { kind: 'flag', flag: (arg & 3) as 0 | 1 | 2 | 3, set: (arg & FLAG_SET_BIT) !== 0 };
      }
    }
    const atoms: Atom[] = [];
    for (let j = 0; j < RULE_ATOM_SLOTS; j++) {
      const slot = at + 8 + ATOM_BYTES * j;
      const valueId = bytes[slot]!;
      const opId = bytes[slot + 1]!;
      const literal = view.getBigUint64(slot + 2, true);
      if (j >= whenN + unlessN) {
        if (valueId !== 0 || opId !== 0 || literal !== 0n) throw new RulesError('slot', i);
        continue;
      }
      const value = VALUE_BY_ID.get(valueId);
      if (value === undefined) throw new RulesError('value', i);
      const op = OP_BY_ID.get(opId);
      if (op === undefined) throw new RulesError('op', i);
      atoms.push({ value, op, literal });
    }
    rules.push({ on: sidesOf(mask), when: atoms.slice(0, whenN), unless: unlessN === 1 ? atoms[whenN]! : null, then, stop });
  }
  return { version, keeps: { entry: (keeps & RULE_KEEP_BITS.entry) !== 0, times: (keeps & RULE_KEEP_BITS.times) !== 0, count: (keeps & RULE_KEEP_BITS.count) !== 0 }, entryCapBps, destination, rules };
}

export const rulesToHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function rulesFromHex(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new RulesError('length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---- the validator --------------------------------------------------------------------------------------

/** The bound a value's literal keeps to. */
export const literalBound = (value: RuleValueName): bigint => RULES_LIMITS.literal[RULE_VALUE_UNITS[value]];

/** Whether a value turns on a holding's own marks (a flag or the counter): never enough for a refusal of a sell, a send or a burn (§2.6). */
export const isMarkValue = (value: RuleValueName): boolean => RULE_VALUE_KEEPS[value] === 'count';

const CUT_SIDES: readonly RuleSide[] = ['sell', 'buy', 'send', 'receive'];

/**
 * Every refusal of §2.6 that the bytes alone do not catch, in order, each once per rule: the codes
 * the engine's `bind` answers with. Empty when the engine will take the set. `validateRules` reads
 * a typed set; `checkRulesBytes` decodes first.
 */
export function validateRules(set: RuleSet): RulesProblem[] {
  const out: RulesProblem[] = [];
  if (set.version !== RULES_VERSION) out.push(problem('version'));
  if (set.rules.length < 1 || set.rules.length > RULES_LIMITS.rules) out.push(problem('rule_count'));
  if (!(set.destination in RULE_DESTINATION_IDS)) out.push(problem('destination'));
  if (!Number.isInteger(set.entryCapBps) || set.entryCapBps < 0 || set.entryCapBps > RULES_LIMITS.entryCapBps || (set.entryCapBps > 0 && !set.keeps.entry)) out.push(problem('entry_cap'));
  const totals: Record<RuleSide, number> = { sell: 0, buy: 0, send: 0, receive: 0, burn: 0 };
  set.rules.forEach((r, i) => {
    const seen = new Set<RulesErrorCode>();
    const add = (code: RulesErrorCode): void => {
      if (!seen.has(code)) {
        seen.add(code);
        out.push(problem(code, i));
      }
    };
    if (r.on.length === 0 || r.on.some((s) => !(s in RULE_SIDE_BITS)) || new Set(r.on).size !== r.on.length) add('side');
    if (r.when.length > RULES_LIMITS.when) add('when_count');
    const atoms = [...r.when, ...(r.unless ? [r.unless] : [])];
    for (const atom of atoms) {
      if (!(atom.value in RULE_VALUE_IDS)) {
        add('value');
        continue;
      }
      if (!(atom.op in RULE_OP_IDS)) add('op');
      if (typeof atom.literal !== 'bigint' || atom.literal < 0n || atom.literal > literalBound(atom.value)) add('literal');
      const keep = RULE_VALUE_KEEPS[atom.value];
      if (keep === 'entry' && !set.keeps.entry) add('keeps_entry');
      if (keep === 'times' && !set.keeps.times) add('keeps_times');
      if (keep === 'count' && !set.keeps.count) add('keeps_count');
    }
    const a = r.then;
    if (!a || !(a.kind in RULE_ACTION_IDS)) add('action');
    else if (a.kind === 'cut') {
      if (!Number.isInteger(a.bps) || a.bps < 1 || a.bps > RULES_LIMITS.cutBps) add('cut_bps');
      if (r.on.includes('burn')) add('cut_on_burn');
      if (set.destination === 'none') add('cut_destination');
      for (const s of r.on) if (s in totals) totals[s] += Number.isInteger(a.bps) && a.bps > 0 ? a.bps : 0;
    } else if (a.kind === 'refuse') {
      if (!(a.reason in REFUSE_REASON_IDS)) add('arg');
      if (r.when.length === 0) add('refuse_when');
      else if (r.on.some((s) => s === 'sell' || s === 'send' || s === 'burn') && r.when.every((atom) => atom.value in RULE_VALUE_IDS && isMarkValue(atom.value))) add('refuse_marks');
    } else if (a.kind === 'count') {
      if (!(a.what in COUNT_ARG_IDS)) add('arg');
      if (!set.keeps.count) add('keeps_count');
    } else {
      if (!Number.isInteger(a.flag) || a.flag < 0 || a.flag > 3) add('arg');
      if (!set.keeps.count) add('keeps_count');
    }
  });
  for (const s of CUT_SIDES) if (totals[s] > RULES_LIMITS.sideCutBps) out.push(problem('side_total'));
  return out;
}

/** Decodes and validates: the problems, or the set. */
export function checkRulesBytes(bytes: Uint8Array): { set: RuleSet; problems: RulesProblem[] } | { set: null; problems: RulesProblem[] } {
  let set: RuleSet;
  try {
    set = decodeRules(bytes);
  } catch (e) {
    if (e instanceof RulesError) return { set: null, problems: [problem(e.code, e.rule)] };
    throw e;
  }
  return { set, problems: validateRules(set) };
}

/** The set, or the first refusal thrown (the builder's `build`). */
export function assertRules(set: RuleSet): RuleSet {
  const [first] = validateRules(set);
  if (first) throw new RulesError(first.code, first.rule);
  return set;
}

// ---- the flags ------------------------------------------------------------------------------------------

/**
 * The token hook flags a set needs (`flags_for`, §2): `BEFORE_TRANSFER` always;
 * `TRANSFER_RETURNS_DELTA` with any cut; `BEFORE_BURN` with any rule on burns (so a burn rule runs
 * even in a set that keeps nothing); `BEFORE_BURN | WRITES_HOOK_DATA` with any keeps bit, a count
 * or a mark. The config must name exactly these (`config_flags`).
 */
export function rulesFlagsOf(set: RuleSet): number {
  let flags: number = TOKEN_HOOK_FLAGS.BEFORE_TRANSFER;
  if (set.rules.some((r) => r.then.kind === 'cut')) flags |= TOKEN_HOOK_FLAGS.TRANSFER_RETURNS_DELTA;
  if (set.rules.some((r) => r.on.includes('burn'))) flags |= TOKEN_HOOK_FLAGS.BEFORE_BURN;
  if (keepsMask(set.keeps) !== 0 || set.rules.some((r) => r.then.kind === 'count' || r.then.kind === 'flag')) flags |= TOKEN_HOOK_FLAGS.BEFORE_BURN | TOKEN_HOOK_FLAGS.WRITES_HOOK_DATA;
  return flags;
}

// ---- numbers in words ------------------------------------------------------------------------------------

const group = (whole: bigint): string => {
  const s = whole.toString();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
};

/** A fixed-point value with `decimals`, rounded half up to `places`, trailing zeros trimmed, the whole part grouped. */
export function decimalWords(value: bigint, decimals: number, places: number): string {
  const drop = decimals - places;
  const scaled = drop > 0 ? (value + 10n ** BigInt(drop) / 2n) / 10n ** BigInt(drop) : value * 10n ** BigInt(-drop);
  const unit = 10n ** BigInt(places);
  const whole = scaled / unit;
  const frac = places > 0 ? (scaled % unit).toString().padStart(places, '0').replace(/0+$/, '') : '';
  return frac ? `${group(whole)}.${frac}` : group(whole);
}

/** Basis points as a percent: 500 -> 5%, 25 -> 0.25%, 1,500 -> 15%. */
export const pctWords = (bps: bigint | number): string => `${decimalWords(BigInt(bps), 2, 2)}%`;
/** Lamports as SOL, to three places: 6,500,000,000 -> 6.5. */
export const solWords = (lamports: bigint): string => decimalWords(lamports, 9, 3);
/** Base units as whole tokens (to six places when not whole), with the ticker, or "tokens". */
export const tokenWords = (base: bigint, symbol: string | null | undefined): string => `${decimalWords(base, TOKEN_DECIMALS, TOKEN_DECIMALS)} ${symbol?.trim() || 'tokens'}`;
/** A price (lamports per base unit times 10^12) as SOL per whole token: `p * 10^decimals / 10^21`. */
export const priceWords = (price: bigint): string => decimalWords(price, 21 - TOKEN_DECIMALS, 9);

/** A length of time in a sentence: a minute, 10 minutes, an hour, 6 hours, a day, 30 days, 30 seconds. With `article` false, the noun alone for one unit: "the first minute", "the first day". */
export function durationWords(secs: bigint | number, article = true): string {
  const s = BigInt(secs);
  const unit = (n: bigint, one: string, many: string): string => (n === 1n ? (article ? `${one === 'hour' ? 'an' : 'a'} ${one}` : one) : `${group(n)} ${many}`);
  if (s >= 86_400n && s % 86_400n === 0n) return unit(s / 86_400n, 'day', 'days');
  if (s >= 3_600n && s % 3_600n === 0n) return unit(s / 3_600n, 'hour', 'hours');
  if (s >= 60n && s % 60n === 0n) return unit(s / 60n, 'minute', 'minutes');
  return unit(s, 'second', 'seconds');
}

const timesWords = (n: bigint): string => (n === 1n ? 'once' : n === 2n ? 'twice' : `${group(n)} times`);

/** A wallet address shortened for a sentence. */
export const shortWallet = (wallet: string): string => (wallet.length > 12 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet);

// ---- the phrase table (§3) ----------------------------------------------------------------------------------

/** The words of a rule's sides: one ("sell or transfer"), many ("sells or transfers"), the verbs of a refusal ("sell or send"). */
export interface SideWords {
  one: string;
  many: string;
  verbs: string;
}

const SIDE_ONE: Record<RuleSide, string> = { sell: 'sell', buy: 'buy', send: 'transfer', receive: 'transfer', burn: 'burn' };
const SIDE_MANY: Record<RuleSide, string> = { sell: 'sells', buy: 'buys', send: 'transfers', receive: 'transfers', burn: 'burns' };

const joinOr = (words: string[]): string => (words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`);
const dedupe = (words: string[]): string[] => words.filter((w, i) => words.indexOf(w) === i);

export function sideWords(on: readonly RuleSide[]): SideWords {
  const ordered = RULE_SIDES.filter((s) => on.includes(s));
  return { one: joinOr(dedupe(ordered.map((s) => SIDE_ONE[s]))), many: joinOr(dedupe(ordered.map((s) => SIDE_MANY[s]))), verbs: joinOr(ordered) };
}

interface Phrase {
  /** After "every sell": "by a holder in profit". */
  when: string;
  /** After "A wallet": "that received tokens less than an hour ago". */
  relative: string;
  /** After "cannot sell or send": "until an hour after launch" (the launch clock alone); null otherwise. */
  trailing: string | null;
  /** As an unless clause: "unless in profit", "until graduation". */
  unless: string;
  /** The second sentence of a cut with this one condition; null when there is none to say. */
  complement: ((w: SideWords) => string) | null;
}

const OP_WORDS: Record<RuleOpName, string> = { lt: 'under', le: 'at most', gt: 'over', ge: 'at least', eq: 'exactly', ne: 'other than' };

const phrase = (when: string, relative: string, complement: ((w: SideWords) => string) | null = null, unless = `unless ${relative}`, trailing: string | null = null): Phrase => ({ when, relative, trailing, unless, complement });

/** "more than 5%", "5% or more", "less than 5%", "5% or less", "exactly 5%", "other than 5%". */
function bound(op: RuleOpName, x: string): string {
  switch (op) {
    case 'gt':
      return `more than ${x}`;
    case 'ge':
      return `${x} or more`;
    case 'lt':
      return `less than ${x}`;
    case 'le':
      return `${x} or less`;
    case 'eq':
      return `exactly ${x}`;
    case 'ne':
      return `other than ${x}`;
  }
}

/** The complement of a bound: who is on the other side of it. */
function otherSide(op: RuleOpName, x: string): string | null {
  switch (op) {
    case 'gt':
      return `${x} or less`;
    case 'ge':
      return `less than ${x}`;
    case 'lt':
      return `${x} or more`;
    case 'le':
      return `more than ${x}`;
    default:
      return null;
  }
}

/** A 0-or-1 value's reading: true, false, or neither (a comparison that holds for both or neither). */
function truth(atom: Atom): boolean | null {
  const holds = (v: bigint): boolean => {
    switch (atom.op) {
      case 'lt':
        return v < atom.literal;
      case 'le':
        return v <= atom.literal;
      case 'gt':
        return v > atom.literal;
      case 'ge':
        return v >= atom.literal;
      case 'eq':
        return v === atom.literal;
      case 'ne':
        return v !== atom.literal;
    }
  };
  const t0 = holds(0n);
  const t1 = holds(1n);
  return t1 && !t0 ? true : t0 && !t1 ? false : null;
}

const smallerBags = (w: SideWords): string => `Smaller bags ${w.one} free.`;
const biggerBags = (w: SideWords): string => `Bigger bags ${w.one} free.`;
const above = (op: RuleOpName): boolean => op === 'gt' || op === 'ge';
const below = (op: RuleOpName): boolean => op === 'lt' || op === 'le';

/** The phrases of one atom (the table of §3, every value and op given a reading so the function is total). */
export function phraseOf(atom: Atom, symbol: string | null | undefined): Phrase {
  const { value, op, literal: x } = atom;
  const sym = symbol?.trim() || 'tokens';
  switch (value) {
    case 'gain':
    case 'loss': {
      const under = value === 'loss';
      const inState = under ? 'under water' : 'in profit';
      const outState = under ? 'in profit' : 'under water';
      if ((op === 'gt' || op === 'ne') && x === 0n) return phrase(`by a holder ${inState}`, inState, (w) => `Holders ${outState} ${w.one} free.`);
      if ((op === 'eq' || op === 'le') && x === 0n) return phrase(`by a holder not ${inState}`, `not ${inState}`, (w) => `Holders ${inState} ${w.one} free.`);
      const dir = under ? 'down' : 'up';
      const b = bound(op, pctWords(x));
      const other = otherSide(op, pctWords(x));
      return phrase(`by a holder ${dir} ${b}`, `${dir} ${b}`, other ? (w) => `Holders ${dir} ${other} ${w.one} free.` : null);
    }
    case 'valueBefore':
    case 'valueAfter': {
      const sol = `${solWords(x)} SOL`;
      const worth = value === 'valueAfter' ? 'would be worth' : 'is worth';
      const words = op === 'gt' ? `over ${sol}` : op === 'lt' ? `under ${sol}` : bound(op, sol);
      const rel = `whose bag ${worth} ${words}${value === 'valueAfter' ? ' afterwards' : ''}`;
      return phrase(`by a holder ${rel}`, rel, above(op) ? smallerBags : below(op) ? biggerBags : null);
    }
    case 'balanceBefore': {
      const b = bound(op, tokenWords(x, sym));
      return phrase(`by a holder with ${b}`, `holding ${b}`, above(op) ? smallerBags : below(op) ? biggerBags : null);
    }
    case 'balanceAfter': {
      const rel = `that would leave a wallet with ${bound(op, tokenWords(x, sym))}`;
      return phrase(rel, rel);
    }
    case 'shareAfter': {
      const p = pctWords(x);
      const words = op === 'gt' ? `over ${p}` : op === 'lt' ? `under ${p}` : op === 'ge' ? `at ${p} or more` : op === 'le' ? `at ${p} or less` : `at ${bound(op, p)}`;
      const rel = `that would leave a wallet ${words} of the supply`;
      return phrase(rel, rel);
    }
    case 'amount':
    case 'amountShare': {
      const b = bound(op, value === 'amount' ? tokenWords(x, sym) : `${pctWords(x)} of the supply`);
      return phrase(`of ${b}`, `moving ${b}`, above(op) ? (w) => `Smaller ${w.many} pass free.` : below(op) ? (w) => `Bigger ${w.many} pass free.` : null);
    }
    case 'sinceReceived':
    case 'sinceSent': {
      const t = durationWords(x);
      const got = value === 'sinceReceived' ? 'received' : 'sent';
      const getting = value === 'sinceReceived' ? 'receiving' : 'sending';
      if (op === 'lt' || op === 'le') return phrase(`within ${t} of ${getting} tokens`, `that ${got} tokens ${op === 'lt' ? `less than ${t}` : `${t} or less`} ago`, () => `After ${t}, free.`);
      if (op === 'gt' || op === 'ge') return phrase(`${op === 'gt' ? `more than ${t}` : `${t} or more`} after ${getting} tokens`, `that ${got} tokens ${op === 'gt' ? `more than ${t}` : `${t} or more`} ago`, () => `Within ${t}, free.`);
      const rel = `that ${got} tokens ${bound(op, t)} ago`;
      return phrase(`by a wallet ${rel}`, rel);
    }
    case 'age': {
      const t = durationWords(x);
      const rel = `that first got tokens ${bound(op, t)} ago`;
      return phrase(`by a wallet ${rel}`, rel, below(op) ? () => `After ${t}, free.` : above(op) ? (w) => `Newer wallets ${w.one} free.` : null);
    }
    case 'firstAfterLaunch': {
      const t = durationWords(x);
      const rel = below(op) ? `whose first tokens arrived in the first ${durationWords(x, false)} after launch` : `whose first tokens arrived ${bound(op, t)} after launch`;
      return phrase(`by a wallet ${rel}`, rel, below(op) ? (w) => `Later wallets ${w.one} free.` : above(op) ? (w) => `Earlier wallets ${w.one} free.` : null);
    }
    case 'sinceLaunch': {
      const t = durationWords(x);
      const first = `in the first ${durationWords(x, false)} after launch`;
      if (below(op)) return phrase(first, first, (w) => `After that, ${w.many} pass free.`, `unless ${first}`, `until ${t} after launch`);
      if (above(op)) return phrase(`from ${t} after launch`, `from ${t} after launch`, (w) => `Before that, ${w.many} pass free.`, `unless from ${t} after launch`, `from ${t} after launch`);
      const rel = `${bound(op, t)} after launch`;
      return phrase(rel, rel, null, `unless ${rel}`, rel);
    }
    case 'tradePrice':
    case 'spotPrice': {
      const p = `${priceWords(x)} SOL per ${sym}`;
      const words = op === 'gt' ? `over ${p}` : op === 'lt' ? `under ${p}` : bound(op, p);
      const rel = value === 'tradePrice' ? `at a price ${words}` : `while the price is ${words}`;
      return phrase(rel, rel, above(op) ? (w) => `At lower prices, ${w.many} pass free.` : below(op) ? (w) => `At higher prices, ${w.many} pass free.` : null);
    }
    case 'counter': {
      const n = timesWords(x);
      const rel = `counted ${op === 'gt' ? `more than ${n}` : op === 'ge' ? `${n} or more` : op === 'lt' ? `fewer than ${n}` : op === 'le' ? `${n} or fewer` : bound(op, n)}`;
      return phrase(`by a holder ${rel}`, rel);
    }
    case 'graduated': {
      const t = truth(atom);
      if (t === true) return phrase('after graduation', 'after graduation', null, 'until graduation');
      if (t === false) return phrase('before graduation', 'before graduation', null, 'after graduation');
      break;
    }
    case 'hasEntry': {
      const t = truth(atom);
      if (t === true) return phrase('by a holder with an entry price', 'with an entry price', null, 'unless it has an entry price');
      if (t === false) return phrase('by a holder with no entry price', 'with no entry price', null, 'unless it has no entry price');
      break;
    }
    case 'flag0':
    case 'flag1':
    case 'flag2':
    case 'flag3': {
      const k = RULE_VALUE_IDS[value] - RULE_VALUE_IDS.flag0;
      const mark = k === 0 ? 'marked' : `marked ${k}`;
      const t = truth(atom);
      if (t === true) return phrase(`by a ${mark} holder`, `that is ${mark}`);
      if (t === false) return phrase(`by a holder not ${mark}`, `that is not ${mark}`);
      break;
    }
  }
  // A comparison that always or never holds on a 0-or-1 value: said in the mechanical words.
  const rel = `whose ${value} is ${OP_WORDS[op]} ${x.toString()}`;
  return phrase(`by a holder ${rel}`, rel);
}

// ---- the sentences ------------------------------------------------------------------------------------------

export interface RenderOptions {
  /** The named destination's wallet, for the sentence; absent: "a named wallet". */
  destinationWallet?: string | null;
  /** The ticker, for amounts; absent: "tokens". */
  symbol?: string | null;
}

/** The most a set takes per side, basis points of the amount, summed over every cut rule on the side, conditions and `stop` ignored (§3). */
export interface MostTakes {
  sell: number;
  buy: number;
  /** A transfer's sender and receiver cuts together (both sides answer in one return). */
  transfer: number;
  /** The largest of the three. */
  bps: number;
  /** "5% of a sell; nothing from buys or transfers", or "Takes nothing." */
  text: string;
}

/** What `renderRules` gives: the sentences in rule order (one or two per rule), the worst case, the flags, the generated notes and what the set keeps. */
export interface RulesWords {
  sentences: string[];
  mostTakes: MostTakes;
  flags: number;
  watch: WorkshopReading['watch'];
  /** What the engine keeps per holding for this set, in words; empty when nothing. */
  keeps: string[];
}

const SUBJECT_PREFIXES = ['by a holder ', 'by a wallet ', 'by a buyer '];

/** The when atoms as one clause: " by a holder in profit and whose bag is worth over 6.5 SOL". */
function whenClause(phrases: Phrase[]): string {
  let out = '';
  let prev: string | null = null;
  for (const p of phrases) {
    const prefix = SUBJECT_PREFIXES.find((s) => p.when.startsWith(s) && prev !== null && prev.startsWith(s));
    out += prefix ? ` and ${p.when.slice(prefix.length)}` : ` ${p.when}`;
    prev = p.when;
  }
  return out;
}

function destinationWords(set: RuleSet, opts: RenderOptions): string {
  switch (set.destination) {
    case 'burn':
      return 'burned';
    case 'creator':
      return 'paid to the creator';
    case 'named':
      return `paid to ${opts.destinationWallet ? shortWallet(opts.destinationWallet) : 'a named wallet'}`;
    default:
      return 'paid nowhere';
  }
}

/** The max-wallet shape (§3): buys and receives refused on the share a wallet would hold, alone, until graduation or for ever. */
function maxWalletSentence(r: Rule): string | null {
  if (r.then.kind !== 'refuse' || r.when.length !== 1 || sideMask(r.on) !== (RULE_SIDE_BITS.buy | RULE_SIDE_BITS.receive)) return null;
  const [a] = r.when;
  if (!a || a.value !== 'shareAfter' || (a.op !== 'gt' && a.op !== 'ge')) return null;
  if (r.unless && !(r.unless.value === 'graduated' && truth(r.unless) === true)) return null;
  const p = pctWords(a.literal);
  return `No wallet can hold ${a.op === 'gt' ? `more than ${p}` : `${p} or more`} of the supply${r.unless ? ' until graduation' : ''}.`;
}

const SENDER_SIDES: readonly RuleSide[] = ['sell', 'send', 'burn'];
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** One rule's sentences (one or two), per §3's templates. */
export function renderRule(r: Rule, set: RuleSet, opts: RenderOptions = {}): string[] {
  const w = sideWords(r.on);
  const whens = r.when.map((a) => phraseOf(a, opts.symbol));
  const unless = r.unless ? ` ${phraseOf(r.unless, opts.symbol).unless}` : '';
  const out: string[] = [];
  if (r.then.kind === 'cut') {
    out.push(`Takes ${pctWords(r.then.bps)} of every ${w.one}${whenClause(whens)}${unless}, ${destinationWords(set, opts)}.`);
    if (whens.length === 1) {
      const c = whens[0]!.complement?.(w);
      if (c) out.push(c);
    } else if (whens.length > 1) out.push(`Every other ${w.one} passes free.`);
  } else if (r.then.kind === 'refuse') {
    const special = maxWalletSentence(r);
    if (special) out.push(special);
    else {
      const sender = r.on.some((s) => SENDER_SIDES.includes(s));
      const subject = sender ? 'A wallet' : 'A buyer';
      const relatives = whens.filter((p) => p.trailing === null).map((p) => p.relative);
      const trailing = whens.flatMap((p) => (p.trailing === null ? [] : [p.trailing]));
      const rel = relatives.length ? ` ${relatives.join(' and ')}` : '';
      const tail = trailing.length ? ` ${trailing.join(' and ')}` : '';
      out.push(`${subject}${rel} cannot ${w.verbs}${sender && !tail ? ' them' : ''}${tail}${unless}.`);
    }
  } else if (r.then.kind === 'count') {
    out.push(r.then.what === 'add' ? `Counts each ${w.one} a holder makes${whenClause(whens)}${unless}.` : `Resets a holder’s count on each ${w.one}${whenClause(whens)}${unless}.`);
  } else {
    const mark = r.then.flag === 0 ? '' : ` with mark ${r.then.flag}`;
    out.push(`${r.then.set ? 'Marks' : 'Unmarks'} a wallet${mark} on its ${w.one}${whenClause(whens)}${unless}.`);
  }
  if (r.stop && r.then.kind !== 'refuse') out.push(`No later rule applies to that ${w.one}.`);
  return out.map(capital);
}

/** The most a set takes per side (§3): summed, never measured. */
export function mostTakesOf(set: RuleSet): MostTakes {
  const sum = (side: RuleSide): number => set.rules.reduce((t, r) => t + (r.then.kind === 'cut' && r.on.includes(side) ? r.then.bps : 0), 0);
  const sell = sum('sell');
  const buy = sum('buy');
  const transfer = sum('send') + sum('receive');
  const sides: [string, string, number][] = [
    ['sell', 'sells', sell],
    ['buy', 'buys', buy],
    ['transfer', 'transfers', transfer],
  ];
  const takes = sides.filter(([, , bps]) => bps > 0).map(([one, , bps]) => `${pctWords(bps)} of a ${one}`);
  const free = sides.filter(([, , bps]) => bps === 0).map(([, many]) => many);
  const text = takes.length === 0 ? 'Takes nothing.' : `${takes.join(', ')}${free.length ? `; nothing from ${joinOr(free)}` : ''}`;
  return { sell, buy, transfer, bps: Math.max(sell, buy, transfer), text };
}

const PRICE_OR_TIME: readonly RuleValueName[] = ['tradePrice', 'spotPrice', 'gain', 'loss', 'valueBefore', 'valueAfter', 'sinceReceived', 'sinceSent', 'age', 'firstAfterLaunch', 'sinceLaunch'];

/** What the engine keeps for a set, in words. */
export function keepsWords(set: RuleSet): string[] {
  const out: string[] = [];
  if (set.keeps.entry) out.push('an entry price per holding');
  if (set.keeps.times) out.push('when tokens arrived and left');
  if (set.keeps.count) out.push('a counter and marks');
  return out;
}

/**
 * The reading of a set (§3): the sentences in rule order, the most it takes, the flags and the
 * generated notes. Total and deterministic: the same bytes give the same words in the SDK, on the
 * site, in the API and in the engine's tests.
 */
export function renderRules(set: RuleSet, opts: RenderOptions = {}): RulesWords {
  const sentences = set.rules.flatMap((r) => renderRule(r, set, opts));
  const mostTakes = mostTakesOf(set);
  const watch: WorkshopReading['watch'] = [];
  const cutSides = RULE_SIDES.filter((s) => set.rules.some((r) => r.then.kind === 'cut' && r.on.includes(s)));
  if (cutSides.length > 0 && (set.destination === 'creator' || set.destination === 'named')) {
    const whose = set.destination === 'creator' ? 'The creator’s' : `${opts.destinationWallet ? shortWallet(opts.destinationWallet) : 'The named wallet’s'}`;
    watch.push({ severity: 'medium', text: `${whose}${set.destination === 'named' && opts.destinationWallet ? '’s' : ''} holding must exist for the cut to be paid; until then ${sideWords(cutSides).many} pass free.` });
  }
  if (set.keeps.entry) watch.push({ severity: 'low', text: 'Entry prices are average cost: a buy at a higher price raises the holder’s basis.' });
  if (set.rules.some((r) => [...r.when, ...(r.unless ? [r.unless] : [])].some((a) => PRICE_OR_TIME.includes(a.value)))) watch.push({ severity: 'low', text: 'After graduation, adding liquidity reads as a sell and removing it as a buy.' });
  return { sentences, mostTakes, flags: rulesFlagsOf(set), watch, keeps: keepsWords(set) };
}

// ---- the synthetic reading ----------------------------------------------------------------------------------

/** The lane's own words on the site: the lane, its verdict word and the line over a composed hook's sentences. */
export const RULES_LANE = 'rules';
export const RULES_VERDICT_WORD = 'Read from its rules';
export const RULES_COMPOSED_LINE = 'Composed from Bordrless rules';
/** What the inspection says of a config that names the engine with no rules bound (§4). */
export const RULES_UNBOUND_PROBLEM = 'This config names the rules engine but has no rules bound: it cannot launch.';

/** The set as the API carries it beside the sentences (`RulesReadout`): the bytes (hex) and what they say. */
export interface RulesReadout {
  version: number;
  bytes: string;
  sentences: string[];
  mostTakes: MostTakes;
  flags: number;
  destination: RuleDestination;
  destinationWallet: string | null;
  keeps: RuleKeep[];
  entryCapBps: number;
}

/**
 * The reading of a composed hook in the shape every surface already shows (`HookReading`), with the
 * lane's own lane and verdict words: `reading.does` the sentences, `total` the computed figure (never
 * measured: `measuredCutBps` null), `watch` the generated notes, and `rules` the set itself. The API
 * serves the words alone (`rulesReadingWords`) and the set once, as `customHook.rules`.
 */
export interface RulesHookReading extends Omit<HookReading, 'verdict' | 'lane' | 'measuredCutBps' | 'kind' | 'reading'> {
  kind: 'hook';
  /** Always present: the words are the bytes. */
  reading: WorkshopReading;
  verdict: 'rules';
  lane: 'rules';
  measuredCutBps: null;
  rules: RulesReadout;
}

export interface RulesReadingOptions extends RenderOptions {
  /** The config's label, else "Composed hook". */
  name?: string | null;
  /** Who bound the set. */
  author?: string | null;
  /** The Workshop item it is listed as, when it is; '' otherwise. */
  workshopId?: string | null;
  /** When it was bound, unix seconds. */
  at?: number | null;
}

export function rulesReadout(set: RuleSet, opts: RenderOptions = {}): RulesReadout {
  const words = renderRules(set, opts);
  return {
    version: set.version,
    bytes: rulesToHex(encodeRules(set)),
    sentences: words.sentences,
    mostTakes: words.mostTakes,
    flags: words.flags,
    destination: set.destination,
    destinationWallet: set.destination === 'named' ? (opts.destinationWallet ?? null) : null,
    keeps: (['entry', 'times', 'count'] as const).filter((k) => set.keeps[k]),
    entryCapBps: set.entryCapBps,
  };
}

export function rulesHookReading(set: RuleSet, opts: RulesReadingOptions = {}): RulesHookReading {
  const words = renderRules(set, opts);
  const title = opts.name?.trim() || 'Composed hook';
  const does = words.sentences.join(' ');
  const keeps = words.keeps.length ? joinOr(words.keeps) : 'nothing';
  return {
    workshopId: opts.workshopId ?? '',
    name: title,
    author: opts.author ?? '',
    kind: 'hook',
    reading: {
      title,
      does,
      total: { bps: words.mostTakes.bps, text: words.mostTakes.text },
      description: `${does} Composed from Bordrless rules and run by the rules engine; it keeps ${keeps}.`,
      watch: words.watch,
      at: opts.at ?? 0,
    },
    measuredCutBps: null,
    verdict: 'rules',
    lane: 'rules',
    approvedBy: null,
    rules: rulesReadout(set, opts),
  };
}

/** Whether a reading the API answered is the lane's synthetic one (served without the set: `rulesReadingWords`). */
export const isRulesReading = (r: unknown): r is HookReading & { lane: 'rules'; verdict: 'rules' } => typeof r === 'object' && r !== null && (r as { lane?: unknown }).lane === RULES_LANE && (r as { verdict?: unknown }).verdict === RULES_LANE;

/** The reading as the API serves it (`ConfigInspection.hook`, `CustomHookInfo.workshop`): the words alone; the set itself travels once, as `customHook.rules`. */
export function rulesReadingWords(r: RulesHookReading): HookReading {
  const { rules: _set, ...words } = r;
  return words;
}

// ---- the engine's refusals (§1.2: a REFUSE rule's reason) ---------------------------------------------------

/**
 * A `REFUSE` rule fails the operation with its reason's error (`1 cooling, 2 cap, 3 locked, 4 rule`).
 * `RULES_REFUSAL_ERRORS` are the engine's error names, the ones the starter's `HookError` spells too
 * (held to the engine's IDL by the SDK's tests); the API names a trade or a send the engine refused
 * by `RULES_REFUSAL_CODES`, with `RULES_REFUSAL_TEXT`; the site's trade panel says its own line from
 * the token's own rules (`rulesRefusalLine`).
 */
export const RULES_REFUSAL_ERRORS: Readonly<Record<RefuseReason, string>> = { cooling: 'CoolingDown', cap: 'OverCap', locked: 'Locked', rule: 'Refused' };
export const RULES_REFUSAL_CODES: Readonly<Record<RefuseReason, string>> = { cooling: 'rules_cooling', cap: 'rules_cap', locked: 'rules_locked', rule: 'rules_rule' };
export const RULES_REFUSAL_TEXT: Readonly<Record<RefuseReason, string>> = {
  cooling: 'The token’s rules refuse this for now: tokens that arrived recently can’t be sold or sent yet.',
  cap: 'The token’s rules refuse this: it would take the wallet over the most one wallet can hold.',
  locked: 'The token’s rules refuse this: this wallet’s tokens are locked for now.',
  rule: 'The token’s rules refuse this for now.',
};

const REASONS = Object.keys(REFUSE_REASON_IDS) as RefuseReason[];
/** The reason of an engine error by its name (`CoolingDown`); null for any other error. */
export const refuseReasonOfError = (name: string | null | undefined): RefuseReason | null => REASONS.find((r) => RULES_REFUSAL_ERRORS[r] === name) ?? null;
/** The reason of an API error code (`rules_cooling`); null for any other code. */
export const refuseReasonOfCode = (code: string | null | undefined): RefuseReason | null => REASONS.find((r) => RULES_REFUSAL_CODES[r] === code) ?? null;

// ---- the engine's error numbers (its IDL, `programs/rules_hook`) ---------------------------------------------

/** `config_kit_rules` -> `ConfigKitRules`: how Anchor names the engine's error for a refusal code. */
const errorNameOf = (code: RulesErrorCode): string => code.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');

/**
 * The engine's errors by number, as its IDL lists them: `bind`'s refusals first, 6000 plus their
 * place in `RULES_ERROR_CODES` (`length` 6000 ... `config_creator` 6028), then the four reasons
 * (`CoolingDown` 6029, `OverCap` 6030, `Locked` 6031, `Refused` 6032), then its own. A log names
 * the error too (`Error Code: CoolingDown`), which `refuseReasonOfError` reads.
 */
export const RULES_ENGINE_ERRORS: Readonly<Record<number, string>> = Object.fromEntries([
  ...RULES_ERROR_CODES.map((code, i) => [6000 + i, errorNameOf(code)] as const),
  ...(['CoolingDown', 'OverCap', 'Locked', 'Refused', 'NoRules', 'Unbound', 'WrongAccount', 'BadHookSigner', 'WrongMint', 'NotEligible', 'NotTheCompanion', 'NoRecord', 'MathOverflow'] as const).map((name, i) => [6000 + RULES_ERROR_CODES.length + i, name] as const),
]);

/** The engine's error number of a refusal of `bind` (`config_flags` -> 6026). */
export const rulesErrorNumber = (code: RulesErrorCode): number => 6000 + RULES_ERROR_CODES.indexOf(code);

/** The refusal of `bind` an engine error number stands for; null for any other number. */
export function rulesErrorCodeOfNumber(n: number): RulesErrorCode | null {
  const i = n - 6000;
  return Number.isInteger(i) && i >= 0 && i < RULES_ERROR_CODES.length ? RULES_ERROR_CODES[i]! : null;
}

/** The engine's error numbers of the four reasons. */
export const RULES_REFUSAL_NUMBERS: Readonly<Record<RefuseReason, number>> = Object.fromEntries(REASONS.map((r) => [r, Number(Object.entries(RULES_ENGINE_ERRORS).find(([, name]) => name === RULES_REFUSAL_ERRORS[r])![0])])) as Record<RefuseReason, number>;

/** The reason of an engine error number (6029 -> `cooling`); null for any other number. */
export const refuseReasonOfNumber = (n: number): RefuseReason | null => refuseReasonOfError(RULES_ENGINE_ERRORS[n]);

const PAST: Record<RuleSide, string> = { sell: 'sold', buy: 'bought', send: 'sent', receive: 'received', burn: 'burned' };

/**
 * What a refused operation says, from the set that refused it: the first `REFUSE` rule with that
 * reason on that side (else on any side). A cooldown on the time since tokens arrived says it the
 * trade panel's way ("Tokens that arrived less than an hour ago can’t be sold yet."); any other is
 * the rule's own sentence. Null when the set has no such rule.
 */
export function rulesRefusalLine(set: RuleSet, reason: RefuseReason, side: RuleSide, opts: RenderOptions = {}): string | null {
  const refusing = set.rules.filter((r) => r.then.kind === 'refuse' && r.then.reason === reason);
  const rule = refusing.find((r) => r.on.includes(side)) ?? refusing[0];
  if (!rule) return null;
  const since = reason === 'cooling' ? rule.when.find((a) => a.value === 'sinceReceived' && (a.op === 'lt' || a.op === 'le')) : undefined;
  if (since) return `Tokens that arrived ${since.op === 'lt' ? 'less than' : 'at most'} ${durationWords(since.literal)} ago can’t be ${PAST[rule.on.includes(side) ? side : rule.on[0]!]} yet.`;
  return renderRule(rule, set, opts)[0] ?? null;
}
