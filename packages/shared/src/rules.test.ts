/**
 * The rules lane's one reading of the bytes (rules.ts, docs/rules-lane.md), held to
 * `vectors/rules.json`: every case encodes to its exact bytes and back, passes the validator and
 * renders its exact sentences, worst case, flags and notes; every refused byte set gets the
 * engine's code. The Rust tests of `programs/rules_hook` read the same file.
 */
import { describe, expect, it } from 'vitest';
import raw from '../vectors/rules.json' with { type: 'json' };
import { TOKEN_HOOK_FLAGS } from './programs.ts';
import {
  RULES_ENGINE_ERRORS,
  RULES_ERROR_CODES,
  RULES_ERROR_TEXT,
  RULES_LIMITS,
  RULES_REFUSAL_CODES,
  RULES_REFUSAL_ERRORS,
  RULES_REFUSAL_NUMBERS,
  RULES_REFUSAL_TEXT,
  RULE_OP_IDS,
  RULE_SIDES,
  RULE_VALUE_IDS,
  RulesError,
  assertRules,
  checkRulesBytes,
  decodeRules,
  decimalWords,
  durationWords,
  encodeRules,
  isRulesReading,
  mostTakesOf,
  pctWords,
  phraseOf,
  priceWords,
  refuseReasonOfCode,
  refuseReasonOfError,
  refuseReasonOfNumber,
  renderRule,
  renderRules,
  rulesBytesLength,
  rulesErrorCodeOfNumber,
  rulesErrorNumber,
  rulesFlagsOf,
  rulesFromHex,
  rulesHookReading,
  rulesReadingWords,
  rulesRefusalLine,
  rulesToHex,
  sideWords,
  solWords,
  tokenWords,
  validateRules,
  type Atom,
  type Rule,
  type RuleOpName,
  type RuleSet,
  type RuleValueName,
  type RulesErrorCode,
} from './rules.ts';

interface VectorCase {
  id: string;
  title: string;
  symbol?: string;
  destinationWallet?: string;
  set: unknown;
  bytes: string;
  flags: number;
  sentences: string[];
  mostTakes: { sell: number; buy: number; transfer: number; bps: number; text: string };
  watch: { severity: 'high' | 'medium' | 'low'; text: string }[];
  keeps: string[];
}
interface VectorRefused {
  id: string;
  bytes: string;
  code: RulesErrorCode;
  rule: number | null;
}
const vectors = raw as { version: number; cases: VectorCase[]; refused: VectorRefused[] };

/** A set as the vectors file writes it (literals as decimal strings). */
function setOf(json: unknown): RuleSet {
  const s = json as { version: number; keeps: RuleSet['keeps']; entryCapBps: number; destination: RuleSet['destination']; rules: { on: Rule['on']; when: { value: RuleValueName; op: RuleOpName; literal: string }[]; unless: { value: RuleValueName; op: RuleOpName; literal: string } | null; then: Rule['then']; stop: boolean }[] };
  const atomOf = (a: { value: RuleValueName; op: RuleOpName; literal: string }): Atom => ({ value: a.value, op: a.op, literal: BigInt(a.literal) });
  return { version: s.version, keeps: { ...s.keeps }, entryCapBps: s.entryCapBps, destination: s.destination, rules: s.rules.map((r) => ({ on: [...r.on], when: r.when.map(atomOf), unless: r.unless ? atomOf(r.unless) : null, then: { ...r.then }, stop: r.stop })) };
}

const atom = (value: RuleValueName, op: RuleOpName, literal: bigint | number): Atom => ({ value, op, literal: BigInt(literal) });
const set = (keeps: Partial<RuleSet['keeps']>, destination: RuleSet['destination'], rules: Rule[], entryCapBps = 0): RuleSet => ({ version: 1, keeps: { entry: false, times: false, count: false, ...keeps }, entryCapBps, destination, rules });
const rule = (on: Rule['on'], when: Atom[], then: Rule['then'], unless: Atom | null = null, stop = false): Rule => ({ on, when, unless, then, stop });
const byId = (id: string): VectorCase => vectors.cases.find((c) => c.id === id)!;
const codesOf = (s: RuleSet): string[] => validateRules(s).map((p) => p.code);

describe('vectors/rules.json', () => {
  it('is version 1 with the doc’s examples and the refusals', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.cases.map((c) => c.id)).toEqual(expect.arrayContaining(['loss-shield', 'cooldown', 'whale-tax', 'whale-cap', 'early-sell-penalty', 'early-lock']));
    expect(vectors.refused.length).toBeGreaterThan(30);
  });

  for (const c of vectors.cases) {
    it(`${c.id}: encodes to its bytes, decodes back, passes, and reads as written`, () => {
      const s = setOf(c.set);
      const bytes = encodeRules(s);
      expect(rulesToHex(bytes)).toBe(c.bytes);
      expect(bytes.length).toBe(rulesBytesLength(s.rules.length));
      expect(decodeRules(rulesFromHex(c.bytes))).toEqual(s);
      expect(validateRules(s)).toEqual([]);
      expect(checkRulesBytes(bytes)).toEqual({ set: s, problems: [] });
      const words = renderRules(s, { symbol: c.symbol ?? null, destinationWallet: c.destinationWallet ?? null });
      expect(words.sentences).toEqual(c.sentences);
      expect(words.mostTakes).toEqual(c.mostTakes);
      expect(words.flags).toBe(c.flags);
      expect(rulesFlagsOf(s)).toBe(c.flags);
      expect(words.watch).toEqual(c.watch);
      expect(words.keeps).toEqual(c.keeps);
    });
  }

  for (const r of vectors.refused) {
    it(`refuses ${r.id} with ${r.code}`, () => {
      const got = checkRulesBytes(rulesFromHex(r.bytes));
      expect(got.problems[0]).toMatchObject({ code: r.code, rule: r.rule });
      expect(got.problems[0]!.text).toContain(RULES_ERROR_TEXT[r.code]);
    });
  }

  it('covers every code the engine answers, but the five only the chain can check', () => {
    const covered = new Set(vectors.refused.map((r) => r.code));
    const chainOnly: RulesErrorCode[] = ['destination_wallet', 'config_hook', 'config_flags', 'config_kit_rules', 'config_creator'];
    for (const code of RULES_ERROR_CODES) expect(covered.has(code) || chainOnly.includes(code), code).toBe(true);
    for (const code of RULES_ERROR_CODES) expect(RULES_ERROR_TEXT[code]).toMatch(/\.$/);
  });
});

describe('the doc’s sentences (docs/rules-lane.md §1.3), word for word', () => {
  it('Loss shield', () => {
    expect(byId('loss-shield').sentences).toEqual(['Takes 5% of every sell by a holder in profit, burned.', 'Holders under water sell free.']);
    expect(byId('loss-shield').mostTakes.text).toBe('5% of a sell; nothing from buys or transfers');
    expect(byId('loss-shield').flags).toBe(209);
  });
  it('Cooldown', () => {
    expect(byId('cooldown').sentences).toEqual(['A wallet that received tokens less than an hour ago cannot sell or send them.']);
    expect(byId('cooldown').mostTakes.text).toBe('Takes nothing.');
    expect(byId('cooldown').flags).toBe(145);
  });
  it('Whale tax', () => {
    expect(byId('whale-tax').sentences).toEqual(['Takes 3% of every sell by a holder whose bag is worth over 6.5 SOL, paid to the creator.', 'Smaller bags sell free.']);
    expect(byId('whale-tax').flags).toBe(65);
    expect(byId('whale-tax').watch[0]).toEqual({ severity: 'medium', text: 'The creator’s holding must exist for the cut to be paid; until then sells pass free.' });
  });
  it('Whale cap', () => {
    expect(byId('whale-cap').sentences).toEqual(['No wallet can hold more than 2% of the supply until graduation.']);
    expect(byId('whale-cap').flags).toBe(1);
  });
  it('Early-sell penalty with a cooldown', () => {
    expect(byId('early-sell-penalty').sentences).toEqual(['Takes 10% of every sell in the first day after launch, burned.', 'After that, sells pass free.', 'A wallet that received tokens less than 10 minutes ago cannot sell or send them.']);
    expect(byId('early-sell-penalty').mostTakes.text).toBe('10% of a sell; nothing from buys or transfers');
    expect(byId('early-sell-penalty').flags).toBe(209);
  });
  it('Early lock', () => {
    expect(byId('early-lock').sentences).toEqual(['A wallet whose first tokens arrived in the first minute after launch cannot sell or send until an hour after launch.']);
  });
});

describe('the byte layout (§1.2)', () => {
  it('writes the header and 48 bytes a rule, atoms in order, unused slots zero', () => {
    const s = set({ entry: true, times: true }, 'creator', [rule(['sell', 'buy'], [atom('gain', 'ge', 1_000), atom('sinceReceived', 'lt', 60)], { kind: 'cut', bps: 250 }, atom('graduated', 'eq', 1), true)], 2_000);
    const b = encodeRules(s);
    expect(b.length).toBe(56);
    expect([...b.subarray(0, 8)]).toEqual([1, 3, 0xd0, 0x07, 1, 2, 0, 0]);
    expect([...b.subarray(8, 16)]).toEqual([3, 2, 1, 1, 1, 0, 0xfa, 0x00]);
    expect([...b.subarray(16, 26)]).toEqual([8, 4, 0xe8, 3, 0, 0, 0, 0, 0, 0]);
    expect([...b.subarray(26, 36)]).toEqual([12, 1, 60, 0, 0, 0, 0, 0, 0, 0]);
    expect([...b.subarray(36, 46)]).toEqual([18, 5, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect([...b.subarray(46, 56)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(decodeRules(b)).toEqual(s);
  });

  it('encodes a refusal, a count and a mark in arg, with no bps', () => {
    const s = set({ count: true }, 'none', [rule(['sell'], [atom('amount', 'gt', 5)], { kind: 'refuse', reason: 'locked' }), rule(['buy'], [], { kind: 'count', what: 'reset' }), rule(['receive'], [], { kind: 'flag', flag: 3, set: true }), rule(['send'], [], { kind: 'flag', flag: 2, set: false })]);
    const b = encodeRules(s);
    expect([...b.subarray(8 + 4, 8 + 8)]).toEqual([2, 3, 0, 0]);
    expect([...b.subarray(56 + 4, 56 + 8)]).toEqual([3, 2, 0, 0]);
    expect([...b.subarray(104 + 4, 104 + 8)]).toEqual([4, 16 | 3, 0, 0]);
    expect([...b.subarray(152 + 4, 152 + 8)]).toEqual([4, 2, 0, 0]);
    expect(decodeRules(b)).toEqual(s);
  });

  it('is 296 bytes at most, and the limits are the doc’s', () => {
    expect(rulesBytesLength(RULES_LIMITS.rules)).toBe(RULES_LIMITS.bytes);
    expect(RULES_LIMITS).toMatchObject({ rules: 6, when: 3, unless: 1, cutBps: 1_500, sideCutBps: 1_500, entryCapBps: 5_000, perDay: 6 });
    expect(RULES_LIMITS.literal.seconds).toBe(365n * 86_400n);
    expect(RULES_LIMITS.literal.lamports).toBe(10_000n * 1_000_000_000n);
    expect(RULES_LIMITS.literal.price).toBe((1n << 64n) - 1n);
  });

  it('numbers the values, ops and sides as the doc does', () => {
    expect(RULE_VALUE_IDS).toMatchObject({ amount: 1, shareAfter: 5, tradePrice: 6, gain: 8, loss: 9, valueBefore: 10, sinceReceived: 12, sinceLaunch: 16, counter: 17, graduated: 18, hasEntry: 19, flag0: 32, flag3: 35 });
    expect(RULE_OP_IDS).toEqual({ lt: 1, le: 2, gt: 3, ge: 4, eq: 5, ne: 6 });
    expect(RULE_SIDES).toEqual(['sell', 'buy', 'send', 'receive', 'burn']);
  });

  it('refuses what has no encoding, and hex that is not bytes', () => {
    expect(() => encodeRules(set({}, 'burn', [rule(['sell'], [atom('amount', 'gt', 1), atom('amount', 'gt', 2), atom('amount', 'gt', 3), atom('amount', 'gt', 4)], { kind: 'cut', bps: 1 }, atom('graduated', 'eq', 1))]))).toThrow(RulesError);
    expect(() => encodeRules(set({}, 'burn', [rule(['sell'], [atom('amount', 'gt', 1n << 64n)], { kind: 'cut', bps: 1 })]))).toThrow(/threshold/);
    expect(() => rulesFromHex('abc')).toThrow(RulesError);
    expect(() => rulesFromHex('zz')).toThrow(RulesError);
    expect(rulesFromHex('0x0102')).toEqual(new Uint8Array([1, 2]));
  });
});

describe('validateRules', () => {
  const shield = set({ entry: true }, 'burn', [rule(['sell'], [atom('gain', 'gt', 0)], { kind: 'cut', bps: 500 })]);

  it('passes the doc’s sets and says each refusal once per rule, with the rule’s number', () => {
    expect(validateRules(shield)).toEqual([]);
    const bad = set({}, 'none', [rule([], [atom('gain', 'gt', 0), atom('counter', 'ge', 1)], { kind: 'cut', bps: 0 }), rule(['sell'], [atom('flag0', 'eq', 1)], { kind: 'refuse', reason: 'rule' })]);
    expect(validateRules(bad).map((p) => [p.code, p.rule])).toEqual([
      ['side', 0],
      ['keeps_entry', 0],
      ['keeps_count', 0],
      ['cut_bps', 0],
      ['cut_destination', 0],
      ['keeps_count', 1],
      ['refuse_marks', 1],
    ]);
    expect(validateRules(bad)[0]!.text).toBe(`Rule 1: ${RULES_ERROR_TEXT.side}`);
    expect(() => assertRules(bad)).toThrow(RulesError);
    expect(assertRules(shield)).toBe(shield);
  });

  it('holds the cuts of a side to 1,500 in all, counting every rule on the side', () => {
    expect(codesOf(set({}, 'burn', [rule(['sell'], [], { kind: 'cut', bps: 1_500 })]))).toEqual([]);
    expect(codesOf(set({}, 'burn', [rule(['sell'], [], { kind: 'cut', bps: 1_000 }), rule(['sell', 'buy'], [atom('amount', 'gt', 1)], { kind: 'cut', bps: 500 })]))).toEqual([]);
    expect(codesOf(set({}, 'burn', [rule(['sell'], [], { kind: 'cut', bps: 1_000 }), rule(['sell'], [atom('amount', 'gt', 1)], { kind: 'cut', bps: 501 })]))).toEqual(['side_total']);
    expect(codesOf(set({}, 'burn', [rule(['send'], [], { kind: 'cut', bps: 1_500 }), rule(['receive'], [], { kind: 'cut', bps: 1_500 })]))).toEqual([]);
  });

  it('lets a refusal of a sell turn on time, amount, balance, share, price or value beside a mark, never on marks alone', () => {
    expect(codesOf(set({ count: true }, 'none', [rule(['sell'], [atom('flag0', 'eq', 1), atom('amount', 'gt', 1)], { kind: 'refuse', reason: 'rule' })]))).toEqual([]);
    expect(codesOf(set({ count: true }, 'none', [rule(['buy'], [atom('flag0', 'eq', 1)], { kind: 'refuse', reason: 'rule' })]))).toEqual([]);
    expect(codesOf(set({ count: true }, 'none', [rule(['burn'], [atom('counter', 'ge', 1)], { kind: 'refuse', reason: 'rule' })]))).toEqual(['refuse_marks']);
  });

  it('bounds the entry cap and ties it to keeps entry', () => {
    expect(codesOf({ ...shield, entryCapBps: 5_000 })).toEqual([]);
    expect(codesOf({ ...shield, entryCapBps: 5_001 })).toEqual(['entry_cap']);
    expect(codesOf({ ...shield, keeps: { entry: false, times: false, count: false }, entryCapBps: 1 })).toEqual(['entry_cap', 'keeps_entry']);
  });

  it('refuses the version, the count, a side named twice and an unknown action', () => {
    expect(codesOf({ ...shield, version: 2 })).toEqual(['version']);
    expect(codesOf({ ...shield, rules: [] })).toEqual(['rule_count']);
    expect(codesOf({ ...shield, rules: Array(7).fill(shield.rules[0]) })).toEqual(['rule_count', 'side_total']);
    expect(codesOf(set({ entry: true }, 'burn', [rule(['sell', 'sell'], [atom('gain', 'gt', 0)], { kind: 'cut', bps: 5 })]))).toEqual(['side']);
    expect(codesOf(set({}, 'burn', [rule(['sell'], [], { kind: 'nothing' } as never)]))).toEqual(['action']);
    expect(codesOf(set({}, 'burn', [rule(['sell'], [atom('amount', 'gt', 1)], { kind: 'refuse', reason: 'tired' as never })]))).toEqual(['arg']);
    expect(codesOf(set({ count: true }, 'burn', [rule(['sell'], [], { kind: 'flag', flag: 4 as never, set: true })]))).toEqual(['arg']);
  });
});

describe('rulesFlagsOf', () => {
  it('is before transfer always, the delta with a cut, burn and hook data with any keeps, a count or a mark', () => {
    const { BEFORE_TRANSFER: T, BEFORE_BURN: B, TRANSFER_RETURNS_DELTA: D, WRITES_HOOK_DATA: W } = TOKEN_HOOK_FLAGS;
    expect(rulesFlagsOf(set({}, 'none', [rule(['buy'], [atom('shareAfter', 'gt', 1)], { kind: 'refuse', reason: 'cap' })]))).toBe(T);
    expect(rulesFlagsOf(set({}, 'burn', [rule(['sell'], [], { kind: 'cut', bps: 1 })]))).toBe(T | D);
    expect(rulesFlagsOf(set({ times: true }, 'none', [rule(['sell'], [atom('sinceReceived', 'lt', 1)], { kind: 'refuse', reason: 'cooling' })]))).toBe(T | B | W);
    expect(rulesFlagsOf(set({ entry: true }, 'burn', [rule(['sell'], [atom('gain', 'gt', 0)], { kind: 'cut', bps: 1 })]))).toBe(T | D | B | W);
    expect(rulesFlagsOf(set({ count: true }, 'none', [rule(['sell'], [], { kind: 'count', what: 'add' })]))).toBe(T | B | W);
    // A rule on burns runs only with `before_burn`: a set that keeps nothing still gets it (17).
    expect(rulesFlagsOf(set({}, 'none', [rule(['burn'], [atom('amount', 'gt', 1)], { kind: 'refuse', reason: 'rule' })]))).toBe(T | B);
    expect(rulesFlagsOf(set({}, 'none', [rule(['send', 'burn'], [atom('amount', 'gt', 1)], { kind: 'refuse', reason: 'rule' })]))).toBe(17);
    expect(byId('burn-cap-keeps-nothing').flags).toBe(T | B);
    expect(209).toBe(T | D | B | W);
    expect(145).toBe(T | B | W);
    expect(65).toBe(T | D);
  });
});

describe('the words', () => {
  it('says numbers in the site’s units', () => {
    expect(pctWords(500)).toBe('5%');
    expect(pctWords(25)).toBe('0.25%');
    expect(pctWords(1_500)).toBe('15%');
    expect(pctWords(1)).toBe('0.01%');
    expect(solWords(6_500_000_000n)).toBe('6.5');
    expect(solWords(1_234_567_890n)).toBe('1.235');
    expect(solWords(1_000_000_000_000n)).toBe('1,000');
    expect(solWords(999_999n)).toBe('0.001');
    expect(solWords(499_999n)).toBe('0');
    expect(tokenWords(1_000_000_000_000n, 'STONE')).toBe('1,000,000 STONE');
    expect(tokenWords(1_500_000n, null)).toBe('1.5 tokens');
    expect(priceWords(1_000_000_000n)).toBe('0.000001');
    expect(decimalWords(123_456n, 3, 1)).toBe('123.5');
    expect(decimalWords(5n, 0, 2)).toBe('5');
  });

  it('says lengths of time as the examples do', () => {
    expect(durationWords(3600)).toBe('an hour');
    expect(durationWords(86_400)).toBe('a day');
    expect(durationWords(600)).toBe('10 minutes');
    expect(durationWords(60)).toBe('a minute');
    expect(durationWords(7_200)).toBe('2 hours');
    expect(durationWords(30)).toBe('30 seconds');
    expect(durationWords(1)).toBe('a second');
    expect(durationWords(30 * 86_400)).toBe('30 days');
    expect(durationWords(90)).toBe('90 seconds');
    expect(durationWords(86_400, false)).toBe('day');
    expect(durationWords(3_600, false)).toBe('hour');
    expect(durationWords(600, false)).toBe('10 minutes');
  });

  it('names the sides', () => {
    expect(sideWords(['sell'])).toEqual({ one: 'sell', many: 'sells', verbs: 'sell' });
    expect(sideWords(['send', 'sell'])).toEqual({ one: 'sell or transfer', many: 'sells or transfers', verbs: 'sell or send' });
    expect(sideWords(['send', 'receive'])).toEqual({ one: 'transfer', many: 'transfers', verbs: 'send or receive' });
    expect(sideWords(['sell', 'buy', 'receive'])).toEqual({ one: 'sell, buy or transfer', many: 'sells, buys or transfers', verbs: 'sell, buy or receive' });
  });

  it('reads every value with every op (the function is total)', () => {
    for (const value of Object.keys(RULE_VALUE_IDS) as RuleValueName[]) {
      for (const op of Object.keys(RULE_OP_IDS) as RuleOpName[]) {
        for (const literal of [0n, 1n, 500n]) {
          const p = phraseOf(atom(value, op, literal), 'STONE');
          expect(p.when.length, `${value} ${op} ${literal}`).toBeGreaterThan(0);
          expect(p.relative.length).toBeGreaterThan(0);
          expect(p.unless.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('gives the table’s forms', () => {
    expect(phraseOf(atom('gain', 'ge', 5_000), null).when).toBe('by a holder up 50% or more');
    expect(phraseOf(atom('gain', 'ge', 5_000), null).complement!(sideWords(['sell']))).toBe('Holders up less than 50% sell free.');
    expect(phraseOf(atom('loss', 'gt', 0), null).complement!(sideWords(['sell']))).toBe('Holders in profit sell free.');
    expect(phraseOf(atom('valueBefore', 'gt', 6_500_000_000), null).relative).toBe('whose bag is worth over 6.5 SOL');
    expect(phraseOf(atom('sinceReceived', 'lt', 3_600), null).complement!(sideWords(['sell']))).toBe('After an hour, free.');
    expect(phraseOf(atom('sinceLaunch', 'lt', 86_400), null).complement!(sideWords(['sell']))).toBe('After that, sells pass free.');
    expect(phraseOf(atom('amount', 'gt', 1_000_000), 'STONE').when).toBe('of more than 1 STONE');
    expect(phraseOf(atom('amount', 'gt', 1_000_000), 'STONE').complement!(sideWords(['sell']))).toBe('Smaller sells pass free.');
    expect(phraseOf(atom('shareAfter', 'gt', 200), null).when).toBe('that would leave a wallet over 2% of the supply');
    expect(phraseOf(atom('counter', 'ge', 3), null).when).toBe('by a holder counted 3 times or more');
    expect(phraseOf(atom('counter', 'ge', 1), null).relative).toBe('counted once or more');
    expect(phraseOf(atom('flag0', 'eq', 1), null).when).toBe('by a marked holder');
    expect(phraseOf(atom('flag2', 'eq', 0), null).relative).toBe('that is not marked 2');
    expect(phraseOf(atom('graduated', 'eq', 1), null)).toMatchObject({ when: 'after graduation', unless: 'until graduation' });
    expect(phraseOf(atom('graduated', 'ne', 1), null)).toMatchObject({ when: 'before graduation', unless: 'after graduation' });
    expect(phraseOf(atom('graduated', 'ge', 0), null).when).toBe('by a holder whose graduated is at least 0');
  });

  it('renders a refusal of buys as a buyer, with a trailing launch clock and an unless', () => {
    const s = set({ entry: true }, 'none', [rule(['buy', 'receive'], [atom('gain', 'ge', 1_000), atom('sinceLaunch', 'lt', 3_600)], { kind: 'refuse', reason: 'rule' }, atom('graduated', 'eq', 1))]);
    expect(renderRule(s.rules[0]!, s)).toEqual(['A buyer up 10% or more cannot buy or receive until an hour after launch until graduation.']);
    expect(renderRule(rule(['sell', 'buy'], [atom('amount', 'gt', 1_000_000)], { kind: 'cut', bps: 100 }), set({}, 'creator', []), { symbol: 'X' })).toEqual(['Takes 1% of every sell or buy of more than 1 X, paid to the creator.', 'Smaller sells or buys pass free.']);
    expect(renderRule(rule(['sell'], [], { kind: 'cut', bps: 100 }, null, true), set({}, 'named', []), { destinationWallet: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH' })).toEqual(['Takes 1% of every sell, paid to HN7c…YWrH.', 'No later rule applies to that sell.']);
    expect(renderRule(rule(['sell'], [], { kind: 'cut', bps: 100 }), set({}, 'named', []))).toEqual(['Takes 1% of every sell, paid to a named wallet.']);
    expect(renderRule(rule(['buy'], [atom('amountShare', 'gt', 50)], { kind: 'flag', flag: 1, set: false }), set({ count: true }, 'none', []))).toEqual(['Unmarks a wallet with mark 1 on its buy of more than 0.5% of the supply.']);
    expect(renderRule(rule(['buy'], [], { kind: 'count', what: 'reset' }), set({ count: true }, 'none', []))).toEqual(['Resets a holder’s count on each buy.']);
  });

  it('special-cases the max-wallet shape only when it is that shape', () => {
    expect(renderRule(rule(['buy', 'receive'], [atom('shareAfter', 'ge', 200)], { kind: 'refuse', reason: 'cap' }), set({}, 'none', []))).toEqual(['No wallet can hold 2% or more of the supply.']);
    expect(renderRule(rule(['buy'], [atom('shareAfter', 'gt', 200)], { kind: 'refuse', reason: 'cap' }), set({}, 'none', []))).toEqual(['A buyer that would leave a wallet over 2% of the supply cannot buy.']);
    expect(renderRule(rule(['buy', 'receive'], [atom('shareAfter', 'gt', 200)], { kind: 'refuse', reason: 'cap' }, atom('gain', 'gt', 0)), set({ entry: true }, 'none', []))).toEqual(['A buyer that would leave a wallet over 2% of the supply cannot buy or receive unless in profit.']);
  });

  it('sums the most it takes per side, conditions and stop ignored, a transfer’s two halves together', () => {
    const s = set({}, 'burn', [rule(['sell', 'send'], [atom('amount', 'gt', 1)], { kind: 'cut', bps: 300 }, null, true), rule(['sell', 'receive'], [], { kind: 'cut', bps: 200 }), rule(['buy'], [], { kind: 'refuse', reason: 'rule' })]);
    expect(mostTakesOf(s)).toEqual({ sell: 500, buy: 0, transfer: 500, bps: 500, text: '5% of a sell, 5% of a transfer; nothing from buys' });
    expect(mostTakesOf(set({}, 'burn', [rule(['sell'], [], { kind: 'cut', bps: 1 }), rule(['buy'], [], { kind: 'cut', bps: 2 }), rule(['send'], [], { kind: 'cut', bps: 3 })])).text).toBe('0.01% of a sell, 0.02% of a buy, 0.03% of a transfer');
  });
});

describe('rulesHookReading', () => {
  it('is a HookReading of the rules lane: the sentences as does, the computed total, no measured cut, the set beside it', () => {
    const s = setOf(byId('whale-tax').set);
    const r = rulesHookReading(s, { name: 'Whale tax', author: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH', workshopId: 'abc', at: 1_700_000_000 });
    expect(r).toMatchObject({ workshopId: 'abc', name: 'Whale tax', kind: 'hook', measuredCutBps: null, verdict: 'rules', lane: 'rules', approvedBy: null });
    expect(r.reading).toEqual({
      title: 'Whale tax',
      does: 'Takes 3% of every sell by a holder whose bag is worth over 6.5 SOL, paid to the creator. Smaller bags sell free.',
      total: { bps: 300, text: '3% of a sell; nothing from buys or transfers' },
      description: 'Takes 3% of every sell by a holder whose bag is worth over 6.5 SOL, paid to the creator. Smaller bags sell free. Composed from Bordrless rules and run by the rules engine; it keeps nothing.',
      watch: byId('whale-tax').watch,
      at: 1_700_000_000,
    });
    expect(r.rules).toMatchObject({ version: 1, bytes: byId('whale-tax').bytes, sentences: byId('whale-tax').sentences, flags: 65, destination: 'creator', destinationWallet: null, keeps: [], entryCapBps: 0 });
    expect(isRulesReading(r)).toBe(true);
    expect(isRulesReading({ lane: 'reading', verdict: 'pass' })).toBe(false);
    expect(isRulesReading(null)).toBe(false);
    const plain = rulesHookReading(setOf(byId('loss-shield').set));
    expect(plain).toMatchObject({ workshopId: '', name: 'Composed hook', author: '' });
    expect(plain.reading.description).toContain('it keeps an entry price per holding.');
    expect(plain.reading.at).toBe(0);
  });
});

describe('the served reading and the engine’s refusals', () => {
  it('serves the words alone: the set travels once, as customHook.rules', () => {
    const r = rulesHookReading(setOf(byId('cooldown').set), { name: 'Cooldown', author: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH' });
    const served = rulesReadingWords(r);
    const { rules: set, ...words } = r;
    expect(served).not.toHaveProperty('rules');
    expect(served).toEqual(words);
    expect(set.bytes).toBe(byId('cooldown').bytes);
    expect(isRulesReading(served)).toBe(true);
    expect(r.rules.sentences).toEqual(byId('cooldown').sentences);
  });

  it('names the four reasons by the engine’s error, by the API’s code and in a sentence each', () => {
    expect(Object.keys(RULES_REFUSAL_ERRORS).sort()).toEqual(['cap', 'cooling', 'locked', 'rule']);
    for (const reason of ['cooling', 'cap', 'locked', 'rule'] as const) {
      expect(refuseReasonOfError(RULES_REFUSAL_ERRORS[reason])).toBe(reason);
      expect(refuseReasonOfCode(RULES_REFUSAL_CODES[reason])).toBe(reason);
      expect(RULES_REFUSAL_TEXT[reason]).toMatch(/^The token’s rules refuse this/);
    }
    expect(RULES_REFUSAL_ERRORS).toEqual({ cooling: 'CoolingDown', cap: 'OverCap', locked: 'Locked', rule: 'Refused' });
    expect(refuseReasonOfError('Slippage')).toBeNull();
    expect(refuseReasonOfCode('max_wallet')).toBeNull();
    expect(refuseReasonOfCode(null)).toBeNull();
  });

  it('numbers the engine’s errors as its IDL does: bind’s refusals in order, then the four reasons, then its own', () => {
    expect(RULES_ERROR_CODES.length).toBe(29);
    expect(RULES_ENGINE_ERRORS[6000]).toBe('Length');
    expect(RULES_ENGINE_ERRORS[6002]).toBe('RuleCount');
    expect(RULES_ENGINE_ERRORS[6027]).toBe('ConfigKitRules');
    expect(RULES_ENGINE_ERRORS[6028]).toBe('ConfigCreator');
    expect(RULES_REFUSAL_NUMBERS).toEqual({ cooling: 6029, cap: 6030, locked: 6031, rule: 6032 });
    expect([6033, 6034, 6035, 6041].map((n) => RULES_ENGINE_ERRORS[n])).toEqual(['NoRules', 'Unbound', 'WrongAccount', 'MathOverflow']);
    expect(Object.keys(RULES_ENGINE_ERRORS).length).toBe(42);
    for (const code of RULES_ERROR_CODES) expect(rulesErrorCodeOfNumber(rulesErrorNumber(code))).toBe(code);
    expect(rulesErrorNumber('config_flags')).toBe(6026);
    expect(rulesErrorCodeOfNumber(6029)).toBeNull();
    expect(rulesErrorCodeOfNumber(5999)).toBeNull();
    expect(refuseReasonOfNumber(6030)).toBe('cap');
    expect(refuseReasonOfNumber(6026)).toBeNull();
  });

  it('says a refusal from the set that refused it: a cooldown the trade panel’s way, anything else as its rule reads', () => {
    expect(rulesRefusalLine(setOf(byId('cooldown').set), 'cooling', 'send')).toBe('Tokens that arrived less than an hour ago can’t be sent yet.');
    expect(rulesRefusalLine(setOf(byId('cooldown').set), 'cooling', 'sell')).toBe('Tokens that arrived less than an hour ago can’t be sold yet.');
    expect(rulesRefusalLine(setOf(byId('early-sell-penalty').set), 'cooling', 'sell')).toBe('Tokens that arrived less than 10 minutes ago can’t be sold yet.');
    // A side the rule is not on: the rule's own first side.
    expect(rulesRefusalLine(setOf(byId('cooldown').set), 'cooling', 'buy')).toBe('Tokens that arrived less than an hour ago can’t be sold yet.');
    expect(rulesRefusalLine(setOf(byId('whale-cap').set), 'cap', 'buy')).toBe('No wallet can hold more than 2% of the supply until graduation.');
    expect(rulesRefusalLine(setOf(byId('early-lock').set), 'locked', 'sell')).toBe('A wallet whose first tokens arrived in the first minute after launch cannot sell or send until an hour after launch.');
    expect(rulesRefusalLine(setOf(byId('counter-and-mark').set), 'rule', 'sell')).toBe('A wallet counted 3 times or more and that received tokens less than a day ago cannot sell them.');
    // A refusal by another reason, on another clock, reads as its rule.
    expect(rulesRefusalLine(setOf(byId('six-rules-every-side').set), 'rule', 'sell')).toBe('A wallet that sent tokens less than 5 minutes ago cannot sell or send them.');
    expect(rulesRefusalLine(setOf(byId('six-rules-every-side').set), 'cap', 'buy', { symbol: 'STONE' })).toBe('A buyer that would leave a wallet with more than 50,000,000 STONE cannot buy unless it has no entry price.');
    expect(rulesRefusalLine(setOf(byId('loss-shield').set), 'cooling', 'sell')).toBeNull();
  });
});
